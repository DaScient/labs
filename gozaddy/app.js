const out = document.getElementById('out');
const cfg = window.GZ_CFG;
const seen = new Set();

const now = () => new Date().toISOString().replace('T',' ').replace(/\..+/,'');

function println(x=''){ out.textContent += x + '\n'; }
function hr(){ println(''.padEnd(60,'-')); }

/* ---- fetch helpers via Worker ---- */
async function corsText(url){
  const u = new URL(cfg.corsBase.replace(/\/$/,'') + '/cors');
  u.searchParams.set('url', url);
  const r = await fetch(u.toString(), { cache: 'no-cache' });
  if(!r.ok) throw new Error('CORS '+r.status);
  return r.text();
}

/* ---- parse RSS in browser ---- */
function parseFeed(xmlTxt){
  const doc = new DOMParser().parseFromString(xmlTxt, "application/xml");
  let items = Array.from(doc.querySelectorAll('item'));
  if (!items.length) items = Array.from(doc.querySelectorAll('entry'));
  return items.map(n => ({
    title: (n.querySelector('title')?.textContent || '').trim(),
    link: (n.querySelector('link')?.getAttribute('href') || n.querySelector('link')?.textContent || '').trim(),
    guid: (n.querySelector('guid')?.textContent || n.querySelector('id')?.textContent || '').trim(),
    published: (n.querySelector('pubDate')?.textContent || n.querySelector('updated')?.textContent || '').trim()
  }));
}

/* ---- super-light readability ---- */
function extractReadable(html){
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll('script,style,noscript,iframe,header,footer,nav,form').forEach(e=>e.remove());
  const blocks = [];
  doc.querySelectorAll('article,main,section,p,div,li').forEach(el=>{
    const t=(el.textContent||'').replace(/\s+/g,' ').trim();
    if (t.split(' ').length>=12) blocks.push({t, s:t.length});
  });
  blocks.sort((a,b)=>b.s-a.s);
  return blocks.slice(0,10).map(x=>x.t).join('\n\n') || (doc.body?.innerText||'').trim();
}

/* ---- load lists ---- */
async function loadList(url){
  const r = await fetch(url, { cache:'no-cache' });
  const txt = await r.text();
  return txt.split('\n').map(s=>s.trim()).filter(Boolean);
}

async function generate(meta, text, perspectives){
  const r = await fetch(cfg.corsBase.replace(/\/$/,'') + '/generate', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      meta, text, perspectives,
      min_words: cfg.minWords, max_words: cfg.maxWords
    })
  });
  if(!r.ok) throw new Error('generate '+r.status);
  return r.json();
}

async function processItem(feedUrl, it, perspectives){
  const fp = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([feedUrl,it.guid,it.link,it.title].join('|')));
  const k = Array.from(new Uint8Array(fp)).map(b=>b.toString(16).padStart(2,'0')).join('');
  if (seen.has(k)) return; seen.add(k);

  println(`[${now()}] NEW • ${it.title}`);
  let html = '';
  try { html = await corsText(it.link); }
  catch(e){ println(`  fetch article failed: ${e}`); return; }

  const text = extractReadable(html);
  if (!text || text.split(/\s+/).length < 80){ println('  skipped (too little content)'); return; }

  try {
    const res = await generate({title: it.title, link: it.link, published: it.published, feed: feedUrl}, text, perspectives);
    if (!res.ok) throw new Error('bad response');
    hr();
    println(`TITLE: ${it.title}\nLINK: ${it.link}\nDATE: ${it.published}\nFEED: ${feedUrl}`);
    hr();
    println(res.text.trim());
    hr();
  } catch(e){
    println(`  generate failed: ${e}`);
  }
}

async function pollOnce(){
  const feeds = await loadList(cfg.feedsUrl);
  const persps = await loadList(cfg.perspectivesUrl);
  for (const f of feeds){
    try {
      const xml = await corsText(f);
      const items = parseFeed(xml).slice(0,6);
      for (const it of items){ await processItem(f, it, persps); }
    } catch(e){
      println(`[${now()}] feed error (${f}): ${e}`);
    }
  }
}

(async function init(){
  out.textContent = `GoZaddy ▶ Minimal Live RSS → AI Summaries\n`+
                    `Proxy: ${cfg.corsBase}\n`+
                    `Interval: ${cfg.interval}s\n`;
  hr();
  await pollOnce();
  setInterval(pollOnce, cfg.interval*1000);
})();
