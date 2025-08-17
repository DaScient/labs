import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fetch } from "undici";

export async function get(url, { headers = {}, tries = 3, backoffMs = 300 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; DascientBot/1.0)",
          "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
          ...headers
        }
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const ct = r.headers.get("content-type") || "";
      return ct.includes("application/json") ? r.json() : r.text();
    } catch (e) {
      lastErr = e;
      await delay(backoffMs * (i + 1));
    }
  }
  throw lastErr;
}

export async function saveJSON(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

// simple rounder
export const round = x => Number((x ?? 0).toFixed(2));

// map Finviz "Recom" number to buy/hold/sell
export function mapRecomToKey(n) {
  if (!Number.isFinite(n)) return null;
  if (n <= 2.2) return "buy";
  if (n >= 3.0) return "sell";
  return "hold";
}
