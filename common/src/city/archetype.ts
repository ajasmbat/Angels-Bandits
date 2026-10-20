// The facade archetype of a building (ANGE-XY8LH8), moved here from the
// client's archetypes.ts by DS1 so the structural frame (./structure.ts) and
// the host's debris physics can read a building's material: GLASS curtain
// wall, punched-window MASONRY or strip-window OFFICE concrete. A pure
// function of the building's (stable) dimensions — no Math.random, no
// THREE — so every reader classifies identically.
//
// L3 Stormlit (Manhattan): the reference city is PREWAR — brick and stone
// towers with punched windows, setbacks and cornices, with glass curtain
// walls a minority. So MASONRY is now the default for every height; GLASS
// keeps the supertalls and the slim shafts, and OFFICE a seeded share of the
// mid-rises and towers. Landmarks follow their LANDMARK_PROFILES style.

import { LANDMARK_HEIGHT } from "../constants";
import type { Building } from "./index";
import { landmarkStyleAt } from "./landmarks";

export const FacadeArchetype = {
  /** Curtain-wall: supertalls, slim shafts and the glass landmark. */
  GLASS: 0,
  /** Punched windows, deep insets, warm brick and stone: the prewar
   * default — and the Art Deco landmarks. */
  MASONRY: 1,
  /** Horizontal strip windows, mixed color: a seeded share of the rest. */
  OFFICE: 2,
} as const;
export type FacadeArchetype =
  (typeof FacadeArchetype)[keyof typeof FacadeArchetype];

/** GLASS when taller than this, whatever the footprint. T1: 150 → 250 —
 * the supertalls start there now; the ring's 100–265 m towers stay brick,
 * stone and office (the prewar skyline, and its laundry, flags, banners). */
export const GLASS_MIN_HEIGHT = 250;
/** ... or when height/longest-side reads as a slim shaft. T1: 1.8 → 3 —
 * the ring's towers stand two or three footprints tall now; at 1.8 most of
 * them read as shafts (57 % of the city glass, was 17 %). */
const GLASS_MIN_ASPECT = 3;
/** OFFICE for a seeded share of the walk-ups (low commercial blocks)… */
const OFFICE_SHARE_LOW = 0.65;
/** …a smaller share of the 40 m+ mid-rises and towers, which the reference
 * shows overwhelmingly as brick and stone… */
const OFFICE_SHARE_TALL = 0.4;
const OFFICE_TALL_FROM = 40;
/** Low and wide stays brick whatever the roll (the XY8LH8 rule, and the
 * prewar walk-up blocks of the reference): under this height… */
const MASONRY_MAX_HEIGHT = 70;
/** …with a longest side at least this wide. */
const MASONRY_MIN_SIDE = 80;
/** …and only when every tier is wide enough for more than two OFFICE bays
 * (the widest jittered OFFICE pitch is 5.2 × 1.16 ≈ 6.03 m). */
const OFFICE_MIN_TIER = 12.1;

/** An integer hash of the building's dimensions in [0, 1) — bit-identical in
 * every JS engine (Math.sin is not), seam-safe (never the translation). */
function dimsRoll(b: Building): number {
  let h = Math.imul(Math.round(b.width) + 1, 0x9e3779b1);
  h = Math.imul(h ^ (Math.round(b.depth) + 7), 0x85ebca6b);
  h = Math.imul(h ^ (Math.round(b.height) + 13), 0xc2b2ae35);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Classify one building. Deterministic and total: landmarks by their style
 * (the glass one GLASS, the Art Deco ones MASONRY stone), supertalls and slim
 * shafts GLASS, a seeded share of the rest OFFICE (fewer of the towers),
 * and everything else MASONRY.
 */
export function archetypeFor(b: Building): FacadeArchetype {
  const side = Math.max(b.width, b.depth);
  if (b.height >= LANDMARK_HEIGHT) {
    const style = landmarkStyleAt(b.x, b.z);
    return style === null || style === "glass"
      ? FacadeArchetype.GLASS
      : FacadeArchetype.MASONRY;
  }
  if (b.height > GLASS_MIN_HEIGHT || b.height / side >= GLASS_MIN_ASPECT) {
    return FacadeArchetype.GLASS;
  }
  const lowWide = b.height < MASONRY_MAX_HEIGHT && side >= MASONRY_MIN_SIDE;
  if (
    !lowWide &&
    dimsRoll(b) <
      (b.height >= OFFICE_TALL_FROM ? OFFICE_SHARE_TALL : OFFICE_SHARE_LOW) &&
    b.tiers.every((t) => Math.min(t.width, t.depth) >= OFFICE_MIN_TIER)
  ) {
    return FacadeArchetype.OFFICE;
  }
  return FacadeArchetype.MASONRY;
}
