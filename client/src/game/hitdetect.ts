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

/** A target as the bullet sweep sees it; `prot` = spawn-protected. */
export interface ImpactTarget {
  pos: Vec3;
  prot?: boolean;
}

/**
 * The first of `targets` this frame's bullet step `prev` → `cur` touches,
 * protected or not (a shielded plane still stops the round), or null.
 */
export function bulletImpact<T extends ImpactTarget>(
  prev: Vec3,
  cur: Vec3,
  targets: readonly T[],
): T | null {
  for (const target of targets) {
    if (bulletHitsSphere(prev, cur, target.pos)) return target;
  }
  return null;
}

/**
 * What an impact means locally (U1). The server rejects hits on a protected
 * plane, so a round that meets one is a "shield" glance: no hit claim, no
 * hit marker, no thunk — only a "hit" earns those.
 */
export function impactKind(target: ImpactTarget): "hit" | "shield" {
  return target.prot ? "shield" : "hit";
}
