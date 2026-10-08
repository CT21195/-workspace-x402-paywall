import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

// ---- config ----
const PAY_TO_EVM = process.env.X402_PAY_TO || '0xD7CDd563e8F6A249B076A702b7e2C233CCF3481d'; // Chris's Base wallet
const PAY_TO_SOL = process.env.X402_PAY_TO_SOL || 'E21AWkUtLz4BP7AaT82CF7v86Kmv4YzN4NAR1FQnEmqy'; // Chris's Solana wallet
const PRICE = '$0.005'; // USDC per request (half a cent)
const UTILS_PRICE = '$0.001'; // USDC per utility call (a tenth of a cent — matches X Pay-style pricing)
const VERIFY_PRICE = '$0.01'; // USDC per verification request
// EVM networks: the free openx402.ai facilitator only settles exact-scheme
// payments on Base. Other chains (eth/arbitrum/optimism/polygon/bsc) need
// Coinbase CDP facilitator keys — add them here if those are ever configured.
const EVM_NETWORKS = {
  base: 'eip155:8453',
};
const SOL_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; // Solana mainnet
const API_URL = 'https://workspace-x402-paywall.onrender.com';
// ----------------

// Build the accepts array for a price across every supported network.
// Same EVM wallet works on all EVM chains; Solana uses the SOL wallet.
function acceptsFor(price) {
  const evm = Object.values(EVM_NETWORKS).map(network => ({
    scheme: 'exact', price, network, payTo: PAY_TO_EVM,
  }));
  return [...evm, { scheme: 'exact', price, network: SOL_NETWORK, payTo: PAY_TO_SOL }];
}

// ---- live multi-venue spread: top 5 CEXs + top 5 Solana DEXs, computed per request ----
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLES = new Set(['USDC', 'USDT']);

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// 5 major CEXs — each degrades gracefully if unreachable
const CEX_FETCHERS = {
  coinbase: async () => parseFloat((await fetchJson('https://api.coinbase.com/v2/prices/SOL-USD/spot')).data.amount),
  kraken: async () => parseFloat((await fetchJson('https://api.kraken.com/0/public/Ticker?pair=SOLUSD')).result.SOLUSD.c[0]),
  okx: async () => parseFloat((await fetchJson('https://www.okx.com/api/v5/market/ticker?instId=SOL-USDT')).data[0].last),
  bitstamp: async () => parseFloat((await fetchJson('https://www.bitstamp.net/api/v2/ticker/solusd/')).last),
  gateio: async () => parseFloat((await fetchJson('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=SOL_USDT'))[0].last),
};

async function topDexPrices(limit = 5) {
  const d = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`);
  const pairs = (d.pairs || []).filter(p =>
    p.chainId === 'solana' && STABLES.has(p.quoteToken?.symbol) && parseFloat(p.priceUsd) > 0
  );
  // top distinct DEXes by 24h volume
  const seen = new Set();
  const out = {};
  for (const p of pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))) {
    if (seen.has(p.dexId)) continue;
    seen.add(p.dexId);
    out[p.dexId] = parseFloat(p.priceUsd);
    if (Object.keys(out).length >= limit) break;
  }
  return out;
}

async function latestSpread(notional = 1000) {
  const cexEntries = await Promise.allSettled(
    Object.entries(CEX_FETCHERS).map(async ([name, fn]) => [name, await fn()])
  );
  const cex = {};
  for (const r of cexEntries) {
    if (r.status === 'fulfilled') {
      const [name, price] = r.value;
      if (Number.isFinite(price) && price > 0) cex[name] = +price.toFixed(4);
    }
  }
  let dex = {};
  try { dex = await topDexPrices(5); } catch { /* dex leg optional */ }

  const all = { ...cex, ...Object.fromEntries(Object.entries(dex).map(([k, v]) => [`dex:${k}`, v])) };
  const names = Object.keys(all);
  if (names.length < 2) throw new Error('not enough venues reachable');

  let buy = names[0], sell = names[0];
  for (const n of names) {
    if (all[n] < all[buy]) buy = n;
    if (all[n] > all[sell]) sell = n;
  }
  const gross = (all[sell] - all[buy]) / all[buy] * 100;
  // est. net: ~0.25% round-trip taker costs + $20 fixed move cost amortized over notional
  const estNet = gross - 0.25 - 20 / notional * 100;

  return {
    ts_utc: new Date().toISOString(),
    asset: 'SOL',
    cex,
    dex,
    venues_reporting: names.length,
    widest_spread: {
      buy_at: buy,
      buy_price: all[buy],
      sell_at: sell,
      sell_price: all[sell],
      gross_pct: +gross.toFixed(4),
      est_net_pct: +estNet.toFixed(4),
    },
    notional_usd: notional,
  };
}

const facilitatorClient = new HTTPFacilitatorClient({ url: 'https://facilitator.openx402.ai' });
const resourceServer = new x402ResourceServer(facilitatorClient);
for (const net of Object.values(EVM_NETWORKS)) {
  resourceServer.register(net, new ExactEvmScheme());
}
resourceServer.register(SOL_NETWORK, new ExactSvmScheme());

const app = express();

app.use(paymentMiddleware(
  {
    'GET /spread': {
      accepts: acceptsFor(PRICE),
      description: 'Live SOL prices across top 5 CEXs + top 5 Solana DEXs with widest spread',
    },
    'GET /verify/npi': {
      accepts: acceptsFor(VERIFY_PRICE),
      description: 'Validate an NPI number (checksum) and enrich via the CMS NPPES registry',
    },
    'GET /verify/dea': {
      accepts: acceptsFor(PRICE),
      description: 'Validate a DEA number format and checksum',
    },
    'GET /search/npm': {
      accepts: acceptsFor(PRICE),
      description: 'Search npm packages (?q=)',
    },
    'GET /search/wikipedia': {
      accepts: acceptsFor(PRICE),
      description: 'Search Wikipedia articles (?q=)',
    },
    'GET /search/arxiv': {
      accepts: acceptsFor(PRICE),
      description: 'Search arXiv papers (?q=)',
    },
    'GET /search/sec': {
      accepts: acceptsFor(PRICE),
      description: 'Search SEC EDGAR filings (?q=)',
    },
    'GET /search/hn': {
      accepts: acceptsFor(PRICE),
      description: 'Search Hacker News (?q=)',
    },
    'GET /search/geo': {
      accepts: acceptsFor(PRICE),
      description: 'Geocode an address via OpenStreetMap (?q=)',
    },
    'GET /lookup/pypi': {
      accepts: acceptsFor(PRICE),
      description: 'Look up a PyPI package (?package=)',
    },
    'GET /search/fda': {
      accepts: acceptsFor(PRICE),
      description: 'Search FDA drug labels (?q=)',
    },
    'GET /pump/chains': {
      accepts: acceptsFor(PRICE),
      description: 'List all 100+ supported chains for meme endpoints',
    },
    'GET /pump/new': {
      accepts: acceptsFor(PRICE),
      description: 'Newly launched pump.fun tokens (?limit=)',
    },
    'GET /pump/trending': {
      accepts: acceptsFor(PRICE),
      description: 'Trending Solana pools incl. pump.fun (?limit=)',
    },
    'GET /pump/migrating': {
      accepts: acceptsFor(PRICE),
      description: 'pump.fun tokens near Raydium migration (?limit=)',
    },
    'GET /solana/top100': {
      accepts: acceptsFor(PRICE),
      description: 'Top 100 Solana tokens by market cap, priced in USD and SOL',
    },
    'GET /stocks/list': {
      accepts: acceptsFor(PRICE),
      description: 'List tokenized stocks with prices (?chain=solana)',
    },
    'GET /stocks/price': {
      accepts: acceptsFor(PRICE),
      description: 'Tokenized stock quote (?symbol=AAPLx&chain=solana)',
    },
    'GET /meme/trending': {
      accepts: acceptsFor(PRICE),
      description: 'Trending meme coin pools (?chain=solana)',
    },
    'GET /meme/new': {
      accepts: acceptsFor(PRICE),
      description: 'Newly launched tokens (?chain=solana or all)',
    },
    'GET /meme/token': {
      accepts: acceptsFor(PRICE),
      description: 'Token price/volume/liquidity by address (?address=)',
    },
    'GET /search/github': {
      accepts: acceptsFor(PRICE),
      description: 'Search GitHub repos, code, or users (?q=, ?type=repos|code|users)',
    },
    // ---- pay-per-call utilities (zero marginal cost, X Pay-style) ----
    'GET /utils/base64': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Base64 encode (?op=encode&text=) or decode (?op=decode&data=)',
    },
    'GET /utils/hash': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Hash text (?algo=sha256|sha512|sha1|md5&text=)',
    },
    'GET /utils/uuid': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Generate UUID v4s (?count=1..100)',
    },
    'GET /utils/ip': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Echo the caller IP address',
    },
    'GET /utils/time': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Current unix timestamp + ISO 8601 time',
    },
  },
  resourceServer,
));

app.get('/', (req, res) => res.json({
  service: 'x402 utility + data APIs',
  description: 'Pay-per-call micro-utilities (base64, hashing, UUIDs, IP echo, time) plus live SOL multi-venue spread data, GitHub search, and NPI/DEA verification. x402 on Base or Solana.',
  prices: {
    utils: `${UTILS_PRICE} USDC per call`,
    spread: `${PRICE} USDC per request`,
    verify_npi: `${VERIFY_PRICE} USDC per request`,
    verify_dea: `${PRICE} USDC per request`,
  },
  endpoints: [
    'GET /utils/base64?op=encode&text=hello',
    'GET /utils/hash?algo=sha256&text=hello',
    'GET /utils/uuid?count=5',
    'GET /utils/ip',
    'GET /utils/time',
    'GET /spread?notional=1000',
    'GET /search/github?q=x402&type=repositories',
    'GET /search/npm?q=express',
    'GET /search/wikipedia?q=black+holes',
  ],
}));

app.get('/spread', async (req, res) => {
  try {
    const n = parseFloat(req.query.notional);
    const notional = Number.isFinite(n) && n > 0 ? n : 1000;
    res.json(await latestSpread(notional));
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ---- pay-per-call utilities (pure functions, zero marginal cost) ----
app.get('/utils/base64', (req, res) => {
  const op = (req.query.op || 'encode').toLowerCase();
  try {
    if (op === 'encode') {
      const text = req.query.text ?? '';
      res.json({ op: 'encode', input: text, output: Buffer.from(String(text), 'utf8').toString('base64') });
    } else if (op === 'decode') {
      const data = String(req.query.data ?? '');
      res.json({ op: 'decode', input: data, output: Buffer.from(data, 'base64').toString('utf8') });
    } else {
      res.status(400).json({ error: 'op must be encode or decode' });
    }
  } catch (e) {
    res.status(400).json({ error: 'invalid input: ' + String(e.message || e) });
  }
});

app.get('/utils/hash', (req, res) => {
  const algo = (req.query.algo || 'sha256').toLowerCase();
  if (!['sha256', 'sha512', 'sha1', 'md5'].includes(algo)) {
    return res.status(400).json({ error: 'algo must be one of sha256, sha512, sha1, md5' });
  }
  const text = String(req.query.text ?? '');
  res.json({ algo, input: text, output: createHash(algo).update(text, 'utf8').digest('hex') });
});

app.get('/utils/uuid', (req, res) => {
  let count = parseInt(req.query.count, 10);
  if (!Number.isFinite(count) || count < 1) count = 1;
  count = Math.min(count, 100);
  res.json({ count, uuids: Array.from({ length: count }, () => randomUUID()) });
});

app.get('/utils/ip', (req, res) => {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : (fwd || '')).split(',')[0].trim() || req.socket?.remoteAddress || null;
  if ((req.query.format || 'json').toLowerCase() === 'text') return res.type('text/plain').send(ip || '');
  res.json({ ip });
});

app.get('/utils/time', (req, res) => {
  const now = new Date();
  const format = (req.query.format || 'json').toLowerCase();
  if (format === 'iso') return res.type('text/plain').send(now.toISOString());
  if (format === 'unix') return res.type('text/plain').send(String(Math.floor(now.getTime() / 1000)));
  res.json({ unix: Math.floor(now.getTime() / 1000), unix_ms: now.getTime(), iso8601: now.toISOString() });
});

// ---- pump.fun data (via GeckoTerminal + DexScreener; pump.fun API blocks non-browser) ----
const PUMP_MIGRATION_MCAP = 69000; // USD threshold for Raydium migration

app.get('/pump/chains', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  try {
    const all = [];
    for (const page of [1, 2]) {
      const d = await fetchMaybeXml(`https://api.geckoterminal.com/api/v2/networks?page=${page}`, 10000);
      for (const n of (d.data || [])) {
        all.push({ id: n.id, name: n.attributes?.name });
      }
      if (!(d.data || []).length) break;
    }
    const chains = q ? all.filter(c => c.id.includes(q) || (c.name || '').toLowerCase().includes(q)) : all;
    res.json({ source: 'geckoterminal', count: chains.length, chains, usage: 'Pass any chain id as ?chain= to /pump/new or /pump/trending' });
  } catch (e) {
    res.status(502).json({ error: 'chains lookup failed: ' + String(e.message || e) });
  }
});

app.get('/pump/new', async (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  limit = Math.min(limit, 20);
  const chain = (req.query.chain || 'solana').trim().toLowerCase();
  try {
    const d = await fetchMaybeXml(`https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(chain)}/new_pools?page=1`, 10000);
    const items = (d.data || []).slice(0, limit).map(p => {
      const a = p.attributes || {};
      return { name: a.name, address: a.address, created_at: a.pool_created_at, price_usd: a.base_token_price_usd, dex: p.relationships?.dex?.data?.id || null };
    });
    res.json({ source: 'geckoterminal', network: chain, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: 'pump new lookup failed: ' + String(e.message || e) });
  }
});

app.get('/pump/trending', async (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  limit = Math.min(limit, 20);
  const chain = (req.query.chain || 'solana').trim().toLowerCase();
  try {
    const d = await fetchMaybeXml(`https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(chain)}/trending_pools`, 10000);
    const items = (d.data || []).slice(0, limit).map(p => {
      const a = p.attributes || {};
      return { name: a.name, address: a.address, price_usd: a.base_token_price_usd, price_change_24h: a.price_change_percentage?.h24, volume_24h: a.volume_usd?.h24, liquidity_usd: a.reserve_in_usd };
    });
    res.json({ source: 'geckoterminal', network: chain, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: 'pump trending lookup failed: ' + String(e.message || e) });
  }
});

app.get('/pump/migrating', async (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  limit = Math.min(limit, 15);
  try {
    const profiles = await fetchMaybeXml('https://api.dexscreener.com/token-profiles/latest/v1', 10000);
    const candidates = (Array.isArray(profiles) ? profiles : []).slice(0, 25);
    const checks = await Promise.all(candidates.map(async (t) => {
      try {
        const d = await fetchMaybeXml(`https://api.dexscreener.com/latest/dex/tokens/${t.tokenAddress}`, 8000);
        const pumpPairs = (d.pairs || []).filter(p => (p.dexId || '').toLowerCase().includes('pump'));
        if (!pumpPairs.length) return null;
        const p = pumpPairs[0];
        const mcap = p.fdv || p.marketCap || 0;
        const progress = mcap / PUMP_MIGRATION_MCAP;
        if (progress < 0.5) return null;
        return {
          symbol: p.baseToken?.symbol, name: p.baseToken?.name, address: t.tokenAddress,
          market_cap_usd: mcap, migration_progress_pct: +(progress * 100).toFixed(1),
          price_usd: p.priceUsd, volume_24h: p.volume?.h24, url: p.url,
        };
      } catch { return null; }
    }));
    const items = checks.filter(Boolean).sort((a, b) => b.migration_progress_pct - a.migration_progress_pct).slice(0, limit);
    res.json({ source: 'dexscreener', migration_threshold_usd: PUMP_MIGRATION_MCAP, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: 'migrating lookup failed: ' + String(e.message || e) });
  }
});

// ---- Solana top 100 (CoinGecko solana-ecosystem, priced in USD + SOL) ----
app.get('/solana/top100', async (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 100;
  limit = Math.min(limit, 100);
  try {
    const d = await fetchMaybeXml(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=solana-ecosystem&order=market_cap_desc&per_page=100&page=1',
      15000
    );
    if (!Array.isArray(d)) throw new Error('unexpected upstream response');
    const sol = d.find(c => (c.symbol || '').toLowerCase() === 'sol');
    const solPrice = sol?.current_price || null;
    const items = d.map(c => ({
      rank: c.market_cap_rank,
      symbol: (c.symbol || '').toUpperCase(),
      name: c.name,
      price_usd: c.current_price,
      price_sol: solPrice && c.current_price ? +(c.current_price / solPrice).toFixed(8) : null,
      market_cap_usd: c.market_cap,
      volume_24h_usd: c.total_volume,
      price_change_24h_pct: c.price_change_percentage_24h,
    }));
    const sliced = items.slice(0, limit);
    res.json({ source: 'coingecko', category: 'solana-ecosystem', sol_price_usd: solPrice, count: sliced.length, items: sliced });
  } catch (e) {
    res.status(502).json({ error: 'top100 lookup failed: ' + String(e.message || e) });
  }
});

// ---- tokenized stocks (xStocks via DexScreener; Solana + Base where indexed) ----
const XSTOCKS_TICKERS = ['AAPLx','TSLAx','NVDAx','AMZNx','GOOGLx','METAx','MSFTx','AMDx','NFLXx','COINx','MSTRx','SPYx'];

async function xstockQuote(symbol, chain) {
  try {
    const d = await fetchMaybeXml(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`, 8000);
    const pairs = (d.pairs || []).filter(p => !chain || chain === 'all' || p.chainId === chain);
    if (!pairs.length) return { symbol, found: false };
    const p = pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))[0];
    return {
      symbol: p.baseToken?.symbol || symbol, underlying: symbol.replace(/x$/, ''),
      chain: p.chainId, dex: p.dexId, price_usd: p.priceUsd,
      price_change_24h: p.priceChange?.h24, volume_24h: p.volume?.h24,
      liquidity_usd: p.liquidity?.usd, pair_address: p.pairAddress, found: true,
    };
  } catch { return { symbol, found: false }; }
}

app.get('/stocks/list', async (req, res) => {
  const chain = (req.query.chain || 'solana').trim().toLowerCase();
  const results = await Promise.all(XSTOCKS_TICKERS.map(t => xstockQuote(t, chain)));
  const found = results.filter(r => r.found);
  res.json({ chain, source: 'dexscreener-xstocks', count: found.length, stocks: found, note: chain === 'robinhood' ? 'Robinhood Chain not yet indexed by public aggregators' : null });
});

app.get('/stocks/price', async (req, res) => {
  const symbol = (req.query.symbol || '').trim();
  if (!symbol) return res.status(400).json({ error: 'missing ?symbol= e.g. AAPLx' });
  const chain = (req.query.chain || 'all').trim().toLowerCase();
  res.json(await xstockQuote(symbol, chain));
});

// ---- meme coin data (free upstream APIs: GeckoTerminal + DexScreener) ----
app.get('/meme/trending', async (req, res) => {
  const chain = (req.query.chain || 'solana').trim().toLowerCase();
  try {
    const d = await fetchMaybeXml(`https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(chain)}/trending_pools`, 10000);
    const items = (d.data || []).slice(0, 10).map(p => {
      const a = p.attributes || {};
      return { name: a.name, address: a.address, price_usd: a.base_token_price_usd, price_change_24h: a.price_change_percentage?.h24, volume_24h: a.volume_usd?.h24, liquidity_usd: a.reserve_in_usd, txns_24h_buys: a.transactions?.h24?.buys, txns_24h_sells: a.transactions?.h24?.sells };
    });
    res.json({ chain, source: 'geckoterminal-trending', items });
  } catch (e) {
    res.status(502).json({ error: 'trending lookup failed: ' + String(e.message || e) });
  }
});

app.get('/meme/new', async (req, res) => {
  const chain = (req.query.chain || 'all').trim().toLowerCase();
  try {
    const d = await fetchMaybeXml(`https://api.dexscreener.com/token-profiles/latest/v1`, 10000);
    const items = (Array.isArray(d) ? d : []).filter(t => chain === 'all' || t.chainId === chain).slice(0, 10)
      .map(t => ({ chain: t.chainId, address: t.tokenAddress, description: t.description, url: t.url }));
    res.json({ chain, source: 'dexscreener-new', items });
  } catch (e) {
    res.status(502).json({ error: 'new tokens lookup failed: ' + String(e.message || e) });
  }
});

app.get('/meme/token', async (req, res) => {
  const address = (req.query.address || '').trim();
  if (!address) return res.status(400).json({ error: 'missing ?address= token mint address' });
  try {
    const d = await fetchMaybeXml(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`, 10000);
    const pairs = (d.pairs || []).slice(0, 5).map(p => ({
      dex: p.dexId, chain: p.chainId, price_usd: p.priceUsd,
      volume_24h: p.volume?.h24, liquidity_usd: p.liquidity?.usd,
      price_change_24h: p.priceChange?.h24, url: p.url,
    }));
    if (!pairs.length) return res.json({ address, found: false });
    res.json({ address, found: true, pairs });
  } catch (e) {
    res.status(502).json({ error: 'token lookup failed: ' + String(e.message || e) });
  }
});

// ---- public data search proxies (free upstream APIs, zero marginal cost) ----
const SEARCH_UA = { 'User-Agent': 'x402-utility-api/1.2 (contact: ctiernan21@gmail.com)' };

async function fetchMaybeXml(url, timeoutMs = 10000, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('xml') ? await r.text() : await r.json();
  } finally {
    clearTimeout(t);
  }
}

function searchHandler(source, buildUrl, mapFn, headers = {}) {
  return async (req, res) => {
    const q = (req.query.q || req.query.package || '').trim();
    if (!q) return res.status(400).json({ error: 'missing ?q= query' });
    try {
      const d = await fetchMaybeXml(buildUrl(q), 10000, headers);
      res.json({ query: q, source, items: mapFn(d, q) });
    } catch (e) {
      res.status(502).json({ error: `${source} lookup failed: ` + String(e.message || e) });
    }
  };
}

app.get('/search/npm', searchHandler('npm',
  q => `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=5`,
  d => (d.objects || []).map(o => ({ name: o.package.name, version: o.package.version, description: o.package.description }))
));

app.get('/search/wikipedia', searchHandler('wikipedia',
  q => `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=5&origin=*`,
  d => (d.query?.search || []).map(s => ({ title: s.title, snippet: (s.snippet || '').replace(/<[^>]+>/g, '') }))
));

app.get('/search/arxiv', searchHandler('arxiv',
  q => `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=5`,
  xml => [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
    const e = m[1];
    const t = (re) => ((e.match(re) || [])[1] || '').trim().replace(/\s+/g, ' ') || null;
    return { title: t(/<title>([\s\S]*?)<\/title>/), id: t(/<id>([\s\S]*?)<\/id>/), published: t(/<published>([\s\S]*?)<\/published>/), summary: (t(/<summary>([\s\S]*?)<\/summary>/) || '').slice(0, 300) };
  })
));

app.get('/search/sec', searchHandler('sec-edgar',
  q => `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}`,
  d => (d.hits?.hits || []).slice(0, 5).map(h => ({ form: h._source?.form, filed: h._source?.file_date, accession: h._id }))
, SEARCH_UA));

app.get('/search/hn', searchHandler('hackernews',
  q => `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=5`,
  d => (d.hits || []).map(h => ({ title: h.title, url: h.url, points: h.points, comments: h.num_comments }))
));

app.get('/search/geo', searchHandler('openstreetmap',
  q => `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`,
  d => (Array.isArray(d) ? d : []).map(p => ({ name: p.display_name, lat: p.lat, lon: p.lon }))
, SEARCH_UA));

app.get('/lookup/pypi', searchHandler('pypi',
  q => `https://pypi.org/pypi/${encodeURIComponent(q)}/json`,
  (d) => [{ name: d.info?.name, version: d.info?.version, summary: d.info?.summary }]
));

app.get('/search/fda', searchHandler('openfda',
  q => `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(q)}&limit=3`,
  d => (d.results || []).map(r => ({ brand: r.openfda?.brand_name?.[0] || null, generic: r.openfda?.generic_name?.[0] || null, manufacturer: r.openfda?.manufacturer_name?.[0] || null }))
));

// ---- GitHub search proxy (free upstream API, zero marginal cost) ----
const GH_SEARCH_TYPES = new Set(['repositories', 'code', 'users', 'issues']);
app.get('/search/github', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing ?q= search query' });
  let type = (req.query.type || 'repositories').toLowerCase();
  if (type === 'repos') type = 'repositories';
  if (!GH_SEARCH_TYPES.has(type)) {
    return res.status(400).json({ error: 'type must be one of repositories, code, users, issues' });
  }
  let perPage = parseInt(req.query.per_page, 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 5;
  perPage = Math.min(perPage, 20);
  try {
    const d = await fetchJson(
      `https://api.github.com/search/${type}?q=${encodeURIComponent(q)}&per_page=${perPage}`,
      10000
    );
    const items = (d.items || []).map(it => ({
      name: it.full_name || it.name || it.login,
      url: it.html_url,
      description: it.description || null,
      stars: it.stargazers_count ?? null,
      updated: it.updated_at || null,
    }));
    res.json({ query: q, type, total_count: d.total_count, returned: items.length, items });
  } catch (e) {
    res.status(502).json({ error: 'GitHub search failed: ' + String(e.message || e) });
  }
});

// ---- validators (pure functions, zero marginal cost) ----
function luhnNpiValid(npi) {
  if (!/^\d{10}$/.test(npi)) return false;
  const s = '80840' + npi;
  let total = 0;
  [...s].reverse().forEach((ch, i) => {
    let d = parseInt(ch, 10);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    total += d;
  });
  return total % 10 === 0;
}

function deaFormatValid(dea) {
  const m = /^([A-Z]{2})(\d{7})$/.exec((dea || '').toUpperCase());
  if (!m) return false;
  const d = [...m[2]].map(Number);
  return ((d[0] + d[2] + d[4]) + 2 * (d[1] + d[3] + d[5])) % 10 === d[6];
}

async function npiLookup(npi) {
  const d = await fetchJson(`https://npiregistry.cms.hhs.gov/api/?number=${npi}&version=2.1`);
  if (!d.result_count || !d.results?.length) return null;
  const r = d.results[0];
  const name = r.basic.organization_name
    || [r.basic.first_name, r.basic.last_name].filter(Boolean).join(' ') || null;
  return {
    npi: r.number,
    name,
    status: r.basic.status,
    enumeration_type: r.enumeration_type,
    taxonomies: (r.taxonomies || []).map(t => ({ code: t.code, desc: t.desc, primary: !!t.primary })),
    address: r.addresses?.[0] ? {
      line1: r.addresses[0].address_1, city: r.addresses[0].city,
      state: r.addresses[0].state, zip: r.addresses[0].postal_code, phone: r.addresses[0].telephone_number,
    } : null,
  };
}

// ---- paid verification endpoints ----
app.get('/verify/npi', async (req, res) => {
  const npi = (req.query.npi || '').trim();
  if (!luhnNpiValid(npi)) {
    return res.json({ npi, valid_format: false, registered: false, reason: 'fails NPI checksum' });
  }
  try {
    const rec = await npiLookup(npi);
    if (!rec) return res.json({ npi, valid_format: true, registered: false });
    res.json({ npi, valid_format: true, registered: true, ...rec, disclaimer: 'NPI registration does not confirm licensure or good standing.' });
  } catch (e) {
    res.status(502).json({ error: 'NPPES lookup failed: ' + String(e.message || e) });
  }
});

app.get('/verify/dea', (req, res) => {
  const dea = (req.query.dea || '').trim().toUpperCase();
  const valid = deaFormatValid(dea);
  res.json({
    dea,
    valid_format: valid,
    ...(valid ? {} : { reason: 'must be 2 letters + 7 digits passing the DEA checksum' }),
    disclaimer: 'Format validity does NOT confirm active DEA registration.',
  });
});

// Discovery: OpenAPI 3.1 document — required by x402scan for listing
// Discovery: OpenAPI 3.1 document — required by x402scan for listing
app.get('/openapi.json', (req, res) => res.json({
  openapi: '3.1.0',
  info: {
    title: 'x402 utility + data APIs',
    version: '1.2.0',
    description: 'Pay-per-call micro-utilities (base64, hashing, UUIDs, IP echo, time) at $0.001 USDC per call, plus live SOL multi-venue spread data ($0.005), GitHub search ($0.005), npm/Wikipedia/arXiv/SEC/HN/geo/PyPI/FDA search ($0.005), and NPI/DEA verification. Accepts USDC via x402 on Base and Solana mainnet.',
    contact: { email: 'ctiernan21@gmail.com' },
  },
  servers: [{ url: API_URL }],
  paths: {
    '/utils/base64': {
      get: {
        operationId: 'base64Util',
        summary: 'Base64 encode or decode text',
        tags: ['Utilities'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'op', in: 'query', required: false, schema: { type: 'string', enum: ['encode', 'decode'], default: 'encode' } },
          { name: 'text', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'data', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Result', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.001 USDC via x402' },
        },
      },
    },
    '/utils/hash': {
      get: {
        operationId: 'hashUtil',
        summary: 'Hash text (sha256, sha512, sha1, md5)',
        tags: ['Utilities'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'algo', in: 'query', required: false, schema: { type: 'string', enum: ['sha256', 'sha512', 'sha1', 'md5'], default: 'sha256' } },
          { name: 'text', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Hex digest', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.001 USDC via x402' },
        },
      },
    },
    '/utils/uuid': {
      get: {
        operationId: 'uuidUtil',
        summary: 'Generate UUID v4 values',
        tags: ['Utilities'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'count', in: 'query', required: false, schema: { type: 'integer', default: 1, minimum: 1, maximum: 100 } },
        ],
        responses: {
          200: { description: 'UUIDs', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.001 USDC via x402' },
        },
      },
    },
    '/utils/ip': {
      get: {
        operationId: 'ipEcho',
        summary: 'Echo caller IP address',
        tags: ['Utilities'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'format', in: 'query', required: false, description: 'Response format', schema: { type: 'string', enum: ['json', 'text'], default: 'json' } },
        ],
        responses: {
          200: { description: 'IP', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.001 USDC via x402' },
        },
      },
    },
    '/utils/time': {
      get: {
        operationId: 'timeUtil',
        summary: 'Current unix timestamp and ISO 8601 time',
        tags: ['Utilities'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'format', in: 'query', required: false, description: 'Response format', schema: { type: 'string', enum: ['json', 'iso', 'unix'], default: 'json' } },
        ],
        responses: {
          200: { description: 'Time', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.001 USDC via x402' },
        },
      },
    },
    '/spread': {
      get: {
        operationId: 'getSpread',
        summary: 'Live SOL prices: top 5 CEXs + top 5 Solana DEXs',
        tags: ['Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'notional', in: 'query', required: false, schema: { type: 'number', default: 1000, minimum: 1 } },
        ],
        responses: {
          200: { description: 'Spread snapshot', content: { 'application/json': { schema: { $ref: '#/components/schemas/Spread' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/verify/npi': {
      get: {
        operationId: 'verifyNpi',
        summary: 'Validate NPI checksum + CMS NPPES enrichment',
        tags: ['Verification'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.010000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'npi', in: 'query', required: true, schema: { type: 'string', pattern: '^[0-9]{10}$' } },
        ],
        responses: {
          200: { description: 'NPI result', content: { 'application/json': { schema: { $ref: '#/components/schemas/NpiResult' } } } },
          402: { description: 'Payment Required: $0.01 USDC via x402' },
        },
      },
    },
    '/verify/dea': {
      get: {
        operationId: 'verifyDea',
        summary: 'Validate DEA number format + checksum',
        tags: ['Verification'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'dea', in: 'query', required: true, schema: { type: 'string', pattern: '^[A-Za-z]{2}[0-9]{7}$' } },
        ],
        responses: {
          200: { description: 'DEA result', content: { 'application/json': { schema: { $ref: '#/components/schemas/DeaResult' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/search/npm': {
      get: {
        operationId: 'npmSearch',
        summary: 'Search npm packages',
        tags: ['Search'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/search/wikipedia': {
      get: {
        operationId: 'wikipediaSearch',
        summary: 'Search Wikipedia articles',
        tags: ['Search'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/search/arxiv': {
      get: {
        operationId: 'arxivSearch',
        summary: 'Search arXiv papers',
        tags: ['Search'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/search/sec': {
      get: {
        operationId: 'secSearch',
        summary: 'Search SEC EDGAR filings',
        tags: ['Search'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/search/hn': {
      get: {
        operationId: 'hnSearch',
        summary: 'Search Hacker News',
        tags: ['Search'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/search/geo': {
      get: {
        operationId: 'geoSearch',
        summary: 'Geocode via OpenStreetMap',
        tags: ['Search'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/lookup/pypi': {
      get: {
        operationId: 'pypiLookup',
        summary: 'Look up a PyPI package',
        tags: ['Search'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'package', in: 'query', required: true, schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/search/fda': {
      get: {
        operationId: 'fdaSearch',
        summary: 'Search FDA drug labels',
        tags: ['Search'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/pump/chains': {
      get: {
        operationId: 'pumpChains',
        summary: 'List all supported blockchain networks for meme endpoints',
        tags: ['Pump.fun'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'q', in: 'query', required: false, description: 'Filter chains by name (e.g. solana)', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Chain list', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/pump/new': {
      get: {
        operationId: 'pumpNew',
        summary: 'Newly launched meme coins on any chain (pump.fun, Clanker, Four.meme, SunPump)',
        tags: ['Pump.fun'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'chain', in: 'query', required: false, description: 'solana, base, bsc, tron (default solana)', schema: { type: 'string', default: 'solana' } },
          { name: 'limit', in: 'query', required: false, description: 'How many (default 10)', schema: { type: 'integer', default: 10, minimum: 1, maximum: 20 } },
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/pump/trending': {
      get: {
        operationId: 'pumpTrending',
        summary: 'Trending meme coin pools on any chain',
        tags: ['Pump.fun'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'chain', in: 'query', required: false, description: 'solana, base, bsc, tron (default solana)', schema: { type: 'string', default: 'solana' } },
          { name: 'limit', in: 'query', required: false, description: 'How many (default 10)', schema: { type: 'integer', default: 10, minimum: 1, maximum: 20 } },
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/pump/migrating': {
      get: {
        operationId: 'pumpMigrating',
        summary: 'pump.fun tokens nearing Raydium migration',
        tags: ['Pump.fun'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'limit', in: 'query', required: false, description: 'How many (default 10)', schema: { type: 'integer', default: 10, minimum: 1, maximum: 20 } },
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/solana/top100': {
      get: {
        operationId: 'solanaTop100',
        summary: 'Top 100 Solana ecosystem tokens by market cap (USD + SOL prices)',
        tags: ['Solana'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'limit', in: 'query', required: false, description: 'How many tokens (1-100, default 100)', schema: { type: 'integer', default: 100, minimum: 1, maximum: 100 } },
        ],
        responses: {
          200: { description: 'Top 100 list', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/stocks/list': {
      get: {
        operationId: 'stocksList',
        summary: 'List tokenized stocks with live prices',
        tags: ['Stocks'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'chain', in: 'query', required: false, description: 'Chain (default solana)', schema: { type: 'string', default: 'solana' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/stocks/price': {
      get: {
        operationId: 'stocksPrice',
        summary: 'Tokenized stock quote by symbol',
        tags: ['Stocks'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'symbol', in: 'query', required: true, description: 'e.g. AAPLx, TSLAx', schema: { type: 'string' } },
          { name: 'chain', in: 'query', required: false, schema: { type: 'string', default: 'all' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/meme/trending': {
      get: {
        operationId: 'memeTrending',
        summary: 'Trending meme coin pools by chain',
        tags: ['Meme Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'chain', in: 'query', required: false, description: 'Chain (default solana)', schema: { type: 'string', default: 'solana' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/meme/new': {
      get: {
        operationId: 'memeNew',
        summary: 'Newly launched tokens',
        tags: ['Meme Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'chain', in: 'query', required: false, description: 'Filter by chain id or all', schema: { type: 'string', default: 'all' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/meme/token': {
      get: {
        operationId: 'memeToken',
        summary: 'Token data by address',
        tags: ['Meme Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'address', in: 'query', required: true, description: 'Token mint/contract address', schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/search/github': {
      get: {
        operationId: 'githubSearch',
        summary: 'Search GitHub repositories, code, users, or issues',
        tags: ['Search'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'q', in: 'query', required: true, description: 'Search query (GitHub search syntax)', schema: { type: 'string' } },
          { name: 'type', in: 'query', required: false, description: 'What to search', schema: { type: 'string', enum: ['repositories', 'code', 'users', 'issues'], default: 'repositories' } },
          { name: 'per_page', in: 'query', required: false, description: 'Results to return (1-20, default 5)', schema: { type: 'integer', default: 5, minimum: 1, maximum: 20 } },
        ],
        responses: {
          200: { description: 'Search results', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
  },
  components: {
    schemas: {
      Spread: {
        type: 'object',
        properties: {
          ts_utc: { type: 'string', format: 'date-time' },
          asset: { type: 'string' },
          cex: { type: 'object', additionalProperties: { type: 'number' } },
          dex: { type: 'object', additionalProperties: { type: 'number' } },
          venues_reporting: { type: 'integer' },
          widest_spread: {
            type: 'object',
            properties: {
              buy_at: { type: 'string' },
              buy_price: { type: 'number' },
              sell_at: { type: 'string' },
              sell_price: { type: 'number' },
              gross_pct: { type: 'number' },
              est_net_pct: { type: 'number' },
            },
          },
          notional_usd: { type: 'number' },
        },
      },
    },
      NpiResult: {
        type: 'object',
        properties: {
          npi: { type: 'string' },
          valid_format: { type: 'boolean' },
          registered: { type: 'boolean' },
          name: { type: 'string' },
          status: { type: 'string' },
          disclaimer: { type: 'string' },
        },
      },
      DeaResult: {
        type: 'object',
        properties: {
          dea: { type: 'string' },
          valid_format: { type: 'boolean' },
          reason: { type: 'string' },
          disclaimer: { type: 'string' },
        },
      },
  },
}));

// Discovery: lets x402 directories auto-index this service
app.get('/.well-known/x402.json', (req, res) => {
  const acceptsForDoc = (price) => [
    ...Object.entries(EVM_NETWORKS).map(([name, network]) => ({
      scheme: 'exact', network, asset: 'USDC', payTo: PAY_TO_EVM, chain: name,
    })),
    { scheme: 'exact', network: SOL_NETWORK, asset: 'USDC', payTo: PAY_TO_SOL, chain: 'solana' },
  ];
  const ep = (path, description, price) => ({ path, method: 'GET', description, price, accepts: acceptsForDoc(price) });
  res.json({
    name: 'x402 utility + data APIs',
    description: 'Pay-per-call micro-utilities (base64, hashing, UUIDs, IP echo, time) at $0.001 USDC, plus live SOL multi-venue spread data, GitHub search, and NPI/DEA verification. Accepts USDC on Base and Solana.',
    url: API_URL,
    x402Version: 2,
    networks: [...Object.values(EVM_NETWORKS), SOL_NETWORK],
    endpoints: [
      ep('/utils/base64', 'Base64 encode (?op=encode&text=) or decode (?op=decode&data=)', UTILS_PRICE),
      ep('/utils/hash', 'Hash text (?algo=sha256|sha512|sha1|md5&text=)', UTILS_PRICE),
      ep('/utils/uuid', 'Generate UUID v4s (?count=1..100)', UTILS_PRICE),
      ep('/utils/ip', 'Echo the caller IP address (?format=json|text)', UTILS_PRICE),
      ep('/utils/time', 'Current time (?format=json|iso|unix)', UTILS_PRICE),
      ep('/spread', 'Live SOL prices across top 5 CEXs + top 5 Solana DEXs with widest spread', PRICE),
      ep('/search/npm', 'Search npm packages (?q=)', PRICE),
      ep('/search/wikipedia', 'Search Wikipedia articles (?q=)', PRICE),
      ep('/search/arxiv', 'Search arXiv papers (?q=)', PRICE),
      ep('/search/sec', 'Search SEC EDGAR filings (?q=)', PRICE),
      ep('/search/hn', 'Search Hacker News (?q=)', PRICE),
      ep('/search/geo', 'Geocode via OpenStreetMap (?q=)', PRICE),
      ep('/lookup/pypi', 'Look up a PyPI package (?package=)', PRICE),
      ep('/search/fda', 'Search FDA drug labels (?q=)', PRICE),
      ep('/pump/chains', 'All 100+ chains supported by meme endpoints', PRICE),
      ep('/pump/new', 'New meme launches on any of 100+ chains (?chain=, see /pump/chains)', PRICE),
      ep('/pump/trending', 'Trending meme pools on any of 100+ chains (?chain=, see /pump/chains)', PRICE),
      ep('/pump/migrating', 'pump.fun near Raydium migration (?limit=)', PRICE),
      ep('/solana/top100', 'Top 100 Solana tokens by mcap, USD + SOL prices (?limit=)', PRICE),
      ep('/stocks/list', 'Tokenized stocks with prices (?chain=solana)', PRICE),
      ep('/stocks/price', 'Tokenized stock quote (?symbol=AAPLx)', PRICE),
      ep('/meme/trending', 'Trending meme coin pools (?chain=solana)', PRICE),
      ep('/meme/new', 'Newly launched tokens (?chain=)', PRICE),
      ep('/meme/token', 'Token price/volume/liquidity (?address=)', PRICE),
      ep('/search/github', 'Search GitHub repos, code, users, issues (?q=, ?type=)', PRICE),
      ep('/verify/npi', 'Validate NPI checksum + CMS NPPES enrichment', VERIFY_PRICE),
      ep('/verify/dea', 'Validate DEA number format + checksum', PRICE),
    ],
  });
});

const PORT = process.env.PORT || 3402;
app.listen(PORT, () => console.log(`paywall up on :${PORT}`));
