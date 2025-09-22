#!/usr/bin/env bash
# check-worker.sh — Health check & smoke tests for your Cloudflare Worker
# Usage:
#   ./check-worker.sh --host https://robovet-ai.aristocles24.workers.dev \
#                     --token "$ROBO_VET_APP_TOKEN" \
#                     [--model gpt-4o-mini] [--hf]

set -euo pipefail

HOST=""
TOKEN="${ROBO_VET_APP_TOKEN:-}"
MODEL="gpt-4o-mini"
DO_HF=false

# Arg parser
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --hf) DO_HF=true; shift;;
    -h|--help) sed -n '1,20p' "$0"; exit 0;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "❌ Missing --host. Example:"
  echo "   ./check-worker.sh --host https://robovet-ai.aristocles24.workers.dev"
  exit 1
fi

divider() { printf "\n──────────────────────────────────────────────\n"; }

echo "🔍 RoboVet Worker Health Report"
echo "Host: $HOST"
echo "Time: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
divider

# 1) Secrets (if wrangler is available)
if command -v npx >/dev/null 2>&1; then
  echo "Secrets (wrangler):"
  if npx --yes wrangler secret list >/dev/null 2>&1; then
    npx --yes wrangler secret list | sed 's/^/  /'
  else
    echo "  (wrangler found but 'secret list' failed — wrong dir or not logged in)"
  fi
else
  echo "Secrets: wrangler not installed"
fi
divider

# 2) Health endpoint
HEALTH_URL="${HOST%/}/v1/health"
echo "GET $HEALTH_URL"
HEALTH_RESP=$(curl -sS -i "$HEALTH_URL" || true)
echo "$HEALTH_RESP" | head -n 10 | sed 's/^/  /'
divider

# 3) Completions smoke test
COMP_URL="${HOST%/}/v1/robovet/completions"
echo "POST $COMP_URL"
if [[ -z "${TOKEN:-}" ]]; then
  echo "  ❌ Missing token. Provide --token or export ROBO_VET_APP_TOKEN"
  exit 2
fi

REQ='{"model":"'"$MODEL"'","messages":[{"role":"user","content":"hello from check-worker.sh"}],"stream":false}'
COMP_RESP=$(curl -sS -i "$COMP_URL" \
  -H "x-robovet-token: $TOKEN" \
  -H "content-type: application/json" \
  -d "$REQ" || true)
echo "$COMP_RESP" | head -n 20 | sed 's/^/  /'
divider

# 4) Optional Hugging Face test
if $DO_HF; then
  HF_URL="${HOST%/}/v1/robovet/hf-generate"
  echo "POST $HF_URL"
  HF_REQ='{"endpointUrl":"https://api-inference.huggingface.co/models/facebook/bart-large-mnli","inputs":"Sick puppy ate dark chocolate","parameters":{}}'
  HF_RESP=$(curl -sS -i "$HF_URL" \
    -H "x-robovet-token: $TOKEN" \
    -H "content-type: application/json" \
    -d "$HF_REQ" || true)
  echo "$HF_RESP" | head -n 20 | sed 's/^/  /'
  divider
fi

echo "✅ Done."
