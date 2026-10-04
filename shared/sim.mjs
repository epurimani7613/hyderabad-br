
// The authoritative character simulation. THIS FILE IS THE NETWORKING CONTRACT:
// the server runs it to decide truth, and every client runs the identical code on
// its own pending input to predict the future. Any change here changes both
// sides at once, which is exactly why prediction cannot drift.
//
// Inputs are absolute and carry a tick number; there are no deltas.
import { P, SURFACE, BOOST_DECAY, TICK_DT, MEDS } from './config.mjs';
import { clamp, lerp, dist2, HALF_X, HALF_Y } from './geometry.mjs';

/** Default movement intent: joystick axes in [-1,1] + button bitfield. */
export const NO_INPUT = { seq: 0, mx: 0, my: 0, pitch: 0, buttons: 0 };
export const BTN = {
  JUMP: 1, CROUCH: 2, SPRINT: 4, ADS: 8, FIRE: 16, RELOAD: 32,
  USE: 64, PRONE: 128, LEAN_L: 256, LEAN_R: 512, VAULT: 1024,
};
export const has = (b, f) => (b & f) !== 0;

/** Create a fresh player state record. */
export function makePlayer(id, name, x, y, z, tick = 0) {
  return {
    id, name,
    x, y, z, vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: 0,
    eye: P.eye,
    stance: 'stand',                 // stand | crouch | prone
    grounded: true,
    surface: 'concrete',
    lastStep: 0, stepPhase: 0,
    sprint: 0,                       // 0..1 smoothed blend
    ads: 0,                          // 0..1 smoothed blend
    hp: P.maxHp, boost: 0,
    armor: 0, armorLvl: 0, helmet: 0, helmetLvl: 0,
    slot: [null, null],             // primary, secondary
    slotIdx: 0,
    ammo: {},
    meds: {},
    firing: false, triggerHeld: false,
    lastShot: -99, reloadUntil: 0, healUntil: 0, healKind: null,
    vaultT: 0, vaultFrom: null, vaultTo: null,
    input: { ...NO_INPUT },
    lastInputSeq: 0,
    appliedTick: tick,
    // Parachute state. dropTarget is where the player asked to land; the canopy
    // carries them there and then holds position.
    dropped: false, chute: false, chuteAt: 0, dropTarget: { x, y },
    // server-only bookkeeping
    alive: true, kills: 0, damage: 0, bot: false, ping: 0,
    lastDamageAt: -99, safeUntil: 0,
  };
}

export function playerHeight(p) {
  return p.stance === 'prone' ? 0.72 : p.stance === 'crouch' ? P.crouchHeight : P.height;
}
export function playerEye(p, now = 0) {
  const base = p.stance === 'prone' ? 0.42 : p.stance === 'crouch' ? P.crouchEye : P.eye;
  // Breathing sway + ADS pull-in, both tiny so they never affect aim math.
  // Phase is derived from the tick clock, never a module-level accumulator, so
  // client and server agree without sharing mutable state.
  const breathe = Math.sin(now * 1.1 + p.id) * 0.012;
  return base + breathe - p.ads * 0.05;
}

export function maxSpeed(p, grip) {
  let s;
  if (p.stance === 'prone') s = 0.85;
  else if (p.stance === 'crouch') s = P.crouchSpeed;
  else if (p.ads > 0.5) s = P.adsSpeed;
  else if (p.sprint > 0.5) s = P.sprint;
  else s = P.walk;
  // Energy drink lets you sprint faster (PUBG behaviour), but it degrades.
  return s * grip * (1 + (p.boost / 100) * 0.13);
}

/**
 * Advance one player by exactly one tick. Pure w.r.t. inputs: all randomness
 * comes from the caller's seeded RNG, never Math.random.
 */
export function stepPlayer(p, input, world, dt, rng, now) {
  p.input = input;
  if (input.seq) p.lastInputSeq = input.seq;

  // --- aim (absolute, snapped on the server) ---
  p.yaw = input.yaw !== undefined ? input.yaw : p.yaw;
  if (input.pitch !== undefined) p.pitch = clamp(input.pitch, -1.4, 1.4);

  const btn = input.buttons | 0;

  // --- stance transitions ---
  const wantCrouch = has(btn, BTN.CROUCH) || has(btn, BTN.PRONE);
  const nextStance = has(btn, BTN.PRONE) ? 'prone' : has(btn, BTN.CROUCH) ? 'crouch' : 'stand';
  if (nextStance !== p.stance) {
    // Only stand up if there is headroom, else the state machine refuses.
    if (nextStance === 'stand') {
      const g = world.grid.groundAt(p.x, p.y, p.z + 0.2, P.radius);
      if (g.z <= p.z + P.maxStep) p.stance = 'stand';
    } else p.stance = nextStance;
  }
  // A prone player cannot sprint.
  const canSprint = p.stance === 'stand' && !has(btn, BTN.ADS) && !p.vaultT;
  p.sprint = lerp(p.sprint, (canSprint && has(btn, BTN.SPRINT) && (input.mx || input.my)) ? 1 : 0, 1 - Math.exp(-14 * dt));
  p.ads = lerp(p.ads, has(btn, BTN.ADS) ? 1 : 0, 1 - Math.exp(-18 * dt));

  // --- surface under the feet ---
  p.surface = world.surfaceAt(p.x, p.y);

  // --- desired horizontal velocity from the joystick, relative to yaw ---
  const mag = Math.min(1, Math.hypot(input.mx, input.my));
  let wx = 0, wy = 0;
  if (mag > 0.02) {
    // Screen-space stick -> world: forward is -yaw in map space.
    const s = Math.sin(p.yaw), c = Math.cos(p.yaw);
    wx = input.mx * c - input.my * s;
    wy = input.mx * s + input.my * c;
    const l = Math.hypot(wx, wy) || 1;
    wx /= l; wy /= l;
  }
  const grip = SURFACE[p.surface]?.grip ?? 1;
  const target = maxSpeed(p, grip) * mag;
  const tvx = wx * target, tvy = wy * target;

  // --- acceleration / friction (Quake-style, framerate independent) ---
  const accel = p.grounded ? P.accel : P.airAccel;
  p.vx += (tvx - p.vx) * clamp(accel * dt / Math.max(target, 1), 0, 1);
  p.vy += (tvy - p.vy) * clamp(accel * dt / Math.max(target, 1), 0, 1);
  if (mag < 0.02 && p.grounded) {
    const f = Math.max(0, 1 - P.friction * dt);
    p.vx *= f; p.vy *= f;
  }

  // --- contextual vault: a live obstacle in front gets an animated arc ---
  if (has(btn, BTN.VAULT) && p.grounded && !p.vaultT) {
    const fwd = world.vaultTarget(p, p.yaw);
    if (fwd) {
      p.vaultT = 0.42;
      p.vaultFrom = { x: p.x, y: p.y, z: p.z };
      p.vaultTo = fwd;
      p.grounded = false;
      p.vz = P.jumpVel * 0.62;
    }
  }
  if (p.vaultT > 0) {
    p.vaultT = Math.max(0, p.vaultT - dt);
    const t = 1 - p.vaultT / 0.42;
    if (p.vaultFrom && p.vaultTo) {
      // Ease the arc while physics keeps a little authority (still collidable).
      p.x = lerp(p.vaultFrom.x, p.vaultTo.x, t * t * (3 - 2 * t));
      p.y = lerp(p.vaultFrom.y, p.vaultTo.y, t * t * (3 - 2 * t));
      p.z = Math.max(p.z, lerp(p.vaultFrom.z, p.vaultTo.z, t));
    }
  }

  // --- jump ---
  if (has(btn, BTN.JUMP) && p.grounded && !p.vaultT) {
    p.vz = P.jumpVel;
    p.grounded = false;
  }

  // --- integrate + gravity ---
  // Freefall, then the canopy opens and terminal velocity clamps the descent.
  if (p.dropped && !p.grounded) {
    if (!p.chuteAt) p.chuteAt = now + P.chuteOpenAfter;
    const open = now >= p.chuteAt;
    p.chute = open;
    const g = open ? P.gravity * P.chuteGravityScale : P.gravity;
    p.vz += g * dt;
    const term = open ? P.chuteTerminal : P.freefallTerminal;
    if (p.vz < term) p.vz = term;
    if (open) {
      // Canopy drift lets the player steer the landing, but it must stop once
      // they've covered the requested horizontal offset, otherwise they drift
      // forever past their chosen drop point.
      const want = Math.hypot(p.x - p.dropTarget.x, p.y - p.dropTarget.y);
      if (want > P.chuteDriftMax) {
        p.vx = Math.cos(p.yaw) * P.chuteDrift;
        p.vy = Math.sin(p.yaw) * P.chuteDrift;
      } else {
        p.vx = 0; p.vy = 0;      // over the target: hold position
      }
    }
  } else {
    p.vz += P.gravity * dt;
  }
  let nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;

  // --- world bounds ---
  nx = clamp(nx, -HALF_X + 8, HALF_X - 8);
  ny = clamp(ny, -HALF_Y + 8, HALF_Y - 8);

  // --- horizontal collision, then vertical (step-up for kerbs) ---
  if (!p.vaultT) {
    const res = world.grid.resolveCircle(nx, ny, P.radius, playerHeight(p), nz);
    nx = res.x; ny = res.y;
  }

  const terrain = world.terrainHeight(nx, ny);
  const support = world.grid.groundAt(nx, ny, nz + P.maxStep, P.radius * 0.9);
  const floor = Math.max(terrain, support.z);

  if (nz <= floor) {
    // Landed (or still grounded): snap, kill downward velocity, allow step-up.
    const fall = -p.vz;
    nz = floor;
    p.vz = 0;
    if (!p.grounded) {
      p.grounded = true;
      // Landing impact drives camera dip + footstep loudness for the animation
      // layer; keep the fall distance for it to read.
      p.landImpact = clamp(fall / P.jumpVel, 0, 1.6);
      p.landAt = now;
      // Touchdown ends the drop: clear chute state so normal gravity resumes.
      p.chute = false;
      p.chuteAt = 0;
      p.vaultT = 0;
    }
  } else if (p.grounded && nz - floor <= P.maxStep && p.vz <= 0) {
    nz = floor; p.vz = 0;             // walking up a kerb / stair
  } else {
    p.grounded = false;
  }

  // Head clearance: if a ceiling would clip us, block the rise.
  const head = world.grid.groundAt(p.x, p.y, p.z + playerHeight(p) - 0.05, 0.01);
  if (head.top && head.top > p.z + playerHeight(p) + 0.05 && nz > p.z) nz = p.z;

  p.x = nx; p.y = ny; p.z = nz;
  p.eye = playerEye(p, now);

  // --- footsteps: distance-driven so they match speed and surface ---
  if (p.grounded && !p.vaultT) {
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 0.6) {
      p.stepPhase += sp * dt;
      const stride = p.stance === 'prone' ? 1.05 : p.sprint > 0.5 ? 2.15 : p.stance === 'crouch' ? 1.5 : 1.85;
      if (p.stepPhase >= stride) {
        p.stepPhase -= stride;
        p.lastStep = now;
        p.stepEvent = { surface: p.surface, loud: SURFACE[p.surface]?.loud ?? 1, sprint: p.sprint > 0.5, speed: sp };
      }
    }
  }

  // --- boost decay ---
  if (p.boost > 0) p.boost = Math.max(0, p.boost - BOOST_DECAY * dt);

  // --- timed actions ---
  if (p.healUntil && now >= p.healUntil) {
    const m = MEDS[p.healKind];
    if (m && (p.meds[p.healKind] || 0) > 0) {
      p.meds[p.healKind]--;
      if (m.heal) p.hp = Math.min(m.cap, p.hp + m.heal);
      if (m.boost) p.boost = Math.min(m.cap, p.boost + m.boost);
    }
    p.healUntil = 0; p.healKind = null;
  }

  // --- zone damage ---
  // world.zoneDamage() returns dps only when outside the circle. The caller
  // decides whether the match is live enough to apply it (see Match.step), so a
  // player idling in the lobby is never ticketed to death.
  if (world.zoneDamage) {
    const zd = world.zoneDamage(p.x, p.y, now);
    if (zd > 0) {
      applyDamage(p, zd, null, { x: p.x, y: p.y, z: p.z }, 'zone', now);
    }
  }
  return p;
}

/** Damage pipeline: armour absorbs first, then hp. Armour degrades per hit. */
export function applyDamage(p, amount, attacker, hitPos, zone, now) {
  if (!p.alive) return 0;
  let dmg = amount;
  if (zone !== 'zone') {
    const soak = zone === 'head' ? 0.55 : 1.0; // helmets only cover the head
    if (zone !== 'head' && p.armor > 0 && p.armorLvl > 0) {
      const a = Math.min(p.armor, dmg * ARMOR_ABS(p.armorLvl) * soak);
      p.armor -= a;
      dmg -= a;
      if (p.armor <= 0) p.armorLvl = 0;
    } else if (zone === 'head' && p.helmet > 0 && p.helmetLvl > 0) {
      const a = Math.min(p.helmet, dmg * 0.55);
      p.helmet -= a;
      dmg -= a;
      if (p.helmet <= 0) p.helmetLvl = 0;
    }
    p.lastDamageAt = now;
    p.safeUntil = now + 0.6;   // shooter-swap grace so self-trades can't double-fire
  }
  p.hp -= dmg;
  if (p.hp <= 0) {
    p.hp = 0;
    p.alive = false;
    p.deathInfo = { by: attacker?.id ?? null, zone, at: now, x: p.x, y: p.y, z: p.z };
    if (attacker && attacker !== p) attacker.kills++;
  }
  return dmg;
}
function ARMOR_ABS(l) { return ({ 1: 0.40, 2: 0.60, 3: 0.72 })[l] ?? 0.4; }
