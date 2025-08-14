const apiBase = "https://stocks.aristocles24.workers.dev/api";

async function fetchJSON(url){
  const res = await fetch(url);
  return await res.json();
}

async function loadMock(){
  const data = await fetchJSON(apiBase + "/mock?symbol=AAPL");
  renderDashboard(data);
}

async function loadLive(){
  const data = await fetchJSON(apiBase + "/summary?symbol=AAPL&mock=1");
  renderDashboard(data);
}

function renderDashboard(data){
  const dash = document.getElementById("dashboard");
  dash.innerHTML = "";
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <h2>${data.symbol}</h2>
    <p>Price: $${data.price}</p>
    <p>Target: $${data.targetMeanPrice}</p>
    <p class="${data.recommendationKey}">Recommendation: ${data.recommendationKey.toUpperCase()}</p>
  `;
  if(data.options){
    card.innerHTML += "<h3>Options Strategies</h3>";
    const o = data.options;
    card.innerHTML += `<p>ATM Call: Strike ${o.atmCall.strike} @ ${o.atmCall.mid}</p>`;
    card.innerHTML += `<p>ATM Put: Strike ${o.atmPut.strike} @ ${o.atmPut.mid}</p>`;
    card.innerHTML += `<p>Bull Call Spread: ${o.bullCallSpread.lower}-${o.bullCallSpread.upper}, Debit ${o.bullCallSpread.debit}</p>`;
    card.innerHTML += `<p>Bear Put Spread: ${o.bearPutSpread.lower}-${o.bearPutSpread.upper}, Debit ${o.bearPutSpread.debit}</p>`;
    card.innerHTML += `<p>Bull Put Credit: Short ${o.bullPutCredit.short}, Long ${o.bullPutCredit.long}, Credit ${o.bullPutCredit.credit}</p>`;
    card.innerHTML += `<p>Bear Call Credit: Short ${o.bearCallCredit.short}, Long ${o.bearCallCredit.long}, Credit ${o.bearCallCredit.credit}</p>`;
    card.innerHTML += `<p>Iron Condor: [${o.ironCondor.lowerPut}/${o.ironCondor.shortPut}/${o.ironCondor.shortCall}/${o.ironCondor.upperCall}], Credit ${o.ironCondor.credit}, Width ${o.ironCondor.width}, MaxLoss ${o.ironCondor.maxLoss}</p>`;
  }
  dash.appendChild(card);
}
