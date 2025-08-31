/**
 * GoZaddy / DaScient — News Summaries Worker
 * Endpoints:
 *  - GET /ascii        → text/plain ASCII summaries (for index.html & analytics ingest)
 *  - GET /summaries    → JSON summaries array (for analytics.html)
 *  - GET /health       → simple JSON ok
 *
 * Query params (both /ascii and /summaries):
 *  - feeds=<comma-separated URLs>   (optional; defaults if omitted)
 *  - limit=<int>                    (default 40)
 *  - interval=<seconds>             (default 3600; server refresh floor)
 *  - model=<openai model>           (optional; e.g. gpt-4o-mini, gpt-4.1-mini)
 *
 * CORS enabled for all routes.
 * Requires Cloudflare secret OPENAI_API_KEY (optional; if absent: heuristic summarizer).
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleOptions(request);
    try {
      switch (url.pathname) {
        case "/ascii":      return handleAscii(request, env);
        case "/summaries":  return handleSummaries(request, env);
        case "/health":     return json({ ok: true, ts: Date.now() });
        default:            return notFound("Route not found");
      }
    } catch (err) {
      return errorOut(err);
    }
  }
};

/* -------------------------- Defaults & Helpers --------------------------- */

const DEFAULT_FEEDS = [
  // US & Global — general
  "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
  "https://feeds.washingtonpost.com/rss/national",
  "https://www.npr.org/rss/rss.php?id=1001",
  "https://www.reutersagency.com/feed/?best-topics=top-news&post_type=best",
  "https://www.aljazeera.com/xml/rss/all.xml",
  "https://feeds.bbci.co.uk/news/rss.xml",
  "https://apnews.com/hub/ap-top-news?utm_source=apnews.com&utm_medium=referral&utm_campaign=rss&output=rss",
  "https://www.ft.com/rss/home/us",
  "https://www.theguardian.com/world/rss",
  "https://www.politico.com/rss/politics-news.xml",

  // Tech & Business
  "https://www.theverge.com/rss/index.xml",
  "https://www.wsj.com/xml/rss/3_7014.xml",
  "https://feeds.arstechnica.com/arstechnica/index",
  "https://www.forbes.com/most-popular/feed/",
  "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  "https://www.bloomberg.com/feed/podcast/etf-report.xml",

  // Science/Health
  "https://www.nature.com/subjects/news.rss",
  "https://www.science.org/rss/news_current.xml",
  "https://feeds.skynews.com/feeds/rss/world.xml"
];

const SEP_SHORT = "-".repeat(24);
const SEP_LONG  = "-".repeat(72);

function withCors(resp) {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  return new Response(resp.body, { status: resp.status, headers: h });
}
function text(body, status=200, extra={}) {
  return withCors(new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...extra } }));
}
function json(obj, status=200) {
  return withCors(new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } }));
}
function notFound(msg="Not found") { return text(msg, 404); }
function errorOut(err) {
  const m = (err && err.message) ? err.message : String(err);
  return text("Error: " + m, 500);
}
function handleOptions(_req) {
  return withCors(new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Max-Age": "86400"
    }
  }));
}

function toInt(v, d) {
  const n = parseInt(v || "", 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}
function parseFeedsParam(q) {
  const raw = q.get("feeds");
  if (!raw) return DEFAULT_FEEDS;
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}
function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/* --------------------------- In-memory cache ---------------------------- */
/* Note: CF Workers are ephemeral; this cache lives per isolate, which is
   still useful to rate-limit and avoid hammering feeds between requests. */

let CACHE = {
  lastAt: 0,
  ascii: "",
  list: []
};

/* ----------------------------- RSS parsing ------------------------------ */

async function fetchText(url, timeoutMs=15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "Accept": "application/rss+xml, application/xml, text/xml, text/html" },
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error("Fetch failed " + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function parseXmlItems(xml) {
  // Lightweight parse via regex; resilient across RSS/Atom variants.
  // We try <item> then <entry>.
  const items = [];
  const itemMatches = xml.matchAll(/<item\b[\s\S]*?<\/item>/gi);
  const entryMatches = xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi);
  let any = false;

  for (const m of itemMatches) {
    any = true;
    const block = m[0];
    items.push({
      title: getTag(block, "title"),
      link: getTag(block, "link") || getAttr(block, "link", "href"),
      id: getTag(block, "guid") || getTag(block, "id") || "",
      published: getTag(block, "pubDate") || getTag(block, "updated") || getTag(block, "dc:date") || "",
      summary: stripHtml(getTag(block, "description") || getTag(block, "summary") || "")
    });
  }
  if (!any) {
    for (const m of entryMatches) {
      const block = m[0];
      items.push({
        title: getTag(block, "title"),
        link: getAttr(block, "link", "href") || getTag(block, "link"),
        id: getTag(block, "id") || "",
        published: getTag(block, "updated") || getTag(block, "published") || "",
        summary: stripHtml(getTag(block, "summary") || getTag(block, "content") || "")
      });
    }
  }
  // Clean & reduce
  return items.map(it => ({
    title: (it.title || "").trim(),
    link:  (it.link  || "").trim(),
    id:    (it.id    || "").trim(),
    published: (it.published || "").trim(),
    summary: (it.summary || "").trim()
  })).filter(it => it.title && it.link);
}

function getTag(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return decodeXml(m[1]);
}
function getAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*${attr}="([^"]+)"[^>]*>`, "i");
  const m = block.match(re);
  return m ? decodeXml(m[1]) : "";
}
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

/* ---------------------------- AI summarizer ----------------------------- */

async function aiSummaryOrHeuristic(env, title, text, model) {
  const key = env.OPENAI_API_KEY;
  if (!key) return heuristicSummary(title, text);

  const sys = `You are a crisp newsroom analyst. Produce a concise, original news-style summary with:
- HEADLINE (<=90 chars)
- CONTEXT (2–4 sentences)
- KEY POINTS (4–6 short bullets)
- IMPACT (1–2 sentences)
- SEO KEYWORDS: kw1; kw2; kw3; kw4; kw5
Use ASCII only. No emojis.`;

  const user = `ARTICLE TITLE: ${title}
ARTICLE TEXT:
${text.substring(0, 7000)}
`;

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model || "gpt-4o-mini",
        input: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ],
        max_output_tokens: 900,
        temperature: 0.5,
        top_p: 0.9
      })
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const data = await r.json();
    const out = (data.output_text || "").trim();
    return out || heuristicSummary(title, text);
  } catch (_e) {
    // Fallback if the model call fails
    return heuristicSummary(title, text);
  }
}

function heuristicSummary(title, text) {
  // Simple fallback: first sentences + keyword list
  const sents = (text || "").split(/(?<=[.!?])\s+/).slice(0, 4).join(" ");
  const kw = extractKeywords(text).slice(0, 5).join("; ");
  return [
    "HEADLINE",
    limit((title || "Update").trim(), 90),
    "",
    "CONTEXT",
    sents || "(Context unavailable.)",
    "",
    "KEY POINTS",
    ...bullets(text, 5),
    "",
    "IMPACT",
    "Further developments will clarify the scope and timeline.",
    "",
    `SEO KEYWORDS: ${kw}`
  ].join("\n");
}

function limit(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function extractKeywords(text) {
  const stop = new Set("a,an,the,of,in,on,for,with,and,or,to,from,by,as,is,are,was,were,be,been,at,that,this,these,those,it,its,their,his,her,our,your,not,no,if,then,than,but,so,also,into,over,under,about,via,per,within,without,across,between,among,will,can,may,might,could,should,would,have,has,had,do,does,did".split(","));
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w=>!stop.has(w) && w.length>2);
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w)||0)+1);
  return [...freq.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
}
function bullets(text, k=5) {
  const sents = (text || "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 10);
  return sents.slice(0, k).map(s => "- " + s);
}

/* ------------------------------ Core build ------------------------------ */

async function build(env, q) {
  const feeds = parseFeedsParam(q);
  const limit = toInt(q.get("limit"), 40);
  const intervalSec = toInt(q.get("interval"), 3600);
  const model = q.get("model") || "";

  // rate limit via cache time
  const now = Date.now();
  if (CACHE.ascii && (now - CACHE.lastAt) < intervalSec * 1000) {
    return { ascii: CACHE.ascii, list: CACHE.list };
  }

  // fetch feeds concurrently
  const allItems = [];
  await Promise.allSettled(feeds.map(async (f) => {
    try {
      const xml = await fetchText(f);
      const items = parseXmlItems(xml).slice(0, 12);
      items.forEach(it => allItems.push({ ...it, feed: f }));
    } catch (_e) { /* ignore feed error */ }
  }));
  // de-dup by (title+host)
  const seen = new Set();
  const uniq = [];
  for (const it of allItems) {
    const key = (it.title + "|" + hostOf(it.link)).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
  }
  // cap
  const batch = uniq.slice(0, limit);

  // summarize (OpenAI if key present; otherwise heuristic)
  const outList = [];
  for (const it of batch) {
    const text = it.summary || `${it.title} — ${it.link}`;
    const body = await aiSummaryOrHeuristic(env, it.title, text, model);
    const perspMatch = body.match(/^\s*PERSPECTIVE:\s*(.+)$/mi);
    const perspective = perspMatch ? perspMatch[1].trim() : "";

    outList.push({
      title: it.title,
      link: it.link,
      published: it.published,
      host: hostOf(it.link),
      perspective,
      body
    });
  }

  // ASCII
  const banner = [
    "=".repeat(72),
    " DaScient / GoZaddy — AI-Generated News Summaries ",
    "=".repeat(72),
    ""
  ].join("\n");

  const ascii = banner + outList.map(a => {
    return [
      `${a.title} | ${a.link} | ${a.published}`,
      SEP_SHORT,
      a.body,
      SEP_LONG
    ].join("\n");
  }).join("\n") + `\n(Updates hourly; latest ${new Date().toISOString()})\n`;

  CACHE = { lastAt: now, ascii, list: outList };
  return { ascii, list: outList };
}

/* ------------------------------ Handlers -------------------------------- */

async function handleAscii(request, env) {
  const q = new URL(request.url).searchParams;
  const { ascii } = await build(env, q);
  return text(ascii);
}

async function handleSummaries(request, env) {
  const q = new URL(request.url).searchParams;
  const { list } = await build(env, q);
  return json({ ok: true, updatedAt: Date.now(), items: list });
}
