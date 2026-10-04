
// Turn raw OSM ways into the compact binary-ish world the client and server both
// load: collision boxes, a heightmap, road/water ribbons, loot spawns, and the
// three hero landmarks. Run once; output is committed and loaded at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { LAT0, LON0, MAP_W, MAP_H, LANDMARKS, WEAPONS, MEDS, P } from '../shared/config.mjs';
import { lonLatToM, clamp, HALF_X, HALF_Y } from '../shared/geometry.mjs';
import { mulberry32, hashStr } from '../shared/rng.mjs';

const RAW = path.resolve(process.argv[2] || 'data/raw');
const OUTDIR = path.resolve(process.argv[3] || 'data/baked');
fs.mkdirSync(OUTDIR, { recursive: true });

// ---------- 1. load raw ----------
const files = fs.readdirSync(RAW).filter(f => f.startsWith('t') && f.endsWith('.json'));
let ways = [];
for (const f of files) {
  try { ways = ways.concat(JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'))); } catch { /* partial tile */ }
}
console.log(`loaded ${ways.length} ways from ${files.length} tiles`);

// landmark positions in map metres
const LM = {};
for (const [k, v] of Object.entries(LANDMARKS)) {
  const [x, y] = lonLatToM(v.lon, v.lat);
  LM[k] = { ...v, x: +x.toFixed(1), y: +y.toFixed(1) };
}
const inside = (x, y) => Math.abs(x) <= HALF_X && Math.abs(y) <= HALF_Y;

// ---------- 2. heightmap ----------
// Hyderabad is Deccan plateau: gently rolling, ~540m ASL, rocky ridges to the
// west (Hesarayathams/Araku) and the lake basin in the south-west. Synthesise a
// plausible surface deterministically; real DEM (SRTM) is out of reach of the
// OSM /map endpoint, so this is heightfield-from-scratch, NOT surveyed terrain.
const G = 192;                                  // heightmap cells per axis
const hm = new Float32Array(G * G);
// 1D lerp for the noise octave (the 2D bilinear helper below is 4-arg).
const mix = (a, b, t) => a + (b - a) * t;
function lerp2(ax, ay, bx, by, t) { return ax + (bx - ax) * t; }
for (let j = 0; j < G; j++) {
  for (let i = 0; i < G; i++) {
    const u = i / (G - 1), v = j / (G - 1);
    const x = (u - 0.5) * MAP_W, y = (v - 0.5) * MAP_H;
    // ridged multifractal-ish fBm from a fixed lattice of value noise
    let h = 0, amp = 1, freq = 1 / 5200, norm = 0;
    for (let o = 0; o < 5; o++) {
      const nx = x * freq, ny = y * freq;
      const ix = Math.floor(nx), iy = Math.floor(ny);
      const fx = nx - ix, fy = ny - iy;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const n00 = hashNoise(ix, iy), n10 = hashNoise(ix + 1, iy);
      const n01 = hashNoise(ix, iy + 1), n11 = hashNoise(ix + 1, iy + 1);
      h += mix(mix(n00, n10, sx), mix(n01, n11, sx), sy) * amp;
      norm += amp; amp *= 0.5; freq *= 2.07;
    }
    // Keep the unit noise scaled independently of the metre-valued terrain
    // terms. Folding them together once multiplied a 210 m hill by the noise
    // scale factor and produced 9.6 km mountains.
    const base = (h / norm) * 46;              // ~0..46 m of rolling relief
    const westness = clamp((1 - (x + HALF_X) / MAP_W) * 1.35, 0, 1);
    const hills = Math.pow(westness, 1.8) * 210;
    const dl = Math.hypot(x - LM.durgam.x, y - LM.durgam.y);
    const basin = Math.max(0, 1 - dl / 5200) * 95;
    const riverX = LM.charminar.x + Math.sin(y / 5200) * 900;
    const river = Math.max(0, 1 - Math.abs(x - riverX) / 420) * 16;
    // Deccan plateau: ~540 m ASL, hills west, lake basin south-west.
    hm[j * G + i] = 540 + base + hills - basin - river;
  }
}
function hashNoise(ix, iy) {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function terrainH(x, y) {
  const u = clamp((x / MAP_W + 0.5) * (G - 1), 0, G - 1.001);
  const v = clamp((y / MAP_H + 0.5) * (G - 1), 0, G - 1.001);
  const i = Math.floor(u), j = Math.floor(v);
  const fx = u - i, fy = v - j;
  const a = hm[j * G + i], b = hm[j * G + i + 1];
  const c = hm[(j + 1) * G + i], d = hm[(j + 1) * G + i + 1];
  // Bilinear sample using the 3-arg mix. (lerp2 here is the 4-arg
  // (ax,ay,bx,by,t) helper; calling it with 3 args silently returns NaN, which
  // nulled every building height and made the whole city invisible.)
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
}
console.log(`heightmap ${G}x${G} built, range ${Math.min(...hm).toFixed(0)}..${Math.max(...hm).toFixed(0)}m`);

// ---------- 3. classify OSM ways into renderable/collidable primitives ----------
const HIGHWAY_KIND = (hw) => {
  const k = hw.split(';').pop();
  if (/motorway|trunk/.test(k)) return { cls: 'motorway', lanes: 5, mat: 'asphalt', speed: 1 };
  if (/primary/.test(k)) return { cls: 'primary', lanes: 3, mat: 'asphalt', speed: 0.95 };
  if (/secondary/.test(k)) return { cls: 'secondary', lanes: 2, mat: 'asphalt', speed: 0.9 };
  if (/tertiary/.test(k)) return { cls: 'tertiary', lanes: 2, mat: 'concrete', speed: 0.85 };
  if (/residential|unclassified|living_street/.test(k)) return { cls: 'street', lanes: 1, mat: 'asphalt', speed: 0.7 };
  if (/service/.test(k)) return { cls: 'service', lanes: 1, mat: 'concrete', speed: 0.6 };
  if (/footway|pedestrian|path|steps|track|cycleway/.test(k)) return { cls: 'path', lanes: 0, mat: 'dirt', speed: 0.4 };
  return null;
};

const boxes = [];       // collision volumes
const roads = [];       // renderable ribbons
const waters = [];      // polygons
const walls = [];       // boundary walls / fences / hedges
const props = [];       // small decor

let bId = 0;
function pushBox(b) { b.id = bId++; boxes.push(b); return b; }

// Buildings: extrude footprint. Height from building:levels / height tag,
// with a zone-aware bias (HITEC towers, Charminar low-rise).
function buildingHeight(t, x, y) {
  if (t.height) {
    const m = /^(\d+(?:\.\d+)?)\s*m/.exec(t.height);
    if (m) return clamp(parseFloat(m[1]), 2.5, 220);
  }
  let lv = parseFloat(t['building:levels'] || t.start_floor || 0);
  if (!lv) {
    // OSM often omits levels; infer from footprint + zone.
    const area = (t._bx[2] - t._bx[0]) * (t._bx[3] - t._bx[1]);
    lv = area > 4000 ? 6 : area > 1200 ? 3 : area > 300 ? 2 : 1;
  }
  let h = lv * 3.35 + 0.6;
  // HITEC: glass towers are the vertical combat core.
  const dHitec = Math.hypot(x - LM.hitec.x, y - LM.hitec.y);
  if (dHitec < LM.hitec.radius) {
    const t01 = 1 - dHitec / LM.hitec.radius;
    if (areaOf(t) > 2500) h = Math.max(h, lerp(20, 165, t01 * t01) * (0.7 + 0.6 * hash01(x, y)));
  }
  // Old city: tight, low, chaotic.
  const dOld = Math.hypot(x - LM.charminar.x, y - LM.charminar.y);
  if (dOld < 1600) h = Math.min(h, 4 + hash01(x, y) * 7);
  return clamp(h, 2.4, 200);
}
function areaOf(t) { return (t._bx[2] - t._bx[0]) * (t._bx[3] - t._bx[1]); }
function hash01(x, y) { let n = Math.imul(Math.round(x * 7) | 0, 374761393) + Math.imul(Math.round(y * 7) | 0, 668265263); n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967295; }

let bCount = 0, rCount = 0, wCount = 0, wallCount = 0;
for (const w of ways) {
  const t = w.t;
  t._bx = w.bx;
  // The fetch parser emits centroids as `cx`/`cy`, NOT `x`/`y`. Reading the wrong
  // key silently produced boxes with undefined centres, which JSON then wrote
  // out as a missing field — every building rendered nowhere and collided with
  // nothing, while the build still "succeeded".
  const cx = w.cx ?? w.x;
  const cy = w.cy ?? w.y;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
    console.error(`skipping way ${w.id}: no centroid`);
    continue;
  }

  // --- water ---
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.waterway === 'river' || t.waterway === 'canal') {
    waters.push({ g: w.g, kind: t.waterway === 'river' ? 'river' : 'lake' });
    wCount++; continue;
  }
  if (t.waterway) { // streams are too thin to matter as water bodies
    walls.push({ g: w.g, kind: 'stream' }); continue;
  }
  // --- roads ---
  if (t.highway) {
    const k = HIGHWAY_KIND(t.highway);
    if (k) { roads.push({ g: w.g, ...k, bridge: t.bridge === 'yes', layer: parseInt(t.layer || 0), oneway: t.oneway === 'yes', name: t.name || '' }); rCount++; }
    continue;
  }
  // --- buildings ---
  if (t.building || t['building:part']) {
    const [x0, y0, x1, y1] = w.bx;
    const wm = (x1 - x0), dn = (y1 - y0);
    if (wm < 1.2 || dn < 1.2) continue;
    if (wm > 900 || dn > 900) continue;           // bogus giant footprints
    const h = buildingHeight(t, cx, cy);
    // Collision box (axis-aligned, footprint-bounded). Plus a collision AABB for
    // the top deck so players can stand on it.
    const ground = terrainH(cx, cy);
    const mat = /glass|concrete|steel/i.test(t['building:material'] || '') ? 'concrete'
      : /wood/i.test(t['building:material'] || '') ? 'wood'
      : (t.building === 'yes' || !t.building) ? 'concrete' : 'brick';
    const bx = { x: cx, y: cy, r: wm / 2, ry: dn / 2, base: ground - 1.5, top: ground + h, solid: true, mat, bldg: true };
    pushBox(bx);
    if (h > 6) {
      // Multi-storey: add one intermediate deck box so interior fights have floors.
      pushBox({ ...bx, base: ground + Math.floor(h / 2), top: ground + Math.floor(h / 2) + 0.3, mat: 'wood', deck: true });
    }
    bCount++; continue;
  }
  // --- walls / fences / hedges ---
  if (t.barrier && /^(wall|fence|hedge)$/.test(t.barrier)) {
    walls.push({ g: w.g, kind: t.barrier, mat: t.barrier === 'wall' ? 'stone' : 'wood' });
    wallCount++; continue;
  }
}
console.log(`classified: buildings=${bCount} roads=${rCount} water=${wCount} walls=${wallCount} boxes=${boxes.length}`);

// ---------- 4. hero landmarks (hand-modelled, procedural geometry) ----------
const landmarks = [];
function addLandmark(o) { landmarks.push(o); return o; }

// CHARMINAR: 4 monumental arches + 4 minarets, stone, 56m to finial.
{
  const z0 = terrainH(LM.charminar.x, LM.charminar.y);
  addLandmark({
    kind: 'charminar', x: LM.charminar.x, y: LM.charminar.y, z: z0,
    size: 30, height: 56, minaretH: 48, minaretR: 4.2,
  });
  // The four gateways are real collidable masses; arcade blocks between them.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const gx = LM.charminar.x + Math.cos(a) * 15, gy = LM.charminar.y + Math.sin(a) * 15;
    pushBox({ x: gx, y: gy, r: 4.5, ry: 4.5, base: z0 - 1, top: z0 + 22, solid: true, mat: 'stone', landmark: 'charminar' });
  }
}
// HITEC: signature Cyber Towers pair + plaza.
{
  const z0 = terrainH(LM.hitec.x, LM.hitec.y);
  addLandmark({ kind: 'hitec_towers', x: LM.hitec.x - 120, y: LM.hitec.y + 60, z: z0, h: 120, r: 16 });
  addLandmark({ kind: 'hitec_towers', x: LM.hitec.x + 130, y: LM.hitec.y - 40, z: z0, h: 96, r: 14 });
  pushBox({ x: LM.hitec.x - 120, y: LM.hitec.y + 60, r: 16, ry: 16, base: z0 - 1, top: z0 + 120, solid: true, mat: 'glass', landmark: 'hitec' });
  pushBox({ x: LM.hitec.x + 130, y: LM.hitec.y - 40, r: 14, ry: 14, base: z0 - 1, top: z0 + 96, solid: true, mat: 'glass', landmark: 'hitec' });
  // Multi-level parking structure — stacked decks, drivable-ish vertical core.
  const px = LM.hitec.x + 40, py = LM.hitec.y - 260;
  for (let lvl = 0; lvl < 5; lvl++) pushBox({ x: px, y: py, r: 30, ry: 22, base: z0 + lvl * 4.2, top: z0 + lvl * 4.2 + 0.4, solid: true, mat: 'concrete', deck: true, landmark: 'parking' });
  for (const [ox, oy] of [[-28,-20],[28,-20],[-28,20],[28,20]]) pushBox({ x: px+ox, y: py+oy, r: 2, ry: 2, base: z0-1, top: z0+21, solid: true, mat: 'concrete', landmark: 'parking' });
  addLandmark({ kind: 'parking', x: px, y: py, z: z0, levels: 5 });
}
// DURGAM CHERUVU: cable bridge across the lake + rocky rim + boardwalks.
{
  const z0 = terrainH(LM.durgam.x, LM.durgam.y);
  const span = 420;                                  // bridge length across water
  const ang = 0.6;
  const bx = LM.durgam.x, by = LM.durgam.y;
  addLandmark({ kind: 'cable_bridge', x: bx, y: by, z: z0, span, angle: ang, deckW: 6, towerH: 62 });
  // Deck: walkable collider so players can run across it.
  pushBox({ x: bx, y: by, r: span / 2, ry: 4, base: z0 + 26, top: z0 + 26.4, solid: true, mat: 'metal', bridge: true, angle: ang });
  // Boardwalks around the shoreline (thin walkways).
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    addLandmark({ kind: 'boardwalk', x: bx + Math.cos(a) * 380, y: by + Math.sin(a) * 380, z: z0, angle: a + Math.PI / 2, len: 60 });
  }
  // Rocky rim boulders as cover.
  for (let i = 0; i < 26; i++) {
    const a = hash01(i, 7) * Math.PI * 2, r = 420 + hash01(i, 9) * 900;
    const rx = bx + Math.cos(a) * r, ry = by + Math.sin(a) * r;
    pushBox({ x: rx, y: ry, r: 3 + hash01(i, 3) * 7, base: terrainH(rx, ry) - 1, top: terrainH(rx, ry) + 2 + hash01(i, 4) * 5, solid: true, mat: 'stone' });
  }
}
console.log(`landmarks built: ${landmarks.length}, total boxes ${boxes.length}`);

// Fail loudly rather than shipping an empty world. A missing coordinate or a
// non-finite height serialises to a missing field / null in JSON and makes the
// structure both invisible and non-colliding, with no error anywhere.
{
  let bad = 0;
  for (const b of boxes) {
    if (![b.x, b.y, b.base, b.top, b.r].every(Number.isFinite)) {
      if (bad < 3) console.error('bad box:', JSON.stringify(b));
      bad++;
    }
  }
  if (bad) throw new Error(`${bad}/${boxes.length} collision boxes have non-finite geometry - refusing to bake`);
  let badLm = 0;
  for (const l of landmarks) if (![l.x, l.y, l.z].every(Number.isFinite)) badLm++;
  if (badLm) throw new Error(`${badLm}/${landmarks.length} landmarks have non-finite positions - refusing to bake`);
}

// ---------- 5. loot spawns ----------
const WEAPON_POOL = [
  ...Object.keys(WEAPONS).map(w => ({ k: 'w', n: w, w: 1 })),
];
// Weight rare weapons down; give the old city shotgun/SMG flavour.
function rollWeapon(rnd, x, y) {
  const zone = zoneAt(x, y);
  let pool;
  if (zone === 'charminar') pool = [['M870',3],['MP5',3],['UMP45',3],['AKM',2],['SCAR-L',2],['VECTOR',1],['M416',1]];
  else if (zone === 'hitec') pool = [['M416',3],['SCAR-L',3],['AKM',2],['SKS',2],['DP28',2],['KAR98K',1],['M870',1]];
  else if (zone === 'durgam') pool = [['M870',3],['SKS',2],['AKM',2],['MP5',2],['UMP45',1],['KAR98K',1]];
  else pool = [['AKM',3],['M416',2],['SCAR-L',2],['MP5',2],['UMP45',2],['SKS',1],['M870',1]];
  const total = pool.reduce((s, [, wt]) => s + wt, 0);
  let r = rnd() * total;
  for (const [name, wt] of pool) { r -= wt; if (r <= 0) return name; }
  return pool[0][0];
}
function zoneAt(x, y) {
  let best = null, bd = 1e9;
  for (const [k, l] of Object.entries(LM)) { const d = Math.hypot(x - l.x, y - l.y); if (d < bd) { bd = d; best = k; } }
  return bd < (LM[best]?.radius ?? 1200) ? best : 'wild';
}
function rollItem(rnd, x, y) {
  const r = rnd();
  const tierBoost = rnd();
  if (r < 0.34) return { k: 'weapon', n: rollWeapon(rnd, x, y) };
  if (r < 0.44) return { k: 'ammo', n: WEAPONS[rollWeapon(rnd, x, y)].ammo, q: 30 };
  if (r < 0.58) { const l = tierBoost < 0.55 ? 1 : tierBoost < 0.85 ? 2 : 3; return { k: 'armor', n: 'vest', lvl: l }; }
  if (r < 0.66) { const l = tierBoost < 0.55 ? 1 : tierBoost < 0.85 ? 2 : 3; return { k: 'armor', n: 'helmet', lvl: l }; }
  if (r < 0.76) return { k: 'med', n: 'bandage', q: 3 };
  if (r < 0.83) return { k: 'med', n: 'firstaid', q: 1 };
  if (r < 0.87) return { k: 'med', n: 'medkit', q: 1 };
  if (r < 0.94) return { k: 'med', n: 'energy', q: 2 };
  return { k: 'med', n: 'painkill', q: 1 };
}

const loot = [];
// Dense in structures and landmarks, sparse in the wild.
const buildingSites = boxes.filter(b => b.bldg).map(b => ({ x: b.x, y: b.y }));
const rnd = mulberry32(0xC0FFEE);
const nStruct = Math.min(buildingSites.length, 2400);
for (let i = 0; i < nStruct; i++) {
  const s = buildingSites[Math.floor(rnd() * buildingSites.length)];
  loot.push({ x: +(s.x + (rnd() - 0.5) * 20).toFixed(1), y: +(s.y + (rnd() - 0.5) * 20).toFixed(1), z: +(terrainH(s.x, s.y) + 0.4).toFixed(1), ...rollItem(rnd, s.x, s.y), id: loot.length });
}
// Landmark floors (the vertical fight loot).
for (const [k, l] of Object.entries(LM)) {
  const count = k === 'hitec' ? 90 : k === 'charminar' ? 70 : 55;
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2, rr = rnd() * l.radius * 0.8;
    const x = l.x + Math.cos(a) * rr, y = l.y + Math.sin(a) * rr;
    const lvl = rnd() < 0.5 ? 0 : Math.floor(rnd() * 6) * 4.2;
    loot.push({ x: +x.toFixed(1), y: +y.toFixed(1), z: +(terrainH(x, y) + lvl + 0.4).toFixed(1), ...rollItem(rnd, x, y), id: loot.length });
  }
}
// Wildland sprinkle (rural clusters along roads).
for (let i = 0; i < 500; i++) {
  const x = (rnd() - 0.5) * MAP_W * 0.94, y = (rnd() - 0.5) * MAP_H * 0.94;
  loot.push({ x: +x.toFixed(1), y: +y.toFixed(1), z: +(terrainH(x, y) + 0.4).toFixed(1), ...rollItem(rnd, x, y), id: loot.length });
}
console.log(`loot spawns: ${loot.length}`);

// ---------- 6. spawn points (plane path / drop zones) ----------
const spawns = [];
// Plane flies across the map; players pick a drop point.
const plane = {
  from: { x: -HALF_X * 0.9, y: -HALF_Y * 0.6 },
  to:   { x:  HALF_X * 0.9, y:  HALF_Y * 0.6 },
};
for (let i = 0; i < 64; i++) {
  const t = i / 63;
  spawns.push({ x: +(plane.from.x + (plane.to.x - plane.from.x) * t).toFixed(0), y: +(plane.from.y + (plane.to.y - plane.from.y) * t).toFixed(0) });
}
// Hot-drop presets per landmark.
for (const [k, l] of Object.entries(LM)) spawns.push({ x: Math.round(l.x), y: Math.round(l.y), hot: k });

// ---------- 7. vegetation / props (instanced) ----------
const trees = [];
for (let i = 0; i < 26000; i++) {
  const x = (rnd() - 0.5) * MAP_W, y = (rnd() - 0.5) * MAP_H;
  const z = zoneAt(x, y);
  // Dense in the western hills and park zones, absent downtown.
  let p = z === 'wild' ? 0.55 : z === 'kbr' || z === 'durgam' ? 0.5 : 0.06;
  if (rnd() < p) trees.push({ x: +x.toFixed(0), y: +y.toFixed(0), z: +terrainH(x, y).toFixed(1), s: +(0.7 + rnd() * 0.9).toFixed(2), r: +rnd().toFixed(3), kind: rnd() < 0.22 ? 1 : 0 });
}
console.log(`trees: ${trees.length}`);

// ---------- 8. rocks / debris ----------
const rocks = [];
for (let i = 0; i < 9000; i++) {
  const x = (rnd() - 0.5) * MAP_W, y = (rnd() - 0.5) * MAP_H;
  const z = zoneAt(x, y);
  if (rnd() < (z === 'wild' ? 0.5 : z === 'durgam' ? 0.4 : 0.15)) rocks.push({ x: +x.toFixed(0), y: +y.toFixed(0), z: +terrainH(x, y).toFixed(1), s: +(0.4 + rnd() * 1.8).toFixed(2), r: +rnd().toFixed(3) });
}

// ---------- 9. surface-type lookup raster (drives footstep audio + traction) ----------
const SG = 256;
const surf = new Uint8Array(SG * SG);           // index into SURFACE
const SURF_ORDER = ['concrete','asphalt','stone','dirt','grass','metal','wood','water'];
// Start as dirt/grass, paint roads and building footprints over it.
for (let i = 0; i < SG * SG; i++) surf[i] = SURF_ORDER.includes('grass') && i % 2 ? 4 : 3;
const paintDisc = (x, y, r, code) => {
  const x0 = clamp(Math.floor((x / MAP_W + 0.5) * SG - r / MAP_W * SG), 0, SG - 1);
  const x1 = clamp(Math.ceil((x / MAP_W + 0.5) * SG + r / MAP_W * SG), 0, SG - 1);
  const y0 = clamp(Math.floor((y / MAP_H + 0.5) * SG - r / MAP_H * SG), 0, SG - 1);
  const y1 = clamp(Math.ceil((y / MAP_H + 0.5) * SG + r / MAP_H * SG), 0, SG - 1);
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) surf[j * SG + i] = code;
};
for (const r of roads) {
  const code = SURF_ORDER.indexOf(r.mat === 'dirt' ? 'dirt' : r.mat === 'concrete' ? 'concrete' : 'asphalt');
  for (let i = 0; i < r.g.length; i++) paintDisc(r.g[i][0], r.g[i][1], 9, code);
}
for (const b of boxes) if (b.bldg) paintDisc(b.x, b.y, Math.max(b.r, b.ry) + 2, SURF_ORDER.indexOf('concrete'));
for (const w of waters) { for (const p of w.g) paintDisc(p[0], p[1], 40, SURF_ORDER.indexOf('water')); }
// Old city = stone paving; hills = dirt.
paintDisc(LM.charminar.x, LM.charminar.y, 900, SURF_ORDER.indexOf('stone'));

// ---------- write ----------
const world = {
  meta: {
    lat0: LAT0, lon0: LON0, mapW: MAP_W, mapH: MAP_H,
    hmGrid: G, surfGrid: SG, surfOrder: SURF_ORDER,
    generated: new Date().toISOString(),
    source: 'OpenStreetMap API 0.6 (real geometry) + procedural terrain',
    counts: { buildings: bCount, roads: rCount, waters: wCount, boxes: boxes.length, loot: loot.length, trees: trees.length, rocks: rocks.length },
  },
  lm: LM,
  boxes, roads, waters, walls, landmarks, loot, spawns, trees, rocks,
  plane,
  // Array.from, not the typed array: JSON.stringify of a Float32Array emits
  // {"0":..} object form, and any NaN would silently become null.
  hm: Array.from(hm, v => +v.toFixed(2)),
  surf: Array.from(surf),
};
const outPath = path.join(OUTDIR, 'world.json');
fs.writeFileSync(outPath, JSON.stringify(world));
// binary heightmap for fast server load
fs.writeFileSync(path.join(OUTDIR, 'height.bin'), Buffer.from(new Float32Array(hm).buffer));
const bytes = fs.statSync(outPath).size;
console.log(`WROTE ${outPath}  ${(bytes/1e6).toFixed(2)} MB`);
console.log(`counts ${JSON.stringify(world.meta.counts)}`);
