
const mod = require('localtunnel');
const lt = mod.default || mod;
(async () => {
  const r = await lt({ port: 8080 });
  console.log('typeof:', typeof r);
  console.log('keys:', Object.keys(r || {}));
  console.log('str:', String(r));
  console.log('url field:', r && r.url);
  console.log('inspect:', require('util').inspect(r, { depth: 2 }));
})().catch(e => console.log('ERR ' + e.message));
setTimeout(() => process.exit(0), 20000);
