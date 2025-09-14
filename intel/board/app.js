// ===== CONFIG =====
const API_BASE = "https://intel.aristocles24.workers.dev"; // set to your Worker URL or "" if same origin

// ===== STATE =====
let regionChart, topicChart;

// ===== HELPERS =====
const $ = (id) => document.getElementById(id);
const api = (path) => `${API_BASE}${path}`;

async function jget(url) {
  const r = await fetch(url, { headers: { "accept": "application/json" }});
  if (!r.ok) throw new Error(url + " -> " + r.status);
  return r.json();
}
const rel = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso); const s = Math.max(0, (Date.now() - d.getTime())/1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return d.toLocaleString();
};

// ===== STATUS BAR =====
function led(label, state, tooltip = "") {
  const cls = state === true ? "ok" : state === "warn" ? "warn" : "bad";
  const title = tooltip ? ` title="${tooltip.replace(/"/g,"'")}"` : "";
  return `<span class="led ${cls}"${title}>
    <span class="led-dot"></span><span>${label}</span>
  </span>`;
}
function renderStatus(s) {
  const el = $("statusBar");
  if (!el) return;
  const f = s?.features || {};
  const feeds = s?.feeds?.sample || [];

  const hfMs = f.hf?.ms != null ? `${f.hf.ms}ms` : "";
  const cronStr = s?.cron?.enabled ? `cron: ${rel(s.cron.last)}` : "cron: off";

  const parts = [
    `<div class="statusbar">`,
      `<div class="status-group">`,
        led("KV", !!f.kv),
        led("HMAC", !!f.hmac),
        led("SSE", !!f.sse),
        led("Search", !!f.search),
        led("Fear/Greed", f.fearGreed?.ok === true),
        led("HF", f.hf?.enabled ? (f.hf?.ok ? true : false) : false, hfMs),
      `</div>`,
      `<span class="status-spacer"></span>`,
      `<div class="status-group">`,
        ...feeds.map(fp => led(fp.src, fp.ok === true, `${fp.ms}ms`)),
      `</div>`,
      `<span class="status-spacer"></span>`,
      `<span class="smallmuted">v${s.version} • ${cronStr}</span>`,
    `</div>`
  ];
  el.innerHTML = parts.join("");
}
async function loadStatus() {
  try {
    const s = await jget(api("/api/status"));
    renderStatus(s);
  } catch (e) {
    $("statusBar").innerHTML = `<div class="statusbar">${led("Status", false, e.message || "error")}</div>`;
  }
}

// ===== FEEDS / CLUSTERS UI =====
function renderFeeds(items) {
  const grid = $("feedsGrid"); grid.innerHTML = "";
  items.forEach((it) => {
    const card = document.createElement("article");
    card.className = "tv p-4 border border-[var(--border)] rounded-2xl";
    card.style.background = "var(--card)";
    card.innerHTML = `
      <div class="flex items-center justify-between gap-3 mb-2">
        <div class="text-sm smallmuted truncate">${it.src} — ${(it.lang||"en").toUpperCase()}</div>
        <div class="text-xs smallmuted">${it.ageH ? (it.ageH.toFixed ? it.ageH.toFixed(1) : it.ageH) : ""}h</div>
      </div>
      <a href="${it.link}" target="_blank" rel="noopener" class="block font-semibold hover:underline mb-2">${it.title}</a>
      ${it.summary ? `<p class="text-sm smallmuted mb-2">${it.summary}</p>` : ""}
      <div class="flex flex-wrap gap-2">${(it.tags||[]).slice(0,6).map(t=>`<span class="chip">${t}</span>`).join("")}</div>
    `;
    grid.appendChild(card);
  });
}
function renderClusters(clusters) {
  const grid = $("clustersGrid"); grid.innerHTML = "";
  clusters.forEach(c => {
    const a = document.createElement("article");
    a.className = "p-4 border border-[var(--border)] rounded-2xl";
    a.style.background = "var(--card)";
    const head = c.items && c.items[0] ? c.items[0].title : "(no title)";
    a.innerHTML = `
      <div class="font-semibold text-sm mb-1 line-clamp-2">${head}</div>
      <div class="text-xs smallmuted mb-2">Sources: ${c.sources.join(", ")}</div>
      <div class="flex flex-wrap gap-2">${(c.tags||[]).slice(0,8).map(t=>`<span class="chip">${t}</span>`).join("")}</div>
    `;
    grid.appendChild(a);
  });
}

// ===== CHARTS =====
function buildCharts(regionCounts, topicCounts) {
  const rc = $("regionChart").getContext("2d");
  if (regionChart) regionChart.destroy();
  regionChart = new Chart(rc, {
    type: "pie",
    data: { labels: regionCounts.map(d=>d.name), datasets: [{ data: regionCounts.map(d=>d.value) }] },
    options: { responsive: true, plugins: { legend: { labels: { color: "#cbd5e1" } } } }
  });

  const tc = $("topicChart").getContext("2d");
  if (topicChart) topicChart.destroy();
  topicChart = new Chart(tc, {
    type: "bar",
    data: { labels: topicCounts.map(d=>d.name), datasets: [{ label: "Count", data: topicCounts.map(d=>d.value) }] },
    options: {
      responsive: true,
      scales: { x: { ticks: { color: "#cbd5e1" } }, y: { ticks: { color: "#cbd5e1" } } },
      plugins: { legend: { display:false } }
    }
  });
}

// ===== DATA LOAD =====
async function loadAll() {
  // status first (paints LEDs fast)
  loadStatus().catch(()=>{});

  const sinceHours = +$("sinceHours").value || 12;
  const limit = +$("limit").value || 18;
  $("windowInfo").textContent = `window: ${sinceHours}h • limit: ${limit}`;

  // Sources list (for filter dropdown)
  const sources = await jget(api("/api/sources")).catch(()=>[]);
  const srcSel = $("sourceFilter");
  if (srcSel.options.length <= 1 && Array.isArray(sources)) {
    sources.map(s => s.src).sort().forEach(s => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      srcSel.appendChild(opt);
    });
  }

  // Enriched items & clusters
  const [enrich, clusters] = await Promise.all([
    jget(api(`/api/enrich?sinceHours=${sinceHours}&limit=${limit}`)).catch(()=>({items:[]})),
    jget(api(`/api/clusters/enriched?sinceHours=${sinceHours}&limit=${Math.max(10, Math.min(40, limit))}`)).catch(()=>[])
  ]);

  let items = enrich.items || [];
  let cls = Array.isArray(clusters) ? clusters : [];

  // Topic options from items
  const tset = new Set(); items.forEach(i => (i.tags||[]).forEach(t => tset.add(t)));
  const topicSel = $("topicFilter");
  if (topicSel.options.length <= 1) {
    [...tset].sort().forEach(t => {
      const opt = document.createElement("option");
      opt.value = t; opt.textContent = t;
      topicSel.appendChild(opt);
    });
  }

  // Apply filters
  const topic = topicSel.value;
  const source = srcSel.value;
  if (topic !== "all") {
    items = items.filter(i => (i.tags||[]).includes(topic));
    cls = cls.filter(c => (c.tags||[]).includes(topic));
  }
  if (source !== "all") {
    items = items.filter(i => i.src === source);
    cls = cls.filter(c => (c.sources||[]).includes(source));
  }

  // Render
  renderFeeds(items);
  renderClusters(cls);

  // Charts
  const tMap = new Map(), gMap = new Map();
  items.forEach(i => {
    (i.tags||[]).forEach(t => tMap.set(t, (tMap.get(t)||0)+1));
    (i.geos||[]).forEach(g => gMap.set(g, (gMap.get(g)||0)+1));
  });
  const topicCounts = [...tMap.entries()].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value).slice(0,12);
  const regionCounts = [...gMap.entries()].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value);
  buildCharts(regionCounts, topicCounts);
}

// ===== SSE ticker =====
function startTicker() {
  const el = $("ticker");
  try {
    const es = new EventSource(api("/api/stream"));
    es.addEventListener("init", (evt) => {
      const data = JSON.parse(evt.data);
      el.innerHTML = `<span>Stream ready • ${new Date(data.ts).toLocaleTimeString()}</span>`;
    });
    es.addEventListener("tick", (evt) => {
      const data = JSON.parse(evt.data);
      const titles = (data.items||[]).map(i => i.title).filter(Boolean);
      if (titles.length) el.innerHTML = `<span>${titles.join(" • ")}</span>`;
    });
    es.addEventListener("error", () => {
      el.innerHTML = `<span>stream ended — reconnecting…</span>`;
      setTimeout(startTicker, 5000);
    });
    setTimeout(()=>{ try{ es.close(); }catch{}; startTicker(); }, 95000);
  } catch (e) {
    el.textContent = "ticker unavailable";
  }
}

// ===== Wire controls & init =====
window.addEventListener("DOMContentLoaded", () => {
  $("refreshBtn").addEventListener("click", loadAll);
  $("sinceHours").addEventListener("change", loadAll);
  $("limit").addEventListener("change", loadAll);
  $("topicFilter").addEventListener("change", loadAll);
  $("sourceFilter").addEventListener("change", loadAll);
  loadAll();
  startTicker();
});
