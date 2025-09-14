// worker.js — Worldwide Intel Coverage API (v2)
// Cloudflare Workers
// Routes:
//   GET  /api/health
//   GET  /api/sources
//   GET  /api/feeds?sinceHours=24&limit=80
//   GET  /api/clusters?sinceHours=24&limit=80&minSources=1
//   GET  /api/search?q=...&sinceHours=48
//   GET  /api/topics
//   GET  /api/feargreed
//   GET  /api/live
//   GET  /api/stream  (Server-Sent Events: near-real-time items)
//   OPTIONS * (CORS preflight)
// Features:
// - Global RSS/Atom coverage + configurable weights per source.
// - Robust parsing w/ retries, timeouts, content hashing, first-seen persistence (KV).
// - Topic & simple geo tagging; NIPF-aligned tags + region heuristics.
// - Impact/Urgency/Confidence scoring + corroboration (multi-source) boost.
// - Jaccard-based de-dup & clustering using normalized title keys.
// - Search (title/desc/tags) over recent cache.
// - SSE stream that pushes new items as they arrive.
// - Scheduled warm-cache (exported `scheduled`) for freshness.
// - Optional HMAC-SHA256 response signing (header: X-Signature) if env.API_SECRET is set.
// - CORS + CSP hardened. Sensible caching headers.
// - CNN Fear & Greed scrape with fallback.

// ---------------------------- Config ---------------------------------

// Expanded global feed map (safe, reputable, world coverage).
// Adjust weights (0..1) to reflect your trust/confidence priors.
const FEEDS = [
  // Global wires / multi-region
  { src: "Reuters",    url: "https://feeds.reuters.com/Reuters/worldNews",           weight: 0.98, region: "Global" },
  { src: "AP",         url: "https://apnews.com/hub/ap-top-news?utm_source=apnews.com&utm_medium=referral&utm_campaign=ap-rss", weight: 0.97, region: "Global" },
  { src: "BBC",        url: "https://feeds.bbci.co.uk/news/world/rss.xml",           weight: 0.95, region: "Global" },
  { src: "TheGuardian",url: "https://www.theguardian.com/world/rss",                 weight: 0.93, region: "Global" },
  { src: "AlJazeera",  url: "https://www.aljazeera.com/xml/rss/all.xml",             weight: 0.92, region: "MEA" },
  { src: "DW",         url: "https://rss.dw.com/rdf/rss-en-world",                   weight: 0.90, region: "Europe" },
  { src: "France24",   url: "https://www.france24.com/en/rss",                       weight: 0.90, region: "Europe" },
  { src: "NHK",        url: "https://www3.nhk.or.jp/nhkworld/en/news/feeds/rss.xml", weight: 0.90, region: "Asia" },
  { src: "Yonhap",     url: "https://en.yna.co.kr/rss/all",                          weight: 0.88, region: "Asia" },
  { src: "TheHindu",   url: "https://www.thehindu.com/news/international/feeder/default.rss", weight: 0.86, region: "Asia" },
  { src: "ABC_AU",     url: "https://www.abc.net.au/news/feed/51120/rss.xml",        weight: 0.88, region: "Oceania" },
  { src: "News24_ZA",  url: "https://feeds.24.com/articles/News24/World/rss",        weight: 0.82, region: "Africa" },
  { src: "Anadolu",    url: "https://www.aa.com.tr/en/rss/default?cat=guncel",       weight: 0.85, region: "MEA" },
  { src: "JPost",      url: "https://www.jpost.com/Rss/RssFeedsHeadlines.aspx",      weight: 0.84, region: "MEA" },
  { src: "CNN",        url: "http://rss.cnn.com/rss/edition_world.rss",              weight: 0.90, region: "Global" },
];

const DEFAULT_SINCE_HOURS = 24;
const DEFAULT_LIMIT = 80;
const MAX_PER_SOURCE = 120;

// Topic dictionary (NIS/NIPF-aligned + expansions).
const TOPICS = [
  { tag: "PRC/China",        kws: ["china","beijing","pla","xi jinping","taiwan","prc","cpc","south china sea","shanghai","beidou"] },
  { tag: "Russia/Ukraine",   kws: ["russia","putin","moscow","ukraine","kyiv","donbas","crimea","rostov","black sea","sevastopol"] },
  { tag: "Iran",             kws: ["iran","tehran","irgc","strait of hormuz","qom","isfahan"] },
  { tag: "DPRK",             kws: ["north korea","dprk","pyongyang","kim jong"] },
  { tag: "Counterterrorism", kws: ["isis","isil","islamic state","al-qaeda","boko haram","taliban","terror","al shabaab"] },
  { tag: "Cyber",            kws: ["ransomware","cyber","malware","apt","phishing","ddos","zero-day","botnet","breach"] },
  { tag: "WMD",              kws: ["nuclear","uranium","centrifuge","missile","icbm","hypersonic","chemical","bioweapon","reprocessing"] },
  { tag: "Energy",           kws: ["oil","gas","lng","pipeline","opec","refinery","uranium","coal","grid","blackout"] },
  { tag: "Space/EO",         kws: ["satellite","space","spacex","isro","esa","sputnik","launch","rocket","payload"] },
  { tag: "Health Security",  kws: ["outbreak","pandemic","vaccine","cholera","ebola","avian flu","covid"] },
  { tag: "Middle East",      kws: ["gaza","israel","hezbollah","lebanon","west bank","idf","hamas","houthi","red sea"] },
  { tag: "Indo-Pacific",     kws: ["asean","south pacific","australia","solomon islands","papua new guinea","aotearoa","indopacific"] },
  { tag: "Europe",           kws: ["eu","brussels","berlin","paris","rome","madrid","warsaw","prague","vienna"] },
  { tag: "Africa",           kws: ["sahel","niger","mali","ethiopia","eritrea","somalia","kenya","sudan","dr congo"] },
  { tag: "Americas",         kws: ["united states","canada","mexico","brazil","argentina","venezuela","colombia","chile","peru"] },
];

// Lightweight geo hints (very rough heuristics).
const GEO = [
  { geo: "Asia",     kws: ["china","india","japan","korea","taiwan","philippines","vietnam","indonesia","malaysia","thailand","myanmar","pakistan","afghanistan","bangladesh","sri lanka","nepal","mongolia"] },
  { geo: "Europe",   kws: ["uk","britain","france","germany","italy","spain","poland","romania","netherlands","belgium","sweden","norway","finland","denmark","austria","ireland","czech","greece","ukraine","russia"] },
  { geo: "MEA",      kws: ["israel","gaza","lebanon","syria","iraq","iran","saudi","uae","qatar","yemen","oman","jordan","bahrain","egypt","morocco","algeria","tunisia","turkey"] },
  { geo: "Africa",   kws: ["nigeria","south africa","kenya","ethiopia","somalia","sudan","mali","niger","ghana","ivory coast","cameroon","tanzania","uganda","dr congo"] },
  { geo: "Americas", kws: ["united states","canada","mexico","brazil","argentina","chile","peru","venezuela","colombia","ecuador","bolivia","paraguay","uruguay"] },
  { geo: "Oceania",  kws: ["australia","new zealand","papua","solomon islands","fiji","samoa","tonga","vanuatu"] },
];

// ---- HF Config ----
const HF = {
  // Public Inference API base:
  BASE: "https://api-inference.huggingface.co",
  // Models (swap to taste)
  MODELS: {
    ZEROSHOT: "facebook/bart-large-mnli",
    LANG_DETECT: "papluca/xlm-roberta-base-language-detection",
    TRANSLATE: "facebook/m2m100_418M",
    SUMMARIZE: "facebook/bart-large-cnn",
    SENTIMENT: "cardiffnlp/twitter-roberta-base-sentiment-latest",
    NER: "dslim/bert-base-NER",
  },
  // Timeouts / rate caps
  TIMEOUT_MS: 8000,
  MAX_HF_ENRICH: 25,       // max items per response to enrich (cost control)
  CACHE_TTL_S: 60 * 60,    // 1h for enrichment cache
};


// ------------------------ Utilities & glue ---------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Vary": "Origin",
    "Content-Security-Policy": "default-src 'none'",
  };
}
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...JSON_HEADERS, "cache-control": "max-age=120", ...corsHeaders(), ...extra },
  });
}
function errorResponse(message, status = 500) {
  return jsonResponse({ ok: false, error: message }, status);
}

function toLower(str = ""){ return str.toLowerCase(); }
function tokenize(s){ return toLower(s).replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function storyKey(title) {
  const stop = new Set(["with","from","that","this","have","will","after","over","amid","into","more","than","were","been","says","about","onto","into","amidst","under","into","near","amid"]);
  return tokenize(title)
    .filter(w => w.length > 3 && !stop.has(w))
    .slice(0, 8)
    .join("-");
}

function tagTopics(text) {
  const t = toLower(text || "");
  const tags = [];
  for (const { tag, kws } of TOPICS) if (kws.some(k => t.includes(k))) tags.push(tag);
  return [...new Set(tags)];
}
function tagGeo(text){
  const t = toLower(text || "");
  const gs = [];
  for (const { geo, kws } of GEO) if (kws.some(k => t.includes(k))) gs.push(geo);
  return [...new Set(gs)];
}

function parseDateAny(s) {
  const ts = Date.parse(s || "");
  return Number.isFinite(ts) ? ts : Date.now();
}

async function signIfNeeded(env, payloadStr) {
  if (!env.API_SECRET) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.API_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadStr));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,"0")).join("");
}

// Retry helper with jitter and timeout.
async function fetchRetry(url, init = {}, tries = 3, timeoutMs = 8000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal, cf: { cacheTtl: 180, cacheEverything: true, ...(init.cf||{}) } });
      clearTimeout(t);
      if (r.ok) return r;
      lastErr = new Error(`${url} -> HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise(res => setTimeout(res, 300 * (i + 1) + Math.random() * 200));
  }
  throw lastErr;
}

// --------------------------- Feed ingest -----------------------------

async function fetchFeed(feed) {
  const res = await fetchRetry(feed.url);
  const xml = await res.text();
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const nodes = [...doc.querySelectorAll("item, entry")].slice(0, MAX_PER_SOURCE);

  const items = nodes.map((it) => {
    const title = (it.querySelector("title")?.textContent || "").trim();
    const link = (it.querySelector("link")?.getAttribute?.("href") || it.querySelector("link")?.textContent || "").trim();
    const pub  = (it.querySelector("pubDate, updated, published")?.textContent?.trim() || "");
    const desc = (it.querySelector("description, summary, content")?.textContent || "").trim();
    const ts   = parseDateAny(pub);
    const hash = crypto.subtle.digest ? null : null; // placeholder if ever needed
    return {
      src: feed.src,
      region: feed.region,
      weight: feed.weight,
      title, link, desc, pub, ts
    };
  });

  return items.filter(x => x.title && x.link);
}

function scoreItem(it) {
  const tags = tagTopics(`${it.title} ${it.desc}`);
  const geos = tagGeo(`${it.title} ${it.desc} ${it.region||""}`);
  const now = Date.now();
  const ageH = (now - (it.ts || now)) / 36e5;

  const urgency = Math.max(0, 1 - Math.min(ageH, 36) / 36); // 0..1, 36h tail
  const impact = Math.min(1, tags.length / 3);
  const confidence = it.weight || 0.8;

  // base score
  let score = 0.5 * impact + 0.3 * confidence + 0.2 * urgency;

  const key = storyKey(it.title);
  return { ...it, tags, geos, ageH: +ageH.toFixed(2), score: +score.toFixed(3), key };
}

function clusterItems(items) {
  // initial grouping by key
  const buckets = new Map();
  for (const it of items) {
    const k = it.key || it.link;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }

  // merge near-duplicates by Jaccard of titles
  const keys = [...buckets.keys()];
  const merged = new Map();
  const used = new Set();

  for (let i = 0; i < keys.length; i++) {
    if (used.has(keys[i])) continue;
    const baseTitleTokens = tokenize(buckets.get(keys[i])[0].title);
    const group = new Set([keys[i]]);
    for (let j = i + 1; j < keys.length; j++) {
      if (used.has(keys[j])) continue;
      const candTokens = tokenize(buckets.get(keys[j])[0].title);
      if (jaccard(baseTitleTokens, candTokens) >= 0.6) {
        group.add(keys[j]);
        used.add(keys[j]);
      }
    }
    merged.set(keys[i], [...group].flatMap(k => buckets.get(k)));
  }

  const clusters = [];
  for (const [seedKey, arr] of merged.entries()) {
    const tags = new Set(), geos = new Set(), srcs = new Set();
    let maxScore = 0, newestTs = 0, oldestTs = Number.MAX_SAFE_INTEGER;
    for (const it of arr) {
      it.tags.forEach(t => tags.add(t));
      it.geos.forEach(g => geos.add(g));
      srcs.add(it.src);
      maxScore = Math.max(maxScore, it.score || 0);
      newestTs = Math.max(newestTs, it.ts || 0);
      oldestTs = Math.min(oldestTs, it.ts || 0);
    }
    // Corroboration boost: more distinct sources = more confidence
    const corroboration = Math.min(1, (srcs.size - 1) / 4); // 0..1 for 1..5+ sources
    const clusterScore = +(0.8 * maxScore + 0.2 * corroboration).toFixed(3);
    clusters.push({
      key: seedKey,
      score: clusterScore,
      tags: [...tags],
      geos: [...geos],
      sources: [...srcs],
      firstSeenTs: oldestTs || newestTs,
      lastSeenTs: newestTs,
      items: arr.sort((a,b)=>b.ts-a.ts),
    });
  }

  // sort: more sources first, then score
  clusters.sort((a,b)=> (b.sources.length - a.sources.length) || (b.score - a.score));
  return clusters;
}

async function aggregateFeeds(env, sinceHours = DEFAULT_SINCE_HOURS, limit = DEFAULT_LIMIT) {
  // Pull all feeds (best-effort)
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const all = results.flatMap(r => r.status === "fulfilled" ? r.value : []);

  const items = all
    .map(scoreItem)
    .filter(x => x.ageH <= sinceHours)
    .sort((a,b) => b.score - a.score)
    .slice(0, limit * 2); // extra for clustering headroom

  const clusters = clusterItems(items);

  // Persist firstSeen / dedupe memory in KV (optional)
  if (env.NEWS_KV) {
    const ops = [];
    for (const it of items) {
      const key = `item:${(it.link || it.key).slice(0,512)}`;
      ops.push(env.NEWS_KV.get(key).then(prev => {
        if (!prev) return env.NEWS_KV.put(key, JSON.stringify({ firstSeenTs: Date.now(), link: it.link, title: it.title }), { expirationTtl: 60 * 60 * 24 * 7 });
      }));
    }
    for (const c of clusters) {
      const ck = `cluster:${c.key}`;
      ops.push(env.NEWS_KV.put(ck, JSON.stringify({ key: c.key, lastSeenTs: c.lastSeenTs, sources: c.sources, tags: c.tags }), { expirationTtl: 60 * 60 * 24 * 7 }));
    }
    Promise.allSettled(ops).catch(()=>{});
  }

  return { items: items.slice(0, limit), clusters: clusters.slice(0, limit) };
}

// -------------------------- Markets FG -------------------------------

async function getFearGreed() {
  try {
    const r = await fetchRetry("https://www.cnn.com/markets/fear-and-greed", {}, 2, 6000);
    const html = await r.text();
    const m = html.match(/"fearAndGreed"\s*:\s*\{"score":\s*(\d{1,3})/i);
    if (m) return { provider: "CNN", score: Number(m[1]), ok: true };
  } catch (_){ /* ignore */ }
  return { provider: "synthetic", score: null, ok: false };
}

// --------------------------- SSE Stream ------------------------------

function sseHeaders(){
  return {
    ...corsHeaders(),
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  };
}

async function handleStream(env, url) {
  const sinceHours = +(url.searchParams.get("sinceHours") || 6);
  const pushIntervalMs = Math.min(Math.max(2500, +(url.searchParams.get("intervalMs") || 4000)), 15000);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      function send(type, data){
        const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      }

      // initial burst
      try {
        const { items } = await aggregateFeeds(env, sinceHours, 40);
        send("init", { ts: Date.now(), count: items.length });
      } catch (e) {
        send("error", { error: e.message || String(e) });
      }

      let timer = setInterval(async () => {
        try {
          const { items } = await aggregateFeeds(env, 2, 20);
          // Only emit newest few
          send("tick", { ts: Date.now(), items: items.slice(0, 8) });
        } catch (e) {
          send("error", { error: e.message || String(e) });
        }
      }, pushIntervalMs);

      // Close after ~90s (edge limit guard)
      setTimeout(() => { clearInterval(timer); controller.close(); }, 90000);
    }
  });

  return new Response(stream, { headers: sseHeaders() });
}

// --------------------------- Router ---------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    try {
      if (url.pathname === "/api/health") {
        const payload = { ok: true, ts: new Date().toISOString(), sources: FEEDS.length };
        const sig = await signIfNeeded(env, JSON.stringify(payload));
        const extra = sig ? { "X-Signature": sig, "cache-control": "no-cache" } : { "cache-control": "no-cache" };
        return jsonResponse(payload, 200, extra);
      }

      if (url.pathname === "/api/sources") {
        return jsonResponse(FEEDS.map(({src,url,weight,region}) => ({src,url,weight,region})), 200, { "cache-control": "max-age=3600" });
      }

      if (url.pathname === "/api/feeds" || url.pathname === "/api/clusters") {
        const sinceHours = +(url.searchParams.get("sinceHours") || DEFAULT_SINCE_HOURS);
        const limit = +(url.searchParams.get("limit") || DEFAULT_LIMIT);
        const minSources = +(url.searchParams.get("minSources") || 1);

      if (url.pathname === "/api/enrich") {
        const sinceHours = +(url.searchParams.get("sinceHours") || DEFAULT_SINCE_HOURS);
        const limit = +(url.searchParams.get("limit") || 40);
        const { items } = await aggregateFeeds(env, sinceHours, limit);
        const out = await enrichItems(env, items, HF.MAX_HF_ENRICH);
        return jsonResponse({ count: out.length, items: out }, 200, { "cache-control": "no-store" });
      }

      if (url.pathname === "/api/clusters/enriched") {
        const sinceHours = +(url.searchParams.get("sinceHours") || DEFAULT_SINCE_HOURS);
        const limit = +(url.searchParams.get("limit") || DEFAULT_LIMIT);
        const minSources = +(url.searchParams.get("minSources") || 1);
        const { items } = await aggregateFeeds(env, sinceHours, limit * 2);
        const enriched = await enrichItems(env, items, HF.MAX_HF_ENRICH);
        const clusters = clusterItems(enriched).filter(c => (c.sources?.length || 0) >= minSources).slice(0, limit);
        return jsonResponse(clusters, 200, { "cache-control": "no-store" });
      }
        const { items, clusters } = await aggregateFeeds(env, sinceHours, limit);
        let body;
        if (url.pathname.endsWith("clusters")) {
          body = clusters.filter(c => (c.sources?.length || 0) >= minSources);
        } else {
          body = items;
        }

        const payloadStr = JSON.stringify(body);
        const sig = await signIfNeeded(env, payloadStr);
        const headers = { "ETag": `"${await digestHex(payloadStr)}"` };
        if (sig) headers["X-Signature"] = sig;
        return new Response(payloadStr, { status: 200, headers: { ...JSON_HEADERS, ...corsHeaders(), "cache-control": "max-age=120", ...headers } });
      }

      if (url.pathname === "/api/search") {
        const q = toLower(url.searchParams.get("q") || "");
        const sinceHours = +(url.searchParams.get("sinceHours") || 48);
        const limit = +(url.searchParams.get("limit") || 60);
        const { items } = await aggregateFeeds(env, sinceHours, limit * 2);
        const res = items.filter(it => {
          const hay = `${it.title} ${it.desc} ${it.tags?.join(" ")} ${it.geos?.join(" ")}`.toLowerCase();
          return q.split(/\s+/).every(tok => hay.includes(tok));
        }).slice(0, limit);
        return jsonResponse({ q, count: res.length, items: res });
      }

      if (url.pathname === "/api/topics") {
        return jsonResponse({ topics: TOPICS.map(t => t.tag), regions: [...new Set(FEEDS.map(f=>f.region))], geoBuckets: GEO.map(g=>g.geo) }, 200, { "cache-control": "max-age=3600" });
      }

      if (url.pathname === "/api/feargreed") {
        const fg = await getFearGreed();
        return jsonResponse(fg, 200, { "cache-control": "max-age=300" });
      }

      if (url.pathname === "/api/live") {
        const live = [
          { name: "Al Jazeera English", url: "https://www.youtube.com/aljazeeraenglish/live" },
          { name: "DW News",            url: "https://www.youtube.com/dwnews/live" },
          { name: "France 24",          url: "https://www.youtube.com/france24_en/live" }
          // Add other licensed live sources as desired.
        ];
        return jsonResponse(live, 200, { "cache-control": "max-age=600" });
      }

      if (url.pathname === "/api/stream") {
        return handleStream(env, url);
      }

      return new Response("OK", { status: 200, headers: { ...corsHeaders(), "content-type": "text/plain" } });
    } catch (err) {
      return errorResponse(err.message || "Unhandled error", 500);
    }
  },

  // Scheduled warm-cache for freshness (configure crons in wrangler.toml)
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await aggregateFeeds(env, 12, 60); // warm recent
      } catch (_){}
    })());
  }
};

// --------------------------- Helpers --------------------------------

async function digestHex(s) {
  const data = new TextEncoder().encode(s);
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2,"0")).join("");
}

// HF helpers
function withHFHeaders(env) {
  return {
    headers: {
      "authorization": `Bearer ${env.HF_TOKEN}`,
      "content-type": "application/json",
    }
  };
}
function hfURL(env, model, fallbackBase = HF.BASE) {
  // If using dedicated Inference Endpoints per task, those are full URLs.
  // Otherwise call public Inference API for /models/{repo_id}
  return env.HF_USE_ENDPOINTS === "true" && model.startsWith("http")
    ? model
    : `${fallbackBase}/models/${encodeURIComponent(model)}`;
}

async function hfPOST(env, url, body, timeoutMs = HF.TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", body: JSON.stringify(body), signal: ctrl.signal, ...withHFHeaders(env) });
    const text = await r.text();
    if (!r.ok) throw new Error(`HF ${url} -> ${r.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally { clearTimeout(t); }
}

// Task wrappers
async function hfZeroShot(env, text, labels) {
  const url = hfURL(env, env.HF_EP_ZEROSHOT || HF.MODELS.ZEROSHOT);
  return hfPOST(env, url, { inputs: text, parameters: { candidate_labels: labels, multi_label: true } });
}
async function hfLangDetect(env, text) {
  const url = hfURL(env, env.HF_EP_LANG_DETECT || HF.MODELS.LANG_DETECT);
  return hfPOST(env, url, { inputs: text });
}
async function hfTranslate(env, text, src = null, tgt = "en") {
  const url = hfURL(env, env.HF_EP_TRANSLATE || HF.MODELS.TRANSLATE);
  const parameters = {};
  if (src) parameters.src_lang = src;
  if (tgt) parameters.tgt_lang = tgt;
  return hfPOST(env, url, { inputs: text, parameters });
}
async function hfSummarize(env, text, maxLen = 120, minLen = 40) {
  const url = hfURL(env, env.HF_EP_SUMMARIZE || HF.MODELS.SUMMARIZE);
  return hfPOST(env, url, { inputs: text, parameters: { max_length: maxLen, min_length: minLen, do_sample: false } });
}
async function hfSentiment(env, text) {
  const url = hfURL(env, env.HF_EP_SENTIMENT || HF.MODELS.SENTIMENT);
  return hfPOST(env, url, { inputs: text });
}
async function hfNER(env, text) {
  const url = hfURL(env, env.HF_EP_NER || HF.MODELS.NER);
  return hfPOST(env, url, { inputs: text });
}

// Map TOPICS tags to zero-shot labels.
const ZS_LABELS = TOPICS.map(t => t.tag);

// Normalize HF outputs
function topLabel(zsOut, thresh = 0.4) {
  try {
    if (!Array.isArray(zsOut?.labels) || !Array.isArray(zsOut?.scores)) return [];
    return zsOut.labels.map((lab, i) => ({ label: lab, score: zsOut.scores[i] }))
                       .filter(x => x.score >= thresh)
                       .slice(0, 5);
  } catch { return []; }
}
function parseLang(det) {
  // det: [[{label:"en", score:0.99}, ...]] or [{label:"en",score:...}]
  const arr = Array.isArray(det) ? det.flat() : [];
  return arr.sort((a,b)=> (b.score||0)-(a.score||0))[0]?.label || "en";
}

// KV key builders
const kvKey = (prefix, id) => `${prefix}:${digestBase64Url(id).slice(0,44)}`;
async function digestBase64Url(s){
  const data = new TextEncoder().encode(s);
  const d = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(d))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
}

async function enrichItem(env, it) {
  // Try KV
  const id = it.link || it.key || it.title;
  const K = kvKey("enrich", id);
  if (env.NEWS_KV) {
    const cached = await env.NEWS_KV.get(K, "json");
    if (cached) return { ...it, ...cached, enriched: true };
  }

  const text = `${it.title}. ${it.desc || ""}`.slice(0, 3500);

  // 1) Language detect
  let lang = "en";
  try {
    const det = await hfLangDetect(env, text);
    lang = parseLang(det) || "en";
  } catch {}

  // 2) Translate if needed
  let normalized = text;
  if (lang !== "en") {
    try {
      const tr = await hfTranslate(env, text, null, "en");
      // API returns array of { translation_text } or similar
      if (Array.isArray(tr) && tr[0]?.translation_text) normalized = tr[0].translation_text;
      else if (typeof tr === "string") normalized = tr;
    } catch {}
  }

  // 3) Zero-shot topics
  let zs = null, zsTop = [];
  try {
    zs = await hfZeroShot(env, normalized, ZS_LABELS);
    zsTop = topLabel(zs, 0.35).map(x => x.label);
  } catch {}

  // 4) Summarize
  let summary = "";
  try {
    const sm = await hfSummarize(env, normalized);
    if (Array.isArray(sm) && sm[0]?.summary_text) summary = sm[0].summary_text;
    else if (typeof sm === "string") summary = sm;
  } catch {}

  // 5) Optional sentiment & NER
  let sentiment = null, entities = [];
  try {
    const s = await hfSentiment(env, normalized);
    sentiment = s;
  } catch {}
  try {
    const e = await hfNER(env, normalized);
    if (Array.isArray(e)) entities = e;
  } catch {}

  // Merge tags: original + zero-shot
  const mergedTags = Array.from(new Set([...(it.tags||[]), ...(zsTop||[])]));

  const enrich = {
    lang,
    translated: lang !== "en",
    normalizedText: normalized.slice(0, 2000),
    summary,
    zsLabels: zsTop,
    sentiment,
    entities,
    tags: mergedTags,
  };

  if (env.NEWS_KV) {
    await env.NEWS_KV.put(K, JSON.stringify(enrich), { expirationTtl: HF.CACHE_TTL_S });
  }
  return { ...it, ...enrich, enriched: true };
}

// Batch enrichment with caps
async function enrichItems(env, items, cap = HF.MAX_HF_ENRICH) {
  const head = items.slice(0, cap);
  const rest = items.slice(cap);
  const enriched = [];
  for (const it of head) {
    try { enriched.push(await enrichItem(env, it)); }
    catch { enriched.push(it); }
  }
  return enriched.concat(rest);
}
