// workers/gozaddy/worker.js
// Minimal RSS → AI summary → hourly cache
// Bindings required:
//  - env.OPENAI_API_KEY (secret)
//  - env.SUM_CACHE (KV namespace)
// Optional:
//  - env.MODEL (default "gpt-4.1-mini")
//  - env.FEEDS_CSV (comma-separated feed URLs)

const DEFAULT_FEEDS = [
  "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
  "https://feeds.washingtonpost.com/rss/national",
  "https://www.forbes.com/most-popular/feed/"
];

const SUMMARIES_PER_FEED = 3;      // take top N per feed
const CACHE_TTL_MINUTES  = 60;     // hard hourly throttle

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/summaries") {
      return handleSummaries(req, env, url);
    }
    return new Response(JSON.stringify({ ok: true, hint: "GET /summaries" }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
};

async function handleSummaries(req, env, url) {
  // Cache key rolls up by hour to enforce 1/hr refresh
  const now = new Date();
  const hourKey = `${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,"0")}${String(now.getUTCDate()).padStart(2,"0")}${String(now.getUTCHours()).padStart(2,"0")}`;
  const cacheKey = `summaries:v1:${hourKey}`;

  // serve cached if present
  const cached = await env.SUM_CACHE.get(cacheKey);
  if (cached) {
    return new Response(cached, { headers: { "content-type": "application/json; charset=utf-8", "x-cache": "HIT" }});
  }

  const feeds = (env.FEEDS_CSV ? env.FEEDS_CSV.split(",").map(s=>s.trim()).filter(Boolean) : DEFAULT_FEEDS);
  const allItems = [];
  for (const f of feeds) {
    try {
      const xml = await (await fetch(f, { headers: { "user-agent": "GoZaddy/1.0" }})).text();
      const items = parseRSSorAtom(xml).slice(0, SUMMARIES_PER_FEED);
      allItems.push(...items);
    } catch (e) {
      // swallow feed errors but include marker item
      allItems.push({ title: `[Feed error] ${f}`, link: f, published: "", text: "Failed to fetch feed." });
    }
  }

  // Pull article text (simple HTML-strip)
  for (const it of allItems) {
    if (!it.link) { it.text = it.text || ""; continue; }
    try {
      const resp = await fetch(it.link, { headers: { "user-agent": "GoZaddy/1.0" }});
      const html = await resp.text();
      it.text = stripTags(html).slice(0, 30_000);  // keep prompt tidy
    } catch {
      it.text = it.text || "";
    }
  }

  // Call OpenAI for concise summaries
  const model = env.MODEL || "gpt-4.1-mini";
  const payload = await buildAISummaries(allItems, model, env.OPENAI_API_KEY);

  // cache ~1h (KV TTL in minutes is set via expiration)
  await env.SUM_CACHE.put(cacheKey, JSON.stringify(payload), {
    expirationTtl: CACHE_TTL_MINUTES * 60
  });

  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json; charset=utf-8", "x-cache": "MISS" }
  });
}

/* ---------- helpers ---------- */

function parseRSSorAtom(xml) {
  // quick-and-tolerant parse for <item> or <entry>
  const items = [];
  const isRSS = /<rss|<channel/i.test(xml);
  const blocks = [...xml.matchAll(new RegExp(isRSS ? "<item[\\s\\S]*?<\\/item>" : "<entry[\\s\\S]*?<\\/entry>", "gi"))].map(m=>m[0]);
  for (const b of blocks) {
    const title = unescapeHTML(grabTag(b, "title"));
    const link  = isRSS ? unescapeHTML(grabTag(b, "link")) : grabAttr(b, "link", "href") || unescapeHTML(grabTag(b, "link"));
    const pub   = unescapeHTML(grabTag(b, isRSS ? "pubDate" : "updated"));
    items.push({ title, link, published: pub });
  }
  return items;
}
function grabTag(block, tag) {
  // handles CDATA too
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  const v = m[1].replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, "$1");
  return v.trim();
}
function grabAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*?${attr}="([^"]+)"[^>]*>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}
function stripTags(html) {
  return html
    .replace(/<script[\\s\\S]*?<\\/script>/gi, " ")
    .replace(/<style[\\s\\S]*?<\\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \\t\\f\\v]+/g, " ")
    .replace(/\\s*\\n\\s*/g, "\n")
    .trim();
}
function unescapeHTML(s){return (s||"")
  .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&quot;/g,'"').replace(/&#39;/g,"'");}

async function buildAISummaries(items, model, apiKey){
  const out = [];
  for (const it of items) {
    const prompt = `You are a crisp newsroom analyst. Write a SHORT, operator-friendly summary for the article below.\n\nRules:\n- 6–10 tight bullet lines, ASCII only.\n- No fluff, no quotes, no sensationalism.\n- Include 1 line: "SEO: kw1; kw2; kw3; kw4; kw5"\n- Output only the bullets and SEO line. No intro text.\n\nTITLE: ${it.title}\nURL: ${it.link}\nPUBLISHED: ${it.published}\nARTICLE TEXT (may be partial):\n${it.text || "(no body available)"}\n`;
    let summary = "";
    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: prompt,
          temperature: 0.5,
          max_output_tokens: 500
        })
      });
      const j = await r.json();
      summary = (j.output_text || "").trim();
    } catch {
      summary = "- Summary unavailable.\nSEO: placeholder; keywords; pending; retry; later";
    }
    out.push({
      title: it.title,
      link: it.link,
      published: it.published,
      summary
    });
  }
  return { generated_at: new Date().toISOString(), items: out };
}
