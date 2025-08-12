// worker.js
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // ---- CORS passthrough for RSS & HTML ----
    if (url.pathname === "/cors") {
      const target = url.searchParams.get("url");
      if (!target) return new Response("Missing url", { status: 400 });
      const r = await fetch(target, { headers: { "User-Agent": "ASCII-RSS/1.0" }});
      const body = await r.text();
      return new Response(body, {
        status: r.status,
        headers: {
          "Content-Type": r.headers.get("content-type") || "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // ---- AI generation ----
    if (url.pathname === "/gen" && req.method === "POST") {
      const { model = "gpt-4o-mini", input = "" } = await req.json().catch(()=>({}));
      // Choose a provider by model prefix (customize as you like)
      if (model.startsWith("gpt-")) {
        // OpenAI Responses API
        const r = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model, input, max_output_tokens: 800, temperature: 0.4, top_p: 0.95
          })
        });
        if (!r.ok) return new Response(`OpenAI error ${r.status}`, { status: 502 });
        const data = await r.json();
        const text = data.output_text || "";
        return new Response(JSON.stringify({ output_text: text }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // Example stub for Anthropic (uncomment if you use it)
      // if (model.startsWith("claude-")) { ... use env.ANTHROPIC_API_KEY ... }

      return new Response(JSON.stringify({ output_text: "" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    return new Response("OK", { status: 200 });
  }
};
