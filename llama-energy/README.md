# LLaMA‑Energy Web Package

## Structure
- `labs/llama-energy/` — Static site for GitHub Pages (index.html, app.js, styles.css)
- `worker/` — Cloudflare Worker backend (proxy EIA + optional RAG proxy)
- `server/` — Optional FastAPI service for RAG / custom APIs (Dockerfile included)
- `.github/workflows/` — CI for Pages and Worker

## Quick Start
1) **GitHub Pages**
- Commit this folder structure into `dascient.github.io` repo.
- URL: https://dascient.github.io/labs/llama-energy/

2) **Cloudflare Worker**
- `cd worker`
- `wrangler secret put EIA_API_KEY`
- Edit `wrangler.toml` with your `account_id` and optional routes.
- `npx wrangler deploy`

3) **Front → Worker wiring**
- Configure Cloudflare route so `/api/*` maps to the worker for your domain.
- Alternatively change `app.js` to point to the workers.dev URL.

4) **Optional Python API**
- `docker build -t llama-energy-api .`
- `docker run -p 8000:8000 -e EIA_API_KEY=$EIA_API_KEY llama-energy-api`
- Set `RAG_ORIGIN=http://localhost:8000` in `worker/wrangler.toml` if you add /api/rag proxying.

## GPU Notes
- Workers are JS-only. Serve models from `server/` on a GPU node (CUDA/ROCm/MPS).
