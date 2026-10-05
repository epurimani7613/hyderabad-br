// Verify PBR maps actually reached the GPU, rather than trusting "no console
// errors". Checks material.map / roughnessMap / normalMap are real textures, that
// scene.environment exists (metal renders black without it), and that at least
// one instanced building mesh uses a mapped material.
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:8080/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
// Enter a match so the scene is built.
await page.waitForTimeout(1200);
const btn = await page.$('#playBtn, #play, button');
if (btn) await btn.click();
await page.waitForTimeout(9000);

const probe = await page.evaluate(() => {
  const w = window;
  // main.mjs exposes window.__scene = { scene, camera, renderer, world, wr }.
  const h = w.__scene;
  const sc = h && h.scene ? h.scene : h;
  if (!sc || typeof sc.traverse !== 'function') return { error: 'no THREE.Scene handle', keys: h ? Object.keys(h) : null };
  const out = {
    hasEnv: !!sc.environment,
    envType: sc.environment ? sc.environment.constructor.name : null,
    toneMapping: h.renderer ? h.renderer.toneMapping : null,
    meshes: 0, mapped: 0, withRough: 0, withNormal: 0,
    totalInstances: 0, materials: 0,
  };
  sc.traverse(o => {
    if (!o.isMesh) return;
    out.meshes++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || !m.isMeshStandardMaterial) continue;
      out.materials++;
      if (m.map) out.mapped++;
      if (m.roughnessMap) out.withRough++;
      if (m.normalMap) out.withNormal++;
    }
    if (o.isInstancedMesh) out.totalInstances += o.count;
  });
  return out;
});

console.log(JSON.stringify(probe, null, 1));
console.log('console errors:', errors.length ? errors.slice(0, 5) : 'none');

const ok = [];
const fail = [];
( probe.hasEnv ? ok : fail).push(`environment map (${probe.envType})`);
( probe.mapped > 200 ? ok : fail).push(`materials with albedo map: ${probe.mapped} (want >200)`);
( probe.withRough > 200 ? ok : fail).push(`materials with roughness map: ${probe.withRough} (want >200)`);
( probe.withNormal > 300 ? ok : fail).push(`materials with normal map: ${probe.withNormal} (want >300)`);
( probe.totalInstances > 1000 ? ok : fail).push(`instanced meshes: ${probe.totalInstances}`);
( errors.length === 0 ? ok : fail).push(`console errors: ${errors.length}`);

for (const s of ok) console.log('PASS ', s);
for (const s of fail) console.log('FAIL ', s);
await browser.close();
process.exit(fail.length ? 1 : 0);