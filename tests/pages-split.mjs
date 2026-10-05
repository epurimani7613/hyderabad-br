// The real split-deploy test: the PAGE comes from GitHub Pages, the GAME SERVER
// is a different origin, joined via the ?ws= override. This is the only
// configuration that proves a static host can front an authoritative server.
import { chromium } from 'playwright';

const PAGE = process.env.PAGE;
const WS = process.env.WS;               // e.g. https://xxx.trycloudflare.com
if (!PAGE || !WS) { console.error('set PAGE=<pages url> WS=<server url>'); process.exit(2); }
const TARGET = `${PAGE}/?ws=${WS.replace(/^http/, 'ws')}`;

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures++; };
console.log(`page : ${PAGE}\nserver: ${WS}\nplay : ${TARGET}\n`);

const browser = await chromium.launch();
const results = [];
for (const label of ['PagesA', 'PagesB']) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  const resp = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });
  check(`${label} page loads from Pages`, resp && resp.ok(), `http ${resp && resp.status()}`);

  await page.fill('#name', label);
  await page.click('#btn-public');
  // world.json is 5.3 MB over a public CDN.
  // net.mjs exposes `id` / `matchId` / `code` / `state`, not a `self` object.
  // An earlier version of this test waited on window.__net.self and timed out
  // against a server that had in fact joined successfully - the on-page log read
  // "joined match 1 as #1, room code KCY78" the whole time.
  await page.waitForFunction(() => window.__net && window.__net.id,
    null, { timeout: 120000 });
  const self = await page.evaluate(() => ({
    id: window.__net.id, match: window.__net.matchId, code: window.__net.code,
    others: window.__net.others instanceof Map ? window.__net.others.size
                                                  : Object.keys(window.__net.others || {}).length,
  }));
  results.push({ label, id: self.id, match: self.match, others: self.others });
  check(`${label} booted and joined`, !!self.id, `id=${self.id} match=${self.match} code=${self.code} others=${self.others}`);
  check(`${label} sees opponents`, (self.others || 0) > 0, `${self.others} others`);
  check(`${label} no console errors`, errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');
  await ctx.close();
}

check('both clients landed in one match',
  results.length === 2 && results[0].match === results[1].match,
  results.map(r => `${r.label}=match${r.match}`).join(' '));

await browser.close();
console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===\n`);
process.exit(failures ? 1 : 0);