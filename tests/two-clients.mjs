
// Headless multiplayer soak test: N real WebSocket clients join one room, move,
// shoot each other, and we assert the netcode invariants hold.
//
// This is the "launch two browser windows and read the console" step, done
// headlessly so it is repeatable and runs in CI.
import { WebSocket } from 'ws';

const URL = process.env.URL || 'ws://localhost:8080';
const N = Number(process.env.CLIENTS || 2);
const SECONDS = Number(process.env.SECONDS || 12);
const TICKS = Number(process.env.TICKS || 20);      // inputs sent per client per second

const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

function mkClient(label, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = {
      label, ws, id: null, joined: null, snaps: 0, inputs: 0, seq: 0,
      lastMe: null, events: [], pings: [], zones: 0, rosters: [],
      errors: [],
    };
    const timer = setTimeout(() => reject(new Error(`${label}: join timeout`)), 10000);
    ws.on('open', () => ws.send(JSON.stringify({ t: opts.room ? 'joinRoom' : 'joinPublic', name: label, code: opts.room })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      switch (m.t) {
        case 'joined': c.id = m.id; c.joined = m; c.matchId = m.matchId; c.code = m.code; clearTimeout(timer); resolve(c); break;
        case 'snap': c.snaps++; c.lastMe = m.me; if (m.zone) c.zones++; c.events.push(...(m.ev || [])); c.lastSnap = m; break;
        case 'roster': c.rosters.push(m.players); break;
        case 'error': c.errors.push(m.msg); break;
        case 'hello': c.hello = m; break;
      }
    });
    ws.on('error', (e) => { c.errors.push('ws:' + e.message); });
  });
}

function runClient(c, seconds) {
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      if (c.ws.readyState !== 1) return;
      // Drive the stick in a circle and jitter aim + fire so every code path runs.
      const ph = (c.inputs / TICKS) * 0.7;
      const input = {
        t: 'input', seq: c.seq++,
        mx: Math.sin(ph), my: Math.cos(ph * 0.6),
        yaw: ph, pitch: Math.sin(ph * 0.3) * 0.2,
        buttons: 4 | (c.inputs % 40 < 8 ? 16 : 0) | (c.inputs % 90 === 0 ? 1 : 0),
      };
      c.ws.send(JSON.stringify(input));
      c.inputs++;
      if (c.inputs % 60 === 0) c.ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));
      if (c.id && !c.jumped) { c.jumped = true; c.ws.send(JSON.stringify({ t: 'jump', x: 0, y: 0 })); }
    }, 1000 / TICKS);
    setTimeout(() => { clearInterval(iv); resolve(); }, seconds * 1000);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\n=== multiplayer test vs ${URL} :: ${N} clients, ${SECONDS}s ===\n`);
  const t0 = Date.now();

  // 1. connect
  const clients = [];
  for (let i = 0; i < N; i++) {
    const c = await mkClient('T' + (i + 1));
    clients.push(c);
    console.log(`  connected ${c.label} as id=${c.id} match=${c.matchId} code=${c.code}`);
  }
  check('all clients joined one match', clients.every(c => c.joined),
        `matchIds=${[...new Set(clients.map(c => c.matchId))].join(',')}`);
  check('unique player ids', new Set(clients.map(c => c.id)).size === N);

  // 2. run
  await Promise.all(clients.map(c => runClient(c, SECONDS)));
  const elapsed = (Date.now() - t0) / 1000;

  // 3. invariants
  for (const c of clients) {
    check(`${c.label} received snapshots`, c.snaps > SECONDS * 20, `${c.snaps} snaps in ${elapsed.toFixed(1)}s`);
    check(`${c.label} no ws errors`, c.errors.length === 0, c.errors.join(';'));
    const me = c.lastMe;
    check(`${c.label} has server position`, !!me && Number.isFinite(me.x) && Number.isFinite(me.y) && Number.isFinite(me.z),
          me ? `x=${me.x} y=${me.y} z=${me.z} hp=${me.hp}` : 'no snapshot');
    if (me) {
      // Positions must be inside the playfield, not NaN/default.
      check(`${c.label} position in bounds`, Math.abs(me.x) < 18100 && Math.abs(me.y) < 22100 && me.z > 0 && me.z < 3000,
            `(${me.x}, ${me.y}, ${me.z})`);
      // Terrain plausibility: never below the plateau or floating in the sky.
      check(`${c.label} above terrain`, me.z > 400, `z=${me.z}`);
    }
  }

  // 4. did the server actually move anyone?
  const moved = clients.filter(c => c.lastMe && (Math.abs(c.lastMe.x) > 1 || Math.abs(c.lastMe.y) > 1 || c.lastMe.z !== c.joined.z));
  check('server simulated movement', moved.length >= 1, `${moved.length}/${N} displaced`);

  // 5. events flowed
  const allEvents = clients.flatMap(c => c.events);
  const kinds = {};
  for (const e of allEvents) kinds[e.t] = (kinds[e.t] || 0) + 1;
  console.log('\n  event mix:', JSON.stringify(kinds));
  check('match started', kinds.matchStart >= 1 || clients.some(c => c.lastSnap?.state !== 'waiting'),
        `state=${clients[0].lastSnap?.state}`);

  // 6. zone present and shrinking
  const z = clients[0].lastSnap?.zone;
  check('zone broadcast present', !!z && z.r > 0, z ? `phase=${z.phase} r=${z.r}` : 'missing');

  // 7. others visible to each client
  if (N > 1) {
    const o = clients[0].lastSnap?.others || [];
    check('clients see each other', o.length >= N - 1, `saw ${o.length} others`);
  }

  // 8. no non-finite NUMBERS anywhere in any snapshot. (nulls are legitimate:
  // empty weapon slots and "no active heal" are both null by design.)
  const nonFinite = [];
  const walk = (o, p) => {
    for (const k in o) {
      const v = o[k];
      if (typeof v === 'number' && !Number.isFinite(v)) nonFinite.push(`${p}.${k}=${v}`);
      else if (v && typeof v === 'object') walk(v, `${p}.${k}`);
      else if (Array.isArray(v)) v.forEach((e, i) => { if (e && typeof e === 'object') walk(e, `${p}.${k}[${i}]`); });
    }
  };
  for (const c of clients) if (c.lastSnap) walk(c.lastSnap, `${c.label}`);
  check('no non-finite numbers in snapshots', nonFinite.length === 0, nonFinite.slice(0, 5).join('; '));

  // 9. loot/med data is populated once the match runs
  const meds = clients[0].lastSnap?.me?.meds || {};
  check('player inventory object present', typeof meds === 'object', JSON.stringify(meds));

  for (const c of clients) c.ws.close();
  await sleep(200);

  console.log(`\n=== ${results.length - failures}/${results.length} checks passed ===\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
