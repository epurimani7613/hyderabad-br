
// Authoritative match server.
//
// Model: fixed 30 Hz simulation, clients send absolute input per tick and
// receive authoritative snapshots. The server owns health, bullets, loot and the
// blue zone; it never trusts a client position. Hit registration is lag-
// compensated: shots are resolved against a rewound view of every player.
//
// Transport is a WebSocket with length-prefixed binary frames for snapshots and
// JSON for the lobby/control channel.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadWorld } from './load-world.mjs';
import { stepPlayer, makePlayer, applyDamage, playerHeight, BTN, has } from '../shared/sim.mjs';
import { stepBullet, fireWeapon, rayCapsule, resolveDamage, falloff } from '../shared/ballistics.mjs';
import { TICK_HZ, TICK_DT, WEAPONS, AMMO, MEDS, ARMOR, P, ZONE, LANDMARKS, MAX_CLIENT_CATCHUP } from '../shared/config.mjs';
import { clamp, lonLatToM, dist, HALF_X, HALF_Y } from '../shared/geometry.mjs';
import { mulberry32, hashStr } from '../shared/rng.mjs';
import { Match } from './match.mjs';
import { Lobby } from './lobby.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);

// ---------- static file server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  // Serve the client from client/, and the baked world from data/baked/.
  const candidates = [
    path.join(ROOT, 'client', 'public', p),
    path.join(ROOT, 'client', p.replace(/^\//, '')),
    path.join(ROOT, p),
  ];
  for (const file of candidates) {
    if (!file.startsWith(ROOT)) continue;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': p.endsWith('.json') ? 'public,max-age=60' : 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }
  // SPA fallback
  const idx = path.join(ROOT, 'client', 'public', 'index.html');
  if (fs.existsSync(idx)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(idx).pipe(res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

// ---------- boot ----------
console.log('[boot] loading baked world...');
const world = loadWorld(path.join(ROOT, 'data', 'baked', 'world.json'));
console.log(`[boot] world ready: ${world.boxCount} collision boxes, ${world.meta.counts.loot} loot, ${world.meta.counts.buildings} buildings`);

const lobby = new Lobby({ world, tickHz: TICK_HZ });

const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on('connection', (ws, req) => {
  lobby.handleConnection(ws, req);
});

server.listen(PORT, () => {
  console.log(`[boot] listening on http://localhost:${PORT}`);
  console.log(`[boot] open http://localhost:${PORT}/ to play`);
});

process.on('SIGINT', () => { console.log('\n[shutdown]'); process.exit(0); });
process.on('uncaughtException', (e) => { console.error('[fatal]', e); });
