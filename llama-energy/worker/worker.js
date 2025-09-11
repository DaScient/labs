// worker.js — Cloudflare Worker for LLaMA-Energy
// Endpoints:
//   GET /api/eia?state=VA[,&series=direct-use,facility-direct,...]
//   GET /api/ferc/docinfo?accession=20110106-3009   (raw HTML passthrough)
// Utilities: CORS, basic input validation, edge caching
//
// Secrets (set via wrangler):
//   wrangler secret put EIA_API_KEY
//
// Notes:
// - Configure a route so your site can call this as /api/*
// - Default EIA series cover hyper-unit analysis; you can override via ?series=

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // CORS preflight
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    try {
      // -------- EIA STATE ELECTRICITY PROFILES --------
      if (url.pathname === "/api/eia") {
        if (!env.EIA_API_KEY) return cors(json({ error: "EIA_API_KEY not configured" }, 500));

        // State param (default VA), accept 2–3 char codes (e.g., "VA", "DC")
        const state = (url.searchParams.get("state") || "VA").toUpperCase().replace(/[^A-Z]/g, "");
        if (!/^[A-Z]{2,3}$/.test(state)) return cors(json({ error: "Invalid state code" }, 400));

        // Default series; allow override via ?series=comma,separated,ids
        const defaultSeries = [
          "direct-use",
          "facility-direct",
          "independent-power-producers",
          "estimated-losses",
          "total-supply",
          "total-disposition",
        ];
        const userSeries = (url.searchParams.get("series") || "")
          .split(",")
          .map(s => s.trim())
          .filter(Boolean);
        const series = userSeries.length ? Array.from(new Set([...userSeries])) : defaultSeries;

        // Build query
        const base = "https://api.eia.gov/v2/electricity/state-electricity-profiles/source-disposition/data/";
        const params = new URLSearchParams({ frequency: "annual", "facets[state][]": state });
        // sort oldest→newest for nicer charts
        params.set("sort[0][column]", "period");
        params.set("sort[0][direction]", "asc");
        params.set("api_key", env.EIA_API_KEY);
        series.forEach((s, i) => params.set(`data[${i}]`, s));

        // Fetch with edge cache
        const resp = await fetch(`${base}?${params}`, { cf: { cacheTtl: 300, cacheEverything: true } });
        if (!resp.ok) return cors(text(await resp.text(), resp.status));
        const body = await resp.json();
        const rows = body?.response?.data || [];

        // Helpers
        const toNum = x => (x == null || x === "" ? null : Number(x));
        const get = (r, key) => toNum(r[key]);

        // Periods
        const periods = rows.map(r => r.period);

        // Levels (only for known display series)
        const labelMap = {
          "direct-use": "Direct Use",
          "facility-direct": "Facility Direct",
          "independent-power-producers": "Independent Power Producers",
          "estimated-losses": "Estimated Losses",
        };
        const levels = {};
        Object.entries(labelMap).forEach(([key, label]) => {
          if (series.includes(key)) levels[label] = rows.map(r => get(r, key));
        });

        // Shares (% of total supply)
        const supply = series.includes("total-supply") ? rows.map(r => get(r, "total-supply") || 0) : [];
        const pct = arr => (supply.length ? arr.map((v, i) => (supply[i] ? (100 * (v ?? 0)) / supply[i] : 0)) : null);
        const shares = {};
        if (supply.length) {
          if (levels["Direct Use"]) shares["Direct Use %"] = pct(levels["Direct Use"]);
          if (levels["Facility Direct"]) shares["Facility Direct %"] = pct(levels["Facility Direct"]);
          if (levels["Independent Power Producers"]) shares["IPPs %"] = pct(levels["Independent Power Producers"]);
          if (levels["Estimated Losses"]) shares["Losses %"] = pct(levels["Estimated Losses"]);
        }

        // Minimal meta for debugging
        const meta = {
          state,
          seriesReturned: series,
          records: rows.length,
          apiVersion: body?.apiVersion || null,
        };

        return cors(json({ periods, levels, shares, meta }));
      }

      // -------- FERC eLibrary (docinfo passthrough) --------
      // Example: /api/ferc/docinfo?accession=20110106-3009
      if (url.pathname === "/api/ferc/docinfo") {
        const acc = url.searchParams.get("accession");
        if (!acc || !/^\d{8}-\d{4}$/.test(acc)) {
          return cors(json({ error: "Missing or invalid accession (expected like 20110106-3009)" }, 400));
        }
        const target = `https://elibrary.ferc.gov/eLibrary/docinfo?accession_Number=${encodeURIComponent(acc)}`;
        const r = await fetch(target, { cf: { cacheTtl: 900, cacheEverything: true } });
        if (!r.ok) return cors(text(await r.text(), r.status));
        // Return raw HTML so backend can parse; keep CORS open for your tooling
        return cors(new Response(await r.text(), { headers: { "content-type": "text/html; charset=utf-8" } }));
      }

      // Health
      if (url.pathname === "/api/status") {
        return cors(json({ ok: true, ts: new Date().toISOString() }));
      }

      // Fallback
      return cors(text("OK", 200));
    } catch (err) {
      return cors(json({ error: err?.message || "Unexpected error" }, 500));
    }
  },
};

// ---------- helpers ----------
function cors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,OPTIONS");
  h.set("access-control-allow-headers", "Content-Type, Authorization");
  return new Response(res.body, { ...res, headers: h });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function text(t, status = 200) {
  return new Response(typeof t === "string" ? t : String(t), { status, headers: { "content-type": "text/plain" } });
}
