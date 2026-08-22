// Thunder scheduling (ST2): pure bookkeeping between a strike's flash and
// its sound — far strikes flash now and rumble later, at 340 m/s over the
// shortest torus path. No WebAudio here; GameAudio.thunder is the adapter
// that turns a due event into sound (the spatial.ts split, applied to time).

import type { Strike } from "@angels-bandits/common/storm";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import { thunderDelayMs, thunderGain } from "../render/storm";

/** Within this torus distance a strike cracks instead of rumbling, m. */
const HARD_CRACK_RANGE = 350;

/** One due thunder sound: loudness 0..1 and whether it cracks. */
export interface ThunderEvent {
  gain: number;
  hard: boolean;
}

interface Pending extends ThunderEvent {
  dueAt: number;
}

/** Queue strikes as they flash; pop their sounds when the delay elapses. */
export class ThunderSchedule {
  private pending: Pending[] = [];

  add(strike: Strike, listener: Vec3, nowMs: number): void {
    const dist = wrapDistance(
      { x: strike.x, y: 0, z: strike.z },
      listener,
    );
    const gain = thunderGain(dist);
    if (gain <= 0) return; // inaudible — never schedule silence
    this.pending.push({
      dueAt: nowMs + thunderDelayMs(strike, listener),
      gain,
      hard: dist < HARD_CRACK_RANGE,
    });
  }

  /** Pop every event whose delay has elapsed. Call once per frame. */
  due(nowMs: number): ThunderEvent[] {
    const ready = this.pending.filter((p) => nowMs >= p.dueAt);
    if (ready.length > 0) {
      this.pending = this.pending.filter((p) => nowMs < p.dueAt);
    }
    return ready.map(({ gain, hard }) => ({ gain, hard }));
  }
}
