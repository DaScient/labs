async function verifyTwilioSignature(request, env) {
  const token = env.TWILIO_AUTH_TOKEN;
  if (!token) return true; // skip if not configured

  const url = new URL(request.url);
  // Twilio signs the EXACT URL they posted to (no query reordering)
  const fullUrl = url.toString();

  const headers = request.headers;
  const twilioSig = headers.get("x-twilio-signature");
  if (!twilioSig) return false;

  // Build the string: URL + concatenated sorted params (by key, ascending)
  let bodyParams = "";
  if ((headers.get("content-type") || "").includes("application/x-www-form-urlencoded")) {
    const form = await request.clone().formData();
    const pairs = Array.from(form.entries()).map(([k, v]) => [k, String(v)]);
    pairs.sort((a, b) => a[0].localeCompare(b[0]));
    bodyParams = pairs.map(([k, v]) => k + v).join("");
  }

  const data = fullUrl + bodyParams;

  // HMAC-SHA1 using token
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  // Constant-time compare
  return timingSafeEqual(computed, twilioSig);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let out = 0;
  for (let i = 0; i < len; i++) {
    out |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return out === 0 && a.length === b.length;
}
