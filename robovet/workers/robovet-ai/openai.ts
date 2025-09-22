export default {
  async fetch(req: Request, env: any) {
    if (new URL(req.url).pathname !== "/v1/robovet/completions") {
      return new Response("Not found", { status: 404 });
    }

    const appToken = req.headers.get("x-robovet-token")
      ?? (req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
    if (!appToken || appToken !== env.ROBO_VET_APP_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await req.json();
    const model = body.model ?? "gpt-4o-mini";
    const messages = body.messages ?? [];
    const stream = body.stream ?? true;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: body.temperature ?? 0.2,
        stream,
      }),
    });

    return new Response(r.body, {
      headers: {
        "Content-Type": r.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-store",
      },
      status: r.status,
    });
  },
};
