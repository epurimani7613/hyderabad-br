// Repair the OSM cache: purge degenerate clipped ways, then re-fetch their areas
// at a finer tile size so the buildings come back whole.
//
// OSM's /map endpoint clips a way to the requested bbox. A building that
// straddles a large tile's edge comes back with 1-2 identical points and a
// zero-area footprint. Cached like any other record, it is never retried, and
// the building silently disappears from the game world.
import fs from 'node:fs';
import path from 'node:path';

const RAW = path.resolve('data/raw');
const LAT0 = 17.4300, LON0 = 78.4900;
const MLAT = 111320, MLON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const UA = 'HydBRWorldBake/0.1 (three.js BR prototype)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 1. find degenerate ways ----------
const files = fs.readdirSync(RAW).filter(f => f.endsWith('.json'));
const degenerate = [];
let kept = 0;
for (const f of files) {
  const p = path.join(RAW, f);
  let arr;
  try { arr = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  const good = [];
  for (const w of arr) {
    const wm = Math.abs(w.bx[2] - w.bx[0]), dn = Math.abs(w.bx[3] - w.bx[1]);
    const pts = w.g || [];
    const uniq = new Set(pts.map(q => q[0] + ',' + q[1])).size;
    if (uniq < 2 || (wm < 0.5 && dn < 0.5)) {
      degenerate.push({ id: w.id, x: w.cx, y: w.cy, building: !!w.t.building });
    } else good.push(w);
  }
  kept += good.length;
  fs.writeFileSync(p, JSON.stringify(good));
}
console.log(`purged ${degenerate.length} degenerate ways (${degenerate.length ? '' : 'none'}), kept ${kept}`);

if (!degenerate.length) { console.log('nothing to repair'); process.exit(0); }

// ---------- 2. cluster the lost ways into boxes ----------
const boxes = [];
const CELL = 700;                              // metres
const grid = new Map();
for (const d of degenerate) {
  const k = `${Math.floor(d.x / CELL)},${Math.floor(d.y / CELL)}`;
  if (!grid.has(k)) { const b = { x: [], y: [], n: 0, bldg: 0 }; grid.set(k, b); boxes.push(b); }
  const b = grid.get(k);
  b.x.push(d.x); b.y.push(d.y); b.n++; if (d.building) b.bldg++;
}
// Merge adjacent cells loosely: just fetch each cluster's bbox with padding.
const clusters = [];
for (const b of boxes) {
  const cx0 = Math.min(...b.x), cx1 = Math.max(...b.x);
  const cy0 = Math.min(...b.y), cy1 = Math.max(...b.y);
  clusters.push({
    cx: (cx0 + cx1) / 2, cy: (cy0 + cy1) / 2,
    r: Math.max(200, Math.hypot(cx1 - cx0, cy1 - cy0) / 2 + 150),
    n: b.n, bldg: b.bldg,
  });
}
clusters.sort((a, b) => b.bldg - a.bldg);
console.log(`re-fetching ${clusters.length} clusters, ${degenerate.filter(d => d.building).length} were buildings`);
console.log(`top clusters: ${clusters.slice(0, 5).map(c => `${c.bldg}b/${c.n}w@${c.r | 0}m`).join(' ')}`);

const seen = new Set();
for (const f of fs.readdirSync(RAW).filter(x => x.endsWith('.json'))) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
    if (Array.isArray(a)) for (const w of a) seen.add(w.id);
  } catch { /* ignore */ }
}
console.log(`cache now holds ${seen.size} ids`);

const KEEP = new Set(['building','building:part','highway','waterway','natural','landuse',
  'leisure','amenity','man_made','historic','railway','barrier','shop','tourism',
  'sport','place','aeroway','power','water','bridge','tunnel','layer','name',
  'height','building:levels','building:material','start_floor','location','surface',
  'building:use','office','public_transport']);

function parseOsm(xml) {
  const nodes = new Map();
  let m;
  const nodeRe = /<node\b([^>]*?)>([\s\S]*?)<\/node>|<node\b([^>]*?)\/>/g;
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
    if (pts.length < 3) continue;
    let span = 0;
    for (let i = 1; i < pts.length; i++) span += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (span > 4000 || span < 1.0) continue;
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, sx = 0, sy = 0;
    for (const p of pts) { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); sx += p[0]; sy += p[1]; }
    out.push({ id: (/id="(\d+)"/.exec(m[1]) || [0, '0'])[1], t: tags, g: pts,
               cx: +(sx / pts.length).toFixed(1), cy: +(sy / pts.length).toFixed(1),
               bx: [+minx.toFixed(1), +miny.toFixed(1), +maxx.toFixed(1), +maxy.toFixed(1)] });
  }
  return out;
}

let repaired = 0, requests = 0;
const MAX_REQ = Number(process.env.REPAIR_BUDGET || 400);
for (const c of clusters) {
  if (requests >= MAX_REQ) break;
  const lat = LAT0 + c.cy / MLAT;
  const lon = LON0 + c.cx / MLON;
  // Fetch in 4 quadrants so a straddling way is whole in at least one of them.
  for (let q = 0; q < 4; q++) {
    if (requests >= MAX_REQ) break;
    const sLat = lat - c.r / MLAT / 2 + (q < 2 ? 0 : c.r / MLAT / 2);
    const nLat = sLat + c.r / MLAT;
    const sLon = lon - c.r / MLON / 2 + (q % 2 === 0 ? 0 : c.r / MLON / 2);
    const nLon = sLon + c.r / MLON;
    const key = `${sLon.toFixed(5)}_${sLat.toFixed(5)}_${nLon.toFixed(5)}_${nLat.toFixed(5)}`;
    const file = path.join(RAW, `r${key.replace(/[.,-]/g, '_')}.json`);
    if (fs.existsSync(file) && fs.statSync(file).size > 40) continue;
    requests++;
    try {
      const res = await fetch(`https://api.openstreetmap.org/api/0.6/map?bbox=${sLon},${sLat},${nLon},${nLat}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180000) });
      if (!res.ok) { await sleep(4000); continue; }
      const parsed = parseOsm(await res.text());
      const fresh = parsed.filter(w => !seen.has(w.id));
      for (const w of fresh) seen.add(w.id);
      fs.writeFileSync(file, JSON.stringify(fresh));
      repaired += fresh.length;
      await sleep(700);
    } catch { await sleep(4000); }
  }
}
console.log(`REPAIR_DONE +${repaired} ways in ${requests} requests`);