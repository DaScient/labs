// Cloudflare Worker — Crypto Dashboard API (Binance + Finnhub fallback)
// Features:
// - CORS + OPTIONS preflight
// - Binance primary with host-rotation + mirror; Finnhub fallback (FINNHUB_API_KEYS or FINNHUB_API_KEY)
// - Concurrency-limited batch to reduce 429s
// - Safe JSON errors; edge caching on public endpoints
// - Diagnostics: /api/diag and /api/selftest

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return corsPreflight(env);

      if (url.pathname === "/api/ping")         return withCORS(await ping(env), env);
      if (url.pathname === "/api/diag")         return withCORS(await diag(env), env);
      if (url.pathname === "/api/selftest")     return withCORS(await selftest(env), env);
      if (url.pathname.startsWith("/api/summary-batch")) return withCORS(await summaryBatch(url, env, ctx), env);
      if (url.pathname.startsWith("/api/summary"))       return withCORS(await summary(url, env, ctx), env);

      return withCORS(json({ ok: true, message: "Crypto API online" }), env);
    } catch (err) {
      return withCORS(json({ error: "Internal error", detail: err?.message || String(err) }, 500), env);
    }
  }
};

/* ------------------- CORS ------------------- */
function corsHeaders(env) {
  const allow = env.CORS_ALLOW || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
  };
}
function withCORS(res, env) {
  const h = corsHeaders(env);
  for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
  return res;
}
function corsPreflight(env) {
  return withCORS(new Response(null, { status: 204 }), env);
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/* ------------------- Utils ------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...(init.headers || {}) },
    cf: init.cf,
    method: init.method || "GET",
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
  return res.json();
}

// Binance host rotation + official data mirror
async function fetchBinanceJson(path) {
  // All hosts implement /api/v3/* shape
  const hosts = [
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://data-api.binance.vision"
  ];
  let lastErr;
  for (const host of hosts) {
    try {
      const url = `${host}${path}`;
      const res = await fetch(url, {
        headers: {
          "Accept": "application/json",
          // A friendlier UA can help avoid edge bot rules at some POPs
          "User-Agent": "Mozilla/5.0 (compatible; DaScientCryptoDashboard/1.0)"
        },
        cf: { cacheTtl: 10 }
      });
      if (!res.ok) throw new Error(`Binance ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Binance unreachable");
}

// Simple stable hash to spread symbols across Finnhub keys
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0);
}
function getFinnhubKeyForSymbol(env, symbol) {
  const listStr = (env.FINNHUB_API_KEYS || "").trim();
  const keys = listStr
    ? listStr.split(",").map((k) => k.trim()).filter(Boolean)
    : (env.FINNHUB_API_KEY ? [env.FINNHUB_API_KEY] : []);
  if (!keys.length) return null;
  const idx = hashStr(symbol) % keys.length;
  return keys[idx];
}

/* ------------------- Indicators ------------------- */
function computeIndicators(candles) {
  const n = candles.length;
  let ao = null, aoUp = null, aoDown = null, rsi = null, choppiness = null;
  let priceStability = null, volumeUp = null, volumeDown = null, sellVolumeDeclining = null;
  const notes = [];

  if (n > 0) {
    const med = candles.map((c) => (c.high + c.low) / 2);
    if (n >= 34) {
      const sma5 = med.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const sma34 = med.slice(-34).reduce((a, b) => a + b, 0) / 34;
      ao = Number((sma5 - sma34).toFixed(6));
      if (n >= 35) {
        const prev5 = med.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
        const prev34 = med.slice(-35, -1).reduce((a, b) => a + b, 0) / 34;
        const prevAO = prev5 - prev34;
        aoUp = ao > prevAO; aoDown = ao < prevAO;
      }
    }
    if (n >= 15) {
      let gains = 0, losses = 0;
      for (let i = n - 14; i < n; i++) {
        const d = candles[i].close - candles[i - 1].close;
        if (d >= 0) gains += d; else losses -= d;
      }
      const avgG = gains / 14, avgL = losses / 14;
      rsi = avgL === 0 ? 100 : Number((100 - (100 / (1 + avgG / avgL))).toFixed(2));
    }
    if (n >= 15) {
      const period = candles.slice(-14);
      let trSum = 0, maxH = -Infinity, minL = Infinity;
      let prevClose = candles[n - 15].close;
      for (const c of period) {
        const hl = c.high - c.low;
        const hc = Math.abs(c.high - prevClose);
        const lc = Math.abs(c.low - prevClose);
        const tr = Math.max(hl, hc, lc);
        trSum += tr;
        if (c.high > maxH) maxH = c.high;
        if (c.low < minL) minL = c.low;
        prevClose = c.close;
      }
      const range = maxH - minL;
      if (range > 0) choppiness = Number(((Math.log10(trSum / range) / Math.log10(14)) * 100).toFixed(2));
    }
    if (n >= 15) {
      let trSum = 0; let prev = candles[n - 15].close;
      for (let i = n - 14; i < n; i++) {
        const c = candles[i];
        const hl = c.high - c.low;
        const hc = Math.abs(c.high - prev);
        const lc = Math.abs(c.low - prev);
        trSum += Math.max(hl, hc, lc);
        prev = c.close;
      }
      const atr14 = trSum / 14; const lastClose = candles[n - 1].close;
      priceStability = Math.max(0, Math.min(1, Number((1 - (atr14 / lastClose)).toFixed(4))));
    }
    if (n >= 21) {
      const recentVol = candles.slice(-20).map(c => c.volume);
      volumeUp = recentVol.at(-1) > recentVol[0];
      volumeDown = recentVol.at(-1) < recentVol[0];
    }
    if (n >= 4) {
      let down = [];
      for (let i = n - 3; i < n; i++) if (candles[i].close < candles[i].open) down.push(candles[i].volume);
      sellVolumeDeclining = down.length >= 3 ? (down[2] < down[1] && down[1] < down[0]) : false;
    }
    if (choppiness != null && choppiness < 38) notes.push("Trend-friendly regime");
    if (aoUp && volumeDown) notes.push("Momentum building quietly");
    if (aoDown && volumeUp) notes.push("Distribution risk");
  }
  return { ao, aoUp, aoDown, rsi, choppiness, volumeUp, volumeDown, priceStability, sellVolumeDeclining, notes };
}

function kalmanForecast(prices) {
  const n = prices.length;
  if (n < 2) return null;
  let x_price = prices[n - 1];
  let x_vel = prices[n - 1] - prices[n - 2];
  let P = [[1, 0], [0, 1]];
  const Q = [[0.001, 0], [0, 0.001]], R = [[0.1]];
  for (let t = Math.max(1, n - 20); t < n; t++) {
    let pred_price = x_price + x_vel;
    P = [
      [P[0][0] + P[1][0] + P[0][1] + P[1][1] + Q[0][0], P[0][1] + P[1][1] + Q[0][1]],
      [P[1][0] + P[1][1] + Q[1][0],                     P[1][1] + Q[1][1]]
    ];
    const S = P[0][0] + R[0][0];
    const K0 = P[0][0] / S, K1 = P[1][0] / S;
    const y = prices[t] - pred_price;
    x_price = pred_price + K0 * y;
    x_vel   = x_vel + K1 * y;
    P = [
      [P[0][0] - K0 * P[0][0], P[0][1] - K0 * P[0][1]],
      [P[1][0] - K1 * P[0][0], P[1][1] - K1 * P[0][1]]
    ];
  }
  return { nextPrice: Number((x_price + x_vel).toFixed(6)), velocity: Number(x_vel.toFixed(6)) };
}

function computeSignalScore(ind, sentiment, kalmanVel) {
  const weights = { momentum: 35, trend: 20, rsi: 10, volume: 10, stability: 10, sentiment: 15 };
  let activeTotal = 0;
  for (const [k, v] of Object.entries(weights)) {
    if ((k === "momentum" && ind.ao != null) ||
        (k === "trend"    && ind.choppiness != null) ||
        (k === "rsi"      && ind.rsi != null) ||
        (k === "volume"   && ind.volumeUp != null) ||
        (k === "stability"&& ind.priceStability != null) ||
        (k === "sentiment"&& sentiment && sentiment.bullish != null)) activeTotal += v;
  }
  if (!activeTotal) activeTotal = 1;

  let momentumScore = ind.ao != null ? (Math.sign(ind.ao) * Math.min(100, Math.abs(ind.ao) * 400)) : 0;
  if (ind.aoUp === true) momentumScore = Math.max(momentumScore, 20);
  if (ind.aoDown === true) momentumScore = Math.min(momentumScore, -20);

  let trendScore = ind.choppiness != null ? (ind.choppiness < 38 ? 40 : (ind.choppiness > 61 ? -40 : 0)) : 0;
  let rsiScore = ind.rsi != null ? Math.max(-100, Math.min(100, (ind.rsi - 50) * 2)) : 0;

  let volumeScore = 0;
  if (ind.sellVolumeDeclining && ind.priceStability != null && ind.priceStability > 0.8) volumeScore += 40;
  if (ind.volumeUp) volumeScore += 10;
  if (ind.volumeDown) volumeScore -= 10;

  let stabilityScore = ind.priceStability != null ? (ind.priceStability - 0.5) * 200 : 0;

  let sentimentScore = 0;
  if (sentiment && sentiment.bullish != null && sentiment.bearish != null) {
    sentimentScore = Math.max(-100, Math.min(100, (sentiment.bullish - sentiment.bearish)));
  }

  let raw = 0;
  raw += (weights.momentum * momentumScore) / activeTotal;
  raw += (weights.trend    * trendScore)    / activeTotal;
  raw += (weights.rsi      * rsiScore)      / activeTotal;
  raw += (weights.volume   * volumeScore)   / activeTotal;
  raw += (weights.stability* stabilityScore)/ activeTotal;
  raw += (weights.sentiment* sentimentScore)/ activeTotal;

  if (ind.choppiness != null && ind.ao != null) {
    if (ind.choppiness < 38 && ind.ao > 0) raw += 15;
    if (ind.choppiness > 61 && ind.ao < 0) raw -= 15;
  }
  if (ind.sellVolumeDeclining && ind.priceStability != null && ind.priceStability > 0.8) raw += 10;
  if (ind.aoUp && ind.volumeDown) raw += 5;
  if (ind.aoDown && ind.volumeUp) raw -= 5;
  if (kalmanVel != null) raw += kalmanVel > 0 ? 5 : -5;

  const score = Math.max(-60, Math.min(60, Math.round(raw)));
  const signal = score >= 25 ? "BUY" : (score <= -25 ? "SELL" : "HOLD");
  const confidence = Math.min(1, Math.abs(score) / 60);
  return { score, signal, confidence };
}

/* ------------------- External Data ------------------- */
async function fetchSentiment(symbol) {
  // Stocktwits crypto symbols usually end with .X
  let stSymbol = symbol.replace("/", "").toUpperCase();
  if (!stSymbol.includes(".X")) stSymbol = stSymbol + ".X";
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${stSymbol}.json`;
  try {
    const data = await fetchJson(url, { cf: { cacheTtl: 30 } });
    let bull = 0, bear = 0;
    for (const msg of (data.messages || [])) {
      const s = msg.entities?.sentiment?.basic;
      if (s === "Bullish") bull++;
      if (s === "Bearish") bear++;
    }
    const total = bull + bear;
    if (!total) return null;
    const bullish = Math.round((bull / total) * 100);
    const bearish = Math.round((bear / total) * 100);
    return { bullish, bearish, neutral: 100 - bullish - bearish };
  } catch {
    return null;
  }
}

async function fetchCryptoData(pair, env) {
  const symbol = pair.replace("/", "").toUpperCase();
  const result = {};
  // Try Binance (with host rotation)
  try {
    const [priceData, klineData] = await Promise.all([
      fetchBinanceJson(`/api/v3/ticker/24hr?symbol=${symbol}`),
      fetchBinanceJson(`/api/v3/klines?symbol=${symbol}&interval=1m&limit=120`)
    ]);
    result.price = Number(priceData.lastPrice);
    result.candles = klineData.map(k => ({
      timestamp: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
    result._provider = "Binance";
    return result;
  } catch (binErr) {
    // Finnhub fallback if keys are configured
    const key = getFinnhubKeyForSymbol(env, symbol);
    if (!key) throw binErr;
    const finSymbol = symbol.includes("USDT") ? `BINANCE:${symbol}` : symbol;
    try {
      const quoteUrl  = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(finSymbol)}&token=${key}`;
      const candleUrl = `https://finnhub.io/api/v1/crypto/candle?symbol=${encodeURIComponent(finSymbol)}&resolution=1&count=120&token=${key}`;
      const [quoteData, candleData] = await Promise.all([ fetchJson(quoteUrl), fetchJson(candleUrl) ]);
      result.price = quoteData.c ?? quoteData.lastPrice;
      if (candleData.s === "ok") {
        result.candles = candleData.t.map((t, i) => ({
          timestamp: t * 1000,
          open: candleData.o[i],
          high: candleData.h[i],
          low:  candleData.l[i],
          close:candleData.c[i],
          volume:candleData.v[i],
        }));
      } else {
        result.candles = [];
      }
      result._provider = "Finnhub";
      return result;
    } catch (finErr) {
      throw finErr;
    }
  }
}

/* ------------------- Routes ------------------- */
async function summaryBatch(url, env, ctx) {
  const syms = (url.searchParams.get("symbols") || "").split(/[\s,]+/).filter(Boolean);
  if (!syms.length) return json({ error: "No symbols provided" }, 400);

  const out = new Array(syms.length);
  const concurrency = 10;
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= syms.length) return;
      const sym = syms[i];
      try {
        const data = await fetchCryptoData(sym, env);
        const ind  = computeIndicators(data.candles || []);
        const sent = await fetchSentiment(sym) || { bullish: 0, bearish: 0, neutral: 100, _mode: "neutral" };
        const kf   = kalmanForecast((data.candles || []).map(c => c.close));
        const sig  = computeSignalScore(ind, sent, kf ? kf.velocity : null);

        out[i] = {
          symbol: sym.toUpperCase(),
          price: data.price,
          ta: { ...ind, notes: ind.notes },
          sentiment: { ...sent },
          forecast: kf ? { nextPrice: kf.nextPrice } : null,
          signal: sig.signal, score: sig.score, confidence: Number(sig.confidence.toFixed(2)),
          _provider: data._provider || null, _mode: "live", timestamp: Date.now(),
        };
      } catch (err) {
        out[i] = { symbol: sym.toUpperCase(), error: err?.message || String(err) };
      }
      await sleep(50);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, syms.length) }, () => worker());
  await Promise.all(workers);
  return json(out);
}

async function summary(url, env, ctx) {
  const sym = url.searchParams.get("symbol");
  if (!sym) return json({ error: "No symbol provided" }, 400);

  try {
    const data = await fetchCryptoData(sym, env);
    const ind  = computeIndicators(data.candles || []);
    const sent = await fetchSentiment(sym) || { bullish: 0, bearish: 0, neutral: 100, _mode: "neutral" };
    const kf   = kalmanForecast((data.candles || []).map(c => c.close));
    const sig  = computeSignalScore(ind, sent, kf ? kf.velocity : null);

    return json({
      symbol: sym.toUpperCase(),
      price: data.price,
      ta: { ...ind, notes: ind.notes },
      sentiment: { ...sent },
      forecast: kf ? { nextPrice: kf.nextPrice } : null,
      signal: sig.signal, score: sig.score, confidence: Number(sig.confidence.toFixed(2)),
      _provider: data._provider || null, _mode: "live", timestamp: Date.now(),
    });
  } catch (err) {
    return json({ symbol: sym.toUpperCase(), error: err?.message || String(err) }, 502);
  }
}

async function ping(env) {
  const status = { now: Date.now(), providers: { binance: false, finnhub: false, stocktwits: true } };
  // Try Binance time with rotation
  try {
    const res = await (async () => {
      const hosts = [
        "https://api.binance.com",
        "https://api1.binance.com",
        "https://api2.binance.com",
        "https://api3.binance.com",
        "https://data-api.binance.vision"
      ];
      for (const h of hosts) {
        try {
          const r = await fetch(`${h}/api/v3/time`, { cf: { cacheTtl: 10 } });
          if (r.ok) return r;
        } catch {}
      }
      return null;
    })();
    status.providers.binance = !!(res && res.ok);
  } catch {}

  try {
    const key = getFinnhubKeyForSymbol(env, "BINANCE:BTCUSDT");
    if (key) {
      const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=BINANCE:BTCUSDT&token=${key}`, { cf: { cacheTtl: 10 } });
      status.providers.finnhub = resp.ok;
    }
  } catch {}
  return json(status);
}

/* ------------------- Diagnostics ------------------- */
async function diag(env) {
  const keysList = (env.FINNHUB_API_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
  const hasSingle = !!env.FINNHUB_API_KEY;
  const corsAllow = env.CORS_ALLOW || "*";
  return json({
    ok: true,
    env: {
      FINNHUB_API_KEY_present: hasSingle,
      FINNHUB_API_KEYS_count: keysList.length,
      CORS_ALLOW: corsAllow
    }
  });
}

async function selftest(env) {
  const symbol = "BTC/USDT";
  try {
    const data = await fetchCryptoData(symbol, env);
    return json({
      ok: true,
      symbol,
      provider: data._provider || "unknown",
      samplePrice: data.price
    });
  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) }, 502);
  }
}
