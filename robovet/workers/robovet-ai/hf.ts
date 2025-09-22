export default {
  async fetch(req: Request, env: any) {
    if (new URL(req.url).pathname !== "/v1/robovet/hf-generate") {
      return new Response("Not found", { status: 404 });
    }
    const appToken = req.headers.get("x-robovet-token");
    if (!appToken || appToken !== env.ROBO_VET_APP_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }
    const { inputs, parameters, endpointUrl } = await req.json();

    // endpointUrl: either Serverless (Hub model) or your Inference Endpoint URL
    const r = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.HF_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inputs, parameters })
    });

    return new Response(r.body, {
      headers: { "Content-Type": r.headers.get("Content-Type") ?? "application/json" },
      status: r.status
    });
  }
}
