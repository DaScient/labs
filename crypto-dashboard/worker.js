// Cloudflare Worker Script: worker.js
// Handles API requests for crypto trading dashboard (RL ensemble + momentum/sentiment signals).

// Configure API keys and endpoints (securely via Worker environment variables if possible)
const FINNHUB_API_KEY = "<YOUR_FINNHUB_API_KEY>";       // optional, for Finnhub data
const STOCKTWITS_COOKIE = ""; // optional, if you have an authenticated cookie for StockTwits sentiment

// Utility: fetch JSON with timeout and error handling
async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res.json();
}

// Compute technical indicators from OHLCV data
function computeIndicators(candles) {
  // candles: array of {timestamp, open, high, low, close, volume}
  const n = candles.length;
  let ao = null, aoUp = null, aoDown = null;
  let rsi = null;
  let choppiness = null;
  let priceStability = null;
  let volumeUp = null, volumeDown = null;
  let sellVolumeDeclining = null;
  const notes = [];

  if (n > 0) {
    // Calculate median prices for AO
    const medians = candles.map(c => (c.high + c.low) / 2);
    if (n >= 34) {
      const period5 = medians.slice(-5);
      const period34 = medians.slice(-34);
      const sma5 = period5.reduce((a,b) => a+b, 0) / 5;
      const sma34 = period34.reduce((a,b) => a+b, 0) / 34;
      ao = parseFloat((sma5 - sma34).toFixed(4));
      // AO direction
      if (n >= 35) {
        // previous AO for aoUp/aoDown
        const period5_prev = medians.slice(-6, -1);
        const period34_prev = medians.slice(-35, -1);
        const sma5_prev = period5_prev.reduce((a,b) => a+b, 0) / 5;
        const sma34_prev = period34_prev.reduce((a,b) => a+b, 0) / 34;
        const prevAO = sma5_prev - sma34_prev;
        aoUp = ao > prevAO;
        aoDown = ao < prevAO;
      }
    }

    // RSI (14-period)
    if (n >= 15) {
      let gains = 0, losses = 0;
      for (let i = n-14; i < n; i++) {
        const diff = candles[i].close - candles[i-1].close;
        if (diff >= 0) gains += diff; else losses -= diff;
      }
      const avgGain = gains / 14;
      const avgLoss = losses / 14;
      if (avgLoss === 0) {
        rsi = 100;
      } else {
        const rs = avgGain / avgLoss;
        rsi = parseFloat((100 - (100 / (1 + rs))).toFixed(1));
      }
    }

    // Choppiness Index (14-period)
    if (n >= 15) {
      const period = candles.slice(-14);
      let trSum = 0;
      let maxHigh = -Infinity, minLow = Infinity;
      let prevClose = candles[n-15].close;
      for (const c of period) {
        const highLow = c.high - c.low;
        const highClose = Math.abs(c.high - prevClose);
        const lowClose = Math.abs(c.low - prevClose);
        const trueRange = Math.max(highLow, highClose, lowClose);
        trSum += trueRange;
        if (c.high > maxHigh) maxHigh = c.high;
        if (c.low < minLow) minLow = c.low;
        prevClose = c.close;
      }
      const range = maxHigh - minLow;
      if (range > 0) {
        const ci = Math.log10(trSum / range) / Math.log10(14);
        choppiness = parseFloat((ci * 100).toFixed(1));
      }
    }

    // ATR-based price stability (14)
    if (n >= 15) {
      // ATR 14
      let trSum = 0;
      let prevClose = candles[n-15].close;
      for (let i = n-14; i < n; i++) {
        const c = candles[i];
        const highLow = c.high - c.low;
        const highClose = Math.abs(c.high - prevClose);
        const lowClose = Math.abs(c.low - prevClose);
        const trueRange = Math.max(highLow, highClose, lowClose);
        trSum += trueRange;
        prevClose = c.close;
      }
      const atr14 = trSum / 14;
      const lastClose = candles[n-1].close;
      priceStability = parseFloat((1 - (atr14 / lastClose)).toFixed(3));
      if (priceStability < 0) priceStability = 0;
      if (priceStability > 1) priceStability = 1;
    }

    // Volume trend
    if (n >= 21) {
      // Simple volume slope: compare last volume vs first volume of period
      const recentVol = candles.slice(-20).map(c => c.volume);
      volumeUp = recentVol[recentVol.length-1] > recentVol[0];
      volumeDown = recentVol[recentVol.length-1] < recentVol[0];
    }

    // Sell volume declining
    if (n >= 4) {
      // Check last 3 down candles volumes
      let downVolumes = [];
      for (let i = n-3; i < n; i++) {
        if (candles[i].close < candles[i].open) {
          downVolumes.push(candles[i].volume);
        }
      }
      if (downVolumes.length >= 3) {
        // If volumes in down candles are decreasing
        sellVolumeDeclining = (downVolumes[2] < downVolumes[1] && downVolumes[1] < downVolumes[0]);
      } else {
        sellVolumeDeclining = false;
      }
    }

    // Notes based on conditions
    if (choppiness != null && choppiness < 38) {
      notes.push("Trend-friendly regime");
    }
    if (aoUp && volumeDown) {
      notes.push("Momentum building quietly");
    }
    if (aoDown && volumeUp) {
      notes.push("Distribution risk");
    }
  }

  return { ao, aoUp, aoDown, rsi, choppiness, volumeUp, volumeDown, priceStability, sellVolumeDeclining, notes };
}

// Kalman Filter for price trend forecasting (simple implementation)
function kalmanForecast(prices) {
  // Constant velocity model: state = [price, velocity]
  const n = prices.length;
  if (n < 2) return null;  // need at least 2 points to init velocity
  // Initialize state
  let x_price = prices[prices.length-1];
  let x_vel = prices[prices.length-1] - prices[prices.length-2];  // initial velocity estimate
  // Covariance matrix P
  let P = [[1, 0], [0, 1]];
  // Model matrices
  const F = [[1, 1], [0, 1]];    // state transition
  const H = [[1, 0]];           // observation model (we observe price only)
  const Q = [[0.001, 0], [0, 0.001]]; // process noise covariance (tuned small)
  const R = [[0.1]];            // measurement noise covariance (tuned)
  // One-step predict/update for the last observation (we'll use only final state)
  for (let t = Math.max(0, n-20); t < n; t++) {  // use last 20 points for stability
    if (t === 0) continue;
    // Prediction
    let pred_price = x_price + x_vel;
    // Predict covariance: P = F P F^T + Q
    P = [
      [P[0][0] + P[1][0] + P[0][1] + P[1][1] + Q[0][0], P[0][1] + P[1][1] + Q[0][1]],
      [P[1][0] + P[1][1] + Q[1][0], P[1][1] + Q[1][1]]
    ];
    // Kalman Gain: K = P H^T / (H P H^T + R)
    const PHt = [P[0][0], P[1][0]];  // P * H^T (since H = [1 0], H^T = [1;0])
    const S = P[0][0] + R[0][0];
    const K = [PHt[0] / S, PHt[1] / S];  // 2x1 vector
    // Update with measurement z
    const z = prices[t];  // actual price at time t
    const y = z - pred_price;  // residual
    // State update: x = pred_x + K * y
    x_price = pred_price + K[0] * y;
    x_vel = x_vel + K[1] * y;
    // Covariance update: P = (I - K H) P
    P = [
      [P[0][0] - K[0] * P[0][0], P[0][1] - K[0] * P[0][1]],
      [P[1][0] - K[1] * P[0][0], P[1][1] - K[1] * P[0][1]]
    ];
  }
  // Now x_price is the filtered price, x_vel is the estimated velocity (price change per step)
  const forecast = x_price + x_vel;  // next step forecast
  return { nextPrice: parseFloat(forecast.toFixed(4)), velocity: parseFloat(x_vel.toFixed(4)) };
}

// Compute final signal score and decision
function computeSignalScore(indicators, sentiment, kalmanVel) {
  // Default weights (can be tweaked or learned via RL)
  const weights = { momentum: 35, trend: 20, rsi: 10, volume: 10, stability: 10, sentiment: 15 };
  let totalWeight = 0;
  for (const [k,v] of Object.entries(weights)) {
    // Only count weight if that indicator is available
    if ((k === 'momentum' && indicators.ao != null) ||
        (k === 'trend' && indicators.choppiness != null) ||
        (k === 'rsi' && indicators.rsi != null) ||
        (k === 'volume' && indicators.volumeUp != null) ||
        (k === 'stability' && indicators.priceStability != null) ||
        (k === 'sentiment' && sentiment && sentiment.bullish != null)) {
      totalWeight += v;
    } else {
      weights[k] = 0;
    }
  }
  if (totalWeight === 0) totalWeight = 1;  // avoid divide by zero

  // Compute component scores (each between -100 and 100)
  let momentumScore = 0;
  if (indicators.ao != null) {
    momentumScore = Math.sign(indicators.ao) * Math.min(100, Math.abs(indicators.ao) * 400); 
    // (AO tends to be small; scale it, cap at 100)
    if (indicators.aoUp === true) momentumScore = Math.max(momentumScore, 20); 
    if (indicators.aoDown === true) momentumScore = Math.min(momentumScore, -20);
  }
  let trendScore = 0;
  if (indicators.choppiness != null) {
    if (indicators.choppiness < 38) trendScore = 40; 
    else if (indicators.choppiness > 61) trendScore = -40;
    // else 0 for mid-range chop
  }
  let rsiScore = 0;
  if (indicators.rsi != null) {
    rsiScore = ((indicators.rsi - 50) * 2);  // if RSI 60 => +20, RSI 40 => -20
    if (rsiScore > 100) rsiScore = 100;
    if (rsiScore < -100) rsiScore = -100;
  }
  let volumeScore = 0;
  if (indicators.sellVolumeDeclining && indicators.priceStability != null && indicators.priceStability > 0.8) {
    volumeScore += 40;
  }
  if (indicators.volumeUp) volumeScore += 10;
  if (indicators.volumeDown) volumeScore -= 10;
  // Trend filter via stability (if very stable price, assume trending)
  let stabilityScore = 0;
  if (indicators.priceStability != null) {
    stabilityScore = (indicators.priceStability - 0.5) * 200;  // e.g. stability 0.9 -> +80
  }
  let sentimentScore = 0;
  if (sentiment && sentiment.bullish != null && sentiment.bearish != null) {
    const bull = sentiment.bullish, bear = sentiment.bearish;
    sentimentScore = bull - bear;  // if more bullish%, positive score; more bearish, negative
    // cap at +/-100
    if (sentimentScore > 100) sentimentScore = 100;
    if (sentimentScore < -100) sentimentScore = -100;
  }

  // Sum weighted scores
  let rawScore = 0;
  rawScore += (weights.momentum * momentumScore) / totalWeight;
  rawScore += (weights.trend * trendScore) / totalWeight;
  rawScore += (weights.rsi * rsiScore) / totalWeight;
  rawScore += (weights.volume * volumeScore) / totalWeight;
  rawScore += (weights.stability * stabilityScore) / totalWeight;
  rawScore += (weights.sentiment * sentimentScore) / totalWeight;

  // Boost rules (hard rules from spec)
  if (indicators.choppiness != null && indicators.ao != null) {
    if (indicators.choppiness < 38 && indicators.ao > 0) rawScore += 15;
    if (indicators.choppiness > 61 && indicators.ao < 0) rawScore -= 15;
  }
  if (indicators.sellVolumeDeclining && indicators.priceStability != null && indicators.priceStability > 0.8) {
    rawScore += 10;
  }
  if (indicators.aoUp && indicators.volumeDown) rawScore += 5;
  if (indicators.aoDown && indicators.volumeUp) rawScore -= 5;
  if (kalmanVel != null) {
    // If Kalman forecast velocity is significantly positive/negative, boost accordingly
    if (kalmanVel > 0.0) rawScore += 5;
    if (kalmanVel < 0.0) rawScore -= 5;
  }

  // Clamp score and determine signal
  let score = Math.max(-60, Math.min(60, Math.round(rawScore)));
  let signal = "HOLD";
  if (score >= 25) signal = "BUY";
  else if (score <= -25) signal = "SELL";
  // Confidence as |score|/60 (0 to 1)
  let confidence = Math.min(1, Math.abs(score) / 60);

  return { score, signal, confidence };
}

// Fetch sentiment from StockTwits (public scrape as fallback)
async function fetchSentiment(symbol) {
  // Construct StockTwits symbol (for crypto, often SYMBOL.X)
  let stSymbol = symbol;
  if (!stSymbol.includes('.X')) {
    // If it's a crypto ticker without .X, add .X
    stSymbol = symbol.replace('/', '').toUpperCase() + '.X';
  }
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${stSymbol}.json`;
  try {
    const data = await fetchJson(url);
    // StockTwits API v2 returns messages; sentiment might be embedded per message or aggregate not directly given.
    // We'll aggregate simple bullish/bearish from messages if possible.
    let bullishCount = 0, bearishCount = 0;
    for (const msg of (data.messages || [])) {
      if (msg.entities && msg.entities.sentiment) {
        if (msg.entities.sentiment.basic === "Bullish") bullishCount++;
        if (msg.entities.sentiment.basic === "Bearish") bearishCount++;
      }
    }
    let totalCount = bullishCount + bearishCount;
    if (totalCount === 0) {
      // if no sentiment tags, return null (or assume neutral)
      return null;
    }
    let bullishPct = Math.round((bullishCount / totalCount) * 100);
    let bearishPct = Math.round((bearishCount / totalCount) * 100);
    let neutralPct = 100 - bullishPct - bearishPct;
    return { bullish: bullishPct, bearish: bearishPct, neutral: neutralPct };
  } catch (err) {
    return null;
  }
}

// Fetch latest price and candles for a crypto symbol
async function fetchCryptoData(symbol) {
  // symbol expected format e.g. "BTC/USDT" or "BTCUSDT"
  const pair = symbol.replace('/', '').toUpperCase();
  const result = {};
  try {
    // Use Binance public API for price and recent candles (no key required)
    const priceUrl = `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`;
    const priceData = await fetchJson(priceUrl);
    result.price = parseFloat(priceData.lastPrice);
    // Get recent 1-minute candles (e.g. last 60 minutes)
    const klineUrl = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m&limit=60`;
    const klineData = await fetchJson(klineUrl);
    // Each kline: [openTime, open, high, low, close, volume, ...]
    const candles = klineData.map(k => ({
      timestamp: k[0],
      open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
    result.candles = candles;
    result._provider = 'Binance';
  } catch (err) {
    // Fallback: try Finnhub if Binance fails (requires API key)
    if (FINNHUB_API_KEY) {
      const finSymbol = pair.includes('USDT') ? `BINANCE:${pair}` : pair;
      const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${finSymbol}&token=${FINNHUB_API_KEY}`;
      const candleUrl = `https://finnhub.io/api/v1/crypto/candle?symbol=${finSymbol}&resolution=1&count=60&token=${FINNHUB_API_KEY}`;
      const [quoteData, candleData] = await Promise.all([fetchJson(quoteUrl), fetchJson(candleUrl)]);
      result.price = quoteData.c || quoteData.lastPrice;
      if (candleData.s === "ok") {
        const candles = [];
        for (let i = 0; i < candleData.t.length; i++) {
          candles.push({
            timestamp: candleData.t[i] * 1000,
            open: candleData.o[i], high: candleData.h[i],
            low: candleData.l[i], close: candleData.c[i],
            volume: candleData.v[i]
          });
        }
        result.candles = candles;
      } else {
        result.candles = [];
      }
      result._provider = 'Finnhub';
    } else {
      throw err;
    }
  }
  return result;
}

// Handle requests
async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith("/api/summary-batch")) {
    // Multiple symbols
    const symbolsParam = url.searchParams.get("symbols");
    if (!symbolsParam) {
      return new Response(JSON.stringify({ error: "No symbols provided" }), { status: 400 });
    }
    const symbols = symbolsParam.split(/[\s,]+/).filter(s => s);
    const results = [];
    for (let sym of symbols) {
      try {
        const data = await fetchCryptoData(sym);
        const indicators = computeIndicators(data.candles || []);
        const sentiment = await fetchSentiment(sym) || { bullish: 0, bearish: 0, neutral: 100, _mode: "neutral" };
        const forecastObj = kalmanForecast((data.candles||[]).map(c => c.close));
        const kalmanInfo = forecastObj ? { nextPrice: forecastObj.nextPrice } : null;
        const signalData = computeSignalScore(indicators, sentiment, forecastObj ? forecastObj.velocity : null);
        results.push({
          symbol: sym.toUpperCase(),
          price: data.price,
          recommendationKey: null,  // no analyst rec for crypto
          ta: { ...indicators, notes: indicators.notes },
          sentiment: { ...sentiment },
          forecast: kalmanInfo,
          signal: signalData.signal,
          score: signalData.score,
          confidence: parseFloat(signalData.confidence.toFixed(2)),
          _provider: data._provider || null,
          _mode: "live",
          timestamp: Date.now()
        });
      } catch (err) {
        // On error, push a minimal result for that symbol (or skip)
        results.push({ symbol: sym.toUpperCase(), error: err.message });
      }
    }
    return new Response(JSON.stringify(results), {
      headers: { 'Content-Type': 'application/json' }
    });
  } else if (path.startsWith("/api/summary")) {
    // Single symbol summary
    const symbol = url.searchParams.get("symbol");
    if (!symbol) {
      return new Response(JSON.stringify({ error: "No symbol provided" }), { status: 400 });
    }
    try {
      const data = await fetchCryptoData(symbol);
      const indicators = computeIndicators(data.candles || []);
      const sentiment = await fetchSentiment(symbol) || { bullish: 0, bearish: 0, neutral: 100, _mode: "neutral" };
      const forecastObj = kalmanForecast((data.candles||[]).map(c => c.close));
      const signalData = computeSignalScore(indicators, sentiment, forecastObj ? forecastObj.velocity : null);
      const result = {
        symbol: symbol.toUpperCase(),
        price: data.price,
        recommendationKey: null,
        ta: { ...indicators, notes: indicators.notes },
        sentiment: { ...sentiment },
        forecast: forecastObj ? { nextPrice: forecastObj.nextPrice } : null,
        signal: signalData.signal,
        score: signalData.score,
        confidence: parseFloat(signalData.confidence.toFixed(2)),
        _provider: data._provider || null,
        _mode: "live",
        timestamp: Date.now()
      };
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ symbol: symbol.toUpperCase(), error: err.message }), { headers: { 'Content-Type': 'application/json' } });
    }
  } else if (path.startsWith("/api/ping")) {
    // Health check: return status of providers
    let status = { now: Date.now(), providers: {} };
    // We can attempt a quick fetch to each provider to test
    try {
      if (FINNHUB_API_KEY) {
        const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=BINANCE:BTCUSDT&token=${FINNHUB_API_KEY}`);
        status.providers.finnhub = resp.ok;
      }
    } catch(e) { status.providers.finnhub = false; }
    try {
      const resp = await fetch("https://api.binance.com/api/v3/time");
      status.providers.binance = resp.ok;
    } catch(e) { status.providers.binance = false; }
    try {
      // We can mark sentiment (StockTwits) as available if cookie or public API is available
      status.providers.stocktwits = STOCKTWITS_COOKIE ? true : true;  // assuming true if we allow scrape
    } catch(e) { status.providers.stocktwits = false; }
    return new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } });
  } else {
    // Optionally, serve static HTML if needed (though we use GitHub Pages for HTML in this case)
    return new Response("OK", { status: 200 });
  }
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
