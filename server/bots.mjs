
// Server-side bots. They exist so a solo player has opponents and so the hit
// registration + damage pipeline is exercised without a second human.
//
// They use the SAME shared stepPlayer() and the SAME bullet pipeline as humans —
// a bot is just an input generator. Nothing bot-specific touches physics.
import { BTN, has } from '../shared/sim.mjs';
import { WEAPONS, MAP_W, MAP_H } from '../shared/config.mjs';
import { dist, inCone, clamp } from '../shared/geometry.mjs';
import { mulberry32 } from '../shared/rng.mjs';

const BOT_NAMES = ['BOT-VIPER', 'BOT-KITTU', 'BOT-SHADOW', 'BOT-ROHAN', 'BOT-AYESHA',
  'BOT-FARHAN', 'BOT-NIHAAL', 'BOT-TANVI', 'BOT-REHAN', 'BOT-MEHER'];

export function makeBotController(match, player, index) {
  const rng = mulberry32(0xB07 + index * 7919);
  const state = {
    mode: 'loot',        // loot -> rotate -> engage -> heal
    target: null,
    targetLoot: null,
    strafe: 0,
    strafeT: 0,
    jumpCd: 0,
    healCd: 0,
    skill: 0.45 + rng() * 0.45,   // aim accuracy + reaction
  };

  function think() {
    const p = player;
    if (!p.alive || !p.dropped) return;
    const zone = match.zone;
    const zoneDist = Math.hypot(p.x - zone.cx, p.y - zone.cy);

    // Threat scan: nearest visible enemy inside the zone.
    let best = null, bd = 1e9;
    for (const q of match.players.values()) {
      if (q === p || !q.alive || !q.dropped) continue;
      const d = dist(p.x, p.y, q.x, q.y);
      if (d > 190) continue;
      // Only "see" them if roughly in front (bots have limited awareness).
      if (!inCone(q.x, q.y, p.x, p.y, p.yaw, 1.5, 200)) continue;
      if (d < bd) { bd = d; best = q; }
    }

    if (best && state.mode !== 'heal') state.mode = 'engage';
    if (!best && state.mode === 'engage') state.mode = 'rotate';
    if (p.hp < 45 && (p.meds?.bandage || p.meds?.firstaid || p.meds?.medkit) && !best) state.mode = 'heal';

    // Out of zone, or circle closing hard => rotate to centre.
    if (zoneDist > zone.r * 0.82) state.mode = 'rotate';

    // Target selection.
    if (state.mode === 'engage') {
      state.target = best;
      p.yaw = Math.atan2(best.y - p.y, best.x - p.x);
      const d = bd;
      const dy = (best.z - p.z) + 1.2;
      p.pitch = Math.atan2(dy, d);
    } else if (state.mode === 'rotate') {
      state.target = null;
      const ang = Math.atan2(zone.cy - p.y, zone.cx - p.x);
      p.yaw += (((ang - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 0.12;
      p.pitch *= 0.9;
    } else if (state.mode === 'heal') {
      state.target = null;
      if (!p.healKind) {
        const kind = p.meds.firstaid ? 'firstaid' : p.meds.bandage ? 'bandage' : p.meds.medkit ? 'medkit' : null;
        if (kind) match.useMed(p.id, kind);
      }
    } else if (state.mode === 'loot') {
      state.target = null;
      // Walk toward the nearest untaken loot.
      if (!state.targetLoot || state.targetLoot.taken) {
        let bl = null, bld = 260;
        for (const l of match.loot) {
          if (l.taken) continue;
          const d = dist(p.x, p.y, l.x, l.y);
          if (d < bld) { bld = d; bl = l; }
        }
        state.targetLoot = bl;
      }
      if (state.targetLoot) {
        const ang = Math.atan2(state.targetLoot.y - p.y, state.targetLoot.x - p.x);
        p.yaw += (((ang - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 0.2;
      }
      // A 36x44 km map means bots will never bump into each other by accident.
      // Once kitted, drift toward the nearest living opponent so fights happen;
      // without this the match stalls until the zone forces everyone together.
      if (p.slot[0] && p.slotIdx === 0 && rng() < 0.012) state.mode = 'hunt';
    } else if (state.mode === 'hunt') {
      // Close on the nearest enemy until we can see them, then engage.
      let best = null, bd = 1e9;
      for (const q of match.players.values()) {
        if (q === p || !q.alive || !q.dropped) continue;
        const d = dist(p.x, p.y, q.x, q.y);
        if (d < bd) { bd = d; best = q; }
      }
      if (!best) { state.mode = 'loot'; return; }
      state.target = best;
      const ang = Math.atan2(best.y - p.y, best.x - p.x);
      p.yaw += (((ang - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 0.15;
      if (bd < 170) state.mode = 'engage';
      if (rng() < 0.004) state.mode = 'loot';   // don't commit forever
    }
  }

  /** Produce an input frame for the bot, in the same shape a client sends. */
  function frame() {
    const p = player;
    if (!p.alive) return { seq: 0, mx: 0, my: 0, pitch: p.pitch, yaw: p.yaw, buttons: 0 };
    if (!p.dropped) {
      // Drop right next to the action. Bots were scattered across a 36x44 km
      // playfield, so a solo player would never meet one; they now jump within
      // a few hundred metres of the match anchor.
      if (!p.botDropped) {
        p.botDropped = true;
        const anchor = [...match.players.values()].find(q => !q.bot);
        const k = (p.id * 2654435761) >>> 0;
        const rr = 200 + ((k & 0xff) / 255) * 1400;
        const aa = ((k >> 8) & 0xffff) / 65535 * Math.PI * 2;
        const cx = anchor ? anchor.x : 0;
        const cy = anchor ? anchor.y : 0;
        match.jumpOut(p.id,
          clamp(cx + Math.cos(aa) * rr, -MAP_W / 2 + 200, MAP_W / 2 - 200),
          clamp(cy + Math.sin(aa) * rr, -MAP_H / 2 + 200, MAP_H / 2 - 200));
      }
      return { seq: 0, mx: 0, my: 0, pitch: 0, yaw: p.yaw, buttons: 0 };
    }

    think();

    let buttons = 0;
    let mx = 0, my = 0;

    if (state.mode === 'engage' && state.target) {
      const d = dist(p.x, p.y, state.target.x, state.target.y);
      // Hold the right range for the equipped weapon and strafe.
      const W = WEAPONS[p.slot[p.slotIdx]] || { falloffStart: 250 };
      const want = Math.max(35, W.falloffStart * 0.55);
      const closing = d > want * 1.25 ? 1 : d < want * 0.6 ? -1 : 0;
      my = closing;
      // Strafe perpendicular.
      state.strafeT -= 1 / 30;
      if (state.strafeT <= 0) { state.strafe = rng() < 0.5 ? -1 : 1; state.strafeT = 0.5 + rng() * 1.4; }
      mx = state.strafe;
      // Fire with a skill-scaled reaction and only if roughly on target.
      const aimErr = Math.abs(((p.yaw - Math.atan2(state.target.y - p.y, state.target.x - p.x) + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (aimErr < 0.22 * (0.4 + state.skill)) {
        buttons |= BTN.FIRE;
        if (d > 140) buttons |= BTN.ADS;
      }
      // Reload when dry.
      const wpn = p.slot[p.slotIdx];
      if (wpn && (p.ammo[wpn] ?? 0) === 0) buttons |= BTN.RELOAD;
    } else if (state.mode === 'rotate' || state.mode === 'loot') {
      my = 1;
      if (state.mode === 'rotate') buttons |= BTN.SPRINT;
      if (rng() < 0.02) buttons |= BTN.JUMP;
    }

    // Jump over kerbs occasionally so vaults/contextual movement get exercised.
    state.jumpCd -= 1 / 30;
    if (state.jumpCd <= 0 && (state.mode === 'rotate')) { buttons |= BTN.VAULT; state.jumpCd = 2 + rng() * 3; }

    // Bot yaw error so they are not perfect shots.
    p.yaw += (rng() - 0.5) * 0.02 * (1 - state.skill);

    return { seq: 0, mx, my, pitch: p.pitch, yaw: p.yaw, buttons };
  }

  return { frame, state, name: BOT_NAMES[index % BOT_NAMES.length] };
}
