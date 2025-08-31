/**
 * GoZaddy Worker — Summaries + ASCII
 * - GET /summaries?feeds=<csv>&feedsUrl=<url>&limit=50&interval=3600
 * - GET /ascii? ...            (plain text version)
 * - GET /health
 *
 * Env:
 *  - OPENAI_API_KEY (optional) -> enables AI summaries
 *  - MODEL_LIST (optional)     -> comma CSV of OpenAI model ids to rotate
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "");

      if (path === "" || path === "/") {
        return text("ok");
      }
      if (path === "/health") {
        return json({ ok: true, ts: Date.now() });
      }

      if (path === "/summaries" || path === "/ascii") {
        const params = await resolveParams(url, env);
        const cacheKey = await cacheKeyFor(url, params);
        const cache = caches.default;

        // serve from cache
        const cached = await cache.match(cacheKey);
        if (cached) return withCORS(cached);

        // build fresh
        const data = await buildPayload(params, env);

        // never 500: always return whatever we could gather
        const response =
          path === "/ascii" ? text(renderASCII(data)) : json(data);

        // cache for interval seconds
        const ttl = Math.max(30, params.interval); // minimum 30s
        response.headers.set("Cache-Control", `public, max-age=${ttl}`);
        ctx.waitUntil(cache.put(cacheKey, response.clone()));

        return withCORS(response);
      }

      return withCORS(new Response("Not found", { status: 404 }));
    } catch (e) {
      // Last-resort safety: never 500 to the client
      return withCORS(
        json({
          ok: false,
          error: String(e?.message || e),
          ts: Date.now(),
          items: [],
          errors: [String(e?.stack || e)],
        })
      );
    }
  },
};

/* ------------------------- helpers ------------------------- */

function withCORS(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  res.headers.set("Content-Type", res.headers.get("Content-Type") || "text/plain; charset=utf-8");
  return res;
}

function text(s) {
  return new Response(s, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function sha256(s) {
  const enc = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function cacheKeyFor(url, params) {
  const clone = new URL(url.toString());
  // normalize key; append signature so different feed sets don't collide
  clone.searchParams.set("limit", String(params.limit));
  clone.searchParams.set("interval", String(params.interval));
  clone.searchParams.delete("feeds");
  clone.searchParams.delete("feedsUrl");
  const sig = await sha256((params.feeds || []).join("\n"));
  clone.searchParams.set("sig", sig);
  return new Request(clone.toString(), { method: "GET" });
}

async function resolveParams(url, env) {
  const qp = url.searchParams;
  let feeds = [];

  // feeds via CSV
  const csv = qp.get("feeds");
  if (csv) {
    feeds = csv.split(",").map(s => s.trim()).filter(Boolean);
  }

  // feeds via URL (preferred)
  const feedsUrl = qp.get("feedsUrl");
  if (feedsUrl) {
    try {
      const r = await fetch(feedsUrl, { cf: { cacheTtl: 300 } });
      const t = await r.text();
      const list = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      // ignore comments and section headers
      feeds = list.filter(line => line.startsWith("http"));
    } catch (e) {
      // fall through; we’ll still try with csv feeds
    }
  }

  // fallback: a small curated set
  if (!feeds.length) {
    feeds = [
      "https://feeds.reuters.com/reuters/topNews",
      "https://www.aljazeera.com/xml/rss/all.xml",
      "https://feeds.bbci.co.uk/news/rss.xml",
    ];
  }

  const limit = Math.max(5, Math.min(200, parseInt(qp.get("limit") || "50", 10)));
  const interval = Math.max(30, Math.min(7200, parseInt(qp.get("interval") || "3600", 10)));

  // model rotation
  const modelList =
    (env.MODEL_LIST || "").split(",").map(s => s.trim()).filter(Boolean) ||
    ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1", "gpt-3.5-turbo"]; // safe fallbacks

  return { feeds, limit, interval, modelList };
}

/* -------------------------- core --------------------------- */

async function buildPayload(params, env) {
  const { feeds, limit } = params;
  const errors = [];
  const items = [];

  // fetch all feeds in parallel with per-request timeout
  const chunks = await Promise.all(
    feeds.map(async (f) => {
      try {
        const txt = await fetchWithTimeout(f, 15000);
        return parseAnyFeed(txt, f);
      } catch (e) {
        errors.push(`Feed error (${f}): ${String(e)}`);
        return [];
      }
    })
  );

  // flatten
  for (const arr of chunks) {
    for (const it of arr) items.push(it);
  }

  // normalize + dedupe
  const map = new Map();
  for (const it of items) {
    const host = hostOf(it.link);
    const key = (it.link || it.guid || it.title || "").trim().toLowerCase();
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { ...it, host });
    }
  }

  // per-source cap to avoid one feed flooding
  const byHost = new Map();
  const capped = [];
  const MAX_PER_SOURCE = 12;

  for (const it of [...map.values()].sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0))) {
    const cnt = (byHost.get(it.host || "unknown") || 0) + 1;
    if (cnt <= MAX_PER_SOURCE) {
      capped.push(it);
      byHost.set(it.host || "unknown", cnt);
    }
  }

  // limit overall
  const trimmed = capped.slice(0, limit);

  // add summaries (AI if key set; otherwise heuristic)
  const withSummaries = await summarizeBatch(trimmed, env, params);

  return {
    ok: true,
    ts: Date.now(),
    count: withSummaries.length,
    items: withSummaries,
    errors,
  };
}

function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "GoZaddy/1.0 (+rss)" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* -------------------- RSS/Atom parsing --------------------- */

function stripCDATA(s = "") {
  return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim();
}

function cleanText(s = "") {
  // strip tags & entities quickly
  const noTags = s.replace(/<[^>]*>/g, " ");
  return stripCDATA(noTags).replace(/\s+/g, " ").trim();
}

function parseAnyFeed(xml, feedUrl) {
  xml = xml || "";
  // Try RSS <item>
  let items = [];
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  if (itemBlocks.length) {
    items = itemBlocks.map(block => {
      const title = pick(block, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
      const link =
        pickAttr(block, /<link\b([^>]*)>/i, "href") ||
        pick(block, /<link\b[^>]*>([\s\S]*?)<\/link>/i);
      const guid = pick(block, /<guid\b[^>]*>([\s\S]*?)<\/guid>/i);
      const pub = pick(block, /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i);
      return normalizeItem({ title, link, guid, published: pub, feed: feedUrl });
    });
    return items.filter(x => x.title || x.link);
  }

  // Try Atom <entry>
  const entryBlocks = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  if (entryBlocks.length) {
    items = entryBlocks.map(block => {
      const title = pick(block, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
      const link =
        pickAttr(block, /<link\b([^>]*)>/i, "href") ||
        pick(block, /<link\b[^>]*>([\s\S]*?)<\/link>/i);
      const guid = pick(block, /<id\b[^>]*>([\s\S]*?)<\/id>/i);
      const pub =
        pick(block, /<updated\b[^>]*>([\s\S]*?)<\/updated>/i) ||
        pick(block, /<published\b[^>]*>([\s\S]*?)<\/published>/i);
      return normalizeItem({ title, link, guid, published: pub, feed: feedUrl });
    });
    return items.filter(x => x.title || x.link);
  }

  // fallback: empty
  return [];
}

function pick(block, re) {
  const m = block.match(re);
  return m ? cleanText(m[1]) : "";
}
function pickAttr(block, re, attr) {
  const m = block.match(re);
  if (!m) return "";
  const attrs = m[1] || "";
  const am = attrs.match(new RegExp(attr + `\\s*=\\s*"(.*?)"`, "i"));
  return am ? am[1] : "";
}

function normalizeItem(o) {
  const title = stripCDATA((o.title || "").trim());
  const link = (o.link || "").trim();
  const guid = (o.guid || "").trim();
  const published = (o.published || "").trim();
  let publishedTs = Date.parse(published);
  if (!Number.isFinite(publishedTs)) publishedTs = 0;
  return { title, link, guid, published, publishedTs, feed: o.feed || "" };
}

/* ----------------- summarization (AI/heur) ----------------- */

async function summarizeBatch(items, env, params) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    // simple heuristic summary + keywords
    return items.map(it => ({
      ...it,
      summary: heuristicSummary(it.title),
      keywords: naiveKeywords(it.title),
      confidence: confidenceScore(it.title, it.host),
    }));
  }

  // model rotation per item
  const models = params.modelList.length ? params.modelList : ["gpt-4.1-mini"];

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const model = models[i % models.length];

    try {
      const prompt = [
        "Write a concise, neutral news brief (2–3 sentences) using only the headline/context.",
        "Return strictly plain text.",
        `Headline: ${it.title}`,
        it.link ? `Source: ${it.link}` : "",
      ].join("\n");

      const r = await openAI(apiKey, model, prompt);
      const summary = (r || "").trim();
      const keywords = naiveKeywords(it.title + " " + summary);

      results.push({
        ...it,
        summary,
        keywords,
        confidence: confidenceScore(summary || it.title, it.host),
        model,
      });
    } catch (e) {
      // fallback to heuristic
      results.push({
        ...it,
        summary: heuristicSummary(it.title),
        keywords: naiveKeywords(it.title),
        confidence: confidenceScore(it.title, it.host),
        model,
        error: String(e?.message || e),
      });
    }
  }
  return results;
}

async function openAI(apiKey, model, prompt) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0.4,
      top_p: 0.95,
      max_output_tokens: 200,
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const j = await r.json();
  // v1 Responses returns consolidated text in output_text
  return j.output_text || "";
}

/* ---------------- text / seo helpers ---------------- */

function heuristicSummary(title = "") {
  if (!title) return "";
  const t = title.replace(/\s+/g, " ").trim();
  // simple split
  return t.endsWith(".") ? t : t + ".";
}

function naiveKeywords(text = "") {
  const stop = new Set(
    "a,an,the,of,in,on,for,with,and,or,to,from,by,as,is,are,was,were,be,been,at,that,this,these,those,it,its,their,his,her,our,your,not,no,if,then,than,but,so,also,into,over,under,about,via,per,within,without,across,between,among,will,can,may,might,could,should,would".split(
      ","
    )
  );
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (w) => !stop.has(w) && w.length > 2
  );
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map((x) => x[0]);
}

function confidenceScore(text = "", host = "") {
  const POS = new Set("confirm,confirmed,official,approved,announced,launch,launched,records,record,acquires,acquired,sec,final,definitive,report,results".split(","));
  const NEG = new Set("may,might,could,reportedly,rumor,alleged,seems,suggests,likely,unverified,investigating,unclear,disputed,questioned,unconfirmed".split(","));
  const bag = (text.toLowerCase().match(/[a-z0-9]+/g) || []);
  let pos = 0, neg = 0;
  for (const w of bag) { if (POS.has(w)) pos++; if (NEG.has(w)) neg++; }
  let score = 52 + 6 * pos - 6 * neg;
  if (/nytimes\.com|washingtonpost\.com|reuters\.com|bbc\.co\.uk|bbc\.com|apnews\.com/i.test(host)) score += 6;
  return Math.max(0, Math.min(100, score));
}

/* ----------------------- ASCII ----------------------- */

function renderASCII(payload) {
  const L = 80;
  const bar = "-".repeat(L);
  const out = [];
  out.push(`AI-GENERATED NEWS SUMMARIES`);
  out.push(bar);
  for (const it of payload.items || []) {
    out.push(`${it.title} | ${it.link || ""} | ${it.published || ""}`);
    out.push("-".repeat(30));
    if (it.summary) out.push(it.summary);
    if (it.keywords?.length) out.push(`SEO KEYWORDS: ${it.keywords.join("; ")}`);
    out.push("-".repeat(60));
  }
  out.push(`(Updates cached up to ${payload.count} items)`);
  return out.join("\n");
}
