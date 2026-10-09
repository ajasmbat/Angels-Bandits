// C2 quakes, the client's pure half: how hard the ground under the camera is
// shaking right now, on the synced render clock — the largest of the room's
// announced quakes (common/src/chaos.ts quakeAmp), expressed as the D3
// collapse jolt's 0..1 amount so the one shake path (camera.ts
// collapseShakeOffset) carries both. No THREE, no audio, no allocation.

import {
  QUAKE_SHAKE_M,
  type QuakeEvent,
  quakeAmp,
} from "@angels-bandits/common/chaos";
import type { Vec3 } from "@angels-bandits/common/world";
import { COLLAPSE_SHAKE_PEAK } from "./camera";

/** The shake amount (0..1 of COLLAPSE_SHAKE_PEAK) the room's quakes put on
 * a camera at `pos` at server time `renderMs`. */
export function quakeShakeAmount(
  quakes: Iterable<QuakeEvent>,
  pos: Vec3,
  renderMs: number,
): number {
  let amp = 0;
  for (const q of quakes) amp = Math.max(amp, quakeAmp(q, pos, renderMs));
  return Math.min(1, (amp * QUAKE_SHAKE_M) / COLLAPSE_SHAKE_PEAK);
}
