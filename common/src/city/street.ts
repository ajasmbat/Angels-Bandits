// The street cross-section contract — the ONE source of street geometry.
// Streets are STREET_WIDTH-wide bands centered on every block-boundary line
// (multiples of BLOCK_PITCH, both axes). Lamps, traffic, and the painted
// ground all import THESE constants/helpers; no downstream file may hardcode
// a curb/lane/furniture offset (same philosophy as the wrapDelta-only rule).
//
// All helpers are wrap-correct by construction: positions are canonicalized
// via common/src/world, and BLOCK_PITCH divides WORLD_SIZE evenly, so
// mod-BLOCK_PITCH arithmetic tiles across the torus seam (street line 0's
// negative-side curb sits at WORLD_SIZE − CURB_LINE).

import {
  BLOCK_PITCH,
  CROSSWALK_DEPTH,
  FURNITURE_MARGIN,
  LANE_CENTER_OFFSET,
  LOT_LINE_MARGIN,
  STREET_WIDTH,
} from "../constants";
import { type Vec3, canonicalize } from "../world";

export { CROSSWALK_DEPTH };

/** Half the roadway width: curb-to-centerline distance, meters. */
export const ROADWAY_HALF = STREET_WIDTH / 2;
/** The curb: where roadway ends and sidewalk begins, meters off the centerline. */
export const CURB_LINE = ROADWAY_HALF;
/** The street-furniture line (lamp posts), just behind the curb. */
export const FURNITURE_LINE = CURB_LINE + FURNITURE_MARGIN;
/**
 * The lot line: where private buildable land begins, meters off the street
 * centerline. Buildings build out to THIS (C1's streetwall), so it sits
 * behind FURNITURE_LINE — lamp posts stand on the sidewalk in front of the
 * facade, not inside it. Facing buildings across a street are therefore
 * 2 × LOT_LINE apart: STREET_WIDTH of roadway plus a sidewalk each side.
 */
export const LOT_LINE = FURNITURE_LINE + LOT_LINE_MARGIN;
/** Sidewalk depth from curb to lot line, meters. */
export const SIDEWALK_DEPTH = LOT_LINE - CURB_LINE;
/** Lane centerlines, meters off the street centerline — right-hand traffic. */
export const LANE_CENTERS = [-LANE_CENTER_OFFSET, LANE_CENTER_OFFSET] as const;
/** Half-side of the square where two streets cross, centered on block corners. */
export const INTERSECTION_HALF = ROADWAY_HALF;

/**
 * Signed shortest offset from `v` to its nearest street centerline (a
 * BLOCK_PITCH multiple) along one axis, in (−BLOCK_PITCH/2, BLOCK_PITCH/2].
 */
const lineDelta = (v: number): number =>
  v - Math.round(v / BLOCK_PITCH) * BLOCK_PITCH;

/**
 * Distance from a facade plane (one coordinate, either axis) to the nearest
 * street centerline, meters. Wrap-correct: BLOCK_PITCH divides WORLD_SIZE.
 */
export function offCenterline(plane: number): number {
  return Math.abs(lineDelta(canonicalize({ x: plane, y: 0, z: 0 }).x));
}

/** True when a facade plane stands exactly on the lot line. */
const onLotLine = (plane: number) =>
  // Half a meter of slack absorbs the half-meter lot centers odd-width lots
  // produce; lot lines themselves land on whole meters.
  Math.abs(offCenterline(plane) - LOT_LINE) < 0.5;

/** Sidewalk depth in front of each of a footprint's four facades, meters. */
export interface FacadeClearances {
  /** Low-x facade (the one at x − width/2), and so on. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * How much open ground stands in front of each facade of a footprint.
 *
 * Anything mounted on a facade — signage, awnings, the neon that pools on the
 * pavement — must size and offset itself from THIS. It may NOT derive a
 * sidewalk from the block pitch: since C1 a block is a continuous streetwall
 * of lots, and a lot is not centered in its block, so "half the block minus
 * the roadway" measures ground that belongs to the neighbour.
 *
 * Two kinds of building, both handled here:
 *
 * - A **lot in a streetwall** has at least one facade standing on the lot
 *   line. Those facades are street frontage with SIDEWALK_DEPTH of pavement;
 *   the rest are party walls with the neighbouring lot flush against them and
 *   no clearance at all.
 * - A **free-standing building** (a landmark keeping its whole block, or a
 *   hand-placed tower) touches no lot line, and every facade looks out over
 *   open ground all the way to the curb.
 */
export function facadeClearances(
  x: number,
  z: number,
  width: number,
  depth: number,
): FacadeClearances {
  const planes = {
    x0: x - width / 2,
    x1: x + width / 2,
    z0: z - depth / 2,
    z1: z + depth / 2,
  };
  const isLot =
    onLotLine(planes.x0) ||
    onLotLine(planes.x1) ||
    onLotLine(planes.z0) ||
    onLotLine(planes.z1);
  const clearanceAt = (plane: number) => {
    if (onLotLine(plane)) return SIDEWALK_DEPTH;
    if (isLot) return 0; // party wall: the neighbour is flush against it
    return Math.max(0, offCenterline(plane) - CURB_LINE);
  };
  return {
    x0: clearanceAt(planes.x0),
    x1: clearanceAt(planes.x1),
    z0: clearanceAt(planes.z0),
    z1: clearanceAt(planes.z1),
  };
}

/** True if `p` (any coords; canonicalized) lies on a roadway — within the
 * street band of a centerline on either axis, curb included. */
export function isInRoadway(p: Vec3): boolean {
  const c = canonicalize(p);
  return (
    Math.abs(lineDelta(c.x)) <= ROADWAY_HALF ||
    Math.abs(lineDelta(c.z)) <= ROADWAY_HALF
  );
}

/** True if `p` lies in an intersection square — inside BOTH street bands. */
export function isInIntersection(p: Vec3): boolean {
  const c = canonicalize(p);
  return (
    Math.abs(lineDelta(c.x)) <= INTERSECTION_HALF &&
    Math.abs(lineDelta(c.z)) <= INTERSECTION_HALF
  );
}

/**
 * The street nearest to `p`. `axis` is the direction of TRAVEL (matching
 * TrafficLane: a north–south street on a line of constant x has axis "z"),
 * `centerline` is the line's canonical coordinate on the cross axis, and
 * `side` is which side of the centerline `p` lies on (+1 on the line itself).
 * Equidistant from both streets (an intersection diagonal) → the "z" street.
 */
export interface NearestStreet {
  axis: "x" | "z";
  centerline: number;
  side: -1 | 1;
}

export function nearestStreet(p: Vec3): NearestStreet {
  const c = canonicalize(p);
  const dx = lineDelta(c.x);
  const dz = lineDelta(c.z);
  const northSouth = Math.abs(dx) <= Math.abs(dz);
  const d = northSouth ? dx : dz;
  const coord = northSouth ? c.x : c.z;
  return {
    axis: northSouth ? "z" : "x",
    centerline: canonicalize({ x: coord - d, y: 0, z: 0 }).x,
    side: d >= 0 ? 1 : -1,
  };
}
