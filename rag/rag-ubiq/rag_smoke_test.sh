#!/usr/bin/env bash
set -euo pipefail
# rag_smoke_test.sh - smoke tests for rag-ubiq worker
# Usage:
#   WORKER_URL="https://rag-ubiq.aristocles24.workers.dev" ./rag_smoke_test.sh
#
# Requirements: curl, jq, npx (wrangler), and wrangler configured with account_id in wrangler.toml.
# Ensure CLOUDFLARE_API_TOKEN or appropriate env is set if using wrangler CLI operations.

WORKER_URL="${WORKER_URL:-http://127.0.0.1:8787}"   # override when running
TMPDIR="$(mktemp -d)"
TEST_FILE="$TMPDIR/test-r2.txt"

echo "=== RAG Ubiq smoke test ==="
echo "Worker URL: $WORKER_URL"
echo

# 1) Landing
echo "1) Landing page..."
curl -sS "$WORKER_URL/" | sed -n '1,4p' || { echo "Landing page failed"; exit 2; }
echo "-> OK"
echo

# 2) Index a short test document (JSON)
echo "2) Indexing test document (POST /api/index)..."
INDEX_RESP=$(curl -sS -X POST "$WORKER_URL/api/index" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "SMOKE TEST DOC",
    "text": "RAG Ubiq testing. This short doc will be indexed for testing retrieval. Token: do not include secrets.",
    "url": "https://example.com/smoke",
    "tags": ["smoke","test"]
  }')
echo "$INDEX_RESP" | jq . || (echo "Invalid JSON response from index" && echo "$INDEX_RESP" && exit 3)
CHUNKS=$(echo "$INDEX_RESP" | jq -r '.chunks // 0')
SOURCE_ID=$(echo "$INDEX_RESP" | jq -r '.sourceId // empty')
echo "-> index response: chunks=$CHUNKS, sourceId=$SOURCE_ID"
if [ "$CHUNKS" -eq 0 ]; then
  echo "WARNING: 0 chunks created. Check worker logs or ensure embedding/vector upsert succeeded."
fi
echo

# 3) Small wait to allow vector upsert (embedding + index) to settle
echo "3) Wait 3 seconds for embedding/upsert to settle..."
sleep 3
echo

# 4) Query the index (POST /api/query)
echo "4) Querying (POST /api/query)..."
QUERY_RESP=$(curl -sS -X POST "$WORKER_URL/api/query" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is RAG Ubiq testing?",
    "top_k": 4,
    "temperature": 0.2
  }')
echo "$QUERY_RESP" | jq . || (echo "Invalid JSON from query:" && echo "$QUERY_RESP" && exit 4)
ANS=$(echo "$QUERY_RESP" | jq -r '.answer // empty')
SRCCOUNT=$(echo "$QUERY_RESP" | jq -r '.sources | length // 0')
echo "-> answer length: $(echo -n "$ANS" | wc -c) chars, sources returned: $SRCCOUNT"
if [ -z "$ANS" ]; then
  echo "WARNING: No answer returned. Check worker logs or confirm chunks > 0."
fi
echo

# 5) List sources (GET /api/sources)
echo "5) Listing sources..."
SOURCES=$(curl -sS "$WORKER_URL/api/sources")
echo "$SOURCES" | jq . || (echo "Invalid JSON from sources:" && echo "$SOURCES" && exit 5)
echo

# 6) Delete test source (cleanup)
if [ -n "$SOURCE_ID" ]; then
  echo "6) Deleting test source: $SOURCE_ID"
  DEL=$(curl -sS -X DELETE "$WORKER_URL/api/source?id=$(printf %s "$SOURCE_ID" | jq -sRr @uri)")
  echo "$DEL" | jq . || (echo "Delete returned invalid JSON:" && echo "$DEL" && exit 6)
  echo
else
  echo "6) No sourceId to delete (skipping)"
  echo
fi

# 7) R2 test using wrangler CLI (put/get) - optional (will run if npx wrangler exists)
if command -v npx >/dev/null 2>&1; then
  echo "7) R2 object put/get smoke test via wrangler (if configured)..."
  echo "-> Creating test file..."
  echo "hello rag-ubiq $(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$TEST_FILE"
  # NOTE: wrangler r2 object put/get uses account_id in wrangler.toml; ensure wrangler configured.
  set +e
  npx wrangler r2 object put rag-ubiq-docs test/smoke-test.txt "$TEST_FILE" >/dev/null 2>&1
  PUT_RC=$?
  if [ $PUT_RC -eq 0 ]; then
    echo "-> R2 put: OK"
    OUT=$(npx wrangler r2 object get rag-ubiq-docs test/smoke-test.txt 2>/dev/null)
    if echo "$OUT" | grep -q "hello rag-ubiq"; then
      echo "-> R2 get: OK, content preview:"
      echo "$OUT" | sed -n '1,3p'
    else
      echo "-> R2 get did not return expected content; check permissions."
    fi
  else
    echo "-> npx wrangler r2 put failed (rc=$PUT_RC). This may be a permissions or config issue. Skipping R2 read test."
  fi
  set -e
  echo
else
  echo "7) Skipping R2 CLI test: npx not found in PATH."
  echo
fi

# 8) KV quick list (optional)
if command -v npx >/dev/null 2>&1; then
  echo "8) KV namespaces (via wrangler)..."
  set +e
  npx wrangler kv namespace list >/dev/null 2>&1
  KV_RC=$?
  if [ $KV_RC -eq 0 ]; then
    npx wrangler kv namespace list
  else
    echo "-> wrangler kv namespace list failed (rc=$KV_RC). Check token permissions."
  fi
  set -e
  echo
else
  echo "8) Skipping KV test: npx not found."
  echo
fi

# 9) Vectorize index status (optional; wrangler support)
if command -v npx >/dev/null 2>&1; then
  echo "9) Vectorize index list (via wrangler) - optional"
  set +e
  npx wrangler vectorize list >/dev/null 2>&1
  VEC_RC=$?
  if [ $VEC_RC -eq 0 ]; then
    npx wrangler vectorize list
  else
    echo "-> vectorize list failed (rc=$VEC_RC). If unsupported, ignore."
  fi
  set -e
  echo
else
  echo "9) Skipping vectorize CLI check: npx not found."
  echo
fi

echo "=== SMOKE TEST COMPLETE ==="
rm -rf "$TMPDIR"
