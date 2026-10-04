
// Bundle the client into one browser-ready ES module with esbuild.
// Three.js is the only external dep; everything else is local.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'client', 'public', 'bundle.js');

const minify = !process.argv.includes('--dev');

await build({
  entryPoints: [path.join(ROOT, 'client', 'src', 'main.mjs')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: OUT,
  minify,
  sourcemap: minify ? false : 'inline',
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: '/* Hyderabad BR — procedural 1:1 battle royale */' },
});

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`bundled -> ${OUT} (${kb} KB, minified=${minify})`);
