# Crypto Dashboard API

Cloudflare Worker providing crypto summaries via Binance + Finnhub.

## Endpoints

- `/api/ping` — check provider status
- `/api/diag` — see if env vars are present
- `/api/selftest` — quick BTC/USDT check
- `/api/summary?symbol=BTC/USDT` — one symbol
- `/api/summary-batch?symbols=BTC/USDT,ETH/USDT` — multiple

## Provider Override

Add `&provider=finnhub` or `&provider=binance` to force one provider.

## Deploy

```bash
npx wrangler deploy
