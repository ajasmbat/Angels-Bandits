// B3 hazard discs — the one shape every timed danger takes for the bots.
//
// A disc is a sphere that is dangerous over a server-time window: an X1
// missile's blast at its impact, an S4 flak shell's burst at its fuse, and
// whatever C2's chaos events push in (RoomBots.setHazardDiscs). Every source
// is a schedule the clients already hold — a missile from its launch
// broadcast, a shell from its fire broadcast — so a bot only ever dodges
// what a human could have seen coming.
//
// The tests are posed at the DISC's time, never "now": a probe ray asks
// where the bot will be when the disc goes off, and a rollout step asks
// whether the disc goes off while the bot is at that step.
//
// Not re-exported from common/src/index.ts; import
// "@angels-bandits/common/hazards".

import { BOSS_FLAK_DAMAGE_R, type BossFlak } from "./boss";
import {
  MISSILE_BLAST_RADIUS,
  type MissileStrike,
  missileImpactAt,
} from "./strike";
import { type Vec3, wrapDeltaAxis } from "./world/index";

/** One timed danger sphere: centre (canonical), radius (m), and the server
 * time window it is live in, ms (t0 === t1 for an instant blast). */
export interface HazardDisc {
  x: number;
  y: number;
  z: number;
  r: number;
  t0: number;
  t1: number;
}

/** Slack either side of an instant blast, ms — about one bot tick, so a
 * decision cadence cannot step over it. */
export const HAZARD_SLOP_MS = 60;
/** Extra clearance a bot keeps from a flak burst beyond its damage radius,
 * m (the burst as drawn is a little bigger, and a shell's wander is real). */
export const FLAK_HAZARD_PAD = 4;

/** An X1 strike as a disc: its whole blast sphere at impact. */
export function missileHazard(m: MissileStrike): HazardDisc {
  const at = missileImpactAt(m);
  return {
    x: m.to.x,
    y: m.to.y,
    z: m.to.z,
    r: MISSILE_BLAST_RADIUS,
    t0: at - HAZARD_SLOP_MS,
    t1: at + HAZARD_SLOP_MS,
  };
}

/** An S4 flak shell as a disc: its burst at the fuse. */
export function flakHazard(f: BossFlak): HazardDisc {
  const at = f.t0 + f.fuse;
  return {
    x: f.to.x,
    y: f.to.y,
    z: f.to.z,
    r: BOSS_FLAK_DAMAGE_R + FLAK_HAZARD_PAD,
    t0: at - HAZARD_SLOP_MS,
    t1: at + HAZARD_SLOP_MS,
  };
}

/** Squared torus distance from a disc's centre to (x, y, z). */
function dist2(d: HazardDisc, x: number, y: number, z: number): number {
  const dx = wrapDeltaAxis(d.x, x);
  const dy = y - d.y;
  const dz = wrapDeltaAxis(d.z, z);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Does a sphere of radius `r` flying a straight ray — from `origin` at
 * server time `now`, along the unit `dir` at `speed` m/s — meet any disc
 * that goes off inside the next `horizonMs`? Each disc is tested at the
 * point of its live window nearest the ray (closest approach of the moving
 * point over the overlap), so a fast pass cannot slip between two samples.
 */
export function rayMeetsHazard(
  origin: Vec3,
  dir: Vec3,
  speed: number,
  now: number,
  horizonMs: number,
  r: number,
  discs: readonly HazardDisc[],
): boolean {
  for (let i = 0; i < discs.length; i++) {
    const d = discs[i] as HazardDisc;
    const a = Math.max(d.t0, now);
    const b = Math.min(d.t1, now + horizonMs);
    if (a > b) continue;
    // Relative position at time a, and velocity, in the disc's frame.
    const sa = (speed * (a - now)) / 1000;
    const px = wrapDeltaAxis(d.x, origin.x + dir.x * sa);
    const py = origin.y + dir.y * sa - d.y;
    const pz = wrapDeltaAxis(d.z, origin.z + dir.z * sa);
    const span = (speed * (b - a)) / 1000;
    const vx = dir.x * span;
    const vy = dir.y * span;
    const vz = dir.z * span;
    const v2 = vx * vx + vy * vy + vz * vz;
    const k =
      v2 > 0
        ? Math.min(1, Math.max(0, -(px * vx + py * vy + pz * vz) / v2))
        : 0;
    const cx = px + vx * k;
    const cy = py + vy * k;
    const cz = pz + vz * k;
    const reach = d.r + r;
    if (cx * cx + cy * cy + cz * cz <= reach * reach) return true;
  }
  return false;
}

/**
 * Is a sphere of radius `r` at `p` caught by a disc that is live at any
 * moment of (tPrev, t] — one step of a rollout that puts the bot at `p` at
 * time `t`? Pass tPrev = t for a single instant.
 */
export function pointInHazard(
  p: Vec3,
  r: number,
  tPrev: number,
  t: number,
  discs: readonly HazardDisc[],
): boolean {
  for (let i = 0; i < discs.length; i++) {
    const d = discs[i] as HazardDisc;
    if (d.t1 < tPrev || d.t0 > t) continue;
    if (tPrev < t && d.t1 === tPrev) continue; // half-open: (tPrev, t]
    const reach = d.r + r;
    if (dist2(d, p.x, p.y, p.z) <= reach * reach) return true;
  }
  return false;
}

/** The discs still to matter at or after `now` (drops the spent ones). */
export function liveHazards(
  discs: readonly HazardDisc[],
  now: number,
): HazardDisc[] {
  return discs.filter((d) => d.t1 >= now);
}
