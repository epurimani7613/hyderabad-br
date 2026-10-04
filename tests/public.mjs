// Verify the game is genuinely playable through the PUBLIC url: two browsers on
// the live tunnel, joining one match and seeing each other. This is the check
// that matters for "give me a link anyone can click".
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://thoughts-similarly-refine-watt.trycloudflare.com';
let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures++; };

async function client(browser, label, delayMs) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('#name', label);
  if (delayMs) await page.waitForTimeout(delayMs);
  await page.click('#btn-public');
  // The baked world is 4.7 MB; over a tunnel that can take a while on first load.
  const ok = await page.waitForFunction(
    () => window.__net?.local && document.getElementById('loading').style.display === 'none',
    { timeout: 180000 }).then(() => true).catch(() => false);
  const diag = await page.evaluate(() => ({
    net: !!window.__net, local: !!window.__net?.local,
    loadTxt: document.querySelector('.load-text')?.textContent || '',
    log: (document.getElementById('log')?.textContent || '').split('\n').slice(-4).join(' | '),
  })).catch(() => ({}));
  console.log(`  [${label}] booted=${ok}`, JSON.stringify(diag));
  return { page, errors, label };
}

(async () => {
  console.log(`\n=== public URL test: ${BASE} ===\n`);
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const a = await client(browser, 'NetA', 0);
  const b = await client(browser, 'NetB', 3000);

  // Play for a bit over the tunnel.
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    await new Promise(r => setTimeout(r, 600));
    for (const c of [a, b]) {
      await c.page.evaluate(() => {
        const w = window.__net; if (!w) return;
        w.stick.mx = Math.sin(performance.now() / 600);
        w.stick.my = 1;
      }).catch(() => {});
    }
  }

  const states = [];
  for (const c of [a, b]) {
    const st = await c.page.evaluate(() => {
      const w = window.__net;
      if (!w) return { ok: false };
      return {
        ok: true, id: w.id, match: w.matchId, code: w.code,
        pos: [Math.round(w.local.x), Math.round(w.local.y), Math.round(w.local.z)],
        hp: w.local.hp, alive: w.local.alive, others: w.others.size, ping: w.ping,
        wss: location.protocol === 'https:' ? 'wss' : 'ws',
      };
    }).catch(e => ({ ok: false, err: e.message }));
    states.push(st);
    console.log(`  ${c.label}:`, JSON.stringify(st));
    check(`${c.label} booted over the public URL`, st.ok, st.err || '');
    check(`${c.label} joined a match`, !!st.match, `match=${st.match} code=${st.code}`);
    check(`${c.label} receives snapshots`, !!st.ping || st.ping === 0, `ping=${st.ping}`);
    check(`${c.label} sees other players`, st.others >= 1, `${st.others} others`);
    const real = c.errors.filter(e => !/favicon/i.test(e));
    check(`${c.label} no console errors`, real.length === 0, real.slice(0, 2).join(' | '));
    await c.page.screenshot({ path: `data/shots/public-${c.label}.png` });
  }

  check('both clients in the same match', states[0].match && states[0].match === states[1].match,
    `${states[0].match} / ${states[1].match}`);

  await browser.close();
  console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===\n`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });