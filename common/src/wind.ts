// Shared wind (L9), a pure function of the synced server clock — the storm
// trick applied to the air: every client computes the same gusts from the
// same clock, so nothing about the wind is ever streamed. L4's weather can
// read windAt() rather than define a second wind.
//
// TREE SWAY AND DRAW == COLLIDE. A crown is drawn as the ellipsoid inscribed
// in its treeBoxes() canopy box, and that ellipsoid is what collideNature()
// treats as solid. Sway may never push a drawn vertex outside it, so:
//   - the crown is drawn at CROWN_DRAW_SCALE in ALL three axes (unit space,
//     i.e. before the instance matrix scales it to the box), and
//   - every vertex moves at most CROWN_SWAY_MAX · k(y) sideways, with
//     k(y) = 0.5 + 0.5·y in [0, 1] — top-weighted, so the crown leans.
// For a unit-sphere vertex v: |s·v + δ| ≤ s + (1 − s)·k ≤ 1. The swayed
// vertex is inside the unit ball, so the scaled crown is inside the solid
// ellipsoid and therefore inside the canopy box. The price is a thin shell of
// solid-but-unpainted air at rest: (1 − s)·canopyR sideways (≤ 0.55 m) and
// (1 − s)·canopyH/2 at top and base (≤ ~0.63 m), on top of the 0.1 m slack.
// The trunk still reaches 0.3·canopyH into the crown, far past the drawn
// base at 0.05·canopyH, so no gap opens under a raised crown.
//
// TORUS. Instances re-image by ±WORLD_SIZE as the camera moves. Every
// spatial phase is a dot product with an INTEGER lattice vector scaled by
// 2π / WORLD_SIZE, so a re-imaged instance keeps exactly its phase. The wind
// direction only steers the displacement; it never enters a spatial phase.
//
// crownSway() and CROWN_SWAY_GLSL are the same function twice — the CPU twin
// is what the containment test checks, and the GLSL is generated from the
// same exported constants so the two cannot silently drift apart.

import { WORLD_SIZE } from "./constants";

/** Drawn crown size as a fraction of its solid ellipsoid, every axis. */
export const CROWN_DRAW_SCALE = 0.9;
/** Largest sideways vertex displacement, unit-sphere space. */
export const CROWN_SWAY_MAX = 1 - CROWN_DRAW_SCALE;

/** Prevailing wind heading (rad, from +x toward +z) the veer swings about. */
export const WIND_BASE_HEADING = 0.7;
/** The heading's veer about the prevailing one: [amplitude rad, period s]. */
const VEER: readonly (readonly [number, number])[] = [
  [0.5, 173],
  [0.25, 61],
];
/** The strength's mean and its breathing terms: [amplitude, period s]. */
const STRENGTH_MEAN = 0.55;
const BREATH: readonly (readonly [number, number])[] = [
  [0.25, 47],
  [0.2, 13.7],
];
/** Gust fronts: two lattice waves rolling across the city. Wavelengths
 * WORLD_SIZE/|k| ≈ 630 m and 890 m; one gust cycle every GUST_PERIOD_S. */
export const GUST_K1: readonly [number, number] = [3, 1];
export const GUST_K2: readonly [number, number] = [-1, 2];
const GUST_PERIOD_S = 23;
/** Flutter: short lattice waves (≈ 46 m, 57 m) so neighbouring crowns are
 * out of step, and fast enough to read as leaves working in the wind. */
export const FLUTTER_KA: readonly [number, number] = [23, 37];
export const FLUTTER_KB: readonly [number, number] = [-31, 17];
const FLUTTER_A_PERIOD_S = 2.7;
const FLUTTER_B_PERIOD_S = 1.9;
/** Weights of the along-wind displacement: steady lean + gust + flutter.
 * LEAN − FLUTTER ≥ 0 and the along/across pair stays inside the unit disc:
 * √((LEAN + GUST + FLUTTER)² + ACROSS²) = √(0.81 + 0.04) < 1. */
export const SWAY_LEAN = 0.3;
export const SWAY_GUST = 0.35;
export const SWAY_FLUTTER = 0.25;
export const SWAY_ACROSS = 0.2;

const TAU = Math.PI * 2;

/** The wind at one instant: unit horizontal direction and a 0..1 strength. */
export interface Wind {
  x: number;
  z: number;
  strength: number;
}

/** Time phases of the sway waves, rad in [0, 2π). */
export interface SwayPhases {
  gust: number;
  flutterA: number;
  flutterB: number;
}

/** (t / period) mod 1 as an angle — done in doubles, so a large server
 * clock never reaches the shader as a float32 that has lost its seconds. */
const cycle = (t: number, period: number): number =>
  (((t / period) % 1) + 1) % 1;

/**
 * The shared wind at `serverMs`. The heading veers slowly about the
 * prevailing one; the strength breathes between 0.1 and 1.
 */
export function windAt(serverMs: number, out?: Wind): Wind {
  const t = serverMs / 1000;
  // Index loops, not `for…of` with destructuring (S8: no per-frame
  // iterator or tuple reads — this runs every frame on the client).
  let heading = WIND_BASE_HEADING;
  for (let i = 0; i < VEER.length; i++) {
    const v = VEER[i] as readonly [number, number];
    heading += v[0] * Math.sin(TAU * cycle(t, v[1]));
  }
  let strength = STRENGTH_MEAN;
  for (let i = 0; i < BREATH.length; i++) {
    const v = BREATH[i] as readonly [number, number];
    strength += v[0] * Math.sin(TAU * cycle(t, v[1]));
  }
  const w = out ?? { x: 0, z: 0, strength: 0 };
  w.x = Math.cos(heading);
  w.z = Math.sin(heading);
  w.strength = strength;
  return w;
}

// --- Air drift (S5) ----------------------------------------------------------
// Where the air itself has carried something by `serverMs`: the fog banks
// slide on it and the litter hops along it, so everything the wind moves
// moves the way windAt() blows. It is the EXACT time integral of
//
//   v(t) = AIR_DRIFT_MPS · s(t) · (ĥ0 + δ(t)·n̂0)
//
// — windAt's strength s and veer δ about the prevailing heading ĥ0 (n̂0 its
// left normal), i.e. the heading linearised about ĥ0. Both s and δ are sums
// of sines, so s·δ expands to sums of cosines and the integral is closed
// form: any instant is O(1), every client computes the same drift. The
// linearisation points v within atan(δ) − δ ≤ 0.11 rad of windAt's heading
// (|δ| ≤ 0.75) and runs up to √(1 + δ²) ≈ 1.25× fast at the veer extremes —
// accepted for cosmetic drift (AIR_DRIFT_MPS is set for the mean).

/** Air speed at full wind strength, m/s. */
export const AIR_DRIFT_MPS = 3;

/** The drift's velocity, m/s, at `serverMs` — the integrand above (tests). */
export function airVelocity(
  serverMs: number,
  out: { x: number; z: number } = { x: 0, z: 0 },
): { x: number; z: number } {
  const t = serverMs / 1000;
  let s = STRENGTH_MEAN;
  for (const [a, p] of BREATH) s += a * Math.sin(TAU * cycle(t, p));
  let d = 0;
  for (const [b, p] of VEER) d += b * Math.sin(TAU * cycle(t, p));
  const hx = Math.cos(WIND_BASE_HEADING);
  const hz = Math.sin(WIND_BASE_HEADING);
  out.x = AIR_DRIFT_MPS * s * (hx - d * hz);
  out.z = AIR_DRIFT_MPS * s * (hz + d * hx);
  return out;
}

/** ∫ sin(ω t) dt and ∫ cos(ω t) dt, with ω = 2π / period, at `t` seconds. */
const intSin = (t: number, period: number): number =>
  (-period / TAU) * Math.cos(TAU * cycle(t, period));
const intCos = (t: number, period: number): number =>
  (period / TAU) * Math.sin(TAU * cycle(t, period));
/** sin(a)·sin(b) = ½[cos(a − b) − cos(a + b)]: ∫ of the product of two
 * sines of periods p and q, as two cosines of the sum/difference periods. */
function intSinSin(t: number, p: number, q: number): number {
  const fDiff = 1 / p - 1 / q;
  const fSum = 1 / p + 1 / q;
  // The difference cosine: frequency 0 would be a constant ½ (never the
  // case for these periods, but keep the integral honest).
  const diff = fDiff === 0 ? t : intCos(t, 1 / Math.abs(fDiff));
  return 0.5 * (diff - intCos(t, 1 / fSum));
}

/** Wrap a metre coordinate into [0, WORLD_SIZE). */
const wrapWorld = (v: number): number =>
  ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

/**
 * How far the shared air has carried a parcel by `serverMs` (m, wrapped to
 * [0, WORLD_SIZE) per axis — add it to a canonical position, then take the
 * nearest image). Pure; allocation-free with `out`.
 */
export function airDrift(
  serverMs: number,
  out: { x: number; z: number } = { x: 0, z: 0 },
): { x: number; z: number } {
  const t = serverMs / 1000;
  // Along the prevailing heading: ∫ s. The mean term grows without bound
  // (~5e9 m at today's epoch), still resolved to ~1e-6 m in doubles; the
  // wrap below brings it home.
  let along = STRENGTH_MEAN * t;
  for (let i = 0; i < BREATH.length; i++) {
    const v = BREATH[i] as readonly [number, number];
    along += v[0] * intSin(t, v[1]);
  }
  // Across it: ∫ s·δ.
  let across = 0;
  for (let j = 0; j < VEER.length; j++) {
    const w = VEER[j] as readonly [number, number];
    const b = w[0];
    const q = w[1];
    across += STRENGTH_MEAN * b * intSin(t, q);
    for (let i = 0; i < BREATH.length; i++) {
      const v = BREATH[i] as readonly [number, number];
      across += v[0] * b * intSinSin(t, v[1], q);
    }
  }
  const hx = Math.cos(WIND_BASE_HEADING);
  const hz = Math.sin(WIND_BASE_HEADING);
  const u = AIR_DRIFT_MPS;
  out.x = wrapWorld(u * (along * hx - across * hz));
  out.z = wrapWorld(u * (along * hz + across * hx));
  return out;
}

/** The sway waves' time phases at `serverMs`. */
export function swayPhases(serverMs: number, out?: SwayPhases): SwayPhases {
  const t = serverMs / 1000;
  const p = out ?? { gust: 0, flutterA: 0, flutterB: 0 };
  p.gust = TAU * cycle(t, GUST_PERIOD_S);
  p.flutterA = TAU * cycle(t, FLUTTER_A_PERIOD_S);
  p.flutterB = TAU * cycle(t, FLUTTER_B_PERIOD_S);
  return p;
}

/** 2π / WORLD_SIZE: one lattice step's phase per metre. */
const TAU_W = TAU / WORLD_SIZE;
const lattice = (k: readonly [number, number], x: number, z: number) =>
  TAU_W * (k[0] * x + k[1] * z);

/**
 * Sideways displacement, unit-sphere space, of a crown vertex at height `vy`
 * (its unit-sphere y, −1..1) on the crown standing at (x, z) — any torus
 * image of it. |out| ≤ CROWN_SWAY_MAX · k(vy) ≤ CROWN_SWAY_MAX.
 */
export function crownSway(
  x: number,
  z: number,
  vy: number,
  wind: Wind,
  phases: SwayPhases,
  out: { x: number; z: number },
): { x: number; z: number } {
  const g =
    0.5 +
    0.25 * Math.sin(lattice(GUST_K1, x, z) - phases.gust) +
    0.25 * Math.sin(lattice(GUST_K2, x, z) - phases.gust);
  const fa = Math.sin(lattice(FLUTTER_KA, x, z) + phases.flutterA);
  const fb = Math.sin(lattice(FLUTTER_KB, x, z) + phases.flutterB);
  const along = wind.strength * (SWAY_LEAN + SWAY_GUST * g + SWAY_FLUTTER * fa);
  const across = wind.strength * SWAY_ACROSS * fb;
  const k = Math.min(1, Math.max(0, 0.5 + 0.5 * vy));
  const amp = CROWN_SWAY_MAX * k;
  out.x = amp * (wind.x * along - wind.z * across);
  out.z = amp * (wind.z * along + wind.x * across);
  return out;
}

/** A GLSL float literal (always with a decimal point). */
const f = (n: number): string => {
  const s = String(n);
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
};
const v2 = (k: readonly [number, number]) => `vec2(${f(k[0])}, ${f(k[1])})`;

/** Uniform names the renderer binds. */
export const SWAY_UNIFORM_WIND = "uWind";
export const SWAY_UNIFORM_PHASE = "uSwayPhase";

/**
 * crownSway() in GLSL, generated from the same constants. Declares
 * `uWind` (dir.x, dir.z, strength) and `uSwayPhase` (gust, flutterA,
 * flutterB); call crownSway(instanceXZ, position.y).
 */
export const CROWN_SWAY_GLSL = `
uniform vec3 ${SWAY_UNIFORM_WIND};
uniform vec3 ${SWAY_UNIFORM_PHASE};
vec2 crownSway(vec2 p, float vy) {
  const float TAU_W = ${f(TAU_W)};
  float g = 0.5
    + 0.25 * sin(TAU_W * dot(${v2(GUST_K1)}, p) - ${SWAY_UNIFORM_PHASE}.x)
    + 0.25 * sin(TAU_W * dot(${v2(GUST_K2)}, p) - ${SWAY_UNIFORM_PHASE}.x);
  float fa = sin(TAU_W * dot(${v2(FLUTTER_KA)}, p) + ${SWAY_UNIFORM_PHASE}.y);
  float fb = sin(TAU_W * dot(${v2(FLUTTER_KB)}, p) + ${SWAY_UNIFORM_PHASE}.z);
  float along = ${SWAY_UNIFORM_WIND}.z * (${f(SWAY_LEAN)} + ${f(SWAY_GUST)} * g + ${f(SWAY_FLUTTER)} * fa);
  float across = ${SWAY_UNIFORM_WIND}.z * ${f(SWAY_ACROSS)} * fb;
  float amp = ${f(CROWN_SWAY_MAX)} * clamp(0.5 + 0.5 * vy, 0.0, 1.0);
  return amp * vec2(
    ${SWAY_UNIFORM_WIND}.x * along - ${SWAY_UNIFORM_WIND}.y * across,
    ${SWAY_UNIFORM_WIND}.y * along + ${SWAY_UNIFORM_WIND}.x * across);
}
`;

/** The begin_vertex replacement: shrink the crown, then sway it by its
 * instance's ground position (the instance matrix's translation). */
export const CROWN_BEGIN_VERTEX_GLSL = `
vec3 transformed = vec3(position) * ${f(CROWN_DRAW_SCALE)};
#ifdef USE_INSTANCING
transformed.xz += crownSway(instanceMatrix[3].xz, position.y);
#endif
`;
