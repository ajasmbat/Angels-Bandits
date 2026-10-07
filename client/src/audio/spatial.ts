// Pure audio spatialization math (PLAN.md: audio panning goes through
// wrapDelta like everything else). No WebAudio in here — sound.ts feeds
// these numbers into StereoPanner/Gain nodes; this module is the seam.

import { FOG_DISTANCE } from "@angels-bandits/common/constants";
import {
  type Vec3,
  wrapDelta,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";

/** Full volume within this range, inverse falloff beyond it, meters. */
export const AUDIO_REF_DISTANCE = 30;

/** An enemy bullet passing nearer than this triggers the whoosh, meters. */
export const NEAR_MISS_RADIUS = 10;

export interface Spatial {
  /** Stereo pan, −1 (hard left) … +1 (hard right) of the listener's nose. */
  pan: number;
  /** Distance attenuation, 0…1. Zero beyond FOG_DISTANCE — out of the haze,
   * out of earshot (and the torus hard rule keeps it under WORLD_SIZE/2). */
  gain: number;
  /** Shortest torus distance, meters (for triggers/priority). */
  distance: number;
}

/**
 * Pan + gain of `source` for a listener at `listenerPos` with `listenerYaw`
 * (flight yaw: 0 faces −Z, right turn decreases yaw — right ear toward +X
 * cos(yaw) − Z sin(yaw)).
 */
export function spatialize(
  listenerPos: Vec3,
  listenerYaw: number,
  sourcePos: Vec3,
): Spatial {
  const d = wrapDelta(listenerPos, sourcePos);
  const distance = Math.hypot(d.x, d.y, d.z);
  if (distance >= FOG_DISTANCE) return { pan: 0, gain: 0, distance };
  const gain = Math.min(1, AUDIO_REF_DISTANCE / Math.max(distance, 1e-6));

  // Listener's right vector: fwd(−sin yaw, −cos yaw) × up = (cos yaw, −sin yaw).
  const flat = Math.hypot(d.x, d.z);
  const pan =
    flat < 1e-6
      ? 0
      : Math.max(
          -1,
          Math.min(
            1,
            (d.x * Math.cos(listenerYaw) - d.z * Math.sin(listenerYaw)) / flat,
          ),
        );
  return { pan, gain, distance };
}

/**
 * Closest distance between the listener and one frame's bullet segment
 * `prev` → `cur` (never extrapolated) — the near-miss whoosh trigger.
 * Same torus-relative sweep as hitdetect's bulletHitsSphere.
 */
export function closestApproach(prev: Vec3, cur: Vec3, listener: Vec3): number {
  // wrapDelta, one axis at a time: this runs per enemy bullet per frame, and
  // two fresh Vec3s each was the furball's biggest steady garbage (O4).
  const rx = wrapDeltaAxis(listener.x, prev.x);
  const ry = prev.y - listener.y;
  const rz = wrapDeltaAxis(listener.z, prev.z);
  const sx = wrapDeltaAxis(prev.x, cur.x);
  const sy = cur.y - prev.y;
  const sz = wrapDeltaAxis(prev.z, cur.z);
  const segLenSq = sx * sx + sy * sy + sz * sz;
  let t = 0;
  if (segLenSq > 0) {
    const dot = rx * sx + ry * sy + rz * sz;
    t = Math.min(1, Math.max(0, -dot / segLenSq));
  }
  return Math.hypot(rx + sx * t, ry + sy * t, rz + sz * t);
}
