// Shooter-side hit detection (PLAN.md: hits resolve on the shooter's client,
// favoring the shooter). Each frame a bullet sweeps a segment; a remote plane
// is a sphere at its interpolated position. Pure math, torus-aware end to
// end: both the bullet's step and its offset from the target go through
// wrapDelta, so a duel across the seam is just a duel.

import { HIT_RADIUS } from "@angels-bandits/common/constants";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";

/**
 * Did a bullet moving `prev` → `cur` this frame pass within `radius` of
 * `center`? Closest-approach on the segment only — never extrapolated.
 */
export function bulletHitsSphere(
  prev: Vec3,
  cur: Vec3,
  center: Vec3,
  radius: number = HIT_RADIUS,
): boolean {
  // Work in target-relative coords: rel0 = bullet start seen from the target,
  // seg = the bullet's true (wrapped) step. rel0 + t·seg traces the segment.
  const rel0 = wrapDelta(center, prev);
  const seg = wrapDelta(prev, cur);
  const segLenSq = seg.x * seg.x + seg.y * seg.y + seg.z * seg.z;
  let t = 0;
  if (segLenSq > 0) {
    const dot = rel0.x * seg.x + rel0.y * seg.y + rel0.z * seg.z;
    t = Math.min(1, Math.max(0, -dot / segLenSq));
  }
  const cx = rel0.x + seg.x * t;
  const cy = rel0.y + seg.y * t;
  const cz = rel0.z + seg.z * t;
  return cx * cx + cy * cy + cz * cz <= radius * radius;
}
