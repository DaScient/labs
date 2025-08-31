/**
 * RoboVet Cloudflare Worker (rv_worker.mjs)
 * Endpoints:
 *   GET  /api/ping
 *   POST /api/ai            - OpenAI relay (JSON or SSE via ?stream=1)
 *   POST /hook/sms          - Twilio inbound SMS -> TwiML reply
 *   POST /hook/email        - Inbound email (SendGrid/Mailgun/Postmark) -> optional email reply
 *   POST /api/sms/send      - Admin-only outbound SMS via Twilio REST
 *
 * Required Secrets:
 *   - OPENAI_API_KEY
 *   - ADMIN_KEY                  (to authorize /api/sms/send)
 *
 * Twilio (choose API Key pair OR Auth Token):
 *   - TWILIO_ACCOUNT_SID         (ACxxxxxxxx)
 *   - Prefer: TWILIO_API_SID + TWILIO_API_SECRET
 *   - Or:    TWILIO_AUTH_TOKEN
 *   - TWILIO_FROM="+18777660460"
 *
 * Optional Email (choose ONE provider):
 *   - SENDGRID_API_KEY + SENDGRID_FROM
 *   - MAILGUN_API_KEY  + MAILGUN_DOMAIN + MAILGUN_FROM
 *   - POSTMARK_TOKEN   + POSTMARK_FROM
 *
 * Optional Vars:
 *   - MODEL_DEFAULT=gpt-4o-mini
 *   - TEMP=0.2
 *   - MAX_TOKENS=1400
 *   - ALLOWED_ORIGIN=https://dascient.com
 *   - ALLOW_ALL=0
 *   - SMS_MAX_LEN=1200
 *   - EMAIL_MAX_LEN=3000
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- CORS preflight ---
    if (request.method === "OPTIONS") return corsPreflight(env);

    // --- Health check ---
    if (url.pathname === "/api/ping" && request.method === "GET") {
      return corsResponse(json({ ok: true, time: new Date().toISOString(), role: "robovet-ai-relay" }), env);
    }

    // --- AI relay (JSON / SSE) ---
    if (url.pathname === "/api/ai" && request.method === "POST") {
      const isStream = url.searchParams.get("stream") === "1" || url.searchParams.get("sse") === "1";
      try {
        const body = await request.json();
        const model = String(body.model || env.MODEL_DEFAULT || "gpt-4o-mini");
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const temperature = clamp(Number(env.TEMP ?? 0.2), 0, 1);
        const max_tokens = Number(env.MAX_TOKENS ?? 1400);

        if (!env.OPENAI_API_KEY) return corsResponse(json({ error: "missing_OPENAI_API_KEY" }, 500), env);
        if (!messages.length)   return corsResponse(json({ error: "messages_required" }, 400), env);

        if (isStream || body.stream === true) {
          const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
            body: JSON.stringify({ model, messages, temperature, max_tokens, stream: true })
          });
          if (!upstream.ok || !upstream.body) {
            const detail = await safeText(upstream);
            return corsResponse(json({ error: "upstream_error", status: upstream.status, detail }), env, 502);
          }
          const stream = new ReadableStream({
            async start(controller) {
              const enc = new TextEncoder(); const reader = upstream.body.getReader();
              const send = (line) => controller.enqueue(enc.encode(`data: ${line}\n\n`));
              try {
                while (true) { const { done, value } = await reader.read(); if (done) break;
                  const chunk = new TextDecoder().decode(value);
                  for (const raw of chunk.split("\n")) {
                    const line = raw.trim(); if (!line) continue;
                    if (line.startsWith("data:")) send(line.slice(6).trim());
                  }
                }
              } catch (e) { send(JSON.stringify({ error: String(e?.message || e) })); }
              finally { send("[DONE]"); controller.close(); }
            }
          });
          return corsSSE(stream, env);
        }

        const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model, messages, temperature, max_tokens })
        });
        const data = await upstream.json().catch(() => ({}));
        if (!upstream.ok) return corsResponse(json({ error: "upstream_error", status: upstream.status, detail: data }, 502), env);
        const text = data?.choices?.[0]?.message?.content || "";
        return corsResponse(json({ text }), env);
      } catch (e) {
        return corsResponse(json({ error: "bad_request", detail: String(e?.message || e) }, 400), env);
      }
    }

    // --- Twilio SMS/MMS webhook (TwiML reply) ---
    if (url.pathname === "/hook/sms" && request.method === "POST") {
      try {
        const verified = await verifyTwilioSignature(request, env); // skips if no token set
        if (verified === false) {
          return new Response("<Response><Message>Signature check failed</Message></Response>", {
            status: 403, headers: { "Content-Type": "application/xml" }
          });
        }

        const contentType = request.headers.get("content-type") || "";
        let fields = {};
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const form = await request.formData(); for (const [k, v] of form.entries()) fields[k] = String(v);
        } else if (contentType.includes("application/json")) {
          fields = await request.json();
        } else {
          return new Response("<Response><Message>Unsupported content-type</Message></Response>", {
            status: 415, headers: { "Content-Type": "application/xml" }
          });
        }

        const from = fields.From || fields.from || "";
        const body = (fields.Body || fields.body || "").trim();
        if (!body) {
          return new Response("<Response><Message>Please text species, age (weeks/months for babies), weight, symptoms, and duration.</Message></Response>", {
            headers: { "Content-Type": "application/xml" }
          });
        }

        const prompt = [
          "Educational guidance only (no diagnoses/prescriptions/drug dosages).",
          "Return sections: Red flags; Categories of possible causes (not diagnoses);",
          "Safe monitoring & comfort steps (no meds); What to tell a vet; When to seek urgent care.",
          "", `User SMS: ${body}`
        ].join("\n");

        const aiText = await chatOnce(env, [
          { role: "system", content: SAFETY_SYSTEM() },
          { role: "user", content: prompt }
        ]);

        const maxLen = Number(env.SMS_MAX_LEN || 1200);
        const reply = sanitizeForSMS(aiText).slice(0, maxLen)
          || "Thanks — please include species, age, weight, symptoms, and duration.";

        const twiml = `<Response><Message>${xmlEscape(reply)}</Message></Response>`;
        return new Response(twiml, { headers: { "Content-Type": "application/xml" } });
      } catch (e) {
        const twiml = `<Response><Message>RoboVet SMS error: ${xmlEscape(String(e?.message || e))}</Message></Response>`;
        return new Response(twiml, { status: 500, headers: { "Content-Type": "application/xml" } });
      }
    }

    // --- Inbound Email webhook (SendGrid/Mailgun/Postmark) ---
    if (url.pathname === "/hook/email" && request.method === "POST") {
      try {
        const ct = request.headers.get("content-type") || "";
        let from = "", to = "", subject = "", text = "", html = "";
        if (ct.includes("multipart/form-data")) {
          const form = await request.formData();
          from = String(form.get("from") || form.get("sender") || "");
          to = String(form.get("to") || "");
          subject = String(form.get("subject") || "");
          text = String(form.get("text") || form.get("TextBody") || "");
          html = String(form.get("html") || form.get("HtmlBody") || "");
        } else if (ct.includes("application/json")) {
          const j = await request.json();
          from = j.from || j.mail_from || j.Sender || "";
          to = j.to || j.rcpt_to || j.To || "";
          subject = j.subject || j.Subject || "";
          text = j.text || j.TextBody || "";
          html = j.html || j.HtmlBody || "";
        } else if (ct.includes("application/x-www-form-urlencoded")) {
          const form = await request.formData();
          from = String(form.get("from") || ""); to = String(form.get("to") || "");
          subject = String(form.get("subject") || ""); text = String(form.get("text") || "");
          html = String(form.get("html") || "");
        } else {
          return corsResponse(json({ error: "unsupported_content_type" }, 415), env);
        }

        const bodyText = (text || stripHtml(html || "")).trim();
        if (!bodyText) return corsResponse(json({ ok: true, note: "Empty message body" }), env);

        const userBlock = [ subject ? `Subject: ${subject}` : "", bodyText ? `Message: ${bodyText}` : "" ]
          .filter(Boolean).join("\n");

        const aiText = await chatOnce(env, [
          { role: "system", content: SAFETY_SYSTEM() },
          { role: "user", content:
            "Educational guidance only (no diagnoses/prescriptions/drug dosages). " +
            "Return sections: Red flags; Categories of possible causes (not diagnoses); " +
            "Safe monitoring & comfort steps (no meds); What to tell a vet; When to seek urgent care.\n\n" +
            userBlock
          }
        ]);

        const maxLen = Number(env.EMAIL_MAX_LEN || 3000);
        const replyText = aiText.slice(0, maxLen);

        let sent = false;
        if (env.SENDGRID_API_KEY && env.SENDGRID_FROM) {
          await sendWithSendGrid(env, env.SENDGRID_FROM, parseEmail(from), subject || "RoboVet reply", replyText); sent = true;
        } else if (env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN && env.MAILGUN_FROM) {
          await sendWithMailgun(env, env.MAILGUN_FROM, parseEmail(from), subject || "RoboVet reply", replyText); sent = true;
        } else if (env.POSTMARK_TOKEN && env.POSTMARK_FROM) {
          await sendWithPostmark(env, env.POSTMARK_FROM, parseEmail(from), subject || "RoboVet reply", replyText); sent = true;
        }

        return corsResponse(json({ ok: true, sent, to: parseEmail(from) }), env);
      } catch (e) {
        return corsResponse(json({ error: "email_hook_error", detail: String(e?.message || e) }, 500), env);
      }
    }

    // --- Admin outbound SMS (Twilio REST) ---
    if (url.pathname === "/api/sms/send" && request.method === "POST") {
      try {
        // Require admin key to prevent abuse
        const adminKey = request.headers.get("x-admin-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
          return corsResponse(json({ error: "unauthorized" }, 401), env);
        }

        const { to, body, from } = await request.json();
        if (!to || !body) return corsResponse(json({ error: "to_and_body_required" }, 400), env);

        const TW_FROM = String(from || env.TWILIO_FROM || "+18777660460");
        const accountSid = String(env.TWILIO_ACCOUNT_SID || "").trim();
        if (!accountSid) return corsResponse(json({ error: "TWILIO_ACCOUNT_SID_required" }, 500), env);

        // Prefer API Key SID/Secret; else fallback to AccountSid/AuthToken
        let basicAuth;
        if (env.TWILIO_API_SID && env.TWILIO_API_SECRET) {
          basicAuth = btoa(`${env.TWILIO_API_SID}:${env.TWILIO_API_SECRET}`);
        } else if (env.TWILIO_AUTH_TOKEN) {
          basicAuth = btoa(`${accountSid}:${env.TWILIO_AUTH_TOKEN}`);
        } else {
          return corsResponse(json({ error: "no_twilio_credentials_found" }, 500), env);
        }

        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
        const payload = new URLSearchParams({ To: to, From: TW_FROM, Body: body });
        const r = await fetch(twilioUrl, {
          method: "POST",
          headers: { "Authorization": `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: payload
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return corsResponse(json({ error: "twilio_send_error", status: r.status, detail: data }, 502), env);

        return corsResponse(json({ ok: true, sid: data.sid, status: data.status, to: data.to, from: data.from }), env);
      } catch (e) {
        return corsResponse(json({ error: "sms_send_error", detail: String(e?.message || e) }, 500), env);
      }
    }

    // --- 404 ---
    return corsResponse(json({ error: "not_found", path: url.pathname }, 404), env);
  }
};

/* =========================
   Helpers
   ========================= */

function SAFETY_SYSTEM() {
  return `You are RoboVet, a cautious veterinary information assistant.
You DO NOT diagnose or prescribe. You MUST NOT provide drug dosages or brand prescriptions.
Your role is strictly educational and conservative.

If immediate danger (not breathing, seizures, collapse, severe bleeding, suspected poisoning, heat stroke, vehicle trauma),
advise emergency veterinary care NOW and provide reputable resources (VECCS directory; ASPCA APCC; Pet Poison Helpline).

Return clear sections:
1) Red flags
2) Categories of possible causes (not diagnoses)
3) Conservative home monitoring & comfort steps (no medications)
4) What information to tell a licensed veterinarian
5) When to seek urgent care

Keep language calm, concise, and practical.`;
}

async function chatOnce(env, messages) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const model = String(env.MODEL_DEFAULT || "gpt-4o-mini");
  const temperature = clamp(Number(env.TEMP ?? 0.2), 0, 1);
  const max_tokens = Number(env.MAX_TOKENS ?? 1400);

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, messages, temperature, max_tokens })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`upstream ${r.status}: ${JSON.stringify(data).slice(0, 400)}`);
  return data?.choices?.[0]?.message?.content || "";
}

/* Twilio signature verification (optional; enabled if TWILIO_AUTH_TOKEN set) */
async function verifyTwilioSignature(request, env) {
  const token = env.TWILIO_AUTH_TOKEN;
  if (!token) return true; // not configured -> skip validation
  const url = new URL(request.url); const fullUrl = url.toString();
  const headers = request.headers; const twilioSig = headers.get("x-twilio-signature"); if (!twilioSig) return false;

  let bodyParams = "";
  if ((headers.get("content-type") || "").includes("application/x-www-form-urlencoded")) {
    const form = await request.clone().formData();
    const pairs = Array.from(form.entries()).map(([k, v]) => [k, String(v)]);
    pairs.sort((a, b) => a[0].localeCompare(b[0]));
    bodyParams = pairs.map(([k, v]) => k + v).join("");
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(fullUrl + bodyParams));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return timingSafeEqual(computed, twilioSig);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length); let out = 0;
  for (let i = 0; i < len; i++) out |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return out === 0 && a.length === b.length;
}

/* Outbound email providers */
async function sendWithSendGrid(env, from, to, subject, text) {
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from }, subject,
      content: [{ type: "text/plain", value: text }]
    })
  });
  if (!r.ok) throw new Error(`SendGrid ${r.status} ${await r.text()}`);
}
async function sendWithMailgun(env, from, to, subject, text) {
  const url = `https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN}/messages`;
  const body = new URLSearchParams({ from, to, subject, text });
  const auth = "Basic " + btoa("api:" + env.MAILGUN_API_KEY);
  const r = await fetch(url, { method: "POST", headers: { "Authorization": auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`Mailgun ${r.status} ${await r.text()}`);
}
async function sendWithPostmark(env, from, to, subject, text) {
  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "X-Postmark-Server-Token": env.POSTMARK_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: text, MessageStream: "outbound" })
  });
  if (!r.ok) throw new Error(`Postmark ${r.status} ${await r.text()}`);
}

/* Small utilities & CORS */
function parseEmail(s = "") { const m = /<([^>]+)>/.exec(s); return (m ? m[1] : s).trim(); }
function stripHtml(h = "") { return h.replace(/<[^>]+>/g, " "); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function xmlEscape(s) { return String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])); }
function sanitizeForSMS(s = "") { return s.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim(); }
async function safeText(res) { try { return await res.text(); } catch { return ""; } }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
function allowedOrigin(env, reqOrigin = "") {
  if (env.ALLOW_ALL === "1") return reqOrigin || "*";
  const allowed = String(env.ALLOWED_ORIGIN || "").trim();
  return allowed || reqOrigin || "*";
}
function corsHeaders(env, reqOrigin = "") {
  const origin = allowedOrigin(env, reqOrigin);
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function corsResponse(res, env) { const h = corsHeaders(env); Object.entries(h).forEach(([k, v]) => res.headers.set(k, v)); return res; }
function corsPreflight(env) { return new Response(null, { status: 204, headers: corsHeaders(env) }); }
function corsSSE(stream, env) {
  return new Response(stream, {
    headers: { ...corsHeaders(env), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive" }
  });
}
