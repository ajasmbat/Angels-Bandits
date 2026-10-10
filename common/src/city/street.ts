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
  WORLD_SIZE,
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

/** Lamps per owned street segment, at these fractions along it. */
const LAMP_FRACTIONS = [0.125, 0.5, 0.875] as const;
/** The negative side is staggered by this fraction (5/16, binary-exact) so
 * the two curbside rows never mirror each other across the street. Its
 * stations land at 37.5 / 87.5 / 162.5 m — the same 50/75/75 rhythm, kept
 * clear of block corners so no lamp falls into a CROSSING street's roadway
 * (a naive half-step stagger puts one station 12.5 m from the corner). */
const LAMP_STAGGER = 0.3125;

/**
 * Lamp stations in meters along a street segment, per side of the street:
 * PLUS is the furniture line on the centerline's positive side, MINUS the
 * negative one. Part of the street contract (not the lamp renderer) because
 * more than lamps anchor to them — the ground shader's wet-look reflections
 * sit under the lamps, and N1's street trees stand between them.
 */
export const LAMP_STATIONS_PLUS: readonly number[] = LAMP_FRACTIONS.map(
  (f) => f * BLOCK_PITCH,
);
export const LAMP_STATIONS_MINUS: readonly number[] = LAMP_FRACTIONS.map(
  (f) => ((f + LAMP_STAGGER) % 1) * BLOCK_PITCH,
);

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
   * well as a nearestStreet() result — `side` is irrelevant to the lattice.
   * B2's hole edges (holes.ts) run it along a hole's axis to find the
   * streets either side of the hole. */
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

// --- Street furniture positions (moved here from the client by D9) ----------
// Lamps and signal masts can be snapped by a blast (city/props.ts), so the
// server places them exactly as every client draws them. The renderers
// (client/src/render/streetlights.ts, signals.ts) re-export these.

/** Canonical ground position of one lamp (on a furniture line, y = 0). */
export interface StreetlampPosition {
  x: number;
  z: number;
}

/**
 * Every street lamp in canonical [0, WORLD_SIZE) coords, deterministic from
 * the block grid. Each block contributes its west line (x = bx·PITCH) and its
 * south line (z = bz·PITCH), placing lamps on BOTH of the line's furniture
 * lines (contract: FURNITURE_LINE m off the centerline, 1 m behind the curb);
 * with the torus wrap that tiles all street lines exactly once, corners
 * excluded (fractions never land on 0 or 1).
 */
export function streetlampPositions(): StreetlampPosition[] {
  const grid = WORLD_SIZE / BLOCK_PITCH;
  const canon = (v: number) => canonicalize({ x: v, y: 0, z: 0 }).x;
  const lamps: StreetlampPosition[] = [];
  for (let bx = 0; bx < grid; bx++) {
    for (let bz = 0; bz < grid; bz++) {
      const x0 = bx * BLOCK_PITCH;
      const z0 = bz * BLOCK_PITCH;
      for (let i = 0; i < LAMP_STATIONS_PLUS.length; i++) {
        const along = LAMP_STATIONS_PLUS[i] as number;
        const staggered = LAMP_STATIONS_MINUS[i] as number;
        // West line: a lamp on each furniture line, negative side staggered.
        lamps.push({ x: x0 + FURNITURE_LINE, z: z0 + along });
        lamps.push({ x: canon(x0 - FURNITURE_LINE), z: z0 + staggered });
        // South line: same cross-section, axes swapped.
        lamps.push({ x: x0 + along, z: z0 + FURNITURE_LINE });
        lamps.push({ x: x0 + staggered, z: canon(z0 - FURNITURE_LINE) });
      }
    }
  }
  return lamps;
}

/** How far back from the vehicle mast a crosswalk head stands, meters. */
const XWALK_SETBACK = 6;

/** One signal head standing on the street furniture line. */
export interface SignalMast {
  /** Canonical ground position. */
  x: number;
  z: number;
  /** Facing, radians — the head looks toward the traffic it governs. */
  yaw: number;
  /** Vehicle head or crosswalk head. */
  kind: "vehicle" | "crosswalk";
  /** True when this head follows the NS half of the cycle. */
  ns: boolean;
}

/**
 * The masts of block (bx, bz)'s intersection — its SOUTH-WEST lattice corner.
 * Every block owns exactly one corner, so the (WORLD_SIZE / BLOCK_PITCH)² blocks cover all
 * (WORLD_SIZE / BLOCK_PITCH)² intersections once, with the torus wrap for free.
 *
 * Four vehicle masts, one per corner, alternating which axis they govern (a
 * diagonally opposite pair per axis — which is also why no two masts are ever
 * co-located; a second mast on the same corner would z-fight the first, since
 * a square pole rotated 90° occupies the identical volume).
 *
 * Eight crosswalk masts, set back XWALK_SETBACK along the axis they face, so
 * they clear both the vehicle mast and the lamp row.
 *
 * Every offset here is FURNITURE_LINE or FURNITURE_LINE + a setback, so all of
 * it sits on street furniture ground by contract: clear of the roadway on both
 * axes, and clear of the pedestrian band (which starts further back).
 */
export function signalMastsForBlock(bx: number, bz: number): SignalMast[] {
  const x0 = bx * BLOCK_PITCH;
  const z0 = bz * BLOCK_PITCH;
  const out: SignalMast[] = [];
  const push = (
    dx: number,
    dz: number,
    yaw: number,
    kind: "vehicle" | "crosswalk",
    ns: boolean,
  ) => {
    const c = canonicalize({ x: x0 + dx, y: 0, z: z0 + dz });
    out.push({ x: c.x, z: c.z, yaw, kind, ns });
  };
  const F = FURNITURE_LINE;
  const S = F + XWALK_SETBACK;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Vehicle head: corners (+,+) and (−,−) govern NS, the other two EW.
      // Forward is −Z at yaw 0, so a head facing +z looks back down the
      // street at oncoming traffic.
      const governsNs = sx === sz;
      const yaw = governsNs
        ? sz > 0
          ? Math.PI
          : 0
        : sx > 0
          ? -Math.PI / 2
          : Math.PI / 2;
      push(sx * F, sz * F, yaw, "vehicle", governsNs);
      // Crosswalk heads. The one set back along z faces across the NS street
      // (a walk along x → the EW half of the cycle); the axis-swapped one
      // faces across the EW street (a walk along z → the NS half).
      push(
        sx * F,
        sz * S,
        sx > 0 ? -Math.PI / 2 : Math.PI / 2,
        "crosswalk",
        false,
      );
      push(sx * S, sz * F, sz > 0 ? Math.PI : 0, "crosswalk", true);
    }
  }
  return out;
}

/** Every intersection's masts, for tests that sweep the whole city. */
export function allSignalMasts(): SignalMast[] {
  const out: SignalMast[] = [];
  for (let bx = 0; bx < (WORLD_SIZE / BLOCK_PITCH); bx++) {
    for (let bz = 0; bz < (WORLD_SIZE / BLOCK_PITCH); bz++)
      out.push(...signalMastsForBlock(bx, bz));
  }
  return out;
}
