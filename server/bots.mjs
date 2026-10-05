
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

export function makeBotController(match, player, index, seed = 0) {
  // Seed from the MATCH seed, not just the bot index. Previously every match
  // played out identically because each bot's RNG was a pure function of its
  // index: the same bot made the same decisions, strafed the same way, and
  // every seed produced a byte-identical match.
  const rng = mulberry32(((seed >>> 0) || 0xB07) + index * 7919 + 13);
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
    if (state.cooldown > 0) state.cooldown--;
    const zone = match.zone;
    const zoneDist = Math.hypot(p.x - zone.cx, p.y - zone.cy);

    // Threat scan. Awareness is deliberately limited: a bot notices an enemy within
    // SIGHT metres that is in front of it, OR any enemy very close regardless of
    // direction (you cannot stand behind someone and not hear them).
    //
    // The old scan required BOTH conditions, so two bots walking toward each
    // other from directly behind never detected each other and the match ran for
    // minutes with nobody ever taking a shot.
    // Awareness range. Bots converge toward each other but realistically settle
        // 400-700 m apart: the drop spiral spreads them over up to ~470 m and a sprint
        // closes ground far slower than the circle shrinks. With SIGHT at 220 m nothing
        // was ever visible - measured over a full match, the closest two bots ever got
        // was 466 m and zero shots were fired. 420 m is a compromise between "bots can
        // actually fight" and "bots do not shoot across the whole map".
        const SIGHT = 420;
    // Inside this range a bot engages regardless of which way it happens to be
    // facing. See the cone note below.
    const ENGAGE_RANGE = 150;
    const CLOSE_QUIET = 90;                 // "in your face" - heard regardless of facing
        let best = null, bd = 1e9;
        let nearestEnemy = null, nearestD = 1e9;   // tracked regardless of facing
        for (const q of match.players.values()) {
          if (q === p || !q.alive || !q.dropped) continue;
          const d = dist(p.x, p.y, q.x, q.y);
          if (d < nearestD) { nearestD = d; nearestEnemy = q; }
          if (d > SIGHT) continue;
          // The cone test is a realism nicety, but requiring it meant a bot whose
          // yaw was pointed the wrong way never engaged anything: bots converge on
          // each other while their yaw lags the walk direction, so they repeatedly
          // arrived just outside their own view cone and then walked past. Inside
          // ENGAGE_RANGE, treat the enemy as seen regardless of facing.
          if (d > ENGAGE_RANGE && d > CLOSE_QUIET && !inCone(q.x, q.y, p.x, p.y, p.yaw, 1.5, SIGHT)) continue;
          if (d < bd) { bd = d; best = q; }
        }

    if (best && state.mode !== 'heal') state.mode = 'engage';
    if (!best && state.mode === 'engage') state.mode = 'hunt';

    // Zone survival outranks the rest of the behaviour tree, because a bot that
    // keeps fighting inside a shrinking ring just dies to it. But it must be a
    // LATCH that the mode logic below can clear, not a terminal assignment.
    //
    // This used to be checked first and unconditionally:
    //     if (zoneDist > zone.r * slack) state.mode = 'rotate';
    // On a 26 km phase-0 circle every bot is outside 0.94 * r, so that pinned all
    // 14 bots in `rotate` for the entire match - 155,246 rotate ticks and not one
    // tick of loot, hunt or engage, so nobody armed and nobody ever fired.
    // Rotate is now applied LAST, only when the bot has nothing better to do.
    const dps = zone.dps || 0;
    const slack = dps > 8 ? 0.82 : dps > 4 ? 0.90 : 0.96;
    // Only count as "must run" when being outside would actually hurt. On the 26 km
    // opening circle the answer is never, and a percentage-only test pinned every
    // bot in `rotate` for an entire match. `holdLeft` is seconds until the next
    // shrink; if the bot can survive the whole phase out there, stay and fight.
    const dpsBudget = dps > 0 ? (p.hp / dps) * (zone.holdLeft ?? 60) : Infinity;
    const mustRotate = zoneDist > zone.r * slack && dpsBudget < 20;

    // Dry? Go find ammo. This has to override engage: bots locked in `engage`
    // with an empty magazine stared at their target forever, unable to shoot and
    // unwilling to leave, which is what stopped matches from resolving.
    //
    // The search radius has to grow as the circle closes. Previously it was a
    // flat 900 m, so once the final circle formed and all the loot had been
    // looted or was outside it, dry bots found nothing and simply orbited each
    // other forever at 130-380 m - outside their own 220 m sight range - so the
    // match never ended.
    //
    // Skipped when running for the circle: a bot with empty magazines 300 m
    // outside the ring should spend those seconds moving, not detouring to loot.
    if (needsAmmo(p) && p.dropped && !mustRotate) {
      const crate = findAmmo(p, zone.closed ? 4000 : zone.r * 0.9 + 900);
      if (crate) {
        state.mode = 'resupply';
        state.targetLoot = crate;
      }
    }

    // Patch up when hurt, but only with no enemy around, not mid-fight, and not
    // once the circle is closed (there is nobody left to heal for).
    if (p.hp < 45 && !zone.closed && (p.meds?.bandage || p.meds?.firstaid || p.meds?.medkit)
        && !best && !mustRotate) state.mode = 'heal';

    // Zone safety last, so it only takes effect when nothing above claimed the
    // bot. Latching this first pinned every bot in `rotate` all match.
    if (mustRotate) {
      state.mode = 'rotate';
    } else if (zone.closed) {
      // Nothing left to rotate to, so the survivors must close on each other or
      // the match stalls forever with two bots circling an empty final circle.
      state.mode = 'hunt';
    } else if (!best && nearestEnemy && nearestD > 250 && !state.cooldown) {
      // Converge. A 26 km opening circle over a 36x44 km map means bots spend
      // the first phase wandering off in different directions and the zone then
      // kills them before any of them meet. Pull everyone toward the circle
      // centre while there is still plenty of time, so fights actually start.
      //
      // Gated on `cooldown` because this branch is re-evaluated every tick: with
      // clustered bots, `nearestD > 250` stayed true for thousands of ticks, so
      // the converge branch re-entered `rotate` before the bounded rotate timer
      // could ever hand control back.
      state.mode = 'rotate';
      state.cooldown = 150;
    }

    // Target selection.
    if (state.mode === 'engage') {
      state.target = best;
      p.yaw = Math.atan2(best.y - p.y, best.x - p.x);
      const d = bd;
      const dy = (best.z - p.z) + 1.2;
      p.pitch = Math.atan2(dy, d);
    } else if (state.mode === 'rotate') {
      // Deliberately do NOT clear `state.target`, and do not stay here forever.
      //
      // `rotate` used to be a terminal sink: it nulled the target every tick and
      // the "converge toward the circle centre" branch re-set the mode each tick,
      // so no bot could ever leave it. Measured over a full match: 155,246 rotate
      // ticks and zero loot/hunt/engage, so bots walked to the middle of the
      // circle, milled about there, and never fired a shot.
      //
      // `mustRotate` also has to be a floor, not a ceiling: bots converge on the
      // circle centre but sit well inside the nominal radius, and 0.96 * 26000 is
      // still a 1 km walk, so a percentage-only rule kept re-triggering it. The
      // absolute slack below is the real constraint once the circle is small.
      state.rotateTicks = (state.rotateTicks || 0) + 1;
      const hardLimit = zone.r * 0.25;             // no reason to circle-run at this range
      if (state.rotateTicks > 90 || zoneDist < hardLimit) {
        state.rotateTicks = 0;
        state.mode = nearestEnemy ? 'hunt' : 'loot';
        return;
      }
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
      // `resupply` used to dominate bot behaviour - 144,051 of ~160,000 ticks -
      // because a bot that found one crate immediately hunted the next. A BR
      // player does not spend the whole match restocking, so give up after a
      // while and go fight instead.
      state.resupplyTicks = (state.resupplyTicks || 0) + 1;
      if (!crate || crate.taken || !needsAmmo(p) || state.resupplyTicks > 240) {
        state.resupplyTicks = 0;
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
      // instead of closing.
      p.yaw = ang;
      // Hand off to engage as soon as the target is inside the threat-scan range,
      // and keep closing well inside it. Two survivors would otherwise orbit each
      // other at 130-380 m - permanently outside the 220 m sight radius - so they
      // never detected each other and the match never ended.
      if (bd < SIGHT * 0.85) state.mode = 'engage';
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
      // sight radius: no fights, and every kill came from the circle.
      //
      // Keep the spread under the sight radius. At `40 + sqrt(i+1)*58` the outer
      // ring reached ~470 m while SIGHT was 420 m, so the farthest bots were
      // born outside each other's view and - because a sprint closes slower than
      // the circle shrinks - never met: measured closest approach over a full
      // match was 539 m, with zero shots fired.
      if (!p.botDropped) {
        p.botDropped = true;
        // Anchor the cluster INSIDE the current circle, near its centre.
        //
        // A 6.4 m/s sprint covers ~3.8 km per match minute, so a bot that lands
        // on the far side of a shrinking circle cannot reach safety before it
        // closes - measured matches were ending at phase 5-8 with r=3000-1600 m
        // and winner=null, every survivor dying to the ring rather than to each
        // other. Dropping into the safe zone is what a real player does.
        const zone = match.zone;
        const anchorR = Math.min(zone.r * 0.25, 900);
        const humans = [...match.players.values()].filter(q => !q.bot && q.alive && q.dropped);
        let cx, cy;
        if (humans.length) {
          const h = humans[Math.floor(rng() * humans.length) % humans.length];
          cx = h.x; cy = h.y;
        } else {
          // Shared across ALL bots so every bot converges on the same point -
          // a per-bot random centre reproduced the scatter we are fixing.
          if (!match.botCentre) {
            const a = rng() * Math.PI * 2, r = rng() * anchorR;
            match.botCentre = { x: zone.cx + Math.cos(a) * r, y: zone.cy + Math.sin(a) * r };
          }
          cx = match.botCentre.x; cy = match.botCentre.y;
        }
        const idx = match.bots.get(p.id)?.state?.index ?? p.id;
        // Golden-angle spiral inside a 260 m radius: every bot can see its
        // neighbours immediately, but they are not stacked on one another.
        //
        // The angle, the radius and the centre must ALL come from the match RNG.
        // This spiral used to be a pure function of the bot index, so every
        // match - and in a bot-only match, every run - dropped all 14 bots on
        // the identical 14 points around (0,0). From touchdown onward the match
        // replayed identically no matter what seed was set.
        const a = idx * 2.39996 + rng() * 0.9;
        // ~35 m per index step: spread the cluster over roughly 130 m so bots
        // start in each other's sight but not stacked. At `30 + sqrt(i+1)*26`
        // the whole cluster collapsed inside 60 m and pairs ended up at literally
        // 0 m - they were in `engage` but too close to resolve a shot.
        const r = 25 + Math.sqrt(idx + 1) * 34 * (0.6 + rng() * 0.7);
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
    // Hunt movement. A plain "sprint at the target" cannot work on this map: with a
// 6.4 m/s sprint, closing the 5-6 km the bots start apart takes over 15 minutes,
// which is longer than a match lasts. Measured: bots moved 0.18 m/tick (correct
// for 6.4 m/s at 30 Hz) while their nearest neighbour stayed ~5.9 km away, so
// they never met, never engaged, and the zone killed everyone.
//
// The fix is to spawn them close enough that a sprint actually arrives, not to
// inflate the speed - bots teleporting at 30 m/s would break the shared sim's
// collision and prediction assumptions. Kept the spiral tight in frame() below;
// this handoff also lets a hunt that starts far apart at least converge while
// there is time, by sprinting without demanding line of sight.
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
