// B3 bot tactics — the pure half of how a bot fights. No clocks, no rand,
// no city: bots.ts builds a situation from what the brain already knows and
// these functions answer it, so every rule here is a plain input → output
// table the tests can pin.
//
//   chooseTactic — what kind of fight to fly against the current target
//                  (or whether to leave it).
//   pincerSides  — which side of a shared target each attacker swings to.
//   threatOnSix  — the contact sitting on a bot's six, if any.
//   SkillScaler  — each human's rolling K/D against the bots, as a bounded
//                  level with hysteresis, and what that does to bot aim.

import {
  BOT_STYLE_TUNING,
  type BotStyle,
} from "@angels-bandits/common/botstyle";
import {
  BOT_BOOM_ALT,
  BOT_BREAK_MAX_MS,
  BOT_SKILL_ALPHA,
  BOT_SKILL_COOLDOWN_NOVICE,
  BOT_SKILL_COOLDOWN_VETERAN,
  BOT_SKILL_DEADBAND,
  BOT_SKILL_JITTER_NOVICE,
  BOT_SKILL_JITTER_VETERAN,
  BOT_SKILL_KD_SPAN,
  BOT_SKILL_REACTION_NOVICE,
  BOT_SKILL_REACTION_VETERAN,
  BOT_THREAT_RANGE,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";

export type Tactic =
  | "turnFight"
  | "boomZoom"
  | "pincer"
  | "breakOff"
  | "defend";

/** Everything chooseTactic reads — nothing else. */
export interface TacticSituation {
  style: BotStyle;
  /** Own HP as a fraction of MAX_HP, [0, 1]. */
  hp: number;
  /** Broken off already (the hysteresis latch), and for how long, ms. */
  breaking: boolean;
  breakingFor: number;
  /** The bot's height over its target, m (negative: below it). */
  above: number;
  /** A contact sits on the six (threatOnSix). */
  onSix: boolean;
  /** This bot's side in a pincer on its target (0: none — alone on it). */
  pincerSide: -1 | 0 | 1;
  /** The target is a sky-boss weak point. */
  boss: boolean;
  /** A boom pass may start (its zoom and cooldown are over). */
  boomReady: boolean;
  /** The target's skill level ([-1, 1], SkillScaler; 0 for a bot). */
  skill: number;
}

/** A style's break-off and return HP fractions against a target of skill
 * `skill`: a novice's bots leave a fight sooner (so a new pilot who lands
 * hits wins it), a veteran's press harder. Return always sits well above
 * the break, so the latch never chatters. */
export function breakThresholds(
  style: BotStyle,
  skill: number,
): { breakHp: number; returnHp: number } {
  const t = BOT_STYLE_TUNING[style];
  const breakHp = Math.min(0.6, Math.max(0.1, t.breakHp - 0.1 * skill));
  return { breakHp, returnHp: Math.max(t.returnHp, breakHp + 0.2) };
}

/**
 * The tactic for one decision. Precedence, top first: defend a contact on
 * the six (hurt or not — flying straight home with a gun behind you is how
 * you die); break off (HP, with hysteresis and the BOT_BREAK_MAX_MS cap);
 * the boss is always a straight attack (its own pass rules live in
 * bots.ts); boom-and-zoom from enough height; pincer when a partner shares
 * the target; otherwise the turn fight down low.
 */
export function chooseTactic(s: TacticSituation): Tactic {
  if (s.onSix) return "defend";
  const { breakHp, returnHp } = breakThresholds(s.style, s.skill);
  if (s.breaking) {
    if (s.hp < returnHp && s.breakingFor < BOT_BREAK_MAX_MS) return "breakOff";
  } else if (s.hp < breakHp) {
    return "breakOff";
  }
  if (s.boss) return "turnFight";
  if (s.above >= BOT_BOOM_ALT && s.boomReady) return "boomZoom";
  if (s.pincerSide !== 0) return "pincer";
  return "turnFight";
}

/** One attacker as the pincer sees it. */
export interface PincerAttacker {
  id: string;
  pos: Vec3;
}

/** Plan-view unit vector of the target's track (east when it hangs still). */
function track(vel: Vec3): { x: number; z: number } {
  const len = Math.hypot(vel.x, vel.z);
  return len > 1e-3 ? { x: vel.x / len, z: vel.z / len } : { x: 1, z: 0 };
}

/**
 * The side each attacker on one target swings to: +1 is the side of the
 * target's track where cross(track, target→attacker) > 0 (pincerOffset
 * aims there), −1 the other. Fewer than two attackers: nobody pincers (an
 * empty map). Otherwise the previous assignment is kept while it still uses
 * both sides (newcomers fill the thinner side), so two bots that cross over
 * each other do not swap; a fresh assignment ranks the attackers by that
 * cross product and alternates, so each starts on the side it is already on.
 */
export function pincerSides(
  target: { pos: Vec3; vel: Vec3 },
  attackers: readonly PincerAttacker[],
  prev: ReadonlyMap<string, -1 | 1> = new Map(),
): Map<string, -1 | 1> {
  const out = new Map<string, -1 | 1>();
  if (attackers.length < 2) return out;
  let left = 0;
  let right = 0;
  for (const a of attackers) {
    const side = prev.get(a.id);
    if (side === -1) left++;
    if (side === 1) right++;
  }
  if (left > 0 && right > 0) {
    for (const a of attackers) {
      let side = prev.get(a.id);
      if (side === undefined) {
        side = left <= right ? -1 : 1;
        if (side === -1) left++;
        else right++;
      }
      out.set(a.id, side);
    }
    return out;
  }
  const h = track(target.vel);
  const ranked = attackers
    .map((a) => {
      const d = wrapDelta(target.pos, a.pos);
      return { id: a.id, cross: h.x * d.z - h.z * d.x };
    })
    .sort((a, b) => a.cross - b.cross || (a.id < b.id ? -1 : 1));
  ranked.forEach((a, i) => {
    out.set(a.id, i % 2 === 0 ? -1 : 1);
  });
  return out;
}

/**
 * Where a pincer attacker aims instead of the target itself: `side` × up to
 * `offset` m square to the target's track, shrinking to nothing at `near` m
 * so the two converge into gun range from either flank. A plan-view delta
 * to add to the pursuit vector.
 */
export function pincerOffset(
  targetVel: Vec3,
  side: -1 | 0 | 1,
  dist: number,
  offset: number,
  near: number,
): Vec3 {
  if (side === 0) return { x: 0, y: 0, z: 0 };
  const h = track(targetVel);
  const k = Math.min(offset, Math.max(0, (dist - near) * 0.6)) * side;
  // n = (−h.z, h.x): cross(h, n) = 1 > 0, the +1 side.
  return { x: -h.z * k, y: 0, z: h.x * k };
}

/** A contact as the six-check sees it. */
export interface SixContact {
  id: string;
  pos: Vec3;
  vel: Vec3;
  boss?: boolean;
}

/** A shooter's nose within this of the line to us counts as "on us", rad. */
const SIX_CONE_COS = Math.cos(0.35);

/**
 * The nearest contact on the six of a plane at `pos` with nose `fwd`:
 * inside BOT_THREAT_RANGE, aft of the 3-9 line, and its own nose (velocity)
 * pointed at us. Boss weak points and `selfId` never count. Null if none.
 */
export function threatOnSix(
  selfId: string,
  pos: Vec3,
  fwd: Vec3,
  contacts: readonly SixContact[],
): SixContact | null {
  let best: SixContact | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of contacts) {
    if (c.id === selfId || c.boss) continue;
    const d = wrapDelta(pos, c.pos);
    const dist = Math.hypot(d.x, d.y, d.z);
    if (dist > BOT_THREAT_RANGE || dist < 1e-6) continue;
    if (d.x * fwd.x + d.y * fwd.y + d.z * fwd.z >= 0) continue;
    const speed = Math.hypot(c.vel.x, c.vel.y, c.vel.z);
    if (speed < 1e-6) continue;
    const aim =
      -(c.vel.x * d.x + c.vel.y * d.y + c.vel.z * d.z) / (speed * dist);
    if (aim < SIX_CONE_COS) continue;
    if (dist < bestD) {
      bestD = dist;
      best = c;
    }
  }
  return best;
}

/**
 * Each human's skill against the bots. Every human–bot outcome (the human
 * killed a bot: a win; a bot killed the human: a loss — crashes, hazards and
 * bot-vs-bot kills never count) moves an EMA of the human's win share; that
 * share as a K/D, on a log scale saturating at BOT_SKILL_KD_SPAN either way,
 * is the raw level in [-1, 1]. The level a bot reads only follows the raw
 * one once it has moved more than BOT_SKILL_DEADBAND (or hit an end), so a
 * single lucky kill never flips how a room flies against someone.
 */
export class SkillScaler {
  private readonly share = new Map<string, number>();
  private readonly levels = new Map<string, number>();

  /** One outcome for human `id`: `won` true when the human got the kill. */
  noteOutcome(id: string, won: boolean): void {
    const prev = this.share.get(id) ?? 0.5;
    const share = prev + BOT_SKILL_ALPHA * ((won ? 1 : 0) - prev);
    this.share.set(id, share);
    const raw = rawLevel(share);
    const level = this.levels.get(id) ?? 0;
    const saturated = Math.abs(raw) >= 1 && raw !== level;
    if (saturated || Math.abs(raw - level) > BOT_SKILL_DEADBAND) {
      this.levels.set(id, raw);
    }
  }

  /** The human's level: −1 (the bots are farming them) … +1 (they farm the
   * bots); 0 for anyone unknown — bots included. */
  levelOf(id: string): number {
    return this.levels.get(id) ?? 0;
  }

  /** The human left: start over if they come back. */
  forget(id: string): void {
    this.share.delete(id);
    this.levels.delete(id);
  }

  /** Aim-jitter multiplier against `id`. */
  jitterScale(id: string): number {
    return skillScale(
      this.levelOf(id),
      BOT_SKILL_JITTER_NOVICE,
      BOT_SKILL_JITTER_VETERAN,
    );
  }

  /** Attack-pass cooldown multiplier against `id` (aggression). */
  cooldownScale(id: string): number {
    return skillScale(
      this.levelOf(id),
      BOT_SKILL_COOLDOWN_NOVICE,
      BOT_SKILL_COOLDOWN_VETERAN,
    );
  }

  /** Reaction-delay multiplier against `id`. */
  reactionScale(id: string): number {
    return skillScale(
      this.levelOf(id),
      BOT_SKILL_REACTION_NOVICE,
      BOT_SKILL_REACTION_VETERAN,
    );
  }
}

/** A win share as a level in [-1, 1]: log K/D over log BOT_SKILL_KD_SPAN. */
function rawLevel(share: number): number {
  const s = Math.min(1 - 1e-6, Math.max(1e-6, share));
  const level = Math.log(s / (1 - s)) / Math.log(BOT_SKILL_KD_SPAN);
  return Math.min(1, Math.max(-1, level));
}

/** Piecewise-linear: `novice` at level −1, 1 at 0, `veteran` at +1. */
export function skillScale(
  level: number,
  novice: number,
  veteran: number,
): number {
  const l = Math.min(1, Math.max(-1, level));
  return l < 0 ? 1 + -l * (novice - 1) : 1 + l * (veteran - 1);
}
