// L1 living streets — the shared pure seam under the micro tier (pedestrians,
// steam, signals, construction sparks). THREE-free by design: everything here
// is a pure function of (seed, block, index, server time), so the whole tier
// is testable in Node and identical on every client, late joiners included.
// Same pure-layout/renderer split as streetlights.ts and traffic.ts.
//
// THE LOAD-BEARING IDEA — the block sidewalk ring.
//
// isInRoadway(p) is true when |lineDelta(x)| <= ROADWAY_HALF OR
// |lineDelta(z)| <= ROADWAY_HALF, so a point is roadway-clear only when its
// offset from the nearest centerline exceeds ROADWAY_HALF on BOTH axes. For a
// block (bx, bz) and a lateral offset d, the closed square
//
//     x in [bx·PITCH + d, (bx+1)·PITCH − d],  z in [bz·PITCH + d, (bz+1)·PITCH − d]
//
// has every point exactly d from one centerline and AT LEAST d from the
// perpendicular one — the corners sit at (d, d). So for any d > CURB_LINE the
// entire ring is provably clear of the roadway, corners included: no stagger,
// no corner-exclusion window, no per-side bookkeeping. The CITY_GRID² rings
// tile every sidewalk exactly once across the torus wrap, and because a ring
// is a closed loop a walker never reaches an end — no U-turn, no teleport.

import { CITY_GRID, mulberry32 } from "@angels-bandits/common/city";
import {
  CURB_LINE,
  FURNITURE_LINE,
  LOT_LINE,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";

// --- The lateral-band contract -------------------------------------------
// Every offset below is DERIVED from the S1 street contract. No downstream
// file in this tier may write a literal curb/furniture/lot offset (the same
// rule signage and traffic follow).

/** Clearance kept off the furniture line so nobody walks through a lamp post. */
const FURNITURE_CLEAR = 0.9;
/** Clearance kept off the lot line so nobody clips a facade. */
const FACADE_CLEAR = 0.8;
/** Inner edge of the walkable band (16.9 m with the shipped contract). */
export const PED_BAND_MIN = FURNITURE_LINE + FURNITURE_CLEAR;
/** Outer edge of the walkable band (19.2 m with the shipped contract). */
export const PED_BAND_MAX = LOT_LINE - FACADE_CLEAR;
/**
 * Gutter grate line: just outside the curb, where a street vent actually
 * sits. Provably roadway-clear (> CURB_LINE) while still reading as part of
 * the gutter rather than the middle of the pavement.
 */
export const GUTTER_LINE = CURB_LINE + 0.55;
/** Half-width of a pedestrian body, meters — used by the clearance tests. */
export const PED_HALF_WIDTH = 0.23;

// --- Per-subsystem PRNG tags ---------------------------------------------
// Each subsystem draws from its own tagged stream so the streams can never
// correlate: adding a pedestrian draw must not move a steam vent.

export const TAG_PED = 1;
export const TAG_STEAM = 2;
export const TAG_SIGNAL = 3;
export const TAG_CONSTRUCTION = 4;

/**
 * The per-block PRNG stream for one subsystem, in the house style (the same
 * spatial-hash mixing signage and roof clutter use), tagged so subsystems
 * stay independent. Deterministic from (world seed, block, tag) alone — no
 * dependence on iteration order, so two clients agree wherever they stand.
 */
export function blockStream(
  seed: number,
  bx: number,
  bz: number,
  tag: number,
): () => number {
  return mulberry32(
    (seed ^
      Math.imul(bx + 1, 73856093) ^
      Math.imul(bz + 1, 19349663) ^
      Math.imul(tag, 0x9e3779b9)) >>>
      0,
  );
}

// --- The ring -------------------------------------------------------------

/** Perimeter of the sidewalk ring at lateral offset `d`, meters. */
export const ringPerimeter = (d: number): number => 4 * (BLOCK_PITCH - 2 * d);

/** A point on a sidewalk ring: canonical ground position + unit travel heading. */
export interface RingPoint {
  x: number;
  z: number;
  /** Unit direction of increasing `s` along the ring (one of ±1 on one axis). */
  dx: number;
  dz: number;
}

/**
 * The point `s` meters along block (bx, bz)'s sidewalk ring at lateral offset
 * `d`, written into `out` (caller-owned scratch — the hot loop allocates
 * nothing). `s` wraps modulo the perimeter, so s and s + perimeter coincide
 * and a walker loops forever. The result is canonicalized, so a ring on block
 * (0, 0) or (GRID−1, GRID−1) lands in [0, WORLD_SIZE) like everything else.
 */
export function ringPointInto(
  bx: number,
  bz: number,
  d: number,
  s: number,
  out: RingPoint,
): RingPoint {
  const side = BLOCK_PITCH - 2 * d;
  const x0 = bx * BLOCK_PITCH + d;
  const z0 = bz * BLOCK_PITCH + d;
  const x1 = x0 + side;
  const z1 = z0 + side;
  let t = s % (4 * side);
  if (t < 0) t += 4 * side;
  let x: number;
  let z: number;
  if (t < side) {
    x = x0 + t;
    z = z0;
    out.dx = 1;
    out.dz = 0;
  } else if (t < 2 * side) {
    x = x1;
    z = z0 + (t - side);
    out.dx = 0;
    out.dz = 1;
  } else if (t < 3 * side) {
    x = x1 - (t - 2 * side);
    z = z1;
    out.dx = -1;
    out.dz = 0;
  } else {
    x = x0;
    z = z1 - (t - 3 * side);
    out.dx = 0;
    out.dz = -1;
  }
  const c = canonicalize({ x, y: 0, z });
  out.x = c.x;
  out.z = c.z;
  return out;
}

/** Allocating form of `ringPointInto` — for tests and one-shot layout. */
export const ringPoint = (
  bx: number,
  bz: number,
  d: number,
  s: number,
): RingPoint => ringPointInto(bx, bz, d, s, { x: 0, z: 0, dx: 0, dz: 0 });

// --- The camera block window ---------------------------------------------

/**
 * Block-window radius, in blocks, shared by all four subsystems: a (2r+1)²
 * neighbourhood, camera-to-far-edge <= 600 m.
 *
 * Not a free knob. scene.fog is linear 60 → 800 and is applied AFTER emissive,
 * so a signal head at 700 m is 86 % fogged and bloom cannot rescue it; below
 * the gate the streetwall occludes nearly everything past one block anyway.
 * 3 is the hard ceiling regardless — a block's far edge would sit 4·BLOCK_PITCH
 * = 800 m out, and wrapDelta/nearestImage go ambiguous at WORLD_SIZE / 2.
 */
export const BLOCK_WINDOW_RADIUS = 2;

/** A canonical block index on the CITY_GRID lattice. */
export interface BlockIndex {
  bx: number;
  bz: number;
}

/** The block a canonical position falls in. */
export const blockOf = (p: Vec3): BlockIndex => {
  const c = canonicalize(p);
  return {
    bx: Math.floor(c.x / BLOCK_PITCH),
    bz: Math.floor(c.z / BLOCK_PITCH),
  };
};

/**
 * The (2r+1)² canonical blocks around `cameraPos`, wrapped mod CITY_GRID.
 * Distinct as long as 2r+1 <= CITY_GRID, so no block is ever visited twice
 * (and no pedestrian drawn twice) however close to the seam the camera is.
 */
export function blockWindow(
  cameraPos: Vec3,
  radius = BLOCK_WINDOW_RADIUS,
): BlockIndex[] {
  const { bx, bz } = blockOf(cameraPos);
  const out: BlockIndex[] = [];
  for (let i = -radius; i <= radius; i++) {
    for (let j = -radius; j <= radius; j++) {
      out.push({
        bx: (((bx + i) % CITY_GRID) + CITY_GRID) % CITY_GRID,
        bz: (((bz + j) % CITY_GRID) + CITY_GRID) % CITY_GRID,
      });
    }
  }
  return out;
}

// --- The altitude gate ----------------------------------------------------

/** Camera altitude at or below which the micro tier draws at full density, m. */
export const MICRO_GATE_FULL = 100;
/** Camera altitude at or above which nothing in the micro tier is drawn, m. */
export const MICRO_GATE_OFF = 140;

/**
 * Micro-tier detail fraction for a camera altitude: 1 at or below
 * MICRO_GATE_FULL, 0 at or above MICRO_GATE_OFF, linear between.
 *
 * A fade band rather than a hard cut: at 100–140 m a 1.8 m figure is 16–11 px
 * on a 1080 px screen at FOV 70, so a uniformly thinning crowd is an
 * invisible transition where a pop would be obvious.
 */
export const microGate = (cameraY: number): number =>
  Math.min(
    1,
    Math.max(
      0,
      (MICRO_GATE_OFF - cameraY) / (MICRO_GATE_OFF - MICRO_GATE_FULL),
    ),
  );

/** Golden ratio conjugate — the low-discrepancy sequence's step. */
const PHI_STEP = 0.618_033_988_749_894_9;

/**
 * Keep rule for thinning a population to fraction `k`, by index.
 *
 * A plain `i / n < k` threshold would be wrong here in a way that shows: a
 * walker's station along the ring grows with its index, so an index threshold
 * deletes one CONTIGUOUS arc of every block — a quarter of the sidewalk goes
 * empty at k = 0.75. The golden-ratio sequence is maximally spread by the
 * three-distance theorem, so the crowd thins uniformly along the ring instead.
 */
export const microKeep = (i: number, k: number): boolean =>
  (i * PHI_STEP) % 1 < k;
