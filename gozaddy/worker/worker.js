export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders(req, env) });
      }

      if (url.pathname === '/cors') {
        const target = url.searchParams.get('url');
        if (!target) return json({ ok:false, error:'missing url' }, 400, req, env);
        const upstream = await fetch(target, { headers: { 'User-Agent': 'GoZaddy/1.0 (+dascient)' }});
        const txt = await upstream.text();
        return new Response(txt, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
            ...corsHeaders(req, env)
          }
        });
      }

      if (url.pathname === '/generate' && req.method === 'POST') {
        const body = await req.json();
        const { meta={}, text='', perspectives=[], min_words=700, max_words=1200 } = body || {};
        const model = (body.model || env.MODEL_DEFAULT || pickModel(env)).trim();

        // Build a single prompt that asks for multi-perspective, ASCII-only output
        const prompt = buildPrompt(meta, text, perspectives, min_words, max_words);

        const resp = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            input: prompt,
            temperature: 0.7,
            top_p: 0.95,
            max_output_tokens: 4096
          })
        });

        if (!resp.ok) {
          const errTxt = await resp.text().catch(()=> 'error');
          return json({ ok:false, error: 'openai_error', detail: errTxt }, 500, req, env);
        }
        const data = await resp.json();
        const textOut = data.output_text || (data.output?.[0]?.content?.[0]?.text ?? '');
        return json({ ok:true, model, text: sanitizeAscii(textOut) }, 200, req, env);
      }

      if (url.pathname === '/health') {
        return json({ ok:true, ts: Date.now() }, 200, req, env);
      }

      return json({ ok:false, error:'not_found' }, 404, req, env);
    } catch (e) {
      return json({ ok:false, error: String(e) }, 500, req, env);
    }
  }
}

/* ----- helpers ----- */
function corsHeaders(req, env){
  const origin = req.headers.get('Origin') || '*';
  let allow = '*';
  if (env.ALLOWED_ORIGINS) {
    const list = env.ALLOWED_ORIGINS.split(',').map(s=>s.trim());
    if (list.includes(origin)) allow = origin;
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}
function json(obj, status, req, env){
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type':'application/json; charset=utf-8', ...corsHeaders(req, env) }
  });
}
function sanitizeAscii(s=''){
  return s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ''); // keep ASCII, tabs/newlines
}
function pickModel(env){
  const pool = (env.MODELS_POOL || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!pool.length) return 'gpt-4.1-mini';
  return pool[Math.floor(Math.random() * pool.length)];
}
function buildPrompt(meta, text, perspectives, minW, maxW){
  return `
You are an expert editor-analyst. Create ORIGINAL, actionable, ASCII-only outputs.

RULES:
- Do NOT copy long lines from the source; paraphrase and analyze.
- Write ${minW}-${maxW} words TOTAL across all sections.
- Use clear section labels in ALL CAPS.
- End with: "SEO KEYWORDS: kw1; kw2; kw3; kw4; kw5".

META:
Title: ${meta.title||''}
Link: ${meta.link||''}
Published: ${meta.published||''}
Feed: ${meta.feed||''}

SOURCE (cleaned text):
"""
${text.slice(0, 15000)}
"""

PERSPECTIVES: ${JSON.stringify(perspectives)}

OUTPUT FORMAT (repeat for each perspective, separated by "-----"):
PERSPECTIVE: <name>
INTRODUCTION
<2-3 sentences>

KEY SIGNALS
- <bullet>
- <bullet>
- <bullet>

STRATEGIC IMPLICATIONS
- <bullet>

RECOMMENDATIONS
- <bullet>
- <bullet>

ACTION CHECKLIST
- <bullet>
- <bullet>

SEO KEYWORDS: kw1; kw2; kw3; kw4; kw5
`.trim();
}
