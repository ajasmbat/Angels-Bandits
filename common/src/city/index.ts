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
  WORLD_SIZE,
} from "../constants";

/** One extruded-box building. (x, z) is the footprint center, on the ground. */
export interface Building {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
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

/** mulberry32 — tiny seeded PRNG, identical output in Node and the browser. */
function mulberry32(seed: number): () => number {
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

      const key = blockKey(bx, bz);
      if (plazas.has(key)) continue;
      if (landmarks.has(key)) {
        buildings.push({
          x,
          z,
          width: LANDMARK_FOOTPRINT,
          depth: LANDMARK_FOOTPRINT,
          height: LANDMARK_HEIGHT,
        });
        continue;
      }

      const span = BUILDING_MAX_FOOTPRINT - BUILDING_MIN_FOOTPRINT;
      buildings.push({
        x,
        z,
        width: Math.round(BUILDING_MIN_FOOTPRINT + rWidth * span),
        depth: Math.round(BUILDING_MIN_FOOTPRINT + rDepth * span),
        // Square the roll to skew heights low: mostly mid-rise, rare talls.
        height: Math.round(
          BUILDING_MIN_HEIGHT +
            rHeight * rHeight * (BUILDING_MAX_HEIGHT - BUILDING_MIN_HEIGHT),
        ),
      });
    }
  }
  return buildings;
}
