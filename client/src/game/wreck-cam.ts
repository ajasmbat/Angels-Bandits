// D4 kill-cam on your own wreck: for the KILL_CAM_MS beat after you are shot
// down, the camera rides behind your falling wreck instead of hanging where
// you died. Pure: the view is a function of the wreck's shared path and the
// render clock, so it follows exactly the wreck everyone else sees.

import { type Vec3, wrapCoord } from "@angels-bandits/common/world";
import { type WreckPath, wreckPosAt } from "@angels-bandits/common/wreck";

/** Eye offset: this far back along the death heading, m, and this far up. */
export const WRECK_CAM_BACK = 34;
export const WRECK_CAM_UP = 14;

/**
 * The kill-cam's eye and look-at at server time `ms`: `at` is the wreck
 * (holding on the impact point once it has landed), `eye` trails it along
 * the death heading's horizontal direction — that one never turns, so the
 * corkscrew spins in front of the camera instead of swinging it round.
 * Both canonical.
 */
export function wreckCamView(
  w: WreckPath,
  ms: number,
  eye: Vec3,
  at: Vec3,
): void {
  wreckPosAt(w, ms, at);
  const h = Math.hypot(w.v.x, w.v.z);
  const dx = h > 1e-6 ? w.v.x / h : 0;
  const dz = h > 1e-6 ? w.v.z / h : 1;
  eye.x = wrapCoord(at.x - dx * WRECK_CAM_BACK);
  eye.y = at.y + WRECK_CAM_UP;
  eye.z = wrapCoord(at.z - dz * WRECK_CAM_BACK);
}
