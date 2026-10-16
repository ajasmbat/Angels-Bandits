// C1 low-flying chaos — the shared, pure half. Fly low among the towers and
// the D5 director escalates (server/src/director.ts): every 2–4 s something
// comes apart NEAR AND AHEAD of the plane — a tower toppling across or
// beside its path, a facade peeling off into the street, a gas main bursting
// up from a manhole, a roof tank or billboard going over the edge, a bridge
// span dropping, a chain of cars and trucks blowing — each warned the usual
// way (one `directorWarn`, its tell swelling for DIRECTOR_WARN_MS) and each
// FAIR: a plane flying straight is not where the danger lands, or a normal
// turn (or a gentle climb) begun after a human's reaction time clears it.
// Climb out of the canyons and it calms back down to D5's cadence.
//
// WHO is low is `lowChaosLevel`: below the local roofline and under
// LOW_ENTER_ALT among towers, with hysteresis so the mode does not flicker
// at the edge. WHEN is `lowSlotsInWindow`: the storm's trick again (hashed
// buckets, seeded offsets), 2–4 s apart by construction and a pure function
// of (seed, server time). WHERE depends on the live fight, so the server
// decides it and broadcasts.
//
// Not re-exported from common/src/index.ts; import
// "@angels-bandits/common/lowchaos".

import type { Building } from "./city/index";
import { mulberry32 } from "./city/rng";
import { standingProfile } from "./city/standing";
import { PLAYER_RADIUS, TURN_RATE } from "./constants";
import type { DangerZone } from "./director";
import { type Vec3, wrapDeltaAxis } from "./world/index";

// --- Who is low ------------------------------------------------------------------

/** A plane is low under this altitude among towers (and under the local
 * roofline), m. */
export const LOW_ENTER_ALT = 120;
/** ...and stays low until it climbs over this, or LOW_ROOF_MARGIN over the
 * local roofline, whichever is lower, m. */
export const LOW_EXIT_ALT = 145;
export const LOW_ROOF_MARGIN = 15;
/** The local roofline: the tallest standing top within this plan-view gap
 * of the plane, m. */
export const LOW_ROOF_RADIUS = 120;
/** "Among towers": a local roofline at least this tall to enter, m (a park,
 * the river or a block of low-rise is not a canyon)... */
export const LOW_TOWERS_MIN = 45;
/** ...and the mode ends when the roofline drops under this, m. */
export const LOW_TOWERS_EXIT = 35;

/** The tallest STANDING top (D8: what still stands, not the generated
 * height) of the buildings whose footprint lies within `r` (plan-view gap)
 * of `pos`, m; 0 when none. Allocation-free. */
export function localRoofline(
  buildings: readonly Building[],
  pos: Vec3,
  r = LOW_ROOF_RADIUS,
): number {
  let top = 0;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i] as Building;
    if (b.height <= top) continue;
    const gx = Math.abs(wrapDeltaAxis(b.x, pos.x)) - b.width / 2;
    if (gx > r) continue;
    const gz = Math.abs(wrapDeltaAxis(b.z, pos.z)) - b.depth / 2;
    if (gz > r) continue;
    const g = Math.hypot(Math.max(gx, 0), Math.max(gz, 0));
    if (g > r) continue;
    const h = b.damage ? standingProfile(b).top : b.height;
    if (h > top) top = h;
  }
  return top;
}

/** A plane as the low test sees it: where it is, and whether it was low on
 * the last test (the hysteresis). */
export interface LowPlane {
  pos: Vec3;
  wasLow?: boolean;
}

/**
 * How deep in the canyons a plane is, 0..1 — 0: not low (D5's cadence);
 * > 0: low chaos, 1 at street level. Entering needs the plane under
 * LOW_ENTER_ALT, under the local roofline and among towers
 * (roofline ≥ LOW_TOWERS_MIN); a plane that `wasLow` stays low until it
 * climbs over min(LOW_EXIT_ALT, roofline + LOW_ROOF_MARGIN) or the roofline
 * drops under LOW_TOWERS_EXIT. Under the street (a tunnel, y < 0) is never
 * low — U6's cave-ins own the bores. Pure.
 */
export function lowChaosLevel(
  plane: LowPlane,
  city: { buildings: readonly Building[] },
): number {
  const y = plane.pos.y;
  if (!(y >= 0)) return 0;
  const roof = localRoofline(city.buildings, plane.pos);
  const ceiling = plane.wasLow
    ? roof < LOW_TOWERS_EXIT
      ? 0
      : Math.min(LOW_EXIT_ALT, roof + LOW_ROOF_MARGIN)
    : roof < LOW_TOWERS_MIN
      ? 0
      : Math.min(LOW_ENTER_ALT, roof);
  if (y >= ceiling) return 0;
  // Never exactly 0 while low: 0.05 at the ceiling, 1 on the street.
  return Math.max(0.05, 1 - y / ceiling);
}

// --- When ------------------------------------------------------------------------

/** Consecutive low slots are this far apart, ms (the ticket's 2–4 s). */
export const LOW_INTERVAL_MIN_MS = 2000;
export const LOW_INTERVAL_MAX_MS = 4000;

const LOW_BUCKET_MS = (LOW_INTERVAL_MIN_MS + LOW_INTERVAL_MAX_MS) / 2;
const LOW_JITTER_MS = (LOW_INTERVAL_MAX_MS - LOW_INTERVAL_MIN_MS) / 2;
const LOW_SALT = 0x0c1c4a05;

/**
 * Every low-chaos slot in the half-open window [tStartMs, tEndMs),
 * ascending: one per LOW_BUCKET_MS bucket at a seeded 0..JITTER offset, so
 * consecutive slots are LOW_INTERVAL_MIN_MS..MAX_MS apart and abutting
 * windows partition the timeline (common/src/director.ts's
 * directorSlotsInWindow, faster). Pure in (seed, window).
 */
export function lowSlotsInWindow(
  seed: number,
  tStartMs: number,
  tEndMs: number,
): number[] {
  const out: number[] = [];
  const first = Math.max(
    0,
    Math.floor((tStartMs - LOW_JITTER_MS) / LOW_BUCKET_MS),
  );
  for (let n = first; n * LOW_BUCKET_MS < tEndMs; n++) {
    const r = mulberry32((seed ^ LOW_SALT ^ Math.imul(n, 0x9e3779b9)) >>> 0);
    const t = n * LOW_BUCKET_MS + r() * LOW_JITTER_MS;
    if (t >= tStartMs && t < tEndMs) out.push(t);
  }
  return out;
}

// --- Fair ------------------------------------------------------------------------

/** A normal turn: half the flight model's full-deflection yaw rate at
 * MAX_SPEED, rad/s — a comfortable bank, not a max-G break. */
export const LOW_TURN_RATE = TURN_RATE / 2;
/** ...or a gentle climb at this vertical speed, m/s. */
export const LOW_CLIMB_MS = 15;
/** Every escape starts this long after the warning, s (a human's reaction
 * to the tell, with room to spare). */
export const LOW_REACT_S = 0.8;
/** The plane's clearance from a danger zone, m: its radius and a margin. */
export const LOW_CLEAR_M = PLAYER_RADIUS + 4;
/** Trajectory sample step, s. */
const STEP_S = 0.05;

/** The ways out a fair event must leave open, in order: straight on, a
 * normal turn left or right, a gentle climb. */
export const ESCAPE_STRAIGHT = 0;
export const ESCAPE_LEFT = 1;
export const ESCAPE_RIGHT = 2;
export const ESCAPE_CLIMB = 3;

/**
 * Does the plane at `pos` flying `vel` (m/s), taking escape `how` (begun
 * LOW_REACT_S after now), keep LOW_CLEAR_M out of `zone` (relative to
 * `cx`, `cz`; plan view plus its top) for the whole window [t0s, t1s] s
 * from now? Torus-correct; allocation-free.
 */
export function clearOf(
  zone: DangerZone,
  cx: number,
  cz: number,
  pos: Vec3,
  vel: Vec3,
  t0s: number,
  t1s: number,
  how: number,
): boolean {
  const m = LOW_CLEAR_M;
  const speed = Math.hypot(vel.x, vel.z);
  let heading = Math.atan2(vel.z, vel.x);
  let x = wrapDeltaAxis(cx, pos.x);
  let z = wrapDeltaAxis(cz, pos.z);
  let y = pos.y;
  const turn =
    how === ESCAPE_LEFT
      ? -LOW_TURN_RATE
      : how === ESCAPE_RIGHT
        ? LOW_TURN_RATE
        : 0;
  for (let t = 0; t <= t1s + 1e-9; t += STEP_S) {
    if (
      t >= t0s - 1e-9 &&
      x >= zone.x0 - m &&
      x <= zone.x1 + m &&
      z >= zone.z0 - m &&
      z <= zone.z1 + m &&
      y <= zone.top + m
    ) {
      return false;
    }
    const acting = t >= LOW_REACT_S;
    if (acting) heading += turn * STEP_S;
    x += Math.cos(heading) * speed * STEP_S;
    z += Math.sin(heading) * speed * STEP_S;
    y +=
      (acting && how === ESCAPE_CLIMB ? Math.max(vel.y, LOW_CLIMB_MS) : vel.y) *
      STEP_S;
  }
  return true;
}

/**
 * The first way out (ESCAPE_*) that clears `zone` over [t0s, t1s], or −1
 * when none does — an UNFAIR event, which the director never stages.
 * Straight on comes first: an event a plane flying straight is clear of
 * needs no reaction at all.
 */
export function escapeFrom(
  zone: DangerZone,
  cx: number,
  cz: number,
  pos: Vec3,
  vel: Vec3,
  t0s: number,
  t1s: number,
): number {
  for (const how of [
    ESCAPE_STRAIGHT,
    ESCAPE_LEFT,
    ESCAPE_RIGHT,
    ESCAPE_CLIMB,
  ]) {
    if (clearOf(zone, cx, cz, pos, vel, t0s, t1s, how)) return how;
  }
  return -1;
}

// --- How much --------------------------------------------------------------------

/** At most this many collapses falling (warned, or with debris still in the
 * air) within LOW_FALLING_R of one human when the director picks another
 * tower to bring down — near that human. */
export const LOW_FALLING_MAX = 2;
export const LOW_FALLING_R = 350;
