# DASCIENT — Momentum-Sentiment Algorithm™ Dashboard (Lite)

A tiny, colorful dashboard that shows **Price**, **Price Target**, **Buy/Sell/Hold**, and **Options (ATM Calls/Puts + simple Bull Call spread)** for any list of tickers.

## What’s inside
- `index.html` – standalone page for your `dascient.github.io` site.
- `assets/styles.css` – minimal styling.
- `assets/app.js` – calls your Cloudflare Worker APIs and renders the table.
- `cloudflare/worker.js` – Cloudflare Worker that fetches data from Yahoo Finance public endpoints and returns clean JSON.
- `cloudflare/wrangler.toml` – optional file for CLI deploy with Wrangler.
- `godaddy_embed.html` – drop-in HTML block for GoDaddy Website Builder pages.

## How it works
- The **Cloudflare Worker** exposes endpoints:
  - `/api/summary?symbol=AAPL` → price, targetMeanPrice, recommendationKey
  - `/api/options?symbol=AAPL` → nearest-expiry ATM call/put mid-prices and a 1-step bull call spread
- The **front-end** (GitHub Pages or GoDaddy embed) calls your Worker and renders a single compact table.

> The Buy/Sell/Hold tag is derived from Yahoo’s `recommendationKey` when present, falling back to a simple target-vs-price rule.

## Deploy in 3 steps

### 1) Deploy the Cloudflare Worker (Free plan OK)
**Option A: Cloudflare Dashboard (no CLI)**
1. Log in to Cloudflare → Workers & Pages → **Create** → **Worker**.
2. Paste the contents of `cloudflare/worker.js` and **Deploy**.
3. Note your Worker URL, e.g. `https://your-worker-subdomain.workers.dev`.

**Option B: Wrangler CLI**
```bash
cd cloudflare
# Install wrangler if needed
# npm install -g wrangler
wrangler deploy
```
This uses `wrangler.toml` and uploads `worker.js`.

### 2) Publish the front-end to GitHub Pages
1. Create/Update your repo `dascient.github.io`.
2. Copy **index.html**, **assets/** into the root of that repo and push.
3. Visit `https://dascient.github.io/` to confirm it renders.

### 3) Connect Cloudflare (Free) to GitHub Pages
- In Cloudflare DNS, point your desired subdomain (e.g. `dash.dascient.com`) via a CNAME to `dascient.github.io`.
- Enable **Proxy (orange cloud)** for CDN, caching, and TLS.
- (Optional) Use a **Page Rule** to always cache HTML for a short time.

## Configure symbols & API
- Open the page and set **Symbols** (e.g., `AAPL,MSFT,NVDA,SPY`) and **API Base** to your Worker URL, then click **Load**.
- For GoDaddy, paste **godaddy_embed.html** into an HTML block, update the `API` field in-page, and click **Load**.

## Notes
- Data comes from Yahoo Finance public endpoints; availability may vary. Use for demonstration/education.
- You can expand the Worker to compute more strategies (credit spreads, iron condors) using the same pattern.

## Files overview
```
/index.html
/assets/styles.css
/assets/app.js
/cloudflare/worker.js
/cloudflare/wrangler.toml
/godaddy_embed.html
```
