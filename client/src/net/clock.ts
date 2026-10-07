// The smoothed clocks the frame loop renders on (O2). Pure and renderer-free:
// the frame loop feeds them its own rAF timestamps; they never read a clock.
//
// The raw render time — estimated server "now" minus the interpolation delay
// — STEPS: the clock-offset estimate jumps whenever a faster snapshot lands,
// and the adaptive delay attacks instantly by up to ~190 ms. Rendering on it
// made every remote plane, car, crane and searchlight hitch forward or step
// backward at exactly those moments. The delay controller is right to jump
// (it must grow before remotes stutter); what must not jump is its OUTPUT.
//
// RenderClock is that output: a clock advanced by real elapsed time that
// slews toward the raw target at no more than ±SLEW of real time, so the
// world can run 5 % fast or slow while it catches up but never stutters and
// never runs backward.

/** Most the clock's rate may differ from real time while it converges. */
export const RENDER_CLOCK_SLEW = 0.05;
/** Proportional time constant of the convergence, ms — small errors close
 * smoothly instead of bang-banging the rate between ±SLEW. */
export const RENDER_CLOCK_TAU_MS = 500;
/**
 * Past this error the slew would take seconds (1 s at 5 % is 20 s), so:
 * a clock this far BEHIND its target snaps forward (a hidden tab resuming,
 * a route change — content would otherwise sit seconds stale), and one this
 * far AHEAD holds still until the target catches up. Never a backward step.
 */
export const RENDER_CLOCK_SNAP_MS = 250;

export class RenderClock {
  private value: number | null = null;
  private lastFrameMs = 0;

  /**
   * Advance to the frame at `frameMs` (local clock, the rAF timestamp) and
   * return the smoothed time. `targetMs` is where the clock should be now.
   * Advances on the RAW frame delta — the sim clamps dt for stability, but a
   * clock that lost time on every slow frame would drift behind its target.
   */
  advance(frameMs: number, targetMs: number): number {
    if (this.value === null) {
      this.value = targetMs;
      this.lastFrameMs = frameMs;
      return targetMs;
    }
    const dt = Math.max(0, frameMs - this.lastFrameMs);
    this.lastFrameMs = frameMs;
    const predicted = this.value + dt;
    const error = targetMs - predicted;
    if (error > RENDER_CLOCK_SNAP_MS) {
      this.value = targetMs;
    } else if (error >= -RENDER_CLOCK_SNAP_MS) {
      const limit = RENDER_CLOCK_SLEW * dt;
      const step = error * Math.min(1, dt / RENDER_CLOCK_TAU_MS);
      this.value = predicted + Math.max(-limit, Math.min(limit, step));
    }
    // Otherwise far ahead: hold (rate 0) — never a backward step.
    return this.value;
  }

  /** The time returned by the last advance(), or null before the first. */
  get time(): number | null {
    return this.value;
  }

  /** Forget everything; the next advance() starts on its target. */
  reset(): void {
    this.value = null;
  }
}

/**
 * Fixed-cadence scheduler for the pose upload. The old `lastSentAt = now`
 * rule quantised to whole frames and never caught back up — at 60 fps a
 * 50 ms interval measured 49.99 ms one frame short and fell to every fourth
 * frame, ~15 Hz. Advancing the DEADLINE by the interval keeps the mean rate
 * exact; a stall (hidden tab) restarts the cadence instead of bursting the
 * missed sends.
 */
export class PoseCadence {
  private next: number | null = null;

  constructor(private readonly intervalMs: number) {}

  /** True when a pose should go out on the frame at `frameMs`. */
  due(frameMs: number): boolean {
    if (this.next === null) {
      this.next = frameMs + this.intervalMs;
      return true;
    }
    if (frameMs < this.next) return false;
    this.next += this.intervalMs;
    if (this.next <= frameMs) this.next = frameMs + this.intervalMs;
    return true;
  }
}
