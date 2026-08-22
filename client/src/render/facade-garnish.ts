// Facade garnish (ANGE-XY8LH8, client-only dressing): parapet caps along
// every tier's roof edges (kills the sharp-box-top look) and one entrance
// canopy per building on its street-facing base side. Layout is the pure
// seam facadeGarnishFor() — deterministic per building via the shared
// mulberry32 (roofClutterFor idiom, no Math.random), so every client
// dresses identical facades. Street geometry comes from the S1 contract
// (nearestStreet + the S2 sidewalk-clearance formula), never re-derived.
// Garnish is visual-only with no collision — the plan's sanctioned
// exception, same as roof clutter.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import { ROADWAY_HALF, nearestStreet } from "@angels-bandits/common/city/street";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";

/** Parapet lip thickness across the edge, meters. */
const LIP_THICKNESS = 1.1;
/** Parapet overhang past each facade end, meters. */
const LIP_OVERHANG = 0.55;
/** Parapet lip height, meters (renderer scale — part of the layout contract). */
export const PARAPET_HEIGHT = 1.5;

/** Canopy footprint along the facade, meters. */
const CANOPY_WIDTH = 9;
/** How far the awning would like to protrude toward the curb, meters. */
const CANOPY_MAX_DEPTH = 3.2;
/** Underside height of the awning, meters (over a door, under the shops). */
export const CANOPY_Y = 3.6;
/** Awning slab thickness, meters. */
export const CANOPY_THICKNESS = 0.6;
/** Faces with less sidewalk than this get no canopy (S2 clearance rule). */
const MIN_CLEARANCE = 1.2;

/** One thin cap along a tier roof edge, axis-aligned like everything else. */
export interface ParapetLip {
  x: number;
  z: number;
  /** Roof height the lip sits on (== the tier's top). */
  y: number;
  width: number;
  depth: number;
}

/** One entrance awning, protruding from the tier-1 facade over the sidewalk. */
export interface Canopy {
  x: number;
  z: number;
  /** Underside height of the awning slab. */
  y: number;
  sizeX: number;
  sizeZ: number;
}

export interface FacadeGarnish {
  parapets: ParapetLip[];
  canopy: Canopy | null;
}

/**
 * Deterministic garnish for one building: four parapet lips per tier, and —
 * when the sidewalk is deep enough — one canopy on the facade that faces the
 * building's nearest street (entrance offset rolled from a PRNG seeded by
 * the building itself).
 */
export function facadeGarnishFor(b: Building): FacadeGarnish {
  const parapets: ParapetLip[] = [];
  let top = 0;
  for (const tier of b.tiers) {
    top += tier.height;
    const spanX = tier.width + LIP_OVERHANG * 2;
    const spanZ = tier.depth + LIP_OVERHANG * 2;
    parapets.push(
      { x: b.x, z: b.z - tier.depth / 2, y: top, width: spanX, depth: LIP_THICKNESS },
      { x: b.x, z: b.z + tier.depth / 2, y: top, width: spanX, depth: LIP_THICKNESS },
      { x: b.x - tier.width / 2, z: b.z, y: top, width: LIP_THICKNESS, depth: spanZ },
      { x: b.x + tier.width / 2, z: b.z, y: top, width: LIP_THICKNESS, depth: spanZ },
    );
  }

  return { parapets, canopy: canopyFor(b) };
}

function canopyFor(b: Building): Canopy | null {
  const street = nearestStreet({ x: b.x, y: 0, z: b.z });
  // The facade facing that street: for a north–south street (axis "z", a
  // line of constant x) it is an x facade; dir points building → street.
  const onX = street.axis === "z";
  const facadeHalf = onX ? b.width / 2 : b.depth / 2;
  const faceLength = onX ? b.depth : b.width;
  const dir = -street.side;
  // S2 sidewalk depth: facade to curb along the protrusion axis.
  const clearance = (BLOCK_PITCH - facadeHalf * 2) / 2 - ROADWAY_HALF;
  if (clearance < MIN_CLEARANCE) return null;
  const depth = Math.min(CANOPY_MAX_DEPTH, clearance - 0.3);

  // Entrance position along the facade — deterministic per building, kept
  // clear of the corners (same hash recipe as roofClutterFor).
  const rand = mulberry32(
    (Math.imul(b.x, 73856093) ^
      Math.imul(b.z, 19349663) ^
      Math.imul(b.height, 83492791) ^
      0x5bd1e995) >>>
      0,
  );
  const offset = (rand() * 2 - 1) * Math.max(0, faceLength / 2 - CANOPY_WIDTH);

  const plane = (onX ? b.x : b.z) + dir * facadeHalf;
  const center = plane + (dir * depth) / 2;
  return {
    x: onX ? center : b.x + offset,
    z: onX ? b.z + offset : center,
    y: CANOPY_Y,
    sizeX: onX ? depth : CANOPY_WIDTH,
    sizeZ: onX ? CANOPY_WIDTH : depth,
  };
}
