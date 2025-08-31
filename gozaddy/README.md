# GoZaddy — AI News Summaries

## 1) Deploy the Cloudflare Worker
- Files: `/gozaddy/worker.js`
- In Cloudflare Dashboard (or `wrangler`), create a Worker and paste `worker.js`.
- (Optional) Add secret: **OPENAI_API_KEY** (Settings → Variables → Add Secret).
- Set a public URL, e.g. `https://gozaddy.<your-subdomain>.workers.dev`.

### Endpoints
- `GET /summaries?feeds=<csv>&limit=25&interval=3600` → JSON
- `GET /ascii?feeds=<csv>&limit=25&interval=3600` → Plain text
- `GET /health` → `{ ok: true }`

> The Worker caches responses for `interval` seconds via Cloudflare Cache.  
> It always returns CORS headers (`Access-Control-Allow-Origin: *`).

## 2) Host the Frontends (GitHub Pages or Cloudflare Pages)
- Put `/labs/index.html` and `/labs/analytics.html` in your repo (e.g., `dascient/labs`).
- If using GitHub Pages: `https://dascient.github.io/labs/`
- If using Cloudflare Pages: your Pages URL.

### Configure feeds
- Edit `/labs/configs/feeds.txt` (optional — frontends can also pass feeds via `?feeds=url1,url2`).

## 3) Use the UIs

### Summaries UI
- `https://<your-pages>/labs/index.html`
- Options:
  - `?feeds=url1,url2` (CSV), defaults to curated set
  - `?refresh=60000` (ms)

### Analytics UI
- `https://<your-pages>/labs/analytics.html`
- Options:
  - `?feeds=url1,url2`
  - `?refresh=90000` (ms)
  - `?window=6` (hours)

## 4) GoDaddy embed (Website Builder)
**HTML block → paste:**
```html
<!-- Summaries -->
<iframe src="https://dascient.github.io/labs/index.html?refresh=60000"
        style="width:100%;min-height:1200px;border:0;background:transparent" loading="lazy"></iframe>

<!-- Analytics -->
<iframe src="https://dascient.github.io/labs/analytics.html?window=6&refresh=90000"
        style="width:100%;min-height:1200px;border:0;background:transparent" loading="lazy"></iframe>
