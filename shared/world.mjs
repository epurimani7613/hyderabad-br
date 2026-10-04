
// Runtime world: holds the baked world data and owns every query the sim and
// netcode need (terrain height, surface, zone, vaulting). Identical on server
// and client so hit registration agrees.
//
// NOTE: no node: imports here - this module is bundled for the browser too.
// The server's disk loader lives in server/load-world.mjs.
import { SpatialGrid, lonLatToM, clamp, HALF_X, HALF_Y } from './geometry.mjs';
import { ZONE, SURFACE, MAP_W, MAP_H, LANDMARKS } from './config.mjs';

export class World {
  constructor(data) {
    this.data = data;
    this.meta = data.meta;
    this.hm = Float32Array.from(data.hm);
    this.G = data.meta.hmGrid;
    this.surf = Uint8Array.from(data.surf);
    this.SG = data.meta.surfGrid;
    this.surfOrder = data.meta.surfOrder;
    this.landmarks = data.lm;

    // Rebuild the collision grid. Cell 32m: building footprints stay in ~1 bucket
    // while a 20k-box world still gives O(1)-ish queries.
    this.grid = new SpatialGrid(32, Math.max(HALF_X, HALF_Y), 400);
    for (const b of data.boxes) {
      this.grid.insert({ ...b, r: Math.max(b.r, 0.05), ry: b.ry ?? b.r });
    }
    this.boxCount = data.boxes.length;
  }

  /** Bilinear heightmap sample, in metres ASL. */
  terrainHeight(x, y) {
    const G = this.G;
    const u = clamp((x / MAP_W + 0.5) * (G - 1), 0, G - 1.001);
    const v = clamp((y / MAP_H + 0.5) * (G - 1), 0, G - 1.001);
    const i = Math.floor(u), j = Math.floor(v);
    const fx = u - i, fy = v - j;
    const a = this.hm[j * G + i], b = this.hm[j * G + i + 1];
    const c = this.hm[(j + 1) * G + i], d = this.hm[(j + 1) * G + i + 1];
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }

  /** Surface type string at a point (drives footstep audio + traction). */
  surfaceAt(x, y) {
    const SG = this.SG;
    const u = clamp(Math.floor((x / MAP_W + 0.5) * SG), 0, SG - 1);
    const v = clamp(Math.floor((y / MAP_H + 0.5) * SG), 0, SG - 1);
    return this.surfOrder[this.surf[v * SG + u]] || 'dirt';
  }

  /**
   * Can a player standing here vault the obstacle in front of them?
   * Returns the landing spot, or null. Used by stepPlayer.
   */
  vaultTarget(p, yaw) {
    const fx = Math.cos(yaw), fy = Math.sin(yaw);
    const reach = 1.5;
    let best = null;
    this.grid.query(p.x + fx * reach, p.y + fy * reach, 2.4, (b) => {
      if (!b.solid || b.deck || b.bridge) return;
      const h = b.top - p.z;
      if (h < 0.45 || h > 1.35) return;          // too low to bother, too tall to clear
      // Is it actually in front?
      const dx = b.x - p.x, dy = b.y - p.y;
      if (dx * fx + dy * fy < 0.6) return;
      if (!best || b.top > best.z) best = { x: b.x, y: b.y, z: b.top };
    });
    if (!best) return null;
    // Land just past the obstacle so the arc clears it.
    const land = 1.35;
    return { x: best.x + fx * land, y: best.y + fy * land, z: best.z + 0.02 };
  }

  /**
   * Zone (blue circle) state at time `now` (seconds into the match).
   * Circles always contain the playfield centroid early, then converge.
   */
  zoneAt(now) {
    const sched = ZONE.schedule;
    let t = now, idx = 0;
    for (let i = 0; i < sched.length; i++) {
      if (t < sched[i].hold) { idx = i; break; }
      t -= sched[i].hold; idx = i + 1;
    }
    if (idx >= sched.length) {
      // Fully closed. Hold the final circle at the LAST centre rather than
      // snapping to the map origin: bots rotating toward (0,0) walked off and
      // a 500 m circle at the origin is often empty ground nobody occupies.
      const last = sched[sched.length - 1];
      return {
        cx: this._finalCentre?.cx ?? 0, cy: this._finalCentre?.cy ?? 0,
        r: last.r, next: null, dps: last.dps, phase: sched.length, closed: true,
      };
    }
    const cur = sched[idx];
    const next = sched[idx + 1] || null;
    // Deterministic pseudo-random next centre inside the current circle, seeded by
    // phase so every client predicts the same circle.
    let nx = 0, ny = 0;
    if (next) {
      const s = mulberryLocal(idx * 7919 + 13);
      const a = s() * Math.PI * 2;
      const maxOff = Math.max(0, cur.r - next.r) * 0.62;
      nx = Math.cos(a) * maxOff * s();
      ny = Math.sin(a) * maxOff * s();
    } else {
      // Last phase: this IS the final circle, so remember its centre.
      this._finalCentre = { cx: nx, cy: ny };
    }
    return { cx: nx, cy: ny, r: cur.r, next, nextX: nx, nextY: ny, dps: cur.dps, phase: idx, closed: false };
  }

  /** Damage per second for a player outside the circle. */
  zoneDamage(x, y, now) {
    const z = this.zoneAt(now);
    const d = Math.hypot(x - z.cx, y - z.cy);
    return d > z.r ? z.dps : 0;
  }

  /** Nearest named landmark, for HUD + bot naming. */
  nearestLandmark(x, y) {
    let best = null, bd = 1e9;
    for (const [k, l] of Object.entries(this.landmarks)) {
      const d = Math.hypot(x - l.x, y - l.y);
      if (d < bd) { bd = d; best = k; }
    }
    return { key: best, dist: bd, label: this.landmarks[best]?.label };
  }
}

// Local deterministic RNG (kept separate from rng.mjs to avoid a cycle).
function mulberryLocal(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
