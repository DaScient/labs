/**
 * GoZaddy / DaScient — ASCII News Summaries Worker
 * Endpoints:
 *   GET /ascii?feeds=<comma-urls>&limit=5&interval=3600&model=gpt-4.1-mini
 *
 * Env:
 *   OPENAI_API_KEY  (optional; if unset, uses built-in heuristic summarizer)
 */

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      // CORS preflight
      if (req.method === "OPTIONS") {
        return cors(new Response(null, { status: 204 }));
      }

      if (path === "" || path === "/") {
        return cors(
          new Response(
            "OK\nUse /ascii?feeds=<rss1,rss2>&limit=5&interval=3600\n",
            { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
          )
        );
      }

      if (path === "/ascii") {
        return cors(await handleAscii(url, env, ctx));
      }

      return cors(new Response("Not found", { status: 404 }));
    } catch (err) {
      console.error("Top-level error:", err);
      return cors(
        new Response(`Worker error\n${String(err?.message || err)}`, {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      );
    }
  },
};

/* ----------------------------- /ascii handler ------------------------------ */

const MEMO = new Map(); // cacheKey -> { ts:number, text:string }

async function handleAscii(url, env, ctx) {
  const feedsParam =
    url.searchParams.get("feeds") ||
    "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml,https://feeds.washingtonpost.com/rss/national";
  const limit = clampInt(url.searchParams.get("limit"), 1, 20, 5);
  const intervalSec = clampInt(url.searchParams.get("interval"), 300, 86400, 3600); // default 1h
  const model = url.searchParams.get("model") || "gpt-4.1-mini";

  // Use a cache key that includes params to throttle generation
  const cacheKey = `ascii|${feedsParam}|${limit}|${intervalSec}|${model}`;
  const now = Date.now();
  const cached = MEMO.get(cacheKey);
  if (cached && now - cached.ts < intervalSec * 1000) {
    // Serve memoized
    return textResponse(cached.text, intervalSec);
  }

  // Try Cloudflare cache (shared)
  const cfCache = caches.default;
  const reqForCache = new Request(`https://cache-key.example/${encodeURIComponent(cacheKey)}`, {
    method: "GET",
  });
  const hit = await cfCache.match(reqForCache);
  if (hit) {
    const t = await hit.text();
    // Also refresh MEMO to keep instances aligned
    MEMO.set(cacheKey, { ts: now, text: t });
    return textResponse(t, intervalSec);
  }

  const feedUrls = feedsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allItems = [];
  for (const u of feedUrls) {
    try {
      const xml = await fetchText(u);
      const items = parseRssItems(xml).slice(0, limit);
      allItems.push(...items);
    } catch (e) {
      console.error("Feed fetch/parse failed for", u, e);
    }
  }

  // Dedup by link/title
  const seen = new Set();
  const uniq = [];
  for (const it of allItems) {
    const key = (it.link || "") + "|" + (it.title || "");
    if (!seen.has(key)) {
      seen.add(key);
      uniq.push(it);
    }
    if (uniq.length >= limit) break;
  }

  if (!uniq.length) {
    const msg = banner("AI-GENERATED NEWS SUMMARIES") +
      "\n(no recent items or feeds unavailable)\n";
    // Cache negative result briefly
    MEMO.set(cacheKey, { ts: now, text: msg });
    await putToCfCache(cfCache, reqForCache, msg, 300);
    return textResponse(msg, Math.min(intervalSec, 300));
  }

  // Build prompts and summarize each item
  const summaries = [];
  for (const it of uniq) {
    try {
      const articleText = await safeFetchArticleText(it.link);
      const base = articleText || it.summary || `${it.title}\n${it.link}`;
      const sum = await summarize(base, it, env, model);
      summaries.push(renderOne(it, sum));
    } catch (e) {
      console.error("Summarize failed", it.link, e);
    }
  }

  const out =
    banner("AI-GENERATED NEWS SUMMARIES") +
    "\n" +
    summaries.join("\n" + "-".repeat(78) + "\n") +
    "\n" +
    footerNote();

  // Store in MEMO and CF cache
  MEMO.set(cacheKey, { ts: now, text: out });
  await putToCfCache(cfCache, reqForCache, out, intervalSec);

  return textResponse(out, intervalSec);
}

/* ------------------------------- Utilities -------------------------------- */

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, { status: res.status, headers: h });
}

function textResponse(txt, maxAgeSec = 3600) {
  return new Response(txt, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": `public, max-age=${Math.max(60, Math.min(maxAgeSec, 86400))}`,
    },
  });
}

async function putToCfCache(cache, req, body, ttlSec) {
  try {
    const res = new Response(body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": `public, max-age=${Math.max(60, Math.min(ttlSec, 86400))}`,
      },
    });
    await cache.put(req, res);
  } catch (e) {
    console.error("Cache put failed", e);
  }
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}

async function fetchText(u) {
  const r = await fetch(u, {
    headers: {
      "User-Agent": "DaScient-GoZaddy-Worker/1.0 (+https://dascient.com)",
      "Accept": "application/rss+xml, application/xml, text/xml, text/html; charset=utf-8",
    },
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`Fetch ${u} failed: ${r.status}`);
  return await r.text();
}

// Very safe RSS item extractor (no brittle CDATA regex)
function parseRssItems(xml) {
  const out = [];

  // Grab <item> blocks (RSS) or <entry> (Atom)
  const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)];
  const entries = items.length ? [] : [...xml.matchAll(/<entry[\s\S]*?<\/entry>/gi)];
  const blocks = items.length ? items.map((m) => m[0]) : entries.map((m) => m[0]);

  for (const b of blocks) {
    const title = decodeEntities(extractTag(b, "title") || "");
    const link =
      extractAttr(b, "link", "href") ||
      decodeEntities(extractTag(b, "link")) ||
      "";
    const summary =
      decodeEntities(extractTag(b, "description") || extractTag(b, "summary") || "");
    const pub =
      decodeEntities(extractTag(b, "pubDate") || extractTag(b, "updated") || "");
    out.push({ title, link: (link || "").trim(), summary, published: pub });
  }
  return out;
}

function extractTag(block, tag) {
  // Handles optional CDATA
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  const inner = m[1] || "";
  const cdata = inner.match(/<!\[CDATA\[(.*?)\]\]>/s);
  return cdata ? cdata[1] : inner;
}

function extractAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}\\s*=\\s*"(.*?)"[^>]*>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function safeFetchArticleText(link) {
  if (!link) return "";
  try {
    const r = await fetch(link, {
      headers: { "User-Agent": "DaScient-GoZaddy-Worker/1.0" },
      cf: { cacheTtl: 600, cacheEverything: false },
    });
    if (!r.ok) return "";
    const html = await r.text();
    // naive extraction: strip scripts/styles and pull paragraphs
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 20000); // keep it bounded
  } catch {
    return "";
  }
}

/* ------------------------- Summarization pipeline -------------------------- */

async function summarize(raw, meta, env, model) {
  const key = env.OPENAI_API_KEY; // do not log
  const basePrompt = `
You are an editorial analyst. Produce a crisp ASCII-only brief for operators.
Focus on: what happened, why it matters, risks, opportunities, and next steps.
No fluff. 120–220 words. End with:
SEO KEYWORDS: kw1; kw2; kw3; kw4; kw5

TITLE: ${meta.title || "Untitled"}
LINK: ${meta.link || ""}
PUBLISHED: ${meta.published || ""}

SOURCE:
${raw.substring(0, 6000)}
`;

  if (!key) {
    // Heuristic fallback (never crashes if key missing)
    return localSummarize(raw, meta);
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: basePrompt,
        max_output_tokens: 600,
        temperature: 0.4,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      console.error("OpenAI error", resp.status, t.slice(0, 500));
      return localSummarize(raw, meta);
    }
    const data = await resp.json();
    const txt =
      (data.output_text || "").trim() ||
      (Array.isArray(data.output) ? (data.output.map((o) => o.content || "").join("\n")).trim() : "");
    return txt || localSummarize(raw, meta);
  } catch (e) {
    console.error("OpenAI call failed", e);
    return localSummarize(raw, meta);
  }
}

function localSummarize(raw, meta) {
  // Minimal extractive summary + template
  const sents = (raw || "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 6);
  const core = sents.join(" ").slice(0, 1200);
  const kws = topKeywords(raw, 5).join("; ");
  return (
    `SUMMARY\n${core}\n\nWHY IT MATTERS\n` +
    `- Potential operational and regulatory impact.\n- Signals shifts in demand, pricing, or policy.\n` +
    `- Watch competitive moves and supply dynamics.\n\nNEXT STEPS\n` +
    `- Validate assumptions with data.\n- Draft a Now/Next/Later action list.\n- Track leading indicators.\n\n` +
    `SEO KEYWORDS: ${kws}`
  );
}

function topKeywords(text, k = 5) {
  if (!text) return ["news analysis", "strategy", "risk", "opportunity", "insight"];
  const stop = new Set(
    "the,of,and,to,a,in,for,is,that,on,with,as,are,was,be,by,or,an,from,at,which,it,this,has,have,were,will,its,not,can,also".split(
      ","
    )
  );
  const freq = Object.create(null);
  (text.toLowerCase().match(/[a-z0-9]+/g) || []).forEach((w) => {
    if (w.length < 3 || stop.has(w)) return;
    freq[w] = (freq[w] || 0) + 1;
  });
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map((x) => x[0]);
}

function renderOne(item, summary) {
  const parts = [];
  parts.push(item.title ? item.title : "(untitled)");
  if (item.link) parts.push(item.link);
  if (item.published) parts.push(item.published);
  const head = parts.join(" | ");
  return (
    head +
    "\n" +
    "-".repeat(Math.min(78, Math.max(20, head.length))) +
    "\n" +
    summary.trim() +
    "\n"
  );
}

function banner(t) {
  const line = "=".repeat(Math.max(24, Math.min(78, t.length + 6)));
  return `${line}\n== ${t} ==\n${line}`;
}

function footerNote() {
  return (
    "\n(Updates hourly · Generated by DaScient/GoZaddy Worker · ASCII only)\n"
  );
}
