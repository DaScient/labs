import { get, round } from "./util.js";

// helper to compute mid from bid/ask/last
function mid(bid, ask, last) {
  if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0) return (bid + ask) / 2;
  if (Number.isFinite(last)) return last;
  return null;
}
function closest(arr, price) {
  if (!arr?.length || !Number.isFinite(price)) return null;
  return arr.slice().sort((a,b)=>Math.abs(a.strike-price)-Math.abs(b.strike-price))[0];
}

export async function scrapeOptions(symbol) {
  const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;

  // 1) fetch root to get expirations & underlying
  const root = await get(base, { headers: { "Accept": "application/json" } });
  const chain = root?.optionChain?.result?.[0];
  if (!chain) return null;

  const price = Number(chain?.quote?.regularMarketPrice) || null;
  const expUnixList = chain?.expirationDates || [];
  if (!expUnixList.length) return { expiration: null, price, atmCall:null, atmPut:null };

  // 2) find first non-empty expiration
  let chosenUnix = null, options = null;
  for (const ts of expUnixList) {
    const j = await get(`${base}?date=${ts}`, { headers: { "Accept": "application/json" } });
    const r = j?.optionChain?.result?.[0];
    const calls = r?.options?.[0]?.calls || [];
    const puts  = r?.options?.[0]?.puts  || [];
    if (calls.length + puts.length > 0) {
      chosenUnix = ts;
      options = { calls, puts };
      break;
    }
  }
  if (!options) return { expiration: null, price, atmCall:null, atmPut:null };

  const calls = [];
  const puts  = [];
  for (const c of (options.calls || [])) {
    const m = mid(Number(c?.bid), Number(c?.ask), Number(c?.lastPrice));
    if (!Number.isFinite(Number(c?.strike)) || m == null) continue;
    calls.push({ strike: Number(c.strike), mid: round(m) });
  }
  for (const p of (options.puts || [])) {
    const m = mid(Number(p?.bid), Number(p?.ask), Number(p?.lastPrice));
    if (!Number.isFinite(Number(p?.strike)) || m == null) continue;
    puts.push({ strike: Number(p.strike), mid: round(m) });
  }
  calls.sort((a,b)=>a.strike-b.strike);
  puts.sort((a,b)=>a.strike-b.strike);

  // Build ATM + simple spreads
  let atmCall=null, atmPut=null;
  if (Number.isFinite(price)) {
    atmCall = calls.find(c=>c.strike>=price) || closest(calls, price);
    const below = puts.filter(p=>p.strike<=price);
    atmPut = below.length ? below[below.length-1] : closest(puts, price);
  }
  const nextHigher = s => calls.find(c=>c.strike>s);
  const nextLower  = s => { const b=puts.filter(p=>p.strike<s); return b.length ? b[b.length-1] : null; };

  let bullCallSpread=null, bearPutSpread=null, bullPutCredit=null, bearCallCredit=null, ironCondor=null;

  if (atmCall) {
    const c2 = nextHigher(atmCall.strike);
    if (c2) {
      const debit = round((atmCall.mid ?? 0) - (c2.mid ?? 0));
      bullCallSpread = { lower: atmCall.strike, upper: c2.strike, debit };
      bearCallCredit = { short: atmCall.strike, long: c2.strike, credit: debit }; // symmetric mapping
    }
  }
  if (atmPut) {
    const p2 = nextLower(atmPut.strike);
    if (p2) {
      const debit = round((atmPut.mid ?? 0) - (p2.mid ?? 0));
      bearPutSpread = { upper: atmPut.strike, lower: p2.strike, debit };
      bullPutCredit = { short: atmPut.strike, long: p2.strike, credit: debit };
    }
  }
  if (bearCallCredit && bullPutCredit) {
    const widthCall = bearCallCredit.long - bearCallCredit.short;
    const widthPut  = bullPutCredit.short - bullPutCredit.long;
    const width = Math.min(widthCall, widthPut);
    const credit = round((bearCallCredit.credit ?? 0) + (bullPutCredit.credit ?? 0));
    const estMaxLoss = width > 0 ? round(width - credit) : null;
    ironCondor = {
      shortPut: bullPutCredit.short, longPut: bullPutCredit.long,
      shortCall: bearCallCredit.short, longCall: bearCallCredit.long,
      credit, width, estMaxLoss
    };
  }

  return {
    expiration: new Date(chosenUnix * 1000).toISOString().slice(0, 10),
    price: Number.isFinite(price) ? round(price) : null,
    atmCall, atmPut, bullCallSpread, bearPutSpread, bullPutCredit, bearCallCredit, ironCondor
  };
}
