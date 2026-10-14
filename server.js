import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { PDFParse } from 'pdf-parse';
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
const CHAIN_PRICE = '$0.003'; // USDC per chain-read request (matches proven x402 price point)
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

// ---- Base chain spreads: cross-DEX spreads for a Base token (DexScreener, no key) ----
const BASE_WETH = '0x4200000000000000000000000000000000000006';

async function baseSpreadSnapshot(token, notional = 1000) {
  const d = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${token}`, 10000);
  const pairs = (d.pairs || []).filter(p =>
    p.chainId === 'base' && parseFloat(p.priceUsd) > 0
  );
  if (!pairs.length) throw new Error('no Base pairs found for token');
  // top distinct DEXes by 24h volume
  const seen = new Set();
  const dex = {};
  for (const p of pairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))) {
    if (seen.has(p.dexId)) continue;
    seen.add(p.dexId);
    dex[p.dexId] = parseFloat(p.priceUsd);
    if (Object.keys(dex).length >= 5) break;
  }
  const names = Object.keys(dex);
  if (names.length < 2) throw new Error('fewer than 2 Base DEX venues quoting this token');

  let buy = names[0], sell = names[0];
  for (const n of names) {
    if (dex[n] < dex[buy]) buy = n;
    if (dex[n] > dex[sell]) sell = n;
  }
  const gross = (dex[sell] - dex[buy]) / dex[buy] * 100;
  // est. net: ~0.3% round-trip DEX fees + $20 fixed move cost amortized over notional
  const estNet = gross - 0.3 - 20 / notional * 100;

  return {
    ts_utc: new Date().toISOString(),
    chain: 'base',
    asset: pairs[0].baseToken?.symbol || null,
    token,
    dex: Object.fromEntries(Object.entries(dex).map(([k, v]) => [k, +v.toFixed(6)])),
    venues_reporting: names.length,
    widest_spread: {
      buy_at: buy,
      buy_price: +dex[buy].toFixed(6),
      sell_at: sell,
      sell_price: +dex[sell].toFixed(6),
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
  { path: '/ai/ask', price: AI_PRICE, tag: 'AI', summary: 'Sends a text prompt to an LLM and returns the generated text response as a string in a JSON object',
    params: [{ n: 'prompt', req: true, d: 'Requires a text string prompt for the LLM' }],
    url: q => `https://text.pollinations.ai/${encodeURIComponent(q.prompt)}`,
    map: d => ({ response: typeof d === 'string' ? d : JSON.stringify(d) }) },
  { path: '/ai/image', price: AI_PRICE, tag: 'AI', summary: 'Generates a 1024x1024 image from a text description and returns a JSON object with the image URL string',
    params: [{ n: 'prompt', req: true, d: 'Requires a text string describing the image to generate' }],
    url: q => `https://image.pollinations.ai/prompt/${encodeURIComponent(q.prompt)}?width=1024&height=1024&nologo=true`,
    map: (d, q) => ({ image_url: `https://image.pollinations.ai/prompt/${encodeURIComponent(q.prompt)}?width=1024&height=1024&nologo=true` }),
    passthrough: true },

  // Prediction markets
  { path: '/markets/polymarket', price: PRICE, tag: 'Markets', summary: 'Returns a JSON array of live Polymarket prediction market events with odds and volume',
    params: [{ n: 'limit', req: false, d: 'Integer 1-20, number of results to return (default 5)', def: 5 }],
    url: q => `https://gamma-api.polymarket.com/events?limit=${num(q.limit, 5, 1, 20)}&active=true&closed=false`,
    map: d => (Array.isArray(d) ? d : []).map(e => ({ title: e.title, slug: e.slug, volume: e.volume, end: e.endDate, markets: (e.markets || []).slice(0, 3).map(m => ({ q: m.question, yes: m.outcomePrices?.[0], no: m.outcomePrices?.[1] })) })) },

  // Crypto
  { path: '/crypto/prices', price: PRICE, tag: 'Crypto', summary: 'Returns a JSON array of top cryptocurrencies by market cap with USD prices',
    params: [{ n: 'limit', req: false, d: 'Integer 1-50, number of results to return (default 10)', def: 10 }],
    url: q => `https://api.coinlore.net/api/tickers/?start=0&limit=${num(q.limit, 10, 1, 50)}`,
    map: d => (d.data || []).map(c => ({ symbol: c.symbol, name: c.name, price_usd: c.price_usd, change_24h: c.percent_change_24h, market_cap: c.market_cap_usd, volume_24h: c.volume24 })) },
  { path: '/crypto/ohlcv', price: PRICE, tag: 'Crypto', summary: 'Returns a JSON array of OHLCV candlestick data for a cryptocurrency symbol',
    params: [{ n: 'coin', req: true, d: 'Requires a coin ID string in format slug-symbol, e.g. btc-bitcoin' }],
    url: q => `https://api.coinpaprika.com/v1/coins/${encodeURIComponent(q.coin)}/ohlcv/latest/`,
    map: d => (Array.isArray(d) ? d : [d]).slice(0, 5).map(c => ({ time: c.time_open, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })) },
  { path: '/btc/fees', price: PRICE, tag: 'Crypto', summary: 'Returns a JSON object with current Bitcoin network fee estimates in satoshis per vByte',
    params: [],
    url: () => `https://mempool.space/api/v1/fees/recommended`,
    map: d => ({ fastest: d.fastestFee, half_hour: d.halfHourFee, hour: d.hourFee, economy: d.economyFee, minimum: d.minimumFee }) },

  // DeFi
  { path: '/defi/tvl', price: PRICE, tag: 'DeFi', summary: 'Returns a JSON array of total value locked figures across 468 blockchain chains',
    params: [],
    url: () => `https://api.llama.fi/v2/chains`,
    map: d => (Array.isArray(d) ? d : []).sort((a, b) => (b.tvl || 0) - (a.tvl || 0)).slice(0, 20).map(c => ({ chain: c.name, tvl_usd: Math.round(c.tvl || 0) })) },
  { path: '/defi/yields', price: PRICE, tag: 'DeFi', summary: 'Returns a JSON array of top DeFi yield pools sorted by APY percentage',
    params: [{ n: 'limit', req: false, d: 'Integer 1-50, number of results to return (default 10)', def: 10 }],
    url: () => `https://yields.llama.fi/pools`,
    map: (d, q) => (d.data || []).filter(p => p.apy > 0).sort((a, b) => b.apy - a.apy).slice(0, num(q.limit, 10, 1, 20)).map(p => ({ project: p.project, chain: p.chain, symbol: p.symbol, apy: +p.apy.toFixed(2), tvl: Math.round(p.tvlUsd || 0) })) },

  // FX
  { path: '/fx/rates', price: PRICE, tag: 'FX', summary: 'Returns a JSON object with current European Central Bank foreign exchange rates',
    params: [{ n: 'base', req: false, d: 'Requires a 3-letter ISO currency code string (default USD)', def: 'USD' }, { n: 'symbols', req: false, d: 'Requires a comma-separated string of 3-letter ISO currency codes, e.g. EUR,GBP,JPY' }],
    url: q => `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(q.base || 'USD')}${q.symbols ? `&symbols=${encodeURIComponent(q.symbols)}` : ''}`,
    map: d => ({ base: d.base, date: d.date, rates: d.rates }) },
  { path: '/fx/convert', price: PRICE, tag: 'FX', summary: 'Converts a numeric amount between two ISO currency codes and returns a JSON object with the converted value',
    params: [{ n: 'from', req: true, d: 'Requires a 3-letter ISO currency code string, e.g. EUR' }, { n: 'to', req: true, d: 'Requires a 3-letter ISO currency code string, e.g. USD' }, { n: 'amount', req: false, d: 'Requires a positive numeric amount (default 1)', def: 1 }],
    url: q => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${encodeURIComponent((q.from || 'eur').toLowerCase())}.json`,
    map: (d, q) => {
      const to = (q.to || 'usd').toLowerCase();
      const rate = d[to];
      const amt = parseFloat(q.amount) || 1;
      return rate ? { from: q.from.toUpperCase(), to: q.to.toUpperCase(), amount: amt, rate, result: +(amt * rate).toFixed(4) } : { error: 'currency not found' };
    } },

  // Weather (wttr.in — no commercial-use restriction unlike Open-Meteo)
  { path: '/weather/current', price: PRICE, tag: 'Weather', summary: 'Returns a JSON object with current weather conditions and forecast for a location',
    params: [{ n: 'location', req: true, d: 'Requires a city name string or lat,lon coordinate string' }],
    url: q => `https://wttr.in/${encodeURIComponent(q.location)}?format=j1`,
    map: d => {
      const c = d.current_condition?.[0] || {};
      return { temp_c: c.temp_C, temp_f: c.temp_F, condition: c.weatherDesc?.[0]?.value, humidity: c.humidity, wind_kph: c.windspeedKmph, feels_like_c: c.FeelsLikeC };
    } },

  // Geo
  { path: '/geo/ip', price: PRICE, tag: 'Geo', summary: 'Returns a JSON object with city, country, latitude, and longitude for an IPv4 or IPv6 address string',
    params: [{ n: 'ip', req: true, d: 'Requires an IPv4 or IPv6 address string, e.g. 8.8.8.8' }],
    url: q => `http://ip-api.com/json/${encodeURIComponent(q.ip)}?fields=status,country,countryCode,city,lat,lon,isp,org`,
    map: d => d.status === 'success' ? { country: d.country, code: d.countryCode, city: d.city, lat: d.lat, lon: d.lon, isp: d.isp, org: d.org } : { error: 'lookup failed' } },
  { path: '/geo/zip', price: PRICE, tag: 'Geo', summary: 'Returns a JSON object with city name, latitude, and longitude for a postal code string',
    params: [{ n: 'country', req: true, d: 'Requires a 2-letter ISO country code string, e.g. us' }, { n: 'code', req: true, d: 'Requires a postal code string, e.g. 90210' }],
    url: q => `https://api.zippopotam.us/${encodeURIComponent(q.country)}/${encodeURIComponent(q.code)}`,
    map: d => ({ country: d.country, places: (d.places || []).map(p => ({ name: p['place name'], state: p.state, lat: p.latitude, lon: p.longitude })) }) },
  { path: '/geo/sun', price: PRICE, tag: 'Geo', summary: 'Returns a JSON object with sunrise and sunset times as ISO 8601 strings for given coordinates',
    params: [{ n: 'lat', req: true, d: 'Requires a decimal latitude float between -90 and 90' }, { n: 'lon', req: true, d: 'Requires a decimal longitude float between -180 and 180' }],
    url: q => `https://api.sunrise-sunset.org/json?lat=${encodeURIComponent(q.lat)}&lng=${encodeURIComponent(q.lon)}&formatted=0`,
    map: d => d.results || {} },
  { path: '/geo/elevation', price: PRICE, tag: 'Geo', summary: 'Returns a JSON object with elevation in meters for latitude/longitude coordinates',
    params: [{ n: 'lat', req: true, d: 'Requires a decimal latitude float between -90 and 90' }, { n: 'lon', req: true, d: 'Requires a decimal longitude float between -180 and 180' }],
    url: q => `https://api.opentopodata.org/v1/test-dataset?locations=${encodeURIComponent(q.lat)},${encodeURIComponent(q.lon)}`,
    map: d => ({ elevation_m: d.results?.[0]?.elevation ?? null }) },

  // Government
  { path: '/gov/fbi', price: PRICE, tag: 'Government', summary: 'Returns a JSON array of FBI wanted persons with names, charges, and descriptions',
    params: [{ n: 'limit', req: false, d: 'Integer 1-20, number of results to return (default 5)', def: 5 }],
    url: q => `https://api.fbi.gov/wanted/v1?limit=${num(q.limit, 5, 1, 20)}&sort_on=modified&sort_order=desc`,
    map: d => ({ total: d.total, items: (d.items || []).map(i => ({ title: i.title, subject: (i.subjects || []).join(','), field_office: i.field_offices?.[0] })) }) },
  { path: '/gov/federal-register', price: PRICE, tag: 'Government', summary: 'Returns a JSON array of recent US federal register documents with titles and dates',
    params: [{ n: 'limit', req: false, d: 'Integer 1-20, number of results to return (default 5)', def: 5 }],
    url: q => `https://www.federalregister.gov/api/v1/documents.json?per_page=${num(q.limit, 5, 1, 20)}&order=newest`,
    map: d => (d.results || []).map(r => ({ title: r.title, type: r.type, date: r.publication_date, agency: r.agency_names?.[0] })) },
  { path: '/gov/datasets', price: PRICE, tag: 'Government', summary: 'Returns a JSON array of US government datasets matching the query string',
    params: [{ n: 'q', req: true, d: 'Requires a text search query string' }],
    url: q => `https://catalog.data.gov/api/3/action/package_search?q=${encodeURIComponent(q.q)}&rows=5`,
    map: d => (d.result?.results || []).map(r => ({ title: r.title, notes: (r.notes || '').slice(0, 200), url: r.url })) },
  { path: '/finance/tickers', price: PRICE, tag: 'Finance', summary: 'Returns a JSON array of all US public company ticker symbols with CIK numbers',
    params: [{ n: 'q', req: false, d: 'Optional text string to filter by ticker symbol or company name' }],
    url: () => `https://www.sec.gov/files/company_tickers.json`,
    headers: UA,
    map: (d, q) => {
      const all = Object.values(d || {});
      const f = q.q ? all.filter(c => (c.ticker || '').toLowerCase().includes(q.q.toLowerCase()) || (c.title || '').toLowerCase().includes(q.q.toLowerCase())) : all;
      return { count: f.length, items: f.slice(0, 10).map(c => ({ ticker: c.ticker, cik: String(c.cik_str).padStart(10, '0'), name: c.title })) };
    } },

  // Health
  { path: '/health/trials', price: PRICE, tag: 'Health', summary: 'Returns a JSON array of clinical trials matching the query with phase, status, and conditions',
    params: [{ n: 'q', req: true, d: 'Requires a medical condition or keyword text string' }],
    url: q => `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(q.q)}&pageSize=5`,
    map: d => (d.studies || []).map(s => ({ nct: s.protocolSection?.identificationModule?.nctId, title: s.protocolSection?.identificationModule?.briefTitle, status: s.protocolSection?.statusModule?.overallStatus })) },
  { path: '/health/gene', price: PRICE, tag: 'Health', summary: 'Returns a JSON object with gene annotations and identifiers for a gene symbol string',
    params: [{ n: 'q', req: true, d: 'Requires a gene symbol or name text string, e.g. insulin' }],
    url: q => `https://mygene.info/v3/query?q=${encodeURIComponent(q.q)}&size=5`,
    map: d => (d.hits || []).map(h => ({ symbol: h.symbol, name: h.name, taxid: h.taxid })) },

  // Science
  { path: '/science/papers', price: PRICE, tag: 'Science', summary: 'Returns a JSON array of scholarly papers matching the query with titles, authors, and DOIs',
    params: [{ n: 'q', req: true, d: 'Requires a text search query string' }],
    url: q => `https://api.openalex.org/works?search=${encodeURIComponent(q.q)}&per-page=5`,
    map: d => (d.results || []).map(w => ({ title: w.title, year: w.publication_year, citations: w.cited_by_count, doi: w.doi })) },
  { path: '/science/quakes', price: PRICE, tag: 'Science', summary: 'Returns a JSON array of recent earthquakes with magnitude, location, and timestamp from USGS',
    params: [{ n: 'min', req: false, d: 'Requires a minimum magnitude float (default 5)', def: 5 }],
    url: q => `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=${num(q.min, 5, 1, 9)}&limit=10&orderby=time`,
    map: d => (d.features || []).map(f => ({ place: f.properties?.place, mag: f.properties?.mag, time: new Date(f.properties?.time).toISOString(), url: f.properties?.url })) },
  { path: '/space/iss', price: PRICE, tag: 'Space', summary: 'Returns a JSON object with the current latitude and longitude of the International Space Station',
    params: [],
    url: () => `http://api.open-notify.org/iss-now.json`,
    map: d => ({ lat: d.iss_position?.latitude, lon: d.iss_position?.longitude, timestamp: d.timestamp }) },
  { path: '/space/spacex', price: PRICE, tag: 'Space', summary: 'Returns a JSON object with details of the most recent SpaceX launch',
    params: [],
    url: () => `https://api.spacexdata.com/v4/launches/latest`,
    map: d => ({ name: d.name, date: d.date_utc, success: d.success, details: (d.details || '').slice(0, 300) }) },

  // Dev tools
  { path: '/dev/stackoverflow', price: PRICE, tag: 'Dev', summary: 'Returns a JSON array of Stack Overflow questions matching the query with titles and scores',
    params: [{ n: 'q', req: true, d: 'Requires a text search query string' }],
    url: q => `https://api.stackexchange.com/2.3/search?order=desc&sort=votes&intitle=${encodeURIComponent(q.q)}&site=stackoverflow&pagesize=5`,
    map: d => (d.items || []).map(i => ({ title: i.title, score: i.score, answers: i.answer_count, url: i.link })) },
  { path: '/dev/dns', price: PRICE, tag: 'Dev', summary: 'Returns a JSON object with DNS records for a domain name string via Google DNS-over-HTTPS',
    params: [{ n: 'name', req: true, d: 'Requires a domain name string, e.g. example.com' }, { n: 'type', req: false, d: 'Requires a DNS record type string: A, AAAA, MX, TXT, etc. (default A)', def: 'A' }],
    url: q => `https://dns.google/resolve?name=${encodeURIComponent(q.name)}&type=${encodeURIComponent(q.type || 'A')}`,
    map: d => ({ answers: (d.Answer || []).map(a => ({ name: a.name, type: a.type, data: a.data })) }) },
  { path: '/dev/crates', price: PRICE, tag: 'Dev', summary: 'Returns a JSON object with metadata, version, and download count for a Rust crate name',
    params: [{ n: 'crate', req: true, d: 'Requires a Rust crate name string, e.g. serde' }],
    url: q => `https://crates.io/api/v1/crates/${encodeURIComponent(q.crate)}`,
    map: d => ({ name: d.crate?.id, downloads: d.crate?.downloads, version: d.crate?.max_version, description: d.crate?.description }) },

  // Reference
  { path: '/ref/define', price: PRICE, tag: 'Reference', summary: 'Returns a JSON array of dictionary definitions for an English word string',
    params: [{ n: 'word', req: true, d: 'Requires an English word string, e.g. hello' }],
    url: q => `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q.word)}`,
    map: d => (Array.isArray(d) ? d : []).slice(0, 1).map(e => ({ word: e.word, phonetic: e.phonetic, meanings: (e.meanings || []).slice(0, 3).map(m => ({ pos: m.partOfSpeech, defs: (m.definitions || []).slice(0, 2).map(x => x.definition) })) })) },
  { path: '/ref/books', price: PRICE, tag: 'Reference', summary: 'Returns a JSON array of books matching the query with titles, authors, and publish years',
    params: [{ n: 'q', req: true, d: 'Requires a text search query string' }],
    url: q => `https://openlibrary.org/search.json?q=${encodeURIComponent(q.q)}&limit=5`,
    map: d => (d.docs || []).map(b => ({ title: b.title, author: (b.author_name || [])[0], year: b.first_publish_year })) },
  { path: '/ref/holidays', price: PRICE, tag: 'Reference', summary: 'Returns a JSON array of public holidays for an ISO country code and year integer',
    params: [{ n: 'country', req: true, d: 'Requires a 2-letter ISO country code string, e.g. US' }, { n: 'year', req: false, d: 'Requires a 4-digit year integer (default 2026)', def: 2026 }],
    url: q => `https://date.nager.at/api/v3/publicholidays/${num(q.year, 2026, 2000, 2030)}/${encodeURIComponent(q.country)}`,
    map: d => (Array.isArray(d) ? d : []).map(h => ({ date: h.date, name: h.name, local: h.localName })) },

  // Entertainment
  { path: '/fun/tv', price: PRICE, tag: 'Fun', summary: 'Returns a JSON array of TV shows matching the query with names, ratings, and premiere dates',
    params: [{ n: 'q', req: true, d: 'Requires a TV show name text string' }],
    url: q => `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q.q)}`,
    map: d => (Array.isArray(d) ? d : []).slice(0, 5).map(r => ({ name: r.show?.name, premiered: r.show?.premiered, rating: r.show?.rating?.average, summary: (r.show?.summary || '').replace(/<[^>]+>/g, '').slice(0, 200) })) },
  { path: '/fun/anime', price: PRICE, tag: 'Fun', summary: 'Returns a JSON array of anime titles matching the query with scores and episode counts',
    params: [{ n: 'q', req: true, d: 'Requires an anime title text string' }],
    url: q => `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q.q)}&limit=5`,
    map: d => (d.data || []).map(a => ({ title: a.title, score: a.score, episodes: a.episodes, url: a.url })) },
  { path: '/fun/lyrics', price: PRICE, tag: 'Fun', summary: 'Returns a JSON object with song lyrics text for an artist and title string',
    params: [{ n: 'artist', req: true, d: 'Requires an artist name text string' }, { n: 'title', req: true, d: 'Requires a song title text string' }],
    url: q => `https://api.lyrics.ovh/v1/${encodeURIComponent(q.artist)}/${encodeURIComponent(q.title)}`,
    map: d => ({ lyrics: (d.lyrics || '').slice(0, 1000) }) },

  // Sports
  { path: '/sports/football', price: PRICE, tag: 'Sports', summary: 'Returns a JSON array of German Bundesliga football matches with scores and dates',
    params: [],
    url: () => `https://api.openligadb.de/getmatchdata/bl1`,
    map: d => (Array.isArray(d) ? d : []).slice(0, 5).map(m => ({ date: m.matchDateTime, home: m.team1?.teamName, away: m.team2?.teamName, score: m.matchResults?.[0] ? `${m.matchResults[0].pointsTeam1}:${m.matchResults[0].pointsTeam2}` : 'upcoming' })) },
  { path: '/sports/nhl', price: PRICE, tag: 'Sports', summary: 'Returns a JSON array of NHL team standings with wins, losses, and points',
    params: [],
    url: () => `https://api-web.nhle.com/v1/standings/now`,
    map: d => (d.standings || []).slice(0, 10).map(s => ({ team: s.teamName?.default, wins: s.wins, losses: s.losses, points: s.points })) },

  // Social
  { path: '/social/bluesky', price: PRICE, tag: 'Social', summary: 'Returns a JSON array of Bluesky social users matching the query with handles and bios',
    params: [{ n: 'q', req: true, d: 'Requires a text search query string' }],
    url: q => `https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(q.q)}&limit=5`,
    map: d => (d.actors || []).map(a => ({ handle: a.handle, name: a.displayName, followers: a.followersCount })) },

  // Food & jobs
  { path: '/food/search', price: PRICE, tag: 'Food', summary: 'Returns a JSON object with nutritional data (calories, macros) for a food name string',
    params: [{ n: 'q', req: true, d: 'Requires a food name text string' }],
    url: q => `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q.q)}&search_simple=1&action=process&json=1&page_size=5`,
    map: d => (d.products || []).map(p => ({ name: p.product_name, brand: p.brands, nutriscore: p.nutriscore_grade })) },
  { path: '/jobs/remote', price: PRICE, tag: 'Jobs', summary: 'Returns a JSON array of remote job listings with titles, companies, and locations',
    params: [{ n: 'tag', req: false, d: 'Optional tag filter string, e.g. python' }],
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
      description: 'Returns a JSON object with live SOL prices from the top 5 centralized exchanges and top 5 Solana DEXs, plus the widest bid-ask spread detected',
      extensions: bazaarExt(),
    },
    'GET /spread/base': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON object with live cross-DEX spreads on Base for a token (default WETH): prices from the top 5 Base DEXs plus the widest spread detected',
      extensions: bazaarExt([
        { n: 'token', req: false, d: 'Base token contract address (default WETH)' },
        { n: 'notional', req: false, d: 'Notional USD for net spread estimate (default 1000)' },
      ]),
    },
    'GET /chain/balance': {
      accepts: acceptsFor(CHAIN_PRICE),
      description: 'Returns a JSON object with the native ETH balance of a Base address (exact wei string plus decimal ETH)',
      extensions: bazaarExt([
        { n: 'address', req: true, d: 'Requires a 0x Base address' },
      ]),
    },
    'GET /chain/erc20-balance': {
      accepts: acceptsFor(CHAIN_PRICE),
      description: 'Returns a JSON object with the ERC-20 token balance of a Base address (exact raw string plus decimal amount, auto-detects token decimals)',
      extensions: bazaarExt([
        { n: 'address', req: true, d: 'Requires a 0x Base wallet address' },
        { n: 'token', req: true, d: 'Requires a 0x ERC-20 contract address' },
      ]),
    },
    'GET /chain/block-number': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Returns a JSON object with the current Base block number as an integer',
      extensions: bazaarExt(),
    },
    'GET /chain/sol-balance': {
      accepts: acceptsFor(CHAIN_PRICE),
      description: 'Returns a JSON object with the native SOL balance of a Solana wallet (lamports plus decimal SOL)',
      extensions: bazaarExt([
        { n: 'wallet', req: true, d: 'Requires a valid 32-44 character base58 Solana wallet address' },
      ]),
    },
    'GET /chain/spl-balance': {
      accepts: acceptsFor(CHAIN_PRICE),
      description: 'Returns a JSON object with SPL token balances for a Solana wallet and mint, including per-account breakdown and total',
      extensions: bazaarExt([
        { n: 'wallet', req: true, d: 'Requires a valid 32-44 character base58 Solana wallet address' },
        { n: 'mint', req: true, d: 'Requires a valid 32-44 character base58 Solana token mint address' },
      ]),
    },
    'GET /chain/slot': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Returns a JSON object with the current Solana slot as an integer',
      extensions: bazaarExt(),
    },
    'GET /verify/npi': {
      accepts: acceptsFor(VERIFY_PRICE),
      description: 'Validates a 10-digit NPI number checksum and returns a JSON object with validation result plus CMS NPPES registry enrichment data',
      extensions: bazaarExt(),
    },
    'GET /verify/dea': {
      accepts: acceptsFor(PRICE),
      description: 'Validates a DEA number format and checksum, returns a JSON object with validation result',
      extensions: bazaarExt(),
    },
    'GET /search/npm': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of npm packages matching the query string',
      extensions: bazaarExt(),
    },
    'GET /search/wikipedia': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of Wikipedia articles matching the query string',
      extensions: bazaarExt(),
    },
    'GET /search/arxiv': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of arXiv papers matching the query string',
      extensions: bazaarExt(),
    },
    'GET /search/sec': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of SEC EDGAR filings matching the query string',
      extensions: bazaarExt(),
    },
    'GET /search/hn': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of Hacker News posts matching the query string',
      extensions: bazaarExt(),
    },
    'GET /search/geo': {
      accepts: acceptsFor(PRICE),
      description: 'Converts a street address string to a JSON object with latitude, longitude, and formatted address via OpenStreetMap',
      extensions: bazaarExt(),
    },
    'GET /lookup/pypi': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON object with metadata for a PyPI package name',
      extensions: bazaarExt(),
    },
    'GET /search/fda': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of FDA drug labels matching the query string',
      extensions: bazaarExt(),
    },
    'GET /pump/chains': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of 100+ supported blockchain chain identifiers for meme token endpoints',
      extensions: bazaarExt(),
    },
    'GET /pump/new': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of newly launched meme tokens with price and market cap data',
      extensions: bazaarExt(),
    },
    'GET /pump/trending': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of trending meme coin liquidity pools on the specified chain',
      extensions: bazaarExt(),
    },
    'GET /pump/migrating': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of pump.fun tokens approaching Raydium migration threshold, sorted by migration progress percentage',
      extensions: bazaarExt(),
    },
    'GET /solana/top100': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of the top 100 Solana tokens by market cap with prices in USD and SOL',
      extensions: bazaarExt(),
    },
    'GET /stocks/list': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of tokenized stocks with live prices',
      extensions: bazaarExt(),
    },
    'GET /stocks/price': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON object with live price quote for a tokenized stock symbol',
      extensions: bazaarExt(),
    },
    'GET /meme/trending': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of trending meme coin liquidity pools on the specified chain',
      extensions: bazaarExt(),
    },
    'GET /meme/new': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of newly launched meme tokens on the specified chain or all chains',
      extensions: bazaarExt(),
    },
    'GET /meme/token': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON object with price, volume, and liquidity data for a token contract address',
      extensions: bazaarExt(),
    },
    'GET /search/github': {
      accepts: acceptsFor(PRICE),
      description: 'Returns a JSON array of GitHub repositories, code, users, or issues matching the query',
      extensions: bazaarExt(),
    },
    'GET /scrape': {
      accepts: acceptsFor(AI_PRICE),
      description: 'Fetches a URL and returns the page content as clean Markdown text in a JSON object',
      extensions: bazaarExt([{ n: 'url', req: true, d: 'Requires a valid public http:// or https:// URL string' }]),
    },
    'GET /whale-watch': {
      accepts: acceptsFor(ALPHA_PRICE),
      description: 'Returns a JSON array of recent token swap transactions for a Solana wallet address',
      extensions: bazaarExt([
        { n: 'wallet', req: true, d: 'Requires a valid 32-44 character base58 Solana wallet address' },
        { n: 'limit', req: false, d: 'Integer 1-20, number of swaps to return (default 5)' },
      ]),
    },
    'GET /solana/audit': {
      accepts: acceptsFor(ALPHA_PRICE),
      description: 'Returns a JSON object with RugCheck risk score, risk level, and list of specific risk findings for a Solana token',
      extensions: bazaarExt([{ n: 'token', req: true, d: 'Requires a valid 32-44 character base58 Solana token mint address' }]),
    },
    'GET /wallet/portfolio': {
      accepts: acceptsFor(ALPHA_PRICE),
      description: 'Returns a JSON object with native SOL balance and an array of SPL token balances for a Solana wallet',
      extensions: bazaarExt(),
    },
    'GET /scrape/pdf': {
      accepts: acceptsFor(AI_PRICE),
      description: 'Fetches a PDF from a URL and returns the extracted text as a string in a JSON object, capped at 50,000 characters',
      extensions: bazaarExt([{ n: 'url', req: true, d: 'Requires a valid public http:// or https:// URL string pointing to a PDF file' }]),
    },
    // ---- pay-per-call utilities (zero marginal cost, X Pay-style) ----
    'GET /utils/base64': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Encodes text to base64 or decodes base64 to text, returns a JSON object with the result string',
      extensions: bazaarExt(),
    },
    'GET /utils/hash': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Computes a cryptographic hash of input text, returns a JSON object with the hex digest string',
      extensions: bazaarExt(),
    },
    'GET /utils/uuid': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Generates random UUID v4 values, returns a JSON array of UUID strings',
      extensions: bazaarExt(),
    },
    'GET /utils/ip': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Returns a JSON object with the caller IP address as a string',
      extensions: bazaarExt(),
    },
    'GET /utils/time': {
      accepts: acceptsFor(UTILS_PRICE),
      description: 'Returns a JSON object with the current Unix timestamp integer and ISO 8601 time string',
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
    'GET /spread/base?token=0x4200000000000000000000000000000000000006&notional=1000',
    'GET /chain/balance?address=0xD7CDd563e8F6A249B076A702b7e2C233CCF3481d',
    'GET /chain/erc20-balance?address=0xD7CDd563e8F6A249B076A702b7e2C233CCF3481d&token=<redacted>',
    'GET /chain/block-number',
    'GET /chain/sol-balance?wallet=E21AWkUtLz4BP7AaT82CF7v86Kmv4YzN4NAR1FQnEmqy',
    'GET /chain/spl-balance?wallet=E21AWkUtLz4BP7AaT82CF7v86Kmv4YzN4NAR1FQnEmqy&mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'GET /chain/slot',
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

app.get('/spread/base', async (req, res) => {
  try {
    const token = (req.query.token || BASE_WETH).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
      return res.status(400).json({ error: 'token must be a 0x Base contract address' });
    }
    const n = parseFloat(req.query.notional);
    const notional = Number.isFinite(n) && n > 0 ? n : 1000;
    res.json(await baseSpreadSnapshot(token, notional));
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ---- EVM/Solana chain reads: balances, block height (public RPCs, no key) ----
const BASE_RPC_URL = 'https://base-rpc.publicnode.com';
const SOL_RPC_URL = 'https://api.mainnet-beta.solana.com';

async function jsonRpc(url, method, params, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || 'RPC error');
    return d.result;
  } finally {
    clearTimeout(t);
  }
}

// exact decimal string from a BigInt raw amount (no float precision loss)
function formatUnits(raw, decimals) {
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals) || '0';
  const frac = (s.slice(-decimals) || '').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

const isEvmAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

app.get('/chain/balance', async (req, res) => {
  const address = (req.query.address || '').trim();
  if (!isEvmAddress(address)) return res.status(400).json({ error: 'address must be a 0x Base address' });
  try {
    const wei = BigInt(await jsonRpc(BASE_RPC_URL, 'eth_getBalance', [address, 'latest']));
    res.json({ chain: 'base', address, balance_wei: wei.toString(), balance_eth: formatUnits(wei, 18) });
  } catch (e) {
    res.status(502).json({ error: 'balance lookup failed: ' + String(e.message || e) });
  }
});

app.get('/chain/erc20-balance', async (req, res) => {
  const address = (req.query.address || '').trim();
  const token = (req.query.token || '').trim();
  if (!isEvmAddress(address)) return res.status(400).json({ error: 'address must be a 0x Base address' });
  if (!isEvmAddress(token)) return res.status(400).json({ error: 'token must be a 0x contract address' });
  try {
    const data = '0x70a08231' + '000000000000000000000000' + address.slice(2).toLowerCase();
    const raw = BigInt(await jsonRpc(BASE_RPC_URL, 'eth_call', [{ to: token, data }, 'latest']));
    let decimals = 18;
    try {
      const decHex = await jsonRpc(BASE_RPC_URL, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
      const dec = parseInt(decHex, 16);
      if (Number.isFinite(dec) && dec >= 0 && dec <= 36) decimals = dec;
    } catch { /* keep 18 */ }
    res.json({ chain: 'base', address, token, balance_raw: raw.toString(), decimals, balance: formatUnits(raw, decimals) });
  } catch (e) {
    res.status(502).json({ error: 'token balance lookup failed: ' + String(e.message || e) });
  }
});

app.get('/chain/block-number', async (req, res) => {
  try {
    const hex = await jsonRpc(BASE_RPC_URL, 'eth_blockNumber', []);
    res.json({ chain: 'base', block_number: parseInt(hex, 16) });
  } catch (e) {
    res.status(502).json({ error: 'block number lookup failed: ' + String(e.message || e) });
  }
});

app.get('/chain/sol-balance', async (req, res) => {
  const wallet = (req.query.wallet || '').trim();
  if (!isValidSolanaAddress(wallet)) return res.status(400).json({ error: 'invalid Solana wallet address' });
  try {
    const lamports = (await jsonRpc(SOL_RPC_URL, 'getBalance', [wallet])).value;
    res.json({ chain: 'solana', wallet, balance_lamports: lamports, balance_sol: formatUnits(BigInt(lamports), 9) });
  } catch (e) {
    res.status(502).json({ error: 'balance lookup failed: ' + String(e.message || e) });
  }
});

app.get('/chain/spl-balance', async (req, res) => {
  const wallet = (req.query.wallet || '').trim();
  const mint = (req.query.mint || '').trim();
  if (!isValidSolanaAddress(wallet)) return res.status(400).json({ error: 'invalid Solana wallet address' });
  if (!isValidSolanaAddress(mint)) return res.status(400).json({ error: 'invalid Solana mint address' });
  try {
    const d = await jsonRpc(SOL_RPC_URL, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]);
    const balances = (d.value || []).map(v => {
      const info = v.account.data.parsed.info.tokenAmount;
      return {
        token_account: v.pubkey,
        balance_raw: info.amount,
        decimals: info.decimals,
        balance: info.uiAmountString ?? String(info.uiAmount),
      };
    });
    const total = balances.reduce((s, b) => s + parseFloat(b.balance || 0), 0);
    res.json({ chain: 'solana', wallet, mint, accounts: balances.length, total_balance: total, balances });
  } catch (e) {
    res.status(502).json({ error: 'token balance lookup failed: ' + String(e.message || e) });
  }
});

app.get('/chain/slot', async (req, res) => {
  try {
    const slot = await jsonRpc(SOL_RPC_URL, 'getSlot', []);
    res.json({ chain: 'solana', slot });
  } catch (e) {
    res.status(502).json({ error: 'slot lookup failed: ' + String(e.message || e) });
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

    // Batch up to 30 addresses into a single comma-separated string
    const addresses = candidates.map(t => t.tokenAddress).join(',');
    const d = await fetchMaybeXml(`https://api.dexscreener.com/latest/dex/tokens/${addresses}`, 8000);

    const checks = [];
    for (const p of (d.pairs || [])) {
      if (!(p.dexId || '').toLowerCase().includes('pump')) continue;
      const mcap = p.fdv || p.marketCap || 0;
      const progress = mcap / PUMP_MIGRATION_MCAP;
      if (progress < 0.5) continue;

      checks.push({
        symbol: p.baseToken?.symbol, name: p.baseToken?.name, address: p.baseToken?.address,
        market_cap_usd: mcap, migration_progress_pct: +(progress * 100).toFixed(1),
        price_usd: p.priceUsd, volume_24h: p.volume?.h24, url: p.url,
      });
    }

    // Deduplicate by address and sort by migration progress
    const uniqueChecks = Array.from(new Map(checks.map(item => [item.address, item])).values());
    const items = uniqueChecks.sort((a, b) => b.migration_progress_pct - a.migration_progress_pct).slice(0, limit);

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

// ---- 1. Solana token audit via RugCheck ----
app.get('/solana/audit', async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: 'missing ?token= mint address' });
  if (!isValidSolanaAddress(token)) return res.status(400).json({ error: 'invalid Solana mint address' });
  try {
    const d = await fetchUpstreamRetry(`https://api.rugcheck.xyz/v1/tokens/${token}/report/summary`, 15000);
    const risks = [];
    if (d.mintAuthority && d.mintAuthority !== 'None') risks.push('mint authority not revoked');
    if (d.freezeAuthority && d.freezeAuthority !== 'None') risks.push('freeze authority enabled');
    if (d.topHolders && Array.isArray(d.topHolders)) {
      const topPct = d.topHolders.slice(0, 5).reduce((s, h) => s + (h.pct || 0), 0);
      if (topPct > 50) risks.push(`top 5 holders own ${topPct.toFixed(1)}% of supply`);
    }
    if (d.rugged) risks.push('flagged as rugged');
    if (Array.isArray(d.risks)) d.risks.forEach(r => risks.push(r.name || r.description || String(r)));
    res.json({
      token,
      risk_score: d.score ?? d.riskScore ?? null,
      risk_level: d.riskLevel ?? d.risk ?? null,
      risks: [...new Set(risks)],
    });
  } catch (e) {
    res.status(502).json({ error: 'Token audit failed: ' + String(e.message || e) });
  }
});

// ---- 2. Wallet portfolio snapshot via Helius DAS ----
app.get('/wallet/portfolio', async (req, res) => {
  const wallet = (req.query.wallet || '').trim();
  if (!wallet) return res.status(400).json({ error: 'missing ?wallet= Solana address' });
  if (!isValidSolanaAddress(wallet)) return res.status(400).json({ error: 'invalid Solana wallet address' });
  if (!HELIUS_API_KEY) return res.status(503).json({ error: 'portfolio not configured (missing Helius API key)' });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let d;
    try {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'portfolio',
          method: 'searchAssets',
          params: { ownerAddress: wallet, tokenType: 'fungible', displayOptions: { showNativeBalance: true } },
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      d = await r.json();
    } finally { clearTimeout(t); }
    if (d.error) throw new Error(d.error.message || 'Helius RPC error');
    const result = d.result || {};
    const items = result.items || [];
    const tokens = items.map(it => ({
      mint: it.id, symbol: it.content?.metadata?.symbol || null,
      name: it.content?.metadata?.name || null,
      balance: it.token_info?.balance ?? null, decimals: it.token_info?.decimals ?? null,
    }));
    const native = result.nativeBalance || {};
    res.json({
      wallet,
      sol_balance: native.sol ?? (native.lamports != null ? native.lamports / 1e9 : null),
      sol_balance_lamports: native.lamports ?? null,
      token_count: tokens.length,
      tokens,
    });
  } catch (e) {
    res.status(502).json({ error: 'Portfolio lookup failed: ' + String(e.message || e) });
  }
});

// ---- 3. PDF to text extractor ----
app.get('/scrape/pdf', async (req, res) => {
  const target = (req.query.url || '').trim();
  if (!target) return res.status(400).json({ error: 'missing ?url=' });
  if (!isPublicUrl(target)) return res.status(400).json({ error: 'URL must be a public http(s) address' });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    let buf;
    try {
      const r = await fetch(target, { signal: ctrl.signal, headers: SCRAPE_UA, redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('pdf') && !target.toLowerCase().endsWith('.pdf')) {
        throw new Error('URL does not appear to be a PDF');
      }
      buf = Buffer.from(await r.arrayBuffer());
    } finally { clearTimeout(t); }
    if (buf.length > 20 * 1024 * 1024) throw new Error('PDF too large (max 20MB)');
    const parser = new PDFParse({ data: buf });
    const info = await parser.getText();
    await parser.destroy();
    const text = (info.text || '').trim().slice(0, 50000);
    if (!text) return res.status(422).json({ error: 'No extractable text in PDF.' });
    res.json({ source_url: target, pages: info.numpages ?? info.total ?? null, chars: text.length, text });
  } catch (e) {
    res.status(502).json({ error: 'PDF extraction failed: ' + String(e.message || e) });
  }
});

// ---- 4. Farcaster social search via Searchcaster ----
// ---- 5. Top traders / FOMO leaderboard via Birdeye ----
// ---- 6. X (Twitter) trending tokens ----
// ---- 7. Headless browser scraper via Browserless ----
// ---- 8. On-demand SMS via Twilio ----
// ---- 10. Drive-time isochrone via OpenRouteService ----
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
    title: 'x402 master data API — 78 endpoints',
    version: '2.0.0',
    description: '78 pay-per-call APIs: AI text/image generation ($0.01), Polymarket odds, crypto prices, DeFi yields, FX rates, weather, IP/geo, FBI wanted, SEC tickers, clinical trials, 250M academic papers, Stack Overflow, meme-coin launchpads (pump.fun, Clanker, Four.meme, SunPump), tokenized stocks, Solana top 100, Base DEX spreads, and 40+ more. $0.005/call standard. USDC on Base and Solana via x402.',
    contact: { email: 'ctiernan21@gmail.com' },
  },
  servers: [{ url: API_URL }],
  paths: {
    ...buildMasterOapiPaths(),
    '/utils/base64': {
      get: {
        operationId: 'base64Util',
        summary: 'Encodes text to base64 or decodes base64 to text, returns a JSON object with the result string',
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
        summary: 'Computes a cryptographic hash of input text, returns a JSON object with the hex digest string',
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
        summary: 'Generates random UUID v4 values, returns a JSON array of UUID strings',
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
        summary: 'Returns a JSON object with the caller IP address as a string',
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
        summary: 'Returns a JSON object with the current Unix timestamp integer and ISO 8601 time string',
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
        summary: 'Returns a JSON object with live SOL prices from the top 5 centralized exchanges and top 5 Solana DEXs, plus the widest bid-ask spread detected',
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
    '/spread/base': {
      get: {
        operationId: 'getBaseSpread',
        summary: 'Returns a JSON object with live cross-DEX spreads on Base for a token (default WETH), plus the widest spread detected',
        tags: ['Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.005000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'token', in: 'query', required: false, description: 'Base token contract address (default WETH)', schema: { type: 'string' } },
          { name: 'notional', in: 'query', required: false, schema: { type: 'number', default: 1000, minimum: 1 } },
        ],
        responses: {
          200: { description: 'Base spread snapshot', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.005 USDC via x402' },
        },
      },
    },
    '/chain/balance': {
      get: {
        operationId: 'chainBalance',
        summary: 'Returns a JSON object with the native ETH balance of a Base address',
        tags: ['Chain Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.003000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'address', in: 'query', required: true, description: '0x Base address', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'ETH balance', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.003 USDC via x402' },
        },
      },
    },
    '/chain/erc20-balance': {
      get: {
        operationId: 'chainErc20Balance',
        summary: 'Returns a JSON object with the ERC-20 token balance of a Base address',
        tags: ['Chain Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.003000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'address', in: 'query', required: true, description: '0x Base wallet address', schema: { type: 'string' } },
          { name: 'token', in: 'query', required: true, description: '0x ERC-20 contract address', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Token balance', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.003 USDC via x402' },
        },
      },
    },
    '/chain/block-number': {
      get: {
        operationId: 'chainBlockNumber',
        summary: 'Returns a JSON object with the current Base block number',
        tags: ['Chain Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001000' }, protocols: [{ x402: {} }] },
        responses: {
          200: { description: 'Block number', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.001 USDC via x402' },
        },
      },
    },
    '/chain/sol-balance': {
      get: {
        operationId: 'chainSolBalance',
        summary: 'Returns a JSON object with the native SOL balance of a Solana wallet',
        tags: ['Chain Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.003000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'wallet', in: 'query', required: true, description: 'Solana wallet address', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'SOL balance', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.003 USDC via x402' },
        },
      },
    },
    '/chain/spl-balance': {
      get: {
        operationId: 'chainSplBalance',
        summary: 'Returns a JSON object with SPL token balances for a Solana wallet and mint',
        tags: ['Chain Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.003000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'wallet', in: 'query', required: true, description: 'Solana wallet address', schema: { type: 'string' } },
          { name: 'mint', in: 'query', required: true, description: 'SPL token mint address', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Token balances', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.003 USDC via x402' },
        },
      },
    },
    '/chain/slot': {
      get: {
        operationId: 'chainSlot',
        summary: 'Returns a JSON object with the current Solana slot',
        tags: ['Chain Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.001000' }, protocols: [{ x402: {} }] },
        responses: {
          200: { description: 'Slot', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.001 USDC via x402' },
        },
      },
    },
    '/verify/npi': {
      get: {
        operationId: 'verifyNpi',
        summary: 'Validates a 10-digit NPI number checksum and returns a JSON object with validation result plus CMS NPPES registry enrichment data',
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
        summary: 'Validates a DEA number format and checksum, returns a JSON object with validation result',
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
        summary: 'Returns a JSON array of npm packages matching the query string',
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
        summary: 'Returns a JSON array of Wikipedia articles matching the query string',
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
        summary: 'Returns a JSON array of arXiv papers matching the query string',
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
        summary: 'Returns a JSON array of SEC EDGAR filings matching the query string',
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
        summary: 'Returns a JSON array of Hacker News posts matching the query string',
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
        summary: 'Converts a street address string to a JSON object with latitude, longitude, and formatted address via OpenStreetMap',
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
        summary: 'Returns a JSON object with metadata for a PyPI package name',
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
        summary: 'Returns a JSON array of FDA drug labels matching the query string',
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
        summary: 'Returns a JSON array of 100+ supported blockchain chain identifiers for meme token endpoints',
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
        summary: 'Returns a JSON array of newly launched meme tokens with price and market cap data',
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
        summary: 'Returns a JSON array of trending meme coin liquidity pools on the specified chain',
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
        summary: 'Returns a JSON array of pump.fun tokens approaching Raydium migration threshold, sorted by migration progress percentage',
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
        summary: 'Returns a JSON array of the top 100 Solana tokens by market cap with prices in USD and SOL',
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
        summary: 'Returns a JSON array of tokenized stocks with live prices',
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
        summary: 'Returns a JSON object with live price quote for a tokenized stock symbol',
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
        summary: 'Returns a JSON array of trending meme coin liquidity pools on the specified chain',
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
        summary: 'Returns a JSON array of newly launched meme tokens on the specified chain or all chains',
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
        summary: 'Returns a JSON object with price, volume, and liquidity data for a token contract address',
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
        summary: 'Returns a JSON array of GitHub repositories, code, users, or issues matching the query',
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
        summary: 'Fetches a URL and returns the page content as clean Markdown text in a JSON object',
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
        summary: 'Returns a JSON array of recent token swap transactions for a Solana wallet address',
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
    '/solana/audit': {
      get: {
        operationId: 'solanaAudit',
        summary: 'Returns a JSON object with RugCheck risk score, risk level, and list of specific risk findings for a Solana token',
        tags: ['Crypto'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.050000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'token', in: 'query', required: true, description: 'Solana token mint address', schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Risk score and findings', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.05 USDC via x402' },
        },
      },
    },
    '/wallet/portfolio': {
      get: {
        operationId: 'walletPortfolio',
        summary: 'Returns a JSON object with native SOL balance and an array of SPL token balances for a Solana wallet',
        tags: ['Crypto'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.050000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'wallet', in: 'query', required: true, description: 'Solana wallet address', schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Portfolio balances', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.05 USDC via x402' },
        },
      },
    },
    '/scrape/pdf': {
      get: {
        operationId: 'scrapePdf',
        summary: 'Fetches a PDF from a URL and returns the extracted text as a string in a JSON object, capped at 50,000 characters',
        tags: ['AI Data'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: '0.010000' }, protocols: [{ x402: {} }] },
        parameters: [
          { name: 'url', in: 'query', required: true, description: 'Public PDF URL', schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'Extracted text', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: 'Payment Required: $0.01 USDC via x402' },
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
    name: 'x402 master data API — 78 endpoints',
    description: '78 pay-per-call APIs: AI text/image generation ($0.01), Polymarket odds, crypto prices, DeFi yields, FX rates, weather, IP/geo, FBI wanted, SEC tickers, clinical trials, 250M academic papers, Stack Overflow, meme-coin launchpads (pump.fun, Clanker, Four.meme, SunPump), tokenized stocks, Solana top 100, Base DEX spreads, and 40+ more. $0.005/call standard. USDC on Base and Solana via x402.',
    url: API_URL,
    x402Version: 2,
    networks: [...Object.values(EVM_NETWORKS), SOL_NETWORK],
    endpoints: [
      ...buildMasterX402eps(ep),
      ep('/utils/base64', 'Encodes text to base64 or decodes base64 to text, returns a JSON object with the result string', UTILS_PRICE),
      ep('/utils/hash', 'Computes a cryptographic hash of input text, returns a JSON object with the hex digest string', UTILS_PRICE),
      ep('/utils/uuid', 'Generates random UUID v4 values, returns a JSON array of UUID strings', UTILS_PRICE),
      ep('/utils/ip', 'Returns a JSON object with the caller IP address as a string', UTILS_PRICE),
      ep('/utils/time', 'Returns a JSON object with the current Unix timestamp integer and ISO 8601 time string', UTILS_PRICE),
      ep('/spread', 'Returns a JSON object with live SOL prices from the top 5 centralized exchanges and top 5 Solana DEXs, plus the widest bid-ask spread detected', PRICE),
      ep('/spread/base', 'Returns a JSON object with live cross-DEX spreads on Base for a token (default WETH): prices from the top 5 Base DEXs plus the widest spread detected', PRICE),
      ep('/chain/balance', 'Returns a JSON object with the native ETH balance of a Base address', CHAIN_PRICE),
      ep('/chain/erc20-balance', 'Returns a JSON object with the ERC-20 token balance of a Base address', CHAIN_PRICE),
      ep('/chain/block-number', 'Returns a JSON object with the current Base block number', UTILS_PRICE),
      ep('/chain/sol-balance', 'Returns a JSON object with the native SOL balance of a Solana wallet', CHAIN_PRICE),
      ep('/chain/spl-balance', 'Returns a JSON object with SPL token balances for a Solana wallet and mint', CHAIN_PRICE),
      ep('/chain/slot', 'Returns a JSON object with the current Solana slot', UTILS_PRICE),
      ep('/search/npm', 'Returns a JSON array of npm packages matching the query string', PRICE),
      ep('/search/wikipedia', 'Returns a JSON array of Wikipedia articles matching the query string', PRICE),
      ep('/search/arxiv', 'Returns a JSON array of arXiv papers matching the query string', PRICE),
      ep('/search/sec', 'Returns a JSON array of SEC EDGAR filings matching the query string', PRICE),
      ep('/search/hn', 'Returns a JSON array of Hacker News posts matching the query string', PRICE),
      ep('/search/geo', 'Converts a street address string to a JSON object with latitude, longitude, and formatted address via OpenStreetMap', PRICE),
      ep('/lookup/pypi', 'Returns a JSON object with metadata for a PyPI package name', PRICE),
      ep('/search/fda', 'Returns a JSON array of FDA drug labels matching the query string', PRICE),
      ep('/pump/chains', 'Returns a JSON array of 100+ supported blockchain chain identifiers for meme token endpoints', PRICE),
      ep('/pump/new', 'Returns a JSON array of newly launched meme tokens with price and market cap data', PRICE),
      ep('/pump/trending', 'Returns a JSON array of trending meme coin liquidity pools on the specified chain', PRICE),
      ep('/pump/migrating', 'Returns a JSON array of pump.fun tokens approaching Raydium migration threshold, sorted by migration progress percentage', PRICE),
      ep('/solana/top100', 'Returns a JSON array of the top 100 Solana tokens by market cap with prices in USD and SOL', PRICE),
      ep('/stocks/list', 'Returns a JSON array of tokenized stocks with live prices', PRICE),
      ep('/stocks/price', 'Returns a JSON object with live price quote for a tokenized stock symbol', PRICE),
      ep('/meme/trending', 'Returns a JSON array of trending meme coin liquidity pools on the specified chain', PRICE),
      ep('/meme/new', 'Returns a JSON array of newly launched meme tokens on the specified chain or all chains', PRICE),
      ep('/meme/token', 'Returns a JSON object with price, volume, and liquidity data for a token contract address', PRICE),
      ep('/search/github', 'Returns a JSON array of GitHub repositories, code, users, or issues matching the query', PRICE),
      ep('/verify/npi', 'Validates a 10-digit NPI number checksum and returns a JSON object with validation result plus CMS NPPES registry enrichment data', VERIFY_PRICE),
      ep('/verify/dea', 'Validates a DEA number format and checksum, returns a JSON object with validation result', PRICE),
      ep('/scrape', 'Fetches a URL and returns the page content as clean Markdown text in a JSON object', AI_PRICE),
      ep('/whale-watch', 'Returns a JSON array of recent token swap transactions for a Solana wallet address', ALPHA_PRICE),
      ep('/solana/audit', 'Returns a JSON object with RugCheck risk score, risk level, and list of specific risk findings for a Solana token', ALPHA_PRICE),
      ep('/wallet/portfolio', 'Returns a JSON object with native SOL balance and an array of SPL token balances for a Solana wallet', ALPHA_PRICE),
      ep('/scrape/pdf', 'Fetches a PDF from a URL and returns the extracted text as a string in a JSON object, capped at 50,000 characters', AI_PRICE),
    ],
  });
});

const PORT = process.env.PORT || 3402;
app.listen(PORT, () => console.log(`paywall up on :${PORT}`));
