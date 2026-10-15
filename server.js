import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { isIPv4 as netIsIPv4, isIPv6 as netIsIPv6 } from 'node:net';
import tls from 'node:tls';
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
        console.log(`PAID ${a.path} ${new Date().toISOString()}`); // buyer analytics: which endpoint sold
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
// Verification endpoint library — 48 validators (pure computation + free public sources, no API keys).
// Written standalone for unit testing; inlined into server.js for deployment.

// ---------- generic helpers ----------
function luhnOk(digits) {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = +digits[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}
// ISO 7064 mod-97 (IBAN, LEI)
function mod97Ok(str) {
  const rearr = (str.slice(4) + str.slice(0, 4)).toUpperCase();
  let rem = 0;
  for (const ch of rearr) {
    const code = ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : +ch;
    if (!Number.isInteger(code) || code < 0 || code > 35) return false;
    rem = (rem * (code > 9 ? 100 : 10) + code) % 97;
  }
  return rem === 1;
}
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(s) {
  if (!s || /[^1-9A-HJ-NP-Za-km-z]/.test(s)) return null;
  let num = 0n;
  for (const ch of s) num = num * 58n + BigInt(B58_ALPHABET.indexOf(ch));
  let bytes = new Uint8Array(0);
  if (num !== 0n) {
    let hex = num.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  }
  let leading = 0;
  for (const ch of s) { if (ch === '1') leading++; else break; }
  const out = new Uint8Array(leading + bytes.length);
  out.set(bytes, leading);
  return out;
}
// ---------- keccak256 (pure JS, for EIP-55) ----------
const KECCAK_RC = [0x0000000000000001n,0x0000000000008082n,0x800000000000808an,0x8000000080008000n,0x000000000000808bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,0x000000000000008an,0x0000000000000088n,0x0000000080008009n,0x000000008000000an,0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n];
const KECCAK_RHO = [0,1,62,28,27, 36,44,6,55,20, 3,10,43,25,39, 41,45,15,21,8, 18,2,61,56,14];
const MASK64 = (1n << 64n) - 1n;
function rotl64(x, n) { n %= 64; return n === 0 ? x & MASK64 : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64; }
function keccakF1600(s) {
  for (let r = 0; r < 24; r++) {
    const C = [], D = [];
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x+5] ^ s[x+10] ^ s[x+15] ^ s[x+20];
    for (let x = 0; x < 5; x++) D[x] = C[(x+4)%5] ^ rotl64(C[(x+1)%5], 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x+5*y] ^= D[x];
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++)
      B[y + 5*((2*x + 3*y) % 5)] = rotl64(s[x + 5*y], KECCAK_RHO[x + 5*y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++)
      s[x+5*y] = B[x+5*y] ^ ((~B[(x+1)%5 + 5*y] & MASK64) & B[(x+2)%5 + 5*y]);
    s[0] ^= KECCAK_RC[r];
  }
}
function keccak256Hex(inputBytes) {
  const rate = 136, suffix = 0x01;
  const blocks = [];
  let buf = Array.from(inputBytes);
  buf.push(suffix);
  while (buf.length % rate !== 0) buf.push(0x00);
  buf[buf.length - 1] |= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < buf.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) lane |= BigInt(buf[off + i*8 + b]) << BigInt(8*b);
      s[i] ^= lane;
    }
    keccakF1600(s);
  }
  let hex = '';
  for (let i = 0; i < 4; i++) hex += (s[i] & MASK64).toString(16).padStart(16, '0').match(/../g).reverse().join('');
  return hex;
}
// ---------- bech32 ----------
const BECH32_ALPH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(vals) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of vals) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function bech32Decode(addr) {
  const a = addr.toLowerCase();
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const pos = a.lastIndexOf('1');
  if (pos < 1 || pos + 7 > a.length || a.length > 90) return null;
  const hrp = a.slice(0, pos), data = a.slice(pos + 1);
  const vals = [];
  for (const ch of data) { const v = BECH32_ALPH.indexOf(ch); if (v < 0) return null; vals.push(v); }
  const hrpVals = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
  const pm = bech32Polymod(hrpVals.concat(vals));
  const isBech32 = pm === 1, isBech32m = pm === 0x2bc830a3;
  if (!isBech32 && !isBech32m) return null;
  const ver = vals[0];
  if (ver > 16) return null;
  if (ver === 0 && !(isBech32 && (vals.length === 39 || vals.length === 59))) return null;
  if (ver !== 0 && !isBech32m) return null;
  // convert 5-bit to 8-bit
  let acc = 0, bits = 0; const prog = [];
  for (let i = 1; i < vals.length - 6; i++) {
    acc = (acc << 5) | vals[i]; bits += 5;
    if (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff); }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  return { hrp, version: ver, program: prog, encoding: isBech32 ? 'bech32' : 'bech32m' };
}
async function fetchText(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'x402-verify/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
async function fetchJsonSimple(url, ms = 9000) {
  return JSON.parse(await fetchText(url, ms));
}

// ================= validators (each returns a JSON-able object) =================
const VERIFY_FNS = {
  // ---- Financial ----
  iban(v) {
    const s = v.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return { input: v, valid: false, reason: 'must be 2-letter country + 2 check digits + up to 30 alphanumerics' };
    const lens = { AL:28, AD:24, AT:20, AZ:28, BE:16, BH:22, BR:29, BG:22, CR:22, HR:21, CY:28, CZ:24, DK:18, DO:28, EG:29, ES:24, FI:18, FR:27, GB:22, GE:22, DE:22, GR:27, GL:18, GT:28, HU:28, IS:26, IE:22, IL:23, IT:27, JO:30, KZ:20, LV:21, LB:28, LI:21, LT:20, LU:20, MK:19, MT:31, MR:27, MU:30, MC:27, MD:24, ME:22, NL:18, NO:15, PK:24, PS:29, PL:28, PT:25, QA:29, RO:24, SM:27, SA:24, RS:22, SK:24, SI:19, SE:24, CH:21, TN:24, TR:26, AE:23 };
    const cc = s.slice(0, 2);
    if (lens[cc] && s.length !== lens[cc]) return { input: v, valid: false, reason: `wrong length for ${cc}: expected ${lens[cc]}` };
    const ok = mod97Ok(s);
    return { input: v, valid: ok, country: cc, check_digits: s.slice(2, 4), ...(ok ? {} : { reason: 'fails ISO 13616 mod-97 checksum' }) };
  },
  routing(v) {
    const s = v.replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(s)) return { input: v, valid: false, reason: 'must be 9 digits' };
    const d = [...s].map(Number);
    const sum = 3*(d[0]+d[3]+d[6]) + 7*(d[1]+d[4]+d[7]) + (d[2]+d[5]+d[8]);
    const ok = sum % 10 === 0;
    return { input: v, valid: ok, ...(ok ? {} : { reason: 'fails ABA checksum' }) };
  },
  card(v) {
    const s = v.replace(/[\s-]/g, '');
    if (!/^\d{12,19}$/.test(s)) return { input: v, valid: false, reason: 'must be 12-19 digits' };
    const brands = [
      [/^4/, 'Visa'], [/^5[1-5]/, 'Mastercard'], [/^2[2-7]/, 'Mastercard'],
      [/^3[47]/, 'American Express'], [/^6(?:011|5)/, 'Discover'], [/^35/, 'JCB'], [/^62/, 'UnionPay'],
    ];
    const brand = (brands.find(([re]) => re.test(s)) || [])[1] || 'Unknown';
    const ok = luhnOk(s);
    return { input: v, valid: ok, brand, disclaimer: 'Checksum only — does not confirm the card is real, active, or funded.' };
  },
  swift(v) {
    const s = v.trim().toUpperCase();
    const m = s.match(/^([A-Z]{4})([A-Z]{2})([A-Z0-9]{2})([A-Z0-9]{3})?$/);
    if (!m) return { input: v, valid: false, reason: 'must be 8 or 11 chars: 4-letter bank + 2-letter country + 2-char location + optional 3-char branch' };
    return { input: v, valid: true, bank_code: m[1], country: m[2], location: m[3], branch: m[4] || 'XXX (head office)' };
  },
  isin(v) {
    const s = v.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s)) return { input: v, valid: false, reason: 'must be 2 letters + 9 alphanumerics + 1 check digit' };
    const digits = [...s].map(ch => /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch).join('');
    const ok = luhnOk(digits);
    return { input: v, valid: ok, country: s.slice(0, 2), ...(ok ? {} : { reason: 'fails ISIN checksum' }) };
  },
  cusip(v) {
    const s = v.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[0-9A-Z*@#]{9}$/.test(s)) return { input: v, valid: false, reason: 'must be 9 chars (0-9, A-Z, *, @, #)' };
    const val = ch => /\d/.test(ch) ? +ch : ch === '*' ? 36 : ch === '@' ? 37 : ch === '#' ? 38 : ch.charCodeAt(0) - 55;
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      let n = val(s[i]);
      if (i % 2 === 1) { n *= 2; sum += Math.floor(n / 10) + (n % 10); }
      else sum += n;
    }
    const ok = (sum + val(s[8])) % 10 === 0;
    return { input: v, valid: ok, ...(ok ? {} : { reason: 'fails CUSIP checksum' }) };
  },
  sedol(v) {
    const s = v.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[0-9A-Z]{7}$/.test(s)) return { input: v, valid: false, reason: 'must be 7 alphanumerics' };
    const w = [1, 3, 1, 7, 3, 9];
    let sum = 0;
    for (let i = 0; i < 6; i++) {
      const ch = s[i];
      const n = /\d/.test(ch) ? +ch : ch.charCodeAt(0) - 55;
      sum += n * w[i];
    }
    const ok = (10 - (sum % 10)) % 10 === +s[6];
    return { input: v, valid: ok, ...(ok ? {} : { reason: 'fails SEDOL checksum' }) };
  },
  upi(v) {
    const s = v.trim();
    const ok = /^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/.test(s);
    return { input: v, valid: ok, ...(ok ? { handle: s.split('@')[0], provider: s.split('@')[1] } : { reason: 'must look like handle@bank' }) };
  },
  // ---- Identity / government / business ----
  vat(v) {
    const s = v.replace(/[\s\-.]/g, '').toUpperCase();
    const cc = s.slice(0, 2);
    const rest = s.slice(2);
    const rules = {
      DE: /^\d{9}$/, FR: /^[0-9A-Z]{2}\d{9}$/, IT: /^\d{11}$/, ES: /^[0-9A-Z]\d{7}[0-9A-Z]$/,
      NL: /^\d{9}B\d{2}$/, BE: /^\d{10}$/, AT: /^U\d{8}$/, PL: /^\d{10}$/, PT: /^\d{9}$/,
      IE: /^[0-9A-Z]\d{7}[0-9A-Z]$/, SE: /^\d{12}$/, DK: /^\d{8}$/, FI: /^\d{8}$/,
      GR: /^\d{9}$/, CZ: /^\d{8,10}$/, HU: /^\d{8}$/, RO: /^\d{2,10}$/, BG: /^\d{9,10}$/,
      HR: /^\d{11}$/, SK: /^\d{10}$/, SI: /^\d{8}$/, GB: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
    };
    if (!rules[cc]) return { input: v, valid: false, reason: 'unknown country prefix (expected EU/GB VAT like DE123456789)' };
    const ok = rules[cc].test(rest);
    return { input: v, valid: ok, country: cc, disclaimer: 'Format check only — not confirmed against the VIES registry.' };
  },
  ein(v) {
    const s = v.trim();
    const m = s.match(/^(\d{2})-?(\d{7})$/);
    const validPrefixes = ['01','02','03','04','05','06','10','11','12','13','14','15','16','20','21','22','23','24','25','26','27','30','32','33','34','35','36','37','38','39','40','41','42','43','44','45','46','47','48','50','51','52','53','54','55','56','57','58','59','60','61','62','63','64','65','66','68','71','72','73','74','75','76','77','80','81','82','83','84','85','86','87','88','90','91','92','93','94','95','98','99'];
    const ok = !!m && validPrefixes.includes(m[1]);
    return { input: v, valid: ok, ...(ok ? { formatted: `${m[1]}-${m[2]}` } : { reason: 'must be 2-digit IRS prefix + 7 digits (e.g. 12-3456789)' }) };
  },
  lei(v) {
    const s = v.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z0-9]{20}$/.test(s)) return { input: v, valid: false, reason: 'must be 20 alphanumerics' };
    const ok = mod97Ok(s);
    return { input: v, valid: ok, ...(ok ? {} : { reason: 'fails ISO 17442 mod-97 checksum' }) };
  },
  ssn(v) {
    const s = v.trim();
    const m = s.match(/^(\d{3})-?(\d{2})-?(\d{4})$/);
    if (!m) return { input: v, valid: false, reason: 'must look like 123-45-6789' };
    const [area, group, serial] = [m[1], m[2], m[3]];
    const bad = area === '000' || area === '666' || +area >= 900 || group === '00' || serial === '0000';
    return { input: v, valid: !bad, ...(bad ? { reason: 'uses an impossible SSA area/group/serial combination' } : {}), disclaimer: 'Format check only — reveals nothing about a real person.' };
  },
  mrz(v) {
    const lines = v.trim().toUpperCase().split(/[\r\n]+/).map(l => l.trim());
    if (lines.length !== 2 || lines.some(l => l.length !== 44 || /[^A-Z0-9<]/.test(l)))
      return { input: v, valid: false, reason: 'must be exactly 2 lines of 44 chars (A-Z, 0-9, <)' };
    const val = ch => ch === '<' ? 0 : /\d/.test(ch) ? +ch : ch.charCodeAt(0) - 55;
    const cd = s => { const w = [7, 3, 1]; let t = 0; for (let i = 0; i < s.length; i++) t += val(s[i]) * w[i % 3]; return t % 10; };
    const [l1, l2] = lines;
    // TD3 (passport): line2 = docnum(0-8)+cd(9), nationality(10-12), dob(13-18)+cd(19),
    // sex(20), expiry(21-26)+cd(27), personal(28-41)+cd(42), composite cd(43)
    const checks = [
      ['document_number', l2.slice(0, 9), +l2[9]],
      ['date_of_birth', l2.slice(13, 19), +l2[19]],
      ['expiry_date', l2.slice(21, 27), +l2[27]],
      ['personal_number', l2.slice(28, 42), +l2[42]],
    ];
    const bad = checks.filter(([n, s2, c]) => cd(s2) !== c).map(([n]) => n);
    const composite = cd(l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 28) + l2.slice(28, 43));
    const ok = bad.length === 0 && composite === +l2[43];
    return {
      input: v, valid: ok,
      document_type: l1[0], issuing_country: l1.slice(2, 5).replace(/</g, ''),
      document_number: l2.slice(0, 9).replace(/</g, ''),
      surname_given: l1.slice(5, 44).split('<<').map(p => p.replace(/</g, ' ').trim()),
      nationality: l2.slice(10, 13).replace(/</g, ''), sex: l2[20],
      ...(ok ? {} : { failed_checks: bad.concat(composite !== +l2[43] ? ['composite'] : []) }),
    };
  },
  nino(v) {
    const s = v.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]$/.test(s)) return { input: v, valid: false, reason: 'must be 2 letters + 6 digits + 1 letter (A-D)' };
    const bad = ['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ'].includes(s.slice(0, 2));
    return { input: v, valid: !bad, ...(bad ? { reason: 'prefix is never issued' } : {}) };
  },
  sin(v) {
    const s = v.replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(s)) return { input: v, valid: false, reason: 'must be 9 digits' };
    const ok = luhnOk(s);
    return { input: v, valid: ok, ...(ok ? {} : { reason: 'fails SIN Luhn checksum' }) };
  },
  // ---- Retail, logistics, automotive ----
  upc(v) {
    const s = v.replace(/[\s-]/g, '');
    const check = d => { let t = 0; for (let i = 0; i < d.length - 1; i++) t += +d[i] * (i % 2 === 0 ? 3 : 1); return (10 - (t % 10)) % 10 === +d[d.length - 1]; };
    if (/^\d{12}$/.test(s)) {
      const ok = check(s);
      return { input: v, valid: ok, format: 'UPC-A', ...(ok ? {} : { reason: 'fails UPC-A checksum' }) };
    }
    if (/^\d{8}$/.test(s)) {
      // expand UPC-E to UPC-A
      const last = s[6], mfr = s.slice(1, 6);
      let upc;
      if (last <= '2') upc = '0' + s[1] + s[2] + last + '0000' + s.slice(3, 6);
      else if (last === '3') upc = '0' + s.slice(1, 4) + '00000' + s.slice(4, 6);
      else if (last === '4') upc = '0' + s.slice(1, 5) + '00000' + s[5];
      else upc = '0' + s.slice(1, 6) + '0000' + last;
      upc += s[7];
      const ok = check(upc);
      return { input: v, valid: ok, format: 'UPC-E', expanded: upc, ...(ok ? {} : { reason: 'fails UPC-E checksum' }) };
    }
    return { input: v, valid: false, reason: 'must be 12 digits (UPC-A) or 8 digits (UPC-E)' };
  },
  ean(v) {
    const s = v.replace(/[\s-]/g, '');
    const check = d => { let t = 0; for (let i = 0; i < d.length - 1; i++) t += +d[i] * (i % 2 === 0 ? 1 : 3); return (10 - (t % 10)) % 10 === +d[d.length - 1]; };
    if (/^\d{13}$/.test(s)) {
      const ok = check(s);
      return { input: v, valid: ok, format: 'EAN-13', ...(ok ? {} : { reason: 'fails EAN-13 checksum' }) };
    }
    if (/^\d{8}$/.test(s)) {
      const ok = check(s);
      return { input: v, valid: ok, format: 'EAN-8', ...(ok ? {} : { reason: 'fails EAN-8 checksum' }) };
    }
    return { input: v, valid: false, reason: 'must be 13 digits (EAN-13) or 8 digits (EAN-8)' };
  },
  isbn(v) {
    const s = v.replace(/[\s-]/g, '').toUpperCase();
    if (/^\d{13}$/.test(s)) {
      let t = 0;
      for (let i = 0; i < 12; i++) t += +s[i] * (i % 2 === 0 ? 1 : 3);
      const ok = (10 - (t % 10)) % 10 === +s[12];
      return { input: v, valid: ok, format: 'ISBN-13', ...(ok ? {} : { reason: 'fails ISBN-13 checksum' }) };
    }
    if (/^\d{9}[\dX]$/.test(s)) {
      let t = 0;
      for (let i = 0; i < 9; i++) t += +s[i] * (10 - i);
      t += s[9] === 'X' ? 10 : +s[9];
      const ok = t % 11 === 0;
      return { input: v, valid: ok, format: 'ISBN-10', ...(ok ? {} : { reason: 'fails ISBN-10 checksum' }) };
    }
    return { input: v, valid: false, reason: 'must be 13 digits (ISBN-13) or 9 digits + digit/X (ISBN-10)' };
  },
  vin(v) {
    const s = v.trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(s)) return { input: v, valid: false, reason: 'must be 17 chars (no I, O, Q)' };
    const tv = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9 };
    const w = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
    let t = 0;
    for (let i = 0; i < 17; i++) { const ch = s[i]; t += (/\d/.test(ch) ? +ch : tv[ch]) * w[i]; }
    const cd = t % 11;
    const ok = (cd === 10 ? 'X' : String(cd)) === s[8];
    const years = { A:'1980/2010', B:'1981/2011', C:'1982/2012', D:'1983/2013', E:'1984/2014', F:'1985/2015', G:'1986/2016', H:'1987/2017', J:'1988/2018', K:'1989/2019', L:'1990/2020', M:'1991/2021', N:'1992/2022', P:'1993/2023', R:'1994/2024', S:'1995/2025', T:'1996/2026', V:'1997/2027', W:'1998/2028', X:'1999/2029', Y:'2000/2030', 1:'2001/2031', 2:'2002/2032', 3:'2003/2033', 4:'2004/2034', 5:'2005/2035', 6:'2006/2036', 7:'2007/2037', 8:'2008/2038', 9:'2009/2039' };
    return { input: v, valid: ok, wmi: s.slice(0, 3), model_year: years[s[9]] || 'unknown', plant: s[10], serial: s.slice(11), ...(ok ? {} : { reason: 'fails VIN check digit' }) };
  },
  usps(v) {
    const s = v.replace(/[\s-]/g, '');
    if (!/^\d{20}$|^\d{22}$|^\d{26}$|^\d{30}$|^\d{34}$/.test(s)) return { input: v, valid: false, reason: 'must be 20, 22, 26, 30, or 34 digits' };
    let t = 0;
    for (let i = 0; i < s.length - 1; i++) t += +s[i] * (i % 2 === 0 ? 3 : 1);
    const ok = (10 - (t % 10)) % 10 === +s[s.length - 1];
    return { input: v, valid: ok, length: s.length, ...(ok ? {} : { reason: 'fails USPS mod-10 checksum' }) };
  },
  ups(v) {
    const s = v.replace(/[\s-]/g, '').toUpperCase();
    if (!/^1Z[0-9A-Z]{16}$/.test(s)) return { input: v, valid: false, reason: 'must be 1Z + 16 alphanumerics' };
    const chars = s.slice(2); // 15 data chars + check digit
    let total = 0;
    for (let i = 0; i < 15; i++) {
      const c = chars[i];
      // letters map to single digits: A->2, B->3, ... H->9, I->0, J->1, ... (wraps at 10)
      const d = c >= '0' && c <= '9' ? +c : ((c.charCodeAt(0) - 65) % 10 + 2) % 10;
      total += i % 2 === 0 ? d : d * 2;
    }
    const ok = (10 - (total % 10)) % 10 === +chars[15];
    return { input: v, valid: ok, ...(ok ? {} : { reason: 'fails UPS check digit' }) };
  },
  fedex(v) {
    const s = v.replace(/[\s-]/g, '');
    if (!/^\d{12}$|^\d{15}$|^\d{20}$|^\d{22}$/.test(s)) return { input: v, valid: false, reason: 'must be 12, 15, 20, or 22 digits' };
    // FedEx does not publish its check-digit algorithm; structural validation only.
    return { input: v, valid: true, length: s.length, check: 'structural only — FedEx check algorithm is not public' };
  },
  imei(v) {
    const s = v.replace(/[\s-]/g, '');
    if (!/^\d{15}$/.test(s)) return { input: v, valid: false, reason: 'must be 15 digits' };
    const ok = luhnOk(s);
    return { input: v, valid: ok, tac: s.slice(0, 8), serial: s.slice(8, 14), ...(ok ? {} : { reason: 'fails IMEI Luhn checksum' }) };
  },
  meid(v) {
    const s = v.replace(/[\s-:]/g, '').toUpperCase();
    if (!/^[0-9A-F]{14}([0-9A-F])?$/.test(s)) return { input: v, valid: false, reason: 'must be 14 hex chars, optional 15th check digit' };
    if (s.length === 14) return { input: v, valid: true, check_digit: 'not provided' };
    let t = 0;
    for (let i = 0; i < 14; i++) {
      let n = parseInt(s[i], 16);
      if (i % 2 === 1) { n *= 2; t += Math.floor(n / 16) + (n % 16); }
      else t += n;
    }
    const ok = (16 - (t % 16)) % 16 === parseInt(s[14], 16);
    return { input: v, valid: ok, ...(ok ? {} : { reason: 'fails MEID check digit' }) };
  },
  container(v) {
    const s = v.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{7}$/.test(s)) return { input: v, valid: false, reason: 'must be 4 letters + 7 digits (ISO 6346)' };
    // ISO 6346 letter values: A=10..Z=38 skipping 11, 22, 33
    const letterVal = ch => { const base = ch.charCodeAt(0) - 55; return base + (base >= 11 ? 1 : 0) + (base >= 21 ? 1 : 0) + (base >= 31 ? 1 : 0); };
    let t = 0;
    for (let i = 0; i < 10; i++) {
      const ch = s[i];
      const n = i < 4 ? letterVal(ch) : +ch;
      t += n * Math.pow(2, i);
    }
    let cd = t % 11;
    if (cd === 10) cd = 0;
    const ok = cd === +s[10];
    return { input: v, valid: ok, owner: s.slice(0, 3), category: s[3], serial: s.slice(4, 10), ...(ok ? {} : { reason: 'fails ISO 6346 check digit' }) };
  },
  // ---- Network & web infrastructure ----
  async email(v) {
    const s = v.trim();
    if (!/^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/.test(s)) return { input: v, valid: false, reason: 'fails basic email syntax' };
    const domain = s.split('@').pop().toLowerCase();
    let mx = [];
    try {
      const d = await fetchJsonSimple(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`);
      mx = (d.Answer || []).filter(a => a.type === 15).map(a => a.data.split(' ').slice(1).join(' '));
    } catch (e) { return { input: v, valid: false, reason: 'MX lookup failed: ' + (e.message || e) }; }
    return { input: v, valid: mx.length > 0, domain, has_mx: mx.length > 0, mx_hosts: mx.slice(0, 5), ...(mx.length ? {} : { reason: 'domain has no MX records — cannot receive mail' }) };
  },
  async domain(v) {
    const s = v.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,}$/.test(s))
      return { input: v, valid: false, reason: 'not a valid domain format' };
    let d;
    try { d = await fetchJsonSimple(`https://rdap.org/domain/${encodeURIComponent(s)}`); }
    catch (e) { return { input: v, valid: false, registered: false, reason: 'no RDAP record — likely unregistered' }; }
    const ev = n => (d.events || []).find(e2 => e2.eventAction === n)?.eventDate || null;
    const registrar = (d.entities || []).find(e2 => (e2.roles || []).includes('registrar'));
    const created = ev('registration'), expires = ev('expiration');
    const ageDays = created ? Math.floor((Date.now() - new Date(created)) / 86400000) : null;
    return { input: v, valid: true, registered: true, domain: d.ldhName || s, status: d.status || [], created, expires, age_days: ageDays, registrar: registrar?.vcardArray?.[1]?.find(x => x[0] === 'fn')?.[3] || null };
  },
  async ssl(v) {
    const host = v.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    if (!host) return { input: v, valid: false, reason: 'missing domain' };
    const cert = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('TLS timeout')), 9000);
      const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
        clearTimeout(t);
        const c = sock.getPeerCertificate(true);
        sock.end();
        c ? resolve(c) : reject(new Error('no certificate presented'));
      });
      sock.on('error', e => { clearTimeout(t); reject(e); });
    }).catch(e => { throw new Error('TLS fetch failed: ' + (e.message || e)); });
    const validTo = new Date(cert.valid_to), validFrom = new Date(cert.valid_from);
    const now = new Date();
    const ok = now >= validFrom && now <= validTo;
    return {
      input: v, valid: ok, host,
      subject: cert.subject?.CN || null, issuer: cert.issuer?.O || cert.issuer?.CN || null,
      valid_from: cert.valid_from, valid_to: cert.valid_to,
      days_until_expiry: Math.floor((validTo - now) / 86400000),
      ...(ok ? {} : { reason: 'certificate is expired or not yet valid' }),
    };
  },
  ipv4(v) {
    const s = v.trim();
    if (!netIsIPv4(s)) return { input: v, valid: false, reason: 'not valid IPv4' };
    const o = s.split('.').map(Number);
    const cls =
      o[0] === 10 ? 'private (RFC1918)' : o[0] === 172 && o[1] >= 16 && o[1] <= 31 ? 'private (RFC1918)' :
      o[0] === 192 && o[1] === 168 ? 'private (RFC1918)' : o[0] === 127 ? 'loopback' :
      o[0] >= 224 && o[0] <= 239 ? 'multicast' : o[0] === 0 ? 'this network' :
      s === '255.255.255.255' ? 'broadcast' : o[0] === 169 && o[1] === 254 ? 'link-local' : 'public/unicast';
    return { input: v, valid: true, classification: cls };
  },
  ipv6(v) {
    const s = v.trim();
    if (!netIsIPv6(s)) return { input: v, valid: false, reason: 'not valid IPv6' };
    const low = s.toLowerCase();
    const cls = low === '::1' ? 'loopback' : low === '::' ? 'unspecified' :
      low.startsWith('fe80:') ? 'link-local' : low.startsWith('fc') || low.startsWith('fd') ? 'unique-local' :
      low.startsWith('ff') ? 'multicast' : 'global-unicast';
    return { input: v, valid: true, classification: cls };
  },
  mac(v) {
    const s = v.trim().toUpperCase();
    const m = s.match(/^([0-9A-F]{2})[:-]([0-9A-F]{2})[:-]([0-9A-F]{2})[:-]([0-9A-F]{2})[:-]([0-9A-F]{2})[:-]([0-9A-F]{2})$/) ||
              s.match(/^([0-9A-F]{4})\.([0-9A-F]{4})\.([0-9A-F]{4})$/) ||
              s.match(/^([0-9A-F]{12})$/);
    if (!m) return { input: v, valid: false, reason: 'must be XX:XX:XX:XX:XX:XX, XXXX.XXXX.XXXX, or 12 hex chars' };
    const hex = m.slice(1).join('').replace(/[^0-9A-F]/g, '');
    const first = parseInt(hex.slice(0, 2), 16);
    return {
      input: v, valid: true, normalized: hex.match(/../g).join(':'),
      oui: hex.slice(0, 6).match(/../g).join(':'),
      multicast: !!(first & 1), locally_administered: !!((first >> 1) & 1),
    };
  },
  asn(v) {
    const s = v.trim().toUpperCase();
    const m = s.match(/^(?:AS)?(\d+)$/);
    if (!m) return { input: v, valid: false, reason: 'must look like AS12345 or 12345' };
    const n = +m[1];
    if (n < 1 || n > 4294967295) return { input: v, valid: false, reason: 'out of range (1-4294967295)' };
    const scope = n <= 65535 ? '16-bit' : '32-bit';
    const priv = (n >= 64512 && n <= 65534) || (n >= 4200000000 && n <= 4294967294);
    return { input: v, valid: true, asn: 'AS' + n, scope, reserved: priv ? 'private-use' : 'public' };
  },
  e164(v) {
    const s = v.replace(/[\s\-.()]/g, '');
    const ok = /^\+[1-9]\d{7,14}$/.test(s);
    return { input: v, valid: ok, ...(ok ? { normalized: s, country_code: s.match(/^\+(\d{1,3})/)[1] } : { reason: 'must be + followed by 8-15 digits (e.g. +16315551234)' }) };
  },
  // ---- Security & cryptography ----
  async pwned(v) {
    if (!v) return { input: '(empty)', valid: false, reason: 'password required' };
    const sha1 = createHash('sha1').update(v, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5), suffix = sha1.slice(5);
    const body = await fetchText(`https://api.pwnedpasswords.com/range/${prefix}`).catch(e => { throw new Error('HIBP lookup failed: ' + (e.message || e)); });
    const line = body.split('\n').find(l => l.split(':')[0].trim() === suffix);
    const count = line ? parseInt(line.split(':')[1], 10) : 0;
    return { valid: true, breached: count > 0, breach_count: count, method: 'k-anonymity (only first 5 chars of SHA-1 left this server)', ...(count > 0 ? { warning: 'This password appears in known breaches — do not use it.' } : { note: 'Not found in known breaches.' }) };
  },
  jwt(v) {
    const s = v.trim();
    const parts = s.split('.');
    if (parts.length !== 3) return { input: '(redacted)', valid: false, reason: 'must have 3 dot-separated parts' };
    const dec = p => JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    let header, payload;
    try { header = dec(parts[0]); payload = dec(parts[1]); }
    catch { return { input: '(redacted)', valid: false, reason: 'header/payload are not valid base64url JSON' }; }
    const now = Math.floor(Date.now() / 1000);
    const exp = typeof payload.exp === 'number' ? payload.exp : null;
    return {
      valid: true, algorithm: header.alg || null, type: header.typ || null,
      subject: payload.sub ?? null, issuer: payload.iss ?? null,
      issued_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
      expires_at: exp ? new Date(exp * 1000).toISOString() : null,
      expired: exp ? now > exp : null,
      disclaimer: 'Structural decode only — signature NOT verified.',
    };
  },
  base64(v) {
    const s = v.trim();
    const std = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s) && s.length % 4 === 0 && s.length > 0;
    const url = /^(?:[A-Za-z0-9\-_]{4})*(?:[A-Za-z0-9\-_]{2}==|[A-Za-z0-9\-_]{3}=?|[A-Za-z0-9\-_]{4})?$/.test(s) && s.length > 0;
    return { input: v.slice(0, 64) + (v.length > 64 ? '…' : ''), valid: std || url, variant: std ? 'standard' : url ? 'base64url' : null, ...(std || url ? {} : { reason: 'fails strict base64/base64url structure' }) };
  },
  md5hash(v) {
    const s = v.trim().toLowerCase();
    const ok = /^[0-9a-f]{32}$/.test(s);
    return { input: v, valid: ok, algorithm: 'MD5', ...(ok ? {} : { reason: 'must be 32 hex chars' }) };
  },
  sha256hash(v) {
    const s = v.trim().toLowerCase();
    const ok = /^[0-9a-f]{64}$/.test(s);
    return { input: v, valid: ok, algorithm: 'SHA-256', ...(ok ? {} : { reason: 'must be 64 hex chars' }) };
  },
  uuid(v) {
    const s = v.trim().toLowerCase();
    const m = s.match(/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/);
    if (!m) return { input: v, valid: false, reason: 'must be 8-4-4-4-12 hex' };
    return { input: v, valid: true, version: m[3][0], variant: /^8|^9|^a|^b/.test(m[4]) ? 'RFC 4122' : 'reserved' };
  },
  ulid(v) {
    const s = v.trim().toUpperCase();
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(s)) return { input: v, valid: false, reason: 'must be 26 chars of Crockford base32 (no I,L,O,U)' };
    const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let ms = 0;
    for (let i = 0; i < 10; i++) ms = ms * 32 + C.indexOf(s[i]);
    return { input: v, valid: true, timestamp_ms: ms, timestamp: new Date(ms).toISOString() };
  },
  // ---- Blockchain & web3 ----
  evmAddress(v) {
    const s = v.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { input: v, valid: false, reason: 'must be 0x + 40 hex chars' };
    const hex = s.slice(2).toLowerCase();
    const hash = keccak256Hex(Buffer.from(hex, 'ascii'));
    let checksummed = '0x';
    for (let i = 0; i < 40; i++) checksummed += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
    const eip55 = s.slice(2) === checksummed.slice(2);
    const allLower = s.slice(2) === hex, allUpper = s.slice(2) === hex.toUpperCase();
    return { input: v, valid: true, eip55_checksum_valid: eip55 || allLower || allUpper, checksummed, note: allLower || allUpper ? 'all-lower/all-upper accepted (no checksum encoded)' : eip55 ? 'valid EIP-55 checksum' : 'INVALID EIP-55 checksum — possible typo' };
  },
  solanaAddress(v) {
    const s = v.trim();
    const bytes = base58Decode(s);
    const ok = !!bytes && bytes.length === 32;
    return { input: v, valid: ok, ...(ok ? { encoding: 'base58', bytes: 32 } : { reason: 'must be base58 decoding to exactly 32 bytes' }) };
  },
  btcAddress(v) {
    const s = v.trim();
    // Base58Check (P2PKH/P2SH)
    const raw = base58Decode(s);
    if (raw && (raw.length === 25)) {
      const ver = raw[0];
      const chk = createHash('sha256').update(createHash('sha256').update(raw.slice(0, 21)).digest()).digest().slice(0, 4);
      if (Buffer.from(chk).equals(Buffer.from(raw.slice(21)))) {
        const type = ver === 0x00 ? 'P2PKH' : ver === 0x05 ? 'P2SH' : ver === 0x6f ? 'P2PKH (testnet)' : ver === 0xc4 ? 'P2SH (testnet)' : 'unknown version ' + ver;
        return { input: v, valid: true, format: 'base58check', type };
      }
      return { input: v, valid: false, reason: 'fails base58check checksum' };
    }
    // Bech32/Bech32m (segwit)
    const bc = bech32Decode(s);
    if (bc && (bc.hrp === 'bc' || bc.hrp === 'tb' || bc.hrp === 'bcrt')) {
      const progLen = bc.program.length;
      const type = bc.version === 0 && progLen === 20 ? 'P2WPKH' : bc.version === 0 && progLen === 32 ? 'P2WSH' : `segwit v${bc.version}`;
      return { input: v, valid: true, format: bc.encoding, type, network: bc.hrp === 'bc' ? 'mainnet' : 'testnet/regtest' };
    }
    return { input: v, valid: false, reason: 'not a valid base58check or bech32 address' };
  },
  polkadotAddress(v) {
    const s = v.trim();
    const raw = base58Decode(s);
    if (!raw) return { input: v, valid: false, reason: 'not valid base58' };
    // SS58: prefix (1-2 bytes) + 32 bytes + checksum (1-2 bytes, blake2b("SS58PRE"+data))
    let prefix, body, csum;
    if (raw.length === 35) { prefix = raw[0]; if (prefix >= 64) return { input: v, valid: false, reason: 'bad ss58 prefix' }; body = raw.slice(1, 33); csum = raw.slice(33); }
    else if (raw.length === 36) { prefix = ((raw[0] & 0x3f) << 2) | (raw[1] >> 6); body = raw.slice(2, 34); csum = raw.slice(34); }
    else return { input: v, valid: false, reason: 'wrong length for ss58 (expected 35 or 36 bytes)' };
    const pre = Buffer.concat([Buffer.from('SS58PRE'), Buffer.from(raw.slice(0, raw.length - csum.length))]);
    const hash = createHash('blake2b512').update(pre).digest();
    const ok = hash[0] === csum[0] && (csum.length === 1 || hash[1] === csum[1]);
    const nets = { 0: 'Polkadot', 2: 'Kusama', 42: 'generic Substrate' };
    return { input: v, valid: ok, ...(ok ? { prefix, network: nets[prefix] || `ss58 prefix ${prefix}` } : { reason: 'fails ss58 checksum' }) };
  },
  ens(v) {
    const s = v.trim().toLowerCase();
    if (s.length > 255 || s.length === 0) return { input: v, valid: false, reason: 'empty or over 255 chars' };
    const labels = s.split('.');
    if (labels.length < 2) return { input: v, valid: false, reason: 'must have at least one dot (e.g. name.eth)' };
    for (const l of labels) {
      if (!l || l.length > 63 || !/^[a-z0-9-]+$/.test(l) || l.startsWith('-') || l.endsWith('-') || l.includes('--'))
        return { input: v, valid: false, reason: `bad label "${l}" (EIP-137: a-z, 0-9, hyphen, no leading/trailing/double hyphen)` };
    }
    return { input: v, valid: true, labels, tld: labels[labels.length - 1], is_eth: labels[labels.length - 1] === 'eth' };
  },
  // ---- Development & data formats ----
  semver(v) {
    const s = v.trim().replace(/^v/i, '');
    const m = s.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/);
    if (!m) return { input: v, valid: false, reason: 'must match SemVer 2.0.0 (e.g. 1.2.3, 2.0.0-beta.1+build)' };
    return { input: v, valid: true, major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] || null, build: m[5] || null };
  },
  cron(v) {
    const s = v.trim();
    const parts = s.split(/\s+/);
    if (parts.length !== 5 && parts.length !== 6) return { input: v, valid: false, reason: 'must have 5 fields (min hour dom month dow) or 6 (with seconds)' };
    const names = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const fields = parts.length === 6 ? parts.slice(1) : parts; // drop seconds for next-run calc
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    const parseField = (f, [lo, hi]) => {
      let ff = f.toLowerCase();
      for (const [n, num] of Object.entries(names)) ff = ff.replace(new RegExp(`\\b${n}\\b`, 'g'), num);
      if (ff === '*') return { ok: true, all: true };
      const vals = new Set();
      for (const seg of ff.split(',')) {
        let m = seg.match(/^\*\/(\d+)$/);
        let a, b, step;
        if (m) { a = lo; b = hi; step = +m[1]; }
        else {
          m = seg.match(/^(\d+)(?:-(\d+))?(?:\/(\d+))?$/);
          if (!m) return { ok: false };
          [a, b, step] = [+m[1], m[2] !== undefined ? +m[2] : +m[1], m[3] !== undefined ? +m[3] : 1];
        }
        if (a < lo || b > hi || a > b || step < 1) return { ok: false };
        for (let x = a; x <= b; x += step) vals.add(x === 7 && hi === 7 ? 0 : x);
      }
      return { ok: true, vals };
    };
    const parsed = fields.map((f, i) => parseField(f, ranges[i]));
    const badIdx = parsed.findIndex(p => !p.ok);
    if (badIdx >= 0) return { input: v, valid: false, reason: `field ${badIdx + 1} ("${fields[badIdx]}") out of range or malformed` };
    // next run: step minute-by-minute up to 366 days
    const [mi, hr, dom, mon, dow] = parsed;
    const match = d => (!mi.vals || mi.vals.has(d.getMinutes())) && (!hr.vals || hr.vals.has(d.getHours())) &&
      (!mon.vals || mon.vals.has(d.getMonth() + 1)) &&
      ((!dom.vals || dom.vals.has(d.getDate())) || (!dow.vals || dow.vals.has(d.getDay())));
    const t = new Date(); t.setSeconds(0, 0); t.setMinutes(t.getMinutes() + 1);
    let next = null;
    for (let i = 0; i < 366 * 1440; i++) { if (match(t)) { next = new Date(t); break; } t.setMinutes(t.getMinutes() + 1); }
    return { input: v, valid: true, fields: parts.length, next_run: next ? next.toISOString() : null };
  },
  json(v) {
    try {
      const o = JSON.parse(v);
      const t = Array.isArray(o) ? 'array' : o === null ? 'null' : typeof o;
      return { valid: true, type: t, ...(t === 'array' ? { length: o.length } : t === 'object' ? { keys: Object.keys(o).length } : {}) };
    } catch (e) {
      const m = String(e.message).match(/position (\d+)/);
      return { valid: false, reason: 'invalid JSON: ' + e.message, ...(m ? { error_at: +m[1], context: v.slice(Math.max(0, +m[1] - 20), +m[1] + 20) } : {}) };
    }
  },
  // ---- Smart contract surface linter (text in, no downloads, no subprocesses) ----
  contract(v) {
    const code = (v || '').trim();
    if (code.length > 10000) return { valid: false, chars_scanned: code.length, reason: 'snippet too large (max 10,000 characters)' };
    const warnings = [];
    // EVM / Solidity surface-level checks
    if (/\bselfdestruct\s*\(/.test(code)) warnings.push('selfdestruct() allows contract destruction and fund draining');
    if (/\bdelegatecall\s*\(/.test(code)) warnings.push('delegatecall() can allow arbitrary code execution in the caller context');
    if (/\btx\.origin\b/.test(code)) warnings.push('tx.origin used — vulnerable to phishing; use msg.sender for authorization');
    if (/\bblock\.timestamp\b/.test(code)) warnings.push('block.timestamp used — miner-manipulable; unsafe for randomness or critical logic');
    if (/\btransferFrom\s*\(/.test(code) && !/\brequire\s*\(/.test(code)) warnings.push('transferFrom() without a visible require() check');
    // Solana / Rust surface-level checks
    if (/\bunsafe\s*\{/.test(code)) warnings.push('unsafe{} block detected — bypasses Rust memory safety guarantees');
    if (/\bAccountInfo\b/.test(code) && !/\bis_signer\b/.test(code)) warnings.push('AccountInfo used without a visible is_signer check — possible missing authorization');
    return {
      chars_scanned: code.length,
      issues_found: warnings.length,
      warnings: warnings.length ? warnings : ['No basic surface-level issues detected'],
      disclaimer: 'Regex-based surface linter only — not a formal security audit. False positives and false negatives are expected.',
    };
  },
}; // end VERIFY_FNS

// ---- endpoint table: path, price tier const name, query param, summary, operationId ----
const VERIFY_APIS = [
  // Financial
  { key: 'iban', path: '/verify/iban', price: 'PRICE', param: 'iban', op: 'verifyIban', summary: 'Validates an IBAN checksum (ISO 13616 mod-97) and parses country/bank codes' },
  { key: 'routing', path: '/verify/routing', price: 'PRICE', param: 'routing', op: 'verifyRouting', summary: 'Validates a US bank routing number (ABA) checksum' },
  { key: 'card', path: '/verify/card', price: 'PRICE', param: 'number', op: 'verifyCard', summary: 'Validates a card number Luhn checksum and detects the brand (format check only)' },
  { key: 'swift', path: '/verify/swift', price: 'PRICE', param: 'swift', op: 'verifySwift', summary: 'Validates a SWIFT/BIC code structure and parses bank/country/branch' },
  { key: 'isin', path: '/verify/isin', price: 'PRICE', param: 'isin', op: 'verifyIsin', summary: 'Validates an ISIN securities identifier checksum' },
  { key: 'cusip', path: '/verify/cusip', price: 'PRICE', param: 'cusip', op: 'verifyCusip', summary: 'Validates a CUSIP securities identifier checksum' },
  { key: 'sedol', path: '/verify/sedol', price: 'PRICE', param: 'sedol', op: 'verifySedol', summary: 'Validates a SEDOL (UK securities) checksum' },
  { key: 'upi', path: '/verify/upi', price: 'PRICE', param: 'upi', op: 'verifyUpi', summary: 'Validates a UPI ID format (India, handle@bank)' },
  // Identity
  { key: 'vat', path: '/verify/vat', price: 'PRICE', param: 'vat', op: 'verifyVat', summary: 'Validates an EU/GB VAT number format per country rules' },
  { key: 'ein', path: '/verify/ein', price: 'PRICE', param: 'ein', op: 'verifyEin', summary: 'Validates a US EIN format and IRS prefix' },
  { key: 'lei', path: '/verify/lei', price: 'PRICE', param: 'lei', op: 'verifyLei', summary: 'Validates a Legal Entity Identifier (ISO 17442 mod-97)' },
  { key: 'ssn', path: '/verify/ssn', price: 'PRICE', param: 'ssn', op: 'verifySsn', summary: 'Validates a US SSN format against impossible SSA combinations (format only)' },
  { key: 'mrz', path: '/verify/passport/mrz', price: 'PRICE', param: 'mrz', op: 'verifyMrz', summary: 'Validates passport MRZ check digits (ICAO 9303, 2x44 chars)' },
  { key: 'nino', path: '/verify/nino', price: 'PRICE', param: 'nino', op: 'verifyNino', summary: 'Validates a UK National Insurance number format and prefix rules' },
  { key: 'sin', path: '/verify/sin', price: 'PRICE', param: 'sin', op: 'verifySin', summary: 'Validates a Canadian SIN Luhn checksum' },
  // Retail / logistics / auto
  { key: 'upc', path: '/verify/upc', price: 'PRICE', param: 'upc', op: 'verifyUpc', summary: 'Validates UPC-A/UPC-E barcode checksums' },
  { key: 'ean', path: '/verify/ean', price: 'PRICE', param: 'ean', op: 'verifyEan', summary: 'Validates EAN-13/EAN-8 barcode checksums' },
  { key: 'isbn', path: '/verify/isbn', price: 'PRICE', param: 'isbn', op: 'verifyIsbn', summary: 'Validates ISBN-10/ISBN-13 checksums' },
  { key: 'vin', path: '/verify/vin', price: 'PRICE', param: 'vin', op: 'verifyVin', summary: 'Validates a VIN check digit and decodes year/plant' },
  { key: 'usps', path: '/verify/usps', price: 'PRICE', param: 'tracking', op: 'verifyUsps', summary: 'Validates a USPS tracking number checksum' },
  { key: 'ups', path: '/verify/ups', price: 'PRICE', param: 'tracking', op: 'verifyUps', summary: 'Validates a UPS tracking number (1Z) check digit' },
  { key: 'fedex', path: '/verify/fedex', price: 'PRICE', param: 'tracking', op: 'verifyFedex', summary: 'Validates FedEx tracking number structure (12/15/20/22 digits; checksum not published by FedEx)' },
  { key: 'imei', path: '/verify/imei', price: 'PRICE', param: 'imei', op: 'verifyImei', summary: 'Validates a device IMEI Luhn checksum' },
  { key: 'meid', path: '/verify/meid', price: 'PRICE', param: 'meid', op: 'verifyMeid', summary: 'Validates a device MEID hex format and check digit' },
  { key: 'container', path: '/verify/container', price: 'PRICE', param: 'container', op: 'verifyContainer', summary: 'Validates an ISO 6346 shipping container code check digit' },
  // Network
  { key: 'email', path: '/verify/email', price: 'VERIFY_PRICE', param: 'email', op: 'verifyEmail', summary: 'Validates email syntax and live MX records via DNS-over-HTTPS' },
  { key: 'domain', path: '/verify/domain', price: 'PRICE', param: 'domain', op: 'verifyDomain', summary: 'Returns RDAP registration status, age, expiry, and registrar for a domain' },
  { key: 'ssl', path: '/verify/ssl', price: 'PRICE', param: 'domain', op: 'verifySsl', summary: 'Fetches a domain TLS certificate and reports validity window and expiry' },
  { key: 'ipv4', path: '/verify/ipv4', price: 'UTILS_PRICE', param: 'ip', op: 'verifyIpv4', summary: 'Validates IPv4 format and classifies the address range' },
  { key: 'ipv6', path: '/verify/ipv6', price: 'UTILS_PRICE', param: 'ip', op: 'verifyIpv6', summary: 'Validates IPv6 format and classifies the address range' },
  { key: 'mac', path: '/verify/mac', price: 'UTILS_PRICE', param: 'mac', op: 'verifyMac', summary: 'Validates a MAC address and parses OUI/multicast bits' },
  { key: 'asn', path: '/verify/asn', price: 'UTILS_PRICE', param: 'asn', op: 'verifyAsn', summary: 'Validates an Autonomous System Number and reports scope' },
  { key: 'e164', path: '/verify/e164', price: 'UTILS_PRICE', param: 'phone', op: 'verifyE164', summary: 'Validates E.164 international phone number formatting' },
  // Security
  { key: 'pwned', path: '/verify/pwned', price: 'VERIFY_PRICE', param: 'password', op: 'verifyPwned', summary: 'Checks a password against breach data via HIBP k-anonymity (never sent in full)' },
  { key: 'jwt', path: '/verify/jwt', price: 'UTILS_PRICE', param: 'token', op: 'verifyJwt', summary: 'Structurally decodes a JWT header/payload and checks expiry (no signature verify)' },
  { key: 'base64', path: '/verify/base64', price: 'UTILS_PRICE', param: 'data', op: 'verifyBase64', summary: 'Strictly validates base64/base64url encoding structure' },
  { key: 'md5hash', path: '/verify/hash/md5', price: 'UTILS_PRICE', param: 'hash', op: 'verifyMd5', summary: 'Validates a 32-char MD5 hex digest format' },
  { key: 'sha256hash', path: '/verify/hash/sha256', price: 'UTILS_PRICE', param: 'hash', op: 'verifySha256', summary: 'Validates a 64-char SHA-256 hex digest format' },
  { key: 'uuid', path: '/verify/uuid', price: 'UTILS_PRICE', param: 'uuid', op: 'verifyUuid', summary: 'Validates UUID structure and detects the version' },
  { key: 'ulid', path: '/verify/ulid', price: 'UTILS_PRICE', param: 'ulid', op: 'verifyUlid', summary: 'Validates ULID format and extracts its timestamp' },
  // Blockchain
  { key: 'evmAddress', path: '/verify/address/evm', price: 'UTILS_PRICE', param: 'address', op: 'verifyEvmAddress', summary: 'Validates an EVM address and its EIP-55 checksum' },
  { key: 'solanaAddress', path: '/verify/address/solana', price: 'UTILS_PRICE', param: 'address', op: 'verifySolanaAddress', summary: 'Validates a Solana address (base58, 32 bytes)' },
  { key: 'btcAddress', path: '/verify/address/btc', price: 'UTILS_PRICE', param: 'address', op: 'verifyBtcAddress', summary: 'Validates Bitcoin P2PKH/P2SH/bech32 addresses' },
  { key: 'polkadotAddress', path: '/verify/address/polkadot', price: 'UTILS_PRICE', param: 'address', op: 'verifyPolkadotAddress', summary: 'Validates a Polkadot/Substrate ss58 address checksum' },
  { key: 'ens', path: '/verify/ens', price: 'UTILS_PRICE', param: 'name', op: 'verifyEns', summary: 'Validates an ENS name against EIP-137 normalization rules' },
  { key: 'contract', path: '/verify/contract', price: 'UTILS_PRICE', param: 'code', op: 'verifyContract', summary: 'Surface-level smart-contract linter: flags dangerous Solidity/Rust patterns (selfdestruct, delegatecall, tx.origin, unsafe blocks, missing signer checks)' },
  // Dev
  { key: 'semver', path: '/verify/semver', price: 'UTILS_PRICE', param: 'version', op: 'verifySemver', summary: 'Validates Semantic Versioning 2.0.0 format' },
  { key: 'cron', path: '/verify/cron', price: 'UTILS_PRICE', param: 'cron', op: 'verifyCron', summary: 'Validates a cron expression and computes the next run time' },
  { key: 'json', path: '/verify/json', price: 'UTILS_PRICE', param: 'json', op: 'verifyJson', summary: 'Strictly validates JSON and pinpoints syntax errors' },
];
// price tier -> { amount6, label }
const VERIFY_TIERS = {
  PRICE: { amount: '0.005000', label: '$0.005' },
  CHAIN_PRICE: { amount: '0.003000', label: '$0.003' },
  UTILS_PRICE: { amount: '0.001000', label: '$0.001' },
  VERIFY_PRICE: { amount: '0.010000', label: '$0.01' },
  AI_PRICE: { amount: '0.010000', label: '$0.01' },
};
const _priceConst = () => ({ PRICE, CHAIN_PRICE, UTILS_PRICE, VERIFY_PRICE, AI_PRICE });
function buildVerifyMw() {
  const mw = {};
  for (const v of VERIFY_APIS) {
    mw[`GET ${v.path}`] = {
      accepts: acceptsFor(_priceConst()[v.price]),
      description: `Returns a JSON object: ${v.summary.charAt(0).toLowerCase() + v.summary.slice(1)}`,
      extensions: bazaarExt([{ n: v.param, req: true, d: `Value to verify` }]),
    };
  }
  return mw;
}
function registerVerifyRoutes(app) {
  for (const v of VERIFY_APIS) {
    app.get(v.path, async (req, res) => {
      const val = (req.query[v.param] || '').toString();
      if (!val.trim()) return res.status(400).json({ error: `missing ?${v.param}= parameter` });
      try {
        console.log(`PAID ${v.path} ${new Date().toISOString()}`); // buyer analytics: which endpoint sold
        res.json(await VERIFY_FNS[v.key](val));
      } catch (e) {
        res.status(502).json({ error: `${v.path} failed: ${String(e.message || e)}` });
      }
    });
  }
}
function buildVerifyOapiPaths() {
  const paths = {};
  for (const v of VERIFY_APIS) {
    const t = VERIFY_TIERS[v.price];
    paths[v.path] = {
      get: {
        operationId: v.op,
        summary: v.summary,
        tags: ['Verification'],
        'x-payment-info': { price: { mode: 'fixed', currency: 'USD', amount: t.amount }, protocols: [{ x402: {} }] },
        parameters: [{ name: v.param, in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Verification result', content: { 'application/json': { schema: { type: 'object' } } } },
          402: { description: `Payment Required: ${t.label} USDC via x402` },
        },
      },
    };
  }
  return paths;
}
function buildVerifyX402eps(ep) {
  return VERIFY_APIS.map(v => ep(v.path, v.summary, _priceConst()[v.price]));
}

const app = express();
app.set('trust proxy', 1); // Render reverse proxy: keeps resource URLs https:// for CDP Bazaar

const masterMw = buildMasterMw();
app.use(paymentMiddleware(
  {
    ...masterMw,
    ...buildVerifyMw(),
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
    verify_suite: `${PRICE} USDC per request ($0.01 for email/npi/pwned, $0.001 for utils)`,
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
    'GET /verify/iban?iban=GB29NWBK60161331926819',
    'GET /verify/vin?vin=1HGCM82633A004352',
    'GET /verify/email?email=test@example.com',
    'GET /verify/address/evm?address=0xD7CDd563e8F6A249B076A702b7e2C233CCF3481d',
    'GET /verify/upc?upc=036000291452',
    'GET /verify/jwt?token=<jwt>',
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

registerVerifyRoutes(app);

// Discovery: OpenAPI 3.1 document — required by x402scan for listing
// Discovery: OpenAPI 3.1 document — required by x402scan for listing
registerMasterRoutes(app);

app.get('/openapi.json', (req, res) => res.json({
  openapi: '3.1.0',
  info: {
    title: 'x402 master data API — 127 endpoints',
    version: '2.0.0',
    description: '127 pay-per-call APIs: AI text/image generation ($0.01), Polymarket odds, crypto prices, DeFi yields, FX rates, weather, IP/geo, FBI wanted, SEC tickers, clinical trials, 250M academic papers, Stack Overflow, meme-coin launchpads (pump.fun, Clanker, Four.meme, SunPump), tokenized stocks, Solana top 100, Base DEX spreads, and 40+ more. $0.005/call standard. USDC on Base and Solana via x402.',
    contact: { email: 'ctiernan21@gmail.com' },
  },
  servers: [{ url: API_URL }],
  paths: {
    ...buildMasterOapiPaths(),
    ...buildVerifyOapiPaths(),
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
    name: 'x402 master data API — 127 endpoints',
    description: '127 pay-per-call APIs: AI text/image generation ($0.01), Polymarket odds, crypto prices, DeFi yields, FX rates, weather, IP/geo, FBI wanted, SEC tickers, clinical trials, 250M academic papers, Stack Overflow, meme-coin launchpads (pump.fun, Clanker, Four.meme, SunPump), tokenized stocks, Solana top 100, Base DEX spreads, and 40+ more. $0.005/call standard. USDC on Base and Solana via x402.',
    url: API_URL,
    x402Version: 2,
    networks: [...Object.values(EVM_NETWORKS), SOL_NETWORK],
    endpoints: [
      ...buildMasterX402eps(ep),
      ...buildVerifyX402eps(ep),
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
