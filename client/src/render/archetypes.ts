// Facade archetype seam (ANGE-XY8LH8, client-only dressing): every building
// classifies into one of three looks — glass curtain-wall, punched-window
// masonry, or strip-window concrete office — as a pure function of its
// (stable) dimensions, the roofClutterFor idiom: no Math.random, no THREE,
// so every client paints identical facades. The shader branches on this id
// (per-instance attribute) and city.ts picks the facade tint from it.

import type { Building } from "@angels-bandits/common/city";
import { LANDMARK_HEIGHT } from "@angels-bandits/common/constants";

export const FacadeArchetype = {
  /** Curtain-wall: tall or slim towers + ALL landmarks. Cool, tight floors. */
  GLASS: 0,
  /** Punched windows, deep insets, warm: low and wide mid-rises. */
  MASONRY: 1,
  /** Horizontal strip windows, mixed color: everything else. */
  OFFICE: 2,
} as const;
export type FacadeArchetype =
  (typeof FacadeArchetype)[keyof typeof FacadeArchetype];

/** GLASS when taller than this, whatever the footprint. */
const GLASS_MIN_HEIGHT = 120;
/** ... or when height/longest-side reads as a slim shaft. */
const GLASS_MIN_ASPECT = 1.4;
/** MASONRY under this height (and wide) — low brick/stone mid-rises. */
const MASONRY_MAX_HEIGHT = 70;
/** MASONRY needs a footprint at least this wide on its longest side —
 * "low and wide" is relative to the lot scale, so this tracks it. C1's BSP
 * lots have a median longest side of ~78 m (they used to be 100–170 m
 * free-standing blocks); at the old 120 m threshold masonry all but vanished
 * and four buildings in five came out OFFICE. */
const MASONRY_MIN_SIDE = 80;

/**
 * Classify one building. Deterministic and total: landmarks and supertalls
 * are always GLASS, low-and-wide is MASONRY, the rest is OFFICE.
 */
export function archetypeFor(b: Building): FacadeArchetype {
  const side = Math.max(b.width, b.depth);
  if (
    b.height >= LANDMARK_HEIGHT ||
    b.height > GLASS_MIN_HEIGHT ||
    b.height / side >= GLASS_MIN_ASPECT
  ) {
    return FacadeArchetype.GLASS;
  }
  if (b.height < MASONRY_MAX_HEIGHT && side >= MASONRY_MIN_SIDE) {
    return FacadeArchetype.MASONRY;
  }
  return FacadeArchetype.OFFICE;
}
