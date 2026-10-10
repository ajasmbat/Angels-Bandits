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
import { type CaveIn, caveInShake } from "@angels-bandits/common/city/caveins";
import type { Vec3 } from "@angels-bandits/common/world";
import { COLLAPSE_SHAKE_PEAK } from "./camera";

/** quakeShakeAmount's walk (P4: Map.forEach with a module-level callback —
 * iterating `quakes.values()` built an iterator every shaking frame). */
const walk = { pos: null as Vec3 | null, renderMs: 0, amp: 0 };
const strongest = (q: QuakeEvent): void => {
  if (walk.pos) {
    walk.amp = Math.max(walk.amp, quakeAmp(q, walk.pos, walk.renderMs));
  }
};

/** The shake amount (0..1 of COLLAPSE_SHAKE_PEAK) the room's quakes put on
 * a camera at `pos` at server time `renderMs`. */
export function quakeShakeAmount(
  quakes: ReadonlyMap<number, QuakeEvent>,
  pos: Vec3,
  renderMs: number,
): number {
  walk.pos = pos;
  walk.renderMs = renderMs;
  walk.amp = 0;
  quakes.forEach(strongest);
  walk.pos = null;
  return Math.min(1, (walk.amp * QUAKE_SHAKE_M) / COLLAPSE_SHAKE_PEAK);
}

/** U6: the shake amount (0..1 of COLLAPSE_SHAKE_PEAK) the room's cave-ins
 * put on a camera at `pos` at server time `renderMs` — the strongest of
 * them (common/src/city/caveins.ts caveInShake). An index loop: nothing
 * allocated per frame. */
export function caveInShakeAmount(
  list: readonly CaveIn[],
  pos: Vec3,
  renderMs: number,
): number {
  let amp = 0;
  for (let i = 0; i < list.length; i++) {
    amp = Math.max(amp, caveInShake(list[i] as CaveIn, pos, renderMs));
  }
  return Math.min(1, amp);
}
