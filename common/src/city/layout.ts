// The hand-placed half of the city: which blocks are landmarks and which are
// plazas. Split out of the generator so the two are independently readable —
// this file is orientation data (fixed, seed-independent, tuned by eye), while
// index.ts is the procedure that dresses everything else.
//
// Both lists are block indices (bx, bz) on the GRID×GRID lattice, so they are
// only meaningful while BLOCK_PITCH divides WORLD_SIZE into that same grid.

/**
 * Hand-placed landmark supertall blocks (bx, bz block indices) — fixed for
 * orientation, independent of the seed. Each keeps its whole block: a single
 * slim tower with clear ground around it, so it reads as a landmark against
 * the streetwall rather than as one more lot.
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
