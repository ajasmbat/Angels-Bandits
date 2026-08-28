// Seeded deterministic city generator, shared verbatim by client and server.
// Both sides call generateCity(seed) with the same seed and MUST get the same
// buildings — the client renders them, the server collides against them.
// No Math.random() anywhere in here; a change to the draw order or the PRNG
// is a protocol break.

import {
  BLOCK_PITCH,
  HEIGHT_BANDS,
  LANDMARK_FOOTPRINT,
  LANDMARK_HEIGHT,
  LOT_CROSS_SPLIT_CHANCE,
  LOT_INTERIOR_INSET_MAX,
  LOT_MAX_DEPTH,
  LOT_MIN_WIDTH,
  LOT_SPLIT_MAX,
  LOT_SPLIT_MIN,
  LOT_STOP_CHANCE,
  TIER_SETBACK_MAX,
  TIER_SETBACK_MIN,
  TIER_SPLIT_MAX,
  TIER_SPLIT_MIN,
  TIER_THREE_MIN_HEIGHT,
  TIER_TWO_MIN_HEIGHT,
  WORLD_SIZE,
} from "../constants";
import { CONSTRUCTION_BLOCKS, LANDMARK_BLOCKS, PLAZA_BLOCKS } from "./layout";
import { LOT_LINE } from "./street";

// Re-exported so the hand-placed lists keep their long-standing import site
// (client signage, common/storm) while living in their own module.
export { CONSTRUCTION_BLOCKS, LANDMARK_BLOCKS, PLAZA_BLOCKS };

/** One box of a setback tower, centered on the building's (x, z). */
export interface Tier {
  width: number;
  depth: number;
  /** This tier's own vertical extent, meters (tiers stack from the ground). */
  height: number;
}

/**
 * One setback tower. (x, z) is the footprint center, on the ground;
 * width/depth/height stay the tier-1 footprint and TOTAL height (minimap,
 * street math, and quick collision rejects read them unchanged), while
 * `tiers` is the exact rendered-and-collided silhouette, bottom-up.
 */
export interface Building {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  tiers: Tier[];
}

/** Blocks per world side (10 for a 2 km world with 200 m blocks). Exported
 * because the collision block index buckets by exactly this lattice. */
export const CITY_GRID = WORLD_SIZE / BLOCK_PITCH;

/** mulberry32 — tiny seeded PRNG, identical output in Node and the browser.
 * Exported so deterministic client-side dressing (roof clutter, V3 traffic)
 * reuses the same generator instead of growing a parallel one. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const blockKey = (bx: number, bz: number) => bx * CITY_GRID + bz;

/**
 * Landmarks' fixed slim-shaft-and-crown profile: podium at the full
 * LANDMARK_FOOTPRINT, a long shaft, a small crown; heights sum to
 * LANDMARK_HEIGHT. Hand-placed like the landmark blocks themselves —
 * orientation reads must survive reseeds.
 */
const LANDMARK_TIERS: readonly Tier[] = [
  { width: LANDMARK_FOOTPRINT, depth: LANDMARK_FOOTPRINT, height: 60 },
  { width: 62, depth: 62, height: 150 },
  { width: 34, depth: 34, height: 40 },
];

/** How many tiers a building of `height` gets from its 0..1 tier roll. */
function tierCount(height: number, rTier: number): number {
  if (height < TIER_TWO_MIN_HEIGHT) return 1;
  if (height >= TIER_THREE_MIN_HEIGHT && rTier < 0.55) return 3;
  if (rTier < 0.85) return 2;
  return 1; // some talls stay sheer slabs — skyline variety
}

/**
 * Stack `count` centered tiers: each non-top tier keeps `split` of the height
 * remaining below it, each upper tier shrinks the footprint by `setback`.
 * Heights are integers and sum exactly to `height` (the top takes the rest).
 */
function buildTiers(
  width: number,
  depth: number,
  height: number,
  count: number,
  rSetback: number,
  rSplit: number,
): Tier[] {
  const setback =
    TIER_SETBACK_MIN + rSetback * (TIER_SETBACK_MAX - TIER_SETBACK_MIN);
  const split = TIER_SPLIT_MIN + rSplit * (TIER_SPLIT_MAX - TIER_SPLIT_MIN);
  const tiers: Tier[] = [];
  let w = width;
  let d = depth;
  let remaining = height;
  for (let i = 0; i < count; i++) {
    const h = i === count - 1 ? remaining : Math.round(remaining * split);
    tiers.push({ width: w, depth: d, height: h });
    remaining -= h;
    w = Math.round(w * setback);
    d = Math.round(d * setback);
  }
  return tiers;
}

/**
 * A rectangle of buildable land in canonical world coordinates, x0 < x1 and
 * z0 < z1. Lots never wrap: every one sits strictly inside its block, which
 * is what lets the collision block index bucket them by a single lattice cell.
 */
interface Lot {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Clamp `v` into [lo, hi]. */
const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Recursive binary subdivision of one block's buildable rectangle into lots.
 *
 * Splits favour the longer axis (with a seeded chance to take the shorter one)
 * and land at a seeded ratio rather than the middle, so a block ends up with
 * the irregular rhythm a cadastral map has — one wide lot beside three narrow
 * ones — instead of the uniform widths a fixed grid would give. Recursion
 * stops at LOT_MAX_DEPTH, at a seeded early stop past depth 1, or when neither
 * axis can be cut without leaving a lot under LOT_MIN_WIDTH.
 */
function subdivide(
  lot: Lot,
  depth: number,
  rand: () => number,
  out: Lot[],
): void {
  const width = lot.x1 - lot.x0;
  const depthM = lot.z1 - lot.z0;
  const canX = width >= 2 * LOT_MIN_WIDTH;
  const canZ = depthM >= 2 * LOT_MIN_WIDTH;

  if (depth >= LOT_MAX_DEPTH || (!canX && !canZ)) {
    out.push(lot);
    return;
  }
  if (depth >= 2 && rand() < LOT_STOP_CHANCE) {
    out.push(lot);
    return;
  }

  // Longer axis by default; the cross-split roll is the irregularity source.
  let splitX = width >= depthM;
  if (rand() < LOT_CROSS_SPLIT_CHANCE) splitX = !splitX;
  if (splitX && !canX) splitX = false;
  if (!splitX && !canZ) splitX = true;

  const len = splitX ? width : depthM;
  const start = splitX ? lot.x0 : lot.z0;
  // Keep the ratio inside the range that leaves both halves buildable; when
  // the lot is so tight that no such ratio exists in [MIN, MAX], halve it.
  const lo = Math.max(LOT_SPLIT_MIN, LOT_MIN_WIDTH / len);
  const hi = Math.min(LOT_SPLIT_MAX, 1 - LOT_MIN_WIDTH / len);
  const ratio = lo >= hi ? 0.5 : lo + rand() * (hi - lo);
  // Round to whole meters, then re-clamp: rounding must not shave a half
  // below LOT_MIN_WIDTH, which is the invariant the whole recursion rests on.
  const cut = clamp(
    Math.round(start + len * ratio),
    start + LOT_MIN_WIDTH,
    start + len - LOT_MIN_WIDTH,
  );

  const a = splitX ? { ...lot, x1: cut } : { ...lot, z1: cut };
  const b = splitX ? { ...lot, x0: cut } : { ...lot, z0: cut };
  subdivide(a, depth + 1, rand, out);
  subdivide(b, depth + 1, rand, out);
}

/**
 * Pull a lot's REAR edges back, opening mid-block light wells — the rear
 * yards a real block has behind its streetwall.
 *
 * An edge may move only when the slot it opens cannot be seen from a street.
 * Moving the edge at z0 opens a slot running along the lot's whole x-span, so
 * it is street-visible unless BOTH x edges are interior; symmetrically for the
 * x edges. An edge lying on the block boundary is street frontage and never
 * moves at all. Together those two rules mean the perimeter of every block
 * stays a solid, unbroken plane while its inside gets light wells.
 */
function insetInterior(lot: Lot, block: Lot, rand: () => number): Lot {
  const freeX = lot.x0 > block.x0 && lot.x1 < block.x1;
  const freeZ = lot.z0 > block.z0 && lot.z1 < block.z1;
  // Draw all four regardless of which edges may actually move, so a lot's
  // inset does not depend on where in the block it happens to sit.
  const pull = (allowed: boolean) =>
    allowed ? Math.round(rand() * LOT_INTERIOR_INSET_MAX) : 0;
  const dx0 = pull(freeZ && lot.x0 > block.x0);
  const dx1 = pull(freeZ && lot.x1 < block.x1);
  const dz0 = pull(freeX && lot.z0 > block.z0);
  const dz1 = pull(freeX && lot.z1 < block.z1);

  const inset = {
    x0: lot.x0 + dx0,
    x1: lot.x1 - dx1,
    z0: lot.z0 + dz0,
    z1: lot.z1 - dz1,
  };
  // Never inset a lot out of existence.
  const minSide = LOT_MIN_WIDTH / 2;
  if (inset.x1 - inset.x0 < minSide || inset.z1 - inset.z0 < minSide) {
    return lot;
  }
  return inset;
}

/**
 * Height for one lot from the HEIGHT_BANDS table: `rBand` picks the band,
 * `rIn` picks uniformly inside it. A band table rather than a power curve
 * because the skyline read is the histogram — mostly low streetwall with a
 * thin tail of towers — and that is far easier to tune as bands.
 */
function bandHeight(rBand: number, rIn: number): number {
  for (const band of HEIGHT_BANDS) {
    if (rBand < band[0]) return Math.round(band[1] + rIn * (band[2] - band[1]));
  }
  const last = HEIGHT_BANDS[HEIGHT_BANDS.length - 1];
  if (!last) throw new Error("HEIGHT_BANDS is empty");
  return Math.round(last[1] + rIn * (last[2] - last[1]));
}

/**
 * Per-block PRNG stream. Replaces the old "draw every block's randoms even
 * for skipped blocks" trick, which cannot survive lot subdivision drawing a
 * VARIABLE number of randoms per block. Seeding each block independently is
 * strictly stronger: a block's lots depend only on (seed, bx, bz), so editing
 * LANDMARK_BLOCKS or PLAZA_BLOCKS cannot shift any other block's layout.
 * Same spatial-hash recipe the client's roof clutter and signage already use.
 */
const blockSeed = (seed: number, bx: number, bz: number) =>
  (seed ^ Math.imul(bx + 1, 73856093) ^ Math.imul(bz + 1, 19349663)) >>> 0;

/**
 * Generate the full city for a seed. Every block of the CITY_GRID×CITY_GRID
 * Manhattan grid is subdivided into irregular lots that build out to the lot
 * line, except fixed plaza blocks (left empty for C2) and fixed landmark
 * blocks (one slim supertall each). Deterministic for a given seed.
 */
export function generateCity(seed: number): Building[] {
  const landmarks = new Set(
    LANDMARK_BLOCKS.map(([bx, bz]) => blockKey(bx, bz)),
  );
  const plazas = new Set(PLAZA_BLOCKS.map(([bx, bz]) => blockKey(bx, bz)));
  // Construction sites are empty ground like plazas: their tower cranes live
  // in city/movers.ts as movers, never as Buildings (see CONSTRUCTION_BLOCKS).
  const sites = new Set(
    CONSTRUCTION_BLOCKS.map(([bx, bz]) => blockKey(bx, bz)),
  );

  const buildings: Building[] = [];
  for (let bx = 0; bx < CITY_GRID; bx++) {
    for (let bz = 0; bz < CITY_GRID; bz++) {
      const key = blockKey(bx, bz);
      if (plazas.has(key) || sites.has(key)) continue;
      if (landmarks.has(key)) {
        buildings.push({
          x: bx * BLOCK_PITCH + BLOCK_PITCH / 2,
          z: bz * BLOCK_PITCH + BLOCK_PITCH / 2,
          width: LANDMARK_FOOTPRINT,
          depth: LANDMARK_FOOTPRINT,
          height: LANDMARK_HEIGHT,
          tiers: LANDMARK_TIERS.map((t) => ({ ...t })),
        });
        continue;
      }

      // The buildable rectangle: the block inset by the sidewalk on all four
      // sides. Streets are centered on block-boundary lines, so LOT_LINE off
      // the centerline is exactly LOT_LINE inside the block edge.
      const block: Lot = {
        x0: bx * BLOCK_PITCH + LOT_LINE,
        z0: bz * BLOCK_PITCH + LOT_LINE,
        x1: (bx + 1) * BLOCK_PITCH - LOT_LINE,
        z1: (bz + 1) * BLOCK_PITCH - LOT_LINE,
      };

      const rand = mulberry32(blockSeed(seed, bx, bz));
      const lots: Lot[] = [];
      subdivide(block, 0, rand, lots);

      for (const raw of lots) {
        const lot = insetInterior(raw, block, rand);
        const width = lot.x1 - lot.x0;
        const depth = lot.z1 - lot.z0;
        const height = bandHeight(rand(), rand());
        const rTier = rand();
        const rSetback = rand();
        const rSplit = rand();
        buildings.push({
          x: (lot.x0 + lot.x1) / 2,
          z: (lot.z0 + lot.z1) / 2,
          width,
          depth,
          height,
          tiers: buildTiers(
            width,
            depth,
            height,
            tierCount(height, rTier),
            rSetback,
            rSplit,
          ),
        });
      }
    }
  }
  return buildings;
}
