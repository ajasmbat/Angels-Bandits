// H1 taller skyline: which kind of district each block is. Pure, seed-free
// orientation data like layout.ts — the generator reads it to pick a
// block's height table and lot depth, and anything else (D10's collapse
// scale, a renderer's skyline tint) may read the same seam.
//
// Manhattan reads as two downtown cores of skyscrapers, a mid-rise ring
// round them and low streetwall at the edges and along the water. On a
// torus there is no edge, so "edge" means far from both cores. Each core
// is anchored on a landmark supertall (Downtown on [2,3], Midtown on
// [5,8]); the other two landmarks ([7,1], [8,6]) stand in a mid-rise
// cluster of their own, never among low-rise.

import { BLOCK_PITCH, WORLD_SIZE } from "../constants";
import { LANDMARK_BLOCKS } from "./layout";
import { isRiverRow } from "./river";

export type BlockZone = "core" | "mid" | "edge";

/** The two cores' centres, canonical world metres (block centres). */
export const CITY_CORES: ReadonlyArray<{ x: number; z: number }> = [
  { x: 500, z: 500 }, // Downtown, round the glass landmark [2,3]
  { x: 1100, z: 1500 }, // Midtown, round the spire landmark [5,8]
];
/** A block whose centre is this close to a core centre is core, m. */
export const CORE_RADIUS = 320;
/** ...this close, mid-rise, m. */
export const MID_RADIUS = 600;
/** A block this close to a landmark block is at least mid-rise, m. */
export const LANDMARK_RING = 300;

/** Shortest torus distance between two canonical coordinates on one axis. */
const axis = (a: number, b: number): number => {
  const d = Math.abs(a - b) % WORLD_SIZE;
  return Math.min(d, WORLD_SIZE - d);
};

/** Is block row `bz` one of the river's two waterfront rows? */
const waterfront = (bz: number): boolean =>
  isRiverRow(bz - 1) || isRiverRow(bz + 1);

/**
 * The district block (bx, bz) belongs to, decided at its centre:
 *  - core: within CORE_RADIUS of a core centre;
 *  - mid: within MID_RADIUS of one, or within LANDMARK_RING of a landmark;
 *  - edge: everything else.
 * The waterfront rows step down one (core → mid, mid → edge) unless a
 * landmark is within LANDMARK_RING: the river is lined by low and mid-rise.
 */
export function blockZone(bx: number, bz: number): BlockZone {
  const cx = bx * BLOCK_PITCH + BLOCK_PITCH / 2;
  const cz = bz * BLOCK_PITCH + BLOCK_PITCH / 2;
  let core = Number.POSITIVE_INFINITY;
  for (const c of CITY_CORES) {
    core = Math.min(core, Math.hypot(axis(cx, c.x), axis(cz, c.z)));
  }
  let landmark = Number.POSITIVE_INFINITY;
  for (const [lx, lz] of LANDMARK_BLOCKS) {
    const x = lx * BLOCK_PITCH + BLOCK_PITCH / 2;
    const z = lz * BLOCK_PITCH + BLOCK_PITCH / 2;
    landmark = Math.min(landmark, Math.hypot(axis(cx, x), axis(cz, z)));
  }
  const nearLandmark = landmark <= LANDMARK_RING;
  let zone: BlockZone =
    core <= CORE_RADIUS
      ? "core"
      : core <= MID_RADIUS || nearLandmark
        ? "mid"
        : "edge";
  if (waterfront(bz) && !nearLandmark) {
    zone = zone === "core" ? "mid" : "edge";
  } else if (waterfront(bz) && zone === "core") {
    zone = "mid";
  }
  return zone;
}
