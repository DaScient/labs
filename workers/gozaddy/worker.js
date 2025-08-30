// workers/gozaddy/worker.js
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '');

      // CORS preflight
      if (request.method === 'OPTIONS') {
        return cors(new Response(null, { status: 204 }), request, env);
      }

      if (path === '' || path === '/') {
        return cors(json({ ok: true, service: 'gozaddy-worker', paths: ['/health','/cors?url=','/generate'] }), request, env);
      }

      if (path === '/health') {
        return cors(json({ ok: true, ts: Date.now() }), request, env);
      }

      if (path === '/cors') {
        const target = url.searchParams.get('url');
        if (!target) return cors(json({ ok: false, error: 'Missing ?url' }, 400), request, env);
        // Basic allowlist for schemes
        if (!/^https?:\/\//i.test(target)) return cors(json({ ok:false, error:'Invalid URL' }, 400), request, env);

        const upstream = await fetch(target, {
          headers: {
            'User-Agent': 'GoZaddy-CORS/1.0 (+dascient)',
            'Accept': '*/*'
          },
          cf: { cacheTtl: 60, cacheEverything: false }
        });

        const body = await upstream.text();
        const hdrs = new Headers({
          'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        });

        return cors(new Response(body, { status: upstream.status, headers: hdrs }), request, env);
      }

      if (path === '/generate') {
        // Rate limit by IP (very light)
        const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
        const okRL = await ratelimit(env, ip, 60, 30); // 30 req / 60s per IP
        if (!okRL) return cors(json({ ok:false, error:'Rate limited' }, 429), request, env);

        if (request.method !== 'POST') {
          return cors(json({ ok:false, error:'POST required' }, 405), request, env);
        }
        const payload = await safeJson(request);
        const {
          meta = { title:'', link:'', feed:'', published:'' },
          text = '',
          perspectives = ['Business Strategy'],
          min_words = 900,
          max_words = 1500,
          temperature = 0.7
        } = payload || {};

        if (!env.OPENAI_API_KEY) return cors(json({ ok:false, error:'OPENAI_API_KEY not configured' }, 500), request, env);
        if (!text || !Array.isArray(perspectives) || perspectives.length === 0) {
          return cors(json({ ok:false, error:'Missing text or perspectives[]' }, 400), request, env);
        }

        const model = chooseModel(env);
        const prompt = buildPrompt({ meta, text, perspectives, min_words, max_words });

        // OpenAI Responses API
        const resp = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            input: prompt,
            temperature,
            top_p: 0.95,
            max_output_tokens: 8192,
            // Safety: ASCII only; no HTML
            modalities: ['text']
          })
        });

        if (!resp.ok) {
          const errTxt = await resp.text().catch(()=> 'error');
          return cors(json({ ok:false, error:'OpenAI error', details: errTxt }, resp.status), request, env);
        }

        const data = await resp.json();
        const out = extractOutputText(data);
        const ascii = toAscii(out || '').trim();

        return cors(json({ ok: true, model, text: ascii }), request, env);
      }

      return cors(json({ ok:false, error:'Not found' }, 404), request, env);
    } catch (e) {
      return json({ ok:false, error: String(e?.message || e) }, 500);
    }
  }
};

/* ---------- helpers ---------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function cors(res, request, env) {
  const h = new Headers(res.headers);
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s=>s.trim()).filter(Boolean);
  const allow =
    allowed.includes('*') ||
    allowed.some(a => a === origin || (a.endsWith('*') && origin.startsWith(a.slice(0,-1))));

  h.set('Access-Control-Allow-Origin', allow ? origin || '*' : '*');
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  return new Response(res.body, { status: res.status, headers: h });
}

async function safeJson(req) {
  try { return await req.json(); } catch { return null; }
}

function toAscii(s) {
  // Normalize to ASCII
  return s
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, (ch) => {
      // simple dash/quote substitutions
      const map = { '“':'"', '”':'"', '‘':"'", '’':"'", '–':'-', '—':'-', '…':'...' };
      return map[ch] || ' ';
    });
}

function extractOutputText(apiData) {
  // Supports Responses API structure
  try {
    if (apiData?.output_text) return apiData.output_text;
    if (Array.isArray(apiData?.output)) {
      const t = apiData.output.map(x => x?.content?.[0]?.text || '').join('\n');
      if (t.trim()) return t;
    }
  } catch {}
  // Last resort
  return typeof apiData === 'string' ? apiData : JSON.stringify(apiData);
}

function chooseModel(env) {
  // You can override via env.MODEL_PREFS = "gpt-4.1-mini,gpt-4o-mini"
  const prefs = (env.MODEL_PREFS || 'gpt-4.1-mini,gpt-4o-mini').split(',').map(s=>s.trim()).filter(Boolean);
  // naive rotation by time slice
  const i = Math.floor(Date.now() / 60000) % prefs.length;
  return prefs[i];
}

function buildPrompt({ meta, text, perspectives, min_words, max_words }) {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n|0));
  const minW = clamp(min_words, 300, 6000);
  const maxW = clamp(max_words, minW + 100, Math.max(minW + 300, 9000));

  return `
You are an elite editorial strategist. Create ORIGINAL, actionable, executive-grade analyses
for EACH perspective listed. Do not copy the source; synthesize and extend it. ASCII only.

HARD REQUIREMENTS:
- Length per perspective: ${minW}-${maxW} words
- Use clear section headers in ALL CAPS (e.g., INTRO, MARKET CONTEXT, IMPLICATIONS, RISKS, ACTIONS)
- Conclude each perspective with:
  SEO KEYWORDS: kw1; kw2; kw3; kw4; kw5
- No markdown tables. No emojis. No HTML.

SOURCE META:
- Title: ${meta.title || ''}
- Link: ${meta.link || ''}
- Published: ${meta.published || ''}
- Feed: ${meta.feed || ''}

SOURCE (for context; do NOT quote verbatim):
"""
${text}
"""

PERSPECTIVES (write one complete analysis for each; separate with a line '-----'):
${JSON.stringify(perspectives)}
  `;
}

/* Very light, in-memory rate limiting (per-IP, window(seconds), limit) */
async function ratelimit(env, key, windowSec, limit) {
  try {
    const id = `rl:${Math.floor(Date.now()/1000/windowSec)}:${key}`;
    let count = await env?.GOZADDY_KV?.get(id);
    if (!count) {
      await env?.GOZADDY_KV?.put(id, '1', { expirationTtl: windowSec });
      return true;
    }
    const c = parseInt(count,10) || 0;
    if (c >= limit) return false;
    await env?.GOZADDY_KV?.put(id, String(c+1), { expirationTtl: windowSec });
    return true;
  } catch {
    // If KV not bound, allow
    return true;
  }
}
