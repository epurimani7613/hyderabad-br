
// Projectile ballistics: drag, travel time, penetration, and the ray-vs-capsule
// hit test used for lag-compensated hit registration. Deterministic and
// dependency-free so the server resolves shots exactly as the client predicts.
import { MAT, WEAPONS, HEADSHOT_MULT_CAP } from './config.mjs';
import { mulberry32 } from './rng.mjs';
import { clamp } from './geometry.mjs';

/**
 * Integrate one bullet for `dt`, sub-stepped so fast rounds can't tunnel.
 * Mutates `b` (a plain bullet record). Returns false when it dies.
 */
export function stepBullet(b, dt, grid, terrainHeight) {
  // Sub-step by distance so nothing moves more than ~1.2 m per check.
  // NOTE: the speed must come from the velocity vector. This used to read a
  // non-existent `b.speed` field, which made `sub` NaN, so the sub-step loop
  // never executed and every bullet froze at the muzzle - hit registration
  // could never fire, at any range.
  const speed = Math.hypot(b.vx, b.vy, b.vz) || 1e-4;
  const sub = Math.max(1, Math.min(64, Math.ceil((speed * dt) / 1.2)));
  const h = dt / sub;
  for (let i = 0; i < sub; i++) {
    const px = b.x, py = b.y, pz = b.z;
    // Quadratic drag acts on the velocity vector; gravity is a separate
    // acceleration and must NOT be multiplied by the drag factor.
    const v = Math.hypot(b.vx, b.vy, b.vz) || 1e-4;
    const f = Math.max(0, 1 - b.drag * v * h);
    b.vx *= f; b.vy *= f; b.vz *= f;
    b.vz += -9.81 * h;
    b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
    b.travelled += Math.hypot(b.x - px, b.y - py, b.z - pz);
    b.age += h;

    // Terrain / water termination.
    const gh = terrainHeight(b.x, b.y);
    if (b.z <= gh + 0.05) {
      b.dead = true;
      b.impact = { kind: 'terrain', mat: 'dirt', x: b.x, y: b.y, z: gh };
      return false;
    }
    // Structure hits.
    const seg = Math.hypot(b.x - px, b.y - py, b.z - pz) || 1e-4;
    const hit = grid.raycast(px, py, pz, (b.x - px) / seg, (b.y - py) / seg, (b.z - pz) / seg, seg, (o) => o.mat !== 'none');
    if (hit) {
      b.x = px + (b.x - px) * (hit.t / seg);
      b.y = py + (b.y - py) * (hit.t / seg);
      b.z = pz + (b.z - pz) * (hit.t / seg);
      const cost = (MAT[hit.mat] ?? 1) * 3.2;
      b.energy -= cost;
      // Penetration: if enough energy survives the material, the round keeps
      // flying (already slightly degraded) instead of stopping here.
      if (b.energy > 0) {
        const ex = (b.x - px) / seg, ey = (b.y - py) / seg, ez = (b.z - pz) / seg;
        b.x += ex * 0.12; b.y += ey * 0.12; b.z += ez * 0.12;
      } else {
        b.dead = true;
        b.impact = { kind: 'structure', mat: hit.mat, x: hit.x, y: hit.y, z: hit.z };
        return false;
      }
    }
    if (b.age > 6 || b.travelled > 1600 || b.energy <= 0) { b.dead = true; return false; }
  }
  return true;
}

/**
 * Spawn a bullet (or a shotgun spread) from a shooter. Deterministic per shot id.
 *
 * `ads` (0..1) tightens the cone: hip fire is deliberately brutal, aiming down
 * sights collapses most of the cone. Without this the dispersion is identical
 * at 30 m and 300 m, which makes long-range play impossible.
 */
export function fireWeapon(shooter, wpn, aim, seed, ads = 0) {
  const W = WEAPONS[wpn];
  const rnd = mulberry32(seed >>> 0);
  const pellets = W.pellets || 1;
  // Interpolate between the hip and ADS cone: ADS keeps ~22% of the hip spread.
  const tight = 1 - ads * 0.78;
  const base = (W.spreadHip + (W.spreadAds - W.spreadHip) * ads) * tight;
  const out = [];
  for (let i = 0; i < pellets; i++) {
    // Spread cone in radians.
    const sp = (base + rnd() * base * 0.5) * Math.PI / 180;
    const a = aim.yaw + (rnd() * 2 - 1) * sp;
    const el = aim.pitch + (rnd() * 2 - 1) * sp * 0.7;
    const ce = Math.cos(el);
    out.push({
      owner: shooter.id,
      wpn, seed: seed * 131 + i,
      x: shooter.x + Math.cos(aim.yaw) * 0.42,
      y: shooter.y + Math.sin(aim.yaw) * 0.42,
      z: shooter.z + shooter.eye,
      vx: Math.cos(a) * ce * W.vel,
      vy: Math.sin(a) * ce * W.vel,
      vz: Math.sin(el) * W.vel,
      drag: W.drag,
      energy: 100 * (W.penCost > 0.5 ? 1.25 : 1.0),
      travelled: 0, age: 0, dead: false, impact: null,
    });
  }
  return out;
}

/**
 * Ray vs a vertical hitbox: head sphere, body cylinder, legs cylinder.
 * Returns the nearest hit as {t, zone}, or null.
 *
 * Coordinate convention: (x, y, z) is map space where x=east, y=north, z=up.
 * The target's (tx, ty, tz) is its FEET position.
 */
export function rayCapsule(ox, oy, oz, dx, dy, dz, tx, ty, tz, height, radius) {
  // Head: a sphere centred just below the top of the head.
  const hs = raySphere(ox, oy, oz, dx, dy, dz, tx, ty, tz + height - 0.13, radius * 0.72);
  if (hs !== null) return { t: hs, zone: 'head' };
  // Body: a cylinder from chest to shoulders, radius = body radius.
  const cy = rayCylinderY(ox, oy, oz, dx, dy, dz, tx, ty, tz + 0.42, tz + height - 0.26, radius);
  if (cy !== null) return { t: cy, zone: 'body' };
  // Legs: a slimmer cylinder from the feet to the chest.
  const lg = rayCylinderY(ox, oy, oz, dx, dy, dz, tx, ty, tz, tz + 0.42, radius * 0.8);
  if (lg !== null) return { t: lg, zone: 'limb' };
  return null;
}
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const ex = ox - cx, ey = oy - cy, ez = oz - cz;
  const b = ex * dx + ey * dy + ez * dz;
  const c = ex * ex + ey * ey + ez * ez - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  let t = -b - s;
  if (t < 0) t = -b + s;
  return t >= 0 ? t : null;
}
/**
 * Ray vs a finite cylinder standing vertically on the ground.
 *
 * Map space: x = east, y = north, z = altitude (up).
 *   ray origin  = (ox, oy, oz), direction (dx, dy, dz)
 *   cylinder    = ground centre (tx, ty), altitude span z0..z1, radius r
 *
 * A vertical cylinder's cross-section lies in the X/Y (horizontal) plane, so
 * the quadratic must be solved in X and Y, with the Z test done afterwards.
 * (Solving in X and Z - the usual axis-convention trap - silently misses every
 * hit, because Z here is altitude and not a horizontal axis.)
 */
export function rayCylinderY(ox, oy, oz, dx, dy, dz, tx, ty, z0, z1, r) {
  const px = ox - tx, py = oy - ty;               // horizontal offset to the axis
  const a = dx * dx + dy * dy;                     // horizontal speed squared
  if (a < 1e-9) return null;                      // straight up/down: no horizontal sweep
  const b = 2 * (px * dx + py * dy);
  const c = px * px + py * py - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  let best = null;
  for (const t of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) {
    if (t < 0) continue;
    const z = oz + dz * t;                        // altitude at that distance
    if (z >= z0 && z <= z1 && (best === null || t < best)) best = t;
  }
  return best;
}

/** Distance falloff multiplier for a weapon at range r. */
export function falloff(W, r) {
  if (r <= W.falloffStart) return 1;
  if (r >= W.falloffEnd) return W.falloffMin;
  const t = (r - W.falloffStart) / (W.falloffEnd - W.falloffStart);
  return 1 + (W.falloffMin - 1) * t;
}

/** Full damage resolution for one bullet vs one (rewound) player. */
export function resolveDamage(W, zone, range) {
  let d = W.dmg * falloff(W, range);
  if (zone === 'head') d *= Math.min(W.hs, HEADSHOT_MULT_CAP);
  else if (zone === 'limb') d *= W.limb;
  return Math.max(1, Math.round(d));
}
