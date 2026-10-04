
import { WebSocket } from 'ws';
const https = process.env.HOST_URL;
if (!https) { console.error('set HOST_URL'); process.exit(2); }
const U = https.replace(/^http/, 'ws');
console.log('dialing', U);
const ws = new WebSocket(U);
const t = setTimeout(()=>{ console.log('TIMEOUT'); process.exit(1); }, 30000);
ws.on('open', () => { console.log('WS OPEN'); ws.send(JSON.stringify({t:'joinPublic', name:'WSTest'})); });
ws.on('message', (r) => {
  const m = JSON.parse(r.toString());
  console.log('MSG', m.t);
  if (m.t === 'joined') { console.log('JOINED match', m.matchId, 'id', m.id); clearTimeout(t); ws.close(); process.exit(0); }
});
ws.on('error', e => { console.log('WS ERROR', e.message); clearTimeout(t); process.exit(1); });
ws.on('close', (c) => console.log('CLOSED', c));
