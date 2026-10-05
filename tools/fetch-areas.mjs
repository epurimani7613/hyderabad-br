// Targeted OSM fetch for regions the main sweep missed.
//
// The main fetch walks the playfield depth-first and exhausts its request
// budget on whichever region it hits first. On this map that meant it filled
// the south (lat 17.20-17.47) and stopped, leaving the north - including
// Charminar at 17.6144 and HITEC City - completely empty.
//
// This fetcher works from an explicit priority list of areas (landmark first),
// so the parts that actually matter are guaranteed to be covered even under a
// tight budget. Same endpoint, same recursive splitting, disk cache.
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] || 'data/raw');
fs.mkdirSync(OUT, { recursive: true });

// Priority areas. Each gets its own budget so one dense area cannot starve
// the next. Ordered by importance to the game.
const AREAS = [
  // [name, lat, lon, radiusMetres, budget]
  { name: 'charminar',  lat: 17.6144, lon: 78.4747, r: 2600, budget: 150 },
  { name: 'hitec',     lat: 17.4435, lon: 78.4690, r: 2600, budget: 150 },
  { name: 'assembly',  lat: 17.4740, lon: 78.4700, r: 1800, budget: 60 },
  { name: 'durgam',    lat: 17.3380, lon: 78.4400, r: 2600, budget: 90 },
  { name: 'kbr',       lat: 17.4125, lon: 78.4710, r: 1800, budget: 60 },
  { name: 'northband', lat: 17.5300, lon: 78.4900, r: 6000, budget: 120 },
  { name: 'sainikpuri',lat: 17.4400, lon: 78.4900, r: 2200, budget: 60 },
  { name: 'secunder',  lat: 17.4398, lon: 78.4983, r: 2000, budget: 60 },
  { name: 'begumpet',  lat: 17.4230, lon: 78.4660, r: 1800, budget: 50 },
  { name: 'mehdipatnam', lat: 17.4150, lon: 78.5100, r: 2000, budget: 50 },
  { name: 'kukatpally',lat: 17.4430, lon: 78.4130, r: 2200, budget: 60 },
  { name: 'gachibowli',lat: 17.4400, lon: 78.3480, r: 2200, budget: 60 },
  { name: 'uppal',     lat: 17.4020, lon: 78.5600, r: 2000, budget: 50 },
];

const LAT0 = 17.4300, LON0 = 78.4900;
const MLAT = 111320;
const MLON = 111320 * Math.cos(LAT0 * Math.PI / 180);

const KEEP = new Set(['building','building:part','highway','waterway','natural','landuse',
  'leisure','amenity','man_made','historic','railway','barrier','shop','tourism',
  'sport','place','aeroway','power','water','bridge','tunnel','layer','name',
  'height','building:levels','building:material','start_floor','location','surface',
  'building:use','office','public_transport']);

const UA = 'HydBRWorldBake/0.1 (three.js BR prototype)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_DEPTH = 8;

const stats = { requests: 0, newWays: 0, areas: {} };

// Track way ids already in the cache so we never write a duplicate tile.
const seenIds = new Set();
for (const f of fs.readdirSync(OUT).filter(x => x.endsWith('.json'))) {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    if (Array.isArray(arr)) for (const w of arr) seenIds.add(w.id);
  } catch { /* partial tile */ }
}
console.log(`cache already holds ${seenIds.size} way ids`);

async function fetchTile(w, s, e, n, depth, budget) {
  if (budget.used >= budget.max) return;
  const key = `${w.toFixed(5)},${s.toFixed(5)},${e.toFixed(5)},${n.toFixed(5)}`;
  const file = path.join(OUT, `a${key.replace(/[.,-]/g, '_')}.json`);
  if (fs.existsSync(file) && fs.statSync(file).size > 40) return;

  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${w},${s},${e},${n}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (budget.used >= budget.max) return;
    budget.used++; stats.requests++;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180000) });
      if (res.status === 400 || res.status === 509) {
        if (depth < MAX_DEPTH) {
          const mw = (w + e) / 2, ms = (s + n) / 2;
          await fetchTile(w, s, mw, ms, depth + 1, budget);
          await fetchTile(mw, s, e, ms, depth + 1, budget);
          await fetchTile(w, ms, mw, n, depth + 1, budget);
          await fetchTile(mw, ms, e, n, depth + 1, budget);
        }
        return;
      }
      if (res.status === 429 || res.status === 503) { await sleep(9000 * (attempt + 1)); continue; }
      if (!res.ok) { await sleep(5000); continue; }

      const parsed = parseOsm(await res.text());
      // Drop ways already cached: the overlapping main sweep produced 730
      // duplicate records, and duplicated geometry means doubled collision.
      const fresh = parsed.filter(w2 => !seenIds.has(w2.id));
      for (const w2 of fresh) seenIds.add(w2.id);
      fs.writeFileSync(file, JSON.stringify(fresh));
      stats.newWays += fresh.length;
      console.log(`  ok d${depth} ${String(parsed.length).padStart(4)} ways (${fresh.length} new)  ${key}`);
      await sleep(700);
      return;
    } catch (e) {
      await sleep(4000 * (attempt + 1));
    }
  }
}

function parseOsm(xml) {
  const nodes = new Map();
  const nodeRe = /<node\b([^>]*?)>([\s\S]*?)<\/node>|<node\b([^>]*?)\/>/g;
  let m;
  while ((m = nodeRe.exec(xml))) {
    const a = m[1] || m[3] || '';
    const id = /id="(\d+)"/.exec(a), lat = /lat="([-\d.]+)"/.exec(a), lon = /lon="([-\d.]+)"/.exec(a);
    if (!id || !lat || !lon) continue;
    nodes.set(id[1], [
      +(((parseFloat(lon[1]) - LON0) * MLON)).toFixed(1),
      +(((parseFloat(lat[1]) - LAT0) * MLAT)).toFixed(1),
    ]);
  }
  const out = [];
  const wayRe = /<way\b([^>]*?)>([\s\S]*?)<\/way>/g;
  const tagRe = /<tag\s+k="([^"]*)"\s+v="([^"]*)"\s*\/>/g;
  const ndRe = /<nd\s+ref="(\d+)"\s*\/>/g;
  while ((m = wayRe.exec(xml))) {
    const inner = m[2];
    const tags = {};
    let t; tagRe.lastIndex = 0;
    while ((t = tagRe.exec(inner))) if (KEEP.has(t[1])) tags[t[1]] = t[2];
    if (!Object.keys(tags).length) continue;
    const pts = [];
    ndRe.lastIndex = 0;
    let nd;
    while ((nd = ndRe.exec(inner))) { const p = nodes.get(nd[1]); if (p) pts.push(p); }
    if (pts.length < 2) continue;
    let span = 0;
    for (let i = 1; i < pts.length; i++) span += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (span > 4000) continue;
    // Reject degenerate ways at PARSE time, not at bake time.
      //
      // OSM's /map endpoint clips a way to the requested bbox and returns only the
      // nodes inside it. When a tile is large, a building straddling the edge comes
      // back with 1-2 identical points and a zero-area bbox. Those records are
      // cached like any other, so the building silently vanishes from the world and
      // is never retried - 989 buildings were lost this way.
      //
      // Dropping them here means the next fetch pass re-requests the area at a finer
      // granularity, where the clipped way comes back whole.
      if (pts.length < 3) return;
      let span2 = 0;
      for (let i = 1; i < pts.length; i++) span2 += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (span2 < 1.0) return;                        // all points collapsed
      const wmm = Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]));
      const dnn = Math.max(...pts.map(p => p[1])) - Math.min(...pts.map(p => p[1]));
      if (wmm < 0.5 && dnn < 0.5) return;            // sub-half-metre footprint

      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, sx = 0, sy = 0;
      for (const p of pts) { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); sx += p[0]; sy += p[1]; }
      out.push({ id: (/id="(\d+)"/.exec(m[1]) || [0, '0'])[1], t: tags, g: pts,
                 cx: +(sx / pts.length).toFixed(1), cy: +(sy / pts.length).toFixed(1),
                 bx: [+minx.toFixed(1), +miny.toFixed(1), +maxx.toFixed(1), +maxy.toFixed(1)] });
      }
      return out;
    }

for (const area of AREAS) {
  const dLat = area.r / MLAT, dLon = area.r / MLON;
  const budget = { used: 0, max: area.budget };
  const before = stats.newWays;
  console.log(`\n== ${area.name} (${area.lat},${area.lon}) r=${area.r}m budget=${area.budget}`);
  await fetchTile(area.lon - dLon, area.lat - dLat, area.lon + dLon, area.lat + dLat, 0, budget);
  stats.areas[area.name] = stats.newWays - before;
  console.log(`   -> +${stats.areas[area.name]} new ways (used ${budget.used}/${area.budget})`);
}

console.log('\nFETCH_DONE ' + JSON.stringify(stats));