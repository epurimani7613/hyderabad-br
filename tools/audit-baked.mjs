// What does the baked world actually contain around each landmark? This is the
// claim we make to the user, so it should be measured from the bake itself.
//
// Radii come from shared/config.mjs, not hardcoded: an earlier version of this
// script used its own smaller radii and reported "0 buildings at HITEC" when 58
// were present just outside the test radius.
import fs from 'node:fs';
import { LANDMARKS } from '../shared/config.mjs';

const w = JSON.parse(fs.readFileSync('data/baked/world.json', 'utf8'));
const bldgs = w.boxes.filter(b => b.bldg);

console.log(`bake: ${bldgs.length} buildings, ${w.roads.length} roads, ${w.boxes.length} boxes\n`);
console.log('landmark          buildings     roads   (radius from config)');
for (const [key, cfg] of Object.entries(LANDMARKS)) {
  const lm = w.lm[key];
  if (!lm) { console.log(`  ${key.padEnd(16)} (not in world)`); continue; }
  const r = cfg.radius;
  const nb = bldgs.filter(b => Math.hypot(b.x - lm.x, b.y - lm.y) < r).length;
  const nr = w.roads.filter(d => d.g.some(p => Math.hypot(p[0] - lm.x, p[1] - lm.y) < r)).length;
  const flag = nb < 20 ? '   <-- sparse' : '';
  console.log(`  ${key.padEnd(16)} ${String(nb).padStart(5)}  @${String(r).padStart(4)}m ${String(nr).padStart(6)}${flag}`);
}

const inAny = Object.entries(LANDMARKS).reduce((s, [k, cfg]) => {
  const lm = w.lm[k];
  return s + (lm ? bldgs.filter(b => Math.hypot(b.x - lm.x, b.y - lm.y) < cfg.radius).length : 0);
}, 0);
console.log(`\nlandmark districts account for ${inAny} of ${bldgs.length} buildings`);