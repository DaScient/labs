// === DASCIENT Worker — summary + options + sentiment + TA (AO, Choppiness, Volumes) ===
// + OpenAI Chat Completions proxy (POST /v1/chat/completions)
//
// Endpoints:
//   GET  /api/ping
//   GET  /api/diag
//   GET  /api/summary?symbol=XYZ
//   GET  /api/summary-batch?symbols=AAPL,MSFT,NVDA
//   GET  /api/options?symbol=XYZ[&date=YYYY-MM-DD]
//   GET  /api/options-batch?symbols=AAPL,MSFT
//   GET  /api/ta-summary?symbol=XYZ[&interval=15m|60m|1d][&range=10d|30d|6mo]
//   GET  /api/sentiment?symbol=XYZ
//   GET  /api/mock?symbol=XYZ
//   GET  /api/yahoo/day-gainers?count=100
//   GET  /api/yahoo/day-losers?count=100
//   GET  /api/yahoo/most-actives?count=100
//   POST /v1/chat/completions      (OpenAI proxy)
//
// Secrets (optional indicated):
//   FINNHUB_KEY, FINNHUB_KEY_2, ...
//   TRADIER_TOKEN, TRADIER_TOKEN_2, ...
//   FMP_KEY, FMP_KEY_2, ...
//   STOCKTWITS_BEARER (optional)
//   STOCKTWITS_COOKIE (optional)
//   OPENAI_API_KEY (for /v1/chat/completions)
//   OPENAI_MODEL_ALLOWLIST (optional, comma-separated)
//
// Notes:
// - Tradier is optional; falls back to Finnhub for options.
// - Yahoo screener routes are proxied to avoid browser CORS.
// - OpenAI proxy route is isolated so existing /api/* capabilities remain intact.

const TRADIER_BASE = "https://sandbox.tradier.com";
const PAGES_BASE = "https://dascient.github.io/labs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(request) });
    }

    try {
      const path = url.pathname;

      // --- OpenAI Chat Completions proxy ---
      // Supports iOS client pointing to baseURL "https://stocks.aristocles24.workers.dev/v1"
      if (path === "/v1/chat/completions") {
        if (request.method !== "POST") {
          return jsonErr(request, 405, "Method Not Allowed");
        }
        return await proxyOpenAIChat(request, env);
      }

      // --- healthcheck ---
      if (path === "/api/ping") {
        return json(request, {
          ok: true,
          now: Date.now(),
          providers: {
            finnhub: getKeyPool(env, /^FINNHUB_KEY/i).length,
            tradier: getKeyPool(env, /^TRADIER_TOKEN/i).length,
            fmp: getKeyPool(env, /^FMP_KEY/i).length,
            st_auth: Boolean(env.STOCKTWITS_BEARER || env.STOCKTWITS_COOKIE),
            openai: Boolean(env.OPENAI_API_KEY)
          }
        });
      }

      // --- Yahoo predefined screeners (proxy) ---
      if (
        path === "/api/yahoo/day-gainers" ||
        path === "/api/yahoo/day-losers" ||
        path === "/api/yahoo/most-actives"
      ) {
        const scrId = path.endsWith("day-gainers")
          ? "day_gainers"
          : path.endsWith("day-losers")
            ? "day_losers"
            : "most_actives";

        const count = sanitizeCount(url.searchParams.get("count"));
        try {
          const { quotes, total } = await fetchYahooPredefined(scrId, count);
          return json(request, { ok: true, id: scrId, count: quotes.length, total, quotes });
        } catch (e) {
          return jsonErr(request, 502, `yahoo screener failed: ${String(e?.message || e)}`);
        }
      }

      // --- diagnostics ---
      if (path === "/api/diag") {
        const out = {
          ok: true,
          providers: {
            finnhub_keys: getKeyPool(env, /^FINNHUB_KEY/i).length,
            tradier_tokens: getKeyPool(env, /^TRADIER_TOKEN/i).length,
            fmp_keys: getKeyPool(env, /^FMP_KEY/i).length,
            openai: Boolean(env.OPENAI_API_KEY)
          }
        };

        try {
          const j = await fhJSON(`https://finnhub.io/api/v1/quote?symbol=AAPL`, env);
          out.finnhub = { price: num(j?.c) };
        } catch (e) {
          out.finnhub = { error: String(e) };
          out.ok = false;
        }

        try {
          const s = await getStocktwitsSentiment("AAPL", env);
          out.stocktwits = s;
        } catch (e) {
          out.stocktwits = { error: String(e) };
          out.ok = false;
        }

        try {
          const ta = await computeTA(env, "AAPL", { interval: "15m", range: "10d" });
          out.ta = ta;
        } catch (e) {
          out.ta = { error: String(e) };
          out.ok = false;
        }

        return json(request, out, out.ok ? 200 : 502);
      }

      // --- summary (single) ---
      if (path === "/api/summary") {
        const symbol = sanitize(url.searchParams.get("symbol"));
        if (!symbol) return jsonErr(request, 400, "symbol required");
        const out = await getSummary(env, symbol);
        return json(request, out);
      }

      // --- batch: summaries ---
      if (path === "/api/summary-batch") {
        const raw = (url.searchParams.get("symbols") || "").trim();
        if (!raw) return jsonErr(request, 400, "symbols required");
        const symbols = raw
          .split(",")
          .map((s) => sanitize(s))
          .filter(Boolean)
          .slice(0, 50);

        const out = [];
        for (const sym of symbols) {
          await sleep(100);
          try {
            out.push(await getSummary(env, sym));
          } catch (e) {
            out.push({ symbol: sym, error: String(e?.message || e) });
          }
        }
        return json(request, out);
      }

      // --- options (single) ---
      if (path === "/api/options") {
        const symbol = sanitize(url.searchParams.get("symbol"));
        const date = url.searchParams.get("date");
        if (!symbol) return jsonErr(request, 400, "symbol required");
        const out = await getOptions(env, symbol, date);
        if (!out) {
          return json(request, {
            expiration: date || null,
            price: null,
            atmCall: null,
            atmPut: null,
            bullCallSpread: null,
            bearPutSpread: null,
            bullPutCredit: null,
            bearCallCredit: null,
            ironCondor: null,
            _note: "no options data"
          });
        }
        return json(request, out);
      }

      // --- batch: options ---
      if (path === "/api/options-batch") {
        const raw = (url.searchParams.get("symbols") || "").trim();
        if (!raw) return jsonErr(request, 400, "symbols required");
        const symbols = raw
          .split(",")
          .map((s) => sanitize(s))
          .filter(Boolean)
          .slice(0, 20);

        const out = {};
        for (const sym of symbols) {
          await sleep(100);
          try {
            out[sym] = (await getOptions(env, sym, null)) ?? { error: "no options data" };
          } catch (e) {
            out[sym] = { error: String(e?.message || e) };
          }
        }
        return json(request, out);
      }

      // --- sentiment oracle (per symbol) ---
      if (path === "/api/sentiment") {
        const symbol = sanitize(url.searchParams.get("symbol"));
        if (!symbol) return jsonErr(request, 400, "symbol required");
        const s = await getSentimentOracle(env, symbol);
        return json(request, { symbol, ...s });
      }

      // --- TA summary (per symbol) ---
      if (path === "/api/ta-summary") {
        const symbol = sanitize(url.searchParams.get("symbol"));
        if (!symbol) return jsonErr(request, 400, "symbol required");
        const interval = (url.searchParams.get("interval") || "15m").toLowerCase();
        const range = (url.searchParams.get("range") || "10d").toLowerCase();
        const t = await computeTA(env, symbol, { interval, range });
        return json(request, { symbol, ...t });
      }

      // --- mock ---
      if (path === "/api/mock") {
        const symbol = sanitize(url.searchParams.get("symbol")) || "AAPL";
        return json(request, mockPayload(symbol));
      }

      return jsonErr(request, 404, "not found");
    } catch (e) {
      return jsonErr(request, 500, String(e?.message || e));
    }
  }
};

/* ================= OPENAI PROXY ================= */
async function proxyOpenAIChat(request, env) {
  if (!env.OPENAI_API_KEY) {
    return jsonErr(request, 500, "OPENAI_API_KEY is not configured on the worker");
  }

  const ct = request.headers.get("Content-Type") || "";
  if (!ct.toLowerCase().includes("application/json")) {
    return jsonErr(request, 415, "Content-Type must be application/json");
  }

  const raw = await request.text();
  if (!raw || raw.length < 2) return jsonErr(request, 400, "Missing request body");
  if (raw.length > 250_000) return jsonErr(request, 413, "Request too large");

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return jsonErr(request, 400, "Invalid JSON");
  }

  // Optional allowlist enforcement
  if (env.OPENAI_MODEL_ALLOWLIST) {
    const allow = String(env.OPENAI_MODEL_ALLOWLIST)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const model = String(payload?.model || "");
    if (!allow.includes(model)) {
      return jsonErr(request, 403, `Model not allowed: ${model}`);
    }
  }

  // Forward request to OpenAI
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload),
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  const respBody = await upstream.text();
  return new Response(respBody, {
    status: upstream.status,
    headers: cors(request, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    })
  });
}

/* ================= SUMMARY (TA + Sentiment Oracle + Targets) ================= */
async function getSummary(env, symbol) {
  const quote = await fhJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`, env);
  const price = num(quote?.c);

  const { targetMeanPrice, _targetProvider } = await resolveTarget(env, symbol);
  const tNum = num(targetMeanPrice) === 0 ? null : num(targetMeanPrice);
  const tProv = tNum != null ? _targetProvider : null;

  let recommendationKey = null;
  try {
    const recs = await fhJSON(
      `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}`,
      env
    );
    recommendationKey = summarizeRecs(recs);
  } catch {}

  const ta = await computeTA(env, symbol, { interval: "15m", range: "10d" });
  const sentiment = await getSentimentOracle(env, symbol);

  const crowdBias =
    (sentiment?.sources?.stocktwits?.bullish ?? 0) - (sentiment?.sources?.stocktwits?.bearish ?? 0);

  let blended = ta.signal;
  if (blended === "HOLD" && crowdBias > 20) blended = "BUY";
  if (blended === "HOLD" && crowdBias < -20) blended = "SELL";

  return {
    symbol,
    price,
    targetMeanPrice: tNum,
    recommendationKey,
    _targetProvider: tProv,
    _provider: "finnhub",
    _mode: "live",

    ta: {
      choppiness: ta.choppiness,
      ao: ta.ao,
      aoUp: ta.aoUp,
      volumeUp: ta.volumeUp,
      priceStability: ta.priceStability,
      sellVolumeDeclining: ta.sellVolumeDeclining,
      notes: ta.notes,
      signal: ta.signal
    },

    sentiment: sentiment?.blend
      ? {
          bullish: sentiment.sources?.stocktwits?.bullish ?? 0,
          bearish: sentiment.sources?.stocktwits?.bearish ?? 0,
          neutral: sentiment.sources?.stocktwits?.neutral ?? 0,
          _mode: sentiment.blend?._mode || "live"
        }
      : { bullish: 0, bearish: 0, neutral: 100, _mode: "_none" },

    signalRecommendation: blended,
    _signalNote: ta._signalNote
  };
}

/* ================= SENTIMENT ORACLE (CNN F&G + Stocktwits + simple news) ================= */
async function getSentimentOracle(env, symbol) {
  const [fg, st, nw] = await Promise.allSettled([
    fetchFearGreed(),
    getStocktwitsSentiment(symbol, env),
    fetchNewsTone(symbol)
  ]);

  const fearGreed =
    fg.status === "fulfilled"
      ? fg.value
      : { value: 0, label: "n/a", regime: "Unknown", source: "", _fallback: true };

  const stocktwits =
    st.status === "fulfilled" ? st.value : { bullish: 0, bearish: 0, neutral: 100, _mode: "_none" };

  const news = nw.status === "fulfilled" ? nw.value : { score: 0, n: 0, top: [] };

  const socialScore = clamp(-100, 100, (stocktwits.bullish || 0) - (stocktwits.bearish || 0));
  const mediaScore = clamp(-100, 100, Math.round((news.score || 0) * 100));
  const macroScore = clamp(-100, 100, (fearGreed.value || 0) - 50);
  const agree = Math.sign(socialScore) === Math.sign(mediaScore) ? 8 : 0;

  const unifiedScore = clamp(
    -100,
    100,
    Math.round(0.5 * socialScore + 0.3 * mediaScore + 0.2 * macroScore + agree)
  );

  const bucket = unifiedScore >= 20 ? "BULLISH" : unifiedScore <= -20 ? "BEARISH" : "NEUTRAL";
  const confidence = Math.min(1, Math.abs(unifiedScore) / 60);

  return {
    timestamp: Date.now(),
    sources: { fearGreed, stocktwits, news },
    blend: {
      socialScore,
      mediaScore,
      macroScore,
      agreementBoost: agree,
      unifiedScore,
      bucket,
      confidence,
      _mode: "live"
    }
  };
}

async function fetchFearGreed() {
  const u = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
  const r = await fetch(u, {
    headers: { Accept: "application/json", "User-Agent": UA() },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!r.ok) return { value: 50, label: "50", regime: "Neutral", source: u, _fallback: true };
  const j = await r.json();
  const v = Number(j?.fear_and_greed?.now?.value ?? j?.fear_and_greed?.now ?? 50);
  const regime =
    v >= 75 ? "Extreme Greed" : v >= 60 ? "Greed" : v > 40 ? "Neutral" : v >= 25 ? "Fear" : "Extreme Fear";
  return { value: v, label: String(v), regime, source: u, _fallback: false };
}

async function fetchNewsTone(symbol) {
  const q = encodeURIComponent(symbol);
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${q}`;
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/rss+xml, text/xml, */*", "User-Agent": UA() },
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!r.ok) return { score: 0, n: 0, top: [] };

    const xml = await r.text();
    const titles = Array.from(xml.matchAll(/<title>([^<]+)<\/title>/gi))
      .map((m) => m[1])
      .filter((t) => t && !/Yahoo Finance|Top Stories/i.test(t))
      .slice(0, 12);

    const pos = ["beats", "surge", "soars", "record", "upgrade", "strong", "growth", "profit", "bull", "win", "rally", "breakout", "pop", "positive"];
    const neg = ["miss", "plunge", "slump", "downgrade", "weak", "loss", "bear", "fall", "selloff", "cuts", "fraud", "probe", "negative"];

    let s = 0;
    for (const t of titles) {
      const lt = t.toLowerCase();
      if (pos.some((w) => lt.includes(w))) s += 1;
      if (neg.some((w) => lt.includes(w))) s -= 1;
    }

    const score = titles.length ? s / titles.length : 0;
    return { score, n: titles.length, top: titles.slice(0, 5) };
  } catch {
    return { score: 0, n: 0, top: [] };
  }
}

/* ================= TA MODULE ================= */
async function computeTA(env, symbol, { interval = "15m", range = "10d" } = {}) {
  const candles = await getCandles(env, symbol, interval, range);
  if (!candles.length) {
    return {
      choppiness: null,
      ao: null,
      aoUp: false,
      aoDown: false,
      volumeUp: false,
      volumeDown: false,
      buyVolume: 0,
      sellVolume: 0,
      sellVolumeDeclining: false,
      priceStability: null,
      signal: "HOLD",
      notes: [],
      _signalNote: "No data"
    };
  }

  const mp = candles.map((k) => (k.h + k.l) / 2);

  const ao = awesomeOscillator(mp, 5, 34);
  const aoPrev = awesomeOscillator(mp.slice(0, -1), 5, 34);
  const aoUp = ao != null && aoPrev != null ? ao > aoPrev : false;
  const aoDown = ao != null && aoPrev != null ? ao < aoPrev : false;

  const chop = choppinessIndex(candles, 14);
  const atr = averageTrueRange(candles, 14);
  const lastPrice = candles.at(-1).c || 1;
  const priceStability = clamp01(1 - (atr / lastPrice) * 5);

  let buyVol = 0,
    sellVol = 0;
  candles.forEach((k) => {
    if (k.c >= k.o) buyVol += k.v || 0;
    else sellVol += k.v || 0;
  });

  const volSeries = candles.map((k) => k.v || 0);
  const volumeUp = slope(volSeries.slice(-20)) > 0;
  const volumeDown = slope(volSeries.slice(-20)) < 0;

  const sellSeries = candles.map((k) => (k.c < k.o ? k.v || 0 : 0));
  const s = sellSeries.slice(-4);
  const sellVolumeDeclining =
    s.length >= 3 ? s[s.length - 3] > s[s.length - 2] && s[s.length - 2] > s[s.length - 1] : false;

  let signal = "HOLD";
  if (chop != null && ao != null) {
    if (chop < 38 && ao > 0) signal = "BUY";
    else if (chop > 61 && ao < 0) signal = "SELL";
  }
  if (sellVolumeDeclining && priceStability > 0.8) signal = boostSignal(signal, "BUY");

  const notes = [];
  if (aoUp && volumeDown) notes.push("Momentum building quietly");
  if (aoDown && volumeUp) notes.push("Distribution risk");

  const _signalNote =
    notes.join(" | ") ||
    (signal === "HOLD" ? "Neutral signals" : signal === "BUY" ? "Conditions supportive" : "Caution warranted");

  return {
    choppiness: chop,
    ao: round(ao),
    aoUp,
    aoDown,
    volumeUp,
    volumeDown,
    buyVolume: Math.round(buyVol),
    sellVolume: Math.round(sellVol),
    sellVolumeDeclining,
    priceStability: round(priceStability),
    signal,
    notes,
    _signalNote
  };
}

async function getCandles(env, symbol, interval, range) {
  // Finnhub first
  try {
    const { res, from, to } = finnhubResolution(interval, range);
    const u = new URL("https://finnhub.io/api/v1/stock/candle");
    u.searchParams.set("symbol", symbol);
    u.searchParams.set("resolution", res);
    u.searchParams.set("from", String(from));
    u.searchParams.set("to", String(to));

    const j = await fhJSON(u.toString(), env);
    if (j?.s === "ok" && Array.isArray(j?.t)) {
      const out = j.t
        .map((t, i) => ({
          t: t * 1000,
          o: num(j.o?.[i]),
          h: num(j.h?.[i]),
          l: num(j.l?.[i]),
          c: num(j.c?.[i]),
          v: num(j.v?.[i])
        }))
        .filter((k) => isFinite(k.c) && isFinite(k.h) && isFinite(k.l));
      if (out.length) return out;
    }
  } catch {}

  // Yahoo fallback
  try {
    const { yi, yr } = yahooParams(interval, range);
    const y = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${yi}&range=${yr}`;
    const r = await fetch(y, {
      headers: { "User-Agent": UA(), Accept: "application/json" },
      cf: { cacheTtl: 30, cacheEverything: true }
    });
    if (r.ok) {
      const j = await r.json();
      const r0 = j?.chart?.result?.[0];
      const ts = r0?.timestamp || [];
      const ind = r0?.indicators?.quote?.[0] || {};
      const out = ts
        .map((t, i) => ({
          t: t * 1000,
          o: num(ind.open?.[i]),
          h: num(ind.high?.[i]),
          l: num(ind.low?.[i]),
          c: num(ind.close?.[i]),
          v: num(ind.volume?.[i])
        }))
        .filter((k) => isFinite(k.c) && isFinite(k.h) && isFinite(k.l));
      if (out.length) return out;
    }
  } catch {}

  return [];
}

function finnhubResolution(interval, range) {
  const now = Math.floor(Date.now() / 1000);
  let res = "15",
    days = 10;
  if (interval === "60m" || interval === "1h") res = "60";
  if (interval === "1d" || interval === "d") res = "D";
  if (range?.endsWith("d")) days = Number(range.replace("d", "")) || 10;
  else if (range?.endsWith("mo")) days = (Number(range.replace("mo", "")) || 1) * 30;
  else if (range?.endsWith("y")) days = (Number(range.replace("y", "")) || 1) * 365;
  const from = now - days * 86400;
  return { res, from, to: now };
}
function yahooParams(interval, range) {
  let yi = "15m";
  if (interval === "60m" || interval === "1h") yi = "60m";
  if (interval === "1d" || interval === "d") yi = "1d";
  let yr = range || "10d";
  return { yi, yr };
}

/* ================= STOCKTWITS SENTIMENT ================= */
async function getStocktwitsSentiment(symbol, env) {
  // 1) Bearer
  if (env.STOCKTWITS_BEARER) {
    try {
      const r = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`, {
        headers: { Authorization: `Bearer ${env.STOCKTWITS_BEARER}`, Accept: "application/json", "User-Agent": UA() },
        cf: { cacheTtl: 60, cacheEverything: true }
      });
      if (r.ok) return summarizeST(await r.json(), "_auth_bearer");
    } catch {}
  }
  // 2) Cookie
  if (env.STOCKTWITS_COOKIE) {
    try {
      const r = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`, {
        headers: { Cookie: env.STOCKTWITS_COOKIE, Accept: "application/json", "User-Agent": UA() },
        cf: { cacheTtl: 60, cacheEverything: true }
      });
      if (r.ok) return summarizeST(await r.json(), "_auth_cookie");
    } catch {}
  }
  // 3) Public JSON
  try {
    const r = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`, {
      headers: { Accept: "application/json", "User-Agent": UA() },
      cf: { cacheTtl: 60, cacheEverything: true }
    });
    if (r.ok) return summarizeST(await r.json(), "_public_json");
  } catch {}

  // 4) HTML scrape fallback
  const tryScrape = async (path) => {
    const r = await fetch(`https://stocktwits.com/symbol/${encodeURIComponent(symbol)}${path}`, {
      headers: { Accept: "text/html", "User-Agent": UA(), Referer: "https://stocktwits.com/" },
      cf: { cacheTtl: 120, cacheEverything: true }
    });
    if (!r.ok) return null;
    const html = await r.text();
    const bullMatch = html.match(/Bullish[^0-9]{0,40}(\d{1,3})%/i);
    const bearMatch = html.match(/Bearish[^0-9]{0,40}(\d{1,3})%/i);
    if (bullMatch || bearMatch) {
      const bullish = clampPct(parseInt(bullMatch?.[1] || "0", 10));
      const bearish = clampPct(parseInt(bearMatch?.[1] || "0", 10));
      const neutral = Math.max(0, 100 - bullish - bearish);
      return { bullish, bearish, neutral, _mode: "_scrape" };
    }
    return { bullish: 0, bearish: 0, neutral: 100, _mode: "_scrape_none" };
  };

  return (await tryScrape("/sentiment")) || (await tryScrape("")) || { bullish: 0, bearish: 0, neutral: 100, _mode: "_none" };
}

function summarizeST(j, modeTag) {
  const msgs = Array.isArray(j?.messages) ? j.messages : [];
  if (!msgs.length) return { bullish: 0, bearish: 0, neutral: 100, _mode: modeTag };
  let bull = 0,
    bear = 0,
    neu = 0;
  for (const m of msgs) {
    const s = m?.entities?.sentiment?.basic;
    if (s === "Bullish") bull++;
    else if (s === "Bearish") bear++;
    else neu++;
  }
  const tot = bull + bear + neu || 1;
  const bullish = Math.round((bull / tot) * 100);
  const bearish = Math.round((bear / tot) * 100);
  const neutral = Math.max(0, 100 - bullish - bearish);
  return { bullish, bearish, neutral, _mode: modeTag };
}

/* ================= TARGETS (Finnhub → FMP → Finviz/MW → Pages) ================= */
async function resolveTarget(env, symbol) {
  try {
    const t = await fhJSON(`https://finnhub.io/api/v1/stock/price-target?symbol=${encodeURIComponent(symbol)}`, env);
    const m = num(t?.targetMean),
      h = num(t?.targetHigh),
      l = num(t?.targetLow);
    if (isFinite(m)) return { targetMeanPrice: round(m), _targetProvider: "finnhub" };
    if (isFinite(h) && isFinite(l)) return { targetMeanPrice: round((h + l) / 2), _targetProvider: "finnhub:avgHL" };
    if (isFinite(h)) return { targetMeanPrice: round(h), _targetProvider: "finnhub:high" };
    if (isFinite(l)) return { targetMeanPrice: round(l), _targetProvider: "finnhub:low" };
  } catch {}

  if (getKeyPool(env, /^FMP_KEY/i).length) {
    try {
      const f = await fmpJSON(`https://financialmodelingprep.com/api/v3/price-target?symbol=${encodeURIComponent(symbol)}`, env);
      const row = Array.isArray(f) ? f[0] : Array.isArray(f?.data) ? f.data[0] : f;
      const m = num(row?.targetMean ?? row?.priceTargetAverage ?? row?.average);
      const h = num(row?.targetHigh ?? row?.priceTargetHigh ?? row?.high);
      const l = num(row?.targetLow ?? row?.priceTargetLow ?? row?.low);
      if (isFinite(m)) return { targetMeanPrice: round(m), _targetProvider: "fmp" };
      if (isFinite(h) && isFinite(l)) return { targetMeanPrice: round((h + l) / 2), _targetProvider: "fmp:avgHL" };
      if (isFinite(h)) return { targetMeanPrice: round(h), _targetProvider: "fmp:high" };
      if (isFinite(l)) return { targetMeanPrice: round(l), _targetProvider: "fmp:low" };
    } catch {}
  }

  try {
    const target = await fetchFinvizTarget(symbol);
    if (isFinite(target)) return { targetMeanPrice: round(target), _targetProvider: "finviz" };
  } catch {}
  try {
    const target = await fetchMarketWatchTarget(symbol);
    if (isFinite(target)) return { targetMeanPrice: round(target), _targetProvider: "marketwatch" };
  } catch {}

  if (PAGES_BASE) {
    try {
      const alt = await fetch(`${PAGES_BASE}/summary.json`, {
        headers: { Accept: "application/json" },
        cf: { cacheTtl: 120, cacheEverything: true }
      });
      if (alt.ok) {
        const arr = await alt.json();
        const row = Array.isArray(arr) ? arr.find((r) => r.symbol === symbol) : null;
        const t = num(row?.targetMeanPrice);
        if (isFinite(t)) return { targetMeanPrice: round(t), _targetProvider: "pages" };
      }
    } catch {}
  }

  return { targetMeanPrice: null, _targetProvider: null };
}

async function fetchFinvizTarget(symbol) {
  const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(symbol)}`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA(), Accept: "text/html", Referer: "https://finviz.com" },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!r.ok) throw new Error(`Finviz ${r.status}`);
  const html = await r.text();
  const m = html.match(/Target Price<\/td>\s*<td[^>]*>\s*\$?\s*([\d.,]+)/i);
  return m ? Number(String(m[1]).replace(/,/g, "")) : null;
}

async function fetchMarketWatchTarget(symbol) {
  const urls = [
    `https://www.marketwatch.com/investing/stock/${encodeURIComponent(symbol)}`,
    `https://www.marketwatch.com/investing/stock/${encodeURIComponent(symbol)}/analystestimates`
  ];
  for (const u of urls) {
    const r = await fetch(u, {
      headers: { "User-Agent": UA(), Accept: "text/html" },
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!r.ok) continue;
    const html = await r.text();
    const m = html.match(/(Average )?Price Target[^$]*\$?\s*([\d.,]+)/i);
    if (m) return Number(String(m[2]).replace(/,/g, ""));
  }
  return null;
}

/* ================= OPTIONS (Tradier optional → Finnhub → null) ================= */
async function getOptions(env, symbol, date) {
  if (getKeyPool(env, /^TRADIER_TOKEN/i).length) {
    const out = await optionsViaTradier(symbol, date, env);
    if (out) return { ...out, _provider: "tradier", _mode: "live" };
  }
  const outFH = await optionsViaFinnhub(symbol, date, env);
  if (outFH) return { ...outFH, _provider: "finnhub", _mode: "live" };
  return null;
}

function normalizeTradierExpirations(json) {
  const dates = json?.expirations?.date;
  if (Array.isArray(dates)) return dates.sort();
  if (typeof dates === "string") return [dates];
  return [];
}

function normalizeTradierChain(json) {
  const arr = json?.options?.option;
  const list = Array.isArray(arr) ? arr : arr ? [arr] : [];
  return list
    .map((o) => ({
      type: String(o?.option_type || "").toLowerCase(),
      strike: num(o?.strike),
      bid: num(o?.bid),
      ask: num(o?.ask),
      last: num(o?.last),
      expiration: o?.expiration_date || null
    }))
    .filter((x) => isFinite(x.strike));
}

function buildStrategies({ price, calls, puts, expiration }) {
  let atmCall = null,
    atmPut = null;

  if (isFinite(price)) {
    atmCall = calls.find((c) => c.strike >= price) || closest(calls, price);
    const below = puts.filter((p) => p.strike <= price);
    atmPut = below.length ? below[below.length - 1] : closest(puts, price);
  }

  const nextHigher = (s) => calls.find((c) => c.strike > s);
  const nextLower = (s) => {
    const b = puts.filter((p) => p.strike < s);
    return b.length ? b[b.length - 1] : null;
  };

  let bullCallSpread = null,
    bearPutSpread = null,
    bullPutCredit = null,
    bearCallCredit = null,
    ironCondor = null;

  if (atmCall) {
    const c2 = nextHigher(atmCall.strike);
    if (c2) {
      const debit = (atmCall.mid ?? 0) - (c2.mid ?? 0);
      bullCallSpread = { lower: atmCall.strike, upper: c2.strike, debit: round(debit) };
      bearCallCredit = { short: atmCall.strike, long: c2.strike, credit: round((atmCall.mid ?? 0) - (c2.mid ?? 0)) };
    }
  }

  if (atmPut) {
    const p2 = nextLower(atmPut.strike);
    if (p2) {
      const debit = (atmPut.mid ?? 0) - (p2.mid ?? 0);
      bearPutSpread = { upper: atmPut.strike, lower: p2.strike, debit: round(debit) };
      bullPutCredit = { short: atmPut.strike, long: p2.strike, credit: round((atmPut.mid ?? 0) - (p2.mid ?? 0)) };
    }
  }

  if (bearCallCredit && bullPutCredit) {
    const widthCall = bearCallCredit.long - bearCallCredit.short;
    const widthPut = bullPutCredit.short - bullPutCredit.long;
    const width = Math.min(widthCall, widthPut);
    const credit = round((bearCallCredit.credit ?? 0) + (bullPutCredit.credit ?? 0));
    const estMaxLoss = width > 0 ? round(width - credit) : null;
    ironCondor = {
      shortPut: bullPutCredit.short,
      longPut: bullPutCredit.long,
      shortCall: bearCallCredit.short,
      longCall: bearCallCredit.long,
      credit,
      width,
      estMaxLoss
    };
  }

  return { expiration, price, atmCall, atmPut, bullCallSpread, bearPutSpread, bullPutCredit, bearCallCredit, ironCondor };
}

async function optionsViaTradier(symbol, date, env) {
  let chosenDate = date;
  if (!chosenDate) {
    const expJSON = await tradierJSON(
      `${TRADIER_BASE}/v1/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true&strikes=false`,
      env
    );
    const exps = normalizeTradierExpirations(expJSON);
    for (const d of exps) {
      const chainJSON = await tradierJSON(
        `${TRADIER_BASE}/v1/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${d}`,
        env
      );
      const opts = normalizeTradierChain(chainJSON);
      if (opts.length) {
        chosenDate = d;
        break;
      }
    }
    if (!chosenDate) return null;
  }

  const chainJSON = await tradierJSON(
    `${TRADIER_BASE}/v1/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${chosenDate}`,
    env
  );
  const opts = normalizeTradierChain(chainJSON);
  if (!opts.length) return null;

  const calls = [],
    puts = [];
  for (const o of opts) {
    const mid =
      isFinite(o.bid) && isFinite(o.ask) && o.ask > 0
        ? (o.bid + o.ask) / 2
        : isFinite(o.last)
          ? o.last
          : null;
    if (mid == null) continue;
    if (o.type.startsWith("c")) calls.push({ strike: o.strike, mid });
    else if (o.type.startsWith("p")) puts.push({ strike: o.strike, mid });
  }
  calls.sort((a, b) => a.strike - b.strike);
  puts.sort((a, b) => a.strike - b.strike);

  let price = null;
  try {
    const q = await tradierJSON(`${TRADIER_BASE}/v1/markets/quotes?symbols=${encodeURIComponent(symbol)}`, env);
    const qv = Array.isArray(q?.quotes?.quote) ? q.quotes.quote[0] : q?.quotes?.quote;
    price = num(qv?.last) ?? num(qv?.bid) ?? num(qv?.ask) ?? null;
  } catch {
    try {
      const fq = await fhJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`, env);
      price = num(fq?.c);
    } catch {}
  }

  return buildStrategies({ price, calls, puts, expiration: chosenDate });
}

async function optionsViaFinnhub(symbol, date, env) {
  let chain,
    pickedGroup = null;

  if (!date) {
    chain = await fhJSON(`https://finnhub.io/api/v1/stock/option-chain?symbol=${encodeURIComponent(symbol)}`, env);
    const groups = Array.isArray(chain?.data) ? chain.data : Array.isArray(chain?.result) ? chain.result : [];
    const first = groups.find((g) => g?.options?.length) || null;
    pickedGroup = first;
    date = first?.expirationDate || first?.date || null;
  }

  if (!pickedGroup) {
    const u = new URL(`https://finnhub.io/api/v1/stock/option-chain`);
    u.searchParams.set("symbol", symbol);
    if (date) u.searchParams.set("date", date);
    chain = await fhJSON(u.toString(), env);
    const groups = Array.isArray(chain?.data) ? chain.data : Array.isArray(chain?.result) ? chain.result : [];
    pickedGroup =
      groups.find((g) => (g.expirationDate === date || g.date === date) && g?.options?.length) ||
      groups.find((g) => g?.options?.length) ||
      null;
  }

  if (!pickedGroup) return null;

  const calls = [],
    puts = [];
  for (const o of pickedGroup.options || []) {
    const type = String(o?.type || o?.side || "").toLowerCase();
    const strike = num(o?.strike);
    const bid = num(o?.bid),
      ask = num(o?.ask),
      last = num(o?.last);
    const mid =
      isFinite(bid) && isFinite(ask) && ask > 0 ? (bid + ask) / 2 : isFinite(last) ? last : null;
    if (!isFinite(strike) || mid == null) continue;
    if (type.startsWith("c")) calls.push({ strike, mid });
    if (type.startsWith("p")) puts.push({ strike, mid });
  }
  calls.sort((a, b) => a.strike - b.strike);
  puts.sort((a, b) => a.strike - b.strike);

  let price = null;
  try {
    const q = await fhJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`, env);
    price = num(q?.c);
  } catch {}

  return buildStrategies({ price, calls, puts, expiration: date || null });
}

/* ================= helpers & HTTP utils ================= */
function cors(req, extra = {}) {
  const origin = req && req.headers ? req.headers.get("Origin") || "*" : "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    // UPDATED: allow POST for the OpenAI proxy while keeping GET endpoints intact
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Timing-Allow-Origin": origin,
    "Content-Type": "application/json; charset=utf-8",
    ...extra
  };
}

function json(req, data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...cors(req), ...headers }
  });
}
function jsonErr(req, status, msg, extra = {}) {
  return json(req, { error: msg, status, ...extra }, status);
}

function sanitize(s) {
  if (!s) return null;
  s = s.toUpperCase().trim();
  return /^[A-Z0-9.\-^=]{1,10}$/.test(s) ? s : null;
}
function round(x) {
  return Number((x ?? 0).toFixed(2));
}
function num(x) {
  const n = Number(x);
  return isFinite(n) ? n : null;
}
function clamp(min, max, v) {
  return Math.max(min, Math.min(max, v));
}
function clampPct(v) {
  v = Number(v || 0);
  if (!isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}
function clamp01(x) {
  return clamp(0, 1, Number(x || 0));
}
function closest(arr, price) {
  if (!arr?.length) return null;
  return arr.slice().sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))[0];
}
function UA() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getKeyPool(env, regexPrefix) {
  const keys = [];
  for (const k of Object.keys(env || {})) if (regexPrefix.test(k) && env[k]) keys.push(env[k]);
  // shuffle to distribute load/quotas
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return keys;
}

async function safeSnippet(res) {
  try {
    const t = await res.text();
    return (t || "").slice(0, 160).replace(/\s+/g, " ");
  } catch {
    return "<no-body>";
  }
}

async function fhJSON(url, env, { tries = 2, timeoutMs = 9000 } = {}) {
  const pool = getKeyPool(env, /^FINNHUB_KEY/i);
  if (!pool.length) throw new Error("No FINNHUB_KEY");
  let lastErr;
  for (const key of pool) {
    const u = new URL(url);
    u.searchParams.set("token", key);
    for (let i = 0; i < tries; i++)
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        const r = await fetch(u, {
          signal: ctl.signal,
          headers: { Accept: "application/json", "User-Agent": UA() },
          cf: { cacheTtl: 20, cacheEverything: true }
        });
        clearTimeout(t);
        if (!r.ok) {
          const body = await safeSnippet(r);
          throw new Error(`Finnhub ${r.status} ${body}`);
        }
        return await r.json();
      } catch (e) {
        lastErr = e;
        await sleep(160);
      }
  }
  throw lastErr || new Error("Finnhub error");
}

async function tradierJSON(url, env, { tries = 2, timeoutMs = 9000 } = {}) {
  const pool = getKeyPool(env, /^TRADIER_TOKEN/i);
  if (!pool.length) throw new Error("No TRADIER_TOKEN");
  let lastErr;
  for (const token of pool) {
    for (let i = 0; i < tries; i++)
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        const r = await fetch(url, {
          signal: ctl.signal,
          headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": UA() },
          cf: { cacheTtl: 15, cacheEverything: true }
        });
        clearTimeout(t);
        if (!r.ok) {
          const body = await safeSnippet(r);
          throw new Error(`Tradier ${r.status} ${body}`);
        }
        return await r.json();
      } catch (e) {
        lastErr = e;
        await sleep(140);
      }
  }
  throw lastErr || new Error("Tradier error");
}

async function fmpJSON(url, env, { tries = 2, timeoutMs = 9000 } = {}) {
  const pool = getKeyPool(env, /^FMP_KEY/i);
  if (!pool.length) throw new Error("No FMP_KEY");
  let lastErr;
  for (const key of pool) {
    const u = new URL(url);
    u.searchParams.set("apikey", key);
    for (let i = 0; i < tries; i++)
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        const r = await fetch(u, {
          signal: ctl.signal,
          headers: { Accept: "application/json", "User-Agent": UA() },
          cf: { cacheTtl: 60, cacheEverything: true }
        });
        clearTimeout(t);
        if (!r.ok) {
          const body = await safeSnippet(r);
          throw new Error(`FMP ${r.status} ${body}`);
        }
        return await r.json();
      } catch (e) {
        lastErr = e;
        await sleep(160);
      }
  }
  throw lastErr || new Error("FMP error");
}

/* ================= YAHOO PREDEFINED SCREENER (proxy) ================= */
const YF_SCREENER = "https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved";
function sanitizeCount(v) {
  const n = Number(v || 100);
  if (!isFinite(n)) return 100;
  return Math.max(1, Math.min(250, Math.floor(n)));
}
async function fetchYahooPredefined(scrId, count = 100) {
  const u = new URL(YF_SCREENER);
  u.searchParams.set("scrIds", scrId);
  u.searchParams.set("count", String(count));
  u.searchParams.set("formatted", "false");
  u.searchParams.set("lang", "en-US");
  u.searchParams.set("region", "US");
  u.searchParams.set("enableSectorIndustryLabelFix", "true");
  u.searchParams.set("corsDomain", "finance.yahoo.com");

  const r = await fetch(u.toString(), {
    headers: { Accept: "application/json", "User-Agent": UA() },
    cf: { cacheTtl: 60, cacheEverything: true }
  });

  if (!r.ok) {
    const body = await safeSnippet(r);
    throw new Error(`Yahoo ${r.status} ${body}`);
  }

  const j = await r.json();
  const res = j?.finance?.result?.[0] || {};
  const total = Number(res.total || 0);
  const rawQuotes = Array.isArray(res.quotes) ? res.quotes : [];
  const quotes = rawQuotes
    .map((q) => ({ ...q, symbol: String(q?.symbol || "").toUpperCase() }))
    .filter((q) => q.symbol);
  return { quotes, total };
}

/* ================= indicators ================= */
function awesomeOscillator(medianPrices, short = 5, long = 34) {
  if (!Array.isArray(medianPrices) || medianPrices.length < long) return null;
  const smaS = SMA(medianPrices, short);
  const smaL = SMA(medianPrices, long);
  const n = Math.min(smaS.length, smaL.length);
  if (!n) return null;
  return smaS.at(-1) - smaL.at(-1);
}
function choppinessIndex(candles, n = 14) {
  if (!Array.isArray(candles) || candles.length < n + 1) return null;
  const slice = candles.slice(-n);
  const highs = slice.map((k) => k.h),
    lows = slice.map((k) => k.l);
  const maxH = Math.max(...highs),
    minL = Math.min(...lows);
  const trSum = sumTrueRange(candles.slice(-(n + 1)));
  if (maxH === minL || trSum === 0) return 100;
  const chop = (100 * Math.log10(trSum / (maxH - minL))) / Math.log10(n);
  return round(chop);
}
function averageTrueRange(candles, n = 14) {
  if (!Array.isArray(candles) || candles.length < n + 1) return 0;
  const seg = candles.slice(-(n + 1));
  const trs = [];
  for (let i = 1; i < seg.length; i++) {
    const cur = seg[i],
      prev = seg[i - 1];
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length || 0;
}
function SMA(arr, period) {
  const out = [];
  for (let i = 0; i <= arr.length - period; i++) {
    const s = arr.slice(i, i + period).reduce((a, b) => a + (b || 0), 0) / period;
    out.push(s);
  }
  return out;
}
function sumTrueRange(candles) {
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i],
      p = candles[i - 1];
    const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    sum += tr;
  }
  return sum;
}
function slope(series) {
  const x = series.map((_, i) => i),
    y = series.map((v) => Number(v || 0));
  const n = x.length;
  if (n < 2) return 0;
  const sx = x.reduce((a, b) => a + b, 0),
    sy = y.reduce((a, b) => a + b, 0);
  const sxx = x.reduce((a, b) => a + b * b, 0),
    sxy = x.reduce((a, xi, i) => a + xi * y[i], 0);
  const denom = n * sxx - sx * sx || 1;
  return (n * sxy - sx * sy) / denom;
}
function boostSignal(current, desired) {
  if (desired !== "BUY") return current;
  if (current === "HOLD") return "BUY";
  if (current === "SELL") return "HOLD";
  return current;
}

/* ================= mocks ================= */
function mockPayload(symbol) {
  return {
    symbol,
    price: 123.45,
    targetMeanPrice: 140,
    recommendationKey: "buy",
    options: {
      expiration: "2025-09-19",
      atmCall: { strike: 125, mid: 4.2 },
      atmPut: { strike: 120, mid: 3.8 },
      bullCallSpread: { lower: 125, upper: 130, debit: 1.95 },
      bearPutSpread: { upper: 120, lower: 115, debit: 1.55 },
      bullPutCredit: { short: 120, long: 115, credit: 1.1 },
      bearCallCredit: { short: 125, long: 130, credit: 1.05 },
      ironCondor: { shortPut: 120, longPut: 115, shortCall: 125, longCall: 130, credit: 2.15, width: 5, estMaxLoss: 2.85 }
    },
    _mode: "mock"
  };
}

function summarizeRecs(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const x = arr[0];
  const score =
    (+x?.strongBuy || 0) + (+x?.buy || 0) - ((+x?.sell || 0) + (+x?.strongSell || 0));
  if (score >= 1) return "buy";
  if (score <= -1) return "sell";
  return "hold";
}
