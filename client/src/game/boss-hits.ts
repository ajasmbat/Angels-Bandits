// S4: rounds against the sky boss, shooter side — the pure seam (like
// hitdetect.ts). Each frame a bullet sweeps `prev` → `cur`; against the
// zeppelin posed at the render clock (the pose it is drawn and collided at)
// the segment meets a LIVE weak point (a hit to claim — the server re-runs
// the same line, common/src/boss.ts bossHitValid), armour (the round stops
// there: sparks, no claim), or nothing. Torus-aware through wrapDelta.

import {
  BOSS_RADIUS,
  type BossPose,
  type BossSlot,
  blankPose,
  bossPoseAt,
  bossPresent,
  bossRayHit,
} from "@angels-bandits/common/boss";
import { type Vec3, wrapDeltaInto } from "@angels-bandits/common/world";

/** What a bullet's step met on the zeppelin. `dir` is the step's unit
 * direction (the claim's line), `at` where it struck. */
export interface BossBulletHit {
  /** Weak point index, or -1 for armour. */
  weak: number;
  at: Vec3;
  dir: Vec3;
}

const pose: BossPose = blankPose();
const step: Vec3 = { x: 0, y: 0, z: 0 };
const toBoss: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The first thing on the zeppelin this frame's bullet step meets, or null.
 * `alive[k]`: weak point k still has HP. Allocates only on a hit.
 */
export function bossBulletHit(
  slot: BossSlot,
  alive: readonly boolean[],
  prev: Vec3,
  cur: Vec3,
  renderMs: number | null,
): BossBulletHit | null {
  const r = slot.raid;
  if (!r || renderMs === null || !bossPresent(slot, renderMs)) return null;
  wrapDeltaInto(prev, cur, step);
  const len = Math.hypot(step.x, step.y, step.z);
  if (len === 0) return null;
  bossPoseAt(r, renderMs, pose);
  // Far from the hull: no box test at all.
  wrapDeltaInto(prev, pose, toBoss);
  if (Math.hypot(toBoss.x, toBoss.y, toBoss.z) > BOSS_RADIUS + len) return null;
  const dir = { x: step.x / len, y: step.y / len, z: step.z / len };
  const hit = bossRayHit(pose, prev, dir, len, alive);
  if (!hit) return null;
  return {
    weak: hit.weak,
    dir,
    at: {
      x: prev.x + dir.x * hit.dist,
      y: prev.y + dir.y * hit.dist,
      z: prev.z + dir.z * hit.dist,
    },
  };
}
