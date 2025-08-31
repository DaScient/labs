/**
 * GoZaddy Worker (Full)
 * Endpoints:
 *   GET  /summaries?feeds=<csv>&feedsUrl=<txt_url>&limit=25&interval=3600
 *   GET  /ascii?feeds=<csv>&feedsUrl=<txt_url>&limit=25&interval=3600
 *   POST /prompts { title, summary, link, perspectives:[], platform, tone, minWords, maxWords }
 *   GET  /health
 *
 * Notes:
 * - Caches responses for `interval` seconds via Cloudflare edge cache.
 * - Always returns CORS headers.
 * - CDATA cleaned; Atom & RSS supported; basic description→summary fallback.
 * - Dedupes by (title|link) and sorts by published desc.
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/health") {
        return withCORS(json({ ok: true, ts: Date.now() }));
      }

      if (path === "/summaries") {
        return await handleSummaries(request, env, ctx);
      }

      if (path === "/ascii") {
        return await handleAscii(request, env, ctx);
      }

      if (path === "/prompts" && request.method === "POST") {
        return await handlePrompts(request, env);
      }

      return withCORS(text("Not found", 404));
    } catch (err) {
      return withCORS(json({ ok: false, error: String(err?.message || err) }, 500));
    }
  },
};

/* ------------- Core handlers ------------- */

async function handleSummaries(request, env, ctx) {
  const u = new URL(request.url);
  const { items, modelUsed } = await loadItemsCached(u, env, ctx);

  const limit = clampInt(u.searchParams.get("limit"), 1, 200, 50);
  const out = items.slice(0, limit);

  return withCORS(
    json({
      ok: true,
      count: out.length,
      model: modelUsed || "open",
      items: out,
      ts: Date.now(),
    })
  );
}

async function handleAscii(request, env, ctx) {
  const u = new URL(request.url);
  const { items } = await loadItemsCached(u, env, ctx);
  const limit = clampInt(u.searchParams.get("limit"), 1, 200, 40);

  const body = renderAscii(items.slice(0, limit), {
    header: "AI-Generated News Summaries (ASCII)",
    footer: "(Updates per cache interval; sources via worker)",
  });
  return withCORS(text(body));
}

async function handlePrompts(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    // ignore; will validate below
  }

  const {
    title = "",
    summary = "",
    link = "",
    perspectives = [],
    platform = "Medium",
    tone = "authoritative",
    minWords = 800,
    maxWords = 1200,
  } = body || {};

  const results = await generateCreatorPrompts(
    { title, summary, link, perspectives, platform, tone, minWords, maxWords },
    env
  );

  return withCORS(json({ ok: true, results, ts: Date.now() }));
}

/* ------------- Cached loader ------------- */

async function loadItemsCached(u, env, ctx) {
  const cache = caches.default;
  const interval = clampInt(u.searchParams.get("interval"), 60, 86400, 3600);
  const cacheKey = new Request(cacheKeyFromURL(u), { method: "GET" });

  // Try cache
  const cached = await cache.match(cacheKey);
  if (cached) {
    const j = await cached.json();
    return j; // { items, modelUsed }
  }

  // Build feed list
  const feedsCsv = u.searchParams.get("feeds") || "";
  const feedsUrl = u.searchParams.get("feedsUrl");
  const feeds = await resolveFeeds({ feedsCsv, feedsUrl });

  // Pull & parse
  const rawItems = [];
  await Promise.all(
    feeds.map(async (src) => {
      try {
        const res = await fetch(src, {
          headers: {
            "User-Agent": "GoZaddy/1.0 (Cloudflare Worker; RSS fetcher)",
            "Accept": "application/rss+xml, application/atom+xml, text/xml, text/html",
          },
          cf: { cacheEverything: false },
        });
        const txt = await res.text();
        const parsed = parseAnyFeed(txt, src);
        rawItems.push(...parsed);
      } catch (e) {
        // Collect a synthetic error item (won't usually appear unless debugging)
        // rawItems.push({ title:`[Feed error] ${src}`, link:"", published_ts:0, summary:String(e) });
      }
    })
  );

  // Clean, dedupe, sort
  const cleaned = rawItems.map(cleanItem).filter((it) => it.title || it.summary);
  const deduped = dedupeItems(cleaned);
  deduped.sort((a, b) => (b.published_ts || 0) - (a.published_ts || 0));

  const payload = { items: deduped, modelUsed: "open" };

  // Cache JSON
  const resp = new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${interval}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));

  return payload;
}

/* ------------- Feeds utils ------------- */

async function resolveFeeds({ feedsCsv, feedsUrl }) {
  // If feedsUrl is given, fetch newline-delimited list
  if (feedsUrl) {
    try {
      const r = await fetch(feedsUrl, { cf: { cacheEverything: true, cacheTtl: 900 } });
      if (r.ok) {
        const t = await r.text();
        const arr = t
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#"));
        if (arr.length) return arr;
      }
    } catch (_) {}
  }

  // Else, CSV from query
  if (feedsCsv) {
    const arr = feedsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (arr.length) return arr;
  }

  // Fallback curated minimal set (stable public feeds)
  return [
    "https://feeds.reuters.com/reuters/topNews",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://feeds.bbci.co.uk/news/rss.xml",
    "https://rss.dw.com/rdf/rss-en-all",
    "https://www.nytimes.com/services/xml/rss/nyt/HomePage.xml",
  ];
}

/* ------------- Parsing (RSS + Atom) ------------- */

function parseAnyFeed(xml, sourceUrl) {
  const items = [];

  // Detect Atom vs RSS quickly
  const isAtom = /<feed[\s>]/i.test(xml) && /<\/feed>/i.test(xml);
  const isRss = /<rss[\s>]/i.test(xml) || /<rdf:RDF/i.test(xml) || /<channel>/i.test(xml);

  if (isAtom) {
    // Atom: <entry><title>, <link href>, <updated>, <summary>/<content>
    const entryRe = /<entry\b[\s\S]*?<\/entry>/gi;
    const linkHref = (block) => {
      // Prefer link rel="alternate", else first href
      const alt = block.match(/<link[^>]*?rel=["']alternate["'][^>]*?href=["']([^"']+)["']/i);
      if (alt) return alt[1];
      const any = block.match(/<link[^>]*?href=["']([^"']+)["']/i);
      return any ? any[1] : "";
    };

    let m;
    while ((m = entryRe.exec(xml))) {
      const block = m[0];
      const title = innerText(block, "title");
      const link = linkHref(block);
      const updated = innerText(block, "updated") || innerText(block, "published") || "";
      const summary = innerText(block, "summary") || innerText(block, "content") || "";
      items.push({
        source: sourceUrl,
        title,
        link,
        published: updated,
        summary,
      });
    }
  } else if (isRss) {
    // RSS: <item><title>, <link>, <pubDate>, <description> or <content:encoded>
    const itemRe = /<item\b[\s\S]*?<\/item>/gi;
    let m;
    while ((m = itemRe.exec(xml))) {
      const block = m[0];
      const title = innerText(block, "title");
      const link = innerText(block, "link") || smartLinkFromGuid(block);
      const pubDate = innerText(block, "pubDate") || innerText(block, "dc:date") || "";
      const contentEnc = innerText(block, "content:encoded");
      const desc = innerText(block, "description");
      const summary = contentEnc || desc || "";
      items.push({
        source: sourceUrl,
        title,
        link,
        published: pubDate,
        summary,
      });
    }

    // Some “RSS-like” pages use <entry> too (fallback)
    if (items.length === 0) {
      const entryRe = /<entry\b[\s\S]*?<\/entry>/gi;
      let em;
      while ((em = entryRe.exec(xml))) {
        const block = em[0];
        const title = innerText(block, "title");
        const link = innerText(block, "link") || smartLinkFromGuid(block);
        const updated = innerText(block, "updated") || innerText(block, "published") || "";
        const summary = innerText(block, "summary") || innerText(block, "content") || "";
        items.push({
          source: sourceUrl,
          title,
          link,
          published: updated,
          summary,
        });
      }
    }
  }

  return items;
}

function innerText(block, tag) {
  // Get tag content; handle CDATA
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return cleanCDATA(stripTags(m[1] || "")).trim();
}

function smartLinkFromGuid(block) {
  const m = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
  if (!m) return "";
  const t = cleanCDATA(m[1] || "").trim();
  if (/^https?:\/\//i.test(t)) return t;
  return "";
}

function cleanCDATA(t) {
  return t.replace(/<!\[CDATA\[(.*?)\]\]>/gis, "$1");
}

function stripTags(html) {
  // Keep a minimal text from HTML
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function cleanItem(it) {
  const title = (it.title || "").replace(/<!\[CDATA\[(.*?)\]\]>/gi, "$1").replace(/\s+/g, " ").trim();
  const link = (it.link || "").trim();
  const host = hostOf(link);
  const published = it.published || "";
  const ts = dateToTs(published);
  const summary = smartSummary(it.summary || "", title);

  return {
    title,
    link,
    published: published,
    published_ts: ts,
    host,
    summary,
    top_terms: extractTopTerms(`${title} ${summary}`),
    confidence: confidenceScore(`${title} ${summary}`, host),
  };
}

function dedupeItems(items) {
  const map = new Map();
  for (const it of items) {
    const key = `${(it.title || "").toLowerCase()}|${(it.link || "").toLowerCase()}`;
    if (!map.has(key)) map.set(key, it);
  }
  return Array.from(map.values());
}

/* ------------- ASCII render ------------- */

function renderAscii(items, { header, footer }) {
  const lines = [];
  lines.push("=".repeat(66));
  lines.push(center(header || "GoZaddy ASCII"));
  lines.push("=".repeat(66));
  lines.push("");

  for (const it of items) {
    lines.push(`${it.title}`);
    lines.push("-".repeat(Math.min(80, Math.max(20, it.title.length))));
    if (it.link) lines.push(`Link: ${it.link}`);
    if (it.published) lines.push(`Published: ${it.published}`);
    if (it.host) lines.push(`Source: ${it.host}`);
    lines.push("");
    if (it.summary) {
      lines.push(wrap(it.summary, 90));
      lines.push("");
    }
    if (it.top_terms?.length) {
      lines.push("Top terms: " + it.top_terms.slice(0, 10).join(", "));
    }
    lines.push(`Confidence: ${it.confidence}`);
    lines.push("-".repeat(66));
    lines.push("");
  }

  if (footer) {
    lines.push(footer);
  }
  return lines.join("\n");
}

/* ------------- Creator prompts (OpenAI) ------------- */

async function generateCreatorPrompts(
  { title, summary, link, perspectives, platform, tone, minWords, maxWords },
  env
) {
  const chosen = Array.isArray(perspectives) ? perspectives.filter(Boolean) : [];
  const out = [];
  const apiKey = env.OPENAI_API_KEY;
  const models = (env.MODEL_LIST || "gpt-4.1-mini,gpt-4o-mini,gpt-4.1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const cleanTitle = (t) => (t || "").replace(/<!\[CDATA\[(.*?)\]\]>/gi, "$1").replace(/\s+/g, " ").trim();

  for (let i = 0; i < chosen.length; i++) {
    const perspective = chosen[i];
    const model = models[i % models.length];
    const titleClean = cleanTitle(title);

    if (!apiKey) {
      out.push({
        perspective,
        model: "fallback",
        prompt: fallbackCreatorPrompt({
          title: titleClean,
          summary,
          link,
          platform,
          tone,
          minWords,
          maxWords,
          perspective,
        }),
      });
      continue;
    }

    const sys = `You craft short, high-signal PROMPTS for other AI assistants to generate publish-ready articles.
The prompt must be article-aware, perspective-specific, concise (~180-260 words), and strictly formatted for easy copy/paste.`;

    const user = `
ARTICLE
- Headline: ${titleClean}
- Brief: ${summary || "(none)"}
- Source URL: ${link || "(none)"}

TARGET
- Platform: ${platform}
- Perspective: ${perspective}
- Tone: ${tone}
- Target length: ${minWords}-${maxWords} words

WRITE ONE PROMPT (nothing else) that instructs an AI to produce a single, publication-quality article tailored to this perspective and platform.

Your prompt MUST:
- Start with: "You are a ${tone} ${perspective} expert writing for ${platform}."
- Include a 1-2 line context recap grounded in the ARTICLE.
- Define objective/outcome (bullet list).
- Specify structure: Title (SEO), Dek, TL;DR, 3–6 H2 sections with H3s, 1 pull-quote, Conclusion/CTA.
- Demand concrete details, numbers, timelines, and sourcing if available from the link.
- Require an "At-a-glance" bullet capsule.
- Require metadata: 8–12 SEO keywords; 6–12 platform-appropriate hashtags.
- Require internal/external links (when link is provided).
- Enforce guardrails: attribute uncertainty; avoid speculation; no hallucinated facts.
- End with a clean output format checklist (markdown headings).

Return ONLY the prompt text.`;

    try {
      const promptText = await openAI_prompt(env.OPENAI_API_KEY, model, sys, user);
      out.push({ perspective, model, prompt: (promptText || "").trim() });
    } catch (e) {
      out.push({
        perspective,
        model,
        error: String(e?.message || e),
        prompt: fallbackCreatorPrompt({
          title: titleClean,
          summary,
          link,
          platform,
          tone,
          minWords,
          maxWords,
          perspective,
        }),
      });
    }
  }
  return out;
}

function fallbackCreatorPrompt({ title, summary, link, platform, tone, minWords, maxWords, perspective }) {
  return [
    `You are a ${tone} ${perspective} expert writing for ${platform}.`,
    `Context: "${title}". ${summary ? "Brief: " + summary : ""} ${link ? "Source: " + link : ""}`,
    `Objective: Produce a ${minWords}-${maxWords} word article that is publication-ready for ${platform}.`,
    `Structure:`,
    `- Title (SEO-optimized)`,
    `- Dek (1–2 lines)`,
    `- TL;DR (3 bullets)`,
    `- H2 Sections (3–6) with H3 subpoints; include data, dates, examples`,
    `- Pull-quote (1)`,
    `- Conclusion / Next Steps / CTA`,
    `- At-a-glance (bulleted summary)`,
    `Metadata: Provide 8–12 SEO keywords and 6–12 hashtags relevant to ${perspective} and the topic.`,
    `Guardrails: Attribute uncertainty; do not invent facts; link to ${link || "relevant sources"} where appropriate.`,
    `Output: Markdown only.`,
  ].join("\n");
}

async function openAI_prompt(apiKey, model, systemText, userText) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: systemText },
        { role: "user", content: userText },
      ],
      temperature: 0.6,
      top_p: 0.9,
      max_output_tokens: 520,
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const j = await r.json();
  return j.output_text || "";
}

/* ------------- Scoring / text utils ------------- */

function confidenceScore(text, sourceHost = "") {
  const POS = new Set(
    "confirm,confirmed,official,approved,announced,launch,launched,records,record,acquires,acquired,sec filing,final,definitive,report,results".split(
      ","
    )
  );
  const NEG = new Set(
    "may,might,could,reportedly,rumor,alleged,seems,suggests,likely,unverified,investigating,unclear,disputed,questioned,unconfirmed".split(
      ","
    )
  );
  const bag = (text.toLowerCase().match(/[a-z0-9]+/g) || []);
  let pos = 0,
    neg = 0;
  for (const w of bag) {
    if (POS.has(w)) pos++;
    if (NEG.has(w)) neg++;
  }
  let score = 52 + 6 * pos - 6 * neg;
  if (/nytimes\.com|washingtonpost\.com|reuters\.com|bbc\.co\.uk|aljazeera\.com/i.test(sourceHost)) score += 6;
  return Math.max(0, Math.min(100, score));
}

function extractTopTerms(text, k = 10) {
  const STOP = new Set(
    `a,an,the,of,in,on,for,with,and,or,to,from,by,as,is,are,was,were,be,been,at,that,this,these,those,it,its,their,his,her,our,your,not,no,if,then,than,but,so,also,into,over,under,about,via,per,within,without,across,between,among,will,can,may,might,could,should,would,update,news,report,brief,said,says`
      .split(",")
  );
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w) && w.length > 2);
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map((x) => x[0]);
}

function smartSummary(desc, title) {
  const t = desc.replace(/\s+/g, " ").trim();
  if (!t) return (title || "").substring(0, 240);
  // Strip leading "SUMMARY" labels if present
  return t.replace(/^summary\s*[:\-]\s*/i, "").trim();
}

function dateToTs(s) {
  if (!s) return 0;
  const d = new Date(s);
  const n = d.getTime();
  if (!isNaN(n)) return n;
  // try RFC822 variants
  const alt = Date.parse(s.replace(/^\w{3},\s*/, ""));
  return isNaN(alt) ? 0 : alt;
}

function hostOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function wrap(txt, width = 80) {
  return (txt || "")
    .split(/\s+/)
    .reduce(
      (acc, w) => {
        const line = acc[acc.length - 1];
        if ((line + " " + w).trim().length > width) acc.push(w);
        else acc[acc.length - 1] = (line + " " + w).trim();
        return acc;
      },
      [""]
    )
    .join("\n");
}

function center(s, w = 66) {
  const t = s || "";
  if (t.length >= w) return t;
  const pad = Math.floor((w - t.length) / 2);
  return " ".repeat(pad) + t;
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v || "", 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return dflt;
}

function cacheKeyFromURL(u) {
  // Do not include cache-busters (e.g., _t)
  const copy = new URL(u.toString());
  copy.searchParams.delete("_t");
  return copy.toString();
}

/* ------------- Response helpers ------------- */

function withCORS(resp) {
  const r = new Response(resp.body, resp);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return r;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(s, status = 200) {
  return new Response(typeof s === "string" ? s : String(s), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
