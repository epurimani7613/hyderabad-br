// Persistent localtunnel bridge. Prints the public URL on start.
const mod = require('localtunnel');
const lt = mod.default || mod;
(async () => {
  const r = await lt({ port: Number(process.env.PORT || 8080) });
  console.log('TUNNEL_URL=' + r.url);
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 1 << 30);
