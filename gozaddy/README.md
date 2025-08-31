# GoZaddy / DaScient — News Summaries Worker

## Deploy

```bash
cd gozaddy
# one-time:
wrangler login
wrangler secret put OPENAI_API_KEY   # paste your key
# optional fixed model:
# wrangler kv:namespace create GZ_CACHE   # (not used in current version)
wrangler deploy
