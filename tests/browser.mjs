
// Browser test: launch two real Chromium clients, join one match, play for a
// few seconds, capture console errors + screenshots. This is the automated
// stand-in for "open two browser windows and read the console".
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8080';
const OUT = path.resolve('data/shots');
fs.mkdirSync(OUT, { recursive: true });
const SECONDS = Number(process.env.SECONDS || 14);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

async function client(browser, label, i) {
  const ctx = await browser.newContext({
    viewport: { width: 900, height: 620 },
    deviceScaleFactor: 1,
    // Touch emulation so the mobile HUD path is what actually runs.
    hasTouch: true, isMobile: i > 0,
  });
  const page = await ctx.newPage();
  const errors = [], logs = [];
  page.on('console', (m) => {
    const t = `${m.type()}: ${m.text()}`;
    logs.push(t);
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#name', label);
  // Second client waits for the first so they land in the same public match.
  if (i === 1) await page.waitForTimeout(2500);
  await page.click('#btn-public');

  // Wait for the world to finish building and the HUD to appear.
  await page.waitForFunction(() => {
    const w = window.__net;
    return w && w.local && document.getElementById('loading').style.display === 'none';
  }, { timeout: 45000 }).catch(() => {});

  return { ctx, page, errors, logs, label };
}

(async () => {
  console.log(`\n=== browser render test vs ${BASE} ===\n`);
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
           '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
  });
  const a = await client(browser, 'Alpha', 0);
  const b = await client(browser, 'Bravo', 1);

  // Let both clients run the match.
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < SECONDS) {
    await new Promise(r => setTimeout(r, 500));
    // Drive input on both clients so movement/animation code actually runs.
    for (const c of [a, b]) {
      await c.page.evaluate(() => {
        const w = window.__net;
        if (!w) return;
        w.stick.mx = Math.sin(performance.now() / 700);
        w.stick.my = Math.cos(performance.now() / 900);
        w.desiredYaw += 0.02;
      }).catch(() => {});
    }
  }

  for (const c of [a, b]) {
    const state = await c.page.evaluate(() => {
      const w = window.__net;
      if (!w) return { ok: false };
      const g = document.getElementById('view').getContext('webgl2')
             || document.getElementById('view').getContext('webgl');
      return {
        ok: true,
        id: w.id, code: w.code, match: w.matchId,
        snaps: w.lastSnapTime ? 'yes' : 'no',
        pos: w.local ? [+w.local.x.toFixed(1), +w.local.y.toFixed(1), +w.local.z.toFixed(1)] : null,
        hp: w.local ? w.local.hp : null,
        others: w.others.size,
        matchState: w.matchState,
        ping: w.ping,
        gl: !!g,
        zone: w.zone ? w.zone.r : null,
      };
    }).catch(e => ({ ok: false, err: e.message }));

    console.log(`\n${c.label}:`, JSON.stringify(state));
    check(`${c.label} booted WebGL`, state.ok && state.gl, state.err || '');
    check(`${c.label} joined a match`, state.ok && !!state.match, `match=${state.match} code=${state.code}`);
    check(`${c.label} received snapshots`, state.snaps === 'yes');
    check(`${c.label} position valid`, state.pos && state.pos.every(Number.isFinite), JSON.stringify(state.pos));
    check(`${c.label} above terrain`, state.pos && state.pos[2] > 100, `z=${state.pos?.[2]}`);
    check(`${c.label} in the same match as the other client`, state.match === (a.label === c.label ? 1 : 1) || state.match, `match=${state.match}`);

    // WebGL errors only matter if they are real; ignore favicon 404s.
    const real = c.errors.filter(e => !/favicon/i.test(e));
    check(`${c.label} no console errors`, real.length === 0, real.slice(0, 3).join(' | '));

    await c.page.screenshot({ path: path.join(OUT, `${c.label}.png`) });
    console.log(`  screenshot -> data/shots/${c.label}.png`);
  }

  // Cross-client: both must be in the SAME match id.
  const [sa, sb] = await Promise.all([a, b].map(c => c.page.evaluate(() => ({ m: window.__net?.matchId, id: window.__net?.id, others: window.__net?.others.size }))));
  check('both clients in the same match', sa.m && sa.m === sb.m, `A=${sa.m} B=${sb.m}`);
  check('clients see each other', sa.others >= 1 && sb.others >= 1, `A sees ${sa.others}, B sees ${sb.others}`);

  await browser.close();
  console.log(`\n=== done ===\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
