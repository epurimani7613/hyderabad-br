
// Entry point: menu -> connect -> match. Owns the renderer, camera rig, atmosphere,
// audio, and the frame loop that ties prediction to presentation.
import * as THREE from 'three';
import { environmentFromSky } from './pbr.mjs';
import { World } from '../../shared/world.mjs';
import { WorldRenderer } from './world-renderer.mjs';
import { Character } from './character.mjs';
import { NetClient } from './net.mjs';
import { HUD } from './hud.mjs';
import { Audio } from './audio.mjs';
import { BTN, has } from '../../shared/sim.mjs';
import { WEAPONS, MAP_W, MAP_H } from '../../shared/config.mjs';
import { clamp, lerp } from '../../shared/geometry.mjs';

const qs = new URLSearchParams(location.search);
// Relative, not '/data/...': this client is also served from a GitHub Pages
// subpath (https://user.github.io/hyderabad-br/), where a leading slash resolves
// to the domain root and 404s. The ?world= override still wins for split deploys
// where the geometry lives on a different host than the page.
const WORLD_URL = qs.get('world') || './data/baked/world.json';
const WS_URL = qs.get('ws') || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

// ---------------------------------------------------------------- menu
const menu = document.getElementById('menu');
const nameInput = document.getElementById('name');
const roomInput = document.getElementById('roomcode');
const name = (nameInput.value = localStorage.getItem('hyd_name') || 'Player' + (Math.random() * 900 + 100 | 0));
document.getElementById('btn-public').onclick = () => start({ t: 'joinPublic', name });
document.getElementById('btn-create').onclick = () => start({ t: 'createRoom', name, code: roomInput.value.toUpperCase() || undefined });
document.getElementById('btn-join').onclick = () => start({ t: 'joinRoom', name, code: roomInput.value.toUpperCase() });
document.getElementById('btn-bots').onclick = () => start({ t: 'joinPublic', name, bots: true });

const loading = document.getElementById('loading');
const logEl = document.getElementById('log');
function log(msg) {
  logEl.textContent += msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

// Module-scope handlers: NetClient is constructed in start(), so these must
// already be initialised. Declaring them inside launch() put them in the
// temporal dead zone at construction time ("onNetEvent is not defined").
let net = null;
let hud = null;
let audio = null;
let wr = null;                 // world renderer (zone + loot visibility)
let camera = null;             // three.js camera (audio listener position)
let camState = null;           // recoil / shake / fov state
let selfChar = null;
const remoteChars = new Map();
const shots = [];              // muzzle tracer flashes
const impacts = [];

function onNetEvent(e) {
  if (e.type === 'joined') {
    log(`joined match ${e.matchId} as #${e.id}  room code ${e.code}`);
    const rc = document.getElementById('roomcode');
    if (rc) rc.value = e.code;
  }
  if (e.type === 'error') log('server: ' + e.msg);
}

function onSnapshot(s) {
  net.lastSnapTime = s.time;
  net.ingestOthers(s.others || [], s.time);
  wr?.updateZone(s.zone);
  wr?.flushLoot();
  for (const ev of (s.ev || [])) handleEvent(ev, s);
}

function handleEvent(ev, snap) {
  const me = net?.state;
  switch (ev.t) {
    case 'shot': {
      audio?.shot(ev.wpn, ev.x, ev.y, ev.z, camera.position, ev.id === net.id);
      shots.push({ x: ev.x, y: ev.y, z: ev.z, yaw: ev.yaw, pitch: ev.pitch, t: 0, life: 0.09, wpn: ev.wpn, id: ev.id });
      if (ev.id === net.id) {
        const W = WEAPONS[ev.wpn];
        const ads = net.local?.ads ?? 0;
        camState.recoilPitch += W.recoil * (1 - ads * 0.42) * 0.011;
        camState.recoilYaw += (Math.random() - 0.5) * W.recoil * (1 - ads * 0.5) * 0.006;
        camState.shake = Math.min(1.2, camState.shake + 0.25 * (1 - ads * 0.5));
      }
      if (ev.id === net.id) selfChar.flashT = 0.05;
      else remoteChars.get(ev.id)?.flashTrigger();
      break;
    }
    case 'impact':
      impacts.push({ x: ev.x, y: ev.y, z: ev.z, t: 0, mat: ev.mat });
      audio?.impact(ev.mat, ev.x, ev.y, ev.z, camera.position);
      break;
    case 'hit':
      if (ev.shooter === net.id) { hud?.showHit(ev.victim === me?.id); audio?.hitmarker(); }
      break;
    case 'kill':
      hud?.killFeed(`${ev.id === net.id ? 'YOU' : '#' + ev.id} eliminated #${ev.victim}${ev.weapon ? ' · ' + ev.weapon : ''}`);
      break;
    case 'death':
      if (ev.id === net.id) hud?.showDeath(ev.by ? `Eliminated by #${ev.by}` : 'You died');
      break;
    case 'pickup':
      if (ev.id === net.id) { audio?.pickup(); wr.hideLoot(ev.item.id); }
      break;
    case 'zone': log(`zone phase ${ev.phase + 1}: r=${ev.r}m`); break;
    case 'matchStart': hud?.showDrop(true, 'Match started — tap JUMP to drop'); break;
    case 'matchEnd': hud?.showDeath(ev.winner === net.id ? 'VICTORY' : `Winner: ${ev.name || '—'}`); break;
    case 'step': if (ev.id !== net.id) audio?.footstep(ev.surface, ev.loud, ev.x, ev.y, ev.z, camera.position); break;
  }
}

async function start(msg) {
  localStorage.setItem('hyd_name', name);
  menu.style.display = 'none';
  loading.style.display = 'flex';
  try {
    log('loading world ' + WORLD_URL + ' …');
    const res = await fetch(WORLD_URL);
    if (!res.ok) throw new Error('world fetch ' + res.status);
    const data = await res.json();
    log(`world: ${data.meta.counts.buildings} buildings, ${data.meta.counts.loot} loot spawns`);
    const world = new World(data);
    log('connecting to ' + WS_URL + ' …');
    const nc = new NetClient({
      url: WS_URL, world,
      onEvent: onNetEvent,
      onSnapshot: onSnapshot,
      onSelf: () => {},
    });
    // Bind before connecting: snapshots can arrive before launch() assigns it.
    net = nc;
    window.__net = nc;
    await nc.connect();
    nc.send(msg);
    launch(nc, world, data);
  } catch (e) {
    log('ERROR: ' + e.message);
    loading.querySelector('.load-text').textContent = 'Failed: ' + e.message;
    console.error(e);
  }
}

// ---------------------------------------------------------------- game
function launch(netClient, world, data) {
  const net = netClient;
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.12, 26000);

  // --- atmosphere: sun, sky, fog, dynamic day/night + weather ---
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(18000, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(0x3a6ea8) }, bottom: { value: new THREE.Color(0xd9c39a) }, sun: { value: new THREE.Vector3(0, 1, 0) } },
      vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vP; uniform vec3 top; uniform vec3 bottom; uniform vec3 sun;
        void main(){
          vec3 d = normalize(vP);
          float t = clamp(d.y*0.5+0.5, 0.0, 1.0);
          vec3 c = mix(bottom, top, pow(t, 0.8));
          float sd = max(dot(d, normalize(sun)), 0.0);
          c += vec3(1.0,0.85,0.6) * pow(sd, 220.0) * 2.5;      // sun disc
          c += vec3(1.0,0.75,0.5) * pow(sd, 8.0) * 0.28;      // haze
          gl_FragColor = vec4(c, 1.0);
        }`,
    })
  );
  sky.frustumCulled = false;
  scene.add(sky);

  // Image-based lighting. Without an environment map, MeshStandardMaterial
  // renders every metal and glass surface almost black, because there is
  // nothing for it to reflect - which is why the towers and car glass read as
  // dead grey. Built once from the sky shader and refreshed when the day/night
  // cycle crosses a threshold (see the atmosphere update below).
  let envRT = null;
  let lastEnvBucket = -1;
  function refreshEnvironment() {
    const prev = envRT;
    envRT = environmentFromSky(renderer, sky);
    scene.environment = envRT;
    if (prev) prev.dispose();
  }
  refreshEnvironment();

  const sun = new THREE.DirectionalLight(0xfff2d0, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 900;
  sun.shadow.camera.left = -260; sun.shadow.camera.right = 260;
  sun.shadow.camera.top = 260; sun.shadow.camera.bottom = -260;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xbfd6f0, 0x6b5a42, 0.85);
  scene.add(hemi);

  // --- world geometry ---
  wr = new WorldRenderer(scene, world);
  wr.build();
  log(`scene built: ${scene.children.length} top-level nodes, ${renderer.info.render.calls} draw calls`);
  loading.style.display = 'none';

  // --- characters ---
  selfChar = new Character({ shirt: 0x2f6f4f });
  scene.add(selfChar.root);

  // --- camera rig ---
  camState = {
    mode: 'third',           // third | first (ADS)
    yaw: 0, pitch: 0,
    fov: 75, targetFov: 75,
    shake: 0, shakeSeed: Math.random() * 1000,
    recoilPitch: 0, recoilYaw: 0,
    fwd: new THREE.Vector3(), right: new THREE.Vector3(),
    offset: new THREE.Vector3(),
  };

  // --- audio ---
  audio = new Audio();

  // --- HUD ---
  hud = new HUD(document.getElementById('hud'), {
    onLook: (dx, dy) => {
      const sens = 0.0032 * (hud.adsOn ? 0.55 : 1);
      net.desiredYaw += dx * sens;
      net.desiredPitch = clamp(net.desiredPitch - dy * sens, -1.35, 1.35);
    },
    onZoom: (d) => { camState.targetFov = clamp(camState.targetFov + d * 0.05, 55, 90); },
    onJump: () => doJump(),
    onMap: () => hud.closeMedMenu(),
    onHealMenu: () => hud.toggleMedMenu(net.state?.meds || {}),
    onUseMed: (k) => net.useMed(k),
    onSpectate: () => {},
  });
  hud.enableMouseLook(canvas);

  function doJump() {
    const p = net.state;
    if (!p) return;
    // Drop at the aim point projected onto the ground ahead of the plane.
    const d = 1800 + Math.random() * 2600;
    const x = clamp(net.local.x + Math.cos(net.desiredYaw) * d, -MAP_W / 2 + 50, MAP_W / 2 - 50);
    const y = clamp(net.local.y + Math.sin(net.desiredYaw) * d, -MAP_H / 2 + 50, MAP_H / 2 - 50);
    net.jump(x, y);
    hud.showDrop(false);
  }

  // Net event handlers are hoisted to module scope (see top of file): they must
  // exist before NetClient is constructed in start().

  // ---------------- frame loop ----------------
  const clock = new THREE.Clock();
  let acc = 0, frames = 0, fps = 0, fpsT = 0;
  let elapsed = 0;

  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;

    const me = net.local;
    if (!me) return;

    // --- input -> net ---
    net.stick.mx = hud.stick.mx; net.stick.my = hud.stick.my;
    net.btn = hud.buttons | (hud.mouseFire ? 16 : 0);
    hud.adsOn = has(net.btn, BTN.ADS);
    net.pumpInput(dt, elapsed);

    // recoil recovery + camera shake decay
    const rec = 9.0;
    camState.recoilPitch *= Math.max(0, 1 - rec * dt);
    camState.recoilYaw *= Math.max(0, 1 - rec * dt);
    camState.shake = Math.max(0, camState.shake - dt * 3.2);
    camState.targetFov = lerp(camState.targetFov, hud.adsOn ? 52 : 75, 1 - Math.exp(-9 * dt));
    camState.fov = lerp(camState.fov, camState.targetFov, 1 - Math.exp(-9 * dt));
    camera.fov = camState.fov;
    camera.updateProjectionMatrix();

    // --- day/night: an 8-minute cycle, offset so a match BEGINS in daylight ---
    // elev = sin(2*pi*dayT - pi/2) = -cos(2*pi*dayT). Choosing dayT naively
    // (0.18) gives elev = -0.43, i.e. night. dayT = 0.45 puts the sun near
    // zenith (elev ~0.95), so a fresh match is lit like a mid-morning Hyderabad.
    const DAY_OFFSET = 0.45;
    const dayT = ((elapsed / 480) + DAY_OFFSET) % 1;
    const sunAngle = dayT * Math.PI * 2 - Math.PI / 2;
    const elev = Math.sin(sunAngle);
    const warmth = clamp(elev * 2 + 0.4, 0, 1);
    sun.position.set(Math.cos(dayT * Math.PI * 2) * 600, clamp(elev, 0.06, 1) * 700, 300);
    sun.target.position.set(me.x, me.z, me.y);
    sun.intensity = 0.35 + warmth * 2.2;
    sun.color.setHSL(0.09, 0.35 + (1 - warmth) * 0.25, 0.55 + warmth * 0.2);
    hemi.intensity = 0.35 + warmth * 0.6;
    sky.material.uniforms.sun.value.set(Math.cos(dayT * Math.PI * 2), Math.max(elev, 0.02), 0.3).normalize();
    // Keep image-based lighting in step with the sky. Rebuilding the PMREM every
    // frame would be far too slow, so refresh on a coarse bucket of the cycle -
    // reflections only need to be roughly right, not frame-accurate.
    const envBucket = Math.floor(dayT * 8);
    if (envBucket !== lastEnvBucket) { lastEnvBucket = envBucket; refreshEnvironment(); }
    sky.material.uniforms.top.value.setHSL(0.58, 0.45, 0.22 + warmth * 0.35);
    sky.material.uniforms.bottom.value.setHSL(0.09, 0.4, 0.35 + warmth * 0.3);

    // Weather: dust haze by day, monsoon downpour on a longer cycle.
    const rain = weather.rain;
    if (rain > 0.01) {
      scene.fog = new THREE.FogExp2(0x8fa3ad, 0.0009 * rain * 60);
      sun.intensity *= (1 - rain * 0.45);
    } else {
      scene.fog = new THREE.FogExp2(0xc8b79a, 0.00022 * (1 + (1 - warmth) * 1.5));
    }
    if (rain > 0.2 && rainParticles.geometry.attributes.position.count < 9000) growRain(rain);
    if (rain <= 0.2 && rainParticles.visible) rainParticles.visible = false;
    if (rainParticles.visible) updateRain(dt, me);

    // --- camera ---
    const yaw = net.desiredYaw + camState.recoilYaw;
    const pitch = clamp(net.desiredPitch + camState.recoilPitch, -1.4, 1.4);
    const sh = camState.shake;
    const shakeX = sh * Math.sin(elapsed * 61 + camState.shakeSeed) * 0.05;
    const shakeY = sh * Math.sin(elapsed * 47 + camState.shakeSeed * 1.7) * 0.05;

    const adsBlend = me.ads ?? 0;
    const eyeY = me.z + (me.stance === 'crouch' ? 1.15 : me.stance === 'prone' ? 0.42 : 1.62);
    const focus = new THREE.Vector3(me.x, eyeY, me.y);

    if (adsBlend > 0.75) {
      // First-person ADS: eye at the camera, weapon in view.
      camState.mode = 'first';
      camera.position.copy(focus);
    } else {
      camState.mode = 'third';
      // Third-person: orbit behind, pull in when close to geometry.
      const dist = 4.2 - adsBlend * 1.6;
      const height = 1.5 + (me.stance === 'crouch' ? -0.35 : 0) + (me.stance === 'prone' ? -1.0 : 0);
      const dir = new THREE.Vector3(
        -Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch)
      );
      const ideal = focus.clone().add(dir.clone().multiplyScalar(dist));
      ideal.y += height;
      // Simple collision: ray from focus to ideal against the world grid.
      const seg = ideal.clone().sub(focus);
      const len = seg.length() || 1;
      const hit = world.grid.raycast(focus.x, focus.y, focus.z, seg.x / len, seg.y / len, seg.z / len, len,
        (b) => !b.deck && !b.bridge);
      if (hit && hit.t < len) {
        ideal.copy(focus).add(seg.clone().multiplyScalar(Math.max(0.35, hit.t - 0.3) / len));
      }
      camera.position.copy(ideal);
    }
    camera.position.x += shakeX; camera.position.y += shakeY;
    // Look direction: face the aim point, not the orbit direction.
    const lookAt = focus.clone().add(new THREE.Vector3(
      Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)
    ).multiplyScalar(60));
    camera.lookAt(lookAt);

    // Keep the sky + zone centred on the player.
    sky.position.copy(camera.position);
    sun.target.position.set(me.x, me.z, me.y);
    sun.position.set(me.x + 300, 500, me.z + 200);

    // --- self character ---
    selfChar.root.position.set(me.x, me.z, me.y);
    selfChar.root.rotation.y = -yaw + Math.PI / 2;
    selfChar.update(me, dt, elapsed);
    selfChar.setVisible(camState.mode === 'third' && me.alive);

    // --- remote characters ---
    const renderT = net.renderTime;
    for (const [id, e] of net.others) {
      const s = net.sampleOther(id, renderT);
      if (!s) continue;
      let ch = remoteChars.get(id);
      if (!ch) {
        ch = new Character({ shirt: 0x6b3f3f });
        scene.add(ch.root);
        remoteChars.set(id, ch);
        log(`player #${id} in view`);
      }
      ch.root.position.set(s.x, s.z, s.y);
      ch.root.rotation.y = -s.yaw + Math.PI / 2;
      ch.update({ ...s, ads: 0, sprint: 0, pitch: 0 }, dt, elapsed);
      ch.setVisible(s.alive);
    }

    // --- tracers + impact decals ---
    // Muzzle flash tracers: a short stretched quad flying out along the barrel,
    // so a firefight reads clearly without a persistent bullet mesh.
    for (const b of shots) b.t += dt;
    for (let i = shots.length - 1; i >= 0; i--) {
      if (shots[i].t <= shots[i].life) continue;
      const s = shots[i];
      const dist = Math.min(26, s.t * 420);
      const p = new THREE.Vector3(
        s.x + Math.cos(s.yaw) * dist, s.z + 0.05 + Math.sin(s.pitch) * dist, s.y + Math.sin(s.yaw) * dist
      );
      const age = 1 - s.t / s.life;
      const mat = tracerPool.find(mm => !mm.visible);
      if (mat) {
        mat.visible = true;
        mat.position.copy(p);
        mat.quaternion.copy(camera.quaternion);
        mat.scale.set(0.16, 0.16, 2.4 * age + 0.4);
        mat.material.opacity = age * 0.9;
      }
      shots.splice(i, 1);
    }
    // Impact puffs: expanding, fading sphere.
    for (let i = impacts.length - 1; i >= 0; i--) {
      const im = impacts[i];
      im.t += dt;
      if (im.t > 0.55) {
        if (im.mesh) im.mesh.visible = false;   // optional chaining is illegal
        impacts.splice(i, 1);                   // on an assignment target
        continue;
      }
      if (!im.mesh) {
        im.mesh = impactPool.find(mm => !mm.visible);
        if (im.mesh) {
          im.mesh.visible = true;
          im.mesh.position.set(im.x, im.z, im.y);
          im.mesh.material.color.set(im.mat === 'metal' ? 0xfff2c0 : im.mat === 'glass' ? 0xcaf0ff : 0xd8c8a8);
        }
      }
      if (im.mesh) {
        const k = im.t / 0.55;
        im.mesh.scale.setScalar(0.3 + k * 1.9);
        im.mesh.material.opacity = (1 - k) * 0.7;
      }
    }

    // --- HUD ---
    const zone = net.zone;
    const outside = zone && Math.hypot(me.x - zone.cx, me.y - zone.cy) > zone.r;
    const wpn = me.slot?.[me.slotIdx];
    hud.update({
      hp: me.hp, maxHp: 100, armor: me.armor + me.helmet,
      weapon: wpn, ammo: me.ammo?.[wpn] ?? 0,
      reserve: wpn ? (me.ammoPool?.[WEAPONS[wpn]?.ammo] ?? 0) : 0,
      alive: me.alive, aliveCount, zonePhase: zone?.phase ?? 0,
      outsideZone: outside, ping: net.ping, meds: me.meds, boosting: me.boost,
    });
    // ADS reticle tightens.
    const ch = hud.crosshair;
    const spread = (1 - (me.ads ?? 0)) * 26 + 6;
    ch.style.setProperty('--s', spread + 'px');
    ch.classList.toggle('ads', (me.ads ?? 0) > 0.7);

    // entries may briefly lack `last` (a player can appear one snapshot before
    // its transform lands), so filter rather than assume.
    const known = [];
    for (const [id, e] of net.others) if (e.last) known.push(e.last);

    if (frameCount % 4 === 0) {
      hud.drawMinimap({
        cx: me.x, cy: me.y, zone, selfId: net.id, yaw,
        range: 2600, players: known,
        loot: world.data.loot.filter(l => !l.taken),
      });
    }
    // Alive count: 1 (self) + every remote still standing. Derived here rather
    // than from a stale `aliveCount` variable, which was never assigned.
    aliveCount = 1 + known.filter(p => p.alive).length;

    // --- drop screen ---
    const showDrop = net.matchState === 'playing' && me.inPlane;
    hud.showDrop(showDrop, showDrop ? 'Match started — tap JUMP to drop' : '');

    renderer.render(scene, camera);

    // --- fps ---
    frames++; fpsT += dt;
    if (fpsT >= 1) { fps = frames / fpsT; frames = 0; fpsT = 0; }
    frameCount++;
    statsEl.textContent = `${fps.toFixed(0)} fps · ${renderer.info.render.calls} calls · ${net.ping}ms`;
  }

  // --- tracer + impact pools (fixed size, no per-shot allocation) ---
  const TRACERS = 24, IMPACTS = 24;
  const tracerPool = [], impactPool = [];
  {
    const tg = new THREE.CylinderGeometry(0.5, 0.5, 1, 5, 1, true);
    for (let i = 0; i < TRACERS; i++) {
      const m = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({
        color: 0xfff0b0, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      m.visible = false; m.frustumCulled = false;
      scene.add(m); tracerPool.push(m);
    }
    const ig = new THREE.SphereGeometry(0.5, 8, 6);
    for (let i = 0; i < IMPACTS; i++) {
      const m = new THREE.Mesh(ig, new THREE.MeshBasicMaterial({
        color: 0xd8c8a8, transparent: true, opacity: 0.7, depthWrite: false,
      }));
      m.visible = false; m.frustumCulled = false;
      scene.add(m); impactPool.push(m);
    }
  }

  // --- rain ---
  const weather = { rain: 0 };
  setInterval(() => {
    // Hyderabad: harsh dry heat most of the time, monsoon bursts.
    weather.rain = Math.random() < 0.22 ? 0.5 + Math.random() * 0.5 : Math.random() * 0.1;
  }, 45000);

  const rainParticles = (() => {
    const N = 9000;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 120;
      pos[i * 3 + 1] = Math.random() * 60;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 120;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: 0xaecbe0, size: 0.5, transparent: true, opacity: 0.55 });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    p.visible = false;
    scene.add(p);
    return p;
  })();
  function growRain() { rainParticles.visible = true; }
  function updateRain(dt, me) {
    const a = rainParticles.geometry.attributes.position.array;
    for (let i = 0; i < a.length / 3; i++) {
      a[i * 3 + 1] -= (55 + weather.rain * 40) * dt;
      if (a[i * 3 + 1] < 0) { a[i * 3 + 1] = 60; a[i * 3] = (Math.random() - 0.5) * 120; a[i * 3 + 2] = (Math.random() - 0.5) * 120; }
    }
    rainParticles.geometry.attributes.position.needsUpdate = true;
    rainParticles.position.set(me.x, me.z + 2, me.y);
  }

  const statsEl = document.getElementById('stats');
  let frameCount = 0, aliveCount = 0;

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ambient loop
  setInterval(() => net.pingNow(), 2000);
  log('controls: WASD move · mouse look · click fire · right-drag/joystick · C crouch · Z prone · Space jump · Q ADS · R reload · V vault · E use · Tab map');

  // Debug hook: lets the test harness inspect the live scene graph, camera and
  // renderer stats without adding any production-only code paths elsewhere.
  window.__scene = { scene, camera, renderer, world, wr };
  frame();
}
