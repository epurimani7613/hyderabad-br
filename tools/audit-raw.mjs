// Duplicate + coverage audit for the raw OSM cache.
import fs from 'node:fs';
import path from 'node:path';

const LAT0 = 17.4300, LON0 = 78.4900;
const MLAT = 111320, MLON = 111320 * Math.cos(LAT0 * Math.PI / 180);

const dir = path.resolve('data/raw');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
let total = 0, parsed = 0, broken = 0;
const seen = new Map();
let dupes = 0;

for (const f of files) {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
  catch { broken++; continue; }
  if (!Array.isArray(arr)) { broken++; continue; }
  parsed++;
  for (const w of arr) {
    total++;
    if (seen.has(w.id)) dupes++; else seen.set(w.id, f);
  }
}

console.log('tile files       :', files.length);
console.log('parsed ok        :', parsed, ' broken:', broken);
console.log('way records      :', total);
console.log('unique way ids   :', seen.size);
console.log('duplicate records:', dupes);

const all = [];
for (const f of files) {
  let arr; try { arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  if (Array.isArray(arr)) all.push(...arr);
}

const LM = {
  charminar: [17.6144, 78.4747], hitec: [17.4435, 78.4690], durgam: [17.3380, 78.4400],
  kbr: [17.4125, 78.4710], assembly: [17.4740, 78.4700], secunder: [17.4398, 78.4983],
  kukatpally: [17.4430, 78.4130], gachibowli: [17.4400, 78.3480], uppal: [17.4020, 78.5600],
};
console.log('\nlandmark coverage (ways within radius):');
for (const [name, [lat, lon]] of Object.entries(LM)) {
  const cx = (lon - LON0) * MLON, cy = (lat - LAT0) * MLAT;
  const at = (r) => all.filter(w => Math.abs(w.cx - cx) < r && Math.abs(w.cy - cy) < r);
  const n2 = at(2000), n7 = at(700);
  const bldg = n2.filter(w => w.t.building).length;
  console.log(`  ${name.padEnd(11)} 700m=${String(n7.length).padStart(3)}  2km=${String(n2.length).padStart(4)}  buildings@2km=${String(bldg).padStart(4)}`);
}