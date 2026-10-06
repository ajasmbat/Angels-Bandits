// VO3 "Roofs & crowns" seam (archetypeFor / signageFor idiom). The city is
// one InstancedMesh painted in the shader, so a roof's look is decided HERE,
// in pure deterministic TypeScript, and delivered to the GPU as per-instance
// attributes (city.ts) — the shader only paints what this module chose.
// Everything is seeded from the building's own position and dimensions via
// the shared mulberry32 (never Math.random, never a torus image), so every
// client dresses identical roofs and nothing changes when a building wraps.
//
// Three decisions per building:
//  - a roof KIND per tier (membrane / gravel / skylights / garden / helipad),
//  - an LED edge-outline colour on a seeded subset of tall towers,
//  - a crown floodlight wash on the top floors of the tallest.
// The palettes (albedo and emissive) live here too, so the shader emitters
// in window-pattern.ts and the ladder test read ONE set of numbers.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import {
  EMISSIVE_SIGN,
  LANDMARK_HEIGHT,
} from "@angels-bandits/common/constants";
import * as THREE from "three";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import { emissiveBoost } from "./emissive";

/** Roof paint per tier. A const object + union — the repo has no TS enums. */
export const RoofKind = {
  MEMBRANE: 0,
  GRAVEL: 1,
  SKYLIGHTS: 2,
  GARDEN: 3,
  HELIPAD: 4,
} as const;
export type RoofKind = (typeof RoofKind)[keyof typeof RoofKind];

/** The parapet lip (facade-garnish.ts: 1.1 m thick, centred on the roof
 * edge) covers the outer ~0.55 m of every roof — roof paint that must be
 * SEEN starts this far in. */
export const PARAPET_INSET = 0.6;

/** Towers at least this tall may carry an LED edge outline… */
export const LED_MIN_HEIGHT = 100;
/** …with this probability (landmarks always do — they are the orientation). */
export const LED_CHANCE = 0.4;
/** Towers at least this tall get the uplit crown (and every landmark). */
export const CROWN_MIN_HEIGHT = 150;
/** Helipads: big flat mid-rise roofs only. Under 120 m keeps them off every
 * mast roof (roofclutter MAST_MIN_HEIGHT) and every searchlight station
 * (the ten tallest non-landmarks, all ~190 m+). */
export const HELIPAD_MIN_HEIGHT = 50;
export const HELIPAD_MAX_HEIGHT = 120;
export const HELIPAD_MIN_ROOF = 34;
export const HELIPAD_CHANCE = 0.18;

/** Touchdown-circle radius on a helipad roof, m — shared by the shader (which
 * derives it from the tier's half extents) and roofClutterFor (which keeps
 * the pad clear). */
export const helipadRadius = (roofWidth: number, roofDepth: number): number =>
  0.62 * (Math.min(roofWidth, roofDepth) / 2 - PARAPET_INSET);

// --- Palettes (linear — GLSL space) -------------------------------------

/** Roof albedos. Up-facing roofs catch the whole hemisphere sky plus ~40%
 * of the moon key, so these mid tones read without ever approaching the
 * bloom threshold (client/test/facade-palette.test.ts bounds them). */
export const ROOF_ALBEDO = {
  membrane: new THREE.Color(0.3, 0.31, 0.34), // light single-ply, cool grey
  gravel: new THREE.Color(0.24, 0.23, 0.2), // ballast, warm grey
  coping: new THREE.Color(0.35, 0.34, 0.33), // pavers inside the parapet
  skyGlass: new THREE.Color(0.035, 0.045, 0.065), // skylight glazing
  deck: new THREE.Color(0.08, 0.09, 0.1), // helipad deck
  padWhite: new THREE.Color(0.46, 0.46, 0.44), // the H
  padYellow: new THREE.Color(0.46, 0.34, 0.05), // touchdown circle
  bed: new THREE.Color(0.035, 0.08, 0.03), // planted beds
  path: new THREE.Color(0.2, 0.18, 0.15), // garden paths
} as const;

/** Skylight interior glow — a sub-bloom read of the floor below. */
export const SKYLIGHT_LUMINANCE = 0.3;
export const SKYLIGHT_COLOR = new THREE.Color(1.0, 0.76, 0.46).multiplyScalar(
  emissiveBoost(new THREE.Color(1.0, 0.76, 0.46), SKYLIGHT_LUMINANCE),
);
/** Helipad perimeter lights: steady green, under the SIGN rung. */
export const PAD_LIGHT_LUMINANCE = 0.9;
export const PAD_LIGHT_COLOR = new THREE.Color(0.25, 1.0, 0.4).multiplyScalar(
  emissiveBoost(new THREE.Color(0.25, 1.0, 0.4), PAD_LIGHT_LUMINANCE),
);
/** Warm bollards at garden path crossings — glints, under bloom. */
export const GARDEN_LIGHT_LUMINANCE = 0.6;
export const GARDEN_LIGHT_COLOR = new THREE.Color(
  1.0,
  0.7,
  0.38,
).multiplyScalar(
  emissiveBoost(new THREE.Color(1.0, 0.7, 0.38), GARDEN_LIGHT_LUMINANCE),
);

/** LED outline peak: architectural neon, between the WINDOW (0.88) and SIGN
 * (0.93) rungs — it blooms like a sign strip, never above one. */
export const LED_LUMINANCE = 0.9;
/** LED hues (pre-boost). Each is lifted to exactly LED_LUMINANCE. */
export const LED_HUES = [
  new THREE.Color(0.15, 0.82, 1.0), // cyan
  new THREE.Color(1.0, 0.22, 0.78), // magenta
  new THREE.Color(0.72, 0.86, 1.0), // ice white
  new THREE.Color(1.0, 0.76, 0.46), // warm white
  new THREE.Color(0.58, 0.38, 1.0), // violet
] as const;
const LED_LANDMARK = 0; // landmarks share the city's teal-cyan identity

/** Crown floodlight tints, max component 1 (the bound in the ladder test
 * multiplies the brightest albedo by the largest component). */
export const CROWN_TINTS = [
  new THREE.Color(1.0, 0.8, 0.56), // warm white (sodium-free 3000 K)
  new THREE.Color(0.8, 0.9, 1.0), // cool white
  new THREE.Color(1.0, 0.72, 0.34), // gold
  new THREE.Color(0.42, 0.86, 1.0), // cyan
  new THREE.Color(1.0, 0.46, 0.86), // magenta
] as const;
/** Crown wash gain: the wash is LIGHT (it multiplies the facade's albedo),
 * sized so the worst case — brightest finish, every rig light at full
 * incidence — stays a sub-bloom wash, never a 40 m bloom blob. */
export const CROWN_GAIN = 1.3;
/** Crown depth: the lit top floors, m — a share of the height, clamped. */
export const crownDepth = (height: number): number =>
  Math.min(Math.max(height * 0.14, 14), 32);

export interface RoofStyle {
  /** One roof kind per tier, bottom-up (a helipad only ever tops the stack). */
  tierKinds: RoofKind[];
  /** Roof tone in [0, 1): albedo × (1 − FACADE.roofVar × tone). */
  tone: number;
  /** LED outline colour, linear, already boosted to LED_LUMINANCE. */
  led: THREE.Color | null;
  /** Crown wash: tint × CROWN_GAIN, and the lit depth (top tier only). */
  crown: { color: THREE.Color; depth: number } | null;
}

const pick = <T>(list: readonly T[], r: number): T =>
  list[Math.min(list.length - 1, Math.floor(r * list.length))] as T;

/** Deterministic roof style for one building. */
export function roofStyleFor(b: Building): RoofStyle {
  // Own salt: the clutter stream hashes the same (x, z, height), and a shared
  // stream would correlate "has a helipad" with "has a water tower".
  const rand = mulberry32(
    (Math.imul(b.x, 2654435761) ^
      Math.imul(b.z, 40503) ^
      Math.imul(b.height, 2246822519) ^
      0x7f4a7c15) >>>
      0,
  );
  const landmark = b.height >= LANDMARK_HEIGHT;
  const top = b.tiers[b.tiers.length - 1];
  const topMin = top ? Math.min(top.width, top.depth) : 0;
  const arch = archetypeFor(b);

  // Fixed draw order — every roll is drawn for every building, so one
  // rule's gate never shifts another rule's outcome.
  const rBase = rand();
  const rTop = rand();
  const rTerrace = rand();
  const rTone = rand();
  const rLed = rand();
  const rLedHue = rand();
  const rCrown = rand();

  const base: RoofKind = rBase < 0.55 ? RoofKind.MEMBRANE : RoofKind.GRAVEL;
  let topKind: RoofKind = base;
  if (!landmark) {
    if (
      b.height >= HELIPAD_MIN_HEIGHT &&
      b.height < HELIPAD_MAX_HEIGHT &&
      topMin >= HELIPAD_MIN_ROOF &&
      rTop < HELIPAD_CHANCE
    ) {
      topKind = RoofKind.HELIPAD;
    } else if (b.height < 90 && rTop > 0.94) {
      topKind = RoofKind.GARDEN;
    } else if (
      b.height < 70 &&
      topMin >= 24 &&
      arch !== FacadeArchetype.GLASS &&
      rTop > 0.5 &&
      rTop <= 0.94
    ) {
      topKind = RoofKind.SKYLIGHTS;
    }
  }
  // Setback terraces: the odd one is planted, the rest match the base deck.
  const terrace: RoofKind = rTerrace < 0.3 ? RoofKind.GARDEN : base;
  const tierKinds = b.tiers.map((_, i) =>
    i === b.tiers.length - 1 ? topKind : terrace,
  );

  let led: THREE.Color | null = null;
  if (landmark || (b.height >= LED_MIN_HEIGHT && rLed < LED_CHANCE)) {
    const hue = landmark ? LED_HUES[LED_LANDMARK] : pick(LED_HUES, rLedHue);
    led = hue.clone().multiplyScalar(emissiveBoost(hue, LED_LUMINANCE));
  }

  let crown: RoofStyle["crown"] = null;
  if (landmark || b.height >= CROWN_MIN_HEIGHT) {
    // Most crowns are white light; one in four takes a colour.
    const tint = landmark
      ? CROWN_TINTS[0]
      : rCrown < 0.45
        ? CROWN_TINTS[0]
        : rCrown < 0.7
          ? CROWN_TINTS[1]
          : pick(CROWN_TINTS.slice(2), (rCrown - 0.7) / 0.3);
    crown = {
      color: tint.clone().multiplyScalar(CROWN_GAIN),
      depth: Math.min(crownDepth(b.height), top?.height ?? 0),
    };
  }

  return { tierKinds, tone: rTone, led, crown };
}
