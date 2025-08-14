// cloudflare/worker.js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization"
    };

    if (url.pathname === "/api/ping") {
      return new Response(JSON.stringify({ ok: true, msg: "pong", now: Date.now() }), { headers });
    }

    if (url.pathname === "/api/mock") {
      const symbol = url.searchParams.get("symbol") || "AAPL";
      return new Response(JSON.stringify({
        symbol,
        price: 123.45,
        targetMeanPrice: 140,
        recommendationKey: "buy",
        options: {
          expiration: "2025-09-19",
          atmCall: { strike: 125, mid: 4.2 },
          atmPut: { strike: 120, mid: 3.8 },
          bullCallSpread: { lower: 125, upper: 130, debit: 1.95 },
          bearPutSpread: { lower: 120, upper: 115, debit: 2.1 },
          bullPutCredit: { short: 120, long: 115, credit: 1.75 },
          bearCallCredit: { short: 125, long: 130, credit: 1.8 },
          ironCondor: {
            lowerPut: 115, shortPut: 120, shortCall: 125, upperCall: 130,
            credit: 2.5, width: 5, maxLoss: 2.5
          }
        }
      }), { headers });
    }

    if (url.pathname.startsWith("/api/summary")) {
      const symbol = url.searchParams.get("symbol") || "AAPL";
      return new Response(JSON.stringify({
        symbol, price: 123.45, targetMeanPrice: 140, recommendationKey: "buy"
      }), { headers });
    }

    if (url.pathname.startsWith("/api/options")) {
      const symbol = url.searchParams.get("symbol") || "AAPL";
      return new Response(JSON.stringify({
        symbol,
        options: {
          expiration: "2025-09-19",
          atmCall: { strike: 125, mid: 4.2 },
          atmPut: { strike: 120, mid: 3.8 },
          bullCallSpread: { lower: 125, upper: 130, debit: 1.95 },
          bearPutSpread: { lower: 120, upper: 115, debit: 2.1 },
          bullPutCredit: { short: 120, long: 115, credit: 1.75 },
          bearCallCredit: { short: 125, long: 130, credit: 1.8 },
          ironCondor: {
            lowerPut: 115, shortPut: 120, shortCall: 125, upperCall: 130,
            credit: 2.5, width: 5, maxLoss: 2.5
          }
        }
      }), { headers });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers });
  }
}
