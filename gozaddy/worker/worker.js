// worker.js — GoZaddy ASCII Summaries API (Cloudflare Workers)
//
// Endpoints:
//   GET /ascii?feeds=<csv_urls>&limit=12&interval=3600&model=gpt-4o-mini
//     - Returns an ASCII bundle suitable for your UI parser.
//     - Uses global/cache to avoid recalculating more often than `interval` seconds.
//   GET /cors?url=https://example.com/…
//     - Lightweight CORS passthrough for XML/HTML/JSON (text only).
//   GET /health
//     - Simple health check.
//
// Set OPENAI_API_KEY in Cloudflare → Workers → Settings → Variables.
// Optional: OPENAI_MODEL default override at env level.
//
// NOTE: No secrets are logged or returned. All external errors degrade gracefully.

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true, ts: Date.now() }), { headers: json() });
      if (url.pathname === "/cors")    return handleCors(url);
      if (url.pathname === "/ascii")   return handleAscii(req, url, env, ctx);
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return new Response("Worker error", { status: 500 });
    }
  }
};

/* ======================= /ascii ======================= */

async function handleAscii(req, url, env, ctx) {
  // Inputs
  const feedsParam = url.searchParams.get("feeds") || "";
  const limit = clampInt(url.searchParams.get("limit"), 12, 1, 50);
  const interval = clampInt(url.searchParams.get("interval"), 3600, 300, 86400); // seconds
  const model = (url.searchParams.get("model") || env.OPENAI_MODEL || "gpt-4o-mini").trim();

  // Build cache key
  const cacheKey = new Request(`https://ascii.cache.key?feeds=${hashish(feedsParam)}&limit=${limit}&model=${encodeURIComponent(model)}`);
  const cache = caches.default;

  // Try cache first
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Parse feed list
  const feeds = feedsParam.split(",").map(s => s.trim()).filter(Boolean);
  if (!feeds.length) {
    // Provide a sane default bundle if caller forgot to pass feeds
    const fallback = [
      "AI-GENERATED NEWS SUMMARIES",
      repeat("=", 64),
      "No feeds specified. Add ?feeds=https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml,https://www.reuters.com/rssFeed/topNews",
      "Tip: Pass &interval=3600 to limit summary refresh to hourly.",
      repeat("-", 80),
    ].join("\n");
    return new Response(fallback, { headers: asciiHeaders() });
  }

  // Collect recent items across feeds
  let items = [];
  await Promise.all(
    feeds.map(async (f) => {
      try {
        const xml = await timedFetchText(f, 12000);
        const parsed = parseRSS(xml).slice(0, limit); // per-feed slice
        items.push(...parsed);
      } catch (_e) {
        // swallow; feed might be blocked or down
      }
    })
  );

  // Sort by published desc then title
  items.sort((a, b) => (b.publishedTs - a.publishedTs) || (a.title > b.title ? 1 : -1));
  // Global cap
  items = items.slice(0, limit);

  // Expand with article text (best effort) and summarize with OpenAI (if key present)
  const apiKey = (env.OPENAI_API_KEY || "").trim(); // do not log
  const useAI = !!apiKey;

  // modest concurrency to avoid hammering
  const summarized = await mapLimit(items, 3, async (it) => {
    const html = await safeFetchArticle(it.link);
    const clean = pickReadableText(html) || it.summary || `${it.title} — ${it.link}`;
    const sum = useAI ? await aiSummarize(apiKey, model, clean, it) : localSummarize(clean, it);
    return { ...it, ascii: sum };
  });

  // Bundle to ASCII
  const body = toAsciiBundle(summarized);

  // Cache for `interval` seconds
  const res = new Response(body, { headers: asciiHeaders(interval) });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/* ======================= /cors ======================= */

async function handleCors(url) {
  const target = url.searchParams.get("url");
  if (!target) return new Response("Missing url", { status: 400, headers: corsHeaders() });

  // Only allow http/https
  try {
    const u = new URL(target);
    if (!/^https?:$/.test(u.protocol)) throw new Error("bad scheme");
  } catch {
    return new Response("Invalid url", { status: 400, headers: corsHeaders() });
  }

  try {
    const r = await fetch(target, { headers: { "User-Agent": "GoZaddy-CORS/1.0" } });
    const txt = await r.text();
    // reflect content-type when reasonable; default text/plain
    const ct = r.headers.get("content-type") || "text/plain; charset=utf-8";
    return new Response(txt, { headers: { ...corsHeaders(), "Content-Type": ct } });
  } catch {
    return new Response("Fetch failed", { status: 502, headers: corsHeaders() });
  }
}

/* ======================= Helpers ======================= */

// Simple RSS parser (no DOMParser). Extracts title/link/pubDate/summary.
function parseRSS(xml) {
  const out = [];

  // Normalize entities
  const s = xml.replace(/\r/g, "");

  // Split by <item>…</item> or <entry>…</entry>
  const items = s.match(/<item[\s\S]*?<\/item>/gi) || s.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of items) {
    const title = pickTag(block, "title") || "";
    const link  = pickLink(block) || "";
    const date  = pickDate(block) || "";
    const summary = stripTags(pickTag(block, "description") || pickTag(block, "content") || "");

    const ts = toTs(date);
    out.push({ title: cleanInline(title), link, published: date, publishedTs: ts, summary });
  }
  return out;
}

// Extract first <link>… or href attribute in atom
function pickLink(block) {
  const atom = block.match(/<link[^>]*?href=["']([^"']+)["'][^>]*>/i);
  if (atom && atom[1]) return atom[1].trim();
  const rss  = block.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss && rss[1]) return rss[1].trim();
  return "";
}

// Extract common date tags
function pickDate(block) {
  const m1 = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
  if (m1) return m1[1].trim();
  const m2 = block.match(/<updated>([\s\S]*?)<\/updated>/i);
  if (m2) return m2[1].trim();
  const m3 = block.match(/<published>([\s\S]*?)<\/published>/i);
  if (m3) return m3[1].trim();
  return "";
}

// Generic tag extractor (first occurrence)
function pickTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

// fetch with timeout -> text
async function timedFetchText(u, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(u, { signal: ctrl.signal, headers: { "User-Agent": "GoZaddy-Worker/1.0" } });
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// best-effort article fetch (may fail due to paywalls/CORS)
async function safeFetchArticle(u) {
  try {
    const r = await fetch(u, { headers: { "User-Agent": "GoZaddy-Article/1.0" } });
    return await r.text();
  } catch {
    return "";
  }
}

// crude readability: drop scripts/styles and tags; keep paragraphs-ish
function pickReadableText(html) {
  if (!html) return "";
  // Remove script/style/noscript/iframe blocks
  html = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
             .replace(/<style[\s\S]*?<\/style>/gi, " ")
             .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
             .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ");

  // Convert <p> and <br> to newlines
  html = html.replace(/<\/p>/gi, "\n")
             .replace(/<br\s*\/?>/gi, "\n");

  // Strip the rest of tags
  const txt = stripTags(html);
  // Collapse whitespace and keep some paragraph breaks
  return txt.split("\n").map(l => l.trim()).filter(Boolean).join("\n");
}

function stripTags(s) {
  return (s || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
                  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function cleanInline(s) {
  return stripTags(s).replace(/\s+/g, " ").trim();
}

function toTs(s) {
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

function clampInt(v, def, min, max) {
  const n = parseInt(v || "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}

function repeat(ch, n) { return Array(n).fill(ch).join(""); }

function asciiHeaders(maxAge = 300) {
  return {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": `public, max-age=${maxAge}`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}
function json() { return { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() }; }

// tiny hash surrogate for cache key variability (non-cryptographic)
function hashish(s) {
  let h = 2166136261 >>> 0;
  for (let i=0; i<s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24);
  }
  return (h >>> 0).toString(16);
}

// control concurrency
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const workers = Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length) {
      const cur = i++;
      try { out[cur] = await fn(arr[cur], cur); }
      catch { out[cur] = null; }
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}

/* ======================= Summarization ======================= */

// Local fallback summary (if API key missing)
function localSummarize(text, meta) {
  // crude: take first few sentences + bullets + naive keywords
  const maxChars = 1400;
  const body = text.replace(/\s+/g, " ").slice(0, maxChars);
  const points = extractBullets(text, 5);
  const kws = topKeywords(text, 5);

  return [
    `${meta.title} | ${meta.link} | ${meta.published || ""}`,
    repeat("-", 24),
    toParagraph(`SUMMARY: ${body}`),
    "",
    "KEY POINTS:",
    ...points.map(p => `- ${p}`),
    "",
    `SEO KEYWORDS: ${kws.join("; ")}`,
    repeat("-", 80)
  ].join("\n");
}

function extractBullets(text, n=5) {
  const sents = (text.match(/[^.!?]+[.!?]/g) || []).map(x => x.trim());
  return sents.slice(0, n);
}

function topKeywords(text, k=5) {
  const stop = new Set(("a,an,the,of,in,on,for,with,and,or,to,from,by,as,is,are,was,were,be,been,at,that,this,these,those,it,its,their,his,her,our,your,not,no,if,then,than,but,so,also,into,over,under,about,via,per,within,without,across,between,among,will,can,may,might,could,should,would,has,have,had,more,most,less,least,new,news,story").split(","));
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => !stop.has(w) && w.length > 2);
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,k).map(x=>x[0]);
}

function toParagraph(s) {
  // wrap to ~100 cols
  const out = [];
  let line = "";
  for (const tok of s.split(/\s+/)) {
    if ((line + " " + tok).trimEnd().length > 100) {
      out.push(line.trimEnd());
      line = tok + " ";
    } else {
      line += tok + " ";
    }
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.join("\n");
}

// OpenAI-powered summary
async function aiSummarize(apiKey, model, text, meta) {
  // Keep prompt short & deterministic; ask for consistent ASCII block your UI expects
  const sys = "You are a news desk editor. Write concise, objective summaries with key points and 5 SEO keywords. ASCII only.";
  const user =
`Summarize the following article for tech/business readers.
Hard rules:
- Keep the body under ~250 words.
- Add a KEY POINTS list (3-6 bullets).
- End with "SEO KEYWORDS: kw1; kw2; kw3; kw4; kw5".
- No emojis, no markdown tables.

TITLE: ${meta.title}
LINK: ${meta.link}
PUBLISHED: ${meta.published}

ARTICLE:
${text.slice(0, 8000)}`;

  const body = JSON.stringify({
    model,
    input: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ],
    temperature: 0.4,
    max_output_tokens: 700
  });

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const j = await r.json();
    const out = (j.output_text || "").trim();
    const wrapped = toParagraph(out);
    return [
      `${meta.title} | ${meta.link} | ${meta.published || ""}`,
      repeat("-", 24),
      wrapped,
      "",
      repeat("-", 80)
    ].join("\n");
  } catch {
    // fall back silently
    return localSummarize(text, meta);
  }
}

/* ======================= Bundle ======================= */

function toAsciiBundle(list) {
  const head = [
    "AI-GENERATED NEWS SUMMARIES",
    repeat("=", 64),
    `Count: ${list.length}`,
    "",
  ].join("\n");

  const blocks = list.map(x => x.ascii || "");
  return head + blocks.join("\n");
}
