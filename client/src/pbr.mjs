// Procedural PBR material library.
//
// The renderer already used MeshStandardMaterial, but every surface was a flat
// colour with a constant roughness - which is why the city looked like coloured
// plastic. Real PBR needs three things this file supplies:
//
//   1. Albedo/roughness/normal maps, generated on a canvas at load time so the
//      build has no binary texture dependencies.
//   2. An environment map, so metal and glass have something to reflect.
//      MeshStandardMaterial without an envMap renders metal as near-black.
//   3. Material classes keyed off the OSM `building:material` / surface tags the
//      baker already emits, falling back to a per-building hash so a block does
//      not look uniform.

import * as THREE from 'three';

const cache = new Map();

/** Deterministic hash -> [0,1), so a building looks the same every load. */
function hash(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Fill a canvas with value noise at several octaves.
 * Cheap, tileable enough at texture scale, and no dependencies.
 */
function noiseCanvas(size, octaves, contrast, base) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const grids = [];
  for (let o = 0; o < octaves; o++) {
    const n = 4 << o;
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = hash(i * 1.37 + o * 91.7);
    grids.push({ n, g });
  }
  const sample = (gr, u, v) => {
    const { n, g } = gr;
    const x = u * n, y = v * n;
    const x0 = Math.floor(x) % n, y0 = Math.floor(y) % n;
    const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const fx = x - Math.floor(x), fy = y - Math.floor(y);
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = g[y0 * n + x0], b = g[y0 * n + x1], c = g[y1 * n + x0], d = g[y1 * n + x1];
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let amp = 1, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += sample(grids[o], u, v) * amp;
        norm += amp;
        amp *= 0.5;
      }
      let val = (sum / norm - 0.5) * contrast + base;
      val = Math.max(0, Math.min(1, val));
      const i = (y * size + x) * 4;
      const c = (val * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** Sobel a greyscale canvas into a tangent-space normal map. */
function normalFromHeight(heightCanvas, strength = 2.2) {
  const size = heightCanvas.width;
  const src = heightCanvas.getContext('2d').getImageData(0, 0, size, size).data;
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => src[((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      img.data[i] = ((nx * 0.5 + 0.5) * 255) | 0;
      img.data[i + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
      img.data[i + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function tex(canvas, repeat, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Material classes. `rough` is the base roughness; `texScale` is texture repeats
// per metre-ish of surface, tuned so detail reads at street level.
const CLASSES = {
  // --- ground ---
  asphalt:   { color: 0x2e3033, rough: 0.93, metal: 0.02, texScale: 0.09, grain: 0.34, bump: 1.1 },
  concrete:  { color: 0x9a958c, rough: 0.90, metal: 0.02, texScale: 0.07, grain: 0.20, bump: 0.9 },
  dirt:      { color: 0x8a6f4e, rough: 0.98, metal: 0.00, texScale: 0.05, grain: 0.38, bump: 1.6 },
  grass:     { color: 0x4a6b3a, rough: 0.95, metal: 0.00, texScale: 0.06, grain: 0.30, bump: 0.7 },
  gravel:    { color: 0x8f887c, rough: 0.97, metal: 0.00, texScale: 0.10, grain: 0.42, bump: 2.0 },
  // --- buildings ---
  plaster:   { color: 0xc9bda6, rough: 0.86, metal: 0.00, texScale: 0.05, grain: 0.18, bump: 0.8 },
  brick:     { color: 0x8d5a44, rough: 0.88, metal: 0.00, texScale: 0.07, grain: 0.26, bump: 1.4 },
  concretePanel: { color: 0xa8a49c, rough: 0.82, metal: 0.03, texScale: 0.05, grain: 0.14, bump: 0.7 },
  glass:     { color: 0x8fbcd0, rough: 0.06, metal: 0.92, texScale: 0.03, grain: 0.05, bump: 0.3 },
  steel:     { color: 0x8d949a, rough: 0.38, metal: 0.85, texScale: 0.05, grain: 0.10, bump: 0.5 },
  paintedMetal: { color: 0xb9b3a6, rough: 0.45, metal: 0.55, texScale: 0.05, grain: 0.12, bump: 0.6 },
  stone:     { color: 0xd8cdb4, rough: 0.92, metal: 0.00, texScale: 0.06, grain: 0.22, bump: 1.1 },
  wood:      { color: 0x8a6a45, rough: 0.88, metal: 0.00, texScale: 0.08, grain: 0.30, bump: 1.3 },
  tile:      { color: 0xa8583c, rough: 0.70, metal: 0.02, texScale: 0.09, grain: 0.22, bump: 1.0 },
};

const built = new Map();

/**
 * Build (once) the texture set for a material class.
 * Returns { map, roughnessMap, normalMap }.
 */
function texturesFor(cls) {
  if (built.has(cls)) return built.get(cls);
  const c = CLASSES[cls];
  const S = 128;
  // Albedo: flat colour modulated by fine grain.
  const albedo = noiseCanvas(S, 5, c.grain, 0.5);
  const actx = albedo.getContext('2d');
  const col = new THREE.Color(c.color);
  actx.globalCompositeOperation = 'multiply';
  actx.fillStyle = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
  actx.fillRect(0, 0, S, S);
  // Height for the normal map.
  const height = noiseCanvas(S, 5, c.bump, 0.5);
  // Roughness: same field, remapped around the class roughness so variation is
  // visible but never glossy where it should be matte (or vice versa).
  const rough = noiseCanvas(S, 4, 0.5, 0.5);
  const rctx = rough.getContext('2d');
  const rd = rctx.getImageData(0, 0, S, S);
  for (let i = 0; i < rd.data.length; i += 4) {
    const v = Math.max(0, Math.min(1, c.rough + (rd.data[i] / 255 - 0.5) * 0.30));
    rd.data[i] = rd.data[i + 1] = rd.data[i + 2] = (v * 255) | 0;
    rd.data[i + 3] = 255;
  }
  rctx.putImageData(rd, 0, 0);

  const out = {
    map: tex(albedo, c.texScale * 8, true),
    roughnessMap: tex(rough, c.texScale * 8, false),
    normalMap: tex(normalFromHeight(height, c.bump * 3), c.texScale * 8, false),
  };
  built.set(cls, out);
  return out;
}

/**
 * A MeshStandardMaterial with real maps for the given class.
 * `variant` shifts the tint slightly so a street of identical buildings does not
 * read as one extruded colour.
 */
export function pbrMaterial(cls, variant = 0) {
  const key = `${cls}#${variant % 4}`;
  if (cache.has(key)) return cache.get(key);
  const c = CLASSES[cls] || CLASSES.concrete;
  const t = texturesFor(cls in CLASSES ? cls : 'concrete');
  const col = new THREE.Color(c.color);
  // +/-6% luminance jitter per variant.
  const j = 1 + (hash(variant * 7.3) - 0.5) * 0.12;
  col.multiplyScalar(j);
  const m = new THREE.MeshStandardMaterial({
    color: col,
    roughness: c.rough,
    metalness: c.metal,
    map: t.map,
    roughnessMap: t.roughnessMap,
    normalMap: t.normalMap,
    // Normal maps need tangents; without them three.js derives them per-pixel
    // which is slow on instanced geometry.
    normalScale: new THREE.Vector2(0.8, 0.8),
    envMapIntensity: c.metal > 0.3 ? 1.25 : 0.55,
  });
  cache.set(key, m);
  return m;
}

/** Map an OSM building:material / surface tag to a class, defaulting by hash. */
export function classForTag(tag, seed = 0) {
  const t = (tag || '').toLowerCase();
  if (/glass|glazing|window/.test(t)) return 'glass';
  if (/brick/.test(t)) return 'brick';
  if (/concrete|cement|precast|reinforced/.test(t)) return 'concretePanel';
  if (/steel|metal|aluminium|aluminum/.test(t)) return 'steel';
  if (/wood|timber/.test(t)) return 'wood';
  if (/stone|marble|granite|limestone|sandstone/.test(t)) return 'stone';
  if (/tile|terracotta|clay/.test(t)) return 'tile';
  if (/plaster|stucco|paint|render/.test(t)) return 'plaster';
  if (/mud|brick/.test(t)) return 'brick';
  // No usable tag: pick deterministically so the city has material variety
  // without inventing a tag we do not have.
  const r = hash(seed * 1.7 + 3.1);
  if (r < 0.34) return 'plaster';
  if (r < 0.58) return 'concretePanel';
  if (r < 0.72) return 'brick';
  if (r < 0.85) return 'stone';
  if (r < 0.93) return 'glass';
  return 'paintedMetal';
}

export function surfaceClass(surface) {
  const s = (surface || '').toLowerCase();
  if (/asphalt|paved/.test(s)) return 'asphalt';
  if (/dirt|earth|ground|soil/.test(s)) return 'dirt';
  if (/grass|meadow|lawn|vegetation/.test(s)) return 'grass';
  if (/gravel|pebble|track/.test(s)) return 'gravel';
  return 'concrete';
}

/**
 * Build a PMREM environment from the existing sky shader so metal and glass
 * reflect the actual sky. Without this, MeshStandardMaterial renders every metal
 * surface almost black, which is why the towers looked dead.
 * Pass the sky mesh; we reuse its uniforms so day/night still drives reflections.
 */
export function environmentFromSky(renderer, skyMesh) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tmpScene = new THREE.Scene();
  const clone = skyMesh.clone();
  tmpScene.add(clone);
  const rt = pmrem.fromScene(tmpScene, 0.04);
  pmrem.dispose();
  tmpScene.remove(clone);
  return rt.texture;
}

export const PBR_CLASSES = Object.keys(CLASSES);