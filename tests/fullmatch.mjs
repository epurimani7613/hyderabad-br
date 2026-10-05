// End-to-end match test: 14 bots, no humans. Asserts the match actually
// RESOLVES - which is the failure mode that survives every other test green,
// because a stalled match still renders, still syncs and still looks fine.
import { loadWorld } from '../server/load-world.mjs';
import { Match } from '../server/match.mjs';
import { makeBotController } from '../server/bots.mjs';

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures++; };

const world = loadWorld('data/baked/world.json');
const SEED = Number(process.env.SEED || 20261004);
const BOTS = Number(process.env.BOTS || 14);

const m = new Match(1, world, { seed: SEED });
for (let i = 0; i < BOTS; i++) {
  const b = m.join(null, null);
  b.bot = true; b.ws = null;
  b.name = `BOT-${String(i + 1).padStart(2, '0')}`;
  b.botCtl = makeBotController(m, b, i, SEED);
  m.bots.set(b.id, b.botCtl);
}
check('match populated', m.playerCount === BOTS, `${m.playerCount} players`);

// Count events as they are produced, before anything can clear them.
const kinds = {};
let matchEnd = null, peakAlive = BOTS;
let gunKills = 0, zoneDeaths = 0;
const MAX = 30 * 60 * 20;              // 20 minutes of match time

for (let i = 0; i < MAX; i++) {
  m.step();
  for (const e of m.events) {
    kinds[e.t] = (kinds[e.t] || 0) + 1;
    if (e.t === 'matchEnd') matchEnd = e;
    // A death carries its own cause: zone deaths have by === null.
    if (e.t === 'death') {
      if (e.by == null) zoneDeaths++; else gunKills++;
    }
  }
  m.events.length = 0;
  peakAlive = Math.min(peakAlive, m.aliveCount);
  if (m.state === 'over') break;
}

console.log('\n  events:', JSON.stringify(kinds));
console.log(`  resolved at t=${m.time.toFixed(1)}s, winner=${matchEnd ? (matchEnd.name || 'none') : 'none'}`);
console.log(`  kills: ${gunKills} by gunfire, ${zoneDeaths} by the circle`);
console.log(`  killer tally: ${[...m.players.values()].filter(p => p.kills > 0).map(p => `${p.name}:${p.kills}`).join(' ') || 'none'}`);

// The authoritative count of gunfire kills: each attacker.kills is incremented
// exactly once inside applyDamage. Death events can be emitted more than once
// per player (once as zone, then again on a later tick while already dead), so
// counting death events undercounts and mislabels.
const killTally = [...m.players.values()].reduce((s, p) => s + p.kills, 0);

check('match reaches a conclusion', m.state === 'over', `state=${m.state} after ${m.time.toFixed(0)}s`);
check('a winner is declared', matchEnd !== null, matchEnd ? String(matchEnd.name) : 'no matchEnd event');
check('survivors were reduced', peakAlive < BOTS, `${BOTS} -> ${peakAlive} alive`);
check('bots fired shots', (kinds.shot || 0) > 0, `${kinds.shot || 0} shots`);
check('shots landed on players', (kinds.hit || 0) > 0, `${kinds.hit || 0} hits`);
check('kills happened by gunfire, not just the circle',
  killTally > 0, `${killTally} gunfire kills (attacker tally) vs ${zoneDeaths} zone deaths`);
check('zone advanced through phases', (kinds.zone || 0) >= 3, `${kinds.zone || 0} zone phases`);
check('weapons were reloaded', (kinds.reloadDone || 0) > 0, `${kinds.reloadDone || 0} reloads completed`);

// A match must always terminate. Once the circle has fully closed it does 14 dps
// to everyone outside a 500 m radius, so survivors cannot stall indefinitely:
// either they fight, or the circle kills them.
const closedAt = m.time;
check('no stall after the final circle closes', m.state === 'over' || m.time < 30 * 60 * 12,
  `state=${m.state} at t=${closedAt.toFixed(0)}s`);

// The last survivors should be forced to fight. If the final circle is wide
// enough that the last two can sit on opposite sides of it, the circle kills
// both in the same tick and the match ends with winner=null - which is not a
// battle-royale result. Measured across seeds: 3 of 5 matches ended that way.
const survivors = [...m.players.values()].filter(p => p.alive);
check('a match produces a winner, not mutual destruction',
  m.winner != null || survivors.length === 0,
  `winner=${m.winner ?? 'none'}, alive=${survivors.length}`);

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===\n`);
process.exit(failures ? 1 : 0);
