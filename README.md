# Spread Paywall API

147 pay-per-call API endpoints, monetized with [x402 v2](https://www.x402.org/). No API keys, no accounts, no signups — callers pay per request in USDC and get JSON back.

**Live:** https://workspace-x402-paywall.onrender.com
**Machine-readable:** [/openapi.json](https://workspace-x402-paywall.onrender.com/openapi.json) · [/.well-known/x402.json](https://workspace-x402-paywall.onrender.com/.well-known/x402.json)

## How it works

Every paid endpoint returns **HTTP 402** with payment terms in the response body: x402 v2, `exact` scheme, paid with an EIP-3009 `TransferWithAuthorization` in USDC. A facilitator settles on-chain, so the payer's wallet only signs — no gas needed.

- **Pay on Base:** USDC → `0xD7CDd563e8F6A249B076A702b7e2C233CCF3481d`
- **Pay on Solana:** USDC → `E21AWkUtLz4BP7AaT82CF7v86Kmv4YzN4NAR1FQnEmqy`

Unpaid request → `402` with the price and payment instructions. Paid request → `200` with JSON.

## Pricing

| Tier | Price (USDC) | Covers |
|---|---|---|
| Utility | $0.001 | block height, slot, base64, hashing, UUIDs, IP, time, text diff, QR codes, timezone conversion, Markdown/HTML/CSV/JSON converters |
| Chain reads | $0.003 | ETH / SOL / ERC-20 / SPL balances |
| Standard | $0.005 | spreads, search, pump.fun, stocks, crypto data, reference data |
| AI | $0.01 | web scraping, PDF scraping, LLM Q&A, image generation |
| Verification | $0.001–$0.01 | 54 validators: IBAN, VIN, ISBN, UPC/EAN, crypto addresses, Lightning invoices, email MX + disposable detection, password strength, domain RDAP, SSL, JWT, cron, smart-contract surface lint, and more |
| Alpha | $0.05 | whale watching, RugCheck audits, wallet portfolios |

## Endpoints

### On-chain data
| Endpoint | Price | What it returns |
|---|---|---|
| `GET /chain/balance?address=0x…` | $0.003 | Native ETH balance of a Base address |
| `GET /chain/erc20-balance?address=0x…&token=0x…` | $0.003 | ERC-20 token balance on Base (auto-detects decimals) |
| `GET /chain/block-number` | $0.001 | Current Base block number |
| `GET /chain/sol-balance?wallet=…` | $0.003 | Native SOL balance of a Solana wallet |
| `GET /chain/spl-balance?wallet=…&mint=…` | $0.003 | SPL token balances for a wallet and mint |
| `GET /chain/slot` | $0.001 | Current Solana slot |

### Trading & spreads — $0.005
- `GET /spread` — live SOL spreads across CEXs and DEXs, best buy/sell venues
- `GET /spread/base?token=0x…` — cross-DEX spreads on Base for any token (default WETH), up to 5 venues

### Alpha — $0.05
- `GET /whale-watch` — large-wallet movement alerts *(needs `HELIUS_API_KEY`)*
- `GET /solana/audit?mint=…` — RugCheck token safety audit
- `GET /wallet/portfolio?wallet=…` — wallet holdings breakdown *(needs `HELIUS_API_KEY`)*

### Verification — 54 endpoints
- `GET /verify/npi?npi=…` — $0.01 — validates a 10-digit NPI checksum + CMS NPPES registry data
- `GET /verify/dea?dea=…` — $0.005 — validates a DEA number format and checksum
- **Finance** ($0.005): `/verify/iban`, `/verify/routing`, `/verify/card`, `/verify/swift`, `/verify/isin`, `/verify/cusip`, `/verify/sedol`, `/verify/upi`
- **Identity** ($0.005): `/verify/vat`, `/verify/ein`, `/verify/lei`, `/verify/ssn`, `/verify/passport/mrz`, `/verify/nino`, `/verify/sin`
- **Retail & logistics** ($0.005): `/verify/upc`, `/verify/ean`, `/verify/isbn`, `/verify/vin`, `/verify/usps`, `/verify/ups`, `/verify/fedex`, `/verify/imei`, `/verify/meid`, `/verify/container`
- **Network**: `/verify/email` ($0.01, live MX lookup), `/verify/domain` ($0.005, RDAP), `/verify/ssl` ($0.005); ($0.001): `/verify/ipv4`, `/verify/ipv6`, `/verify/mac`, `/verify/asn`, `/verify/e164`, `/verify/email-disposable` (throwaway-domain blocklist), `/verify/dns` (A/MX/TXT/NS lookup)
- **Security**: `/verify/pwned` ($0.01, k-anonymity breach check); ($0.001): `/verify/jwt`, `/verify/base64`, `/verify/hash/md5`, `/verify/hash/sha256`, `/verify/uuid`, `/verify/ulid`, `/verify/password-strength` (0–4 score + crack-time estimate), `/verify/ssh-key` (OpenSSH public-key structure check), `/verify/url-malicious` (URLhaus malware feed: clean/malicious/unknown)
- **Crypto** ($0.001): `/verify/address/evm` (EIP-55), `/verify/address/solana`, `/verify/address/btc`, `/verify/address/polkadot`, `/verify/lightning` (BOLT11 invoice), `/verify/ens`, `/verify/contract` (smart-contract surface linter — flags `selfdestruct`, `delegatecall`, `tx.origin`, missing signer checks, etc.)
- **Dev** ($0.001): `/verify/semver`, `/verify/cron`, `/verify/json`

### Scraping & AI — $0.01
- `GET /scrape?url=…` — web page to text
- `GET /scrape/pdf?url=…` — PDF to text
- `GET /ai/ask?prompt=…` — LLM text response
- `GET /ai/image?prompt=…` — 1024×1024 generated image

### Search — $0.005
One query param (`?q=…`) across: `/search/npm`, `/search/wikipedia`, `/search/arxiv`, `/search/sec`, `/search/hn`, `/search/geo`, `/search/fda`, `/search/github`, `/lookup/pypi`

### pump.fun & memes — $0.005
`/pump/trending`, `/pump/new`, `/pump/migrating`, `/pump/chains`, `/meme/trending`, `/meme/new`, `/meme/token`

### Markets & crypto — $0.005
`/stocks/price`, `/stocks/list`, `/solana/top100`, `/crypto/prices`, `/crypto/ohlcv`, `/btc/fees`, `/defi/tvl`, `/defi/yields`, `/fx/rates`, `/fx/convert`, `/markets/polymarket`, `/finance/tickers`

### Reference data — $0.005
Weather, IP/zip/sun/elevation geo lookups, FBI/gov datasets, clinical trials, gene info, papers, quakes, ISS/SpaceX, StackOverflow, DNS, crates, definitions, books, holidays, TV, anime, lyrics, football, NHL, Bluesky users, food nutrition, remote jobs.

### Utilities — $0.001
- `GET /utils/base64?op=encode&text=…` — base64 encode/decode
- `GET /utils/hash?text=…` — cryptographic hash of input text
- `GET /utils/uuid` — random UUID v4 values
- `GET /utils/ip` — caller IP address
- `GET /utils/time` — current Unix timestamp + ISO 8601 time
- `GET /utils/text-diff?a=…&b=…` — line-based diff of two texts
- `GET /utils/qr?data=…&size=200` — QR-code image URL for any text
- `GET /utils/timezone?at=…&to=America/New_York` — convert a datetime between IANA timezones
- `GET /utils/md2html?md=…` — Markdown to HTML
- `GET /utils/html2md?html=…` — HTML to Markdown-ish plain text
- `GET /utils/csv2json?csv=…` — CSV to a JSON array of objects
- `GET /utils/json2csv?json=…` — JSON array of objects to CSV

## Key-gated endpoints

`/whale-watch` and `/wallet/portfolio` need a Helius API key and return `503` until `HELIUS_API_KEY` is set on the server. Everything else works with no keys.

## Deployment

Single-file Node.js server (`server.js`), currently on Render's free tier. Environment variables:

| Variable | Required | Enables |
|---|---|---|
| `HELIUS_API_KEY` | No | `/whale-watch`, `/wallet/portfolio` |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | Yes | x402 settlement via the Coinbase CDP facilitator |

Replacing `server.js` with a new version does not clear environment variables.

## Discovery

Indexed on [x402sc