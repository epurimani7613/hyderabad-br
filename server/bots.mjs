
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
    index,                  // spawn index, used for the drop spiral
    mode: 'loot',        // loot -> hunt -> engage -> heal
    target: null,
    targetLoot: null,
    strafe: 0,
    strafeT: 0,
    jumpCd: 0,
    healCd: 0,
    skill: 0.45 + rng() * 0.45,   // aim accuracy + reaction
  };

  /**
   * Does this player need to go shopping? True when the equipped weapon is dry
   * or the reserve is low.
   *
   * Without this, bots emptied their starting loadout in the opening scrum and
   * then stood at 0 magazine / 0 reserve for the rest of the match, engaging
   * at point-blank range without ever firing again. Matches stalled and every
   * death came from the circle rather than from gunfire.
   */
  function needsAmmo(p) {
    const wpn = p.slot[p.slotIdx];
    if (!wpn) return true;
    const W = WEAPONS[wpn];
    const mag = p.ammo[wpn] ?? 0;
    const reserve = p.ammoPool?.[W.ammo] ?? 0;
    return mag <= 0 || reserve < W.mag;
  }

  /** Nearest untaken ammo crate matching this player's equipped weapon. */
  function findAmmo(p, maxDist = 700) {
    const wpn = p.slot[p.slotIdx];
    if (!wpn) return null;
    const want = WEAPONS[wpn].ammo;
    let best = null, bd = maxDist;
    for (const l of match.loot) {
      if (l.taken || l.k !== 'ammo' || l.n !== want) continue;
      const d = dist(p.x, p.y, l.x, l.y);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }

  function think() {
    const p = player;
    if (!p.alive || !p.dropped) return;
    const zone = match.zone;
    const zoneDist = Math.hypot(p.x - zone.cx, p.y - zone.cy);

    // Threat scan. Awareness is deliberately limited: a bot notices an enemy within
    // SIGHT metres that is in front of it, OR any enemy very close regardless of
    // direction (you cannot stand behind someone and not hear them).
    //
    // The old scan required BOTH conditions, so two bots walking toward each
    // other from directly behind never detected each other and the match ran for
    // minutes with nobody ever taking a shot.
    const SIGHT = 220;
    const CLOSE_QUIET = 60;                 // "in your face" - heard regardless of facing
    let best = null, bd = 1e9;
    let nearestEnemy = null, nearestD = 1e9;   // tracked regardless of facing
    for (const q of match.players.values()) {
      if (q === p || !q.alive || !q.dropped) continue;
      const d = dist(p.x, p.y, q.x, q.y);
      if (d < nearestD) { nearestD = d; nearestEnemy = q; }
      if (d > SIGHT) continue;
      if (d > CLOSE_QUIET && !inCone(q.x, q.y, p.x, p.y, p.yaw, 1.5, SIGHT)) continue;
      if (d < bd) { bd = d; best = q; }
    }

    if (best && state.mode !== 'heal') state.mode = 'engage';
    if (!best && state.mode === 'engage') state.mode = 'hunt';

    // Out of zone, or circle closing hard => rotate to centre. Checked last so a
    // visible enemy still wins: bots should fight their way in, not walk past.
    // Once the circle has fully closed there is nowhere left to rotate to, so
    // the survivors must close on each other or the match stalls forever with
    // two bots circling an empty 500 m zone.
    if (zone.closed) {
      state.mode = 'hunt';
    } else if (zoneDist > zone.r * 0.92 && !best) {
      state.mode = 'rotate';
    } else if (!best && nearestEnemy && nearestD > 250) {
      // Converge. A 26 km opening circle over a 36x44 km map means bots spend
      // the first phase wandering off in different directions and the zone then
      // kills them before any of them meet. Pull everyone toward the circle
      // centre while there is still plenty of time, so fights actually start.
      state.mode = 'rotate';
    }

    // Dry with an enemy in sight? Back off and rearm. This has to override engage:
// bots that were locked in `engage` with an empty magazine stared at their
// target forever, unable to shoot and unwilling to leave, which is what kept
// every match from resolving. A bot that cannot fire has nothing to gain from
// the fight, so it goes and reloads instead.
    if (needsAmmo(p) && p.dropped) {
      const crate = findAmmo(p, 900);
      if (crate) {
        state.mode = 'resupply';
        state.targetLoot = crate;
      }
    }

    // Patch up when hurt, but only with no enemy around, not mid-fight, and not
    // once the circle is closed (there is nobody left to heal for).
    if (p.hp < 45 && !zone.closed && (p.meds?.bandage || p.meds?.firstaid || p.meds?.medkit) && !best) state.mode = 'heal';

    // Target selection.
    if (state.mode === 'engage') {
      state.target = best;
      p.yaw = Math.atan2(best.y - p.y, best.x - p.x);
      const d = bd;
      const dy = (best.z - p.z) + 1.2;
      p.pitch = Math.atan2(dy, d);
    } else if (state.mode === 'rotate') {
      state.target = null;
      // Walk to a point inside the circle, not at its rim. Heading straight at
      // (cx, cy) would overshoot past it, so aim at a point pulled back toward
      // the middle: bots converge and then mill about together instead of
      // spreading along the boundary.
      let tx = zone.cx, ty = zone.cy;
      const gd = dist(p.x, p.y, zone.cx, zone.cy);
      if (gd > zone.r * 0.55) {
        // keep 55% of the radius of headroom so we stop before the centre
        const k = (gd - zone.r * 0.55) / gd;
        tx = zone.cx - (zone.cx - p.x) * k;
        ty = zone.cy - (zone.cy - p.y) * k;
      }
      const ang = Math.atan2(ty - p.y, tx - p.x);
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
      // Looting is a short errand, not the default state. A 1.2% per-tick roll to
      // start hunting meant a bot could spend an entire match walking between
      // nearby loot crates and never engage anyone. Hunt whenever a target is
      // known, and only return to looting when the area is picked clean.
      if (p.slot[0] && nearestEnemy) state.mode = 'hunt';
    } else if (state.mode === 'resupply') {
      // Walk to the ammo crate; Match's proximity pickup takes it from us.
      const crate = state.targetLoot;
      if (!crate || crate.taken || !needsAmmo(p)) {
        state.mode = 'hunt';
      } else {
        const ang = Math.atan2(crate.y - p.y, crate.x - p.x);
        p.yaw += (((ang - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 0.25;
      }
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
      // Snap toward the target rather than easing. Bots eased at 0.15 rad/tick,
      // which at a sprint turn rate left them circling their own drop point
      // instead of closing - two bots 1.2 km apart never converged.
      p.yaw = ang;
      // Hand off to engage inside the sight radius so the threat scan can pick
      // it up; before this, hunt kept walking until the target was on top of it.
      if (bd < 200) state.mode = 'engage';
    }
  }

  /** Produce an input frame for the bot, in the same shape a client sends. */
  function frame() {
    const p = player;
    if (!p.alive) return { seq: 0, mx: 0, my: 0, pitch: p.pitch, yaw: p.yaw, buttons: 0 };
    if (!p.dropped) {
      // Drop into a tight cluster. Bots used to be scattered 200-1600 m apart
      // around an anchor, which on a 36x44 km map with a 26 km opening circle
      // meant ZERO of the 91 possible bot pairs were ever within the 220 m
      // sight radius: no fights, and every kill came from the circle. Drop them
      // within a couple of hundred metres of each other so they actually meet.
      if (!p.botDropped) {
        p.botDropped = true;
        const anchor = [...match.players.values()].find(q => !q.bot);
        const idx = match.bots.get(p.id)?.state?.index ?? p.id;
        const cx = anchor ? anchor.x : 0;
        const cy = anchor ? anchor.y : 0;
        // Golden-angle spiral inside a 260 m radius: every bot can see its
        // neighbours immediately, but they are not stacked on one another.
        const a = idx * 2.39996;
        const r = 40 + Math.sqrt(idx + 1) * 58;
        match.jumpOut(p.id,
          clamp(cx + Math.cos(a) * r, -MAP_W / 2 + 200, MAP_W / 2 - 200),
          clamp(cy + Math.sin(a) * r, -MAP_H / 2 + 200, MAP_H / 2 - 200));
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
    } else if (state.mode === 'hunt' || state.mode === 'resupply') {
      // Close on the target / the ammo crate. Without an explicit branch here,
      // hunt bots stood completely still (my/mx stayed 0), so they never
      // reached anyone and the match ran for minutes with zero shots.
      my = 1;
      buttons |= BTN.SPRINT;
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
