// Cloudflare Worker: options + price/target via Yahoo Finance (public endpoints)
//
// Endpoints:
//   GET /api/summary?symbol=AAPL
//   GET /api/options?symbol=AAPL[&date=UNIX_EXPIRY]
//
// Notes:
// - Adds permissive CORS for embedding on GoDaddy / GitHub Pages.
// - Lightweight caching via fetch cf: { cacheTtl, cacheEverything }.
//
// DISCLAIMER: Respect upstream site terms; this is for educational/demo use.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (pathname === "/api/summary") {
        const symbol = (searchParams.get("symbol") || "").toUpperCase();
        if (!symbol) return json({ error: "symbol required" }, 400);
        const data = await getSummary(symbol);
        return json(data);
      }

      if (pathname === "/api/options") {
        const symbol = (searchParams.get("symbol") || "").toUpperCase();
        const date = searchParams.get("date"); // optional UNIX expiry
        if (!symbol) return json({ error: "symbol required" }, 400);
        const data = await getOptionsLite(symbol, date);
        return json(data);
      }

      if (pathname === "/api/ping") {
        return json({ ok: true, now: Date.now() });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  }
};

function corsHeaders(extra={}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
    ...extra
  };
}

function json(data, status=200, headers={}) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: corsHeaders(headers) });
}

async function cfFetch(url) {
  const res = await fetch(url, {
    cf: { cacheTtl: 60, cacheEverything: true }
  });
  if (!res.ok) throw new Error(`Upstream ${res.status} for ${url}`);
  return res.json();
}

async function getSummary(symbol) {
  const u = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price,financialData,summaryDetail,recommendationTrend`;
  const j = await cfFetch(u);
  const r = j?.quoteSummary?.result?.[0] || {};
  const price = r?.price?.regularMarketPrice?.raw ?? r?.price?.regularMarketPrice;
  const targetMeanPrice = r?.financialData?.targetMeanPrice?.raw ?? r?.financialData?.targetMeanPrice;
  const recommendationKey = r?.financialData?.recommendationKey || null;
  return { symbol, price, targetMeanPrice, recommendationKey };
}

function midpoint(opt) {
  // Prefer (bid+ask)/2 if available; else lastPrice
  const bid = opt?.bid?.raw ?? opt?.bid;
  const ask = opt?.ask?.raw ?? opt?.ask;
  const last = opt?.lastPrice?.raw ?? opt?.lastPrice;
  if (isFinite(bid) && isFinite(ask) && ask > 0) return (Number(bid) + Number(ask)) / 2;
  if (isFinite(last)) return Number(last);
  return null;
}

async function getOptionsLite(symbol, date) {
  const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
  const url = date ? `${base}?date=${encodeURIComponent(date)}` : base;
  const j = await cfFetch(url);

  const result = j?.optionChain?.result?.[0];
  if (!result) return { error: "no options data" };

  const q = result?.quote || {};
  const price = q?.regularMarketPrice ?? q?.regularMarketPreviousClose ?? null;
  const expirations = result?.expirationDates || [];
  const opt = result?.options?.[0]; // nearest expiry (if date not specified)
  const exp = opt?.expirationDate || expirations?.[0] || null;

  const calls = (opt?.calls || []).map(o => ({ strike: o?.strike?.raw ?? o?.strike, mid: midpoint(o) })).filter(o => o.mid !== null);
  const puts  = (opt?.puts  || []).map(o => ({ strike: o?.strike?.raw ?? o?.strike, mid: midpoint(o) })).filter(o => o.mid !== null);

  // Find ATM call (first strike >= price), ATM put (first strike <= price)
  let atmCall = null, atmPut = null;
  if (isFinite(price)) {
    const aboveCalls = calls.filter(c => c.strike >= price).sort((a,b)=>a.strike-b.strike);
    const belowPuts  = puts.filter(p => p.strike <= price).sort((a,b)=>b.strike-a.strike);
    atmCall = aboveCalls[0] || calls.sort((a,b)=>Math.abs(a.strike-price)-Math.abs(b.strike-price))[0] || null;
    atmPut  = belowPuts[0]  || puts.sort((a,b)=>Math.abs(a.strike-price)-Math.abs(b.strike-price))[0] || null;
  }

  // Simple 1-step bull call spread using next strike up if available
  let bullCallSpread = null;
  if (atmCall) {
    const nextCall = calls.filter(c => c.strike > atmCall.strike).sort((a,b)=>a.strike-b.strike)[0];
    if (nextCall) {
      const debit = (atmCall.mid ?? 0) - (nextCall.mid ?? 0);
      bullCallSpread = { lower: atmCall.strike, upper: nextCall.strike, debit: Number(debit.toFixed(2)) };
    }
  }

  return {
    expiration: exp ? new Date(exp * 1000).toISOString().slice(0,10) : null,
    price,
    atmCall,
    atmPut,
    bullCallSpread
  };
}
