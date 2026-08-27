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

/**
 * Hand-placed construction-site blocks (bx, bz) — L2's tower cranes stand here.
 *
 * Like plazas these blocks emit NO buildings: the whole crane (mast, jib,
 * counter-jib, hook, cable) is a mover in city/movers.ts, not a Building. A
 * slim lattice mast cannot be a Building — it fails the generator's own
 * min(width, depth) >= LOT_MIN_WIDTH / 2 floor and the client's
 * "every lot shows more than one window bay" rule — and being one would buy
 * nothing: at the minimap's 0.16 px/m a 4 m mast is a 0.64 px smudge.
 *
 * Chosen by hand, not by seed, for the same reason the other two lists are:
 * a jib sweeping a particular canyon is an orientation landmark you learn.
 * Three constraints on any edit here:
 *   - never (0, 0) — common/test/collision.test.ts probes that block's center;
 *   - never a landmark or plaza block — a block belongs to exactly one list;
 *   - re-run the suite after changing them. Removing a block's lots shifts the
 *     city fingerprint and the banded width/height distribution tests.
 */
export const CONSTRUCTION_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [6, 6],
  [6, 0],
  [0, 6],
];
