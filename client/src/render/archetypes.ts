// Facade archetype seam (ANGE-XY8LH8, client-only dressing): every building
// classifies into one of three looks — glass curtain-wall, punched-window
// masonry, or strip-window concrete office — as a pure function of its
// (stable) dimensions, the roofClutterFor idiom: no Math.random, no THREE,
// so every client paints identical facades. The shader branches on this id
// (per-instance attribute) and city.ts picks the facade tint from it.
//
// L3 Stormlit (Manhattan): the reference city is PREWAR — brick and stone
// towers with punched windows, setbacks and cornices, with glass curtain
// walls a minority. So MASONRY is now the default for every height; GLASS
// keeps the supertalls and the slim shafts, and OFFICE a seeded share of the
// mid-rises and towers. Landmarks follow their LANDMARK_PROFILES style.

import { type Building, landmarkStyleAt } from "@angels-bandits/common/city";
import { LANDMARK_HEIGHT } from "@angels-bandits/common/constants";

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

/** GLASS when taller than this, whatever the footprint. */
const GLASS_MIN_HEIGHT = 150;
/** ... or when height/longest-side reads as a slim shaft. */
const GLASS_MIN_ASPECT = 1.8;
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

// --- L11 New York building types -------------------------------------------
// Each archetype splits into the NYC types the reference skyline is made of.
// The archetype still decides occupancy, glass reflection and every system
// that only knows GLASS / MASONRY / OFFICE; the STYLE decides the facade's
// geometry — window shape, recess, muntins, trim and finish. The base style
// of each archetype keeps the archetype's own id, so old callers that pass
// an archetype id still mean "its base style".

export const FacadeStyle = {
  /** Modern glass curtain wall: mullion grid, reflective glass. */
  MODERN_GLASS: 0,
  /** Prewar brick and limestone: punched 2-over-2 windows, rusticated
   * base, stone sills and lintels — also the walk-up tenements. */
  PREWAR: 1,
  /** Mid-century office: ribbon windows over spandrel panels. */
  MIDCENTURY_OFFICE: 2,
  /** Art Deco: vertical window strips between proud piers, recessed dark
   * spandrels with chevrons. */
  DECO: 3,
  /** Cast-iron loft (SoHo): tall round-headed windows between columns. */
  CAST_IRON: 4,
  /** Brownstone row house: 6-over-6 windows under heavy lintels, a stoop. */
  BROWNSTONE: 5,
  /** Mid-century glass and steel box: glass ribbons over coloured spandrels. */
  MIDCENTURY_GLASS: 6,
} as const;
export type FacadeStyle = (typeof FacadeStyle)[keyof typeof FacadeStyle];

/** Each style's archetype and its index within it. The shader decodes the
 * index from the fraction of `aArchetype.x` (packArchetype), so it must stay
 * at most 3: 3/8 < 0.5 keeps every ±0.5 archetype threshold in the shader
 * exactly where it was. */
export const STYLE_ARCH: Readonly<
  Record<FacadeStyle, { arch: FacadeArchetype; sub: 0 | 1 | 2 | 3 }>
> = {
  [FacadeStyle.MODERN_GLASS]: { arch: FacadeArchetype.GLASS, sub: 0 },
  [FacadeStyle.MIDCENTURY_GLASS]: { arch: FacadeArchetype.GLASS, sub: 1 },
  [FacadeStyle.PREWAR]: { arch: FacadeArchetype.MASONRY, sub: 0 },
  [FacadeStyle.DECO]: { arch: FacadeArchetype.MASONRY, sub: 1 },
  [FacadeStyle.CAST_IRON]: { arch: FacadeArchetype.MASONRY, sub: 2 },
  [FacadeStyle.BROWNSTONE]: { arch: FacadeArchetype.MASONRY, sub: 3 },
  [FacadeStyle.MIDCENTURY_OFFICE]: { arch: FacadeArchetype.OFFICE, sub: 0 },
};

/** The `aArchetype.x` value a style is drawn with: archetype + sub / 8. */
export const packArchetype = (style: FacadeStyle): number =>
  STYLE_ARCH[style].arch + STYLE_ARCH[style].sub / 8;

/** Masonry under this height is a row of walk-ups: brownstones or tenements. */
export const ROW_MAX_HEIGHT = 32;
/** Share of the low-rise masonry rows that are brownstones (with a stoop);
 * the rest are prewar brick walk-up tenements with shops. */
const BROWNSTONE_SHARE = 0.5;
/** Mid-rise masonry up to this height may be a cast-iron loft… */
const LOFT_MAX_HEIGHT = 75;
const CAST_IRON_SHARE = 0.4;
/** …and masonry towers from it may be Art Deco. */
const DECO_SHARE = 0.4;
/** Slim glass shafts under GLASS_MIN_HEIGHT may be a mid-century box. */
const MIDCENTURY_GLASS_SHARE = 0.5;

/** A second integer hash of the dimensions, independent of dimsRoll (its
 * own constants), so the style never correlates with the archetype roll. */
function styleRoll(b: Building): number {
  let h = Math.imul(Math.round(b.depth) + 3, 0x27d4eb2f);
  h = Math.imul(h ^ (Math.round(b.width) + 11), 0x165667b1);
  h = Math.imul(h ^ (Math.round(b.height) + 5), 0x9e3779b1);
  h ^= h >>> 13;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The building's New York type. Pure and total, a refinement of
 * archetypeFor (never a different archetype): Art Deco landmarks are DECO;
 * low masonry rows are brownstones or walk-ups; mid-rise masonry is partly
 * cast-iron lofts; masonry towers partly Art Deco; slim glass shafts partly
 * mid-century boxes. Heights are absolute metres — a brownstone has 4–6
 * floors whatever the skyline around it does.
 */
export function facadeStyleFor(b: Building): FacadeStyle {
  const arch = archetypeFor(b);
  if (arch === FacadeArchetype.OFFICE) return FacadeStyle.MIDCENTURY_OFFICE;
  const r = styleRoll(b);
  if (arch === FacadeArchetype.GLASS) {
    return b.height < GLASS_MIN_HEIGHT &&
      b.height < LANDMARK_HEIGHT &&
      r < MIDCENTURY_GLASS_SHARE
      ? FacadeStyle.MIDCENTURY_GLASS
      : FacadeStyle.MODERN_GLASS;
  }
  if (b.height >= LANDMARK_HEIGHT) return FacadeStyle.DECO;
  if (b.height < ROW_MAX_HEIGHT) {
    return r < BROWNSTONE_SHARE ? FacadeStyle.BROWNSTONE : FacadeStyle.PREWAR;
  }
  if (b.height < LOFT_MAX_HEIGHT) {
    return r < CAST_IRON_SHARE ? FacadeStyle.CAST_IRON : FacadeStyle.PREWAR;
  }
  return r < DECO_SHARE ? FacadeStyle.DECO : FacadeStyle.PREWAR;
}
