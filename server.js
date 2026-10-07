import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

// ---- config ----
const PAY_TO_EVM = process.env.X402_PAY_TO || '0xD7CDd563e8F6A249B076A702b7e2C233CCF3481d'; // Chris's Base wallet
const PAY_TO_SOL = process.env.X402_PAY_TO_SOL || 'E21AWkUtLz4BP7AaT82CF7v86Kmv4YzN4NAR1FQnEmqy'; // Chris's Solana wallet
const PRICE = '$0.005'; // USDC per request (half a cent)
const EVM_NETWORK = 'eip155:8453'; // Base mainnet
const SOL_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; // Solana mainnet
const API_URL = 'https://workspace-x402-paywall.onrender.com';
// ----------------

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
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(EVM_NETWORK, new ExactEvmScheme())
  .register(SOL_NETWORK, new ExactSvmScheme());

const app = express();

app.use(paymentMiddleware(
  {
    'GET /spread': {
      accepts: [
        { scheme: 'exact', price: PRICE, network: EVM_NETWORK, payTo: PAY_TO_EVM },
        { scheme: 'exact', price: PRICE, network: SOL_NETWORK, payTo: PAY_TO_SOL },
      ],
      description: 'Live SOL prices across top 5 CEXs + top 5 Solana DEXs with widest spread',
    },
  },
  resourceServer,
));

app.get('/', (req, res) => res.json({
  service: 'SOL multi-venue spread feed',
  description: 'Live SOL prices across top 5 CEXs (Coinbase, Kraken, OKX, Bitstamp, Gate.io) + top 5 Solana DEXs, with widest spread',
  price: `${PRICE} USDC per request, x402 on Base or Solana`,
  paid_endpoint: 'GET /spread',
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

// Discovery: OpenAPI 3.1 document — required by x402scan for listing
app.get('/openapi.json', (req, res) => res.json({
  openapi: '3.1.0',
  info: {
    title: 'SOL multi-venue spread feed',
    version: '1.1.0',
    description: 'Live SOL prices across top 5 CEXs (Coinbase, Kraken, OKX, Bitstamp, Gate.io) + top 5 Solana DEXs by volume, with the widest cross-venue spread. Paid via x402: $0.005 USDC per request on Base or Solana mainnet.',
    'x-guidance': 'Call GET /spread with optional ?notional= (your trade size in USD, default 1000). First call returns HTTP 402 with a PAYMENT-REQUIRED header (x402 v2). Pay $0.005 USDC on Base (eip155:8453) or Solana mainnet to the payTo address, then retry with the PAYMENT-SIGNATURE header. Response is the latest multi-venue snapshot as JSON.',
    contact: { email: 'ctiernan21@gmail.com' },
  },
  servers: [{ url: API_URL }],
  paths: {
    '/spread': {
      get: {
        operationId: 'getSpread',
        summary: 'Live SOL prices: top 5 CEXs + top 5 Solana DEXs',
        tags: ['Data'],
        'x-payment-info': {
          price: { mode: 'fixed', currency: 'USD', amount: '0.005000' },
          protocols: [{ x402: {} }],
        },
        parameters: [
          {
            name: 'notional',
            in: 'query',
            required: false,
            description: 'Your intended trade size in USD. Calibrates est_net_pct on the widest spread to your size (default 1000).',
            schema: { type: 'number', default: 1000, minimum: 1 },
          },
        ],
        security: [],
        responses: {
          200: {
            description: 'Multi-venue spread snapshot',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Spread' },
              },
            },
          },
          402: {
            description: 'Payment Required — pay $0.005 USDC via x402 (Base or Solana), then retry with PAYMENT-SIGNATURE header',
          },
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
          cex: { type: 'object', description: 'SOL price per CEX', additionalProperties: { type: 'number' } },
          dex: { type: 'object', description: 'SOL price per Solana DEX', additionalProperties: { type: 'number' } },
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
  },
}));

// Discovery: lets x402 directories auto-index this service
app.get('/.well-known/x402.json', (req, res) => res.json({
  name: 'SOL multi-venue spread feed',
  description: 'Live SOL prices across top 5 CEXs + top 5 Solana DEXs with widest spread, computed live per request',
  url: API_URL,
  x402Version: 2,
  endpoints: [
    {
      path: '/spread',
      method: 'GET',
      description: 'Live SOL prices across top 5 CEXs + top 5 Solana DEXs with widest spread',
      price: PRICE,
      accepts: [
        { scheme: 'exact', network: EVM_NETWORK, asset: 'USDC', payTo: PAY_TO_EVM },
        { scheme: 'exact', network: SOL_NETWORK, asset: 'USDC', payTo: PAY_TO_SOL },
      ],
    },
  ],
}));

const PORT = process.env.PORT || 3402;
app.listen(PORT, () => console.log(`paywall up on :${PORT}`));
