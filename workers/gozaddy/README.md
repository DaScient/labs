# GoZaddy Worker (CORS + Generation)

## Endpoints
- `GET /health` → `{"ok":true,"ts":…}`
- `GET /cors?url=…` → Proxies target with permissive CORS.
- `POST /generate` → Body: `{ meta, text, perspectives[], min_words, max_words, temperature }`
  - Returns `{ ok:true, model, text }` (ASCII).

## Environment
- `OPENAI_API_KEY` (secret) — set via `wrangler secret put OPENAI_API_KEY`
- `ALLOWED_ORIGINS` (env var) — CSV, e.g. `https://dascient.com,https://dascient.github.io,https://*.godaddysites.com`
- `MODEL_PREFS` (env var) — e.g. `gpt-4.1-mini,gpt-4o-mini`
- `GOZADDY_KV` (KV) — optional for rate limiting.

## Deploy
```bash
wrangler kv:namespace create GOZADDY_KV
wrangler secret put OPENAI_API_KEY
wrangler publish

## Tests
```bash
curl -s https://<your-subdomain>.workers.dev/health
curl -s 'https://<your-subdomain>.workers.dev/cors?url=https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' | head
curl -sX POST https://<your-subdomain>.workers.dev/generate \
 -H 'content-type: application/json' \
 -d '{"meta":{"title":"Test","link":"https://example.com"},"text":"Sample about AI and markets.","perspectives":["Business Strategy"],"min_words":500,"max_words":900}'

---

# `dascient/labs/gozaddy/README.md`
Viewer notes.

```md
# GoZaddy ASCII Viewer (GitHub Pages)

- Minimal, ASCII-only output.
- Reads `feeds.txt` and `perspectives.txt` from this folder.
- Calls your Cloudflare Worker for CORS + AI generation.

## URL Parameters
- `corsBase` (required): your Worker origin. Example: `https://gozaddy.aristocles24.workers.dev`
- `feedsUrl` (default `/labs/gozaddy/feeds.txt`)
- `perspectivesUrl` (default `/labs/gozaddy/perspectives.txt`)
- `interval` (seconds, default `180`)

## Example URL
