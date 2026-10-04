
// One authoritative match: players, the plane drop, bullets, loot pickups, the
// shrinking zone, and the snapshot ring used for lag compensation.
import { stepPlayer, makePlayer, applyDamage, playerHeight, playerEye, BTN, has } from '../shared/sim.mjs';
import { stepBullet, fireWeapon, rayCapsule, resolveDamage } from '../shared/ballistics.mjs';
import { TICK_HZ, TICK_DT, WEAPONS, AMMO, MEDS, ARMOR, P, ZONE, LAG_COMP_WINDOW, MAP_W, MAP_H, MAX_CLIENT_CATCHUP } from '../shared/config.mjs';
import { clamp, dist, HALF_X, HALF_Y, inBounds } from '../shared/geometry.mjs';
import { mulberry32, hashStr } from '../shared/rng.mjs';

const NAMES = ['Ravi', 'Priya', 'Arjun', 'Sneha', 'Kiran', 'Divya', 'Rahul', 'Meera',
  'Vikram', 'Anjali', 'Sanjay', 'Pooja', 'Ramesh', 'Lakshmi', 'Naveen', 'Deepa',
  'Sameer', 'Nisha', 'Ajay', 'Kavya', 'Manish', 'Shreya', 'Varun', 'Ananya'];

export class Match {
  constructor(id, world, opts = {}) {
    this.id = id;
    this.world = world;
    this.tick = 0;
    this.time = 0;                    // seconds since match start
    this.players = new Map();         // id -> player
    this.bullets = [];
    this.events = [];                 // consumed by each socket then cleared
    this.state = 'waiting';           // waiting | dropping | playing | over
    this.rng = mulberry32(opts.seed ?? 0xBEEF);
    this.seed = opts.seed ?? 0xBEEF;
    this.maxPlayers = opts.maxPlayers || 100;
    this.isPrivate = !!opts.private;
    this.code = opts.code || null;
    this.winner = null;
    this.bots = new Map();          // id -> bot controller (server-side opponents)
    this.loot = world.data.loot.map(l => ({ ...l, taken: false }));
    this.lootById = new Map(this.loot.map(l => [l.id, l]));
    this.history = [];                // [{tick, snap:[{id,x,y,z,stance,hp}]}] for rewind
    this.plane = { ...world.data.plane, t: 0, dropped: false };
    this.zone = world.zoneAt(0);
  }

  get playerCount() { return this.players.size; }
  get botCount() { return this.bots.size; }
  get humanCount() { return this.playerCount - this.botCount; }
  get aliveCount() { return [...this.players.values()].filter(p => p.alive).length; }

  // ---------- join ----------
  join(ws, name) {
    if (this.playerCount >= this.maxPlayers) return null;
    const id = this.nextId();
    const spawn = this.pickSpawn();
    const p = makePlayer(id, name || NAMES[this.rng() * NAMES.length | 0], spawn.x, spawn.y, spawn.z, this.tick);
    p.ping = 0;
    p.dropFrom = null;                // set while parachuting
    p.ws = ws;
    this.kitPlayer(p);
    this.players.set(id, p);
    return p;
  }

  /**
   * Ground kit. A BR player who lands with literally nothing has no way to
   * fight before finding ground loot, which made early drops unwinnable in
   * testing. Everyone starts with a rifle plus basic supplies; better guns
   * still have to be looted from the map.
   *
   * The weapon is chosen from the player's id rather than the RNG so it is
   * reproducible: tests could not assert anything about shooting when the same
   * seed produced a bolt-action (one shot per trigger pull) or an automatic.
   */
  kitPlayer(p) {
    const AUTO_KIT = ['M416', 'SCAR-L', 'VECTOR', 'MP5', 'DP28'];
    const w = AUTO_KIT[p.id % AUTO_KIT.length];
    p.slot = [w, null];
    p.slotIdx = 0;
    p.ammo = { [w]: WEAPONS[w].mag };
    // Reserve ammo has to cover a whole match, not a firefight. Bots used to
    // start with 120 rounds, burned through it inside the opening minute of a
    // 14-player scrum and then stood at 0 magazine / 0 reserve forever, unable
    // to shoot again - matches never resolved and every death came from the
    // circle. Four magazines is a realistic BR loadout.
    p.ammoPool = { [WEAPONS[w].ammo]: WEAPONS[w].mag * 4, '9mm': 180 };
    p.armorLvl = 1; p.armor = ARMOR[1];
    p.helmetLvl = 1; p.helmet = ARMOR[1];
    p.meds = { bandage: 5, firstaid: 2 };
  }
  nextId() {
    let n = 1;
    while (this.players.has(n)) n++;
    return n;
  }
  pickSpawn() {
    // Prefer a spawn away from living players so nobody spawns in a firefight.
    for (let i = 0; i < 24; i++) {
      const s = this.world.data.spawns[Math.floor(this.rng() * this.world.data.spawns.length)];
      const x = s.x + (this.rng() - 0.5) * 900, y = s.y + (this.rng() - 0.5) * 900;
      if (!inBounds(x, y)) continue;
      const ok = [...this.players.values()].every(q => dist(q.x, q.y, x, y) > 420);
      if (ok) return { x, y, z: this.world.terrainHeight(x, y) + 0.1 };
    }
    const x = (this.rng() - 0.5) * MAP_W * 0.8, y = (this.rng() - 0.5) * MAP_H * 0.8;
    return { x, y, z: this.world.terrainHeight(x, y) + 0.1 };
  }

  remove(id) {
    const p = this.players.get(id);
    if (p) this.events.push({ t: 'leave', id, name: p.name });
    this.bots.delete(id);
    this.players.delete(id);
    this.checkWin();
  }

  // ---------- input ----------
  /**
   * Queue a client's input for its player. Absolute input + tick; the server
   * applies it on the next tick, so a late packet costs latency, never a
   * physics desync.
   */
  submitInput(id, input) {
    const p = this.players.get(id);
    if (!p) return;
    // Reject impossible values outright - never trust the client.
    const mx = clamp(Number(input.mx) || 0, -1, 1);
    const my = clamp(Number(input.my) || 0, -1, 1);
    p.pending = p.pending || [];
    p.pending.push({
      seq: Number(input.seq) | 0,
      mx, my,
      pitch: clamp(Number(input.pitch) || 0, -1.4, 1.4),
      yaw: Number.isFinite(input.yaw) ? input.yaw : p.yaw,
      buttons: Number(input.buttons) | 0,
      t: this.time,
    });
    if (p.pending.length > MAX_CLIENT_CATCHUP * 3) p.pending.splice(0, p.pending.length - MAX_CLIENT_CATCHUP * 3);
  }

  // ---------- the tick ----------
  step() {
    this.tick++;
    this.time += TICK_DT;

    if (this.state === 'waiting' && this.playerCount >= 2) this.begin();

    // zone advance
    const prevZone = this.zone;
    this.zone = this.world.zoneAt(this.time);
    if (this.zone.phase !== prevZone.phase) {
      this.events.push({ t: 'zone', phase: this.zone.phase, r: this.zone.r, dps: this.zone.dps });
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;

      // --- bots generate an input frame exactly like a client would ---
      if (p.bot && p.botCtl) {
        const f = p.botCtl.frame();
        p.pending = [{ seq: 0, mx: f.mx, my: f.my, pitch: f.pitch, yaw: f.yaw, buttons: f.buttons, t: this.time }];
      }

      // --- consume input ---
      // The client samples at 60 Hz and the sim ticks at 30 Hz, so two inputs
      // normally arrive per tick. Consume up to the tick budget so the queue
      // drains at the send rate instead of growing without bound; the extra
      // one becomes a speed boost for that tick, which is the standard
      // fixed-tick input drain.
      let input = p.lastInput;
      let drained = 0;
      const budget = 2;
      if (p.pending && p.pending.length) {
        // Drop inputs too old to matter (client stalled / tab backgrounded).
        while (p.pending.length > 1 && this.time - p.pending[0].t > TICK_DT * 3) p.pending.shift();
        const merged = { seq: p.lastInputSeq, mx: 0, my: 0, pitch: p.pitch, yaw: p.yaw, buttons: 0, t: this.time };
        while (p.pending.length && drained < budget) {
          const inp = p.pending.shift();
          merged.mx = inp.mx; merged.my = inp.my;
          merged.pitch = inp.pitch; merged.yaw = inp.yaw;
          merged.buttons |= inp.buttons;
          merged.seq = inp.seq;
          drained++;
        }
        input = merged;
        p.lastInput = input;
      }
      input = input || { seq: p.lastInputSeq, mx: 0, my: 0, pitch: p.pitch, yaw: p.yaw, buttons: 0 };

      // --- weapon fire (server-authoritative rate of fire) ---
      this.handleFire(p, input);

      // --- movement (shared sim) ---
      // The pure sim applies zone damage whenever the world reports dps, so gate
      // it here: in 'waiting' the room is a lobby, not a live match.
      // Object.create keeps the prototype methods (terrainHeight, vaultTarget,
      // grid); a spread would drop them and the sim would throw.
      let simWorld = this.world;
      if (this.state !== 'playing') {
        simWorld = Object.create(this.world);
        simWorld.zoneDamage = () => 0;
      }
      stepPlayer(p, input, simWorld, TICK_DT, this.rng, this.time);

      // --- footsteps as events (clients play audio + anim) ---
      if (p.stepEvent) {
        this.events.push({ t: 'step', id: p.id, surface: p.stepEvent.surface, loud: p.stepEvent.loud, sprint: p.stepEvent.sprint, x: p.x, y: p.y, z: p.z });
        p.stepEvent = null;
      }
      if (p.landAt === this.time && p.landImpact > 0.35) {
        this.events.push({ t: 'land', id: p.id, impact: p.landImpact, x: p.x, y: p.y, z: p.z });
      }

      // --- loot pickup (proximity + auto-pickup rules) ---
      this.handleLoot(p, input);

      // --- death ---
      if (!p.alive && p.deathInfo) {
        this.events.push({ t: 'death', id: p.id, by: p.deathInfo.by, zone: p.deathInfo.zone, x: p.x, y: p.y, z: p.z, name: p.name });
        const killer = this.players.get(p.deathInfo.by);
        this.events.push({ t: 'kill', id: p.deathInfo.by, victim: p.id, weapon: killer?.lastWeapon });
      }
    }

    this.stepBullets();
    this.recordHistory();
    this.checkWin();
  }

  begin() {
    this.state = 'playing';
    this.plane.t = 0;
    this.events.push({ t: 'matchStart', seed: this.seed, plane: this.plane, at: this.time });
    for (const p of this.players.values()) {
      // Everyone starts in the plane; they pick a drop point.
      p.inPlane = true;
      p.dropped = false;
      const a = this.rng() * Math.PI * 2, r = 1500 + this.rng() * 2500;
      p.dropFrom = { x: clamp(this.rng() * MAP_W * 0.5 - MAP_W * 0.25, -HALF_X + 400, HALF_X - 400),
                      y: clamp(this.rng() * MAP_H * 0.5 - MAP_H * 0.25, -HALF_Y + 400, HALF_Y - 400),
                      alt: 620 };
    }
  }

  /** Player asked to jump from the plane at (x,y). */
  jumpOut(id, x, y) {
    const p = this.players.get(id);
    if (!p || p.dropped) return;
    p.dropped = true;
    p.inPlane = false;
    p.x = clamp(x, -HALF_X + 20, HALF_X - 20);
    p.y = clamp(y, -HALF_Y + 20, HALF_Y - 20);
    p.z = this.world.terrainHeight(p.x, p.y) + 600;   // freefall start
    p.vz = -32;
    p.vx = 0; p.vy = 0;
    p.grounded = false;
    p.dropTarget = { x: p.x, y: p.y };   // canopy steers to the chosen point
    p.chute = false;
    p.chuteAt = 0;
    this.events.push({ t: 'jump', id, x: p.x, y: p.y });
  }

  handleFire(p, input) {
    // No shooting while still aboard the plane. The check must test `dropped`
    // alone: gating on `state === 'playing'` let a player who had not dropped
    // yet fire, because the match is already 'playing' the moment it begins.
    if (!p.dropped) { p.firing = false; return; }
    const wantFire = has(input.buttons, BTN.FIRE);
    const wpnName = p.slot[p.slotIdx];
    if (!wpnName) { p.firing = false; return; }
    const W = WEAPONS[wpnName];
    const res = p.ammo[wpnName] ?? 0;

    // Finish any reload that has come due FIRST.
    //
    // Ordering matters and was previously inverted: the "start a new reload"
    // block ran while a reload was still pending, so a weapon that ran dry
    // restarted its reload timer every tick and NEVER completed. Ammo sat at 0
    // and bots could never shoot again.
    if (p.reloadUntil && p.reloadUntil <= this.time) {
      const W2 = WEAPONS[p.reloadWpn];
      const reserve = p.ammoPool?.[W2.ammo] ?? 0;
      const need = W2.mag - (p.ammo[p.reloadWpn] ?? 0);
      const take = Math.min(need, reserve);
      p.ammo[p.reloadWpn] = (p.ammo[p.reloadWpn] ?? 0) + take;
      p.ammoPool[W2.ammo] = reserve - take;
      this.events.push({ t: 'reloadDone', id: p.id, wpn: p.reloadWpn, rounds: take });
      p.reloadUntil = 0; p.reloadWpn = null;
    }

    // Now start a new reload if needed.
    if (has(input.buttons, BTN.RELOAD) || res === 0) {
      if (p.reloadUntil <= this.time && res < W.mag && (p.ammoPool?.[W.ammo] ?? 0) > 0) {
        p.reloadUntil = this.time + W.reload;
        p.reloadWpn = wpnName;
        this.events.push({ t: 'reload', id: p.id, wpn: wpnName, time: W.reload });
      }
    }
    if (p.reloadUntil > this.time) { p.firing = false; return; }

    const interval = 60 / W.rpm;
    const canFire = wantFire && (W.auto || !p.triggerHeld);
    if (!canFire) { p.triggerHeld = wantFire; p.firing = false; return; }
    if (this.time - p.lastShot < interval) { p.triggerHeld = true; p.firing = false; return; }
    if ((p.ammo[wpnName] ?? 0) <= 0) { p.triggerHeld = true; p.firing = false; return; }

    p.ammo[wpnName]--;
    p.lastShot = this.time;
    p.triggerHeld = true;
    p.firing = true;
    p.lastWeapon = wpnName;
    // Aim comes straight from the authoritative player state.
    const aim = { yaw: p.yaw, pitch: p.pitch };
    const seed = (this.tick * 7919 + p.id * 104729) >>> 0;
    const shots = fireWeapon(p, wpnName, aim, seed, p.ads ?? 0);
    for (const s of shots) {
      // bornAt drives lag-compensated rewind: "where were people when the
      // trigger was pulled", not "where are they when the bullet is tested".
      s.bornAt = this.time;
      s.ox = s.x; s.oy = s.y; s.oz = s.z;    // segment start for this tick
      this.bullets.push(s);
    }
    this.events.push({ t: 'shot', id: p.id, wpn: wpnName, x: p.x, y: p.y, z: p.z + p.eye, yaw: p.yaw, pitch: p.pitch, seed });
  }

  stepBullets() {
    const alive = [];
    for (const b of this.bullets) {
      // Move the round along its segment for this tick, capturing where it
      // started so the capsule test covers the path travelled, not a ray from
      // the end point.
      const speed = Math.hypot(b.vx, b.vy, b.vz) || 1;
      const sx = b.ox ?? b.x, sy = b.oy ?? b.y, sz = b.oz ?? b.z;

      // ---- lag-compensated player hit test against a rewound snapshot ----
      const hit = this.raycastPlayers(b, sx, sy, sz, speed);
      if (hit) {
        const W = WEAPONS[b.wpn];
        const shooter = this.players.get(b.owner);
        const victim = this.players.get(hit.id);
        if (victim && victim.alive && victim.id !== b.owner) {
          const dmg = resolveDamage(W, hit.zone, b.travelled);
          const applied = applyDamage(victim, dmg, shooter, { x: b.x, y: b.y, z: b.z }, hit.zone, this.time);
          this.events.push({ t: 'hit', shooter: b.owner, victim: victim.id, dmg: Math.round(applied), zone: hit.zone,
                             x: b.x, y: b.y, z: b.z, dist: +b.travelled.toFixed(1), wpn: b.wpn });
          // stop the round at the body
          b.x = sx + (b.vx / speed) * hit.t;
          b.y = sy + (b.vy / speed) * hit.t;
          b.z = sz + (b.vz / speed) * hit.t;
          continue;
        }
      }
      // ---- world ----
      const aliveNow = stepBullet(b, TICK_DT, this.world.grid, (x, y) => this.world.terrainHeight(x, y));
      if (aliveNow) { alive.push(b); b.ox = b.x; b.oy = b.y; b.oz = b.z; }
      else if (b.impact) this.events.push({ t: 'impact', x: b.impact.x, y: b.impact.y, z: b.impact.z, mat: b.impact.mat });
    }
    this.bullets = alive;
  }

  /**
   * Lag compensation: rewind every player to where they were when the shooter
   * pulled the trigger, then test the bullet's path against them.
   *
   * The bullet covers ~28 m per 30 Hz tick, so a player standing at, say, 200 m
   * can sit exactly between two tick positions and never be inside a tested
   * segment. The path is therefore subdivided into fixed-length steps: each
   * sub-segment is small enough that nothing can be skipped between samples.
   */
  raycastPlayers(b, sx, sy, sz, speed) {
    const age = Math.max(0, this.time - (b.bornAt ?? this.time));
    const rewindTicks = Math.min(Math.round(age / TICK_DT), Math.round(LAG_COMP_WINDOW / TICK_DT));
    const past = this.snapshotAt(this.tick - rewindTicks);
    const dx = b.vx / speed, dy = b.vy / speed, dz = b.vz / speed;

    // Sample every ~0.75 m so a 0.38 m-wide capsule is never stepped over.
    const segLen = speed * TICK_DT;
    const samples = Math.max(1, Math.ceil(segLen / 0.75));
    const stepLen = segLen / samples;

    let best = null;
    for (let k = 0; k < samples; k++) {
      const px = sx + dx * (k * stepLen);
      const py = sy + dy * (k * stepLen);
      const pz = sz + dz * (k * stepLen);
      for (const s of past) {
        if (s.id === b.owner || !s.alive) continue;
        const p = this.players.get(s.id);
        if (!p) continue;
        const h = rayCapsule(px, py, pz, dx, dy, dz, s.x, s.y, s.z, playerHeight(p), P.radius);
        if (h !== null && h.t <= stepLen && (!best || h.t < best.t)) {
          best = { id: s.id, t: h.t + k * stepLen, zone: h.zone };
        }
      }
      if (best) break;                 // nearest sample wins; stop early
    }
    return best;
  }

  snapshotAt(tick) {
    const h = this.history;
    if (!h.length) return [];
    if (tick >= h[h.length - 1].tick) return h[h.length - 1].snap;
    if (tick <= h[0].tick) return h[0].snap;
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].tick <= tick && tick <= h[i].tick) return h[i].snap;   // nearest-at-or-after
    }
    return h[h.length - 1].snap;
  }

  recordHistory() {
    const snap = [];
    for (const p of this.players.values()) {
      snap.push({ id: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
                  stance: p.stance, hp: Math.round(p.hp), alive: p.alive, dropped: !!p.dropped,
                  vx: +p.vx.toFixed(2), vy: +p.vy.toFixed(2), vz: +p.vz.toFixed(2), yaw: +p.yaw.toFixed(3) });
    }
    this.history.push({ tick: this.tick, time: this.time, snap });
    // 1.5 s of history is plenty for a 1 s rewind window.
    while (this.history.length && this.history[0].tick < this.tick - Math.ceil(1.5 / TICK_DT)) this.history.shift();
  }

  handleLoot(p, input) {
    // Proximity pickup: within 1.9m, auto-pick ammo/meds, weapons need USE
    // (or auto if the slot is empty - PUBG-style "auto-pickup").
    for (const l of this.loot) {
      if (l.taken) continue;
      const d = dist(p.x, p.y, l.x, l.y);
      if (d > 1.9 || Math.abs(l.z - p.z) > 2.6) continue;
      const auto = l.k !== 'weapon';
      const use = has(input.buttons, BTN.USE);
      if (!auto && !use && p.slot[0]) continue;
      if (this.takeLoot(p, l)) {
        l.taken = true;
        this.events.push({ t: 'pickup', id: p.id, item: l, x: l.x, y: l.y, z: l.z });
      }
    }
  }

  takeLoot(p, l) {
    if (l.k === 'weapon') {
      if (!WEAPONS[l.n]) return false;
      const free = p.slot[0] ? (p.slot[1] ? -1 : 1) : 0;
      if (free < 0) return false;
      p.slot[free] = l.n;
      p.slotIdx = free;
      p.ammo[l.n] = WEAPONS[l.n].mag;
      p.ammoPool = p.ammoPool || {};
      p.ammoPool[WEAPONS[l.n].ammo] = (p.ammoPool[WEAPONS[l.n].ammo] || 0) + Math.min(l.q ?? 30, 90);
      return true;
    }
    if (l.k === 'ammo') {
      p.ammoPool = p.ammoPool || {};
      p.ammoPool[l.n] = (p.ammoPool[l.n] || 0) + (l.q ?? 30);
      return true;
    }
    if (l.k === 'armor') {
      if (l.n === 'vest') {
        const pool = ARMOR[l.lvl] ?? 30;
        if (l.lvl < (p.armorLvl || 0)) return false;
        p.armorLvl = l.lvl; p.armor = pool;
      } else {
        const pool = ARMOR[l.lvl] ?? 30;
        if (l.lvl < (p.helmetLvl || 0)) return false;
        p.helmetLvl = l.lvl; p.helmet = pool;
      }
      return true;
    }
    if (l.k === 'med') {
      p.meds[l.n] = (p.meds[l.n] || 0) + (l.q ?? 1);
      return true;
    }
    return false;
  }

  /** Start using a med (client requests; server validates count + time). */
  useMed(id, kind) {
    const p = this.players.get(id);
    if (!p || !p.alive) return false;
    const m = MEDS[kind];
    if (!m || (p.meds[kind] || 0) <= 0) return false;
    if (p.healUntil > this.time) return false;
    p.healKind = kind;
    p.healUntil = this.time + m.time;
    this.events.push({ t: 'useMed', id, kind, time: m.time });
    return true;
  }
  cancelMed(id) {
    const p = this.players.get(id);
    if (p) { p.healUntil = 0; p.healKind = null; }
  }

  checkWin() {
    if (this.state !== 'playing') return;
    const alive = [...this.players.values()].filter(p => p.alive);
    if (alive.length === 1 && this.players.size >= 2) {
      this.state = 'over';
      this.winner = alive[0].id;
      this.events.push({ t: 'matchEnd', winner: alive[0].id, name: alive[0].name, time: this.time });
    } else if (alive.length === 0) {
      this.state = 'over';
      this.winner = null;
      this.events.push({ t: 'matchEnd', winner: null, time: this.time });
    }
  }
}
