
// Room / lobby layer: public matchmaking queue, private room codes, the fixed
// 30 Hz match loop, and snapshot broadcast.
import { TICK_HZ, TICK_DT } from '../shared/config.mjs';
import { Match } from './match.mjs';
import { makeBotController } from './bots.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1

export class Lobby {
  constructor({ world, tickHz = TICK_HZ }) {
    this.world = world;
    this.tickHz = tickHz;
    this.matches = new Map();          // id -> Match
    this.sockets = new Set();          // {ws, player, matchId}
    this.nextMatchId = 1;
    this.accum = 0;
    this.last = process.hrtime.bigint();
    this.timer = setInterval(() => this.loop(), 1000 / tickHz);
    this.stats = { ticks: 0, lateBy: 0 };
  }

  newCode() {
    for (let i = 0; i < 40; i++) {
      let c = '';
      for (let k = 0; k < 5; k++) c += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
      if (![...this.matches.values()].some(m => m.code === c)) return c;
    }
    return 'X' + Date.now().toString(36).slice(-4).toUpperCase();
  }

  createMatch(opts = {}) {
    const MatchCtor = Match;
    const id = this.nextMatchId++;
    const m = new MatchCtor(id, this.world, { ...opts, code: opts.code || this.newCode() });
    this.matches.set(id, m);
    console.log(`[lobby] match ${id} created code=${m.code} private=${!!m.isPrivate}`);
    return m;
  }

  findByCode(code) {
    const c = String(code || '').toUpperCase().trim();
    for (const m of this.matches.values()) if (m.code === c) return m;
    return null;
  }
  /** Oldest non-full public match with room, else a fresh one. */
  publicMatch() {
    let best = null;
    for (const m of this.matches.values()) {
      if (m.isPrivate) continue;
      if (m.state === 'over') continue;
      if (m.playerCount >= m.maxPlayers) continue;
      if (!best || m.playerCount < best.playerCount || (m.playerCount === best.playerCount && m.id < best.id)) best = m;
    }
    return best || this.createMatch({ private: false });
  }

  /**
   * Top a public match up with bots so a solo player still gets a real fight.
   *
   * The cap is on TOTAL occupants (bots + humans) so that a second human joining
   * after the bots land still lands in the SAME match rather than a fresh empty
   * one. Raise BOT_TOTAL to widen the room.
   *
   * Bots are placed in a loose cluster around the first human rather than
   * scattered across the 36x44 km playfield. Even with a hunt mode, players who
   * land 15 km apart may not meet before the zone forces the issue, which makes
   * a "solo practice" match feel empty.
   */
  /** How many total occupants this match should aim for. */
  botTarget(m) {
    return Number(process.env.BOT_TOTAL ?? 14);
  }

  fillBots(m, humanCount) {
    const cap = Math.max(0, Number(process.env.BOT_TOTAL ?? 14));
    if (cap === 0) return;
    const anchor = [...m.players.values()].find(p => !p.bot) || m.players.values().next().value;
    while (m.playerCount < cap) {
      if (!this.addBot(m, anchor)) break;
    }
  }

  addBot(m, anchor) {
    const index = m.botCount;
    const p = m.join(null, null);
    if (!p) return false;
    p.bot = true;
    p.ws = null;
    p.name = `BOT-${(index + 1).toString().padStart(2, '0')}`;
    // Cluster within ~1.5 km of the anchor so bots actually meet each other.
    if (anchor) {
      const a = index * 2.39996;                       // golden-angle spiral
      const r = 120 + index * 118;
      p.x = anchor.x + Math.cos(a) * r;
      p.y = anchor.y + Math.sin(a) * r;
      p.z = this.world.terrainHeight(p.x, p.y) + 0.1;
    }
    p.botCtl = makeBotController(m, p, index);
    m.bots.set(p.id, p.botCtl);
    console.log(`[lobby] added bot ${p.name} to match ${m.id}`);
    return true;
  }

  handleConnection(ws, req) {
    // Registry entries are plain WebSockets; player/match live on the socket
    // itself. Keep this shape consistent - mixing a Set<WebSocket> with
    // {ws,...} wrappers silently broke every send.
    ws.player = null;
    ws.matchId = null;
    ws.isAlive = true;
    ws.on('message', (raw) => {
      try { this.onMessage(ws, raw); }
      catch (e) {
        // These used to be logged at low volume and silently swallowed every
        // player input (a missing import in submitInput). Make it impossible to
        // miss: count them and keep the last few in memory for inspection.
        this.errors = this.errors || [];
        this.errors.push(e);
        if (this.errors.length > 20) this.errors.shift();
        console.error(`[lobby] message handler threw: ${e.message}\n${e.stack?.split('\n')[1] || ''}`);
      }
    });
    ws.on('pong', () => { ws.isAlive = true; ws.lastSeen = Date.now(); });
    ws.on('message', () => { ws.lastSeen = Date.now(); });
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => this.onClose(ws));
    this.sockets.add(ws);
    this.send(ws, { t: 'hello', serverTime: Date.now(), tickHz: this.tickHz, map: this.world.meta });
  }

  onClose(ws) {
    if (ws.player && ws.matchId) {
      const m = this.matches.get(ws.matchId);
      m?.remove(ws.player.id);
      console.log(`[lobby] player ${ws.player.id} left match ${ws.matchId} (${m ? m.aliveCount : 0} alive)`);
    }
    this.sockets.delete(ws);
  }

  onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { t } = msg;

    switch (t) {
      case 'joinPublic': {
        const m = this.publicMatch();
        this.attach(ws, m, msg.name);
        break;
      }
      case 'createRoom': {
        const m = this.createMatch({ private: true, code: msg.code ? String(msg.code).toUpperCase() : undefined, maxPlayers: msg.maxPlayers });
        this.attach(ws, m, msg.name);
        break;
      }
      case 'joinRoom': {
        const m = this.findByCode(msg.code);
        if (!m) return this.send(ws, { t: 'error', msg: 'room not found' });
        if (m.state === 'over') return this.send(ws, { t: 'error', msg: 'match already ended' });
        this.attach(ws, m, msg.name);
        break;
      }
      case 'listRooms': {
        const rooms = [...this.matches.values()]
          .filter(m => !m.isPrivate && m.state !== 'over')
          .map(m => ({ id: m.id, count: m.playerCount, max: m.maxPlayers, state: m.state }));
        this.send(ws, { t: 'rooms', rooms });
        break;
      }
      case 'input': {
        if (!ws.matchId || !ws.player) return;
        this.matches.get(ws.matchId)?.submitInput(ws.player.id, msg);
        break;
      }
      case 'jump': {
        const m = this.matches.get(ws.matchId);
        if (m && ws.player) m.jumpOut(ws.player.id, msg.x, msg.y);
        break;
      }
      case 'useMed': {
        const m = this.matches.get(ws.matchId);
        if (m && ws.player) m.useMed(ws.player.id, msg.kind);
        break;
      }
      case 'cancelMed': {
        const m = this.matches.get(ws.matchId);
        if (m && ws.player) m.cancelMed(ws.player.id);
        break;
      }
      case 'ping': {
        ws.pongSent = Date.now();
        this.send(ws, { t: 'pong', c: msg.c });
        break;
      }
      case 'leave': this.onClose(ws); ws.close(); break;
    }
  }

  attach(ws, m, name) {
    const p = m.join(ws, name);
    if (!p) return this.send(ws, { t: 'error', msg: 'match full' });
    ws.player = p;
    ws.matchId = m.id;
    // Top a match up with bots so a solo player lands in a real fight instead
    // of an empty lobby. Applies to private rooms too.
    if (m.botCount < this.botTarget(m)) this.fillBots(m, m.humanCount);
    this.send(ws, {
      t: 'joined', matchId: m.id, code: m.code, id: p.id, name: p.name,
      state: m.state, players: this.roster(m), zone: m.zone,
    });
    this.broadcast(m, { t: 'roster', players: this.roster(m) });
  }

  roster(m) {
    return [...m.players.values()].map(p => ({ id: p.id, name: p.name, alive: p.alive, kills: p.kills, hp: Math.round(p.hp), ping: p.ping ?? 0 }));
  }

  // ---------- the authoritative loop ----------
  loop() {
    const now = process.hrtime.bigint();
    let dt = Number(now - this.last) / 1e9;
    this.last = now;
    if (dt > 0.25) { this.stats.lateBy++; dt = 0.25; }   // never spiral
    this.accum += dt;
    const step = 1 / this.tickHz;
    let n = 0;
    while (this.accum >= step && n < 5) {
      for (const m of this.matches.values()) m.step();
      this.accum -= step;
      n++;
      this.stats.ticks++;
    }
    this.sendSnapshots();
    this.dropDeadSockets();
  }

  sendSnapshots() {
      for (const m of this.matches.values()) {
        if (!m.playerCount) continue;
        // Snapshot the event list ONCE per tick and hand the same slice to every
        // recipient. Clearing it inside the per-socket loop (as this used to)
        // meant the first socket to be served consumed the events and everyone
        // else saw an empty list - so clients only ever observed their own shots.
        const ev = m.events.slice(-96);
        for (const s of this.sockets) {
          if (s.matchId !== m.id || !s.player) continue;
          this.sendSnapshot(s, m, ev);
        }
        m.events.length = 0;    // per-tick, already flushed to all recipients
      }
    }

    sendSnapshot(sock, m, ev) {
    const me = m.players.get(sock.player.id);
    // Own player gets full state; others get a compact, rate-limited transform.
    const others = [];
    for (const p of m.players.values()) {
      if (p.id === me.id) continue;
      others.push([p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
                   p.stance === 'stand' ? 0 : p.stance === 'crouch' ? 1 : 2,
                   Math.round(p.hp), p.alive ? 1 : 0, +p.yaw.toFixed(2), p.kills, p.lastWeapon || 0,
                   p.inPlane ? 1 : 0, p.firing ? 1 : 0]);
    }
    this.send(sock, {
      t: 'snap',
      tick: m.tick,
      time: +m.time.toFixed(2),
      state: m.state,
      me: {
        id: me.id, x: +me.x.toFixed(3), y: +me.y.toFixed(3), z: +me.z.toFixed(3),
        vx: +me.vx.toFixed(2), vy: +me.vy.toFixed(2), vz: +me.vz.toFixed(2),
        yaw: +me.yaw.toFixed(3), pitch: +me.pitch.toFixed(3),
        hp: Math.round(me.hp), boost: Math.round(me.boost),
        armor: Math.round(me.armor), armorLvl: me.armorLvl,
        helmet: Math.round(me.helmet), helmetLvl: me.helmetLvl,
        stance: me.stance, grounded: me.grounded, sprint: +me.sprint.toFixed(2), ads: +me.ads.toFixed(2),
        slot: me.slot, slotIdx: me.slotIdx, ammo: me.ammo, ammoPool: me.ammoPool || {}, meds: me.meds || {},
        alive: me.alive, kills: me.kills, surface: me.surface,
        healUntil: me.healUntil, healKind: me.healKind,
        reloadUntil: me.reloadUntil, inPlane: !!me.inPlane, dropped: !!me.dropped,
        vaultT: me.vaultT, landImpact: me.landImpact || 0,
        // The client needs this to know which buffered inputs the server has
        // already consumed; without it, reconciliation replays stale inputs and
        // the local player drifts behind authority.
        ackSeq: me.lastInputSeq,
      },
      others,
      zone: { cx: +m.zone.cx.toFixed(0), cy: +m.zone.cy.toFixed(0), r: m.zone.r, phase: m.zone.phase, dps: m.zone.dps,
              nx: m.zone.nextX ?? null, ny: m.zone.nextY ?? null, nr: m.zone.next?.r ?? null },
      ev: ev && ev.length ? ev : undefined,
    });
  }

  broadcast(m, obj) {
    const s = JSON.stringify(obj);
    for (const sock of this.sockets) if (sock.matchId === m.id && sock.readyState === 1) sock.send(s);
  }

  send(sock, obj) {
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj));
  }

  /**
   * Heartbeat. The grace window must be seconds, not ticks: this ran every
   * simulation tick (33 ms) and terminated any socket that had not ponged since
   * the previous tick, which is any connection with real network latency. Every
   * remote client was killed ~1 frame after connecting, while localhost worked
   * fine - the classic "it works on my machine" netcode bug.
   */
  dropDeadSockets() {
    for (const sock of this.sockets) {
      if (sock.isAlive === false && Date.now() - (sock.lastSeen || 0) > 30000) {
        try { sock.terminate(); } catch {}
        this.onClose(sock);
        continue;
      }
      sock.isAlive = false;
      sock.lastSeen = Date.now();
      try { sock.ping(); } catch {}
    }
  }
}
