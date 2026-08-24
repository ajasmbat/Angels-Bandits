// The adaptive interpolation delay (ANGE-4KO2W2) — the only stateful half of
// the controller; all of the math lives in common/src/net.ts so both sides of
// the wire agree on the floor, the ceiling, and the slack derived from it.
//
// The old fixed 100 ms buffer made every player pay for the worst connection
// in the room. This holds the SMALLEST safe buffer instead: one snapshot
// interval plus a margin on a clean link, growing only as far as that
// client's own measured snapshot jitter demands.
//
// The single asymmetry that makes it safe: jitter attacks instantly and
// decays slowly, so the buffer deepens on the FIRST late snapshot — before
// remotes stutter — and only relaxes once the link has been calm for a while.
// That is also why it cannot oscillate: alternating jitter simply pins the
// estimate to the larger deviation.

import { INTERP_FLOOR_MS } from "@angels-bandits/common/constants";
import { interpDelayFor, nextJitter } from "@angels-bandits/common/net";

export class InterpDelay {
  /** Smoothed snapshot-arrival jitter, ms. */
  private jitterMs = 0;
  private prevArrivalMs: number | null = null;

  /** Record one snapshot's arrival on the LOCAL clock (performance.now()). */
  observe(arrivalMs: number): void {
    const prev = this.prevArrivalMs;
    this.prevArrivalMs = arrivalMs;
    // The first snapshot has no gap, and a non-monotonic clock reading is not
    // evidence of anything — either way, nothing to learn yet.
    if (prev === null || arrivalMs <= prev) return;
    this.jitterMs = nextJitter(this.jitterMs, arrivalMs - prev);
  }

  /** The buffer to hold right now, ms. Never below one snapshot interval. */
  get delayMs(): number {
    return interpDelayFor(this.jitterMs);
  }

  /** Current jitter estimate, ms — QA/telemetry only. */
  get jitter(): number {
    return this.jitterMs;
  }

  /** Forget the arrival history (a reconnect; the old gaps mean nothing). */
  reset(): void {
    this.jitterMs = 0;
    this.prevArrivalMs = null;
  }
}

/** The delay a fresh client starts at, before any snapshot has arrived. */
export const INITIAL_INTERP_DELAY_MS = INTERP_FLOOR_MS;
