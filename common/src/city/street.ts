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

/**
 * The next lattice intersection ahead of `p` along `street`'s travel axis,
 * in direction `dir` (+1 = increasing coordinate). Returned on the ground
 * plane (y = 0) — callers add their own altitude.
 *
 * "Ahead" is strict: sitting exactly on an intersection returns the NEXT one,
 * so a patrol that reaches its waypoint always gets a fresh block to fly.
 * Wrap-correct like the rest of this file — BLOCK_PITCH divides WORLD_SIZE,
 * so stepping past the last line lands on line 0 rather than off the map.
 */
export function nextIntersection(
  p: Vec3,
  /** Only the line matters here, so a hand-built {axis, centerline} works as
   * well as a nearestStreet() result — `side` is irrelevant to the lattice. */
  street: Pick<NearestStreet, "axis" | "centerline">,
  dir: 1 | -1,
): Vec3 {
  const c = canonicalize(p);
  const along = street.axis === "x" ? c.x : c.z;
  const steps =
    dir === 1
      ? Math.floor(along / BLOCK_PITCH) + 1
      : Math.ceil(along / BLOCK_PITCH) - 1;
  const next = steps * BLOCK_PITCH;
  return canonicalize(
    street.axis === "x"
      ? { x: next, y: 0, z: street.centerline }
      : { x: street.centerline, y: 0, z: next },
  );
}
