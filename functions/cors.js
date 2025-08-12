// functions/cors.js
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get("url");
  if (!target) {
    return new Response('Missing "url" param', { status: 400 });
  }

  // (Optional) allow-list to reduce abuse:
  // const allowed = ["nytimes.com","washingtonpost.com","forbes.com","arstechnica.com","cnbc.com","reuters.com"];
  // const host = new URL(target).hostname.replace(/^www\./,'');
  // if (!allowed.some(d => host.endsWith(d))) return new Response("Forbidden", { status: 403 });

  const r = await fetch(target, {
    headers: { "User-Agent": "DASCIENT-API-FREE/1.0" }
  });
  const body = await r.text();
  return new Response(body, {
    status: r.status,
    headers: {
      "Content-Type": r.headers.get("content-type") || "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    }
  });
}
