
// Isomorphic 2D math + the shared projection between lat/lon and map metres.
// Both the server and the client import this, so a shot the client predicts hits
// exactly where the server resolves it.
import { LAT0, LON0, M_PER_DEG_LAT, M_PER_DEG_LON, MAP_W, MAP_H } from './config.mjs';

// Playfield is rectangular, so bounds are per-axis. HALF_X/HALF_Y are the
// authoritative limits; HALF is kept as the largest, for anything that only
// needs one scalar.
export const HALF_X = MAP_W / 2;
export const HALF_Y = MAP_H / 2;
export const HALF = Math.max(HALF_X, HALF_Y);

/** lat/lon -> map-space metres. +x = east, +y = north. */
export function lonLatToM(lon, lat) {
  return [ (lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT ];
}
export function mToLonLat(x, y) {
  return [ LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT ];
}
/** Is a map-space point inside the playfield? */
export const inBounds = (x, y) => x >= -HALF_X && x <= HALF_X && y >= -HALF_Y && y <= HALF_Y;
/** map metres -> world units for the renderer (1:1, just recentred on origin). */
export function mToWorld(x, y) { return [x - HALF, y - HALF]; }

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
export const dist2 = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };
export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

/** Shortest distance from point p to segment ab, plus the parametric t. */
export function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 1e-9 ? (wx * vx + wy * vy) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + vx * t, cy = ay + vy * t;
  return { d: dist(px, py, cx, cy), t, cx, cy };
}

/** Is the point inside the cone centred on `facing` with half-angle `half`? */
export function inCone(px, py, ox, oy, facing, half, range) {
  const d2 = dist2(px, py, ox, oy);
  if (d2 > range * range) return false;
  const a = Math.atan2(py - oy, px - ox);
  let diff = ((a - facing + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff) <= half;
}

/**
 * Build the uniform spatial grid the world uses for collision + hit queries.
 * Cell ~24m keeps a typical building footprint inside one bucket.
 */
export class SpatialGrid {
  constructor(cell = 24, half = HALF, pad = 600) {
    this.cell = cell;
    this.half = half + pad;
    this.dim = Math.ceil((this.half * 2) / cell);
    this.dimY = this.dim;   // square grid keeps bucketing simple
    this.buckets = new Map();
    this.items = [];
  }
  _key(cx, cy) { return cy * this.dim + cx; }
  _cells(x, y, r) {
    const x0 = clamp(Math.floor((x - r + this.half) / this.cell), 0, this.dim - 1);
    const x1 = clamp(Math.floor((x + r + this.half) / this.cell), 0, this.dim - 1);
    const y0 = clamp(Math.floor((y - r + this.half) / this.cell), 0, this.dim - 1);
    const y1 = clamp(Math.floor((y + r + this.half) / this.cell), 0, this.dim - 1);
    const out = [];
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) out.push(this._key(cx, cy));
    return out;
  }
  insert(item) {
    const id = this.items.length;
    item._gridId = id;
    this.items.push(item);
    for (const k of this._cells(item.x, item.y, item.r)) {
      let b = this.buckets.get(k);
      if (!b) { b = []; this.buckets.set(k, b); }
      b.push(item);
    }
    return id;
  }
  /** Visit every item whose bucket overlaps the query circle. May return duplicates. */
  query(x, y, r, fn) {
    const seen = this._qseen || (this._qseen = new Set());
    seen.clear();
    for (const k of this._cells(x, y, r)) {
      const b = this.buckets.get(k);
      if (!b) continue;
      for (const it of b) {
        if (seen.has(it._gridId)) continue;
        seen.add(it._gridId);
        fn(it);
      }
    }
  }
  /**
   * Push a circle out of every overlapping solid it penetrates.
   * Returns {x,y,hit,normal} in map metres. Mutates nothing.
   */
  resolveCircle(x, y, radius, height, z) {
    let nx = x, ny = y, hit = null;
    this.query(x, y, radius + 2, (b) => {
      if (!b.solid) return;
      if (z >= b.top - 0.02) return;          // walking over it
      if (z + height <= b.base + 0.02) return; // underneath it
      const dx = nx - b.x, dy = ny - b.y;
      const rr = radius + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) return;
      const d = Math.sqrt(d2) || 1e-4;
      const push = (rr - d);
      nx += (dx / d) * push; ny += (dy / d) * push;
      hit = hit || { x: dx / d, y: dy / d, mat: b.mat };
    });
    return { x: nx, y: ny, hit };
  }
  /** Highest solid top strictly below `z+eps` whose footprint contains (x,y). */
  groundAt(x, y, z, radius = 0.3) {
    let best = -1e9, top = null;
    this.query(x, y, radius, (b) => {
      if (!b.solid) return;
      if (z >= b.top - 0.35) return;         // already above it -> not support
      if (b.top <= best) return;
      const dx = x - b.x, dy = y - b.y, rr = radius + b.r;
      if (dx * dx + dy * dy <= rr * rr) { best = b.top; top = b; }
    });
    return { z: best > -1e8 ? best : 0, top };
  }
  /**
   * Ray-march the grid: returns the nearest box hit for a capsule/segment query.
   * Cheap and exact enough for buildings + walls (all axis-aligned boxes).
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, filter) {
    let bestT = maxDist, hit = null;
    const steps = Math.ceil(maxDist / (this.cell * 0.5)) + 1;
    const stepLen = maxDist / steps;
    for (let i = 0; i <= steps; i++) {
      const t = i * stepLen;
      const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
      let found = null;
      this.query(px, py, this.cell, (b) => {
        if (!b.solid || found) return;
        if (filter && !filter(b)) return;
        const th = slabHit(ox, oy, oz, dx, dy, dz, b, maxDist);
        if (th && th.t < bestT) { bestT = th.t; found = th; }
      });
      if (found) { hit = found; break; }     // boxes are solid, first entry wins
    }
    return hit;
  }
}

/** Ray vs axis-aligned box (centre x/y, half extents r/ry, z base..top). */
export function slabHit(ox, oy, oz, dx, dy, dz, b, maxDist) {
  const ry = b.ry ?? b.r;
  let tmin = 0, tmax = maxDist, axis = null, sign = 1;
  const lo = [b.x - b.r, b.y - ry, b.base], hi = [b.x + b.r, b.y + ry, b.top];
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-8) { if (o[a] < lo[a] || o[a] > hi[a]) return null; continue; }
    const inv = 1 / d[a];
    let t1 = (lo[a] - o[a]) * inv, t2 = (hi[a] - o[a]) * inv;
    let s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return { t: tmin, x: b.x, y: b.y, base: b.base, top: b.top, mat: b.mat, axis, sign, box: b };
}
