// L12 sky cycle: the night breathes. One slow loop on the SYNCED server clock
// — dusk → deep night → pre-dawn → back to dusk, SKY_CYCLE_MS long — so every
// client in a room sees the same time of night.
//
// The top half is the pure seam: `skyStateAt(timeMs)` is a function of the
// clock alone (no THREE, no DOM), returning every parameter the look is made
// of — sky gradient, fog/horizon colour, the four-light rig, the moon's arc,
// haze, stars, exposure, bloom strength, the grade's split-tone, window
// occupancy and the street-light pools. client/test/skycycle.test.ts pins its
// invariants: continuity, fog == horizon, and a facade that stays sub-bloom.
// The bottom half is the adapter that writes a state into the scene once per
// frame (uniform and light writes only — no meshes, no draw calls).
//
// NIGHT is VO1's "Neon Blue Hour" exactly (sky.ts DUSK / LIGHT_RIG / EXPOSURE,
// fog.ts HAZE_*, grade.ts tints): deep night IS today's look.

import * as THREE from "three";
import { HAZE_COLOR, HAZE_TINT, setHaze } from "./fog";
import { HIGHLIGHT_TINT, SHADOW_TINT, setGradeTone } from "./grade";
import {
  DUSK,
  EXPOSURE,
  GLOW_DIR,
  LIGHT_RIG,
  MOON_DIR,
  SKY_GRADIENT_NIGHT,
  SKY_STOPS,
  type SkyRig,
} from "./sky";
import { OCCUPANCY_UNIFORM } from "./window-pattern";

/** One full loop, ms: ~40 minutes of game time per night. */
export const SKY_CYCLE_MS = 40 * 60_000;

type Rgb = [number, number, number];

/** sRGB transfer (exact IEC 61966-2-1), per channel. */
export const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
export const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

/** An sRGB hex as LINEAR rgb — the same conversion THREE.Color(hex) makes. */
const lin = (hex: number): Rgb => [
  srgbToLinear(((hex >> 16) & 255) / 255),
  srgbToLinear(((hex >> 8) & 255) / 255),
  srgbToLinear((hex & 255) / 255),
];

/** A linear colour scaled — a dome glow's colour × strength. */
const glowOf = (hex: number, k: number): Rgb => {
  const c = lin(hex);
  return [c[0] * k, c[1] * k, c[2] * k];
};

/**
 * Everything the cycle drives. Colours are LINEAR rgb (three's working
 * space); the gradient stops run zenith → SKY_FOG_STOP and the last one,
 * `horizon`, is the fog colour — one value, so they can never disagree.
 */
export interface SkyKey {
  /** Gradient stops at canvas fractions 0, 0.14, 0.25, 0.32, 0.37. */
  zenith: Rgb;
  sky14: Rgb;
  sky25: Rgb;
  sky32: Rgb;
  sky37: Rgb;
  /** Horizon glow = clear colour = fog colour (the torus contract). */
  horizon: Rgb;
  ambient: Rgb;
  ambientI: number;
  moon: Rgb;
  moonI: number;
  glow: Rgb;
  glowI: number;
  hemiSky: Rgb;
  hemiGround: Rgb;
  hemiI: number;
  /** Height-haze colour and how far it departs from the fog colour. */
  haze: Rgb;
  hazeTint: number;
  /** Dome glow toward the warm rim light's quarter (dusk) and its opposite
   * quarter (dawn), linear colour × strength, added above SKY_FOG_STOP. */
  duskGlow: Rgb;
  dawnGlow: Rgb;
  /** Star field opacity, 0..1. */
  stars: number;
  /** Tone-mapping exposure and bloom strength (the threshold never moves). */
  exposure: number;
  bloom: number;
  /** Grade split-tone (display-referred, signed). */
  shadowTint: Rgb;
  highlightTint: Rgb;
  /** Window occupancy multiplier on the lit probability, 0..1. */
  occupancy: number;
  /** Street-lamp ground pool level, 0..1 (lamp heads keep their rung). */
  pools: number;
}

/** A full state: the blended key plus the moon's position on its arc. */
export interface SkyState extends SkyKey {
  /** Unit vector toward the moon (world space). */
  moonDir: Rgb;
  /** Moon disc + halo visibility, 0..1 — it rises and sets into the haze. */
  moonVis: number;
  /** Unit vector toward the warm/cool rim light (world space). */
  glowDir: Rgb;
}

/** Deep night — VO1 "Neon Blue Hour", bit for bit. */
export const NIGHT: SkyKey = {
  zenith: lin(SKY_GRADIENT_NIGHT[0]),
  sky14: lin(SKY_GRADIENT_NIGHT[1]),
  sky25: lin(SKY_GRADIENT_NIGHT[2]),
  sky32: lin(SKY_GRADIENT_NIGHT[3]),
  sky37: lin(SKY_GRADIENT_NIGHT[4]),
  horizon: lin(DUSK.sky),
  ambient: lin(DUSK.ambient),
  ambientI: LIGHT_RIG.ambient,
  moon: lin(DUSK.moon),
  moonI: LIGHT_RIG.moon,
  glow: lin(DUSK.glow),
  glowI: LIGHT_RIG.glow,
  hemiSky: lin(DUSK.hemiSky),
  hemiGround: lin(DUSK.hemiGround),
  hemiI: LIGHT_RIG.hemi,
  haze: lin(HAZE_COLOR),
  hazeTint: HAZE_TINT,
  duskGlow: [0, 0, 0],
  dawnGlow: [0, 0, 0],
  stars: 1,
  exposure: EXPOSURE,
  bloom: 0.4,
  shadowTint: [...SHADOW_TINT],
  highlightTint: [...HIGHLIGHT_TINT],
  occupancy: 1,
  pools: 1,
};

/** Dusk: a violet-rose horizon with the sunset's orange still burning in
 * the west, a brighter sky fill, the city only half switched on. */
export const DUSK_KEY: SkyKey = {
  zenith: lin(0x101a44),
  sky14: lin(0x1a2558),
  sky25: lin(0x2b316c),
  sky32: lin(0x3a3170),
  sky37: lin(0x48386a),
  horizon: lin(0x4c3458),
  ambient: lin(0x62608a),
  ambientI: 0.85,
  moon: lin(DUSK.moon),
  moonI: 1.5,
  glow: lin(0xff7a48),
  glowI: 1.5,
  hemiSky: lin(0x6066a6),
  hemiGround: lin(0x8a5038),
  hemiI: 1.4,
  haze: lin(0x704664),
  hazeTint: 0.5,
  duskGlow: glowOf(0xff7038, 0.5),
  dawnGlow: [0, 0, 0],
  stars: 0.3,
  exposure: 1.2,
  bloom: 0.36,
  shadowTint: [-0.02, 0.008, 0.03],
  highlightTint: [0.06, 0.016, -0.05],
  occupancy: 0.7,
  pools: 0.75,
};

/** Pre-dawn: a cool blue lift, the windows thinning out, and the faintest
 * pale glow on the eastern horizon. */
export const PREDAWN: SkyKey = {
  zenith: lin(0x0c1640),
  sky14: lin(0x15215a),
  sky25: lin(0x22306c),
  sky32: lin(0x2e3a74),
  sky37: lin(0x384476),
  horizon: lin(0x3c4878),
  ambient: lin(0x5c6890),
  ambientI: 0.85,
  moon: lin(0xb8c8ff),
  moonI: 1.6,
  glow: lin(0x7c8cc8),
  glowI: 0.7,
  hemiSky: lin(0x5c70a8),
  hemiGround: lin(0x5c4a48),
  hemiI: 1.4,
  haze: lin(0x50608a),
  hazeTint: 0.5,
  duskGlow: [0, 0, 0],
  dawnGlow: glowOf(0xa8b8e8, 0.32),
  stars: 0.5,
  exposure: 1.2,
  bloom: 0.38,
  shadowTint: [-0.03, 0.014, 0.04],
  highlightTint: [0.02, 0.012, -0.02],
  occupancy: 0.55,
  pools: 0.85,
};

/**
 * The loop, as fractions of SKY_CYCLE_MS: holds and smoothstep blends.
 * Every blend lasts ≥ 150 s, so smoothstep's peak slope (1.5 / duration)
 * keeps each parameter under 1 % of its swing per second.
 */
const SEGMENTS: readonly { from: number; to: number; a: SkyKey; b: SkyKey }[] =
  [
    { from: 0, to: 0.04, a: DUSK_KEY, b: DUSK_KEY },
    { from: 0.04, to: 0.24, a: DUSK_KEY, b: NIGHT },
    { from: 0.24, to: 0.7, a: NIGHT, b: NIGHT },
    { from: 0.7, to: 0.86, a: NIGHT, b: PREDAWN },
    { from: 0.86, to: 0.9, a: PREDAWN, b: PREDAWN },
    { from: 0.9, to: 1, a: PREDAWN, b: DUSK_KEY },
  ];

/** Named moments, as cycle fractions — the QA hook's and gallery's anchors. */
export const SKY_MOMENTS = { dusk: 0.02, night: 0.47, predawn: 0.89 } as const;

/** Where in the loop `timeMs` (server clock) falls, 0..1. */
export function skyPhase(timeMs: number): number {
  const m = timeMs % SKY_CYCLE_MS;
  return (m < 0 ? m + SKY_CYCLE_MS : m) / SKY_CYCLE_MS;
}

const smooth = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

// --- The moon's arc ---------------------------------------------------------
// The moon rises out of the haze after dusk, climbs across the sky, and sets
// back into the haze before dawn. Its path parameter u runs 0 → 1 across the
// night and swings back 1 → 0 during the wrap while the disc is invisible,
// so neither the disc nor the light it drives ever jumps. At the NIGHT
// moment u = 0.5 and the moon is exactly VO1's MOON_DIR — deep night is
// today's look, moon included.

/** Arc elevation at rise/set, rad. The disc (radius 0.045) stays above
 * SKY_FOG_STOP's 0.314 rad, so a fully fogged tower can never cut a
 * moon-shaped hole; the halo is ramped to zero at the stop in the shader. */
export const MOON_EL_LOW = 0.365;
/** Arc peak, rad: VO1's moon — low enough for a chase camera to see it. */
export const MOON_EL_PEAK = Math.asin(MOON_DIR.y);
/** Azimuth swept across the night, rad (~100°), centred on MOON_DIR's. */
const MOON_SWEEP = 1.75;
const MOON_AZ = Math.atan2(MOON_DIR.z, MOON_DIR.x);
/** u runs forward over [RISE, SET]; swings back over [SET, 1 + RISE]. */
const MOON_RISE = 0.05;
const MOON_SET = 0.89;
/** Disc fade windows (168 s): fades in after RISE, out before SET. */
const MOON_FADE = 0.07;
/** The moon KEY light while the disc is hidden, as a share of its full
 * intensity — the sky still lights the city, the moon no longer does. */
const MOON_KEY_HIDDEN = 0.4;

function moonU(f: number): number {
  if (f >= MOON_RISE && f <= MOON_SET) {
    return (f - MOON_RISE) / (MOON_SET - MOON_RISE);
  }
  // The unseen swing back: SET → 1 + RISE, smoothstepped so it eases out of
  // and into the visible sweep.
  const g = f < MOON_RISE ? f + 1 : f;
  return 1 - smooth((g - MOON_SET) / (1 + MOON_RISE - MOON_SET));
}

function moonVisibility(f: number): number {
  return (
    smooth((f - MOON_RISE) / MOON_FADE) *
    (1 - smooth((f - (MOON_SET - MOON_FADE)) / MOON_FADE))
  );
}

// --- The rim light's swing ---------------------------------------------------
// The warm rim (the old dusk sun) holds the west through dusk and the night,
// swings round to the east for pre-dawn — where the dawn glow is — and back
// over the wrap, always the same way round so it never crosses overhead.

const GLOW_AZ_WEST = Math.atan2(GLOW_DIR.z, GLOW_DIR.x);
const GLOW_EL = Math.asin(GLOW_DIR.y);
/** Swing windows (fractions): out to the east, then back through the wrap. */
const GLOW_OUT = { from: 0.55, to: 0.86 } as const;
const GLOW_BACK = { from: 0.9, to: 1.04 } as const;

function glowSwing(f: number): number {
  if (f >= GLOW_OUT.from && f <= GLOW_OUT.to) {
    return smooth((f - GLOW_OUT.from) / (GLOW_OUT.to - GLOW_OUT.from));
  }
  if (f > GLOW_OUT.to && f < GLOW_BACK.from) return 1;
  const g = f < GLOW_BACK.to - 1 ? f + 1 : f;
  if (g >= GLOW_BACK.from && g <= GLOW_BACK.to) {
    return 1 - smooth((g - GLOW_BACK.from) / (GLOW_BACK.to - GLOW_BACK.from));
  }
  return 0;
}

// --- Blending ---------------------------------------------------------------

const lerp = (a: number, b: number, w: number): number => a + (b - a) * w;

/** Field names in a fixed order — the blend loop and the tests share it. */
export const SKY_FIELDS = Object.keys(NIGHT) as (keyof SkyKey)[];

/** A fresh state object (allocate once, pass as `out` every frame). */
export function createSkyState(): SkyState {
  const s = structuredClone(NIGHT) as SkyState;
  s.moonDir = [MOON_DIR.x, MOON_DIR.y, MOON_DIR.z];
  s.moonVis = 1;
  s.glowDir = [GLOW_DIR.x, GLOW_DIR.y, GLOW_DIR.z];
  return s;
}

/**
 * The sky at server time `timeMs`. Pure and deterministic: every client
 * computes the same state from the same clock. Allocation-free when `out`
 * is supplied.
 */
export function skyStateAt(
  timeMs: number,
  out: SkyState = createSkyState(),
): SkyState {
  return skyStateAtPhase(skyPhase(timeMs), out);
}

/** As skyStateAt, from a cycle fraction 0..1 (the QA hook forces this). */
export function skyStateAtPhase(
  phase: number,
  out: SkyState = createSkyState(),
): SkyState {
  const f = phase - Math.floor(phase);
  let seg = SEGMENTS[SEGMENTS.length - 1] as (typeof SEGMENTS)[number];
  for (const s of SEGMENTS) {
    if (f < s.to) {
      seg = s;
      break;
    }
  }
  const w = smooth((f - seg.from) / (seg.to - seg.from));
  const o = out as unknown as Record<string, number | number[]>;
  for (const k of SKY_FIELDS) {
    const a = seg.a[k];
    const b = seg.b[k];
    if (typeof a === "number") {
      o[k] = lerp(a, b as number, w);
    } else {
      const dst = o[k] as number[];
      const bb = b as Rgb;
      dst[0] = lerp(a[0], bb[0], w);
      dst[1] = lerp(a[1], bb[1], w);
      dst[2] = lerp(a[2], bb[2], w);
    }
  }
  const u = moonU(f);
  const el = MOON_EL_LOW + (MOON_EL_PEAK - MOON_EL_LOW) * Math.sin(Math.PI * u);
  const az = MOON_AZ + (u - 0.5) * MOON_SWEEP;
  out.moonDir[0] = Math.cos(el) * Math.cos(az);
  out.moonDir[1] = Math.sin(el);
  out.moonDir[2] = Math.cos(el) * Math.sin(az);
  out.moonVis = moonVisibility(f);
  out.moonI *= MOON_KEY_HIDDEN + (1 - MOON_KEY_HIDDEN) * out.moonVis;
  const gaz = GLOW_AZ_WEST - Math.PI * glowSwing(f);
  out.glowDir[0] = Math.cos(GLOW_EL) * Math.cos(gaz);
  out.glowDir[1] = Math.sin(GLOW_EL);
  out.glowDir[2] = Math.cos(GLOW_EL) * Math.sin(gaz);
  return out;
}

/**
 * TS mirror of the dome shader's gradient (sky.ts skyPatch): the colour at
 * polar fraction `f` (0 zenith, 0.5 horizon), linear rgb, before the
 * additive glows and the moon. Stops mix in sRGB then decode — the old
 * canvas texture's maths — and from SKY_FOG_STOP down it is the horizon,
 * i.e. the fog colour (pinned in client/test/sky.test.ts).
 */
export function domeGradient(f: number, s: SkyKey): Rgb {
  const stops = [s.zenith, s.sky14, s.sky25, s.sky32, s.sky37, s.horizon];
  const enc = (c: Rgb): Rgb => [
    linearToSrgb(c[0]),
    linearToSrgb(c[1]),
    linearToSrgb(c[2]),
  ];
  let c = enc(stops[0] as Rgb);
  for (let i = 1; i < stops.length; i++) {
    const f0 = SKY_STOPS[i - 1] as number;
    const f1 = SKY_STOPS[i] as number;
    const w = Math.min(1, Math.max(0, (f - f0) / (f1 - f0)));
    const b = enc(stops[i] as Rgb);
    c = [lerp(c[0], b[0], w), lerp(c[1], b[1], w), lerp(c[2], b[2], w)];
  }
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
}

/** `?sky=` boot pin: a phase name or a cycle fraction; null = follow the
 * clock. The perf/gallery harnesses pin `night` so baselines never depend
 * on what time it is on the server. */
export function parseSkyParam(search: string): number | null {
  const v = new URLSearchParams(search).get("sky");
  if (v === null || v === "") return null;
  if (v in SKY_MOMENTS) return SKY_MOMENTS[v as keyof typeof SKY_MOMENTS];
  const n = Number(v);
  return Number.isFinite(n) ? n - Math.floor(n) : null;
}

/** Rec. 709 luminance of a linear colour. */
export const lumOf = (c: readonly number[]): number =>
  0.2126 * (c[0] as number) +
  0.7152 * (c[1] as number) +
  0.0722 * (c[2] as number);

/**
 * Worst-case irradiance luminance the rig can put on a surface: every light
 * at full incidence at once, the hemisphere at its brighter half — the same
 * bound client/test/facade-palette.test.ts proves the night rig against.
 */
export function rigIrradiance(s: SkyKey): number {
  return (
    lumOf(s.ambient) * s.ambientI +
    lumOf(s.moon) * s.moonI +
    lumOf(s.glow) * s.glowI +
    Math.max(lumOf(s.hemiSky), lumOf(s.hemiGround)) * s.hemiI
  );
}

// --- Adapter ----------------------------------------------------------------

/** Everything the cycle writes, gathered once in main.ts. */
export interface SkyTargets {
  rig: SkyRig;
  dome: { setCycle(s: SkyState): void };
  streetlights: { setPoolLevel(k: number): void };
  renderer: THREE.WebGLRenderer;
  /** The bloom pass (its strength follows the night). */
  bloom: { strength: number };
  /** Whatever carries the grade's uniforms (the final pass), when ?grade is on. */
  grade: { uniforms: Record<string, THREE.IUniform> } | null;
}

/**
 * Per-frame driver. Holds one state object (no per-frame allocation) and
 * the horizon colour storm.atmosphere() takes as its fog base — the storm
 * module stays the single fog writer.
 */
export class SkyCycle {
  readonly state = createSkyState();
  /** This frame's fog/horizon colour (THREE linear), for storm.atmosphere. */
  readonly horizon = new THREE.Color();
  /** QA override: a cycle fraction, or null to follow the clock. */
  forced: number | null = null;
  private phase: number = SKY_MOMENTS.night;

  constructor(
    private readonly targets: SkyTargets,
    /** Boot pin (`?sky=`), or null to follow the clock. */
    forced: number | null = null,
  ) {
    this.forced = forced;
  }

  /** Advance to server time `timeMs` (null before the first snapshot:
   * hold the last phase — deep night at boot) and write every target. */
  update(timeMs: number | null): SkyState {
    if (this.forced !== null) this.phase = this.forced;
    else if (timeMs !== null) this.phase = skyPhase(timeMs);
    const s = skyStateAtPhase(this.phase, this.state);
    const t = this.targets;
    this.horizon.setRGB(s.horizon[0], s.horizon[1], s.horizon[2]);
    t.rig.ambient.color.setRGB(s.ambient[0], s.ambient[1], s.ambient[2]);
    t.rig.ambient.intensity = s.ambientI;
    t.rig.moon.color.setRGB(s.moon[0], s.moon[1], s.moon[2]);
    t.rig.moon.intensity = s.moonI;
    t.rig.moon.position.set(s.moonDir[0], s.moonDir[1], s.moonDir[2]);
    t.rig.glow.position.set(s.glowDir[0], s.glowDir[1], s.glowDir[2]);
    t.rig.glow.color.setRGB(s.glow[0], s.glow[1], s.glow[2]);
    t.rig.glow.intensity = s.glowI;
    t.rig.hemi.color.setRGB(s.hemiSky[0], s.hemiSky[1], s.hemiSky[2]);
    t.rig.hemi.groundColor.setRGB(
      s.hemiGround[0],
      s.hemiGround[1],
      s.hemiGround[2],
    );
    t.rig.hemi.intensity = s.hemiI;
    setHaze(s.haze, s.hazeTint);
    t.dome.setCycle(s);
    OCCUPANCY_UNIFORM.value = s.occupancy;
    t.streetlights.setPoolLevel(s.pools);
    t.renderer.toneMappingExposure = s.exposure;
    t.bloom.strength = s.bloom;
    if (t.grade) setGradeTone(t.grade, s.shadowTint, s.highlightTint);
    return s;
  }

  /** Where the loop is now, 0..1. */
  get phaseNow(): number {
    return this.phase;
  }
}
