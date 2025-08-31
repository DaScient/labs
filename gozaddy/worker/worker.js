// /gozaddy/worker.js
// Cloudflare Worker: AI summaries for RSS feeds
// Env secrets to set (never print these):
// - OPENAI_API_KEY  (optional; if missing we use heuristic summaries)

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return cors(new Response(null, { status: 204 }));
      }

      if (url.pathname === "/health") {
        return cors(json({ ok: true, ts: Date.now() }));
      }

      if (url.pathname === "/ascii" || url.pathname === "/summaries") {
        // Serve from cache if fresh
        const cacheKey = new Request(req.url, req);
        const cached = await caches.default.match(cacheKey);
        if (cached) return cors(cached);

        // Build fresh
        const feedsParam = url.searchParams.get("feeds") || "";
        const limit = clampInt(url.searchParams.get("limit"), 5, 100, 25);
        const interval = clampInt(url.searchParams.get("interval"), 60, 86400, 3600); // seconds

        const feedUrls = parseFeedList(feedsParam);
        if (!feedUrls.length) {
          return cors(json({ error: "No feeds specified. Add ?feeds=url1,url2" }, 400));
        }

        // Pull + parse feeds (parallel)
        const items = await gatherFeedItems(feedUrls, limit);

        // Summarize (AI if key provided; fallback otherwise)
        const OPENAI_API_KEY = env.OPENAI_API_KEY || "";
        const summarized = await summarizeItems(items, OPENAI_API_KEY);

        // JSON or ASCII
        let resp;
        if (url.pathname === "/summaries") {
          resp = json({ ok: true, interval, items: summarized });
        } else {
          resp = new Response(toASCII(summarized, interval), {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            status: 200,
          });
        }

        // Cache for `interval` seconds
        const headers = new Headers(resp.headers);
        headers.set("Cache-Control", `public, max-age=${interval}, stale-while-revalidate=60`);
        const cachedResp = new Response(resp.body, { status: resp.status, headers });

        ctx.waitUntil(caches.default.put(cacheKey, cachedResp.clone()));
        return cors(cachedResp);
      }

      // Friendly landing
      if (url.pathname === "/" || url.pathname === "") {
        return cors(
          new Response(
            `GoZaddy RSS Summarizer
Endpoints:
  GET /summaries?feeds=<csv>&limit=25&interval=3600    -> JSON
  GET /ascii?feeds=<csv>&limit=25&interval=3600        -> ASCII
  GET /health                                          -> JSON

Tip: Set OPENAI_API_KEY secret for AI summaries. Without it, we fall back to a heuristic.`,
            { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
          )
        );
      }

      // 404 (with CORS)
      return cors(new Response("Not found", { status: 404 }));
    } catch (err) {
      return cors(json({ error: String(err || "Worker exception") }, 500));
    }
  },
};

/* ----------------- Utilities ----------------- */
function cors(resp) {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  return new Response(resp.body, { status: resp.status, headers: h });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function clampInt(v, min, max, dflt) {
  const n = parseInt(v || "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return dflt;
}
function parseFeedList(csv) {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}
function hostOnly(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* ----------------- RSS Fetch/Parse ----------------- */
async function gatherFeedItems(feedUrls, limit) {
  const perFeed = Math.max(3, Math.ceil(limit / Math.max(1, feedUrls.length)) * 2); // overfetch a little
  const settled = await Promise.allSettled(
    feedUrls.map(async (u) => {
      const r = await fetch(u, { headers: { "User-Agent": "GoZaddy-RSS/1.0" } });
      const txt = await r.text();
      return parseRSS(txt).slice(0, perFeed).map((it) => ({ ...it, feed: u }));
    })
  );
  const all = [];
  for (const s of settled) if (s.status === "fulfilled") all.push(...s.value);
  // unique by (title+link), newest first
  const seen = new Set();
  const uniq = [];
  for (const it of all) {
    const key = (it.title || "") + "|" + (it.link || "");
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
  }
  // sort by published desc (fallback to current time order)
  uniq.sort((a, b) => (Date.parse(b.published || "") || 0) - (Date.parse(a.published || "") || 0));
  return uniq.slice(0, limit);
}

// Lightweight RSS/Atom parse (no fragile regex; simple block slices)
function parseTag(block, tag) {
  // <tag> ... </tag>
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = block.indexOf(open);
  if (i === -1) return "";
  const j = block.indexOf(close, i + open.length);
  if (j === -1) return "";
  return decodeEntities(block.slice(i + open.length, j).trim());
}
function parseAttr(block, tag, attr) {
  // <tag ... attr="x" ...>
  const rx = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"`, "i");
  const m = block.match(rx);
  return m ? decodeEntities(m[1]) : "";
}
function splitBlocks(xml, openTag, closeTag) {
  const blocks = [];
  let idx = 0;
  for (;;) {
    const i = xml.indexOf(openTag, idx);
    if (i === -1) break;
    const j = xml.indexOf(closeTag, i);
    if (j === -1) break;
    blocks.push(xml.slice(i, j + closeTag.length));
    idx = j + closeTag.length;
  }
  return blocks;
}
function parseRSS(xml) {
  const x = xml || "";
  const items = [];
  // RSS 2.0
  for (const block of splitBlocks(x, "<item", "</item>")) {
    const title = parseTag(block, "title");
    const link = parseTag(block, "link") || parseAttr(block, "link", "href");
    const pubDate = parseTag(block, "pubDate");
    const desc = parseTag(block, "description");
    items.push({
      title,
      link,
      published: pubDate || "",
      summary: stripTags(desc),
    });
  }
  if (items.length) return items;
  // Atom
  const out = [];
  for (const block of splitBlocks(x, "<entry", "</entry>")) {
    const title = parseTag(block, "title");
    const link = parseAttr(block, "link", "href") || parseTag(block, "link");
    const updated = parseTag(block, "updated") || parseTag(block, "published");
    const sum = parseTag(block, "summary") || parseTag(block, "content");
    out.push({
      title,
      link,
      published: updated || "",
      summary: stripTags(sum),
    });
  }
  return out;
}
function stripTags(html) {
  if (!html) return "";
  // Remove tags & entities
  const noTags = html.replace(/<[^>]*>/g, " ");
  return collapseSpaces(decodeEntities(noTags));
}
function collapseSpaces(s) {
  return s.replace(/\s+/g, " ").trim();
}
function decodeEntities(s) {
  // Minimal entity decode
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/* ----------------- Summaries ----------------- */
async function summarizeItems(items, OPENAI_API_KEY) {
  const out = [];
  for (const it of items) {
    const src = it.summary || "";
    const title = it.title || "";
    const link = it.link || "";
    const body = src.length > 1200 ? src.slice(0, 1200) + " ..." : src;

    let summary = "";
    let keywords = [];

    if (OPENAI_API_KEY) {
      try {
        const ai = await aiSummarize(OPENAI_API_KEY, title, body);
        summary = ai.summary;
        keywords = ai.keywords;
      } catch {
        // fallback
        const h = heuristicSummary(title, body);
        summary = h.summary;
        keywords = h.keywords;
      }
    } else {
      const h = heuristicSummary(title, body);
      summary = h.summary;
      keywords = h.keywords;
    }

    const host = hostOnly(link);
    const confidence = confidenceScore(summary, host);

    out.push({
      title,
      link,
      published: it.published || "",
      source: host,
      summary,
      keywords,
      confidence,
    });
  }
  return out;
}

async function aiSummarize(API_KEY, title, text) {
  const prompt = [
    "You are an editorial desk summarizer.",
    "Write a concise, trustworthy, *original* news-style brief (120–180 words) for executives.",
    "No bullet lists. 2–4 short paragraphs. No fluff. No quotes.",
    "End with one line exactly: SEO KEYWORDS: kw1; kw2; kw3; kw4; kw5",
    "",
    `TITLE: ${title}`,
    "ARTICLE:",
    text,
  ].join("\n");

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.5,
      max_output_tokens: 500,
    }),
  });
  if (!r.ok) {
    throw new Error(`OpenAI ${r.status}`);
  }
  const data = await r.json();
  const full = (data?.output_text || "").trim();
  const { body, kw } = splitKeywords(full);
  return { summary: body, keywords: kw };
}

function heuristicSummary(title, text) {
  const sents = (text.match(/[^.!?]+[.!?]+/g) || text.split(".")).map((s) => collapseSpaces(s));
  const picked = sents.slice(0, 4).join(" ");
  const kw = topKeywords(text, 5);
  return { summary: picked, keywords: kw };
}

function splitKeywords(full) {
  const m = full.match(/^\s*SEO KEYWORDS:\s*(.+)$/im);
  if (!m) {
    return { body: full.replace(/\n{3,}/g, "\n\n").trim(), kw: [] };
  }
  const body = full.slice(0, m.index).trim();
  const tail = m[1] || "";
  const kw = tail.split(/[;,]/g).map((x) => x.trim()).filter(Boolean).slice(0, 5);
  return { body, kw };
}

function topKeywords(text, k = 5) {
  const STOP = new Set(
    "a,an,the,of,in,on,for,with,and,or,to,from,by,as,is,are,was,were,be,been,at,that,this,these,those,it,its,their,his,her,our,your,not,no,if,then,than,but,so,also,into,over,under,about,via,per,within,without,across,between,among,will,can,may,might,could,should,would"
      .split(",")
  );
  const bag = (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w) && w.length > 2);
  const freq = new Map();
  for (const w of bag) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map((x) => x[0]);
}

/* Confidence heuristic */
function confidenceScore(text, host = "") {
  const POS = new Set("confirm,confirmed,official,approved,announced,launch,launched,records,record,acquires,acquired,sec,filing,final,definitive,report,results".split(","));
  const NEG = new Set("may,might,could,reportedly,rumor,alleged,seems,suggests,likely,unverified,investigating,unclear,disputed,questioned,unconfirmed".split(","));
  const bag = (text.toLowerCase().match(/[a-z0-9]+/g) || []);
  let pos = 0, neg = 0;
  for (const w of bag) { if (POS.has(w)) pos++; if (NEG.has(w)) neg++; }
  let score = 52 + 6 * pos - 6 * neg;
  if (/nytimes\.com|washingtonpost\.com|reuters\.com|apnews\.com|bbc\.co\.uk|bbc\.com/i.test(host)) score += 6;
  return Math.max(0, Math.min(100, score));
}
