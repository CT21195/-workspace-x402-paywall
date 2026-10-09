import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createFacilitatorConfig } from '@coinbase/x402';

// ---- config ----
const PAY_TO_EVM = process.env.X402_PAY_TO || '0xD7CDd563e8F6A249B076A702b7e2C233CCF3481d'; // Chris's Base wallet
const PAY_TO_SOL = process.env.X402_PAY_TO_SOL || 'E21AWkUtLz4BP7AaT82CF7v86Kmv4YzN4NAR1FQnEmqy'; // Chris's Solana wallet
const PRICE = '$0.005'; // USDC per request (half a cent)
const UTILS_PRICE = '$0.001'; // USDC per utility call (a tenth of a cent — matches X Pay-style pricing)
const VERIFY_PRICE = '$0.01'; // USDC per verification request
const ALPHA_PRICE = '$0.05'; // USDC per whale-alpha request (premium tier)
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
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
  let lastErr;
  for (let i = 0; i < 3; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
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

const CDP_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET;
const facilitatorClient = (CDP_KEY_ID && CDP_KEY_SECRET)
  ? new HTTPFacilitatorClient(createFacilitatorConfig(CDP_KEY_ID, CDP_KEY_SECRET))
  : new HTTPFacilitatorClient({ url: 'https://facilitator.openx402.ai' });
console.log(`facilitator: ${CDP_KEY_ID ? 'CDP (api.cdp.coinbase.com)' : 'openx402.ai (fallback)'}`);
const resourceServer = new x402ResourceServer(facilitatorClient);
for (const net of Object.values(EVM_NETWORKS)) {
  resourceServer.register(net, new ExactEvmScheme());
}
resourceServer.register(SOL_NETWORK, new ExactSvmScheme());
// Bazaar discovery: Coinbase's Bazaar only indexes settlements whose payment
// payload echoes extensions.bazaar, so every route declares it below.
resourceServer.registerExtension(bazaarResourceServerExtension);
// If the client didn't echo the bazaar extension, fill it in server-side.
// These fields sit outside the payment signature, so this is safe.
resourceServer.onBeforeVerify(async ({ paymentPayload, declaredExtensions }) => {
  if (!paymentPayload.extensions?.bazaar && declaredExtensions?.bazaar) {
    paymentPayload.extensions = { ...paymentPayload.extensions, bazaar: declaredExtensions.bazaar };
  }
});

// Build the Bazaar discovery extension for a route from its query params
// ([{ n, req, d }] -> input schema agents can call).
function bazaarExt(params) {
  const properties = {};
  const required = [];
  const input = {};
  for (const p of params || []) {
    properties[p.n] = { type: 'string', description: p.d || '' };
    if (p.req) required.push(p.n);
    // example value so the Bazaar validator sees required params present
    input[p.n] = p.def !== undefined ? String(p.def) : 'example';
  }
  // declareDiscoveryExtension returns the full { bazaar: { info, schema } } map
  return declareDiscoveryExtension({
    method: 'GET',
    ...(Object.keys(properties).length
      ? {
          input,
          inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        }
      : {}),
  });
}


// ================= MASTER API (39 endpoints, data-driven) =================
const MASTER_UA = { 'User-Agent': 'x402-master-api/1.0 (contact: ctiernan21@gmail.com)' };
const UA = MASTER_UA; // alias used inside MASTER_APIS
const AI_PRICE = '$0.01'; // master API: AI inference tier

async function fetchUpstream(url, timeoutMs = 12000, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

// Retry wrapper: transient upstream failures (429/5xx/timeouts) retry with
// backoff instead of immediately 502ing a paid call.
async function fetchUpstreamRetry(url, timeoutMs = 12000, headers = {}, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchUpstream(url, timeoutMs, headers);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// Simple in-memory cache: avoids re-hitting rate-limited upstreams
// (GeckoTerminal, CoinGecko) on every paid call.
const _cache = new Map();
async function fetchUpstreamCached(url, ttlMs = 300000, timeoutMs = 12000, headers = {}) {
  const now = Date.now();
  const hit = _cache.get(url);
  if (hit && now - hit.t < ttlMs) return hit.d;
  const d = await fetchUpstreamRetry(url, timeoutMs, headers);
  _cache.set(url, { t: now, d });
  // bound cache size
  if (_cache.size > 500) _cache.delete(_cache.keys().next().value);
  return d;
}

const masterNum = (v, dflt, min, max) => {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < min) n = dflt;
  return Math.min(n, max);
};
const num = masterNum; // alias used inside MASTER_APIS url builders

const MASTER_APIS = [
  // AI inference (highest-value x402 category)
  { path: '/ai/ask', price: AI_PRICE, tag: 'AI', summary: 'Ask an LLM anything',
    params: [{ n: 'prompt', req: true, d: 'Your question' }],
    url: q => `https://text.pollinations.ai/${encodeURIComponent(q.prompt)}`,
    map: d => ({ response: typeof d === 'string' ? d : JSON.stringify(d) }) },
  { path: '/ai/image', price: AI_PRICE, tag: 'AI', summary: 'Generate an image from text',
    params: [{ n: 'prompt', req: true, d: 'Image description' }],
    url: q => `https://image.pollinations.ai/prompt/${encodeURIComponent(q.prompt)}?width=1024&height=1024&nologo=true`,
    map: (d, q) => ({ image_url: `https://image.pollinations.ai/prompt/${encodeURIComponent(q.prompt)}?width=1024&height=1024&nologo=true` }),
    passthrough: true },

  // Prediction markets
  { path: '/markets/polymarket', price: PRICE, tag: 'Markets', summary: 'Live Polymarket events and odds',
    params: [{ n: 'limit', req: false, d: 'How many (default 5)', def: 5 }],
    url: q => `https://gamma-api.polymarket.com/events?limit=${num(q.limit, 5, 1, 20)}&active=true&closed=false`,
    map: d => (Array.isArray(d) ? d : []).map(e => ({ title: e.title, slug: e.slug, volume: e.volume, end: e.endDate, markets: (e.markets || []).slice(0, 3).map(m => ({ q: m.question, yes: m.outcomePrices?.[0], no: m.outcomePrices?.[1] })) })) },

  // Crypto
  { path: '/crypto/prices', price: PRICE, tag: 'Crypto', summary: 'Top crypto prices by market cap',
    params: [{ n: 'limit', req: false, d: 'How many (default 10)', def: 10 }],
    url: q => `https://api.coinlore.net/api/tickers/?start=0&limit=${num(q.limit, 10, 1, 50)}`,
    map: d => (d.data || []).map(c => ({ symbol: c.symbol, name: c.name, price_usd: c.price_usd, change_24h: c.percent_change_24h, market_cap: c.market_cap_usd, volume_24h: c.volume24 })) },
  { path: '/crypto/ohlcv', price: PRICE, tag: 'Crypto', summary: 'OHLCV candles for a coin',
    params: [{ n: 'coin', req: true, d: 'e.g. btc-bitcoin' }],
    url: q => `https://api.coinpaprika.com/v1/coins/${encodeURIComponent(q.coin)}/ohlcv/latest/`,
    map: d => (Array.isArray(d) ? d : [d]).slice(0, 5).map(c => ({ time: c.time_open, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })) },
  { path: '/btc/fees', price: PRICE, tag: 'Crypto', summary: 'Bitcoin fee estimates (sat/vB)',
    params: [],
    url: () => `https://mempool.space/api/v1/fees/recommended`,
    map: d => ({ fastest: d.fastestFee, half_hour: d.halfHourFee, hour: d.hourFee, economy: d.economyFee, minimum: d.minimumFee }) },

  // DeFi
  { path: '/defi/tvl', price: PRICE, tag: 'DeFi', summary: 'TVL per chain (468 chains)',
    params: [],
    url: () => `https://api.llama.fi/v2/chains`,
    map: d => (Array.isArray(d) ? d : []).sort((a, b) => (b.tvl || 0) - (a.tvl || 0)).slice(0, 20).map(c => ({ chain: c.name, tvl_usd: Math.round(c.tvl || 0) })) },
  { path: '/defi/yields', price: PRICE, tag: 'DeFi', summary: 'Top DeFi yield pools by APY',
    params: [{ n: 'limit', req: false, d: 'How many (default 10)', def: 10 }],
    url: () => `https://yields.llama.fi/pools`,
    map: (d, q) => (d.data || []).filter(p => p.apy > 0).sort((a, b) => b.apy - a.apy).slice(0, num(q.limit, 10, 1, 20)).map(p => ({ project: p.project, chain: p.chain, symbol: p.symbol, apy: +p.apy.toFixed(2), tvl: Math.round(p.tvlUsd || 0) })) },

  // FX
  { path: '/fx/rates', price: PRICE, tag: 'FX', summary: 'ECB foreign exchange rates',
    params: [{ n: 'base', req: false, d: 'Base currency (default USD)', def: 'USD' }, { n: 'symbols', req: false, d: 'Comma list e.g. EUR,GBP,JPY' }],
    url: q => `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(q.base || 'USD')}${q.symbols ? `&symbols=${encodeURIComponent(q.symbols)}` : ''}`,
    map: d => ({ base: d.base, date: d.date, rates: d.rates }) },
  { path: '/fx/convert', price: PRICE, tag: 'FX', summary: 'Convert currency amount',
    params: [{ n: 'from', req: true, d: 'e.g. EUR' }, { n: 'to', req: true, d: 'e.g. USD' }, { n: 'amount', req: false, d: 'Default 1', def: 1 }],
    url: q => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${encodeURIComponent((q.from || 'eur').toLowerCase())}.json`,
    map: (d, q) => {
      const to = (q.to || 'usd').toLowerCase();
      const rate = d[to];
      const amt = parseFloat(q.amount) || 1;
      return rate ? { from: q.from.toUpperCase(), to: q.to.toUpperCase(), amount: amt, rate, result: +(amt * rate).toFixed(4) } : { error: 'currency not found' };
    } },

  // Weather (wttr.in — no commercial-use restriction unlike Open-Meteo)
  { path: '/weather/current', price: PRICE, tag: 'Weather', summary: 'Current weather + forecast',
    params: [{ n: 'location', req: true, d: 'City or lat,lon' }],
    url: q => `https://wttr.in/${encodeURIComponent(q.location)}?format=j1`,
    map: d => {
      const c = d.current_condition?.[0] || {};
      return { temp_c: c.temp_C, temp_f: c.temp_F, condition: c.weatherDesc?.[0]?.value, humidity: c.humidity, wind_kph: c.windspeedKmph, feels_like_c: c.FeelsLikeC };
    } },

  // Geo
  { path: '/geo/ip', price: PRICE, tag: 'Geo', summary: 'Geolocate an IP address',
    params: [{ n: 'ip', req: true, d: 'e.g. 8.8.8.8' }],
    url: q => `http://ip-api.com/json/${encodeURIComponent(q.ip)}?fields=status,country,countryCode,city,lat,lon,isp,org`,
    map: d => d.status === 'success' ? { country: d.country, code: d.countryCode, city: d.city, lat: d.lat, lon: d.lon, isp: d.isp, org: d.org } : { error: 'lookup failed' } },
  { path: '/geo/zip', price: PRICE, tag: 'Geo', summary: 'City/coords for postal code',
    params: [{ n: 'country', req: true, d: 'e.g. us' }, { n: 'code', req: true, d: 'e.g. 90210' }],
    url: q => `https://api.zippopotam.us/${encodeURIComponent(q.country)}/${encodeURIComponent(q.code)}`,
    map: d => ({ country: d.country, places: (d.places || []).map(p => ({ name: p['place name'], state: p.state, lat: p.latitude, lon: p.longitude })) }) },
  { path: '/geo/sun', price: PRICE, tag: 'Geo', summary: 'Sunrise/sunset times',
    params: [{ n: 'lat', req: true, d: 'Latitude' }, { n: 'lon', req: true, d: 'Longitude' }],
    url: q => `https://api.sunrise-sunset.org/json?lat=${encodeURIComponent(q.lat)}&lng=${encodeURIComponent(q.lon)}&formatted=0`,
    map: d => d.results || {} },
  { path: '/geo/elevation', price: PRICE, tag: 'Geo', summary: 'Elevation for coordinates',
    params: [{ n: 'lat', req: true, d: 'Latitude' }, { n: 'lon', req: true, d: 'Longitude' }],
    url: q => `https://api.opentopodata.org/v1/test-dataset?locations=${encodeURIComponent(q.lat)},${encodeURIComponent(q.lon)}`,
    map: d => ({ elevation_m: d.results?.[0]?.elevation ?? null }) },

  // Government
  { path: '/gov/fbi', price: PRICE, tag: 'Government', summary: 'FBI wanted list',
    params: [{ n: 'limit', req: false, d: 'How many (default 5)', def: 5 }],
    url: q => `https://api.fbi.gov/wanted/v1?limit=${num(q.limit, 5, 1, 20)}&sort_on=modified&sort_order=desc`,
    map: d => ({ total: d.total, items: (d.items || []).map(i => ({ title: i.title, subject: (i.subjects || []).join(','), field_office: i.field_offices?.[0] })) }) },
  { path: '/gov/federal-register', price: PRICE, tag: 'Government', summary: 'Latest US federal regulations',
    params: [{ n: 'limit', req: false, d: 'How many (default 5)', def: 5 }],
    url: q => `https://www.federalregister.gov/api/v1/documents.json?per_page=${num(q.limit, 5, 1, 20)}&order=newest`,
    map: d => (d.results || []).map(r => ({ title: r.title, type: r.type, date: r.publication_date, agency: r.agency_names?.[0] })) },
  { path: '/gov/datasets', price: PRICE, tag: 'Government', summary: 'Search 300k+ US government datasets',
    params: [{ n: 'q', req: true, d: 'Search query' }],
    url: q => `https://catalog.data.gov/api/3/action/package_search?q=${encodeURIComponent(q.q)}&rows=5`,
    map: d => (d.result?.results || []).map(r => ({ title: r.title, notes: (r.notes || '').slice(0, 200), url: r.url })) },
  { path: '/finance/tickers', price: PRICE, tag: 'Finance', summary: 'Every US public company ticker + CIK',
    params: [{ n: 'q', req: false, d: 'Filter by ticker or name' }],
    url: () => `https://www.sec.gov/files/company_tickers.json`,
    headers: UA,
    map: (d, q) => {
      const all = Object.values(d || {});
      const f = q.q ? all.filter(c => (c.ticker || '').toLowerCase().includes(q.q.toLowerCase()) || (c.title || '').toLowerCase().includes(q.q.toLowerCase())) : all;
      return { count: f.length, items: f.slice(0, 10).map(c => ({ ticker: c.ticker, cik: String(c.cik_str).padStart(10, '0'), name: c.title })) };
    } },

  // Health
  { path: '/health/trials', price: PRICE, tag: 'Health', summary: 'Search clinical trials',
    params: [{ n: 'q', req: true, d: 'Condition or keyword' }],
    url: q => `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(q.q)}&pageSize=5`,
    map: d => (d.studies || []).map(s => ({ nct: s.protocolSection?.identificationModule?.nctId, title: s.protocolSection?.identificationModule?.briefTitle, status: s.protocolSection?.statusModule?.overallStatus })) },
  { path: '/health/gene', price: PRICE, tag: 'Health', summary: 'Gene annotations lookup',
    params: [{ n: 'q', req: true, d: 'Gene name e.g. insulin' }],
    url: q => `https://mygene.info/v3/query?q=${encodeURIComponent(q.q)}&size=5`,
    map: d => (d.hits || []).map(h => ({ symbol: h.symbol, name: h.name, taxid: h.taxid })) },

  // Science
  { path: '/science/papers', price: PRICE, tag: 'Science', summary: 'Search 250M+ scholarly works',
    params: [{ n: 'q', req: true, d: 'Search query' }],
    url: q => `https://api.openalex.org/works?search=${encodeURIComponent(q.q)}&per-page=5`,
    map: d => (d.results || []).map(w => ({ title: w.title, year: w.publication_year, citations: w.cited_by_count, doi: w.doi })) },
  { path: '/science/quakes', price: PRICE, tag: 'Science', summary: 'Recent earthquakes (USGS)',
    params: [{ n: 'min', req: false, d: 'Min magnitude (default 5)', def: 5 }],
    url: q => `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=${num(q.min, 5, 1, 9)}&limit=10&orderby=time`,
    map: d => (d.features || []).map(f => ({ place: f.properties?.place, mag: f.properties?.mag, time: new Date(f.properties?.time).toISOString(), url: f.properties?.url })) },
  { path: '/space/iss', price: PRICE, tag: 'Space', summary: 'Live ISS position',
    params: [],
    url: () => `http://api.open-notify.org/iss-now.json`,
    map: d => ({ lat: d.iss_position?.latitude, lon: d.iss_position?.longitude, timestamp: d.timestamp }) },
  { path: '/space/spacex', price: PRICE, tag: 'Space', summary: 'Latest SpaceX launch',
    params: [],
    url: () => `https://api.spacexdata.com/v4/launches/latest`,
    map: d => ({ name: d.name, date: d.date_utc, success: d.success, details: (d.details || '').slice(0, 300) }) },

  // Dev tools
  { path: '/dev/stackoverflow', price: PRICE, tag: 'Dev', summary: 'Search Stack Overflow',
    params: [{ n: 'q', req: true, d: 'Search query' }],
    url: q => `https://api.stackexchange.com/2.3/search?order=desc&sort=votes&intitle=${encodeURIComponent(q.q)}&site=stackoverflow&pagesize=5`,
    map: d => (d.items || []).map(i => ({ title: i.title, score: i.score, answers: i.answer_count, url: i.link })) },
  { path: '/dev/dns', price: PRICE, tag: 'Dev', summary: 'DNS lookup via Google DoH',
    params: [{ n: 'name', req: true, d: 'Domain e.g. example.com' }, { n: 'type', req: false, d: 'Record type (default A)', def: 'A' }],
    url: q => `https://dns.google/resolve?name=${encodeURIComponent(q.name)}&type=${encodeURIComponent(q.type || 'A')}`,
    map: d => ({ answers: (d.Answer || []).map(a => ({ name: a.name, type: a.type, data: a.data })) }) },
  { path: '/dev/crates', price: PRICE, tag: 'Dev', summary: 'Rust crate info',
    params: [{ n: 'crate', req: true, d: 'e.g. serde' }],
    url: q => `https://crates.io/api/v1/crates/${encodeURIComponent(q.crate)}`,
    map: d => ({ name: d.crate?.id, downloads: d.crate?.downloads, version: d.crate?.max_version, description: d.crate?.description }) },

  // Reference
  { path: '/ref/define', price: PRICE, tag: 'Reference', summary: 'Word definitions',
    params: [{ n: 'word', req: true, d: 'e.g. hello' }],
    url: q => `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q.word)}`,
    map: d => (Array.isArray(d) ? d : []).slice(0, 1).map(e => ({ word: e.word, phonetic: e.phonetic, meanings: (e.meanings || []).slice(0, 3).map(m => ({ pos: m.partOfSpeech, defs: (m.definitions || []).slice(0, 2).map(x => x.definition) })) })) },
  { path: '/ref/books', price: PRICE, tag: 'Reference', summary: 'Search Open Library books',
    params: [{ n: 'q', req: true, d: 'Search query' }],
    url: q => `https://openlibrary.org/search.json?q=${encodeURIComponent(q.q)}&limit=5`,
    map: d => (d.docs || []).map(b => ({ title: b.title, author: (b.author_name || [])[0], year: b.first_publish_year })) },
  { path: '/ref/holidays', price: PRICE, tag: 'Reference', summary: 'Public holidays by country/year',
    params: [{ n: 'country', req: true, d: 'e.g. US' }, { n: 'year', req: false, d: 'Default 2026', def: 2026 }],
    url: q => `https://date.nager.at/api/v3/publicholidays/${num(q.year, 2026, 2000, 2030)}/${encodeURIComponent(q.country)}`,
    map: d => (Array.isArray(d) ? d : []).map(h => ({ date: h.date, name: h.name, local: h.localName })) },

  // Entertainment
  { path: '/fun/tv', price: PRICE, tag: 'Fun', summary: 'Search TV shows',
    params: [{ n: 'q', req: true, d: 'Show name' }],
    url: q => `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q.q)}`,
    map: d => (Array.isArray(d) ? d : []).slice(0, 5).map(r => ({ name: r.show?.name, premiered: r.show?.premiered, rating: r.show?.rating?.average, summary: (r.show?.summary || '').replace(/<[^>]+>/g, '').slice(0, 200) })) },
  { path: '/fun/anime', price: PRICE, tag: 'Fun', summary: 'Search anime (MyAnimeList)',
    params: [{ n: 'q', req: true, d: 'Anime name' }],
    url: q => `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q.q)}&limit=5`,
    map: d => (d.data || []).map(a => ({ title: a.title, score: a.score, episodes: a.episodes, url: a.url })) },
  { path: '/fun/lyrics', price: PRICE, tag: 'Fun', summary: 'Song lyrics lookup',
    params: [{ n: 'artist', req: true, d: 'Artist name' }, { n: 'title', req: true, d: 'Song title' }],
    url: q => `https://api.lyrics.ovh/v1/${encodeURIComponent(q.artist)}/${encodeURIComponent(q.title)}`,
    map: d => ({ lyrics: (d.lyrics || '').slice(0, 1000) }) },

  // Sports
  { path: '/sports/football', price: PRICE, tag: 'Sports', summary: 'German Bundesliga matches',
    params: [],
    url: () => `https://api.openligadb.de/getmatchdata/bl1`,
    map: d => (Array.isArray(d) ? d : []).slice(0, 5).map(m => ({ date: m.matchDateTime, home: m.team1?.teamName, away: m.team2?.teamName, score: m.matchResults?.[0] ? `${m.matchResults[0].pointsTeam1}:${m.matchResults[0].pointsTeam2}` : 'upcoming' })) },
  { path: '/sports/nhl', price: PRICE, tag: 'Sports', summary: 'NHL standings',
    params: [],
    url: () => `https://api-web.nhle.com/v1/standings/now`,
    map: d => (d.standings || []).slice(0, 10).map(s => ({ team: s.teamName?.default, wins: s.wins, losses: s.losses, points: s.points })) },

  // Social
  { path: '/social/bluesky', price: PRICE, tag: 'Social', summary: 'Search Bluesky users',
    params: [{ n: 'q', req: true, d: 'Search query' }],
    url: q => `https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(q.q)}&limit=5`,
    map: d => (d.actors || []).map(a => ({ handle: a.handle, name: a.displayName, followers: a.followersCount })) },

  // Food & jobs
  { path: '/food/search', price: PRICE, tag: 'Food', summary: 'Food nutrition lookup',
    params: [{ n: 'q', req: true, d: 'Food name' }],
    url: q => `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q.q)}&search_simple=1&action=process&json=1&page_size=5`,
    map: d => (d.products || []).map(p => ({ name: p.product_name, brand: p.brands, nutriscore: p.nutriscore_grade })) },
  { path: '/jobs/remote', price: PRICE, tag: 'Jobs', summary: 'Remote job listings',
    params: [{ n: 'tag', req: false, d: 'e.g. python' }],
    url: q => `https://remoteok.com/api${q.tag ? `?tag=${encodeURIComponent(q.tag)}` : ''}`,
    headers: UA,
    map: d => (Array.isArray(d) ? d : []).filter(j => j.position).slice(0, 5).map(j => ({ title: j.position, company: j.company, tags: (j.tags || []).slice(0, 5), url: j.url })) },
];

function masterOapiParam(p) {
  const schema = { type: 'string' };
  if (p.def !== undefined && typeof p.def === 'number') { schema.type = 'integer'; schema.default = p.def; }
  else if (p.def !== undefined) schema.default = p.def;
  return { name: p.n, in: 'query', required: !!p.req, description: p.d || '', schema };
}

function buildMasterMw() {
  const mw = {};
  for (const a of MASTER_APIS) {
    mw[`GET ${a.path}`] = {
      accepts: acceptsFor(a.price),
      description: a.summary,
      extensions: bazaarExt(a.params),
    };
  }
  return mw;
}

function buildMasterOapiPaths() {
  const paths = {};
  for (const a of MASTER_APIS) {
    const amt = a.price.replace('$', '');
    paths[a.path] = {
      get: {
        operationId: a.path.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, ''),
        summary: a.summary,
        tags: [a.tag],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: amt.includes('.') ? amt.padEnd(amt.indexOf('.') + 7, '0') : amt + '.000000' }, protocols: [{ x402: {} }] },
        parameters: [...(a.params || []).map(masterOapiParam),
          { name: 'fields', in: 'query', required: false, description: 'Comma-separated fields to return (e.g. name,price_usd)', schema: { type: 'string' } }],
        responses: {
          200: { description: 'Result', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: `Payment Required: ${a.price} USDC via x402` },
        },
      },
    };
  }
  return paths;
}

function registerMasterRoutes(app) {
  for (const a of MASTER_APIS) {
    app.get(a.path, async (req, res) => {
      for (const p of (a.params || [])) {
        if (p.req && !(req.query[p.n] || '').toString().trim()) {
          return res.status(400).json({ error: `missing ?${p.n}= parameter` });
        }
      }
      const q = {};
      for (const p of (a.params || [])) q[p.n] = req.query[p.n];
      try {
        let out = a.passthrough ? a.map(null, q) : a.map(await fetchUpstreamCached(a.url(q), 300000, 12000, a.headers || {}), q);
        if (req.query.fields) {
          const fs = String(req.query.fields).split(',').map(s => s.trim()).filter(Boolean);
          const pick = o => { const r = {}; for (const f of fs) if (o && f in o) r[f] = o[f]; return r; };
          if (Array.isArray(out)) out = out.map(pick);
          else if (out && typeof out === 'object' && Array.isArray(out.items)) out = { ...out, items: out.items.map(pick) };
          else if (out && typeof out === 'object') out = pick(out);
        }
        res.json(out);
      } catch (e) {
        res.status(502).json({ error: `${a.path} failed: ` + String(e.message || e) });
      }
    });
  }
}

function buildMasterX402eps(ep) {
  return MASTER_APIS.map(a => ep(a.path, a.summary, a.price));
}
// ================= /MASTER API =================

const app = express();
app.set('trust proxy', 1); // Render reverse proxy: keeps resource URLs https:// for CDP Bazaar

const masterMw = buildMasterMw();
app.use(paymentMiddleware(
  {
    ...masterMw,
    'GET /spread': {
      accepts: acceptsFor(PRICE),
      description: 'Live SOL prices across top 5 CEXs + top 5 Solana DEXs with widest spread',
      extensions: bazaarExt(),
    },
    'GET /verify/npi': {
      accepts: acceptsFor(VERIFY_PRICE),
      description: 'Validate an NPI number (checksum) and enrich via the CMS NPPES registry',
      extensions: bazaarExt(),
    },
    'GET /verify/dea': {
      accepts: acceptsFor(PRICE),
      description: 'Validate a DEA number format and checksum',
      extensions: bazaarExt(),
    },
    'GET /search/npm': {
      accepts: acceptsFor(PRICE),
      description: 'Search npm packages (?q=)',
      extensions: bazaarExt(),
    },
    'GET /search/wikipedia': {
      accepts: acceptsFor(PRICE),
      description: 'Search Wikipedia articles (?q=)',
      extensions: bazaarExt(),
    },
    'GET /search/arxiv': {
      accepts: acceptsFor(PRICE),
      description: 'Search arXiv papers (?q=)',
      extensions: bazaarExt(),
    },
    'GET /search/sec': {
      accepts: acceptsFor(PRICE),
      description: 'Search SEC EDGAR filings (?q=)',
      extensions: bazaarExt(),
    },
    'GET /search/hn': {
      accepts: acceptsFor(PRICE),
      description: 'Search Hacker News (?q=)',
      extensions: bazaarExt(),
    },
    'GET /search/geo': {
      accepts: acceptsFor(PRICE),
      description: 'Geocode an address via OpenStreetMap (?q=)',
      extensions: bazaarExt(),
    },
    'GET /lookup/pypi': {
      accepts: acceptsFor(PRICE),
      description: 'Look up a PyPI package (?package=)',
      extensions: bazaarExt(),
    },
    'GET /search/fda': {
      accepts: acceptsFor(PRICE),
      description: 'Search FDA drug labels (?q=)',
      extensions: bazaarExt(),
    },
    'GET /pump/chains': {
      accepts: acceptsFor(PRICE),
      description: 'List all 100+ supported chains for meme endpoints',
      extensions: bazaarExt(),
    },
    'GET /pump/new': {
      accepts: acceptsFor(PRICE),
      description: 'Newly launched pump.fun tokens (?limit=)',
      extensions: bazaarExt(),
    },
    'GET /pump/trending': {
      accepts: acceptsFor(PRICE),
      description: 'Trending Solana pools incl. pump.fun (?limit=)',
      extensions: bazaarExt(),
    },
    'GET /pump/migrating': {
      accepts: acceptsFor(PRICE),
      description: 'pump.fun tokens near Raydium migration (?limit=)',
      extensions: bazaarExt(),
    },
    'GET /solana/top100': {
      accepts: acceptsFor(PRICE),
      description: 'Top 100 Solana tokens by market cap, priced in USD and SOL',
      extensions: bazaarExt(),
    },
    'GET /stocks/list': {
      accepts: acceptsFor(PRICE),
      description: 'List tokenized stocks with prices (?chain=solana)',
      extensions: bazaarExt(),
    },
    'GET /stocks/price': {
      accepts: acceptsFor(PRICE),
      description: 'Tokenized stock quote (?symbol=AAPLx&chain=solana)',
      extensions: bazaarExt(),
    },
    'GET /meme/trending': {
      accepts: acceptsFor(PRICE),
      description: 'Trending meme coin pools (?chain=solana)',
      extensions: bazaarExt(),
    },
    'GET /meme/new': {
      accepts: acceptsFor(PRICE),
      description: 'Newly launched tokens (?chain=solana or all)',
      extensions: bazaarExt(),
    },
    'GET /meme/token': {
      accepts: acceptsFor(PRICE),
      description: 'Token price/volume/liquidity by address (?address=)',
      extensions: bazaarExt(),
    },
    'GET /search/github': {
      accepts: acceptsFor(PRICE),
      description: 'Search GitHub repos, code, or users (?q=, ?type=repos|code|users)',
      extensions: bazaarExt(),
    },
    'GET /scrape': {
      accepts: acceptsFor(AI_PRICE),
      description: 'Scrape a URL and return clean markdown (?url=)',
      extensions: bazaarExt([{ n: 'url', req: true, d: 'URL to scrape' }]),
    },
    'GET /whale-watch': {
      accepts: acceptsFor(ALPHA_PRICE),
      description: 'Recent swaps for a Solana wallet (?wallet=address&limit=5)',
      extensions: bazaarExt([
        { n: 'wallet', req: true, d: 'Solana wallet address to track' },
        { n: 'limit', req: false, d: 'How many swaps (default 5, max 20)' },
      ]),
    },
    // ---- pay-per-call utilities (zero marginal cost, X Pay-style) ----
    'GET /utils/base64': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Base64 encode (?op=encode&text=) or decode (?op=decode&data=)',
      extensions: bazaarExt(),
    },
    'GET /utils/hash': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Hash text (?algo=sha256|sha512|sha1|md5&text=)',
      extensions: bazaarExt(),
    },
    'GET /utils/uuid': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Generate UUID v4s (?count=1..100)',
      extensions: bazaarExt(),
    },
    'GET /utils/ip': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Echo the caller IP address',
      extensions: bazaarExt(),
    },
    'GET /utils/time': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Current unix timestamp + ISO 8601 time',
      extensions: bazaarExt(),
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
  let lastErr;
  for (let i = 0; i < 3; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      return ct.includes('xml') ? await r.text() : await r.json();
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
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

// ---- web scraper -> markdown (Node port of trafilatura logic) ----
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const SCRAPE_UA = { 'User-Agent': 'x402-scraper/1.0 (contact: ctiernan21@gmail.com)' };

function isPublicUrl(target) {
  try {
    const u = new URL(target);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    // block localhost / private / metadata endpoints without DNS lookup
    if (h === 'localhost' || h.endsWith('.local') || h === 'metadata.google.internal') return false;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(h)) return false;
    if (h === '169.254.169.254') return false; // cloud metadata
    return true;
  } catch { return false; }
}

app.get('/scrape', async (req, res) => {
  const target = (req.query.url || '').trim();
  if (!target) return res.status(400).json({ error: 'missing ?url=' });
  if (!isPublicUrl(target)) return res.status(400).json({ error: 'URL must be a public http(s) address' });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let html;
    try {
      const r = await fetch(target, { signal: ctrl.signal, headers: SCRAPE_UA, redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      html = await r.text();
    } finally { clearTimeout(t); }
    // extract readable content (readability) then convert to markdown (turndown)
    const doc = new JSDOM(html, { url: target });
    const reader = new Readability(doc.window.document);
    const article = reader.parse();
    if (!article || !article.content) {
      return res.status(422).json({ error: 'Failed to extract readable content from the page.' });
    }
    const markdown = turndown.turndown(article.content).trim();
    if (!markdown) return res.status(422).json({ error: 'Page had no extractable text.' });
    res.json({
      source_url: target,
      title: article.title || null,
      content_length: markdown.length,
      markdown: markdown.slice(0, 50000), // cap response size
    });
  } catch (e) {
    res.status(502).json({ error: 'Scrape failed: ' + String(e.message || e) });
  }
});

// ---- whale watch: recent Solana swaps via Helius (premium tier) ----
function isValidSolanaAddress(addr) {
  // 32-byte Solana addresses encode to 32-44 base58 characters
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

app.get('/whale-watch', async (req, res) => {
  const wallet = (req.query.wallet || '').trim();
  if (!wallet) return res.status(400).json({ error: 'missing ?wallet= Solana address' });
  if (!isValidSolanaAddress(wallet)) return res.status(400).json({ error: 'invalid Solana wallet address' });
  if (!HELIUS_API_KEY) return res.status(503).json({ error: 'whale-watch not configured (missing Helius API key)' });
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 5;
  limit = Math.min(limit, 20);
  try {
    const url = `https://api.helius.xyz/v1/wallet/${wallet}/history?api-key=${HELIUS_API_KEY}&type=SWAP&limit=${limit}`;
    const txs = await fetchUpstreamRetry(url, 15000);
    if (!Array.isArray(txs)) throw new Error('unexpected Helius response');
    const recent_swaps = txs.map(tx => ({
      timestamp: tx.timestamp ?? null,
      signature: tx.signature ?? null,
      action: tx.description ?? null,
      network_fee: tx.fee ?? null,
    }));
    res.json({ target_whale: wallet, returned: recent_swaps.length, recent_swaps });
  } catch (e) {
    res.status(502).json({ error: 'Whale lookup failed: ' + String(e.message || e) });
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
registerMasterRoutes(app);

app.get('/openapi.json', (req, res) => res.json({
  openapi: '3.1.0',
  info: {
    title: 'x402 master data API — 66 endpoints',
    version: '2.0.0',
    description: '66 pay-per-call APIs: AI text/image generation ($0.01), Polymarket odds, crypto prices, DeFi yields, FX rates, weather, IP/geo, FBI wanted, SEC tickers, clinical trials, 250M academic papers, Stack Overflow, meme-coin launchpads (pump.fun, Clanker, Four.meme, SunPump), tokenized stocks, Solana top 100, and 40+ more. $0.005/call standard. USDC on Base and Solana via x402.',
    contact: { email: 'ctiernan21@gmail.com' },
  },
  servers: [{ url: API_URL }],
  paths: {
    ...buildMasterOapiPaths(),
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
    '/scrape': {
      get: {
        operationId: 'scrapeUrl',
        summary: 'Scrape a URL and return clean markdown',
        tags: ['AI Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.010000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'url', in: 'query', required: true, description: 'Target URL', schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Markdown content', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.01 USDC via x402' },
        },
      },
    },
    '/whale-watch': {
      get: {
        operationId: 'whaleWatch',
        summary: 'Recent swaps for a Solana wallet',
        tags: ['Crypto'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.050000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'wallet', in: 'query', required: true, description: 'Solana address', schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 5, minimum: 1, maximum: 20 } }
        ],
        responses: {
          200: { description: 'Recent swaps', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.05 USDC via x402' },
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
    name: 'x402 master data API — 66 endpoints',
    description: '66 pay-per-call APIs: AI text/image generation ($0.01), Polymarket odds, crypto prices, DeFi yields, FX rates, weather, IP/geo, FBI wanted, SEC tickers, clinical trials, 250M academic papers, Stack Overflow, meme-coin launchpads (pump.fun, Clanker, Four.meme, SunPump), tokenized stocks, Solana top 100, and 40+ more. $0.005/call standard. USDC on Base and Solana via x402.',
    url: API_URL,
    x402Version: 2,
    networks: [...Object.values(EVM_NETWORKS), SOL_NETWORK],
    endpoints: [
      ...buildMasterX402eps(ep),
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
      ep('/scrape', 'Scrape a URL and return clean markdown (?url=)', AI_PRICE),
      ep('/whale-watch', 'Recent swaps for a Solana wallet (?wallet=address&limit=5)', ALPHA_PRICE),
    ],
  });
});

const PORT = process.env.PORT || 3402;
app.listen(PORT, () => console.log(`paywall up on :${PORT}`));
