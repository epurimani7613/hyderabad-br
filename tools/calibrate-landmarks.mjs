// The landmark anchors in shared/config.mjs point at coordinates that do not
// match where the cached OSM buildings actually are (HITEC was ~2.2 km off).
// Recompute each anchor from the data: centroid of building-tagged ways within
// a radius of the configured point.
import fs from 'node:fs';
import path from 'node:path';
import { LAT0, LON0, LANDMARKS, MAP_W, MAP_H } from '../shared/config.mjs';
import { lonLatToM } from '../shared/geometry.mjs';

const MLAT = 111320, MLON = 111320 * Math.cos(LAT0 * Math.PI / 180);

const dir = 'data/raw';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const byId = new Map();
for (const f of files) {
  let a; try { a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(a)) continue;
  for (const w of a) if (!byId.has(w.id)) byId.set(w.id, w);
}
const ways = [...byId.values()].filter(w => w.t && w.t.building);
console.log('building ways in cache:', ways.length);

const out = {};
for (const [key, cfg] of Object.entries(LANDMARKS)) {
  const [ox, oy] = lonLatToM(cfg.lon, cfg.lat);
  const R = cfg.radius * 1.6;
  const near = ways.filter(w => Math.hypot(w.cx - ox, w.cy - oy) < R);
  if (near.length < 8) {
    // Widen until we have something to centroid.
    let wide = near, rr = R;
    while (wide.length < 8 && rr < 20000) { rr *= 1.5; wide = ways.filter(w => Math.hypot(w.cx - ox, w.cy - oy) < rr); }
    near.length; // keep
    var used = wide;
  } else var used = near;

  const cx = used.reduce((s, w) => s + w.cx, 0) / used.length;
  const cy = used.reduce((s, w) => s + w.cy, 0) / used.length;
  const lat = LAT0 + cy / MLAT;
  const lon = LON0 + cx / MLON;
  const off = Math.hypot(cx - ox, cy - oy);
  // Radius that actually contains most of these buildings.
  const radii = used.map(w => Math.hypot(w.cx - cx, w.cy - cy)).sort((a, b) => a - b);
  const r90 = radii[Math.floor(radii.length * 0.9)] || cfg.radius;

  out[key] = { lat: +lat.toFixed(5), lon: +lon.toFixed(5), radius: Math.round(Math.max(400, r90)) };
  console.log(`  ${key.padEnd(11)} cfg=(${cfg.lat},${cfg.lon}) r=${cfg.radius}`);
  console.log(`  ${''.padEnd(11)} actual centroid=(${lat.toFixed(5)},${lon.toFixed(5)}) n=${used.length} offset=${off.toFixed(0)}m r90=${r90.toFixed(0)}m`);
}

console.log('\n--- paste into shared/config.mjs LANDMARKS ---');
for (const [k, v] of Object.entries(out)) {
  console.log(`  ${k}: { lat: ${v.lat}, lon: ${v.lon}, radius: ${v.radius} },`);
}