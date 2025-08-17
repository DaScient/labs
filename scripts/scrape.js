import { SYMBOLS } from "./symbols.js";
import { scrapeTargetAndReco } from "./scrape_targets.js";
import { scrapeOptions } from "./scrape_options.js";
import { saveJSON } from "./util.js";

async function run() {
  const out = [];
  for (const sym of SYMBOLS) {
    try {
      const t = await scrapeTargetAndReco(sym);
      out.push({ symbol: sym, ...t });
      console.log(`[targets] ${sym}`, t);
    } catch (e) {
      console.error(`[targets] ${sym} FAILED`, e.message);
      out.push({ symbol: sym, price: null, targetMeanPrice: null, recommendationKey: null, _error: "targets" });
    }
  }
  await saveJSON("docs/summary.json", out);

  // options: write per symbol (so partial failures don't wipe the whole set)
  for (const sym of SYMBOLS) {
    try {
      const opt = await scrapeOptions(sym);
      await saveJSON(`docs/options/${sym}.json`, opt ?? { expiration:null });
      console.log(`[options] ${sym}`, opt?.expiration ?? "none");
    } catch (e) {
      console.error(`[options] ${sym} FAILED`, e.message);
      await saveJSON(`docs/options/${sym}.json`, { expiration:null, _error: e.message });
    }
  }
  console.log("DONE.");
}

run().catch(e => { console.error("FATAL", e); process.exit(1); });
