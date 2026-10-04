
import fs from 'node:fs';
import path from 'node:path';
const LAT0=17.4300, LON0=78.4900;
const MLAT=111320, MLON=111320*Math.cos(LAT0*Math.PI/180);
const dir='data/raw';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
// histogram by latitude band
const bands=new Map();
for(const f of files){
  let arr; try{arr=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));}catch{continue;}
  if(!Array.isArray(arr))continue;
  for(const w of arr){
    const lat=LAT0 + w.cy/MLAT;
    const b=(Math.floor(lat*20)/20).toFixed(2);
    bands.set(b,(bands.get(b)||0)+1);
  }
}
const rows=[...bands.entries()].sort((a,b)=>Number(b[0])-Number(a[0]));
console.log('ways by latitude band (north -> south):');
for(const [lat,n] of rows) console.log(`  ${lat}  ${String(n).padStart(5)} ${'#'.repeat(Math.min(60,Math.round(n/25)))}`);
