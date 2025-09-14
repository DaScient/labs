import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { motion } from "framer-motion";
import { Activity, Globe, Radio, Cpu } from "lucide-react";

export default function KnowledgeBoard() {
  const [feeds, setFeeds] = useState([]);
  const [clusters, setClusters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sinceHours, setSinceHours] = useState(12);
  const [limit, setLimit] = useState(18);
  const [topicFilter, setTopicFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [sources, setSources] = useState([]);

  // charts
  const [topicCounts, setTopicCounts] = useState([]);
  const [regionCounts, setRegionCounts] = useState([]);

  async function loadData() {
    setLoading(true);
    try {
      const baseParams = `sinceHours=${sinceHours}&limit=${limit}`;
      const [fRes, cRes, sRes] = await Promise.all([
        fetch(`/api/enrich?${baseParams}`).then((r) => r.json()),
        fetch(`/api/clusters/enriched?${baseParams}`).then((r) => r.json()),
        fetch(`/api/sources`).then((r) => r.json()),
      ]);
      let items = fRes.items || [];
      let cl = cRes || [];

      // client-side filters
      if (topicFilter !== "all") {
        items = items.filter((i) => (i.tags || []).includes(topicFilter));
        cl = cl.filter((c) => (c.tags || []).includes(topicFilter));
      }
      if (sourceFilter !== "all") {
        items = items.filter((i) => i.src === sourceFilter);
        cl = cl.filter((c) => (c.sources || []).includes(sourceFilter));
      }

      setFeeds(items);
      setClusters(cl);
      setSources((sRes || []).map((s) => s.src));

      // aggregate for charts
      const tMap = new Map();
      const gMap = new Map();
      for (const i of items) {
        (i.tags || []).forEach((t) => tMap.set(t, (tMap.get(t) || 0) + 1));
        (i.geos || []).forEach((g) => gMap.set(g, (gMap.get(g) || 0) + 1));
      }
      const tArr = [...tMap.entries()].map(([name, value]) => ({ name, value }))
        .sort((a,b)=>b.value-a.value).slice(0, 12);
      const gArr = [...gMap.entries()].map(([name, value]) => ({ name, value }))
        .sort((a,b)=>b.value-a.value);
      setTopicCounts(tArr);
      setRegionCounts(gArr);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);
  useEffect(() => { loadData(); /* re-query when filters change */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceHours, limit, topicFilter, sourceFilter]);

  return (
    <div className="min-h-screen bg-[#0b0f14] text-[#e9f1f7] p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
      {/* Left: Controls + Analytics */}
      <div className="space-y-6 order-1 xl:order-none">
        <Card className="bg-[#121821] border border-[#1f2a36]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[#5ec6ff]" /> Controls
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1 text-[#7a90a1]">Since (hrs)</label>
                <input type="number" min={2} max={72} value={sinceHours}
                  onChange={(e)=>setSinceHours(parseInt(e.target.value||"12"))}
                  className="w-full bg-[#0e141b] border border-[#1f2a36] rounded-xl px-3 py-2" />
              </div>
              <div>
                <label className="block mb-1 text-[#7a90a1]">Limit</label>
                <input type="number" min={6} max={60} value={limit}
                  onChange={(e)=>setLimit(parseInt(e.target.value||"18"))}
                  className="w-full bg-[#0e141b] border border-[#1f2a36] rounded-xl px-3 py-2" />
              </div>
              <div className="col-span-2">
                <label className="block mb-1 text-[#7a90a1]">Topic</label>
                <select value={topicFilter} onChange={(e)=>setTopicFilter(e.target.value)}
                  className="w-full bg-[#0e141b] border border-[#1f2a36] rounded-xl px-3 py-2">
                  <option value="all">All</option>
                  {[...new Set(topicCounts.map(t=>t.name))].sort().map((t)=>(
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block mb-1 text-[#7a90a1]">Source</label>
                <select value={sourceFilter} onChange={(e)=>setSourceFilter(e.target.value)}
                  className="w-full bg-[#0e141b] border border-[#1f2a36] rounded-xl px-3 py-2">
                  <option value="all">All</option>
                  {sources.sort().map((s)=>(<option key={s} value={s}>{s}</option>))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-[#5ec6ff] text-[#5ec6ff] hover:bg-[#0e141b]"
                onClick={loadData}
              >
                Refresh
              </Button>
              {loading && <span className="text-[#7a90a1]">Loading…</span>}
            </div>
          </CardContent>
        </Card>

        {/* Analytics cards with charts */}
        <Charts topicCounts={topicCounts} regionCounts={regionCounts} />

        <Card className="bg-[#121821] border border-[#1f2a36]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#5ec6ff]" /> Live Feed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <a href="https://www.youtube.com/aljazeeraenglish/live" target="_blank" rel="noreferrer" className="text-[#5ec6ff] text-sm hover:underline">Al Jazeera English</a>
          </CardContent>
        </Card>
      </div>

      {/* Middle: Enriched Feed wall */}
      <div className="col-span-1 xl:col-span-2 space-y-4">
        <motion.h1 className="text-2xl font-bold tracking-tight" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          🌐 Worldwide Intel Board
        </motion.h1>
        <ScrollArea className="h-[80vh] pr-2">
          <div className="grid gap-4 md:grid-cols-2">
            {feeds.map((item, idx) => (
              <motion.div key={idx} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.03 }}>
                <Card className="bg-[#121821] border border-[#1f2a36]">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Globe className="w-4 h-4 text-[#5ec6ff]" />
                      <span className="truncate">{item.src} — {item.lang?.toUpperCase() || "EN"}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <a href={item.link} target="_blank" rel="noreferrer" className="font-semibold mb-2 block hover:underline">
                      {item.title}
                    </a>
                    {item.summary && (
                      <p className="text-sm text-[#7a90a1] mb-2">{item.summary}</p>
                    )}
                    <div className="flex flex-wrap gap-2 text-xs">
                      {item.tags?.slice(0,6).map((t, i) => (
                        <span key={i} className="bg-[#1f2a36] text-[#5ec6ff] px-2 py-0.5 rounded-full">{t}</span>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </ScrollArea>

        {/* Clusters summary */}
        <Card className="bg-[#121821] border border-[#1f2a36]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-[#5ec6ff]" /> Clusters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              {clusters.map((c, idx) => (
                <motion.div key={idx} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: idx * 0.05 }}>
                  <div className="mb-2">
                    <p className="font-semibold text-sm line-clamp-2">{c.items[0]?.title}</p>
                    <p className="text-xs text-[#7a90a1]">Sources: {c.sources.join(", ")} | Tags: {c.tags.join(", ")}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// --- Charts component (using recharts) ---
import { PieChart, Pie, Cell, Tooltip as RTooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";

function Charts({ topicCounts, regionCounts }){
  return (
    <Card className="bg-[#121821] border border-[#1f2a36]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Activity className="w-4 h-4 text-[#5ec6ff]" /> Analytics</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6">
          <div className="h-56">
            <p className="text-xs text-[#7a90a1] mb-2">Regions (last window)</p>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={regionCounts} dataKey="value" nameKey="name" outerRadius={80}>
                  {regionCounts.map((_, idx) => (<Cell key={idx} />))}
                </Pie>
                <RTooltip formatter={(v)=>[v, "Count"]} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="h-60">
            <p className="text-xs text-[#7a90a1] mb-2">Top Topics</p>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topicCounts}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" hide={false} tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={50} />
                <YAxis />
                <RTooltip />
                <Bar dataKey="value" fillOpacity={0.9} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
