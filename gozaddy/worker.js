export default {
  async fetch(req, env, ctx) {
    try {
      if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "");

      if (path === "" || path === "/") {
        return cors(json({ ok: true, name: "GoZaddy Summarizer Worker" }));
      }
      if (path === "/health") return cors(json({ ok: true }));

      if (path === "/summaries") {
        const data = await handleSummaries(url, env);
        return cors(json(data), /* ttl */ url.searchParams.get("interval"));
      }

      if (path === "/ascii") {
        const data = await handleSummaries(url, env);
        const body = toASCII(data.items, data.meta);
        return cors(text(body), /* ttl */ url.searchParams.get("interval"));
      }

      return cors(text("Not found", 404));
    } catch (e) {
      console.error(e);
      return cors(text("Worker error", 500));
    }
  }
};

/* ===================== Core handlers ===================== */

async function handleSummaries(url, env) {
  const feeds = getFeeds(url);
  const limit = clamp(int(url.searchParams.get("limit"), 24), 3, 60);
  const interval = clamp(int(url.searchParams.get("interval"), 3600), 300, 21600); // 5m–6h
  const style = (url.searchParams.get("style") || "strategic").toLowerCase();
  const length = (url.searchParams.get("length") || "short").toLowerCase(); // short|medium|long
  const modelHint = (url.searchParams.get("model") || "auto").toLowerCase();

  const xmlItems = await collectRecentItems(feeds, limit);
  const models = getModelRing(env, modelHint);
  const items = [];
  for (const it of xmlItems) {
    const fp = sha256(it.link || it.title || it.guid || Math.random().toString(36));
    const cacheKey = new Request(`https://cache.local/sum/${fp}?len=${length}&sty=${style}`);
    const cached = await caches.default.match(cacheKey);

    if (cached) {
      const obj = await cached.json();
      items.push({ ...obj, cached: true });
      continue;
    }

    // choose model deterministically; fallback if needed
    const model = pickModel(models, fp);
    const allModels = cycleFrom(models, model);
    let summaryText = "";
    let modelUsed = model;
    let lastErr = null;

    for (const m of allModels) {
      try {
        summaryText = await summarizeWithOpenAI(env, m, it, style, length);
        modelUsed = m;
        break;
      } catch (e) {
        lastErr = e;
        // try next model on rate limit or 5xx / network
        continue;
      }
    }
    if (!summaryText) {
      // total failure: degrade gracefully to a trimmed feed description
      summaryText = degradeSummary(it);
      modelUsed = "fallback";
      console.warn("FALLBACK summary used for:", it.link || it.title, lastErr?.message);
    }

    const keywords = parseSEOKeywords(summaryText);
    const host = safeHost(it.link);
    const confidence = heuristicConfidence(summaryText, host);
    const obj = {
      id: fp,
      title: it.title,
      link: it.link,
      published: it.published,
      host,
      summary: cleanLines(summaryText),
      keywords,
      confidence,
      model: modelUsed,
      createdAt: new Date().toISOString(),
      cached: false
    };

    const res = json(obj);
    res.headers.set("Cache-Control", `public, s-maxage=${interval}`);
    await caches.default.put(cacheKey, res.clone());

    items.push(obj);
  }

  return {
    ok: true,
    meta: { feeds, limit, interval, style, length, modelStrategy: modelHint },
    items
  };
}

/* ===================== OpenAI ===================== */

async function summarizeWithOpenAI(env, model, item, style, length) {
  const sys = promptSystem(style, length);
  const usr = promptUser(item);

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: sys },
        { role: "user", content: usr }
      ],
      max_output_tokens: targetTokens(length),
      temperature: 0.4,
      top_p: 0.9
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI ${resp.status}: ${t.slice(0, 300)}`);
  }

  const data = await resp.json();
  const out = (data.output_text || "").trim();
  if (!out) throw new Error("Empty OpenAI output");
  return out;
}

function promptSystem(style, length) {
  const lenMap = {
    short: "≈120–180 words",
    medium: "≈220–350 words",
    long: "≈400–650 words"
  };
  const tone = {
    strategic:
      "Be concise, executive-ready. Neutral but decisive. Include key facts only, avoid fluff.",
    neutral:
      "Straight newswire tone. No opinion. Focus strictly on what happened and context.",
    bullet:
      "Return compact bullet points. Each bullet single line, lead with a strong noun/verb.",
    editorial:
      "Analytical magazine tone. Provide brief context and significance without advocacy."
  }[style] || "Neutral, concise.";

  return `You are a world-class news analyst.
- Summarize the article in ${lenMap[length] || lenMap.short}.
- ${tone}
- Use ASCII only. No emojis.
- Begin with a one-sentence lead.
- Then 3–5 crisp lines expanding the core.
- End with a single line starting with: SEO KEYWORDS: kw1; kw2; kw3; kw4; kw5
- Do not repeat the title verbatim in the body.`;
}

function promptUser(item) {
  const clean = (item.summary || item.description || "").slice(0, 4000);
  return `TITLE: ${item.title}
URL: ${item.link || ""}
PUBLISHED: ${item.published || ""}

FEED BODY (may be partial; paraphrase, don't copy):
"""
${clean}
"""`;
}

/* ===================== RSS utils ===================== */

async function collectRecentItems(feeds, limit) {
  const results = [];
  await Promise.all(
    feeds.map(async (f) => {
      try {
        const r = await fetch(f, { cf: { cacheTtl: 300 }, headers: { "Accept": "application/rss+xml, application/atom+xml, text/xml;q=0.9" } });
        const xml = await r.text();
        const parsed = parseFeed(xml).map(x => ({ ...x, feed: f }));
        results.push(...parsed);
      } catch (e) {
        console.warn("Feed error", f, e.message);
      }
    })
  );
  // sort by published desc if available
  results.sort((a, b) => (Date.parse(b.published || "0") || 0) - (Date.parse(a.published || "0") || 0));
  // de-dupe by link+title
  const seen = new Set();
  const uniq = [];
  for (const it of results) {
    const k = `${(it.link || "").toLowerCase()}|${(it.title || "").toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
    if (uniq.length >= limit) break;
  }
  return uniq;
}

function parseFeed(xml) {
  const items = [];
  const cleaned = xml.replace(/\r/g, "");
  // RSS <item>
  const rss = cleaned.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of rss) items.push(parseItemBlock(block, false));

  // Atom <entry>
  const atom = cleaned.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of atom) items.push(parseItemBlock(block, true));

  return items.filter(Boolean);
}

function parseItemBlock(block, isAtom) {
  const title = stripCDATA(tag(block, "title"));
  let link = "";
  if (isAtom) {
    const href = attr(block, "link", "href");
    link = href || stripCDATA(tag(block, "link"));
  } else {
    link = stripCDATA(tag(block, "link"));
  }
  const guid = stripCDATA(tag(block, "guid")) || stripCDATA(tag(block, "id"));
  const pub = stripCDATA(tag(block, isAtom ? "updated" : "pubDate"));
  const summary = stripCDATA(tag(block, "description")) || stripCDATA(tag(block, "summary"));
  return {
    title: decodeEntities(title || "").trim(),
    link: (link || "").trim(),
    guid,
    published: normalizeDate(pub),
    description: decodeEntities(summary || "")
  };
}

function tag(s, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = s.match(re);
  return m ? m[1] : "";
}
function attr(s, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, "i");
  const m = s.match(re);
  return m ? m[1] : "";
}
function stripCDATA(t) {
  if (!t) return "";
  return t.replace(/<!\[CDATA\[(.*?)\]\]>/gis, "$1");
}
function decodeEntities(s) {
  if (!s) return "";
  const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  s = s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, p1) => {
    if (map[p1]) return map[p1];
    if (p1[0] === "#") {
      const n = p1[1]?.toLowerCase() === "x" ? parseInt(p1.slice(2), 16) : parseInt(p1.slice(1), 10);
      return String.fromCodePoint(isFinite(n) ? n : 0x20);
    }
    return m;
  });
  return s;
}
function normalizeDate(d) {
  const t = Date.parse(d || "");
  if (!t) return "";
  return new Date(t).toUTCString();
}

/* ===================== Heuristics & helpers ===================== */

function degradeSummary(it) {
  const body = (it.description || "").replace(/\s+/g, " ").trim();
  return [
    `${it.title}`,
    body ? body.slice(0, 300) + (body.length > 300 ? "…" : "") : "",
    "",
    "SEO KEYWORDS: news; update; world; report; brief"
  ].filter(Boolean).join("\n");
}

function parseSEOKeywords(txt) {
  const m = txt.match(/^\s*seo keywords:\s*(.+)$/gim);
  if (!m) return [];
  const line = m[m.length - 1];
  const list = (line.split(":")[1] || "").trim();
  return list.split(/[;,]/g).map(s => s.trim()).filter(Boolean).slice(0, 8);
}

function heuristicConfidence(text, host = "") {
  const pos = ["confirmed", "official", "launched", "records", "acquired", "results", "sec", "filing", "verdict"];
  const neg = ["may", "might", "could", "reportedly", "alleged", "unverified", "unclear", "disputed", "questioned"];
  const lc = text.toLowerCase();
  let score = 52;
  for (const w of pos) if (lc.includes(w)) score += 4;
  for (const w of neg) if (lc.includes(w)) score -= 4;
  if (/(nytimes|washingtonpost|reuters|bbc|apnews|aljazeera)\./i.test(host)) score += 6;
  return Math.max(0, Math.min(100, score));
}

function safeHost(u = "") {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function targetTokens(length) {
  return { short: 500, medium: 900, long: 1400 }[length] || 500;
}

/* ===================== Model ring ===================== */

function getModelRing(env, hint) {
  const list = (env.OPENAI_MODELS || "").split(",").map(s => s.trim()).filter(Boolean);
  const def = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o", "gpt-4.1"];
  const ring = (list.length ? list : def).filter(Boolean);
  if (!ring.length) ring.push("gpt-4o-mini");
  if (hint && hint !== "auto") return [hint, ...ring.filter(m => m !== hint)];
  return ring;
}
function pickModel(ring, key) {
  const h = hash32(key);
  return ring[h % ring.length];
}
function cycleFrom(ring, start) {
  const i = ring.indexOf(start);
  if (i <= 0) return ring;
  return [...ring.slice(i), ...ring.slice(0, i)];
}

/* ===================== ASCII packer ===================== */

function toASCII(items, meta) {
  const head = [
    "================= AI-GENERATED NEWS SUMMARIES ================",
    `Window interval: ${meta.interval}s | Style: ${meta.style} | Length: ${meta.length} | Model: ${meta.modelStrategy}`,
    "--------------------------------------------------------------",
    ""
  ].join("\n");

  const bodies = items.map(a => {
    const metaLine = `${a.title} | ${a.link || ""} | ${a.published || ""}`;
    const sepShort = "-".repeat(Math.max(24, Math.min(80, metaLine.length)));
    const block = [
      metaLine,
      sepShort,
      a.summary.trim(),
      "",
      `Model: ${a.model} | Confidence: ${a.confidence} | Host: ${a.host}`,
      "-".repeat(72)
    ];
    return block.join("\n");
  });

  const foot = "\n(Updates hourly if interval=3600. ASCII stream)\n";
  return head + bodies.join("\n") + foot;
}

/* ===================== small utils ===================== */

function int(x, d = 0) { const n = parseInt(x || "", 10); return Number.isFinite(n) ? n : d; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function cleanLines(t) { return (t || "").replace(/\n{3,}/g, "\n\n").trim(); }
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function sha256(s) {
  const enc = new TextEncoder().encode(s);
  return crypto.subtle.digest("SHA-256", enc).then(b => {
    const a = Array.from(new Uint8Array(b));
    return a.map(x => x.toString(16).padStart(2, "0")).join("");
  });
}

/* ===================== CORS & responses ===================== */

function cors(res, ttl) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (ttl) res.headers.set("Cache-Control", `public, s-maxage=${int(ttl, 3600)}`);
  return res;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/* ===================== Feeds ===================== */

function getFeeds(url) {
  const param = url.searchParams.get("feeds");
  if (param) {
    return param.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  }
  // default worldwide set
  return [
    "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
    "https://feeds.washingtonpost.com/rss/national",
    "https://www.forbes.com/most-popular/feed/",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://feeds.bbci.co.uk/news/rss.xml",
    "https://www.npr.org/rss/rss.php?id=1001",
    "https://www.reuters.com/rss/worldNews",
    "https://apnews.com/hub/apf-topnews?utm_source=ap_rss&utm_medium=rss",
    "https://www.theguardian.com/world/rss",
    "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "https://www.ft.com/world?format=rss"
  ];
}
