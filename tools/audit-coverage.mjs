// Where does the cached OSM data actually cover the playfield? The fetch has a
// request budget, so it may have exhausted itself on one region and left the
// hero landmarks empty. This quantifies the bias tile by tile.
import fs from 'node:fs';
import path from 'node:path';

const LAT0 = 17.4300, LON0 = 78.4900;
const MAP_W = 36000, MAP_H = 44000;
const MLAT = 111320, MLON = 111320 * Math.cos(LAT0 * Math.PI / 180);
const HALF_LAT = MAP_H / 2 / MLAT, HALF_LON = MAP_W / 2 / MLON;

const dir = path.resolve('data/raw');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

// Bucket every cached way into a coarse grid and report counts per cell.
const GX = 6, GY = 6;
const cells = Array.from({ length: GY }, () => new Array(GX).fill(0));
let total = 0;
for (const f of files) {
  let arr; try { arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  for (const w of arr) {
    total++;
    const gx = Math.floor(((w.cx / MAP_W) + 0.5) * GX);
    const gy = Math.floor(((w.cy / MAP_H) + 0.5) * GY);
    if (gx >= 0 && gx < GX && gy >= 0 && gy < GY) cells[gy][gx]++;
  }
}
console.log('playfield lon', (LON0 - HALF_LON).toFixed(4), '..', (LON0 + HALF_LON).toFixed(4));
console.log('playfield lat', (LAT0 - HALF_LAT).toFixed(4), '..', (LAT0 + HALF_LAT).toFixed(4));
console.log('\nways per cell (rows = north at top, cols = west at left):\n');
process.stdout.write('        ');
for (let x = 0; x < GX; x++) process.stdout.write(String(x).padStart(8));
console.log();
for (let y = 0; y < GY; y++) {
  process.stdout.write(`  lat${y}  `);
  for (let x = 0; x < GX; x++) process.stdout.write(String(cells[y][x]).padStart(8));
  console.log();
}
const counts = cells.flat().filter(c => c > 0);
const empty = cells.flat().filter(c => c === 0).length;
console.log(`\nnon-empty cells: ${counts.length}/${GX * GY}, empty: ${empty}`);
console.log(`median non-empty: ${counts.sort((a, b) => a - b)[counts.length >> 1]}`);

// Where are the landmarks in this grid?
const LM = { charminar: [17.6144, 78.4747], hitec: [17.4435, 78.4690], durgam: [17.3380, 78.4400] };
console.log('\nlandmark cells:');
for (const [name, [lat, lon]] of Object.entries(LM)) {
  const x = (lon - LON0) * MLON, y = (lat - LAT0) * MLAT;
  const gx = Math.floor(((x / MAP_W) + 0.5) * GX);
  const gy = Math.floor(((y / MAP_H) + 0.5) * GY);
  console.log(`  ${name.padEnd(10)} cell[${gy}][${gx}] = ${cells[gy]?.[gx] ?? 'oob'} ways`);
}