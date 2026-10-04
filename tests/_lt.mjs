
const mod = require('localtunnel');
console.log('module keys:', Object.keys(mod), 'type:', typeof mod, 'default:', typeof mod.default);
const lt = mod.default || mod;
try {
  const s = lt({ port: 8080 });
  console.log('returned:', typeof s, s && s.constructor && s.constructor.name);
  if (typeof s.on === 'function') s.on('url', u => console.log('TUNNEL_URL=' + u));
  if (typeof s.then === 'function') s.then(x => console.log('promise resolved', String(x)));
} catch (e) { console.log('ERR', e.message); }
setTimeout(() => process.exit(0), 22000);
