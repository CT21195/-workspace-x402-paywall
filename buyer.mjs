// Self-test buyer: pays $0.01 USDC on Solana mainnet to your own API and prints the data.
// Run on YOUR machine:  SOL_PRIVATE_KEY='<your base58 private key>' node buyer.mjs
// Never share your private key. This only ever talks to your API + Solana RPC.
import { x402Client } from '@x402/core/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder } from '@solana/kit';

const API = process.env.API_URL || 'https://workspace-x402-paywall.onrender.com/spread';
const SOL_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const raw = process.env.SOL_PRIVATE_KEY;
if (!raw) {
  console.error('Set SOL_PRIVATE_KEY first. Get it from Phantom: Settings > Manage Accounts > your account > Show Private Key.');
  process.exit(1);
}
const secretKey = raw.trim().startsWith('[')
  ? Uint8Array.from(JSON.parse(raw))
  : getBase58Decoder().decode(raw.trim());
const signer = await createKeyPairSignerFromPrivateKeyBytes(secretKey);
console.log('buyer wallet:', signer.address);

// Pick the Solana mainnet option from the 402 challenge
const client = new x402Client((paymentRequired) =>
  paymentRequired.accepts.find((a) => a.network === SOL_MAINNET),
);
registerExactSvmScheme(client, { signer, networks: [SOL_MAINNET] });
client.onPaymentResponse(async ({ paymentResponse }) => {
  console.log('settlement tx:', paymentResponse?.transaction ?? paymentResponse);
});

// 1) ask -> 402 challenge
const first = await fetch(API);
if (first.status !== 402) {
  console.error('expected 402, got', first.status, await first.text());
  process.exit(1);
}
const paymentRequired = decodePaymentRequiredHeader(first.headers.get('PAYMENT-REQUIRED'));
console.log('price:', paymentRequired.accepts.find((a) => a.network === SOL_MAINNET)?.amount, 'base units USDC');

// 2) sign + retry with payment
const payload = await client.createPaymentPayload(paymentRequired);
const paid = await fetch(API, {
  headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) },
});
console.log('paid request ->', paid.status);
console.log(JSON.stringify(await paid.json(), null, 2));
