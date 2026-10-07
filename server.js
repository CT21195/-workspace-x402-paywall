import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

// ---- config ----
const PAY_TO_EVM = process.env.X402_PAY_TO || '0xD7CDd563e8F6A249B076A702b7e2C233CCF3481d'; // Chris's Base wallet
const PAY_TO_SOL = process.env.X402_PAY_TO_SOL || 'E21AWkUtLz4BP7AaT82CF7v86Kmv4YzN4NAR1FQnEmqy'; // Chris's Solana wallet
const PRICE = '$0.01'; // USDC per request
const EVM_NETWORK = 'eip155:8453'; // Base mainnet
const SOL_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; // Solana mainnet
// ----------------

// ---- live spread: computed fresh on each paid request (no local monitor needed) ----
const KRAKEN_TAKER = 0.004, DEX_COST = 0.0085, WITHDRAW_USD = 20, NOTIONAL = 1000;
async function latestSpread() {
  const [kRes, dRes] = await Promise.all([
    fetch('https://api.kraken.com/0/public/Ticker?pair=SOLUSD'),
    fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'),
  ]);
  if (!kRes.ok || !dRes.ok) throw new Error('price feed unavailable');
  const k = parseFloat((await kRes.json()).result.SOLUSD.c[0]);
  const pairs = (await dRes.json()).pairs || [];
  const sol = pairs.find(p => p.chainId === 'solana' && p.quoteToken?.symbol === 'USDC') || pairs[0];
  if (!sol) throw new Error('no solana pairs from dexscreener');
  const d = parseFloat(sol.priceUsd);
  const gross = (d - k) / k * 100;
  const net = gross - (KRAKEN_TAKER + DEX_COST) * 100 - WITHDRAW_USD / NOTIONAL * 100;
  return {
    ts_utc: new Date().toISOString(),
    kraken_usd: +k.toFixed(4),
    dex_usd: +d.toFixed(4),
    dex_venue: sol.dexId,
    gross_spread_pct: +gross.toFixed(4),
    net_spread_pct: +net.toFixed(4),
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
      description: 'Latest SOL CEX-DEX spread reading (Kraken vs Solana DEX)',
    },
  },
  resourceServer,
));

app.get('/', (req, res) => res.json({
  service: 'SOL CEX-DEX spread feed',
  price: `${PRICE} USDC per request, x402 on Base or Solana`,
  paid_endpoint: 'GET /spread',
}));

app.get('/spread', async (req, res) => {
  try {
    res.json(await latestSpread());
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3402;
app.listen(PORT, () => console.log(`paywall up on :${PORT}`));
