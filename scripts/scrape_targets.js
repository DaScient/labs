import * as cheerio from "cheerio";
import { get, round, mapRecomToKey } from "./util.js";

export async function scrapeTargetAndReco(symbol) {
  const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(symbol)}`;
  const html = await get(url, { headers: { Referer: "https://finviz.com" } });
  const $ = cheerio.load(html);

  // Finviz puts key-value tiles in snapshot-table2
  let target = null, recom = null, price = null;

  // current price (from quote price span if present)
  const pTxt = $('b#quote_price').first().text().trim() || $('div.quote-price').text().trim();
  if (pTxt) {
    const pNum = Number(pTxt.replace(/[^0-9.\-]+/g, ""));
    if (Number.isFinite(pNum)) price = pNum;
  }

  $('table.snapshot-table2 td').each((i, el) => {
    const txt = $(el).text().trim();
    if (/Target Price/i.test(txt)) {
      const val = $(el).next().text().trim();
      const n = Number(val.replace(/[^0-9.\-]+/g, ""));
      if (Number.isFinite(n)) target = n;
    }
    if (/Recom/i.test(txt)) {
      const val = $(el).next().text().trim();
      const n = Number(val);
      if (Number.isFinite(n)) recom = n;
    }
  });

  const recommendationKey = mapRecomToKey(recom);
  return { price: price ?? null, targetMeanPrice: target ?? null, recommendationKey };
}
