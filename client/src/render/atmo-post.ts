// S5 atmosphere in the post chain: moon light shafts (a quarter-res pass of
// its own), heat shimmer and glare (inside O4's fused FinalPass — no new
// full-res pass). Every switch is a UNIFORM, never a #define, so a quality
// tier flips them without compiling a program (O3 rule 1).
//
// The emissive ladder holds: shafts are clamped per sample to SHAFT_CAP and
// scaled by SHAFT_GAIN, the flare is a fraction of the bloom it is built
// from (flarePeakGain < 1), so nothing here can out-shine a tracer — and a
// tracer crossing the moon's disc adds at most one capped sample, never a
// streak brighter than the sky it crosses.
//
// Shimmer: every term is a pure function of the latched world clock, and
// the slowest ripple period is SHIMMER_PERIOD_S ≥ 2 s, so a frozen camera
// sees at most one sign reversal per pixel in half a second of capture.

import {
  EMISSIVE_STROBE,
  EMISSIVE_TRACER,
} from "@angels-bandits/common/constants";

// --- Light shafts -------------------------------------------------------------

/** Samples marched toward the moon per (quarter-res) pixel. */
export const SHAFT_SAMPLES = 24;
/** Per-sample luminance cap (linear): the moon's halo, not its disc. */
export const SHAFT_CAP = 0.32;
/** Luminance a sample must clear to scatter at all: the bare night sky
 * stays out, so only the moon and its halo throw rays past the skyline. */
export const SHAFT_FLOOR = 0.1;
/** Weight decay per step toward the moon. */
export const SHAFT_DECAY = 0.955;
/** Overall gain of the shafts added in FinalPass. */
export const SHAFT_GAIN = 0.45;
/** Disc around the moon the shafts live in, screen heights (radius). */
export const SHAFT_DISC = 0.45;
/** Only light within this of the moon scatters, screen heights: the moon
 * and its halo are the source, never a lit facade that shares the disc. */
export const SHAFT_SOURCE = 0.09;

/** Peak luminance the shafts can add to a pixel (all samples at the cap). */
export const shaftPeak = (): number => (SHAFT_CAP - SHAFT_FLOOR) * SHAFT_GAIN;

export const SHAFT_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uSun;       // the moon, in screen UV
uniform float uAspect;   // width / height
uniform float uStrength; // 0 = nothing (the pass is skipped before that)
varying vec2 vUv;
// Interleaved gradient noise on the PIXEL — a fixed dither, never animated.
float abIgn(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
void main() {
  vec2 d = uSun - vUv;
  float r = length(d * vec2(uAspect, 1.0));
  float mask = 1.0 - smoothstep(${(SHAFT_DISC * 0.45).toFixed(3)}, ${SHAFT_DISC.toFixed(3)}, r);
  if (mask <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 stepUv = d / ${SHAFT_SAMPLES.toFixed(1)};
  vec2 uv = vUv + stepUv * abIgn(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  float w = 1.0;
  float wsum = 0.0;
  for (int i = 0; i < ${SHAFT_SAMPLES}; i++) {
    vec3 c = texture2D(tDiffuse, uv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Only light above the floor scatters, and never more than the cap: a
    // tracer, a window or the moon disc counts as bright sky, no brighter.
    float lk = clamp(l - ${SHAFT_FLOOR.toFixed(3)}, 0.0, ${(SHAFT_CAP - SHAFT_FLOOR).toFixed(3)});
    float src = 1.0 - smoothstep(${(SHAFT_SOURCE * 0.5).toFixed(3)}, ${SHAFT_SOURCE.toFixed(3)},
      length((uSun - uv) * vec2(uAspect, 1.0)));
    c *= lk * src / max(l, 1e-4);
    acc += c * w;
    wsum += w;
    w *= ${SHAFT_DECAY.toFixed(4)};
    uv += stepUv;
  }
  gl_FragColor = vec4(acc / wsum * mask * uStrength, 1.0);
}
`;

// --- Heat shimmer -------------------------------------------------------------

/** Columns FinalPass can ripple at once. */
export const SHIMMER_SLOTS = 6;
/** Peak UV displacement, drawing-buffer pixels. */
export const SHIMMER_AMP_PX = 1.5;
/** Ripple period, s — ≥ 2 s (see the header). */
export const SHIMMER_PERIOD_S = 2.4;
/** A column fades in (and out) over this long, s. */
export const SHIMMER_FADE_S = 0.6;
/** Vents further than this are not shimmered (sub-pixel ripple), m. */
export const SHIMMER_RANGE = 220;
/** Hysteresis: a picked vent is kept until it is this × the range away. */
export const SHIMMER_KEEP = 1.15;
/** The column's height above the stack, and its half-width, m. */
export const SHIMMER_HEIGHT = 14;
export const SHIMMER_HALF_WIDTH = 1.8;
/** Vent picks are refreshed at this rate (world clock), Hz. */
export const SHIMMER_PICK_HZ = 4;

/**
 * The displacement (drawing-buffer px, signed) at fraction `t` up a column,
 * `lateral` its half-widths off the axis, `timeS` world seconds, `level` its
 * fade/distance weight 0..1. Pure mirror of the GLSL below — the tested
 * seam: |result| ≤ SHIMMER_AMP_PX.
 */
export function shimmerOffsetPx(
  t: number,
  lateral: number,
  timeS: number,
  level: number,
): number {
  if (t <= 0 || t >= 1 || Math.abs(lateral) >= 1) return 0;
  const along = smooth(0, 0.12, t) * (1 - smooth(0.65, 1, t));
  const across = 1 - smooth(0, 1, Math.abs(lateral));
  const phase =
    t * 19 - ((timeS % SHIMMER_PERIOD_S) / SHIMMER_PERIOD_S) * Math.PI * 2;
  const lv = Math.min(1, Math.max(0, level));
  return SHIMMER_AMP_PX * lv * along * across * Math.sin(phase);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** A candidate stack: a stable id and its canonical top. */
export interface ShimmerVent {
  id: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Which vents to shimmer: the previous picks stay while they are still
 * within SHIMMER_KEEP × the range and visible (hysteresis — no swapping
 * between two equidistant stacks), then the nearest visible newcomers fill
 * the free slots. `dist` and `visible` are the caller's (torus distance,
 * line of sight). Returns ids, at most SHIMMER_SLOTS. Pure.
 */
export function pickShimmerVents(
  candidates: readonly ShimmerVent[],
  previous: readonly number[],
  dist: (v: ShimmerVent) => number,
  visible: (v: ShimmerVent) => boolean,
): number[] {
  return pickShimmerVentsInto(candidates, previous, dist, visible, []);
}

/** pickShimmerVentsInto's scratch: each candidate's distance, and whether
 * it is still in the running. Grown, never shrunk. */
let pickDist = new Float64Array(64);
let pickOpen = new Uint8Array(64);

/**
 * pickShimmerVents into `out` (cleared first), allocation-free (S8): the
 * same picks in the same order — the kept ones, then newcomers nearest
 * first (ties by id) — found by repeated minimum selection over a distance
 * scratch instead of a filtered, sorted copy of the candidates.
 */
export function pickShimmerVentsInto(
  candidates: readonly ShimmerVent[],
  previous: readonly number[],
  dist: (v: ShimmerVent) => number,
  visible: (v: ShimmerVent) => boolean,
  out: number[],
): number[] {
  out.length = 0;
  for (let p = 0; p < previous.length; p++) {
    if (out.length >= SHIMMER_SLOTS) break;
    const id = previous[p] as number;
    let v: ShimmerVent | null = null;
    for (let c = 0; c < candidates.length; c++) {
      if ((candidates[c] as ShimmerVent).id === id) {
        v = candidates[c] as ShimmerVent;
        break;
      }
    }
    if (v && dist(v) <= SHIMMER_RANGE * SHIMMER_KEEP && visible(v)) {
      out.push(id);
    }
  }
  const n = candidates.length;
  if (pickDist.length < n) {
    pickDist = new Float64Array(n * 2);
    pickOpen = new Uint8Array(n * 2);
  }
  for (let c = 0; c < n; c++) {
    const v = candidates[c] as ShimmerVent;
    let kept = false;
    for (let k = 0; k < out.length; k++) if (out[k] === v.id) kept = true;
    const d = kept ? Number.POSITIVE_INFINITY : dist(v);
    pickDist[c] = d;
    pickOpen[c] = !kept && d <= SHIMMER_RANGE ? 1 : 0;
  }
  while (out.length < SHIMMER_SLOTS) {
    let best = -1;
    for (let c = 0; c < n; c++) {
      if (pickOpen[c] === 0) continue;
      if (
        best < 0 ||
        (pickDist[c] as number) < (pickDist[best] as number) ||
        ((pickDist[c] as number) === (pickDist[best] as number) &&
          (candidates[c] as ShimmerVent).id <
            (candidates[best] as ShimmerVent).id)
      ) {
        best = c;
      }
    }
    if (best < 0) break;
    pickOpen[best] = 0;
    const v = candidates[best] as ShimmerVent;
    if (visible(v)) out.push(v.id);
  }
  return out;
}

// --- Glare ----------------------------------------------------------------------

/** Anamorphic streak taps (each side) and their weights. */
export const STREAK_WEIGHTS: readonly number[] = [0.5, 0.3, 0.17, 0.08];
/** Streak tap spacing, screen widths. */
export const STREAK_STEP = 0.014;
export const STREAK_GAIN = 0.16;
/** Ghosts: mirrored through the centre at these scales. */
export const GHOST_SCALES: readonly number[] = [0.55, 1.4];
export const GHOST_GAIN = 0.06;
/** Only bloom above this (linear) streaks or makes a ghost — the brightest
 * lights (lamps, beacons, strobes, tracers), never a lit window grid. */
export const GLARE_FLOOR = 0.12;

/**
 * Most the flare can add to one pixel, as a share of the brightest bloom
 * value on screen (every tap landing on it). < 1: a flare is always dimmer
 * than the light it comes from.
 */
export function flarePeakGain(): number {
  const streak = 2 * STREAK_WEIGHTS.reduce((a, w) => a + w, 0) * STREAK_GAIN;
  return streak + GHOST_SCALES.length * GHOST_GAIN;
}

/** The brightest a flare off the strobe rung can be — under the tracer's. */
export const flareCeiling = (): number => flarePeakGain() * EMISSIVE_STROBE;
export const TRACER_RUNG = EMISSIVE_TRACER;

const f = (n: number): string => n.toFixed(4);

/** FinalPass's uniform declarations and helpers for shimmer and glare. */
export const FINAL_ATMO_PARS_GLSL = /* glsl */ `
uniform sampler2D tShafts;
uniform vec3 uShaftTint;
uniform vec4 uShimA[${SHIMMER_SLOTS}]; // base.xy, top.xy (aspect-corrected UV)
uniform vec4 uShimB[${SHIMMER_SLOTS}]; // half-width (UV), level, -, -
uniform int uShimCount;
uniform float uShimTime;               // world s, wrapped to the period
uniform vec2 uTexel;                   // 1 / drawing-buffer size
uniform float uAspect;
uniform float uGlare;
float abShSmooth(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
vec2 abShimmer(vec2 uv) {
  float dx = 0.0;
  vec2 p = uv * vec2(uAspect, 1.0);
  for (int i = 0; i < ${SHIMMER_SLOTS}; i++) {
    if (i >= uShimCount) break;
    vec2 base = uShimA[i].xy;
    vec2 seg = uShimA[i].zw - base;
    float len2 = max(dot(seg, seg), 1e-8);
    float t = dot(p - base, seg) / len2;
    vec2 foot = base + seg * clamp(t, 0.0, 1.0);
    float lateral = length(p - foot) / max(uShimB[i].x, 1e-5);
    if (t <= 0.0 || t >= 1.0 || lateral >= 1.0) continue;
    float along = abShSmooth(0.0, 0.12, t) * (1.0 - abShSmooth(0.65, 1.0, t));
    float across = 1.0 - abShSmooth(0.0, 1.0, lateral);
    float phase = t * 19.0 - uShimTime * ${f((Math.PI * 2) / SHIMMER_PERIOD_S)};
    dx += ${f(SHIMMER_AMP_PX)} * clamp(uShimB[i].y, 0.0, 1.0) * along * across * sin(phase);
  }
  return vec2(dx * uTexel.x, 0.0);
}
vec3 abBloomAt(vec2 uv) {
  vec4 b = texture2D(tBloom, uv);
  return b.rgb * b.a;
}
// Only the brightest lights flare: the bloom above GLARE_FLOOR. A window
// grid's glow (and its living-window toggles) never streaks.
vec3 abHot(vec2 uv) {
  return max(abBloomAt(uv) - ${f(GLARE_FLOOR)}, 0.0);
}
vec3 abGlare(vec2 uv) {
  vec3 streak = vec3(0.0);
${STREAK_WEIGHTS.map(
  (w, i) =>
    `  streak += ${f(w)} * (abHot(uv + vec2(${f(STREAK_STEP * (i + 1))}, 0.0)) + abHot(uv - vec2(${f(STREAK_STEP * (i + 1))}, 0.0)));`,
).join("\n")}
  vec3 glare = streak * ${f(STREAK_GAIN)} * vec3(0.72, 0.86, 1.0);
  vec2 mirror = vec2(1.0) - uv;
${GHOST_SCALES.map(
  (s, i) => `  {
    vec2 g = 0.5 + (mirror - 0.5) * ${f(s)};
    float edge = 1.0 - smoothstep(0.25, 0.7, length(g - 0.5));
    vec3 b = abHot(g);
    glare += b * edge * ${f(GHOST_GAIN)} * ${i === 0 ? "vec3(1.0, 0.7, 0.4)" : "vec3(0.45, 0.8, 1.0)"};
  }`,
).join("\n")}
  return glare;
}
`;
