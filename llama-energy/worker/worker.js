// worker.js — LLaMA-Energy (full, CORS-safe, SSE passthrough)
// Endpoints:
//   GET  /api/status
//   GET  /api/eia?state=VA[&series=a,b,c]
//   POST /api/rag              (proxies to RAG_BASE if set; supports SSE/NDJSON/JSON)
//   GET  /api/ferc/docinfo?accession=20110106-3009
//   GET  /api/etariff/list?company=Dominion
//   GET  /api/etariff/record?link=https://etariff.ferc.gov/...
//
// Required vars/secrets (wrangler.toml):
//   EIA_API_KEY   (secret)
//   RAG_BASE      (var; optional — if absent, /api/rag returns stub)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- CORS preflight ----
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    try {
      // ---- Health ----
      if (url.pathname === "/api/status") {
        return cors(json({ ok: true, ts: new Date().toISOString() }));
      }

      // ---- EIA: State Electricity Profiles (Source-Disposition) ----
      if (url.pathname === "/api/eia" && request.method === "GET") {
        if (!env.EIA_API_KEY) return cors(json({ error: "EIA_API_KEY not configured" }, 500));

        const state = (url.searchParams.get("state") || "VA").toUpperCase().replace(/[^A-Z]/g, "");
        if (!/^[A-Z]{2,3}$/.test(state)) return cors(json({ error: "Invalid state code" }, 400));

        const defaultSeries = [
          "direct-use",
          "facility-direct",
          "independent-power-producers",
          "estimated-losses",
          "total-supply",
          "total-disposition",
        ];
        const series = parseSeries(url.searchParams.get("series"), defaultSeries);

        const base = "https://api.eia.gov/v2/electricity/state-electricity-profiles/source-disposition/data/";
        const params = new URLSearchParams({ frequency: "annual", "facets[state][]": state });
        params.set("sort[0][column]", "period");
        params.set("sort[0][direction]", "asc");
        params.set("api_key", env.EIA_API_KEY);
        series.forEach((s, i) => params.set(`data[${i}]`, s));

        const upstream = `${base}?${params}`;
        const r = await fetch(upstream, { cf: { cacheTtl: 300, cacheEverything: true } });
        if (!r.ok) return cors(text(await r.text(), r.status));
        const body = await r.json();
        const rows = body?.response?.data || [];

        const periods = rows.map(r => r.period);

        // units per series
        const units = {};
        for (const s of series) {
          const uk = `${s}-units`;
          const first = rows.find(x => x[uk] != null);
          if (first) units[s] = String(first[uk]);
        }

        // display labels
        const labelMap = {
          "direct-use": "Direct Use",
          "facility-direct": "Facility Direct",
          "independent-power-producers": "Independent Power Producers",
          "estimated-losses": "Estimated Losses",
        };
        const toNum = x => (x == null || x === "" ? null : Number(x));
        const getV = (row, key) => toNum(row[key]);

        const levels = {};
        for (const [k, label] of Object.entries(labelMap)) {
          if (series.includes(k)) levels[label] = rows.map(r => getV(r, k));
        }

        // %-of-supply (only when per-period total-supply is present & > 0)
        let shares = null;
        if (series.includes("total-supply")) {
          const supply = rows.map(r => getV(r, "total-supply"));
          if (supply.some(v => v != null)) {
            const pct = arr => arr?.map((v, i) => {
              const s = supply[i];
              return (s && s > 0 && v != null) ? (100 * v / s) : null;
            });
            shares = {};
            if (levels["Direct Use"]) shares["Direct Use %"] = pct(levels["Direct Use"]);
            if (levels["Facility Direct"]) shares["Facility Direct %"] = pct(levels["Facility Direct"]);
            if (levels["Independent Power Producers"]) shares["IPPs %"] = pct(levels["Independent Power Producers"]);
            if (levels["Estimated Losses"]) shares["Losses %"] = pct(levels["Estimated Losses"]);
          }
        }

        const meta = {
          state,
          seriesRequested: series,
          units,
          apiVersion: body?.apiVersion || null,
          records: rows.length,
          source: upstream, // exact upstream URL for audit
        };

        return cors(json({ periods, levels, shares, meta }));
      }

      // ---- RAG / Chat (proxy to backend if configured) ----
      if (url.pathname === "/api/rag" && request.method === "POST") {
        const body = await safeJson(request);
        if (!body || !body.question) return cors(json({ error: "missing 'question' in body" }, 400));

        // Proxy to backend when RAG_BASE is present (SSE/NDJSON/JSON passthrough)
        if (env.RAG_BASE) {
          const target = new URL("/chat", env.RAG_BASE).toString();
          const upstream = await fetch(target, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });

          const ct = (upstream.headers.get("content-type") || "").toLowerCase();
          if (ct.includes("text/event-stream") || ct.includes("application/x-ndjson")) {
            return cors(new Response(upstream.body, {
              status: upstream.status,
              headers: {
                "content-type": ct,
                "cache-control": "no-cache",
                "connection": "keep-alive",
              }
            }));
          }
          const bytes = await upstream.arrayBuffer();
          return cors(new Response(bytes, {
            status: upstream.status,
            headers: { "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8" }
          }));
        }

        // Stub (only used if no backend configured)
        const answer = [
          `State: ${body.state || "VA"}`,
          `Persona: ${body?.context?.persona || "hyper-unit"}`,
          `Region: ${body?.context?.region || "PJM-VA"}`,
          "",
          "This is a JSON stub from /api/rag. Replace with your RAG/model handler.",
          "Cite EIA series (e.g., direct-use / IPPs / estimated-losses) and FERC docket/accession (when used)."
        ].join("\n");

        return cors(json({
          answer,
          sources: [
            { source: "EIA", series: "direct-use, independent-power-producers, estimated-losses" },
            { source: "FERC eLibrary", accession: "20110106-3009" }
          ]
        }));
      }

      // ---- FERC eLibrary docinfo passthrough (raw HTML) ----
      if (url.pathname === "/api/ferc/docinfo" && request.method === "GET") {
        const acc = url.searchParams.get("accession");
        if (!acc || !/^\d{8}-\d{4}$/.test(acc)) {
          return cors(json({ error: "Missing or invalid accession (expected like 20110106-3009)" }, 400));
        }
        const target = `https://elibrary.ferc.gov/eLibrary/docinfo?accession_Number=${encodeURIComponent(acc)}`;
        const r = await fetch(target, { cf: { cacheTtl: 900, cacheEverything: true } });
        if (!r.ok) return cors(text(await r.text(), r.status));
        return cors(new Response(await r.text(), { headers: { "content-type": "text/html; charset=utf-8" } }));
      }

      // ---- FERC eTariff helpers (HTML/XML passthroughs) ----
      if (url.pathname === "/api/etariff/list" && request.method === "GET") {
        const company = url.searchParams.get("company") || "";
        const target = `https://etariff.ferc.gov/TariffList.aspx?company=${encodeURIComponent(company)}`;
        const r = await fetch(target, { cf: { cacheTtl: 900, cacheEverything: true } });
        if (!r.ok) return cors(text(await r.text(), r.status));
        const html = await r.text();
        return cors(json({ html, source: target }));
      }

      if (url.pathname === "/api/etariff/record" && request.method === "GET") {
        const link = url.searchParams.get("link");
        if (!link) return cors(json({ error: "missing link" }, 400));
        const r = await fetch(link, { cf: { cacheTtl: 900, cacheEverything: true } });
        if (!r.ok) return cors(text(await r.text(), r.status));
        const body = await r.text();
        return cors(new Response(body, { headers: { "content-type": r.headers.get("content-type") || "text/html" } }));
      }

      // ---- Fallback ----
      return cors(text("Not Found", 404));
    } catch (err) {
      return cors(json({ error: err?.message || "Unexpected error" }, 500));
    }
  }
};

// ---------- helpers ----------
function parseSeries(qsValue, defaults) {
  if (!qsValue) return defaults;
  const arr = qsValue.split(",").map(s => s.trim()).filter(Boolean);
  const seen = new Set(); const out = [];
  for (const s of arr) if (!seen.has(s)) { seen.add(s); out.push(s); }
  return out.length ? out : defaults;
}

async function safeJson(req) {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) return null;
  try { return await req.json(); } catch { return null; }
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "Content-Type, Authorization");
  if (!h.has("cache-control")) h.set("cache-control", "no-store");
  return new Response(res.body, { ...res, headers: h });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function text(t, status = 200) {
  return new Response(typeof t === "string" ? t : String(t), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
