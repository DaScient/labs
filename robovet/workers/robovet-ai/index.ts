// workers/robovet-ai/index.ts
import openai from "./openai";
import hf from "./hf";

export interface Env {
  OPENAI_API_KEY: string;
  HF_TOKEN: string;
  ROBO_VET_APP_TOKEN: string;
  ALLOWED_ORIGINS?: string;
}

function cors(req: Request, env: Env) {
  const requestOrigin = req.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const allow = allowed.length === 0 || allowed.includes(requestOrigin);
  return {
    "Access-Control-Allow-Origin": allow ? (requestOrigin || "*") : "https://dascient.com",
    "Access-Control-Allow-Headers": "content-type,x-robovet-token,authorization",
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
  };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req, env) });
    const url = new URL(req.url);
    const headers = cors(req, env);

    // root page
    if (url.pathname === "/") {
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>RoboVet AI Worker</title>
<style>body{font:14px ui-sans-serif,system-ui;margin:40px;max-width:720px}</style>
</head><body>
<h1>RoboVet AI Worker</h1>
<p>✅ Worker is running. Available endpoints:</p>
<ul>
  <li><code>POST /v1/robovet/completions</code> (OpenAI proxy)</li>
  <li><code>POST /v1/robovet/hf-generate</code> (Hugging Face proxy)</li>
  <li><code>GET  /v1/health</code> (health check)</li>
</ul>
<p>Try a curl:</p>
<pre>curl -H "x-robovet-token: &lt;YOUR_TOKEN&gt;" \ 
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}],"stream":false}' \
  https://${url.host}/v1/robovet/completions</pre>
</body></html>`;
      const h = new Headers({ ...headers, "content-type": "text/html; charset=UTF-8" });
      return new Response(html, { status: 200, headers: h });
    }

    // health
    if (url.pathname === "/v1/health") {
      const h = new Headers({ ...headers, "content-type": "application/json" });
      const ok = Boolean(env.OPENAI_API_KEY && env.ROBO_VET_APP_TOKEN);
      return new Response(JSON.stringify({
        ok,
        endpoints: ["/v1/robovet/completions", "/v1/robovet/hf-generate"],
        hasOpenAI: !!env.OPENAI_API_KEY,
        hasHuggingFace: !!env.HF_TOKEN,
      }), { status: ok ? 200 : 503, headers: h });
    }

    // existing routes
    if (url.pathname === "/v1/robovet/completions") {
      const res = await (openai as any).fetch(req, env, ctx);
      const h = new Headers(res.headers); for (const [k,v] of Object.entries(headers)) h.set(k, v as string);
      return new Response(res.body, { status: res.status, headers: h });
    }

    if (url.pathname === "/v1/robovet/hf-generate") {
      const res = await (hf as any).fetch(req, env, ctx);
      const h = new Headers(res.headers); for (const [k,v] of Object.entries(headers)) h.set(k, v as string);
      return new Response(res.body, { status: res.status, headers: h });
    }

    return new Response("Not Found", { status: 404, headers });
  }
};
