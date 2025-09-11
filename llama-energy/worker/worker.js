export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/eia') {
      const state = url.searchParams.get('state') || 'VA';
      const base = 'https://api.eia.gov/v2/electricity/state-electricity-profiles/source-disposition/data/';
      const params = new URLSearchParams({
        frequency: 'annual',
        'data[0]': 'direct-use',
        'data[1]': 'facility-direct',
        'data[2]': 'independent-power-producers',
        'data[3]': 'estimated-losses',
        'data[4]': 'total-supply',
        'data[5]': 'total-disposition',
        'facets[state][]': state,
        'sort[0][column]': 'period',
        'sort[0][direction]': 'asc',
        api_key: env.EIA_API_KEY
      });
      const resp = await fetch(`${base}?${params}`, { cf: { cacheTtl: 300, cacheEverything: true }});
      if (!resp.ok) return new Response(await resp.text(), { status: resp.status });
      const body = await resp.json();
      const rows = body?.response?.data || [];
      const toNum = (x) => (x==null ? null : Number(x));
      const periods = rows.map(r => r.period);
      const levels = {
        'Direct Use': rows.map(r => toNum(r['direct-use'])),
        'Facility Direct': rows.map(r => toNum(r['facility-direct'])),
        'Independent Power Producers': rows.map(r => toNum(r['independent-power-producers'])),
        'Estimated Losses': rows.map(r => toNum(r['estimated-losses']))
      };
      const supply = rows.map(r => toNum(r['total-supply']) || 0);
      const pct = (arr) => arr.map((v,i)=> supply[i] ? (100*v/supply[i]) : 0);
      const shares = {
        'Direct Use %': pct(levels['Direct Use']),
        'Facility Direct %': pct(levels['Facility Direct']),
        'IPPs %': pct(levels['Independent Power Producers']),
        'Losses %': pct(levels['Estimated Losses'])
      };
      return new Response(JSON.stringify({ periods, levels, shares }, null, 2), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
      });
    }
    return new Response('OK', { status: 200 });
  }
};
