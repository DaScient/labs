// cloudflare/rv_robovet_relay/rv_worker.mjs
// RoboVet AI Relay (safe, CORS-hardened, education-only vet guidance)
//
// Endpoints:
//   GET/OPTIONS  /api/ping     -> healthcheck
//   POST         /api/ai       -> { model?, messages: [{role,content}], system? , stream? }
//                                returns { text } by default; if stream=1 (or true) returns SSE passthrough
//   POST         /api/moderate -> optional moderation pre-check (returns { ok, flagged, results })
//
// Notes:
// - Holds your OPENAI_API_KEY server-side (never exposed to browsers).
// - Enforces a server-side safety system prompt for veterinary guidance.
// - CORS: lock with ALLOWED_ORIGIN (or ALLOW_ALL="1" during testing).
// - Optional moderation: set MODERATION="1" to block risky inputs.
// - Streaming: enable per request with body.stream=true (or query ?stream=1).
//
// © RoboVet

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ----- CORS preflight -----
    if (request.method === "OPTIONS") {
      return corsResponse(null, env);
    }

    // ----- Healthcheck -----
    if (url.pathname === "/api/ping" && (request.method === "GET" || request.method === "HEAD")) {
      return corsResponse(json({
        ok: true,
        time: new Date().toISOString(),
        role: "robovet-ai-relay"
      }), env);
    }

    // ----- Moderation (optional) -----
    if (url.pathname === "/api/moderate" && request.method === "POST") {
      if (!env.OPENAI_API_KEY) return corsResponse(json({ error: "Missing OPENAI_API_KEY" }, 500), env);
      const body = await getJSON(request).catch(() => ({}));
      const input = String(body?.input ?? "");
      const model = "omni-moderation-latest";

      try {
        const r = await fetch("https://api.openai.com/v1/moderations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({ model, input })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return corsResponse(json({ error: "moderation_error", status: r.status, detail: data }, r.status), env);
        const flagged = !!data?.results?.some((res) => res.flagged);
        return corsResponse(json({ ok: true, flagged, results: data?.results ?? [] }), env);
      } catch (err) {
        return corsResponse(json({ error: "moderation_exception", detail: String(err?.message || err) }, 500), env);
      }
    }

    // ----- Chat Relay -----
    if (url.pathname === "/api/ai" && request.method === "POST") {
      try {
        if (!env.OPENAI_API_KEY) return corsResponse(json({ error: "Missing OPENAI_API_KEY" }, 500), env);

        const body = await getJSON(request).catch(() => ({}));
        const model = String(body?.model || env.MODEL_DEFAULT || "gpt-4o-mini").trim();
        const userMessages = Array.isArray(body?.messages) ? body.messages : [];
        const userSystem = typeof body?.system === "string" ? body.system : "";
        const wantStream = truthy(body?.stream) || truthy(new URL(request.url).searchParams.get("stream"));

        if (!model) return corsResponse(json({ error: "Missing model" }, 400), env);
        if (userMessages.length === 0) return corsResponse(json({ error: "messages[] required" }, 400), env);

        // Server-side safety rails (non-overridable)
        const SAFETY_SYSTEM = `
You are RoboVet, a cautious veterinary information assistant.
You DO NOT diagnose or prescribe. You MUST NOT provide drug dosages or brand prescriptions.
Your role is strictly educational and conservative.

If immediate danger (not breathing, seizures, collapse, severe bleeding, suspected poisoning, heat stroke, vehicle trauma),
advise emergency veterinary care NOW and provide reputable resources (e.g., VECCS directory; ASPCA APCC; Pet Poison Helpline).

Return clear sections:
1) Red flags
2) Categories of possible causes (not diagnoses)
3) Conservative home monitoring & comfort steps (no medications)
4) What information to tell a licensed veterinarian
5) When to seek urgent care

Keep language calm, concise, and practical.
        `.trim();

        // Compose message array (server system first)
        const messages = [
          { role: "system", content: SAFETY_SYSTEM },
          ...(userSystem ? [{ role: "system", content: String(userSystem) }] : []),
          ...userMessages.map((m) => ({
            role: normalizeRole(m.role),
            content: String(m.content ?? "")
          }))
        ];

        // Optional moderation pre-check (coarse gate)
        if (env.MODERATION === "1") {
          const mod = await fetch("https://api.openai.com/v1/moderations", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
              model: "omni-moderation-latest",
              input: messages.map((m) => m.content).join("\n\n")
            })
          });
          const mj = await mod.json().catch(() => ({}));
          if (!mod.ok) return corsResponse(json({ error: "moderation_error", status: mod.status, detail: mj }, mod.status), env);
          const flagged = !!mj?.results?.some((r) => r.flagged);
          if (flagged) return corsResponse(json({ error: "content_flagged", message: "Please rephrase in neutral, non-harmful terms." }, 400), env);
        }

        // Streaming path (SSE passthrough)
        if (wantStream) {
          const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
              model,
              messages,
              temperature: clamp(Number(env.TEMP ?? 0.2), 0, 1),
              max_tokens: Number(env.MAX_TOKENS ?? 1400),
              top_p: 1,
              stream: true
            })
          });
          if (!upstream.ok) {
            const text = await upstream.text().catch(() => "");
            return corsSSE(upstream.status, text, env);
          }
          return corsSSE(200, upstream.body, env);
        }

        // Non-streaming path (simple JSON -> { text })
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: clamp(Number(env.TEMP ?? 0.2), 0, 1),
            max_tokens: Number(env.MAX_TOKENS ?? 1400),
            top_p: 1,
            stream: false
          })
        });

        if (!r.ok) {
          const text = await r.text().catch(() => "");
          return corsResponse(json({ error: "upstream_error", status: r.status, detail: text.slice(0, 800) }, r.status), env);
        }

        const data = await r.json().catch(() => ({}));
        const text =
          data?.choices?.[0]?.message?.content ??
          data?.message?.content ??
          data?.content ?? "";

        return corsResponse(json({ text }), env);
      } catch (err) {
        return corsResponse(json({ error: "relay_exception", detail: String(err?.message || err) }, 500), env);
      }
    }

    // ----- Not found -----
    return corsResponse(json({ error: "Not found" }, 404), env);
  }
};

// ---------- helpers ----------
function normalizeRole(role) {
  const r = String(role || "").toLowerCase();
  if (r === "system" || r === "assistant") return r;
  return "user";
}
async function getJSON(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await request.json();
  const text = await request.text();
  try { return JSON.parse(text); } catch { return {}; }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
function clamp(n, lo, hi) {
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : lo;
}
function truthy(v) {
  if (v === true) return true;
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  return false;
}

// CORS for JSON routes
function corsResponse(res, env) {
  const allowAll = env.ALLOW_ALL === "1";
  const origin = env.ALLOWED_ORIGIN || "*";
  const h = new Headers(res ? res.headers : undefined);
  h.set("Access-Control-Allow-Origin", allowAll ? "*" : origin);
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  h.set("Access-Control-Max-Age", "86400");
  if (!res) return new Response(null, { status: 204, headers: h });
  return new Response(res.body, { status: res.status, headers: h });
}

// CORS + SSE headers for streaming
function corsSSE(status, bodyOrText, env) {
  const allowAll = env.ALLOW_ALL === "1";
  const origin = env.ALLOWED_ORIGIN || "*";
  const h = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });
  h.set("Access-Control-Allow-Origin", allowAll ? "*" : origin);
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  h.set("Access-Control-Max-Age", "86400");

  // bodyOrText can be a ReadableStream (from upstream) or a string with error details
  if (typeof bodyOrText === "string") {
    return new Response(bodyOrText, { status, headers: h });
  }
  return new Response(bodyOrText, { status, headers: h });
}
