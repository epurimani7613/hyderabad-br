
// Procedural character rig + state machine.
//
// There is no downloaded animation data (no Blender, no mocap in this repo), so
// the character is a jointed procedural mesh animated by a blended state machine:
// locomotion blends walk/run/sprint by speed, crouch and prone lower the root and
// re-pose the legs, the upper body always holds the weapon, and additive layers
// add breathing, recoil kick, landing dip and vault arcs on top.
import * as THREE from 'three';
import { P } from '../../shared/config.mjs';

const SKIN = 0xc08b62;
const SHIRT = 0x3c4f63;
const PANTS = 0x2f3338;
const BOOT = 0x1d1f22;

function mat(color, rough = 0.85) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02 });
}

export class Character {
  constructor(opts = {}) {
    this.root = new THREE.Group();
    this.root.name = 'character';
    this.parts = {};
    this.phase = 0;
    this.recoil = 0;
    this.lean = 0;
    this.landDip = 0;
    this.state = 'idle';
    this.blend = { idle: 1, walk: 0, run: 0, crouch: 0, prone: 0, air: 0 };
    this.build(opts.shirt ?? SHIRT, opts.pants ?? PANTS);
  }

  build(shirtCol, pantsCol) {
    const skinM = mat(SKIN, 0.8), shirtM = mat(shirtCol, 0.9), pantsM = mat(pantsCol, 0.9), bootM = mat(BOOT, 0.7);

    // --- hips (the animation root) ---
    const hips = new THREE.Group();
    hips.position.y = P.crouchHeight;
    this.root.add(hips);
    this.parts.hips = hips;

    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.20, 0.19), pantsM);
    hips.add(pelvis);

    // --- torso ---
    const torso = new THREE.Group();
    torso.position.y = 0.12;
    hips.add(torso);
    this.parts.torso = torso;

    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.44, 0.21), shirtM);
    chest.position.y = 0.22; chest.castShadow = true;
    torso.add(chest);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.08, 0.10), skinM);
    neck.position.y = 0.47; torso.add(neck);

    // --- head ---
    const head = new THREE.Group();
    head.position.y = 0.54;
    torso.add(head);
    this.parts.head = head;
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.23, 0.21), skinM);
    skull.castShadow = true;
    head.add(skull);
    // helmet slot (child mesh, toggled by armour level)
    const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.235, 0.13, 0.245), mat(0x3d4a3a, 0.6));
    helmet.position.y = 0.09; helmet.visible = false;
    head.add(helmet);
    this.parts.helmet = helmet;

    // --- arms ---
    this.parts.armL = this.arm(-1, torso, shirtM, skinM);
    this.parts.armR = this.arm(1, torso, shirtM, skinM);

    // --- legs ---
    this.parts.legL = this.leg(-1, hips, pantsM, bootM);
    this.parts.legR = this.leg(1, hips, pantsM, bootM);

    // --- weapon (held in the right hand) ---
    // parts.armR is {upper, fore, hand}, not a Group — the weapon parents to the
    // hand so it inherits the whole arm chain.
    const weapon = new THREE.Group();
    weapon.position.set(0.02, 0.28, 0.30);
    this.parts.armR.hand.add(weapon);
    this.parts.weapon = weapon;
    const wBody = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.10, 0.62), mat(0x24262a, 0.55));
    weapon.add(wBody);
    const wMag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.08), mat(0x1a1c1f, 0.6));
    wMag.position.set(0, -0.11, 0.02); weapon.add(wMag);
    const wStock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.22), mat(0x3a2f24, 0.85));
    wStock.position.set(0, -0.01, -0.38); weapon.add(wStock);

    // --- muzzle flash (lit for a few ms after firing) ---
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffdd88, transparent: true, opacity: 0 }));
    flash.position.set(0, 0.02, 0.38);
    weapon.add(flash);
    this.parts.flash = flash;
    this.flashT = 0;

    this.root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }

  arm(side, parent, shirtM, skinM) {
    const g = new THREE.Group();
    g.position.set(side * 0.21, 0.40, 0);
    parent.add(g);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.26, 0.10), shirtM);
    upper.position.y = -0.13; g.add(upper);
    const fore = new THREE.Group();
    fore.position.y = -0.26;
    g.add(fore);
    const foreMesh = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.24, 0.09), skinM);
    foreMesh.position.y = -0.12; fore.add(foreMesh);
    const hand = new THREE.Group();
    hand.position.y = -0.25;
    fore.add(hand);
    return { upper: g, fore, hand };
  }

  leg(side, parent, pantsM, bootM) {
    const g = new THREE.Group();
    g.position.set(side * 0.10, -0.08, 0);
    parent.add(g);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.40, 0.13), pantsM);
    thigh.position.y = -0.20; g.add(thigh);
    const shin = new THREE.Group();
    shin.position.y = -0.40;
    g.add(shin);
    const shinMesh = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.38, 0.12), pantsM);
    shinMesh.position.y = -0.19; shin.add(shinMesh);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.22), bootM);
    foot.position.set(0, -0.40, 0.04); shin.add(foot);
    return { upper: g, shin };
  }

  /**
   * Advance the animation by dt using the authoritative player state.
   * Everything here is cosmetic - it never feeds back into the sim.
   */
  update(p, dt, now, opts = {}) {
    const speed = Math.hypot(p.vx, p.vy);
    const moving = speed > 0.35 && p.grounded;
    // Gait frequency scales with speed: 1 stride per ~1.9 m walked.
    const stride = p.stance === 'prone' ? 1.05 : p.sprint > 0.5 ? 2.15 : 1.85;
    if (moving) this.phase += (speed / stride) * dt * Math.PI * 2;

    // ---- state blend weights ----
    const t = {
      idle: (!moving && p.grounded && p.stance === 'stand') ? 1 : 0,
      walk: (moving && speed < 4.4) ? 1 : 0,
      run: (moving && speed >= 4.4) ? 1 : 0,
      crouch: p.stance === 'crouch' ? 1 : 0,
      prone: p.stance === 'prone' ? 1 : 0,
      air: p.grounded ? 0 : 1,
    };
    for (const k in this.blend) this.blend[k] += (t[k] - this.blend[k]) * (1 - Math.exp(-16 * dt));

    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const amp = Math.min(1, speed / P.sprint);
    const b = this.blend;

    // ---- root height + landing dip ----
    this.landDip += ((p.landImpact ? 0.22 : 0) - this.landDip) * (1 - Math.exp(-9 * dt));
    if (now - (p.landAt ?? -99) > 0.25) p.landImpact = 0;
    let hipY = P.crouchHeight;
    hipY = hipY * (1 - b.prone) + 0.22 * b.prone;
    hipY = hipY * (1 - b.crouch * 0.55) + P.crouchHeight * b.crouch * 0.55;
    this.parts.hips.position.y = hipY - this.landDip * b.air;

    // ---- lean into turns + strafe ----
    const targetLean = THREE.MathUtils.clamp(-(p.vx * Math.cos(p.yaw) - p.vy * Math.sin(p.yaw)) * 0.012, -0.28, 0.28);
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-8 * dt));
    this.parts.hips.rotation.z = this.lean * (1 - b.prone);

    // ---- legs: swing opposite to arms ----
    const swing = b.walk * 0.55 + b.run * 0.95 + b.crouch * 0.18;
    const legL = this.parts.legL, legR = this.parts.legR;
    legL.upper.rotation.x = s * swing;
    legR.upper.rotation.x = -s * swing;
    legL.shin.rotation.x = Math.max(0, -Math.sin(this.phase - 0.6)) * swing * 1.25;
    legR.shin.rotation.x = Math.max(0, -Math.sin(this.phase + Math.PI - 0.6)) * swing * 1.25;
    // Airborne tuck.
    legL.upper.rotation.x += b.air * -0.5 + b.prone * 1.2;
    legR.upper.rotation.x += b.air * 0.25 + b.prone * 1.2;
    legL.shin.rotation.x += b.air * 0.9;
    legR.shin.rotation.x += b.air * 0.5;
    // Idle: a relaxed asymmetric stance with breathing.
    const breathe = Math.sin(now * 1.15 + this.phase) * 0.012;
    legL.upper.rotation.x += b.idle * 0.06;
    legR.upper.rotation.x -= b.idle * 0.10;

    // ---- torso: bob + counter-rotation ----
    this.parts.torso.rotation.y = -s * swing * 0.42;
    this.parts.torso.position.y = 0.12 + (moving ? Math.abs(c) * 0.035 * amp : breathe);
    this.parts.torso.rotation.x = b.run * 0.16 + b.crouch * 0.32 + b.prone * 0.9 + b.air * 0.10;

    // ---- head: look along pitch, counter the torso ----
    this.parts.head.rotation.x = -p.pitch * 0.55 - b.run * 0.14;
    this.parts.head.rotation.y = -this.parts.torso.rotation.y * 0.6;

    // ---- arms: weapon hold. Hip-fire low, ADS brings the weapon to centre. ----
    this.recoil = Math.max(0, this.recoil - dt * 7.5);
    if (p.firing) this.recoil = Math.min(1, this.recoil + dt * 12);
    const ads = p.ads ?? 0;
    const aL = this.parts.armL, aR = this.parts.armR;
    // Right hand stays on the grip; left hand supports the fore-end (IK-ish).
    const rShoulderX = -1.05 + ads * 0.52 + b.prone * 0.55;
    const rShoulderZ = -0.34 + ads * 0.20;
    const lShoulderX = -1.18 + ads * 0.62 + b.prone * 0.5;
    const lShoulderZ = 0.42 - ads * 0.26;
    aR.upper.rotation.set(rShoulderX - this.recoil * 0.22, 0, rShoulderZ);
    aL.upper.rotation.set(lShoulderX - this.recoil * 0.12, 0, lShoulderZ);
    aR.fore.rotation.x = -0.55 - ads * 0.28 + this.recoil * 0.5;
    aL.fore.rotation.x = -0.78 - ads * 0.16 + this.recoil * 0.4;
    aL.fore.rotation.z = 0.42 - ads * 0.5;

    // ---- weapon recoil kick + muzzle flash ----
    this.parts.weapon.rotation.x = -this.recoil * 0.35;
    this.parts.weapon.position.z = 0.30 - this.recoil * 0.07;
    if (p.firing) this.flashT = 0.045;
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.parts.flash.material.opacity = Math.max(0, this.flashT / 0.045);
      this.parts.flash.scale.setScalar(0.7 + Math.random() * 0.7);
    } else this.parts.flash.material.opacity = 0;

    // ---- helmet visibility ----
    this.parts.helmet.visible = (p.helmetLvl ?? 0) > 0;

    // ---- vault: tuck and throw the legs forward ----
    const vault = p.vaultT ?? 0;
    if (vault > 0) {
      const k = 1 - vault / 0.42;
      legL.upper.rotation.x = -0.9 * Math.sin(k * Math.PI);
      legR.upper.rotation.x = -0.5 * Math.sin(k * Math.PI);
      this.parts.hips.position.y += Math.sin(k * Math.PI) * 0.12;
    }
  }

  /** Trigger the muzzle flash from outside (a remote player's shot event). */
  flashTrigger() { this.flashT = 0.05; }

  setVisible(v) { this.root.visible = v; }
  dispose() {
    this.root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
}
