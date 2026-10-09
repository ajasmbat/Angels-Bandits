// R3 rain readability: the pure maths behind the streaks (rain.ts draws
// them). No three.js here, so the rules the ticket sets are unit-tested
// (client/test/rain-look.test.ts) on exactly the numbers the shader uses:
//
//  - ORIENTATION: a streak lies along the drop's own fall (gravity + the
//    shared wind) with only a mild, capped lean from the camera's motion.
//    Streaking along the RELATIVE velocity, as L4 did, lines every drop up
//    with the flight path at speed — a radial fan out of the vanishing
//    point, "warp speed" over the whole frame.
//  - LOOK: faster means sparser, fainter and shorter. At 80–125 m/s rain is
//    a thin scatter plus beads on the lens edge (hud.ts), never a wall.
//  - COVERAGE: the expected share of screen pixels the streaks touch, and
//    the drop count that keeps it under budget at the live focal length.
//    The ~1.5 px width floor is what makes a low resolution the worst case.

import { MIN_SPEED } from "@angels-bandits/common/constants";

/** Horizontal box edge, m — must divide WORLD_SIZE (seam-invariant field). */
export const RAIN_BOX_XZ = 80;
/** Vertical box edge, m (no seam on Y). */
export const RAIN_BOX_Y = 40;
/** Drops at full downpour, before the tier, speed and coverage cuts. */
export const RAIN_MAX_DROPS = 8000;
/** Terminal fall speed, m/s. */
export const RAIN_FALL_SPEED = 11;
/** Drops nearer than this collapse — the lens never fills with rain. */
export const RAIN_NEAR_CUT = 4;
/** …and reach full strength only past this, m (the ~8 m near fade). */
export const RAIN_NEAR_FULL = 8;
/** The box fade: a drop is gone past this share of the box half-edges. */
export const RAIN_FADE_END = 0.5;
/** Streak half-width, m; it widens by this share per metre of distance. */
export const STREAK_HALF_WIDTH = 0.02;
export const STREAK_WIDEN_PER_M = 0.03;
/** A streak is never drawn thinner than this many drawing-buffer px (O5). */
export const STREAK_MIN_PX = 1.5;
/** Hard rule: rain covers at most this share of the screen's pixels. */
export const RAIN_COVERAGE_CAP = 0.08;
/** The streaks' share of that; the rest is the lens-edge droplets. */
export const STREAK_COVERAGE_BUDGET = 0.075;
/** Lean: this share of the camera's velocity tilts the streak… */
export const LEAN_GAIN = 0.05;
/** …capped at this share of the fall speed (asin(0.45) ≈ 27° at most). */
export const LEAN_MAX = 0.45;
/** Speed at and past which rain reads at its sparsest, m/s. */
export const RAIN_FAST = 110;
/** Speed thinning's soft band: a drop fades over this share of the hash
 * range above the drawn share instead of popping (rain.ts). */
export const RAIN_THIN_BAND = 0.08;

export interface V3 {
  x: number;
  y: number;
  z: number;
}

const smooth01 = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/**
 * Unit streak direction, pointing the way the drop falls: `fall` (the
 * drop's world velocity — gravity plus wind drift) leaned against `camVel`
 * by LEAN_GAIN, the lean capped at LEAN_MAX × |fall|. Writes `out`.
 */
export function streakDir(fall: V3, camVel: V3, out: V3): V3 {
  let lx = -camVel.x * LEAN_GAIN;
  let ly = -camVel.y * LEAN_GAIN;
  let lz = -camVel.z * LEAN_GAIN;
  const fallLen = Math.hypot(fall.x, fall.y, fall.z);
  const leanLen = Math.hypot(lx, ly, lz);
  const maxLean = LEAN_MAX * fallLen;
  if (leanLen > maxLean && leanLen > 0) {
    const s = maxLean / leanLen;
    lx *= s;
    ly *= s;
    lz *= s;
  }
  const x = fall.x + lx;
  const y = fall.y + ly;
  const z = fall.z + lz;
  const len = Math.hypot(x, y, z);
  if (len < 1e-6) {
    out.x = 0;
    out.y = -1;
    out.z = 0;
  } else {
    out.x = x / len;
    out.y = y / len;
    out.z = z / len;
  }
  return out;
}

export interface RainLook {
  /** Share of the drops drawn, 0..1 (a per-drop seed threshold). */
  density: number;
  /** Alpha multiplier, 0..1. */
  alpha: number;
  /** Streak length, m. */
  length: number;
  /** Rain beading on the lens rim (hud.ts), share of the rain level: the
   * faster the plane, the more the canopy catches. */
  lens: number;
}

/** Speed → how the rain reads: full at MIN_SPEED, sparse/faint/short at
 * RAIN_FAST and beyond. Writes `out`. */
export function rainSpeedLook(speed: number, out: RainLook): RainLook {
  const t = smooth01((speed - MIN_SPEED) / (RAIN_FAST - MIN_SPEED));
  out.density = 1 - 0.7 * t;
  out.alpha = 1 - 0.45 * t;
  out.length = 1.1 - 0.5 * t;
  out.lens = 0.35 + 0.65 * t;
  return out;
}

/** Pixel focal length: drawing-buffer height and vertical FOV (degrees). */
export function focalPx(bufferHeight: number, fovDeg: number): number {
  return bufferHeight / 2 / Math.tan((fovDeg * Math.PI) / 360);
}

/** Drawn streak width at distance `d`, px (the shader's width rule). */
export function streakWidthPx(d: number, focal: number): number {
  const w = (2 * STREAK_HALF_WIDTH * (1 + d * STREAK_WIDEN_PER_M) * focal) / d;
  return Math.max(w, STREAK_MIN_PX);
}

const COVERAGE_STEPS = 48;

/**
 * Expected share of screen pixels covered by `count` streaks `length` m long
 * at pixel focal length `focal`. An UPPER bound, on purpose: every drop in a
 * sphere out to the box fade counts at the box's density, every streak is
 * taken side-on (full projected length), faded drops count as fully drawn,
 * and overlaps are not merged.
 *
 * A shell at depth d holds ρ·(A/f²)·d²·dd drops in view (A = screen px²),
 * each covering (L·f/d)·w(d) px, so coverage = ρ·(L/f)·∫ d·w(d) dd.
 */
export function rainCoverage(
  count: number,
  length: number,
  focal: number,
): number {
  const rho = count / (RAIN_BOX_XZ * RAIN_BOX_XZ * RAIN_BOX_Y);
  const d0 = RAIN_NEAR_CUT;
  const d1 = RAIN_BOX_XZ * RAIN_FADE_END;
  const step = (d1 - d0) / COVERAGE_STEPS;
  let sum = 0;
  for (let i = 0; i < COVERAGE_STEPS; i++) {
    const d = d0 + (i + 0.5) * step;
    sum += d * streakWidthPx(d, focal) * step;
  }
  return (rho * length * sum) / focal;
}

/**
 * The streak instances to draw: the downpour's share of RAIN_MAX_DROPS
 * scaled by the quality tier (`tierDensity`), then capped so the drawn
 * share (`look.density` of them, plus the fade band) stays inside STREAK_COVERAGE_BUDGET at the
 * live focal length. The render and the QA count both come from here.
 */
export function rainCount(
  rain: number,
  tierDensity: number,
  look: RainLook,
  focal: number,
): number {
  const want = Math.round(
    RAIN_MAX_DROPS * Math.min(1, Math.max(0, rain) / 0.9) * tierDensity,
  );
  if (want === 0) return 0;
  const drawn = Math.min(1, look.density * (1 + RAIN_THIN_BAND));
  const perDrop = rainCoverage(1, look.length, focal) * drawn;
  if (perDrop <= 0) return want;
  return Math.min(want, Math.floor(STREAK_COVERAGE_BUDGET / perDrop));
}
