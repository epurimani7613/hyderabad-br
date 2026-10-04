
// Procedural WebAudio: no sample files ship with this repo, so every sound is
// synthesised. Gun reports are noise bursts shaped by an exponential envelope
// with per-weapon character; footsteps switch timbre by surface type, which is
// what makes concrete/dirt/stone audibly different.
export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.42;
    // A gentle limiter keeps a firefight from clipping.
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18; this.comp.ratio.value = 8;
    this.master.connect(this.comp);
    this.comp.connect(this.ctx.destination);
    this.enabled = true;
    return this.ctx;
  }

  resume() { const c = this.ensure(); if (c && c.state === 'suspended') c.resume(); }

  noiseBuffer(dur = 0.5) {
    const ctx = this.ctx;
    if (!this._nb || this._nbDur < dur) {
      const n = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this._nb = buf; this._nbDur = dur;
    }
    return this._nb;
  }

  panFor(pos, listener) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    if (!pos || !listener) { g.gain.value = 1; g.connect(this.master); return g; }
    const dx = pos.x - listener.x, dz = pos.z - listener.z;
    const d = Math.hypot(dx, dz);
    // Distance attenuation over ~450m, plus a lowpass that closes with range.
    const atten = Math.max(0, 1 - d / 450) ** 1.7;
    g.gain.value = atten;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(700, 18000 - d * 34);
    g.connect(lp); lp.connect(this.master);
    // Stereo placement relative to where the listener faces.
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = Math.max(-1, Math.min(1, dx / 90)); lp.disconnect(); lp.connect(p); p.connect(this.master); }
    return g;
  }

  // Character of each weapon class: crack, body, tail.
  profile(wpn) {
    switch (wpn) {
      case 'AKM': return { crack: 2600, body: 190, dur: 0.20, punch: 1.0, sub: 0.55 };
      case 'M416': return { crack: 3400, body: 240, dur: 0.16, punch: 0.85, sub: 0.35 };
      case 'SCAR-L': return { crack: 3200, body: 225, dur: 0.16, punch: 0.85, sub: 0.35 };
      case 'SKS': return { crack: 2200, body: 140, dur: 0.30, punch: 1.2, sub: 0.7 };
      case 'KAR98K': return { crack: 1500, body: 90, dur: 0.46, punch: 1.45, sub: 0.9 };
      case 'MP5': return { crack: 3800, body: 330, dur: 0.12, punch: 0.6, sub: 0.25 };
      case 'UMP45': return { crack: 2900, body: 260, dur: 0.14, punch: 0.7, sub: 0.3 };
      case 'VECTOR': return { crack: 4200, body: 360, dur: 0.10, punch: 0.55, sub: 0.2 };
      case 'M870': return { crack: 1400, body: 70, dur: 0.42, punch: 1.6, sub: 1.0 };
      case 'DP28': return { crack: 2100, body: 130, dur: 0.28, punch: 1.3, sub: 0.8 };
      default: return { crack: 2600, body: 180, dur: 0.2, punch: 0.9, sub: 0.5 };
    }
  }

  shot(wpn, x, y, z, listener, isSelf) {
    const ctx = this.ensure(); if (!ctx) return;
    const p = this.profile(wpn);
    const dest = this.panFor(isSelf ? null : { x, z }, listener);
    const t = ctx.currentTime;

    // Transient: filtered noise burst.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.6);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = p.crack; bp.Q.value = 0.8;
    const g = ctx.createGain();
    const vol = (isSelf ? 0.5 : 0.75) * p.punch;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + p.dur);
    src.connect(bp); bp.connect(g); g.connect(dest);
    src.start(t); src.stop(t + p.dur + 0.05);

    // Low thump.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(p.body, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, p.body * 0.35), t + p.dur * 0.8);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 0.7, t);
    og.gain.exponentialRampToValueAtTime(0.0008, t + p.dur);
    osc.connect(og); og.connect(dest);
    osc.start(t); osc.stop(t + p.dur + 0.05);
  }

  impact(mat, x, y, z, listener) {
    const ctx = this.ensure(); if (!ctx) return;
    const dest = this.panFor({ x, z }, listener);
    const t = ctx.currentTime;
    const freq = { concrete: 1800, brick: 1200, stone: 900, glass: 4200, wood: 700, metal: 2600, dirt: 380, foliage: 500 }[mat] || 1200;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.2);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 2.2;
    const g = ctx.createGain();
    const dur = mat === 'glass' ? 0.34 : 0.12;
    g.gain.setValueAtTime(mat === 'glass' ? 0.32 : 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(bp); bp.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.03);
  }

  /** Footsteps must be audibly distinct per surface: the brief calls this out. */
  footstep(surface, loud, x, y, z, listener) {
    const ctx = this.ensure(); if (!ctx) return;
    const dest = this.panFor({ x, z }, listener);
    const t = ctx.currentTime;
    const cfg = {
      concrete: { f: 2200, q: 1.2, dur: 0.09, v: 0.22 },
      asphalt:  { f: 1900, q: 1.0, dur: 0.09, v: 0.20 },
      stone:    { f: 1500, q: 2.0, dur: 0.13, v: 0.26 },
      dirt:     { f: 420,  q: 0.7, dur: 0.14, v: 0.17 },
      grass:    { f: 2600, q: 0.5, dur: 0.11, v: 0.13 },
      metal:    { f: 3400, q: 3.0, dur: 0.18, v: 0.24 },
      wood:     { f: 800,  q: 1.6, dur: 0.12, v: 0.21 },
      water:    { f: 1100, q: 0.6, dur: 0.22, v: 0.24 },
    }[surface] || { f: 1400, q: 1, dur: 0.1, v: 0.18 };
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.3);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = cfg.f * (0.85 + Math.random() * 0.3); bp.Q.value = cfg.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(cfg.v * loud, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + cfg.dur);
    src.connect(bp); bp.connect(g); g.connect(dest);
    src.start(t); src.stop(t + cfg.dur + 0.03);
  }

  hitmarker() {
    const ctx = this.ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1500, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + 0.1);
  }

  pickup() {
    const ctx = this.ensure(); if (!ctx) return;
    const t = ctx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.07);
      g.gain.linearRampToValueAtTime(0.14, t + i * 0.07 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.14);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.16);
    });
  }

  /** Wind bed tied to weather intensity; keeps the world from feeling dead. */
  ambience(level) {
    const ctx = this.ensure(); if (!ctx) return;
    if (!this._wind) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer(2.0);
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 420;
      const g = ctx.createGain(); g.gain.value = 0.0;
      src.connect(lp); lp.connect(g); g.connect(this.master);
      src.start();
      this._wind = g;
    }
    this._wind.gain.setTargetAtTime(0.05 + level * 0.16, ctx.currentTime, 1.5);
  }
}
