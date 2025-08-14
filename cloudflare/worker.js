export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ping") {
      return new Response(JSON.stringify({ ok: true, now: Date.now() }), {
        headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" }
      });
    }
    return new Response("custom worker is live");
  }
}
