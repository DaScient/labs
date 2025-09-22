// workers/robovet-ai/index.ts
import openai from "./openai";
import hf from "./hf";

export interface Env {
  OPENAI_API_KEY: string;
  HF_TOKEN: string;
  ROBO_VET_APP_TOKEN: string;
  ALLOWED_ORIGINS?: string; // optional CSV of origins
}

function cors(req: Request, env: Env) {
  const requestOrigin = req.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const allow = allowed.length === 0 || allowed.includes(requestOrigin);
  return {
    "Access-Control-Allow-Origin": allow ? (requestOrigin || "*") : "https://dascient.com",
    "Access-Control-Allow-Headers": "content-type,x-robovet-token",
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
  };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors(req, env) });
    }

    const url = new URL(req.url);
    const headers = cors(req, env);

    // Route to your two modules
    if (url.pathname === "/v1/robovet/completions") {
      const res = await (openai as any).fetch(req, env, ctx);
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(headers)) h.set(k, v as string);
      return new Response(res.body, { status: res.status, headers: h });
    }

    if (url.pathname === "/v1/robovet/hf-generate") {
      const res = await (hf as any).fetch(req, env, ctx);
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(headers)) h.set(k, v as string);
      return new Response(res.body, { status: res.status, headers: h });
    }

    return new Response("Not Found", { status: 404, headers });
  }
};
