# RoboVet AI Relay (rv_robovet_relay)

Server-side relay for RoboVet. Holds your OpenAI key, adds safety system prompt, enforces CORS, and (optionally) streams SSE.

## Endpoints
- `GET /api/ping` → healthcheck
- `POST /api/ai` → `{ model?, messages: [{role,content}], system?, stream? }`
  - returns `{ text }` (JSON) unless `stream=true|1` → SSE passthrough
- `POST /api/moderate` → `{ input }` → `{ ok, flagged, results }` (optional)

## Local dev

```bash
cd cloudflare/rv_robovet_relay
# put temp dev values in .dev.vars (OPENAI_API_KEY etc.)
wrangler dev --config wrangler.rv.toml
# open http://127.0.0.1:8787/api/ping
