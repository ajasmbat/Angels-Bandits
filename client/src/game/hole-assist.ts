// H2 hole assist — the silent centering nudge. Lined up on a hole's mouth
// (within ASSIST_RANGE, inside the mouth plus a small capture margin, and
// meaning to fly along its axis), the plane is eased onto the centreline: a
// small bias toward a carrot on the centreline ASSIST_LOOKAHEAD ahead.
//
// Rules, all of them caps on what the assist may do — it is help, never a
// hand on the stick:
//   - at most ASSIST_MAX_RAD of aim, fading in from ASSIST_RANGE to
//     ASSIST_FULL_RANGE and out from ASSIST_ALIGN_FULL to ASSIST_ALIGN_MAX
//     of misalignment, so it never yanks;
//   - rate limited (ASSIST_RATE), so engaging and letting go are both a
//     glide, never a step;
//   - measured against where the pilot MEANS to go (main.ts hands the aim
//     ray's direction in mouse-aim mode, the nose in classic mode), so a
//     pilot aiming away is past ASSIST_ALIGN_MAX and gets nothing;
//   - in classic mode it yields to any stick pushing the other way
//     (assistStick), and the caller zeroes it while firing or free-looking;
//   - it never steers INTO a solid: if a sphere swept along the nudged
//     direction meets one sooner than along the pilot's own, it does nothing.
//
// Pure and allocation-free per frame: state and outputs live in caller-owned
// objects, distances are per-axis wrapDeltaAxis (torus-correct), and the
// sweep reuses one scratch point. No HUD, no sound — the plane just lines up.

import type { Building, HoleSpan } from "@angels-bandits/common/city";
import { type CityIndex, collideCity } from "@angels-bandits/common/collision";
import { PLAYER_RADIUS } from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";

const DEG = Math.PI / 180;
/** The assist engages within this of a mouth, m, and is at full weight
 * inside ASSIST_FULL_RANGE (and all the way through the hole). */
export const ASSIST_RANGE = 80;
export const ASSIST_FULL_RANGE = 50;
/** Misalignment (the larger of heading and elevation off the axis) at which
 * the assist is full, and past which it is off, rad. */
export const ASSIST_ALIGN_FULL = 8 * DEG;
export const ASSIST_ALIGN_MAX = 20 * DEG;
/** Capture margin round the mouth rectangle, m: a plane further off the
 * opening than this is flying past the hole, not into it. */
export const ASSIST_CAPTURE = 6;
/** The most aim the assist ever adds, rad, and how fast it may change, rad/s. */
export const ASSIST_MAX_RAD = 4 * DEG;
export const ASSIST_RATE = 6 * DEG;
/** Mouse-aim mode: the intended direction is plane → the world point the
 * cursor marks this far out, m (about where the hole is when it engages). */
export const ASSIST_AIM_RANGE = 120;
/** Carrot distance along the centreline ahead of the plane, m. */
export const ASSIST_LOOKAHEAD = 40;
/** Classic mode: the assist's stick share is capped at this, and opposing
 * stick past ASSIST_YIELD makes it yield outright. */
export const ASSIST_STICK_MAX = 0.15;
export const ASSIST_YIELD = 0.05;
/** Rad/s of commanded rate per rad of error — the instructor's loop gain, so
 * a classic stick nudge and a mouse-aim bias of the same angle steer alike. */
const STICK_GAIN = 10;
/** The solid-guard sweep: length, step and sphere, m. */
const GUARD_DIST = 60;
const GUARD_STEP = 4;
const GUARD_RADIUS = PLAYER_RADIUS + 0.5;

/** The applied bias, rad: +yaw turns right, +pitch noses up. */
export interface HoleAssist {
  yaw: number;
  pitch: number;
}

export function createHoleAssist(): HoleAssist {
  return { yaw: 0, pitch: 0 };
}

/** Everything the assist reads. Build once per city. */
export interface AssistWorld {
  spans: readonly HoleSpan[];
  buildings: readonly Building[];
  index?: CityIndex;
}

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** 1 at/under `full`, 0 at/over `zero`, linear between. */
const fade = (v: number, full: number, zero: number) =>
  clamp((zero - v) / (zero - full), 0, 1);

// Scratch sample for the guard sweep (the colliders never keep it).
const probe: Vec3 = { x: 0, y: 0, z: 0 };

/** Distance to the first solid along unit (dx, dy, dz) from `pos`, out to
 * GUARD_DIST — Infinity when clear. Holes open: the hole itself is air. */
function firstHit(
  world: AssistWorld,
  pos: Vec3,
  dx: number,
  dy: number,
  dz: number,
): number {
  for (let d = GUARD_STEP; d <= GUARD_DIST; d += GUARD_STEP) {
    probe.x = pos.x + dx * d;
    probe.y = pos.y + dy * d;
    probe.z = pos.z + dz * d;
    if (collideCity(probe, GUARD_RADIUS, world.buildings, world.index)) {
      return d;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * The bias the assist wants this frame, written into `out` (zero when it is
 * not engaged). `dir` is the unit direction the pilot means to fly. Returns
 * whether a hole engaged it.
 */
export function holeAssistTarget(
  pos: Vec3,
  dir: Vec3,
  world: AssistWorld,
  out: HoleAssist,
): boolean {
  out.yaw = 0;
  out.pitch = 0;
  let best: HoleSpan | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestW = 0;
  let bestYaw = 0;
  let bestPitch = 0;
  for (const s of world.spans) {
    const { axis, width, height, y0 } = s.hole;
    const x = axis === "x";
    const ia = x ? dir.x : dir.z; // intended, along the axis
    const ic = x ? dir.z : dir.x; // intended, across it
    if (Math.abs(ia) < 1e-6) continue;
    const sg = ia > 0 ? 1 : -1;
    const along =
      (x
        ? wrapDeltaAxis(s.center.x, pos.x)
        : wrapDeltaAxis(s.center.z, pos.z)) * sg;
    const lateral = x
      ? wrapDeltaAxis(s.center.z, pos.z)
      : wrapDeltaAxis(s.center.x, pos.x);
    const up = pos.y - (y0 + height / 2);
    const half = s.length / 2;
    // Before the near mouth (toMouth > 0) or inside; never past the exit.
    const toMouth = -along - half;
    if (toMouth > ASSIST_RANGE || along >= half) continue;
    if (Math.abs(lateral) > width / 2 + ASSIST_CAPTURE) continue;
    if (Math.abs(up) > height / 2 + ASSIST_CAPTURE) continue;
    // Misalignment of the intended direction off the axis.
    const heading = Math.atan2(ic, Math.abs(ia)); // + toward +across
    const elev = Math.asin(clamp(dir.y, -1, 1));
    const mis = Math.max(Math.abs(heading), Math.abs(elev));
    if (mis >= ASSIST_ALIGN_MAX) continue;
    const dist = Math.max(0, toMouth);
    if (dist >= bestDist) continue;
    // Heading/elevation onto the carrot, minus where the pilot points.
    const wantHeading = Math.atan2(-lateral, ASSIST_LOOKAHEAD);
    const wantElev = Math.atan2(-up, ASSIST_LOOKAHEAD);
    // +across is the pilot's right when travelling +x, or −z (right of a
    // nose f is (−fz, fx)).
    const rightSign = x ? sg : -sg;
    best = s;
    bestDist = dist;
    bestW =
      fade(dist, ASSIST_FULL_RANGE, ASSIST_RANGE) *
      fade(mis, ASSIST_ALIGN_FULL, ASSIST_ALIGN_MAX);
    bestYaw = (wantHeading - heading) * rightSign;
    bestPitch = wantElev - elev;
  }
  if (!best || bestW <= 0) return false;
  const yaw = clamp(bestYaw, -ASSIST_MAX_RAD, ASSIST_MAX_RAD) * bestW;
  const pitch = clamp(bestPitch, -ASSIST_MAX_RAD, ASSIST_MAX_RAD) * bestW;
  // Never into a solid: the nudged sweep must not hit sooner than the
  // pilot's own. Small angles: rotate `dir` by yaw about up, pitch about
  // the right vector (first order is plenty at ≤ 4°).
  const h = Math.hypot(dir.x, dir.z) || 1;
  const rx = -dir.z / h; // right of the intended direction
  const rz = dir.x / h;
  let nx = dir.x + rx * yaw - (dir.x / h) * dir.y * pitch;
  let ny = dir.y + h * pitch;
  let nz = dir.z + rz * yaw - (dir.z / h) * dir.y * pitch;
  const n = Math.hypot(nx, ny, nz);
  nx /= n;
  ny /= n;
  nz /= n;
  const nudged = firstHit(world, pos, nx, ny, nz);
  if (nudged !== Number.POSITIVE_INFINITY) {
    const own = firstHit(world, pos, dir.x, dir.y, dir.z);
    if (nudged < own) return false;
  }
  out.yaw = yaw;
  out.pitch = pitch;
  return true;
}

/** Glide the applied bias toward `target` at ASSIST_RATE — in place. */
export function stepHoleAssist(
  state: HoleAssist,
  target: HoleAssist,
  dt: number,
): void {
  const max = ASSIST_RATE * dt;
  state.yaw += clamp(target.yaw - state.yaw, -max, max);
  state.pitch += clamp(target.pitch - state.pitch, -max, max);
}

/**
 * Classic mode: the bias as stick, added to the pilot's own and written into
 * `out`. Each axis is capped at ASSIST_STICK_MAX and yields outright when the
 * pilot pushes the other way. `rates` are stepFlight's handling rates.
 */
export function assistStick(
  bias: HoleAssist,
  pilot: { turn: number; pitch: number },
  rates: { turnRate: number; pitchRate: number },
  out: { turn: number; pitch: number },
): void {
  const axis = (cmd: number, rad: number, rate: number) => {
    const n = clamp(
      (STICK_GAIN * rad) / rate,
      -ASSIST_STICK_MAX,
      ASSIST_STICK_MAX,
    );
    if (cmd * n < 0 && Math.abs(cmd) > ASSIST_YIELD) return cmd;
    return clamp(cmd + n, -1, 1);
  };
  out.turn = axis(pilot.turn, bias.yaw, rates.turnRate);
  out.pitch = axis(pilot.pitch, bias.pitch, rates.pitchRate);
}
