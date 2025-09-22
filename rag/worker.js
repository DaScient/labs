// worker.js
// A dependency-free Cloudflare Worker implementing a compact, production-grade RAG API.
// Endpoints:
//   POST /api/index       -> { sourceId?, title?, text?, url?, tags? } OR multipart/form-data with files
//   POST /api/query       -> { query, top_k?, temperature?, max_tokens? }
//   GET  /api/sources     -> list sources
//   DELETE /api/source?id -> delete a single source (and its vectors)
//   OPTIONS /*            -> CORS preflight

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname, origin } = url;

    // Basic CORS
    if (req.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));
    const method = req.method.toUpperCase();

    try {
      if (pathname === "/" && method === "GET") {
        // Handy landing page
        return cors(env, new Response("RAG Ubiq: Worker is live.", { status: 200 }));
      }
      if (pathname === "/api/index" && method === "POST") {
        return cors(env, await handleIndex(req, env));
      }
      if (pathname === "/api/query" && method === "POST") {
        return cors(env, await handleQuery(req, env));
      }
      if (pathname === "/api/sources" && method === "GET") {
        return cors(env, await handleListSources(env));
      }
      if (pathname === "/api/source" && method === "DELETE") {
        return cors(env, await handleDeleteSource(req, env));
      }

      return cors(env, new Response(JSON.stringify({ error: "Not found" }), { status: 404 }));
    } catch (err) {
      console.error(err);
      return cors(env, new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500 }));
    }
  },
};

// ---------- Core Handlers ----------

async function handleIndex(req, env) {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    return await indexMultipart(req, env);
  } else {
    const body = await req.json();
    return await indexJson(body, env);
  }
}

async function handleQuery(req, env) {
  const { query, top_k, temperature, max_tokens } = await req.json();
  if (!query || typeof query !== "string") {
    return json({ error: "query (string) is required" }, 400);
  }
  const k = clampInt(top_k ?? env.RAG_TOP_K ?? "6", 1, 24);
  const embed = await embedText(query, env);
  const results = await vectorSearch(env, embed, k);

  // Build the context block and collect sources
  let context = "";
  const seen = new Set();
  const sources = [];

  for (const r of results) {
    const id = r.id;
    const m = await env.DOC_META.get(id, { type: "json" });
    if (!m) continue;

    // Retrieve chunk text from R2
    const object = await env.DOCS.get(m.r2Key);
    if (!object) continue;
    const chunkText = await object.text();

    // Add to context, respecting max char budget
    const maxChars = clampInt(env.RAG_MAX_CONTEXT_CHARS ?? "12000", 2000, 60000);
    if ((context.length + chunkText.length + 200) > maxChars) break;

    context += `\n[${m.sourceId}] ${m.title || m.filename || m.url || "Untitled"}\n${chunkText}\n`;

    if (!seen.has(m.sourceId)) {
      seen.add(m.sourceId);
      sources.push({
        sourceId: m.sourceId,
        title: m.title || m.filename || m.url || "Untitled",
        url: m.url || null,
      });
    }
  }

  const sys = env.RAG_SYSTEM_PROMPT || "You are a helpful assistant.";
  const prompt = [
    { role: "system", content: sys },
    { role: "user", content: `User query: ${query}\n\nContext:\n${context.trim()}\n\nAnswer with [S#] citations.` },
  ];

  const model = env.GENERATION_MODEL || "@cf/meta/llama-3.1-8b-instruct";
  const temp = clampFloat(temperature ?? 0.2, 0, 1);
  const maxOut = clampInt(max_tokens ?? 600, 100, 2000);

  const completion = await env.AI.run(model, {
    messages: prompt,
    temperature: temp,
    max_tokens: maxOut,
  });

  return json({
    answer: completion?.response ?? completion?.result ?? "",
    sources,
  });
}

async function handleListSources(env) {
  // Keys are vector chunk IDs; we track per-source grouping via sourceId
  const list = await listAllKV(env.DOC_META);
  const bySource = new Map();
  for (const item of list) {
    const meta = item.value;
    if (!meta?.sourceId) continue;
    if (!bySource.has(meta.sourceId)) {
      bySource.set(meta.sourceId, {
        sourceId: meta.sourceId,
        title: meta.title || meta.filename || meta.url || "Untitled",
        url: meta.url || null,
        tags: meta.tags || [],
        chunks: 0,
        bytes: 0,
      });
    }
    const group = bySource.get(meta.sourceId);
    group.chunks += 1;
    group.bytes += meta.size || 0;
  }
  return json({ sources: [...bySource.values()] });
}

async function handleDeleteSource(req, env) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return json({ error: "id is required" }, 400);

  // Delete all chunks whose sourceId matches
  const list = await listAllKV(env.DOC_META);
  const toDelete = list.filter(x => x.value?.sourceId === id);

  // Vectorize deletions in batch
  const delIds = toDelete.map(x => x.key);
  if (delIds.length) {
    await env.VDB.deleteByIds(delIds);
  }
  for (const item of toDelete) {
    try { await env.DOCS.delete(item.value.r2Key); } catch {}
    try { await env.DOC_META.delete(item.key); } catch {}
  }
  return json({ ok: true, deleted_chunks: delIds.length });
}

// ---------- Indexing ----------

async function indexJson(body, env) {
  const { text, title, url, tags, sourceId } = body || {};
  if (!text || typeof text !== "string") {
    return json({ error: "text (string) is required" }, 400);
  }
  const sid = sourceId || cryptoRandomId("SRC_");
  const filename = title?.slice(0, 160) || "pasted-text.txt";
  const chunks = chunkText(text, env);

  const upserts = [];
  let index = 0;
  for (const chunk of chunks) {
    const vector = await embedText(chunk, env);
    const id = cryptoRandomId("VEC_");
    const r2Key = `chunks/${sid}/${id}.txt`;

    await env.DOCS.put(r2Key, chunk);
    const meta = {
      id, sourceId: sid, r2Key,
      title, url, tags: tags || [],
      filename, size: chunk.length,
      createdAt: new Date().toISOString(),
    };
    await env.DOC_META.put(id, JSON.stringify(meta));

    upserts.push({ id, values: vector, metadata: { sourceId: sid, title } });
    index++;
  }
  if (upserts.length) {
    await env.VDB.upsert(upserts);
  }
  return json({ ok: true, sourceId: sid, chunks: upserts.length });
}

async function indexMultipart(req, env) {
  const form = await req.formData();
  const title = form.get("title") || null;
  const url = form.get("url") || null;
  const tags = safeTags(form.get("tags"));
  const sourceId = form.get("sourceId") || cryptoRandomId("SRC_");

  const files = form.getAll("files");
  if (!files || files.length === 0) return json({ error: "files are required" }, 400);

  let totalChunks = 0;
  for (const f of files) {
    if (typeof f?.arrayBuffer !== "function") continue;
    const buf = await f.arrayBuffer();
    const text = decodeAsText(buf, f.type, f.name);
    const chunks = chunkText(text, env);

    const filename = (f.name || "upload.txt").slice(0, 160);

    const upserts = [];
    for (const chunk of chunks) {
      const vector = await embedText(chunk, env);
      const id = cryptoRandomId("VEC_");
      const r2Key = `chunks/${sourceId}/${id}.txt`;

      await env.DOCS.put(r2Key, chunk);
      const meta = {
        id, sourceId, r2Key, title, url, tags,
        filename, size: chunk.length,
        createdAt: new Date().toISOString(),
      };
      await env.DOC_META.put(id, JSON.stringify(meta));

      upserts.push({ id, values: vector, metadata: { sourceId, title } });
    }
    if (upserts.length) await env.VDB.upsert(upserts);
    totalChunks += upserts.length;
  }

  return json({ ok: true, sourceId, chunks: totalChunks });
}

// ---------- Vector + AI Utilities ----------

async function embedText(text, env) {
  const model = env.EMBEDDING_MODEL || "@cf/baai/bge-small-en-v1.5";
  const out = await env.AI.run(model, { text });
  // Workers AI returns { data: [ { embedding: number[] } ] } or { embedding: [] }
  const vec =
    out?.data?.[0]?.embedding ||
    out?.embedding ||
    out?.vector ||
    null;
  if (!Array.isArray(vec)) throw new Error("Embedding failed.");
  return vec;
}

async function vectorSearch(env, vector, topK) {
  // Vectorize binding supports .query() returning matches with ids/scores/metadata
  const res = await env.VDB.query(vector, { topK, returnMetadata: true });
  return res.matches || res;
}

// ---------- Helpers ----------

function chunkText(text, env) {
  const size = clampInt(env.RAG_CHUNK_SIZE ?? "1600", 800, 4000);
  const overlap = clampInt(env.RAG_CHUNK_OVERLAP ?? "220", 0, 800);
  const chunks = [];

  // Normalize whitespace a bit
  const clean = text.replace(/\r\n/g, "\n").replace(/\t/g, "  ");

  let i = 0;
  while (i < clean.length) {
    const end = Math.min(i + size, clean.length);
    let slice = clean.slice(i, end);

    // Try to break on paragraph boundary if possible
    if (end < clean.length) {
      const lastPara = slice.lastIndexOf("\n\n");
      if (lastPara > size * 0.6) slice = slice.slice(0, lastPara);
    }

    chunks.push(slice.trim());
    if (end === clean.length) break;
    i += size - overlap;
  }
  return chunks.filter(Boolean);
}

function decodeAsText(buf, mime, name) {
  // Minimal, robust default to UTF-8
  const dec = new TextDecoder("utf-8");
  // Naive gate: treat binaries (pdf, docx) as unsupported -> suggest pre-conversion.
  if (/\.(pdf|docx?|pptx?|xlsx?)$/i.test(name || "")) {
    return "[UNSUPPORTED OFFICE/PDF BINARY]\nPlease upload as .txt or .md after conversion.";
  }
  return dec.decode(buf);
}

function safeTags(x) {
  if (!x) return [];
  const raw = typeof x === "string" ? x : (Array.isArray(x) ? x.join(",") : String(x));
  return raw.split(",").map(s => s.trim()).filter(Boolean).slice(0, 24);
}

function cors(env, res) {
  const allow = env.CORS_ALLOW_ORIGIN || "*";
  res.headers.set("Access-Control-Allow-Origin", allow);
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function clampInt(v, min, max) {
  const n = Math.max(min, Math.min(max, parseInt(v, 10) || min));
  return n;
}

function clampFloat(v, min, max) {
  const n = Math.max(min, Math.min(max, parseFloat(v)));
  return Number.isFinite(n) ? n : min;
}

function cryptoRandomId(prefix = "") {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  const b = [...a].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${prefix}${b}`;
}

async function listAllKV(kv) {
  let cursor = undefined;
  const out = [];
  do {
    const page = await kv.list({ cursor, limit: 1000 });
    for (const k of page.keys) {
      const v = await kv.get(k.name, { type: "json" });
      out.push({ key: k.name, value: v });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
