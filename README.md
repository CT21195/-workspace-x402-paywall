# Spread Paywall API

**149 pay-per-call API endpoints, monetized with x402 v2.** No API keys, no accounts, no signups — callers pay per request in USDC and get JSON back.

**Live:** https://workspace-x402-paywall.onrender.com
**Machine-readable:** [/openapi.json](https://workspace-x402-paywall.onrender.com/openapi.json) · [/llms.txt](https://workspace-x402-paywall.onrender.com/llms.txt) · [/.well-known/x402.json](https://workspace-x402-paywall.onrender.com/.well-known/x402.json)

## How it works

Every paid endpoint returns **HTTP 402** with payment terms when called unpaid: x402 v2, `exact` scheme, paid with an EIP-3009 `TransferWithAuthorization` in USDC. A facilitator settles on-chain, so the payer's wallet only signs — **no gas needed**. Pay, retry the same request, get `200` with JSON.

- **Pay on Base:** USDC → `0xD7CDd563e8F6A249B076A702b7e2C233CCF3481d`
- **Pay on Solana:** USDC → `E21AWkUtLz4BP7AaT82CF7v86Kmv4YzN4NAR1FQnEmqy`

Also listed on **RapidAPI** (6 listings, card billing) for buyers who don't use x402.

## Pricing

| Tier | Price (USDC) | Covers |
|---|---|---|
| Utility | $0.001 | UUIDs, hashing, base64, IP/time, block height, slot, converters, format validators |
| Chain reads | $0.003 | ETH / SOL / ERC-20 / SPL balances |
| Standard | $0.005 | Spreads, search, market data, stocks, reference data, most validators |
| AI | $0.01 | Web scraping, PDF extraction, LLM Q&A, image generation, email/pwned checks |
| Alpha | $0.05 | Whale watching, RugCheck token audits, wallet portfolios |

## Endpoints

### AI (3)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /ai/ask` | $0.005 | Ask an LLM anything: sends a text prompt and returns the generated answer as text - general-purpose inference (reasoning, drafting, summarization, Q&A) for agents without their own model key |
| `GET /ai/image` | $0.01 | Generates a 1024x1024 image from a text description and returns a ready-to-use image URL - illustrations, thumbnails and visual assets on demand |
| `GET /ai/models` | $0.001 | Returns a JSON array of the AI models this API can serve (live from the upstream provider), each with name, description and capabilities |

### AI Data (2)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /scrape` | $0.01 | Fetches any public URL and returns the page content as clean Markdown text - for agents that need to read articles, docs and web pages without browser tooling |
| `GET /scrape/pdf` | $0.01 | Fetches a PDF from a URL and returns the extracted text as a string in a JSON object, capped at 50,000 characters |

### Chain Data (6)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /chain/balance` | $0.003 | Returns a JSON object with the native ETH balance of a Base address |
| `GET /chain/block-number` | $0.001 | Returns a JSON object with the current Base block number |
| `GET /chain/erc20-balance` | $0.003 | Returns a JSON object with the ERC-20 token balance of a Base address |
| `GET /chain/slot` | $0.001 | Returns a JSON object with the current Solana slot |
| `GET /chain/sol-balance` | $0.003 | Returns a JSON object with the native SOL balance of a Solana wallet |
| `GET /chain/spl-balance` | $0.003 | Returns a JSON object with SPL token balances for a Solana wallet and mint |

### Crypto (6)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /btc/fees` | $0.005 | Returns a JSON object with current Bitcoin network fee estimates in satoshis per vByte |
| `GET /crypto/ohlcv` | $0.005 | Returns a JSON array of OHLCV candlestick data for a cryptocurrency symbol |
| `GET /crypto/prices` | $0.005 | Returns a JSON array of top cryptocurrencies by market cap with USD prices |
| `GET /solana/audit` | $0.05 | Audits a Solana token for rug-pull risk: RugCheck risk score, risk level and the specific risk findings - for agents screening tokens before trading |
| `GET /wallet/portfolio` | $0.05 | Returns a JSON object with native SOL balance and an array of SPL token balances for a Solana wallet |
| `GET /whale-watch` | $0.05 | Returns a JSON array of recent token swap transactions for a Solana wallet address |

### Data (2)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /spread` | $0.005 | Live SOL prices from the top 5 centralized exchanges and top 5 Solana DEXs with the widest bid-ask spread, in gross and estimated net basis points - for arbitrage screening, price discovery and execution checks |
| `GET /spread/base` | $0.005 | Returns a JSON object with live cross-DEX spreads on Base for a token (default WETH), plus the widest spread detected |

### DeFi (2)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /defi/tvl` | $0.005 | Returns a JSON array of total value locked figures across 468 blockchain chains |
| `GET /defi/yields` | $0.005 | Returns a JSON array of top DeFi yield pools sorted by APY percentage |

### Dev (3)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /dev/crates` | $0.005 | Returns a JSON object with metadata, version, and download count for a Rust crate name |
| `GET /dev/dns` | $0.005 | Returns a JSON object with DNS records for a domain name string via Google DNS-over-HTTPS |
| `GET /dev/stackoverflow` | $0.005 | Returns a JSON array of Stack Overflow questions matching the query with titles and scores |

### FX (2)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /fx/convert` | $0.005 | Converts a numeric amount between two ISO currency codes and returns a JSON object with the converted value |
| `GET /fx/rates` | $0.005 | Returns a JSON object with current European Central Bank foreign exchange rates |

### Finance (1)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /finance/tickers` | $0.005 | Returns a JSON array of all US public company ticker symbols with CIK numbers |

### Food (1)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /food/search` | $0.005 | Returns a JSON object with nutritional data (calories, macros) for a food name string |

### Fun (3)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /fun/anime` | $0.005 | Returns a JSON array of anime titles matching the query with scores and episode counts |
| `GET /fun/lyrics` | $0.005 | Returns a JSON object with song lyrics text for an artist and title string |
| `GET /fun/tv` | $0.005 | Returns a JSON array of TV shows matching the query with names, ratings, and premiere dates |

### Geo (4)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /geo/elevation` | $0.005 | Returns a JSON object with elevation in meters for latitude/longitude coordinates |
| `GET /geo/ip` | $0.005 | Returns a JSON object with city, country, latitude, and longitude for an IPv4 or IPv6 address string |
| `GET /geo/sun` | $0.005 | Returns a JSON object with sunrise and sunset times as ISO 8601 strings for given coordinates |
| `GET /geo/zip` | $0.005 | Returns a JSON object with city name, latitude, and longitude for a postal code string |

### Government (3)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /gov/datasets` | $0.005 | Returns a JSON array of US government datasets matching the query string |
| `GET /gov/fbi` | $0.005 | Returns a JSON array of FBI wanted persons with names, charges, and descriptions |
| `GET /gov/federal-register` | $0.005 | Returns a JSON array of recent US federal register documents with titles and dates |

### Health (2)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /health/gene` | $0.005 | Returns a JSON object with gene annotations and identifiers for a gene symbol string |
| `GET /health/trials` | $0.005 | Returns a JSON array of clinical trials matching the query with phase, status, and conditions |

### Jobs (1)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /jobs/remote` | $0.005 | Returns a JSON array of remote job listings with titles, companies, and locations |

### Markets (1)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /markets/polymarket` | $0.005 | Returns a JSON array of live Polymarket prediction market events with odds and volume |

### Meme Data (3)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /meme/new` | $0.005 | Returns a JSON array of newly launched meme tokens on the specified chain or all chains |
| `GET /meme/token` | $0.005 | Returns a JSON object with price, volume, and liquidity data for a token contract address |
| `GET /meme/trending` | $0.005 | Returns a JSON array of trending meme coin liquidity pools on the specified chain |

### Pump.fun (4)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /pump/chains` | $0.005 | Returns a JSON array of 100+ supported blockchain chain identifiers for meme token endpoints |
| `GET /pump/migrating` | $0.005 | Returns a JSON array of pump.fun tokens approaching Raydium migration threshold, sorted by migration progress percentage |
| `GET /pump/new` | $0.005 | Returns a JSON array of newly launched meme tokens with price and market cap data |
| `GET /pump/trending` | $0.005 | Returns a JSON array of trending meme coin liquidity pools on the specified chain |

### Reference (3)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /ref/books` | $0.005 | Returns a JSON array of books matching the query with titles, authors, and publish years |
| `GET /ref/define` | $0.005 | Returns a JSON array of dictionary definitions for an English word string |
| `GET /ref/holidays` | $0.005 | Returns a JSON array of public holidays for an ISO country code and year integer |

### Science (2)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /science/papers` | $0.005 | Returns a JSON array of scholarly papers matching the query with titles, authors, and DOIs |
| `GET /science/quakes` | $0.005 | Returns a JSON array of recent earthquakes with magnitude, location, and timestamp from USGS |

### Search (9)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /lookup/pypi` | $0.005 | Returns a JSON object with metadata for a PyPI package name |
| `GET /search/arxiv` | $0.005 | Returns a JSON array of arXiv papers matching the query string |
| `GET /search/fda` | $0.005 | Returns a JSON array of FDA drug labels matching the query string |
| `GET /search/geo` | $0.005 | Converts a street address string to a JSON object with latitude, longitude, and formatted address via OpenStreetMap |
| `GET /search/github` | $0.005 | Returns a JSON array of GitHub repositories, code, users, or issues matching the query |
| `GET /search/hn` | $0.005 | Returns a JSON array of Hacker News posts matching the query string |
| `GET /search/npm` | $0.005 | Returns a JSON array of npm packages matching the query string |
| `GET /search/sec` | $0.005 | Returns a JSON array of SEC EDGAR filings matching the query string |
| `GET /search/wikipedia` | $0.005 | Returns a JSON array of Wikipedia articles matching the query string |

### Social (1)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /social/bluesky` | $0.005 | Returns a JSON array of Bluesky social users matching the query with handles and bios |

### Solana (1)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /solana/top100` | $0.005 | Returns a JSON array of the top 100 Solana tokens by market cap with prices in USD and SOL |

### Space (2)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /space/iss` | $0.005 | Returns a JSON object with the current latitude and longitude of the International Space Station |
| `GET /space/spacex` | $0.005 | Returns a JSON object with details of the most recent SpaceX launch |

### Sports (2)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /sports/football` | $0.005 | Returns a JSON array of German Bundesliga football matches with scores and dates |
| `GET /sports/nhl` | $0.005 | Returns a JSON array of NHL team standings with wins, losses, and points |

### Stocks (2)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /stocks/list` | $0.005 | Returns a JSON array of tokenized stocks with live prices |
| `GET /stocks/price` | $0.005 | Returns a JSON object with live price quote for a tokenized stock symbol |

### Utilities (18)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /ping` | $0.001 | Health check endpoint for x402 payment flow testing: returns a JSON object with service status and the current server timestamp |
| `GET /utils/base64` | $0.001 | Encodes text to base64 or decodes base64 to text, returns a JSON object with the result string |
| `GET /utils/cron-explain` | $0.001 | Explains a 5-field cron expression field by field in plain language |
| `GET /utils/csv2json` | $0.001 | Converts CSV to a JSON array of objects |
| `GET /utils/hash` | $0.001 | Computes a cryptographic hash of input text, returns a JSON object with the hex digest string |
| `GET /utils/html2md` | $0.001 | Converts HTML to Markdown-ish plain text |
| `GET /utils/ip` | $0.001 | Returns a JSON object with the caller IP address as a string |
| `GET /utils/json-validate` | $0.001 | Validates JSON syntax and optionally checks it against a JSON Schema subset |
| `GET /utils/json2csv` | $0.001 | Converts a JSON array of objects to CSV |
| `GET /utils/jwt-decode` | $0.001 | Decodes a JWT header and payload (signature not verified) |
| `GET /utils/md2html` | $0.001 | Converts Markdown to HTML |
| `GET /utils/password-generator` | $0.001 | Generates a cryptographically random password |
| `GET /utils/qr` | $0.001 | Builds a QR-code image URL for the given text (free provider, properly encoded) |
| `GET /utils/text-diff` | $0.001 | Line-based diff of two texts with added/removed counts and hunks |
| `GET /utils/time` | $0.001 | Returns a JSON object with the current Unix timestamp integer and ISO 8601 time string |
| `GET /utils/timezone` | $0.001 | Converts a datetime between IANA timezones |
| `GET /utils/uuid` | $0.001 | Generates random UUID v4 values, returns a JSON array of UUID strings |
| `GET /utils/xml2json` | $0.001 | Converts an XML document to JSON (dependency-free parser) |

### Verification (59)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /verify/address/btc` | $0.001 | Validates Bitcoin P2PKH/P2SH/bech32 addresses |
| `GET /verify/address/evm` | $0.001 | Validates an EVM address and its EIP-55 checksum |
| `GET /verify/address/polkadot` | $0.001 | Validates a Polkadot/Substrate ss58 address checksum |
| `GET /verify/address/solana` | $0.001 | Validates a Solana address (base58, 32 bytes) |
| `GET /verify/asn` | $0.001 | Validates an Autonomous System Number and reports scope |
| `GET /verify/base64` | $0.001 | Strictly validates base64/base64url encoding structure |
| `GET /verify/card` | $0.005 | Validates a card number Luhn checksum and detects the brand (format check only) |
| `GET /verify/container` | $0.005 | Validates an ISO 6346 shipping container code check digit |
| `GET /verify/contract` | $0.001 | Surface-level smart-contract linter: flags dangerous Solidity/Rust patterns (selfdestruct, delegatecall, tx.origin, unsafe blocks, missing signer checks) |
| `GET /verify/cron` | $0.001 | Validates a cron expression and computes the next run time |
| `GET /verify/cusip` | $0.005 | Validates a CUSIP securities identifier checksum |
| `GET /verify/dea` | $0.005 | Validates a DEA number format and checksum, returns a JSON object with validation result |
| `GET /verify/dns` | $0.001 | Returns DNS records (A/NS/MX/TXT) for a domain via DNS-over-HTTPS |
| `GET /verify/domain` | $0.005 | Returns RDAP registration status, age, expiry, and registrar for a domain |
| `GET /verify/e164` | $0.001 | Validates E.164 international phone number formatting |
| `GET /verify/ean` | $0.005 | Validates EAN-13/EAN-8 barcode checksums |
| `GET /verify/ein` | $0.005 | Validates a US EIN format and IRS prefix |
| `GET /verify/email` | $0.01 | Validates email syntax and live MX records via DNS-over-HTTPS |
| `GET /verify/email-disposable` | $0.001 | Checks whether an email domain is a known disposable/throwaway provider |
| `GET /verify/ens` | $0.001 | Validates an ENS name against EIP-137 normalization rules |
| `GET /verify/fedex` | $0.005 | Validates FedEx tracking number structure (12/15/20/22 digits; checksum not published by FedEx) |
| `GET /verify/hash/md5` | $0.001 | Validates a 32-char MD5 hex digest format |
| `GET /verify/hash/sha256` | $0.001 | Validates a 64-char SHA-256 hex digest format |
| `GET /verify/iban` | $0.005 | Validates an IBAN checksum (ISO 13616 mod-97) and parses country/bank codes |
| `GET /verify/imei` | $0.005 | Validates a device IMEI Luhn checksum |
| `GET /verify/ipv4` | $0.001 | Validates IPv4 format and classifies the address range |
| `GET /verify/ipv6` | $0.001 | Validates IPv6 format and classifies the address range |
| `GET /verify/isbn` | $0.005 | Validates ISBN-10/ISBN-13 checksums |
| `GET /verify/isin` | $0.005 | Validates an ISIN securities identifier checksum |
| `GET /verify/issn` | $0.001 | Validates an ISSN check digit (ISO 3297) |
| `GET /verify/json` | $0.001 | Strictly validates JSON and pinpoints syntax errors |
| `GET /verify/jwt` | $0.001 | Structurally decodes a JWT header/payload and checks expiry (no signature verify) |
| `GET /verify/lei` | $0.005 | Validates a Legal Entity Identifier (ISO 17442 mod-97) |
| `GET /verify/lightning` | $0.001 | Validates a BOLT11 Lightning invoice: bech32 checksum, network, amount, timestamp and tagged fields |
| `GET /verify/mac` | $0.001 | Validates a MAC address and parses OUI/multicast bits |
| `GET /verify/meid` | $0.005 | Validates a device MEID hex format and check digit |
| `GET /verify/nino` | $0.005 | Validates a UK National Insurance number format and prefix rules |
| `GET /verify/npi` | $0.01 | Validates a 10-digit NPI number checksum and returns a JSON object with validation result plus CMS NPPES registry enrichment data |
| `GET /verify/orcid` | $0.001 | Validates an ORCID iD checksum (ISO 7064 MOD 11-2) |
| `GET /verify/passport/mrz` | $0.005 | Validates passport MRZ check digits (ICAO 9303, 2x44 chars) |
| `GET /verify/password-strength` | $0.001 | Scores password strength 0-4 with crack-time estimate and feedback (password never echoed back) |
| `GET /verify/pwned` | $0.01 | Checks a password against breach data via HIBP k-anonymity (never sent in full) |
| `GET /verify/routing` | $0.005 | Validates a US bank routing number (ABA) checksum |
| `GET /verify/sedol` | $0.005 | Validates a SEDOL (UK securities) checksum |
| `GET /verify/semver` | $0.001 | Validates Semantic Versioning 2.0.0 format |
| `GET /verify/sin` | $0.005 | Validates a Canadian SIN Luhn checksum |
| `GET /verify/ssh-key` | $0.001 | Validates an OpenSSH public key structure and reports algorithm/bit length (key is never echoed) |
| `GET /verify/ssl` | $0.005 | Fetches a domain TLS certificate and reports validity window and expiry |
| `GET /verify/ssn` | $0.005 | Validates a US SSN format against impossible SSA combinations (format only) |
| `GET /verify/swift` | $0.005 | Validates a SWIFT/BIC code structure and parses bank/country/branch |
| `GET /verify/ulid` | $0.001 | Validates ULID format and extracts its timestamp |
| `GET /verify/upc` | $0.005 | Validates UPC-A/UPC-E barcode checksums |
| `GET /verify/upi` | $0.005 | Validates a UPI ID format (India, handle@bank) |
| `GET /verify/ups` | $0.005 | Validates a UPS tracking number (1Z) check digit |
| `GET /verify/url-malicious` | $0.001 | Checks a URL/host against the URLhaus malware feed: clean, malicious, or unknown |
| `GET /verify/usps` | $0.005 | Validates a USPS tracking number checksum |
| `GET /verify/uuid` | $0.001 | Validates UUID structure and detects the version |
| `GET /verify/vat` | $0.005 | Validates an EU/GB VAT number format per country rules |
| `GET /verify/vin` | $0.005 | Validates a VIN check digit and decodes year/plant |

### Weather (1)

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /weather/current` | $0.005 | Returns a JSON object with current weather conditions and forecast for a location |

## Notes

- All endpoints are **keyless** — payment is the only auth.
- Responses are JSON. Errors return `400` (missing/invalid parameter), `402` (unpaid), or `502` (upstream failure).
- `HEAD` requests to paid endpoints return `405`.
- Contact: ctiernan21@gmail.com
