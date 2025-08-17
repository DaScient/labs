// worker.js — Worldwide Intel Coverage API (ODNI-aligned)
// Deploy on Cloudflare Workers
// Routes:
//   GET  /api/health
//   GET  /api/feeds?sinceHours=24&limit=60
//   GET  /api/clusters?sinceHours=24
//   GET  /api/feargreed
//   GET  /api/live
//   OPTIONS * (CORS preflight)
// Notes:
// - Uses official RSS endpoints for BBC, Reuters, Al Jazeera, and CNN.
// - Adds simple NIPF-aligned topic tagging + impact/urgency/confidence scoring.
// - Returns CORS headers so any origin (your dashboard) can fetch JSON.

const FEEDS = [
  { src: "BBC",       url: "https://feeds.bbci.co.uk/news/world/rss.xml",        weight: 0.95 },
  { src: "Reuters",   url: "https://feeds.reuters.com/Reuters/worldNews",        weight: 0.98 },
  { src: "AlJazeera", url: "https://www.aljazeera.com/xml/rss/all.xml",          weight: 0.90 },
  { src: "CNN",       url: "http://rss.cnn.com/rss/edition_world.rss",           weight: 0.90 }
];

// Minimal NIS/NIPF-aligned topic dictionary (expand as needed)
const TOPICS = [
  { tag: "PRC/China",          kws: ["china","beijing","pla","xi jinping","taiwan","prc"] },
  { tag: "Russia/Ukraine",     kws: ["russia","putin","moscow","ukraine","kyiv","donbas","crimea"] },
  { tag: "Iran",               kws: ["iran","tehran","irgc","strait of hormuz"] },
  { tag: "DPRK",               kws: ["north korea","pyongyang","kim jong"] },
  { tag: "Counterterrorism",   kws: ["isis","isil","islamic state","al-qaeda","boko haram","terror"] },
  { tag: "Cyber",              kws: ["ransomware","cyber","malware","apt","phishing","ddos"] },
  { tag: "WMD",                kws: ["nuclear","uranium","centrifuge","missile","icbm","hypersonic","chemical","bioweapon"] },
  { tag: "Energy",             kws: ["oil","gas","lng","pipeline","opec","refinery","uranium"] },
  { tag: "Space/EO",           kws: ["satellite","space","spacex","isro","esa"] },
  { tag: "Health Security",    kws: ["outbreak","pandemic","vaccine","cholera","ebola"] },
  { tag: "Middle East",        kws: ["gaza","israel","hezbollah","lebanon","west bank","idf","hamas"] },
];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    // Some browsers require explicit content-type for JSON
    "Content-Security-Policy": "default-src 'none'",
  };
}

function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "max-age=120",
      ...corsHeaders(),
      ...extra
    }
  });
}

function errorResponse(message, status = 500) {
  return jsonResponse({ ok: false, error: message }, status);
}

// ---- Feed helpers ----
async function fetchFeed(feed) {
  const res = await fetch(feed.url, { cf: { cacheTtl: 180, cacheEverything: true } });
  if (!res.ok) throw new Error(`Bad upstream (${feed.src}): ${res.status}`);
  const xml = await res.text();
  const doc = new DOMParser().parseFromString(xml, "application/xml");

  // Support RSS <item> and Atom <entry>
  const nodes = [...doc.querySelectorAll("item, entry")].slice(0, 100);

  const items = nodes.map((it) => {
    const title = (it.querySelector("title")?.textContent || "").trim();
    const link =
      (it.querySelector("link")?.getAttribute?.("href") || it.querySelector("link")?.textContent || "").trim();
    const pub =
      it.querySelector("pubDate, updated, published")?.textContent?.trim() || "";
    const desc =
      (it.querySelector("description, summary, content")?.textContent || "").trim();

    return { src: feed.src, weight: feed.weight, title, link, desc, pub };
  });

  return items.filter(x => x.title && x.link);
}

function tagTopics(text) {
  const t = (text || "").toLowerCase();
  const tags = [];
  for (const { tag, kws } of TOPICS) {
    if (kws.some(k => t.includes(k))) tags.push(tag);
  }
  return [...new Set(tags)];
}

function storyKey(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w =>
      w.length > 3 &&
      !["with","from","that","this","have","will","after","over","amid","into","more","than","were","been","says","about","into","onto"].includes(w)
    )
    .slice(0, 8)
    .join("-");
}

function scoreItem(it) {
  const tags = tagTopics(`${it.title} ${it.desc}`);
  const now = Date.now();
  const ts = Date.parse(it.pub || "") || now;
  const ageH = (now - ts) / 36e5;

  const urgency = Math.max(0, 1 - Math.min(ageH, 24) / 24); // 0..1
  const impact = Math.min(1, tags.length / 3);               // 0..1
  const confidence = it.weight;                               // 0..1
  const score = +(0.5 * impact + 0.3 * confidence + 0.2 * urgency).toFixed(3);

  return { ...it, tags, ageH: +ageH.toFixed(2), score, key: storyKey(it.title) };
}

async function aggregateFeeds(sinceHours = 24, limit = 60) {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const all = results.flatMap(r => (r.status === "fulfilled" ? r.value : []));

  const items = all
    .map(scoreItem)
    .filter(x => x.ageH <= sinceHours)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const clusters = {};
  for (const it of items) {
    const k = it.key || it.link;
    if (!clusters[k]) clusters[k] = { key: k, tags: new Set(), items: [], score: 0 };
    clusters[k].items.push(it);
    it.tags.forEach(t => clusters[k].tags.add(t));
    clusters[k].score = Math.max(clusters[k].score, it.score);
  }

  const flatClusters = Object.values(clusters)
    .map(c => ({
      key: c.key,
      score: c.score,
      tags: [...c.tags],
      sources: [...new Set(c.items.map(i => i.src))],
      items: c.items
    }))
    .sort((a, b) => (b.sources.length - a.sources.length) || (b.score - a.score));

  return { items, clusters: flatClusters };
}

// ---- Markets: Fear & Greed ----
async function getFearGreed() {
  // Try CNN page scraping server-side; if blocked, fall back to null score
  try {
    const r = await fetch("https://www.cnn.com/markets/fear-and-greed", { cf: { cacheTtl: 300 } });
    const html = await r.text();
    const m = html.match(/"fearAndGreed"\s*:\s*\{"score":\s*(\d{1,3})/i);
    if (m) return { provider: "CNN", score: Number(m[1]), ok: true };
  } catch (_) { /* ignore */ }
  return { provider: "synthetic", score: null, ok: false };
}

// ---- Router ----
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/api/health") {
        return jsonResponse({ ok: true, ts: new Date().toISOString() }, 200, { "cache-control": "no-cache" });
      }

      if (url.pathname === "/api/feeds" || url.pathname === "/api/clusters") {
        const sinceHours = +(url.searchParams.get("sinceHours") || 24);
        const limit = +(url.searchParams.get("limit") || 60);
        const { items, clusters } = await aggregateFeeds(sinceHours, limit);
        const body = url.pathname.endsWith("clusters") ? clusters : items;
        return jsonResponse(body);
      }

      if (url.pathname === "/api/feargreed") {
        const fg = await getFearGreed();
        return jsonResponse(fg, 200, { "cache-control": "max-age=300" });
      }

      if (url.pathname === "/api/live") {
        const live = [
          { name: "Al Jazeera English (YouTube)", url: "https://www.youtube.com/aljazeeraenglish/live" }
          // Add more licensed/allowed live sources here if available to you.
        ];
        return jsonResponse(live, 200, { "cache-control": "max-age=300" });
      }

      // Fallback
      return new Response("OK", { status: 200, headers: { ...corsHeaders(), "content-type": "text/plain" } });
    } catch (err) {
      return errorResponse(err.message || "Unhandled error", 500);
    }
  }
};
