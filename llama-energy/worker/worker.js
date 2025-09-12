// worker.js — LLaMA-Energy Edge API + Static Assets (Option B)
// Requires wrangler.toml:
// [assets] directory = "./public" ; binding = "ASSETS"

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // If this isn't an /api/* path, serve static files from ASSETS.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // ---- CORS preflight for API routes ----
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    try {
      /* ========== HEALTH ========== */
      if (url.pathname === "/api/status") {
        return cors(json({ ok: true, ts: new Date().toISOString() }));
      }

      /* ========== FRIENDLY HINT FOR GET /api/rag ========== */
      if (url.pathname === "/api/rag" && request.method === "GET") {
        return cors(json({
          ok: true,
          hint: "POST JSON to this endpoint: { question, state, context?, system?, temperature?, stream? }"
        }));
      }

      /* ========== EIA: STATE ELECTRICITY PROFILES (SOURCE/DISPOSITION) ========== */
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

        // capture units per series
        const units = {};
        for (const s of series) {
          const uk = `${s}-units`;
          const first = rows.find(x => x[uk] != null);
          if (first) units[s] = String(first[uk]);
        }

        const labelMap = {
          "direct-use": "Direct Use",
          "facility-direct": "Facility Direct",
          "independent-power-producers": "Independent Power Producers",
          "estimated-losses": "Estimated Losses",
        };
        const toNum = x => (x == null || x === "" ? null : Number(x));
        const getV = (row, key) => toNum(row[key]);

        const levels = {};
        for (const [key, label] of Object.entries(labelMap)) {
          if (series.includes(key)) levels[label] = rows.map(r => getV(r, key));
        }

        // compute % of total-supply when present
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
          source: upstream
        };

        return cors(json({ periods, levels, shares, meta }));
      }

      // ========== RAG / CHAT (EIA-backed summary) ==========
      if (url.pathname === "/api/rag" && request.method === "POST") {
        const body = await safeJson(request);
        if (!body || !body.question) return cors(json({ error: "missing 'question' in body" }, 400));

        // If a custom backend exists, proxy to it; otherwise do EIA summary.
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
              headers: { "content-type": ct, "cache-control": "no-cache", "connection": "keep-alive" }
            }));
          }
          const bytes = await upstream.arrayBuffer();
          return cors(new Response(bytes, {
            status: upstream.status,
            headers: { "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8" }
          }));
        }

        // Deterministic EIA-only fallback
        const state = (body.state || "VA").toUpperCase();
        const series = [
          "direct-use","independent-power-producers","estimated-losses",
          "total-supply","total-disposition"
        ].join(",");

        const eiaUrl = `${url.origin}/api/eia?state=${encodeURIComponent(state)}&series=${series}`;
        const eiaRes = await fetch(eiaUrl, { cf: { cacheTtl: 120, cacheEverything: true } });

        if (!eiaRes.ok) {
          const ct = (eiaRes.headers.get("content-type")||"").toLowerCase();
          const preview = ct.includes("application/json") ? JSON.stringify(await eiaRes.json()).slice(0,400)
                                                          : (await eiaRes.text()).slice(0,400);
          return cors(json({
            answer: `Could not retrieve EIA data for ${state}. Upstream HTTP ${eiaRes.status}.`,
            detail: preview,
            sources: [{ source: "EIA proxy", url: eiaUrl }]
          }, 200));
        }

        const eia = await eiaRes.json();
        const P = eia.periods || [];
        const L = eia.levels || {};
        const S = eia.shares || {};
        const n = Math.min(P.length, 5);
        const lastYears = P.slice(-n);
        const last = lastYears.at(-1);

        const di = (L["Direct Use"]||[]).slice(-n);
        const ip = (L["Independent Power Producers"]||[]).slice(-n);
        const lo = (L["Estimated Losses"]||[]).slice(-n);
        const dps = (S["Direct Use %"]||[]).slice(-n);
        const ips = (S["IPPs %"]||[]).slice(-n);
        const lps = (S["Losses %"]||[]).slice(-n);

        const fmt = v => (v==null ? "—" : Number(v).toLocaleString());
        const delta = arr => (arr?.length>=2 && arr.at(-1)!=null && arr.at(-2)!=null)
          ? (arr.at(-1) - arr.at(-2)) : null;
        const median = a => { const x=a.filter(v=>v!=null&&isFinite(v)).sort((a,b)=>a-b); if(!x.length) return null; const m=Math.floor(x.length/2); return x.length%2?x[m]:(x[m-1]+x[m])/2; };

        const dDi = delta(di), dIp = delta(ip), dLo = delta(lo);
        const lines = [];
        lines.push(`State: ${state} • Persona: ${body?.context?.persona || "hyper-unit"} • Region: ${body?.context?.region || ""}`.trim());
        lines.push(`Latest ${last}: Direct Use ${fmt(di.at(-1))} MWh (${dps.at(-1)?.toFixed?.(2) ?? "–"}%), IPPs ${fmt(ip.at(-1))} MWh (${ips.at(-1)?.toFixed?.(2) ?? "–"}%), Losses ${fmt(lo.at(-1))} MWh (${lps.at(-1)?.toFixed?.(2) ?? "–"}%).`);
        lines.push(`YoY: Direct Use ${dDi==null?"–":(dDi>=0?"+":"") + dDi.toLocaleString()} MWh; IPPs ${dIp==null?"–":(dIp>=0?"+":"") + dIp.toLocaleString()} MWh; Losses ${dLo==null?"–":(dLo>=0?"+":"") + dLo.toLocaleString()} MWh.`);
        lines.push(`Window ${lastYears[0]}–${lastYears.at(-1)} median shares: Direct Use ${(median(dps)||0).toFixed(2)}%, IPPs ${(median(ips)||0).toFixed(2)}%, Losses ${(median(lps)||0).toFixed(2)}%.`);
        lines.push(`Implications: scale interconnection & offtake with IPP growth; watch losses vs local constraints; size behind-the-meter direct-use by share, not gross supply.`);

        return cors(json({
          answer: lines.join("\n"),
          sources: [{ source: "EIA (State Profiles – Source/Disposition)", url: eia?.meta?.source }]
        }, 200));
      }

      /* ========== HF INFERENCE PROXY (TOKEN ROTATION + FAILOVER) ========== */
      if (url.pathname === "/api/hf" && request.method === "POST") {
        const body = await safeJson(request);
        if (!body) return cors(json({ error: "Invalid JSON body" }, 400));

        const model = (body.model || "mistralai/Mistral-7B-Instruct-v0.2").trim();

        const MAX_INPUT_CHARS = 20000;
        try {
          const s = JSON.stringify(body.inputs ?? body);
          if (s.length > MAX_INPUT_CHARS) {
            return cors(json({ error: "Payload too large" }, 413));
          }
        } catch {}

        const payload = {
          inputs: body.inputs ?? body.question ?? "",
          parameters: body.parameters ?? { temperature: body.temperature ?? 0.2, max_new_tokens: 512 },
        };

        const resp = await callHfWithFailover({ env, model, payload });
        return cors(resp);
      }

      // Non-sensitive token visibility check
      if (url.pathname === "/api/hf/status" && request.method === "GET") {
        const list = tokensFromEnv(env);
        return cors(json({ token_count: list.length }));
      }

      /* ========== FERC ELIBRARY PASSTHROUGH ========== */
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

      /* ========== FERC ETARIFF HELPERS ========== */
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

      /* ========== FALLBACK (API) ========== */
      return cors(text("Not Found", 404));
    } catch (err) {
      return cors(json({ error: err?.message || "Unexpected error" }, 500));
    }
  }
};

/* ================= Helpers ================= */

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

function median(arr){
  const a = (arr||[]).filter(v=>v!=null && isFinite(v)).sort((x,y)=>x-y);
  if (!a.length) return null;
  const m = Math.floor(a.length/2);
  return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
}

/* ===== Hugging Face token rotation + failover ===== */

function tokensFromEnv(env) {
  const list = [];
  try {
    if (env.HF_TOKENS_JSON) {
      const arr = JSON.parse(env.HF_TOKENS_JSON);
      if (Array.isArray(arr)) list.push(...arr.filter(Boolean));
    }
  } catch {}
  if (env.HF_TOKEN_A) list.push(env.HF_TOKEN_A);
  if (env.HF_TOKEN_B) list.push(env.HF_TOKEN_B);
  return [...new Set(list)];
}

let _hfIdx = 0;
function nextToken(tokens) {
  if (!tokens.length) return null;
  const t = tokens[_hfIdx % tokens.length];
  _hfIdx = (_hfIdx + 1) % tokens.length;
  return t;
}

function backoff(attempt) {
  const base = Math.min(1000 * Math.pow(2, attempt), 8000);
  const jitter = Math.floor(Math.random() * 200);
  return base + jitter;
}

/**
 * Call HF Inference with rotation + failover.
 * Retries on 429/5xx/network; fails fast on 401/403.
 */
async function callHfWithFailover({ env, model, payload, maxAttempts = 4, signal }) {
  const tokens = tokensFromEnv(env);
  if (!tokens.length) {
    return new Response(JSON.stringify({ error: "HF tokens not configured" }), {
      status: 500, headers: { "content-type": "application/json" }
    });
  }
  const url = `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`;

  let lastErrTxt = "unknown";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = nextToken(tokens);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal
      });

      // Auth/gated → return immediately with detail
      if (r.status === 401 || r.status === 403) {
        const t = await r.text();
        return new Response(JSON.stringify({
          error: "HF auth/gated model",
          detail: t.slice(0, 800),
          status: r.status
        }), { status: r.status, headers: { "content-type": "application/json" }});
      }

      // Retry on 429/5xx
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        lastErrTxt = await r.text();
        await new Promise(res => setTimeout(res, backoff(attempt)));
        continue;
      }

      // Success passthrough
      return new Response(r.body, {
        status: r.status,
        headers: { "content-type": r.headers.get("content-type") || "application/json" }
      });

    } catch (e) {
      lastErrTxt = e?.message || "network error";
      await new Promise(res => setTimeout(res, backoff(attempt)));
      continue;
    }
  }

  return new Response(JSON.stringify({
    error: "HF call failed after retries",
    detail: lastErrTxt
  }), { status: 502, headers: { "content-type": "application/json" }});
}
