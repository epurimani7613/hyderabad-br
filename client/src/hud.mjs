
// Mobile HUD: dual virtual joysticks, action buttons, health/armour, minimap,
// kill feed, and the plane/drop screen. Pointer Events, so touch, pen and mouse
// all work without branching.
import { BTN } from '../../shared/sim.mjs';

export class HUD {
  constructor(root, callbacks) {
    this.root = root;
    this.cb = callbacks;
    this.stick = { mx: 0, my: 0 };
    this.buttons = 0;
    this.activeStick = null;
    this.activeLook = null;
    this.build();
  }

  el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    (parent || this.root).appendChild(e);
    return e;
  }

  build() {
    const r = this.root;
    r.innerHTML = '';

    // ---------- crosshair ----------
    this.crosshair = this.el('div', 'crosshair', r);
    this.crosshair.innerHTML = '<i></i><i></i><i></i><i></i><b></b>';

    // ---------- hit marker ----------
    this.hitmarker = this.el('div', 'hitmarker', r);

    // ---------- left stick (movement) ----------
    this.moveZone = this.el('div', 'zone move-zone', r);
    this.moveBase = this.el('div', 'stick-base', this.moveZone);
    this.moveKnob = this.el('div', 'stick-knob', this.moveBase);
    this.bindStick(this.moveZone, this.moveBase, this.moveKnob, (mx, my) => {
      this.stick.mx = mx; this.stick.my = my;
    }, true);

    // ---------- right stick (look) ----------
    this.lookZone = this.el('div', 'zone look-zone', r);
    this.lookBase = this.el('div', 'stick-base', this.lookZone);
    this.lookKnob = this.el('div', 'stick-knob', this.lookBase);
    this.lookBase.style.display = 'none';   // ADS look is drag-anywhere, not fixed
    this.bindStick(this.lookZone, null, null, (dx, dy) => {
      this.cb.onLook(dx, dy);
    }, false);

    // ---------- action buttons ----------
    const pad = this.el('div', 'actions', r);
    this.btnFire = this.button(pad, 'FIRE', BTN.FIRE, 'fire');
    this.btnAds = this.button(pad, 'ADS', BTN.ADS, 'ads');
    this.btnJump = this.button(pad, 'JUMP', BTN.JUMP, 'jump');
    this.btnCrouch = this.button(pad, 'CROUCH', BTN.CROUCH, 'crouch');
    this.btnReload = this.button(pad, 'RELOAD', BTN.RELOAD, 'reload');
    this.btnVault = this.button(pad, 'VAULT', BTN.VAULT, 'vault');
    this.btnMap = this.button(pad, 'MAP', 0, 'map', () => this.cb.onMap());
    this.btnHeal = this.button(pad, 'MED', 0, 'heal', () => this.cb.onHealMenu());
    this.btnProne = this.button(pad, 'PRONE', BTN.PRONE, 'prone');

    // ---------- status ----------
    this.status = this.el('div', 'status', r);
    this.hpBar = this.el('div', 'bar hp', this.status);
    this.hpFill = this.el('i', null, this.hpBar);
    this.arBar = this.el('div', 'bar ar', this.status);
    this.arFill = this.el('i', null, this.arBar);
    this.weaponBox = this.el('div', 'weapon', r);

    // ---------- minimap ----------
    this.minimap = this.el('canvas', 'minimap', r);
    this.minimap.width = 220; this.minimap.height = 220;
    this.mmCtx = this.minimap.getContext('2d');

    // ---------- top bar ----------
    this.top = this.el('div', 'top', r);
    this.aliveEl = this.el('span', 'stat', this.top, '0 alive');
    this.zoneEl = this.el('span', 'stat', this.top, '');
    this.pingEl = this.el('span', 'stat', this.top, '');

    // ---------- kill feed ----------
    this.feed = this.el('div', 'feed', r);

    // ---------- zone + damage vignette ----------
    this.vignette = this.el('div', 'vignette', r);
    this.zoneWarn = this.el('div', 'zone-warn', r);

    // ---------- plane / drop screen ----------
    this.dropScreen = this.el('div', 'drop-screen', r);
    this.dropScreen.style.display = 'none';
    this.dropMsg = this.el('div', 'drop-msg', this.dropScreen, 'Waiting for players…');
    this.dropBtn = this.el('button', 'drop-btn', this.dropScreen, 'JUMP');
    this.dropBtn.onclick = () => this.cb.onJump();

    // ---------- med picker ----------
    this.medMenu = this.el('div', 'med-menu', r);
    this.medMenu.style.display = 'none';
    this.renderMedMenu({});

    // ---------- death screen ----------
    this.deathScreen = this.el('div', 'death-screen', r);
    this.deathScreen.style.display = 'none';
    this.deathText = this.el('div', 'death-text', this.deathScreen, '');
    this.spectateBtn = this.el('button', 'drop-btn', this.deathScreen, 'SPECTATE');
    this.spectateBtn.onclick = () => { this.deathScreen.style.display = 'none'; this.cb.onSpectate(); };
  }

  button(parent, label, bit, cls, onTap) {
    const b = this.el('button', `btn ${cls}`, parent, label);
    const down = (e) => {
      e.preventDefault();
      b.classList.add('on');
      if (bit) this.buttons |= bit;
      else b.classList.toggle('on');
      onTap?.();
    };
    const up = (e) => {
      e.preventDefault();
      b.classList.remove('on');
      if (bit) this.buttons &= ~bit;
    };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up);
    return b;
  }

  bindStick(zone, base, knob, onMove, isMove) {
    const radius = 62;
    let id = null, ox = 0, oy = 0;
    zone.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      zone.setPointerCapture(id);
      const rect = zone.getBoundingClientRect();
      if (isMove) {
        // Floating origin: the stick centres wherever the thumb lands.
        ox = e.clientX - rect.left; oy = e.clientY - rect.top;
        base.style.left = ox + 'px'; base.style.top = oy + 'px';
        base.style.display = 'block';
      } else {
        ox = e.clientX; oy = e.clientY;
      }
      if (knob) knob.style.transform = 'translate(-50%,-50%)';
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - ox, dy = e.clientY - oy;
      const d = Math.hypot(dx, dy);
      if (d > radius) {
        // Drag outside the radius still tracks (camera keeps turning).
        if (isMove) { ox = e.clientX - (dx / d) * radius; oy = e.clientY - (dy / d) * radius; }
      }
      if (isMove) {
        const nx = (e.clientX - ox) / radius, ny = (e.clientY - oy) / radius;
        const n = Math.min(1, Math.hypot(nx, ny));
        const ang = Math.atan2(ny, nx);
        const cx = Math.cos(ang) * n * radius, cy = Math.sin(ang) * n * radius;
        if (knob) knob.style.transform = `translate(calc(-50% + ${cx}px), calc(-50% + ${cy}px))`;
        // Invert Y: pushing up on screen = forward (-my in the sim).
        onMove(Math.cos(ang) * n, -Math.sin(ang) * n);
      } else {
        onMove(e.clientX - ox, e.clientY - oy);
      }
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      if (isMove) {
        base.style.display = 'none';
        if (knob) knob.style.transform = 'translate(-50%,-50%)';
        this.stick.mx = 0; this.stick.my = 0;
        onMove(0, 0);
      }
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  /** Drag anywhere on the right half to look (desktop mouse also works). */
  enableMouseLook(canvas) {
    let dragging = false, lx = 0, ly = 0;
    canvas.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this.cb.onLook(e.clientX - lx, e.clientY - ly);
      lx = e.clientX; ly = e.clientY;
    });
    // Mouse wheel = zoom in first-person.
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.cb.onZoom(e.deltaY); }, { passive: false });
    // Keyboard for desktop play.
    this.keys = {};
    window.addEventListener('keydown', (e) => { this.keys[e.code] = true; this.syncKeys(); });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; this.syncKeys(); });
  }

  syncKeys() {
    const k = this.keys || {};
    let b = this.buttons;
    const set = (bit, on) => { if (on) b |= bit; else b &= ~bit; };
    set(BTN.JUMP, !!k['Space']);
    set(BTN.CROUCH, !!k['KeyC']);
    set(BTN.SPRINT, !!k['ShiftLeft'] || !!k['ShiftRight']);
    set(BTN.ADS, !!k['KeyQ']);
    set(BTN.RELOAD, !!k['KeyR']);
    set(BTN.VAULT, !!k['KeyV']);
    set(BTN.USE, !!k['KeyE']);
    set(BTN.PRONE, !!k['KeyZ']);
    this.buttons = b;
    // Mouse fire is handled by the main loop.
    this.mouseFire = !!(k['Mouse0']);
  }

  // ---------------- updates ----------------
  update(s) {
    // s: { hp, maxHp, armor, helmet, weapon, ammo, reserve, alive, aliveCount,
    //      zonePhase, outsideZone, ping, meds, boosting }
    const hpPct = Math.max(0, Math.min(100, s.hp));
    this.hpFill.style.width = hpPct + '%';
    this.hpFill.style.background = hpPct < 25 ? '#e5484d' : hpPct < 55 ? '#f5a524' : '#3fb950';
    this.arFill.style.width = Math.max(0, Math.min(100, s.armor)) + '%';
    this.weaponBox.innerHTML =
      `<div class="wname">${s.weapon || '—'}</div>` +
      `<div class="wammo">${s.ammo ?? 0} <span>/ ${s.reserve ?? 0}</span></div>` +
      (s.meds && s.meds.bandage ? `<div class="wmed">🩹 ${s.meds.bandage}</div>` : '') +
      (s.boosting ? `<div class="wboost">+${s.boosting}%</div>` : '');
    this.aliveEl.textContent = `${s.aliveCount} alive`;
    this.pingEl.textContent = `${s.ping} ms`;
    this.zoneEl.textContent = s.outsideZone ? '⚠ OUTSIDE ZONE' : `Zone ${s.zonePhase + 1}`;
    this.zoneEl.classList.toggle('danger', !!s.outsideZone);
    this.vignette.style.opacity = hpPct < 30 ? String((30 - hpPct) / 40) : '0';
    this.zoneWarn.style.display = s.outsideZone ? 'flex' : 'none';
  }

  showHit(killed) {
    this.hitmarker.classList.add('show');
    if (killed) this.hitmarker.classList.add('kill');
    clearTimeout(this._hmT);
    this._hmT = setTimeout(() => {
      this.hitmarker.classList.remove('show', 'kill');
    }, killed ? 420 : 180);
  }

  killFeed(html) {
    const d = this.el('div', 'feed-item', this.feed, html);
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 400); }, 4200);
    while (this.feed.children.length > 5) this.feed.firstChild.remove();
  }

  showDrop(active, msg) {
    this.dropScreen.style.display = active ? 'flex' : 'none';
    if (msg) this.dropMsg.textContent = msg;
  }

  showDeath(text) {
    this.deathScreen.style.display = 'flex';
    this.deathText.textContent = text;
  }

  renderMedMenu(meds) {
    this.medMenu.innerHTML = '';
    const items = [['bandage', '🩹 Bandage'], ['firstaid', '🧰 First Aid'], ['medkit', '🧰 Medkit'], ['energy', '🥤 Energy'], ['painkill', '💊 Painkiller']];
    for (const [k, label] of items) {
      const n = meds[k] || 0;
      const b = this.el('button', `med ${k} ${n ? '' : 'empty'}`, this.medMenu, `${label} ×${n}`);
      b.onclick = () => { this.cb.onUseMed(k); this.medMenu.style.display = 'none'; };
    }
  }
  toggleMedMenu(meds) { this.renderMedMenu(meds); this.medMenu.style.display = this.medMenu.style.display === 'none' ? 'flex' : 'none'; }
  closeMedMenu() { this.medMenu.style.display = 'none'; }

  /**
   * Minimap: draws the zone, nearby landmarks, loot density hints and players.
   * `range` is metres visible across the canvas.
   */
  drawMinimap({ cx, cy, zone, players, selfId, yaw, range, loot }) {
    const c = this.mmCtx, W = this.minimap.width, H = this.minimap.height;
    const s = W / range;
    const toX = (x) => W / 2 + (x - cx) * s;
    const toY = (y) => H / 2 + (y - cy) * s;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#0d1512'; c.fillRect(0, 0, W, H);

    // zone circles
    if (zone) {
      c.strokeStyle = '#4a8fe8'; c.lineWidth = 2;
      c.beginPath(); c.arc(toX(zone.cx), toY(zone.cy), zone.r * s, 0, Math.PI * 2); c.stroke();
      if (zone.nr) {
        c.strokeStyle = '#ffffff'; c.setLineDash([4, 4]); c.lineWidth = 1.5;
        c.beginPath(); c.arc(toX(zone.nx), toY(zone.ny), zone.nr * s, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
      }
    }
    // loot dots
    if (loot) {
      c.fillStyle = 'rgba(255,209,102,0.55)';
      for (const l of loot) {
        if (l.taken) continue;
        const x = toX(l.x), y = toY(l.y);
        if (x < -2 || y < -2 || x > W + 2 || y > H + 2) continue;
        c.fillRect(x, y, 2, 2);
      }
    }
    // other players
    for (const p of players) {
      if (p.id === selfId) continue;
      c.fillStyle = p.alive ? '#e5484d' : '#666';
      c.beginPath(); c.arc(toX(p.x), toY(p.y), 3.5, 0, Math.PI * 2); c.fill();
    }
    // self arrow
    c.save();
    c.translate(W / 2, H / 2);
    c.rotate(yaw);
    c.fillStyle = '#3fb950';
    c.beginPath(); c.moveTo(7, 0); c.lineTo(-4, 4); c.lineTo(-4, -4); c.closePath(); c.fill();
    c.restore();
  }
}
