# server/main.py
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
import os, json, httpx, asyncio

app = FastAPI()
MODEL = os.getenv("MODEL_ID", "mistralai/Mistral-7B-Instruct-v0.2")  # choose a model you have access to
HF_TOKEN = os.getenv("HF_TOKEN")  # optional
# If you run TGI/vLLM yourself, set TGI_BASE like http://localhost:8080
TGI_BASE = os.getenv("TGI_BASE")  # optional

SYSTEM_DEFAULT = (
  "You are an energy analyst. Use verifiable facts. "
  "When citing, reference EIA series names and FERC docket/accession numbers. "
  "Avoid unsafe field instructions."
)

async def generate_stream(prompt: str):
  """Stream tokens via TGI or HF Inference streaming if available; else yield once."""
  if TGI_BASE:
    # TGI streaming
    async with httpx.AsyncClient(timeout=60) as client:
      async with client.stream("POST", f"{TGI_BASE}/generate_stream",
                               json={"inputs": prompt, "parameters": {"temperature": 0.2}}) as r:
        async for line in r.aiter_lines():
          if not line: continue
          try:
            obj = json.loads(line)
            if "token" in obj and "text" in obj["token"]:
              yield f"data: {json.dumps({'delta': obj['token']['text']})}\n\n"
          except Exception:
            continue
    return
  # HF Inference (non-stream JSON) fallback
  if HF_TOKEN:
    async with httpx.AsyncClient(timeout=60) as client:
      r = await client.post(
        f"https://api-inference.huggingface.co/models/{MODEL}",
        headers={"Authorization": f"Bearer {HF_TOKEN}"},
        json={"inputs": prompt, "parameters": {"temperature": 0.2}}
      )
      text = r.json()[0]["generated_text"] if r.headers.get("content-type","").startswith("application/json") else await r.text()
      yield f"data: {json.dumps({'delta': text})}\n\n"
      return
  # Last resort: echo
  yield f"data: {json.dumps({'delta': 'RAG backend is up. Plug a model to replace this.'})}\n\n"

def build_prompt(body: dict, context_text: str = "") -> str:
  system = body.get("system") or SYSTEM_DEFAULT
  q = body.get("question","")
  state = body.get("state","")
  ctx = body.get("context") or {}
  header = f"[SYSTEM]\n{system}\n\n[CONTEXT]\n{context_text}\n\n[USER]\nState: {state}\nPersona: {ctx.get('persona','')}\nRegion: {ctx.get('region','')}\nQuestion: {q}\n\n[ASSISTANT]\n"
  return header

@app.post("/chat")
async def chat(request: Request):
  body = await request.json()
  question = body.get("question")
  if not question:
    return JSONResponse({"error": "missing 'question'"}, status_code=400)

  # TODO: plug your Qdrant retrieval here and put text into context_text
  context_text = ""  # e.g., concatenated top-k passages with citations

  prompt = build_prompt(body, context_text)

  # SSE if client wants streaming or if TGI_BASE is set
  wants_stream = body.get("stream") is True or TGI_BASE is not None
  if wants_stream:
    async def sse_iter():
      async for chunk in generate_stream(prompt):
        yield chunk
    headers = {"content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache"}
    return StreamingResponse(sse_iter(), headers=headers)

  # Non-stream JSON response (single shot)
  text_chunks = []
  async for chunk in generate_stream(prompt):
    try:
      data = json.loads(chunk[len("data: "):])  # {"delta": "..."}
      text_chunks.append(data.get("delta",""))
    except Exception:
      pass
  answer = "".join(text_chunks).strip() or "Backend responded but no content was produced."
  return JSONResponse({"answer": answer, "sources": []})
