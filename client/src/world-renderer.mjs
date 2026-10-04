
// Builds the renderable scene from the baked world: terrain mesh, building
// instancing, roads, water, vegetation, and the three hero landmarks.
//
// Performance strategy (mobile first): everything repetitive is an InstancedMesh,
// so the whole 36x44 km map draws in ~25 draw calls instead of ~250k.
import * as THREE from 'three';
import { MAP_W, MAP_H, LANDMARKS } from '../../shared/config.mjs';

const rngFactory = (seed) => {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};

export class WorldRenderer {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.data = world.data;
    this.rnd = rngFactory(0x5EED);
    this.instanced = [];
    this.group = new THREE.Group();
    this.group.name = 'world';
    scene.add(this.group);
  }

  build() {
    this.buildTerrain();
    this.buildBuildings();
    this.buildRoads();
    this.buildWater();
    this.buildVegetation();
    this.buildLandmarks();
    this.buildLoot();
    this.buildZone();
    return this.group;
  }

  // ---------------- terrain ----------------
  buildTerrain() {
    // Chunked heightfield: 8x8 chunks so frustum culling can drop most of the
    // 44 km map every frame. Single 192x192 mesh = 36k verts, always drawn.
    const CH = 12, G = this.world.G;
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.96, metalness: 0.0, flatShading: false,
    });
    const chunkSize = G / CH;
    const group = new THREE.Group();
    for (let cz = 0; cz < CH; cz++) {
      for (let cx = 0; cx < CH; cx++) {
        const seg = chunkSize;
        const g = new THREE.PlaneGeometry(MAP_W / CH, MAP_H / CH, Math.round(seg), Math.round(seg));
        g.rotateX(-Math.PI / 2);
        const pos = g.attributes.position;
        const colors = new Float32Array(pos.count * 3);
        const ox = -MAP_W / 2 + (cx + 0.5) * (MAP_W / CH);
        const oz = -MAP_H / 2 + (cz + 0.5) * (MAP_H / CH);
        for (let i = 0; i < pos.count; i++) {
          const wx = ox + pos.getX(i);
          const wz = oz + pos.getZ(i);
          const h = this.world.terrainHeight(wx, wz);
          pos.setY(i, h);
          // Colour by elevation + moisture: red soil, green scrub, grey rock.
          const rock = THREE.MathUtils.clamp((h - 640) / 160, 0, 1);
          const low = THREE.MathUtils.clamp((600 - h) / 90, 0, 1);
          const r = 0.42 + rock * 0.34 + low * 0.1;
          const g = 0.33 + rock * 0.30 - low * 0.06;
          const b = 0.20 + rock * 0.32 - low * 0.02;
          colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
        }
        g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, mat);
        m.position.set(ox, 0, oz);
        m.receiveShadow = true;
        group.add(m);
      }
    }
    this.group.add(group);
    this.terrain = group;
  }

  // ---------------- buildings ----------------
  buildBuildings() {
    const boxes = this.data.boxes.filter(b => b.bldg);
    // Bucket by material so we get ~5 InstancedMeshes instead of thousands.
    const byMat = new Map();
    for (const b of boxes) {
      const k = b.mat || 'concrete';
      if (!byMat.has(k)) byMat.set(k, []);
      byMat.get(k).push(b);
    }
    const mats = {
      concrete: { color: 0xb9b2a6, roughness: 0.9 },
      brick:    { color: 0xa8765a, roughness: 0.95 },
      glass:    { color: 0x8fc4d8, roughness: 0.12, metalness: 0.85 },
      stone:    { color: 0xc9c2b4, roughness: 0.95 },
      wood:     { color: 0x9a7a52, roughness: 0.9 },
    };
    for (const [k, list] of byMat) {
      const cfg = mats[k] || mats.concrete;
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshStandardMaterial(cfg);
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      inst.castShadow = true; inst.receiveShadow = true;
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      const pos = new THREE.Vector3(), scl = new THREE.Vector3();
      list.forEach((b, i) => {
        const h = Math.max(2, b.top - b.base);
        pos.set(b.x, b.base + h / 2, b.y);
        scl.set(b.r * 2, h, (b.ry ?? b.r) * 2);
        q.identity();
        m4.compose(pos, q, scl);
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;   // one mesh spans the map; culling is manual via chunks
      this.group.add(inst);
      this.instanced.push(inst);
    }
    // Interior decks get their own thin instanced boxes (multi-level floors).
    const decks = boxes.filter(b => b.deck);
    if (decks.length) {
      const g = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshStandardMaterial({ color: 0x8d8478, roughness: 0.92 });
      const inst = new THREE.InstancedMesh(g, mat, decks.length);
      inst.receiveShadow = true;
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
      decks.forEach((b, i) => {
        pos.set(b.x, (b.base + b.top) / 2, b.y);
        scl.set(b.r * 2, Math.max(0.3, b.top - b.base), (b.ry ?? b.r) * 2);
        q.identity(); m4.compose(pos, q, scl); inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      this.group.add(inst);
      this.instanced.push(inst);
    }
  }

  // ---------------- roads ----------------
  buildRoads() {
    // Ribbon meshes per road class, built as a single BufferGeometry each.
    const classes = new Map();
    for (const r of this.data.roads) {
      if (!classes.has(r.cls)) classes.set(r.cls, []);
      classes.get(r.cls).push(r);
    }
    const width = { motorway: 22, primary: 15, secondary: 11, tertiary: 9, street: 6.5, service: 5, path: 3 };
    for (const [cls, list] of classes) {
      const w = width[cls] || 6;
      const verts = [], norms = [], idx = [];
      let base = 0;
      for (const r of list) {
        const g = r.g;
        for (let i = 0; i < g.length - 1; i++) {
          const [x0, z0] = g[i], [x1, z1] = g[i + 1];
          const dx = x1 - x0, dz = z1 - z0;
          const len = Math.hypot(dx, dz) || 1;
          const nx = -dz / len * (w / 2), nz = dx / len * (w / 2);
          const y0 = this.world.terrainHeight(x0, z0) + 0.12;
          const y1 = this.world.terrainHeight(x1, z1) + 0.12;
          verts.push(x0 - nx, y0, z0 - nz, x1 - nx, y1, z1 - nz, x0 + nx, y0, z0 + nz, x1 + nx, y1, z1 + nz);
          norms.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
          idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
          base += 4;
        }
      }
      if (!verts.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
      geo.setIndex(idx);
      const mat = new THREE.MeshStandardMaterial({
        color: cls === 'path' ? 0x9c8b6a : cls === 'service' ? 0x8e8e8a : 0x4a4a4c,
        roughness: 0.94, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  // ---------------- water ----------------
  buildWater() {
    // One merged plane per lake/river polygon, sitting just under the terrain
    // surface so the basin reads as water.
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2d5a6b, roughness: 0.08, metalness: 0.25,
      transparent: true, opacity: 0.82,
    });
    for (const w of this.data.waters) {
      const g = w.g;
      if (g.length < 3) continue;
      const verts = [], idx = [];
      let cx = 0, cy = 0;
      for (const p of g) { cx += p[0]; cy += p[1]; }
      cx /= g.length; cy /= g.length;
      let base = 0;
      for (let i = 0; i < g.length; i++) {
        const p = g[i];
        const h = this.world.terrainHeight(cx, cy);
        verts.push(p[0], h + 0.6, p[1]);
        if (i > 0) idx.push(base - 1, base, base + 1);
      }
      base = g.length;
      // fan triangulation
      idx.length = 0;
      for (let i = 1; i < g.length - 1; i++) idx.push(0, i, i + 1);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  // ---------------- vegetation ----------------
  buildVegetation() {
    const trees = this.data.trees;
    if (trees.length) {
      // Trunk + canopy merged into one instanced geometry to halve draw calls.
      const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 2.4, 5);
      trunkGeo.translate(0, 1.2, 0);
      const canopyGeo = new THREE.IcosahedronGeometry(1.5, 0);
      canopyGeo.translate(0, 3.0, 0);
      const merged = mergeGeometries([trunkGeo, canopyGeo]);
      const mat = new THREE.MeshStandardMaterial({ color: 0x4a6b3a, roughness: 0.92, flatShading: true });
      const inst = new THREE.InstancedMesh(merged, mat, trees.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
      trees.forEach((t, i) => {
        pos.set(t.x, t.z, t.y);
        scl.set(t.s, t.s * (t.kind ? 1.25 : 1), t.s);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.r * Math.PI * 2);
        m4.compose(pos, q, scl);
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      inst.castShadow = false;
      this.group.add(inst);
    }
    const rocks = this.data.rocks;
    if (rocks.length) {
      const geo = new THREE.DodecahedronGeometry(1, 0);
      const mat = new THREE.MeshStandardMaterial({ color: 0x8b8378, roughness: 0.98, flatShading: true });
      const inst = new THREE.InstancedMesh(geo, mat, rocks.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
      rocks.forEach((t, i) => {
        pos.set(t.x, t.z + t.s * 0.3, t.y);
        scl.set(t.s, t.s * 0.7, t.s);
        q.setFromAxisAngle(new THREE.Vector3(0.3, 1, 0.2).normalize(), t.r * Math.PI * 2);
        m4.compose(pos, q, scl);
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      this.group.add(inst);
    }
  }

  // ---------------- hero landmarks ----------------
  buildLandmarks() {
    for (const L of this.data.landmarks) {
      const g = new THREE.Group();
      switch (L.kind) {
        case 'charminar': this.makeCharminar(g, L); break;
        case 'hitec_towers': this.makeTower(g, L); break;
        case 'cable_bridge': this.makeCableBridge(g, L); break;
        case 'boardwalk': this.makeBoardwalk(g, L); break;
        case 'parking': this.makeParkingDeck(g, L); break;
      }
      g.position.set(L.x, L.z, L.y);
      this.group.add(g);
    }
  }

  // Charminar: four stacked arcades with corner minarets and a bulbous dome.
  makeCharminar(g, L) {
    const stone = new THREE.MeshStandardMaterial({ color: 0xd8cdb4, roughness: 0.95 });
    const S = L.size, H = L.height;
    // Main block: 4 arcaded faces, open at ground level (the real structure is
    // a hollow square with arches on all sides).
    const base = new THREE.Mesh(new THREE.BoxGeometry(S, 3, S), stone);
    base.position.y = 1.5; base.castShadow = true; g.add(base);
    // Arcade columns on each face.
    const colGeo = new THREE.CylinderGeometry(0.5, 0.6, H * 0.62, 8);
    const perFace = 5;
    for (let f = 0; f < 4; f++) {
      const rot = (f / 4) * Math.PI * 2;
      for (let i = 0; i < perFace; i++) {
        const t = (i / (perFace - 1) - 0.5) * (S - 3);
        const x = t, z = (f % 2 === 0 ? 1 : -1) * S / 2;
        const col = new THREE.Mesh(colGeo, stone);
        col.position.set(f % 2 === 0 ? x : z, 3 + H * 0.31, f % 2 === 0 ? z : x);
        col.castShadow = true;
        col.rotation.y = rot;
        g.add(col);
      }
    }
    // Cornice / roof slab.
    const roof = new THREE.Mesh(new THREE.BoxGeometry(S + 1.5, 2.2, S + 1.5), stone);
    roof.position.y = 3 + H * 0.62; roof.castShadow = true; g.add(roof);
    // Dome.
    const dome = new THREE.Mesh(new THREE.SphereGeometry(S * 0.34, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), stone);
    dome.position.y = 3 + H * 0.62 + 1.1; dome.castShadow = true; g.add(dome);
    // Finial.
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.6, 4, 8), stone);
    fin.position.y = 3 + H * 0.62 + 1.1 + S * 0.34 + 2; g.add(fin);
    // Four minarets.
    const minGeo = new THREE.CylinderGeometry(L.minaretR * 0.8, L.minaretR, L.minaretH, 12);
    for (let f = 0; f < 4; f++) {
      const a = Math.PI / 4 + (f / 4) * Math.PI * 2;
      const m = new THREE.Mesh(minGeo, stone);
      m.position.set(Math.cos(a) * S * 0.78, L.minaretH / 2, Math.sin(a) * S * 0.78);
      m.castShadow = true; g.add(m);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(L.minaretR * 0.95, 10, 8), stone);
      cap.position.set(m.position.x, L.minaretH + L.minaretR * 0.4, m.position.z);
      g.add(cap);
    }
    // Staircase to the minarets (visual; the climb itself is platforming).
    const stairMat = new THREE.MeshStandardMaterial({ color: 0xc4b89f, roughness: 0.95 });
    for (let s = 0; s < 14; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(S - 4, 0.5, 1.4), stairMat);
      const t = s / 13;
      step.position.set(0, 3 + t * (H * 0.6), -(S / 2 - 3) + t * 0.9);
      step.castShadow = true;
      g.add(step);
    }
  }

  makeTower(g, L) {
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fd0e0, roughness: 0.08, metalness: 0.9, envMapIntensity: 1.2 });
    const frame = new THREE.MeshStandardMaterial({ color: 0x6e7a80, roughness: 0.4, metalness: 0.7 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(L.r, L.r * 1.06, L.h, 20), glass);
    body.position.y = L.h / 2; body.castShadow = true; g.add(body);
    // Floor bands.
    for (let f = 1; f < L.h / 3.5; f++) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(L.r * 1.01, 0.12, 6, 24), frame);
      band.rotation.x = Math.PI / 2;
      band.position.y = f * 3.5;
      g.add(band);
    }
    const cap = new THREE.Mesh(new THREE.ConeGeometry(L.r * 1.1, L.h * 0.08, 20), frame);
    cap.position.y = L.h + L.h * 0.04; g.add(cap);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, L.h * 0.18, 6), frame);
    mast.position.y = L.h + L.h * 0.17; g.add(mast);
    // Podium.
    const podium = new THREE.Mesh(new THREE.BoxGeometry(L.r * 3, 6, L.r * 3), frame);
    podium.position.y = 3; podium.receiveShadow = true; g.add(podium);
  }

  makeCableBridge(g, L) {
    const steel = new THREE.MeshStandardMaterial({ color: 0x8a9298, roughness: 0.5, metalness: 0.6 });
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x6f6a63, roughness: 0.9 });
    const half = L.span / 2, deckY = 26;
    // Deck.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(L.span, 0.8, L.deckW), deckMat);
    deck.position.y = deckY; deck.rotation.y = -L.angle; deck.castShadow = true; g.add(deck);
    // Towers at each end.
    for (const s of [-1, 1]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(1.6, L.towerH, 1.6), steel);
      t.position.set(s * half * Math.cos(L.angle), deckY + L.towerH / 2, -s * half * Math.sin(L.angle));
      t.castShadow = true; g.add(t);
    }
    // Main catenary cables + hangers.
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, x = -half + t * L.span;
      const sag = Math.sin(t * Math.PI) * (L.towerH * 0.62);
      pts.push(new THREE.Vector3(x, deckY + L.towerH - sag, 0));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.35, 6, false), steel);
    cable.castShadow = true; g.add(cable);
    for (let i = 2; i < 23; i += 2) {
      const p = pts[i];
      const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, deckY + L.towerH - p.y - 0.4, 5), steel);
      hanger.position.set(p.x, (p.y + deckY + 0.4) / 2, 0);
      g.add(hanger);
    }
  }

  makeBoardwalk(g, L) {
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.95 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(L.len, 0.5, 4), wood);
    deck.position.y = 2.2; deck.receiveShadow = true; g.add(deck);
    for (let i = -3; i <= 3; i++) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 4, 6), wood);
      post.position.set(i * (L.len / 7), 0.2, 1.8); g.add(post);
      const post2 = post.clone(); post2.position.z = -1.8; g.add(post2);
    }
  }

  makeParkingDeck(g, L) {
    const conc = new THREE.MeshStandardMaterial({ color: 0x9b968d, roughness: 0.95 });
    for (let l = 0; l < L.levels; l++) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(60, 0.5, 44), conc);
      slab.position.y = l * 4.2; slab.receiveShadow = true; g.add(slab);
      // Ramp wall.
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(10, 0.4, 44), conc);
      ramp.position.set(22, l * 4.2 + 2.1, 0); ramp.rotation.z = 0.18; g.add(ramp);
    }
  }

  // ---------------- loot ----------------
  buildLoot() {
    // Loot uses the server's authoritative list: built here only for the
    // initial view; removed when the server confirms a pickup.
    const g = new THREE.BoxGeometry(0.5, 0.35, 0.7);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.5, emissive: 0x332200 });
    const list = this.data.loot;
    const inst = new THREE.InstancedMesh(g, mat, list.length);
    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    list.forEach((l, i) => {
      // Matrix4.setRotationY/setPosition are chainable scalar setters only —
      // calling setPosition() with no args first nulls the vector and throws.
      // Compose the transform explicitly instead.
      rot.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.id * 0.7);
      pos.set(l.x, l.z + 0.4, l.y);
      m4.compose(pos, rot, scl);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    inst.name = 'loot';
    this.group.add(inst);
    this.lootMesh = inst;
    this.lootIndex = new Map(list.map((l, i) => [l.id, i]));
    this.lootVisible = list.map(() => 1);
  }
  hideLoot(id) {
    const i = this.lootIndex.get(id);
    if (i === undefined) return;
    this.lootVisible[i] = 0;
    this._lootDirty = true;
  }
  flushLoot() {
    if (!this._lootDirty) return;
    const m4 = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    const zero = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < this.lootVisible.length; i++) {
      if (this.lootVisible[i]) continue;
      const l = this.data.loot[i];
      pos.set(l.x, -9999, l.y);
      m4.compose(pos, rot, zero);      // scale 0 = hidden
      this.lootMesh.setMatrixAt(i, m4);
    }
    this.lootMesh.instanceMatrix.needsUpdate = true;
    this._lootDirty = false;
  }

  // ---------------- zone ----------------
  buildZone() {
    // The blue wall: an open cylinder whose radius is driven each frame.
    const geo = new THREE.CylinderGeometry(1, 1, 900, 96, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x3b7dd8, transparent: true, opacity: 0.16,
      side: THREE.BackSide, depthWrite: false,
    });
    this.zoneMesh = new THREE.Mesh(geo, mat);
    this.zoneMesh.frustumCulled = false;
    this.scene.add(this.zoneMesh);
    // Next-circle preview.
    const geo2 = new THREE.CylinderGeometry(1, 1, 900, 64, 1, true);
    const mat2 = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.10, side: THREE.BackSide, depthWrite: false });
    this.nextZoneMesh = new THREE.Mesh(geo2, mat2);
    this.nextZoneMesh.frustumCulled = false;
    this.nextZoneMesh.visible = false;
    this.scene.add(this.nextZoneMesh);
  }
  updateZone(z) {
    if (!z || !this.zoneMesh) return;
    this.zoneMesh.position.set(z.cx, 450, z.cy);
    this.zoneMesh.scale.set(z.r, 1, z.r);
    if (z.nr) {
      this.nextZoneMesh.visible = true;
      this.nextZoneMesh.position.set(z.nx ?? 0, 450, z.ny ?? 0);
      this.nextZoneMesh.scale.set(z.nr, 1, z.nr);
    } else this.nextZoneMesh.visible = false;
  }
}

// Minimal geometry merge (avoids pulling in the addons build for 2 primitives).
function mergeGeometries(geos) {
  let vCount = 0, iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal;
    pos.set(p.array, vo * 3);
    if (n) nor.set(n.array, vo * 3);
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo; }
    else { for (let i = 0; i < p.count; i++) idx[io++] = i + vo; }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
