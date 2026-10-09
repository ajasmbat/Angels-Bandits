// C2: rounds against the bomber formations, shooter side — the pure seam
// (like boss-hits.ts). Each frame a bullet sweeps `prev` → `cur`; against the
// ships posed at the render clock (where they are drawn and collided) the
// segment meets a ship (a hit to claim — the server re-runs the same line,
// common/src/chaos.ts bomberRayHit) or nothing. Torus-aware through
// wrapDelta.

import { type BomberSlot, bomberRayHit } from "@angels-bandits/common/chaos";
import { type Vec3, wrapDeltaInto } from "@angels-bandits/common/world";

/** What a bullet's step met: the run and ship, where, and the step's unit
 * direction (the claim's line). */
export interface BomberBulletHit {
  run: number;
  k: number;
  at: Vec3;
  dir: Vec3;
}

const step: Vec3 = { x: 0, y: 0, z: 0 };
const unit: Vec3 = { x: 0, y: 0, z: 0 };

/** The ship this frame's bullet step meets first, or null. Allocates only
 * on a hit. */
export function bomberBulletHit(
  slot: BomberSlot,
  prev: Vec3,
  cur: Vec3,
  renderMs: number | null,
): BomberBulletHit | null {
  if (renderMs === null || slot.runs.length === 0) return null;
  wrapDeltaInto(prev, cur, step);
  const len = Math.hypot(step.x, step.y, step.z);
  if (len === 0) return null;
  unit.x = step.x / len;
  unit.y = step.y / len;
  unit.z = step.z / len;
  const hit = bomberRayHit(slot, prev, unit, len, renderMs);
  if (!hit) return null;
  return {
    run: hit.run,
    k: hit.k,
    dir: { ...unit },
    at: {
      x: prev.x + unit.x * hit.dist,
      y: prev.y + unit.y * hit.dist,
      z: prev.z + unit.z * hit.dist,
    },
  };
}
