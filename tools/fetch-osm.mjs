
// Fetch real OSM geometry for the Hyderabad BR playfield.
//
// OVERPASS IS UNREACHABLE from this network: /api/interpreter returns 406 at the
// proxy for every method/UA/body combination, and the public mirrors
// (kumi.systems, private.coffee) time out. The official OSM API 0.6 /map
// endpoint DOES work, so this targets that.
//
// /map errors on dense bboxes, so we recurse into quarters until it accepts.
// A per-run request budget stops the recursion running forever on the densest
// tiles, and tiles are cached as trimmed JSON so a killed run resumes.
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] || 'data/raw');
fs.mkdirSync(OUT, { recursive: true });

// Anchored per shared/config.mjs (44 x 36 km playfield).
const LAT0 = 17.4300, LON0 = 78.4900;
const HALF_LAT = 22000 / 111320;                                  // 0.19763
const HALF_LON = 18000 / (111320 * Math.cos(LAT0 * Math.PI / 180)); // 0.16997

// Budget: enough requests to cover dense downtown, finite enough to finish.
const BUDGET = Number(process.env.OSM_BUDGET || 900);
const MAX_DEPTH = 8;
let used = 0;

const KEEP = new Set(['building','building:part','highway','waterway','natural','landuse',
  'leisure','amenity','man_made','historic','railway','barrier','shop','tourism',
  'sport','place','aeroway','power','water','bridge','tunnel','layer','name',
  'height','building:levels','building:material','start_floor','location','surface',
  'building:use','landuse:retail','office','public_transport']);

const UA = 'HydBRWorldBake/0.1 (three.js BR prototype)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchTile(w, s, e, n, depth) {
  if (used >= BUDGET) return;
  const key = `${w.toFixed(5)},${s.toFixed(5)},${e.toFixed(5)},${n.toFixed(5)}`;
  const file = path.join(OUT, `t${key.replace(/[.,-]/g, '_')}.json`);
  if (fs.existsSync(file) && fs.statSync(file).size > 40) return;

  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${w},${s},${e},${n}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (used >= BUDGET) return;
    used++;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180000) });
      if (res.status === 400 || res.status === 509) {          // too dense -> split
        if (depth < MAX_DEPTH) {
          const mw = (w + e) / 2, ms = (s + n) / 2;
          console.log(`  split d${depth}->${depth + 1} ${key}`);
          await fetchTile(w, s, mw, ms, depth + 1);
          await fetchTile(mw, s, e, ms, depth + 1);
          await fetchTile(w, ms, mw, n, depth + 1);
          await fetchTile(mw, ms, e, n, depth + 1);
        } else console.error(`  depth-capped ${key}`);
        return;
      }
      if (res.status === 429 || res.status === 503) { await sleep(10000 * (attempt + 1)); continue; }
      if (!res.ok) { console.error(`  HTTP ${res.status} ${key}`); await sleep(5000); continue; }
      const xml = await res.text();
      const parsed = parseOsm(xml);
      fs.writeFileSync(file, JSON.stringify(parsed));
      console.log(`  ok d${depth} ${String(parsed.length).padStart(4)} ways  req#${used}  ${key}`);
      await sleep(700);
      return;
    } catch (e) { console.error(`  ! ${key} ${e.message.slice(0, 80)}`); await sleep(4000 * (attempt + 1)); }
  }
  if (depth < MAX_DEPTH && used < BUDGET) {
    const mw = (w + e) / 2, ms = (s + n) / 2;
    await fetchTile(w, s, mw, ms, depth + 1); await fetchTile(mw, s, e, ms, depth + 1);
    await fetchTile(w, ms, mw, n, depth + 1);   await fetchTile(mw, ms, e, n, depth + 1);
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
      +(((parseFloat(lon[1]) - LON0) * 111320 * Math.cos(LAT0 * Math.PI / 180))).toFixed(1),
      +(((parseFloat(lat[1]) - LAT0) * 111320)).toFixed(1),
    ]);
  }
  const out = [];
  const wayRe = /<way\b([^>]*?)>([\s\S]*?)<\/way>/g;
  const tagRe = /<tag\s+k="([^"]*)"\s+v="([^"]*)"\s*\/>/g;
  const ndRe = /<nd\s+ref="(\d+)"\s*\/>/g;
  while ((m = wayRe.exec(xml))) {
    const inner = m[2];
    const tags = {};
    let t;
    tagRe.lastIndex = 0;
    while ((t = tagRe.exec(inner))) if (KEEP.has(t[1])) tags[t[1]] = t[2];
    if (!Object.keys(tags).length) continue;
    const pts = [];
    ndRe.lastIndex = 0;
    let nd;
    while ((nd = ndRe.exec(inner))) { const p = nodes.get(nd[1]); if (p) pts.push(p); }
    if (pts.length < 2) continue;
    // Drop absurd polylines (motorway ramps stitched across the map).
    let span = 0;
    for (let i = 1; i < pts.length; i++) span += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
    if (span > 4000) continue;
    let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9,sx=0,sy=0;
    for (const p of pts){minx=Math.min(minx,p[0]);miny=Math.min(miny,p[1]);maxx=Math.max(maxx,p[0]);maxy=Math.max(maxy,p[1]);sx+=p[0];sy+=p[1];}
    out.push({ id: (/id="(\d+)"/.exec(m[1])||[0,'0'])[1], t: tags, g: pts,
               cx: +(sx/pts.length).toFixed(1), cy: +(sy/pts.length).toFixed(1),
               bx: [+minx.toFixed(1), +miny.toFixed(1), +maxx.toFixed(1), +maxy.toFixed(1)] });
  }
  return out;
}

console.log(`playfield lon ${(LON0-HALF_LON).toFixed(4)}..${(LON0+HALF_LON).toFixed(4)}  lat ${(LAT0-HALF_LAT).toFixed(4)}..${(LAT0+HALF_LAT).toFixed(4)}`);
await fetchTile(LON0 - HALF_LON, LAT0 - HALF_LAT, LON0 + HALF_LON, LAT0 + HALF_LAT, 0);
console.log(`FETCH_DONE requests=${used} tiles=${fs.readdirSync(OUT).length}`);
