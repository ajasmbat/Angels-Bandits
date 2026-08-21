// Seeded deterministic city generator, shared verbatim by client and server.
// Both sides call generateCity(seed) with the same seed and MUST get the same
// buildings — the client renders them, the server collides against them.
// No Math.random() anywhere in here; a change to the draw order or the PRNG
// is a protocol break.

import {
  BLOCK_PITCH,
  BUILDING_MAX_FOOTPRINT,
  BUILDING_MAX_HEIGHT,
  BUILDING_MIN_FOOTPRINT,
  BUILDING_MIN_HEIGHT,
  LANDMARK_FOOTPRINT,
  LANDMARK_HEIGHT,
  TIER_SETBACK_MAX,
  TIER_SETBACK_MIN,
  TIER_SPLIT_MAX,
  TIER_SPLIT_MIN,
  TIER_THREE_MIN_HEIGHT,
  TIER_TWO_MIN_HEIGHT,
  WORLD_SIZE,
} from "../constants";

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

/** Blocks per world side (10 for a 2 km world with 200 m blocks). */
const GRID = WORLD_SIZE / BLOCK_PITCH;

/**
 * Hand-placed landmark supertall blocks (bx, bz block indices) — fixed for
 * orientation, independent of the seed.
 */
export const LANDMARK_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [2, 3],
  [7, 1],
  [5, 8],
  [8, 6],
];

/** Hand-placed empty plaza blocks (bx, bz) — landmarks' counterpart for orientation. */
export const PLAZA_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [4, 4],
  [1, 7],
  [8, 2],
];

/** mulberry32 — tiny seeded PRNG, identical output in Node and the browser.
 * Exported so deterministic client-side dressing (roof clutter) reuses the
 * same generator instead of growing a parallel one. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const blockKey = (bx: number, bz: number) => bx * GRID + bz;

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
 * Generate the full city for a seed: one building centered in every block of
 * the GRID×GRID Manhattan grid, except fixed plaza blocks (empty) and fixed
 * landmark blocks (slim supertalls). Deterministic for a given seed.
 */
export function generateCity(seed: number): Building[] {
  const rand = mulberry32(seed);
  const landmarks = new Set(
    LANDMARK_BLOCKS.map(([bx, bz]) => blockKey(bx, bz)),
  );
  const plazas = new Set(PLAZA_BLOCKS.map(([bx, bz]) => blockKey(bx, bz)));

  const buildings: Building[] = [];
  for (let bx = 0; bx < GRID; bx++) {
    for (let bz = 0; bz < GRID; bz++) {
      const x = bx * BLOCK_PITCH + BLOCK_PITCH / 2;
      const z = bz * BLOCK_PITCH + BLOCK_PITCH / 2;
      // Always draw the block's randoms, even for skipped blocks, so the
      // layout of every other block is independent of the fixed placements.
      const rWidth = rand();
      const rDepth = rand();
      const rHeight = rand();
      const rTier = rand();
      const rSetback = rand();
      const rSplit = rand();

      const key = blockKey(bx, bz);
      if (plazas.has(key)) continue;
      if (landmarks.has(key)) {
        buildings.push({
          x,
          z,
          width: LANDMARK_FOOTPRINT,
          depth: LANDMARK_FOOTPRINT,
          height: LANDMARK_HEIGHT,
          tiers: LANDMARK_TIERS.map((t) => ({ ...t })),
        });
        continue;
      }

      const span = BUILDING_MAX_FOOTPRINT - BUILDING_MIN_FOOTPRINT;
      const width = Math.round(BUILDING_MIN_FOOTPRINT + rWidth * span);
      const depth = Math.round(BUILDING_MIN_FOOTPRINT + rDepth * span);
      // Square the roll to skew heights low: mostly mid-rise, rare talls.
      const height = Math.round(
        BUILDING_MIN_HEIGHT +
          rHeight * rHeight * (BUILDING_MAX_HEIGHT - BUILDING_MIN_HEIGHT),
      );
      buildings.push({
        x,
        z,
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
  return buildings;
}
