// Node-only: read the baked world from disk. Kept out of shared/world.mjs so
// that module stays browser-safe.
import fs from 'node:fs';
import { World } from '../shared/world.mjs';

export function loadWorld(p) {
  return new World(JSON.parse(fs.readFileSync(p, 'utf8')));
}
