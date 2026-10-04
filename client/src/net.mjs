
// Client netcode: prediction, server reconciliation, and entity interpolation.
//
// Model
// -----
//  * Inputs are sampled at a fixed 60 Hz, stamped with a sequence number, and
//    buffered locally.
//  * The local player is predicted forward by replaying unacknowledged inputs
//    through the SAME stepPlayer() the server runs, on every frame.
//  * When a snapshot arrives carrying an authoritative transform + the last
//    processed input seq, we snap to it and re-simulate the remaining buffered
//    inputs. Anything that moves the replayed result back toward the server is
//    the correction; smoothing it over ~100ms is what hides latency.
//  * Remote players are rendered on a 100ms interpolation delay between snapshots.
import { World } from '../../shared/world.mjs';
import { stepPlayer, makePlayer, playerHeight, BTN, has } from '../../shared/sim.mjs';
import { TICK_HZ, TICK_DT, P, MAP_W, MAP_H } from '../../shared/config.mjs';
import { lerp, lerpAngle, clamp } from '../../shared/geometry.mjs';
import { mulberry32 } from '../../shared/rng.mjs';

const INPUT_HZ = 60;
const INPUT_DT = 1 / INPUT_HZ;
const INTERP_DELAY = 0.10;

export class NetClient {
  constructor({ url, world, onEvent, onSnapshot, onSelf }) {
    this.url = url;
    this.world = world;
    this.onEvent = onEvent || (() => {});
    this.onSnapshot = onSnapshot || (() => {});
    this.onSelf = onSelf || (() => {});

    this.ws = null;
    this.id = null;
    this.matchId = null;
    this.code = null;
    this.connected = false;

    this.seq = 1;
    this.pending = [];          // unacknowledged inputs [{seq, ...}]
    this.state = null;          // last authoritative self state
    this.local = null;          // predicted player (shared sim object)
    this.rng = mulberry32(1234);

    this.others = new Map();     // id -> {buf:[snapshots], last}
    this.zone = null;
    this.matchState = 'waiting';
    this.serverTimeOffset = 0;
    this.ping = 0;
    this.rtt = 0;
    this.correction = { x: 0, z: 0, y: 0 };
    this.errorAccum = 0;         // rolling prediction error, for the HUD
    this.recoilKick = 0;
    this.recoilRecover = 0;
    this.desiredYaw = 0; this.desiredPitch = 0;
    this.stick = { mx: 0, my: 0 };
    this.btn = 0;
    this._acc = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => { this.connected = true; resolve(); };
      this.ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')));
      this.ws.onclose = () => { this.connected = false; };
      this.ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
      setTimeout(() => reject(new Error('connect timeout')), 8000);
    });
  }

  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  joinPublic(name) { this.send({ t: 'joinPublic', name }); }
  createRoom(name, code) { this.send({ t: 'createRoom', name, code }); }
  joinRoom(name, code) { this.send({ t: 'joinRoom', name, code }); }
  jump(x, y) { this.send({ t: 'jump', x, y }); }
  useMed(kind) { this.send({ t: 'useMed', kind }); }
  cancelMed() { this.send({ t: 'cancelMed' }); }
  pingNow() { this.send({ t: 'ping', c: performance.now() }); }

  onMessage(m) {
    switch (m.t) {
      case 'hello':
        this.serverTimeOffset = m.serverTime - Date.now();
        this.worldMeta = m.map;
        break;
      case 'joined':
        this.id = m.id; this.matchId = m.matchId; this.code = m.code;
        this.matchState = m.state;
        this.onEvent({ type: 'joined', ...m });
        break;
      case 'roster': this.onEvent({ type: 'roster', players: m.players }); break;
      case 'error': this.onEvent({ type: 'error', msg: m.msg }); break;
      case 'pong': this.rtt = performance.now() - m.c; this.ping = Math.round(this.rtt); break;
      case 'snap': this.onSnapshotMsg(m); break;
    }
  }

  onSnapshotMsg(m) {
    this.matchState = m.state;
    this.zone = m.zone;
    this.state = m.me;

    if (!this.local) {
      // First snapshot: build the predicted player object from server truth.
      this.local = makePlayer(this.id, 'me', m.me.x, m.me.y, m.me.z);
      this.local.id = this.id;
    }

    // --- reconciliation ---
    // Authoritative position, then replay every input the server has not seen.
    const a = this.local;
    a.x = m.me.x; a.y = m.me.y; a.z = m.me.z;
    a.vx = m.me.vx; a.vy = m.me.vy; a.vz = m.me.vz;
    a.hp = m.me.hp; a.boost = m.me.boost;
    a.armor = m.me.armor; a.armorLvl = m.me.armorLvl;
    a.helmet = m.me.helmet; a.helmetLvl = m.me.helmetLvl;
    a.alive = m.me.alive; a.kills = m.me.kills;
    a.slot = m.me.slot; a.slotIdx = m.me.slotIdx;
    a.ammo = m.me.ammo; a.ammoPool = m.me.ammoPool; a.meds = m.me.meds;
    a.stance = m.me.stance; a.grounded = m.me.grounded;
    a.sprint = m.me.sprint; a.ads = m.me.ads; a.surface = m.me.surface;
    a.healUntil = m.me.healUntil; a.healKind = m.me.healKind;
    a.reloadUntil = m.me.reloadUntil; a.vaultT = m.me.vaultT;
    a.firing = m.me.firing; a.inPlane = m.me.inPlane; a.dropped = m.me.dropped;

    // Drop inputs the server has already processed.
    const before = this.pending.length;
    this.pending = this.pending.filter(i => i.seq > (m.me.ackSeq ?? 0));
    const acked = before - this.pending.length;
    void acked;

    // Re-simulate the unacknowledged tail.
    // The tick clock must advance, otherwise stepPlayer() sees `now` pinned to
    // zero and timed behaviour (reload, heal, parachute) never fires on the
    // predicted copy.
    this.local.appliedTick = m.tick;
    const nowS = m.time;
    for (const inp of this.pending) {
      stepPlayer(a, inp, this.world, TICK_DT, this.rng, nowS + TICK_DT);
      inp.t = nowS;
    }

    this.onSnapshot(m);
    this.onSelf(a);
  }

  /** Sample and send input at a fixed rate; call once per frame. */
  pumpInput(dt, now) {
    this._acc += dt;
    let sent = 0;
    while (this._acc >= INPUT_DT && sent < 6) {
      this._acc -= INPUT_DT; sent++;
      if (!this.local || !this.local.alive) break;
      const input = {
        t: 'input', seq: this.seq++,
        mx: this.stick.mx, my: this.stick.my,
        yaw: this.desiredYaw, pitch: this.desiredPitch,
        buttons: this.btn,
      };
      this.pending.push(input);
      // Predict one step immediately for zero input latency.
      // Use the last authoritative server time as `now`, so timed logic in the
      // sim (parachute, reload, heal) sees the same clock the server does.
      stepPlayer(this.local, input, this.world, INPUT_DT, this.rng,
                 (this.lastSnapTime || 0) + INPUT_DT);
      this.local.appliedTick++;
      this.send(input);
    }
    // Trim the buffer if we stalled (tab hidden, GC pause).
    if (this.pending.length > 90) this.pending.splice(0, this.pending.length - 90);
  }

  /** Interpolated transform for a remote player, rendered INTERP_DELAY in the past. */
  sampleOther(id, renderTime) {
    const e = this.others.get(id);
    if (!e || e.buf.length === 0) return null;
    const buf = e.buf;
    if (buf.length === 1) return buf[0];
    // Find the pair bracketing renderTime.
    for (let i = buf.length - 1; i > 0; i--) {
      const a = buf[i - 1], b = buf[i];
      if (renderTime >= a.t && renderTime <= b.t) {
        const k = b.t === a.t ? 0 : (renderTime - a.t) / (b.t - a.t);
        return {
          id,
          x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k),
          yaw: lerpAngle(a.yaw, b.yaw, k),
          stance: b.stance, hp: b.hp, alive: b.alive, kills: b.kills,
          weapon: b.weapon, firing: b.firing, inPlane: b.inPlane,
        };
      }
    }
    return buf[buf.length - 1];
  }

  /** Push snapshot rows for remotes into their interpolation buffers. */
  ingestOthers(rows, time) {
    for (const r of rows) {
      const [id, x, y, z, stance, hp, alive, yaw, kills, weapon, inPlane, firing] = r;
      let e = this.others.get(id);
      if (!e) { e = { buf: [], lastSeen: time }; this.others.set(id, e); }
      const s = { t: time, x, y, z, stance: ['stand', 'crouch', 'prone'][stance] || 'stand',
                  hp, alive: !!alive, yaw, kills, weapon, inPlane: !!inPlane, firing: !!firing };
      // Insert in time order (snapshots can arrive slightly out of order).
      e.buf.push(s);
      while (e.buf.length > 24) e.buf.shift();
      // `last` is the newest known transform; the minimap renders from it.
      e.last = s;
      e.lastSeen = time;
    }
    // Age out players we haven't seen in a while.
    for (const [id, e] of this.others) {
      if (time - e.lastSeen > 3) { this.others.delete(id); this.retired?.(id); }
    }
  }

  get renderTime() {
    const latest = this.lastSnapTime || 0;
    return latest - INTERP_DELAY;
  }
}
