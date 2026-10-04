// Deterministic hit-registration test: two players placed in clear line of sight
// at a known distance, both firing. This isolates the damage pipeline from AI,
// navigation and cover, so a failure here means the maths is wrong rather than
// the bot behaviour.
import { loadWorld } from '../server/load-world.mjs';
import { Match } from '../server/match.mjs';
import { rayCapsule } from '../shared/ballistics.mjs';
import { playerHeight } from '../shared/sim.mjs';
import { P, TICK_DT } from '../shared/config.mjs';

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures++; };

const world = loadWorld('data/baked/world.json');

// ---- 1. primitive level ----
{
  const tz = 644.0, h = 1.80, r = 0.38;
  const chest = rayCapsule(0, 0, tz + 1.0, 1, 0, 0, 50, 0, tz, h, r);
  check('rayCapsule hits a chest-height ray', chest && chest.zone === 'body', JSON.stringify(chest));
  const head = rayCapsule(0, 0, tz + h - 0.13, 1, 0, 0, 50, 0, tz, h, r);
  check('rayCapsule hits a head-height ray', head && head.zone === 'head', JSON.stringify(head));
  const legs = rayCapsule(0, 0, tz + 0.15, 1, 0, 0, 50, 0, tz, h, r);
  check('rayCapsule hits a leg-height ray', legs && legs.zone === 'limb', JSON.stringify(legs));
  const miss = rayCapsule(0, 2.0, tz + 1.0, 1, 0, 0, 50, 0, tz, h, r);
  check('rayCapsule misses a ray 2 m to the side', miss === null, JSON.stringify(miss));
}

// ---- 2. full pipeline: A shoots B in the open ----
// Ranges chosen to stay inside the drop envelope: a 900 m/s round falls ~2 m at
// 200 m and ~6 m at 300 m, so a level shot from the muzzle only reaches a
// same-height target up to roughly 250 m without hold-over.
for (const range of [30, 80, 200]) {
  const m = new Match(range, world, { seed: range });
  const a = m.join(null, 'A'), b = m.join(null, 'B');
  m.state = 'playing';
  for (const p of [a, b]) { p.dropped = true; p.inPlane = false; }
  // Both stand at the same altitude with clear air between them, so the only
  // thing under test is the bullet-to-player intersection and damage maths.
  const LEVEL_Z = 700;
  a.x = 0; a.y = 0; a.z = LEVEL_Z;
  b.x = range; b.y = 0; b.z = LEVEL_Z;
  a.yaw = 0; a.pitch = 0;
  b.yaw = Math.PI; b.pitch = 0;
  a.ads = 1;
  a.slotIdx = 0;
  const wpn = a.slot[0];
  a.ammo[wpn] = 999;

  const startHp = b.hp;
  let hits = 0;
  for (let i = 0; i < 300; i++) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    // Hold over by the drop accumulated over the flight time.
    const drop = 0.5 * 9.81 * (d / 880) ** 2;
    a.yaw = Math.atan2(dy, dx);
    a.pitch = Math.atan2((b.z + 1.05 + drop) - (a.z + a.eye), d);
    m.submitInput(a.id, { seq: i, mx: 0, my: 0, yaw: a.yaw, pitch: a.pitch, buttons: 16 });
    m.submitInput(b.id, { seq: i, mx: 0, my: 0, yaw: b.yaw, pitch: 0, buttons: 0 });
    a.grounded = true; a.z = LEVEL_Z; a.vz = 0;
    b.grounded = true; b.z = LEVEL_Z; b.vz = 0;
    m.step();
    for (const e of m.events) if (e.t === 'hit' && e.victim === b.id) hits++;
    m.events.length = 0;
    if (!b.alive) break;
  }
  const dealt = startHp - b.hp;
  check(`${range}m: shots land on the target`, hits > 0, `${hits} hits, hp ${startHp} -> ${b.hp}`);
  check(`${range}m: damage applied`, dealt > 0, `${dealt.toFixed(0)} total`);
  check(`${range}m: no error state`, Number.isFinite(b.hp), `hp=${b.hp}`);
}

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===\n`);
process.exit(failures ? 1 : 0);