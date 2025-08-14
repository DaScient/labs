// Production Worker: /api/ping, /api/mock, /api/summary, /api/options
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Preflight
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    try {
      switch (url.pathname) {
        case "/api/ping":
          return json({ ok: true, now: Date.now() });

        case "/api/mock": {
          const symbol = (url.searchParams.get("symbol") || "AAPL").toUpperCase();
          return json({
            symbol,
            price: 123.45,
            targetMeanPrice: 140.0,
            recommendationKey: "buy",
            options: {
              expiration: "2025-09-19",
              atmCall: { strike: 125, mid: 4.2 },
              atmPut: { strike: 120, mid: 3.8 },
              bullCallSpread: { lower: 125, upper: 130, debit: 1.95 }
            }
          });
        }

        case "/api/summary": {
          const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
          if (!symbol) return json({ error: "symbol required" }, 400);
          const u = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price,financialData,recommendationTrend`;
          const j = await cfGet(u);
          const r = j?.quoteSummary?.result?.[0] || {};
          const price = r?.price?.regularMarketPrice?.raw ?? r?.price?.regularMarketPrice ?? null;
          const targetMeanPrice = r?.financialData?.targetMeanPrice?.raw ?? r?.financialData?.targetMeanPrice ?? null;
          const recommendationKey = r?.financialData?.recommendationKey ?? null;
          return json({ symbol, price, targetMeanPrice, recommendationKey });
        }

        case "/api/options": {
          const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
          const date = url.searchParams.get("date"); // optional unix expiry
          if (!symbol) return json({ error: "symbol required" }, 400);

          const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
          const j = await cfGet(date ? `${base}?date=${encodeURIComponent(date)}` : base);
          const res = j?.optionChain?.result?.[0];
          if (!res) return json({ error: "no options data" }, 404);

          const price = res?.quote?.regularMarketPrice ?? res?.quote?.regularMarketPreviousClose ?? null;
          const opt = res?.options?.[0];
          const exp = opt?.expirationDate || res?.expirationDates?.[0] || null;

          const mid = (o) => {
            const bid = o?.bid?.raw ?? o?.bid, ask = o?.ask?.raw ?? o?.ask, last = o?.lastPrice?.raw ?? o?.lastPrice;
            if (isFinite(bid) && isFinite(ask) && ask > 0) return (Number(bid) + Number(ask)) / 2;
            if (isFinite(last)) return Number(last);
            return null;
          };

          const calls = (opt?.calls || []).map(o => ({ strike: o?.strike?.raw ?? o?.strike, mid: mid(o) })).filter(x => x.mid !== null);
          const puts  = (opt?.puts  || []).map(o => ({ strike: o?.strike?.raw ?? o?.strike, mid: mid(o) })).filter(x => x.mid !== null);

          let atmCall = null, atmPut = null;
          if (isFinite(price)) {
            atmCall = (calls.filter(c => c.strike >= price).sort((a,b)=>a.strike-b.strike)[0]) ||
                      (calls.sort((a,b)=>Math.abs(a.strike-price)-Math.abs(b.strike-price))[0]) || null;
            atmPut  = (puts.filter(p => p.strike <= price).sort((a,b)=>b.strike-a.strike)[0]) ||
                      (puts.sort((a,b)=>Math.abs(a.strike-price)-Math.abs(b.strike-price))[0]) || null;
          }

          let bullCallSpread = null;
          if (atmCall) {
            const next = calls.filter(c => c.strike > atmCall.strike).sort((a,b)=>a.strike-b.strike)[0];
            if (next) bullCallSpread = { lower: atmCall.strike, upper: next.strike, debit: Number(((atmCall.mid ?? 0) - (next.mid ?? 0)).toFixed(2)) };
          }

          return json({
            expiration: exp ? new Date(exp * 1000).toISOString().slice(0, 10) : null,
            price, atmCall, atmPut, bullCallSpread
          });
        }

        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  }
};

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
    ...extra
  };
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: cors(headers) });
}
async function cfGet(u) {
  const r = await fetch(u, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) throw new Error(`Upstream ${r.status} for ${u}`);
  return r.json();
}
