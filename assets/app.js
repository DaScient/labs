// Lightweight client that calls your Cloudflare Worker for data.
const elRows = document.getElementById("rows");
const elLoad = document.getElementById("load");
const elSymbols = document.getElementById("symbols");
const elApi = document.getElementById("api");

async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function decideBSH(price, target, recommendationKey) {
  if (recommendationKey) {
    const key = String(recommendationKey).toLowerCase();
    if (key.includes("buy")) return "buy";
    if (key.includes("sell")) return "sell";
    return "hold";
  }
  const diff = (target - price) / price;
  if (diff >= 0.1) return "buy";
  if (diff <= -0.05) return "sell";
  return "hold";
}

function fmt(n, d=2) { 
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toFixed(d); 
}

function renderRow(info) {
  const tr = document.createElement("tr");

  const tag = decideBSH(info.price, info.target, info.recommendationKey);
  const tagHTML = `<span class="tag ${tag}">${tag.toUpperCase()}</span>`;

  const opts = info.options || {};
  const call = opts.atmCall ? `Call ${fmt(opts.atmCall.strike,2)} @ ${fmt(opts.atmCall.mid,2)}` : "—";
  const put  = opts.atmPut  ? `Put ${fmt(opts.atmPut.strike,2)} @ ${fmt(opts.atmPut.mid,2)}`  : "—";
  const spread = opts.bullCallSpread ? `Bull Call ${fmt(opts.bullCallSpread.lower,2)}→${fmt(opts.bullCallSpread.upper,2)} ≈ ${fmt(opts.bullCallSpread.debit,2)}` : "—";

  tr.innerHTML = `
    <td><strong>${info.symbol}</strong></td>
    <td>$${fmt(info.price)}</td>
    <td>$${fmt(info.target)}</td>
    <td>${tagHTML}</td>
    <td>
      <div class="options">
        <span class="chip">ATM ${call}</span>
        <span class="chip">ATM ${put}</span>
        <span class="chip">${spread}</span>
        <div class="small">Exp: ${opts.expiration || "—"}</div>
      </div>
    </td>
  `;
  elRows.appendChild(tr);
}

async function load() {
  elRows.innerHTML = "";
  const base = elApi.value.trim().replace(/\/+$/,"");
  const symbols = elSymbols.value.split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);

  for (const symbol of symbols) {
    try {
      const [summary, options] = await Promise.all([
        fetchJSON(`${base}/api/summary?symbol=${encodeURIComponent(symbol)}`),
        fetchJSON(`${base}/api/options?symbol=${encodeURIComponent(symbol)}`)
      ]);
      renderRow({
        symbol,
        price: summary.price ?? null,
        target: summary.targetMeanPrice ?? null,
        recommendationKey: summary.recommendationKey ?? null,
        options
      });
    } catch (err) {
      renderRow({ symbol, price: null, target: null, recommendationKey: null, options: {} });
      console.error(symbol, err);
    }
  }
}

elLoad.addEventListener("click", load);
// Auto-load once for convenience (will fail until API is set)
setTimeout(load, 300);
