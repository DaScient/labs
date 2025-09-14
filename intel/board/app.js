// ===== CONFIG =====
const API_BASE = "https://intel.aristocles24.workers.dev"; 

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

function renderFeeds(items) {
  const grid = $("feedsGrid"); grid.innerHTML = "";
  items.forEach((it) => {
    const card = document.createElement("article");
    card.className = "tv p-4 border border-[var(--border)] rounded-2xl";
    card.style.background = "var(--card)";
    card.innerHTML = `
      <div class="flex items-center justify-between gap-3 mb-2">
        <div class="text-sm text-[var(--muted)] truncate">${it.src} — ${(it.lang||"en").toUpperCase()}</div>
        <div class="text-xs">${it.ageH ? (it.ageH.toFixed ? it.ageH.toFixed(1) : it.ageH) : ""}h</div>
      </div>
      <a href="${it.link}" target="_blank" rel="noopener" class="block font-semibold hover:underline mb-2">${it.title}</a>
      ${it.summary ? `<p class="text-sm text-[var(--muted)] mb-2">${it.summary}</p>` : ""}
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
      <div class="text-xs text-[var(--muted)] mb-2">Sources: ${c.sources.join(", ")}</div>
      <div class="flex flex-wrap gap-2">${(c.tags||[]).slice(0,8).map(t=>`<span class="chip">${t}</span>`).join("")}</div>
    `;
    grid.appendChild(a);
  });
}

function buildCharts(regionCounts, topicCounts) {
  // Region pie
  const rc = $("regionChart").getContext("2d");
  if (regionChart) regionChart.destroy();
  regionChart = new Chart(rc, {
    type: "pie",
    data: { labels: regionCounts.map(d=>d.name), datasets: [{ data: regionCounts.map(d=>d.value) }] },
    options: { responsive: true, plugins: { legend: { labels: { color: "#cbd5e1" } } } }
  });

  // Topics bar
  const tc = $("topicChart").getContext("2d");
  if (topicChart) topicChart.destroy();
  topicChart = new Chart(tc, {
    type: "bar",
    data: { labels: topicCounts.map(d=>d.name), datasets: [{ label: "Count", data: topicCounts.map(d=>d.value) }] },
    options: {
      responsive: true,
      scales: {
        x: { ticks: { color: "#cbd5e1", maxRotation: 0, minRotation: 0 } },
        y: { ticks: { color: "#cbd5e1" } }
      },
      plugins: { legend: { display:false } }
    }
  });
}

async function loadAll() {
  const sinceHours = +$("sinceHours").value || 12;
  const limit = +$("limit").value || 18;
  $("windowInfo").textContent = `window: ${sinceHours}h • limit: ${limit}`;

  // Sources for filter dropdown
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

  // Build topic filter options from items
  const tset = new Set();
  items.forEach(i => (i.tags||[]).forEach(t => tset.add(t)));
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

  // Render UI
  renderFeeds(items);
  renderClusters(cls);

  // Aggregate for charts
  const tMap = new Map(), gMap = new Map();
  items.forEach(i => {
    (i.tags||[]).forEach(t => tMap.set(t, (tMap.get(t)||0)+1));
    (i.geos||[]).forEach(g => gMap.set(g, (gMap.get(g)||0)+1));
  });
  const topicCounts = [...tMap.entries()].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value).slice(0,12);
  const regionCounts = [...gMap.entries()].map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value);
  buildCharts(regionCounts, topicCounts);
}

// SSE ticker
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

// Wire controls & init
window.addEventListener("DOMContentLoaded", () => {
  $("refreshBtn").addEventListener("click", loadAll);
  $("sinceHours").addEventListener("change", loadAll);
  $("limit").addEventListener("change", loadAll);
  $("topicFilter").addEventListener("change", loadAll);
  $("sourceFilter").addEventListener("change", loadAll);
  loadAll();
  startTicker();
});
