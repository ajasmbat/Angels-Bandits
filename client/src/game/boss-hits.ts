// Z1: rounds against the airship fleet, shooter side — the pure seam (like
// hitdetect.ts). Each frame a bullet sweeps `prev` → `cur`; against every
// ship posed at the render clock (the pose it is drawn and collided at) the
// segment meets a weak point or the hull (a hit to claim either way — the
// server re-runs the same line, common/src/boss.ts shipHitValid), or
// nothing. The nearest ship it meets stops the round. Torus-aware through
// wrapDelta.

import {
  FLEET_LANES,
  type FleetSlot,
  SHIP_REACH,
  type ShipPose,
  blankPose,
  fleetPoseAt,
  shipPresent,
  shipRayHit,
} from "@angels-bandits/common/boss";
import { type Vec3, wrapDeltaInto } from "@angels-bandits/common/world";

/** What a bullet's step met on a ship. `dir` is the step's unit direction
 * (the claim's line), `at` where it struck. */
export interface BossBulletHit {
  /** The ship's id. */
  ship: number;
  /** Weak point index, or -1 for the hull. */
  weak: number;
  at: Vec3;
  dir: Vec3;
}

const pose: ShipPose = blankPose();
const step: Vec3 = { x: 0, y: 0, z: 0 };
const toShip: Vec3 = { x: 0, y: 0, z: 0 };
const unitStep: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The first ship this frame's bullet step meets, and where, or null. Only
 * intact ships are shootable (a falling one is already going down).
 * Allocates only on a hit.
 */
export function bossBulletHit(
  slot: FleetSlot,
  prev: Vec3,
  cur: Vec3,
  renderMs: number | null,
): BossBulletHit | null {
  if (renderMs === null || slot.ships.length === 0) return null;
  wrapDeltaInto(prev, cur, step);
  const len = Math.hypot(step.x, step.y, step.z);
  if (len === 0) return null;
  unitStep.x = step.x / len;
  unitStep.y = step.y / len;
  unitStep.z = step.z / len;
  let best = Number.POSITIVE_INFINITY;
  let bestShip = -1;
  let bestWeak = -1;
  for (const s of slot.ships) {
    if (!shipPresent(s, renderMs)) continue;
    const cls = (FLEET_LANES[s.lane] as { cls: 0 | 1 | 2 }).cls;
    const r = (SHIP_REACH[cls] as { r: number }).r;
    fleetPoseAt(s, renderMs, pose);
    // Far from the hull: no part test at all.
    wrapDeltaInto(prev, pose, toShip);
    if (Math.hypot(toShip.x, toShip.y, toShip.z) > r + len) continue;
    const hit = shipRayHit(pose, cls, prev, unitStep, len);
    if (hit && hit.dist < best) {
      best = hit.dist;
      bestShip = s.id;
      bestWeak = hit.weak;
    }
  }
  if (bestShip < 0) return null;
  const dir = { ...unitStep };
  return {
    ship: bestShip,
    weak: bestWeak,
    dir,
    at: {
      x: prev.x + dir.x * best,
      y: prev.y + dir.y * best,
      z: prev.z + dir.z * best,
    },
  };
}
