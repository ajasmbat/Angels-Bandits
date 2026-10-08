// VO3 "Roofs & crowns" seam (archetypeFor / signageFor idiom). The city is
// one InstancedMesh painted in the shader, so a roof's look is decided HERE,
// in pure deterministic TypeScript, and delivered to the GPU as per-instance
// attributes (city.ts) — the shader only paints what this module chose.
// Everything is seeded from the building's own position and dimensions via
// the shared mulberry32 (never Math.random, never a torus image), so every
// client dresses identical roofs and nothing changes when a building wraps.
//
// Three decisions per building:
//  - a roof KIND per tier (membrane / gravel / garden / helipad — R2 retired
//    the lit skylight grid, which from the air read as one more window grid),
//  - an LED edge-outline colour on a seeded subset of tall towers,
//  - a crown floodlight wash on the top floors of the tallest.
// The palettes (albedo and emissive) live here too, so the shader emitters
// in window-pattern.ts and the ladder test read ONE set of numbers.

import type { Building } from "@angels-bandits/common/city";
import {
  HELIPAD_CHANCE,
  HELIPAD_MAX_HEIGHT,
  HELIPAD_MIN_HEIGHT,
  HELIPAD_MIN_ROOF,
  PARAPET_INSET,
  hasHelipad,
  helipadRadius,
  roofStyleStream,
} from "@angels-bandits/common/city/roof-structures";
import {
  EMISSIVE_SIGN,
  LANDMARK_HEIGHT,
} from "@angels-bandits/common/constants";
import * as THREE from "three";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import { emissiveBoost } from "./emissive";

/** Roof paint per tier. A const object + union — the repo has no TS enums.
 * 2 was VO3's SKYLIGHTS, retired by R2; the others keep their numbers (the
 * shader compares against them). GARDEN is also R2's green roof. */
export const RoofKind = {
  MEMBRANE: 0,
  GRAVEL: 1,
  GARDEN: 3,
  HELIPAD: 4,
} as const;
export type RoofKind = (typeof RoofKind)[keyof typeof RoofKind];

// The parapet inset and the helipad rule live in the shared R2 seam
// (common/src/city/roof-structures.ts), which keeps structures off the pads;
// re-exported here, their long-standing import site.
export {
  HELIPAD_CHANCE,
  HELIPAD_MAX_HEIGHT,
  HELIPAD_MIN_HEIGHT,
  HELIPAD_MIN_ROOF,
  PARAPET_INSET,
  helipadRadius,
};

/** Towers at least this tall may carry an LED edge outline… */
export const LED_MIN_HEIGHT = 100;
/** …with this probability (landmarks always do — they are the orientation). */
export const LED_CHANCE = 0.4;
/** Towers at least this tall get the uplit crown (and every landmark). */
export const CROWN_MIN_HEIGHT = 150;
// --- Palettes (linear — GLSL space) -------------------------------------

/** Roof albedos. Up-facing roofs catch the whole hemisphere sky plus ~40%
 * of the moon key, so these mid tones read without ever approaching the
 * bloom threshold (client/test/facade-palette.test.ts bounds them). */
export const ROOF_ALBEDO = {
  membrane: new THREE.Color(0.3, 0.31, 0.34), // light single-ply, cool grey
  gravel: new THREE.Color(0.24, 0.23, 0.2), // ballast, warm grey
  coping: new THREE.Color(0.35, 0.34, 0.33), // pavers inside the parapet
  deck: new THREE.Color(0.08, 0.09, 0.1), // helipad deck
  padWhite: new THREE.Color(0.46, 0.46, 0.44), // the H
  padYellow: new THREE.Color(0.46, 0.34, 0.05), // touchdown circle
  bed: new THREE.Color(0.035, 0.08, 0.03), // planted beds
  path: new THREE.Color(0.2, 0.18, 0.15), // garden paths
} as const;

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
  // stream would correlate "has a helipad" with "has a water tower". The
  // stream is defined in common, which re-rolls rTop for hasHelipad().
  const rand = roofStyleStream(b);
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
    if (hasHelipad(b)) {
      topKind = RoofKind.HELIPAD;
    } else if (b.height < 90 && rTop > 0.94) {
      topKind = RoofKind.GARDEN;
    } else if (
      b.height < 70 &&
      topMin >= 24 &&
      arch !== FacadeArchetype.GLASS &&
      rTop > 0.5 &&
      rTop <= 0.64
    ) {
      // R2: part of what VO3 glazed with skylights is a green roof now; the
      // rest stays plain membrane or gravel deck for the roof dressing.
      topKind = RoofKind.GARDEN;
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
