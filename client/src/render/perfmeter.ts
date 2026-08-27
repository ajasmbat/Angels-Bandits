// Frame-time instrumentation (P1). One fixed-size ring of raw per-frame
// deltas plus the draw calls that frame — the single place fps, p50, p95 and
// the worst frame come from. The dev HUD, `__ab.perf()`, the headless perf
// harness and the adaptive resolution controller all read THIS, so a number
// in the harness report and a number on screen can never disagree.
//
// Mean fps is deliberately not the headline metric: a 2 % frame at 200 ms
// averages away and is precisely the stutter players call lag. Percentiles
// and the worst frame keep it visible.
//
// `push` allocates nothing (preallocated typed arrays, no array growth) —
// a per-frame allocation here would show up as the very GC spike the worst
// frame number exists to catch.

/**
 * Value at `p` (0..1) of an ASCENDING-sorted sample array, nearest-rank.
 * Empty input is 0 so a freshly reset meter reports zeros, never NaN.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[i] as number;
}

/** A window of frames summarised. Times are milliseconds. */
export interface FrameStats {
  /** Frames in the window (0 right after a reset). */
  count: number;
  p50: number;
  p95: number;
  p99: number;
  /** The single worst frame in the window — the hitch number. */
  worst: number;
  mean: number;
  /** Derived from p50, NOT from the mean: the fps half the frames beat. */
  fps: number;
  /** Median draw calls over the window. */
  drawCalls: number;
  /** Worst draw calls over the window. */
  drawCallsMax: number;
}

export const EMPTY_STATS: FrameStats = {
  count: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  worst: 0,
  mean: 0,
  fps: 0,
  drawCalls: 0,
  drawCallsMax: 0,
};

/** Rolling ring of per-frame samples. Capacity caps memory AND the window. */
export class FrameMeter {
  private readonly times: Float64Array;
  private readonly calls: Float64Array;
  private head = 0;
  private filled = 0;
  /**
   * Scratch for tail(), which the resolution controller calls at 4 Hz — that
   * one is allocation-free. `stats()` is NOT: it sorts, so it copies first,
   * which is why it is documented as a few-Hz call rather than a per-frame one.
   * A retained tail() result is invalidated by the next tail() call.
   */
  private readonly scratch: number[] = [];

  /**
   * 4096, not 1200: the harness captures a 5 s window, and any configuration
   * cheaper than ~4.2 ms a frame overruns 1200 samples and wraps the ring —
   * silently dropping the oldest frames and capping `count`, so `worst` is
   * no longer the worst of the window it claims to summarise. Two Float64
   * arrays at this size are 64 KB, which is nothing next to being wrong.
   */
  constructor(readonly capacity = 4096) {
    this.times = new Float64Array(capacity);
    this.calls = new Float64Array(capacity);
  }

  /** Frames currently held. */
  get count(): number {
    return this.filled;
  }

  /** Record one frame. Allocation-free by construction. */
  push(frameMs: number, drawCalls: number): void {
    this.times[this.head] = frameMs;
    this.calls[this.head] = drawCalls;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** Drop every sample — the harness calls this at each segment boundary. */
  reset(): void {
    this.head = 0;
    this.filled = 0;
  }

  /**
   * The last `n` frame times, oldest first. Reuses one scratch array, so the
   * result is only valid until the next call — the resolution controller
   * reads it a few times a second, never per frame.
   */
  tail(n: number): readonly number[] {
    const take = Math.min(n, this.filled);
    this.scratch.length = take;
    for (let i = 0; i < take; i++) {
      // head points at the NEXT write slot, so the newest sample is head-1.
      const idx = (this.head - take + i + this.capacity * 2) % this.capacity;
      this.scratch[i] = this.times[idx] as number;
    }
    return this.scratch;
  }

  /** Copy of every frame time held, oldest first (harness histograms). */
  samples(): number[] {
    return [...this.tail(this.filled)];
  }

  /** Summarise the whole window. Sorts a copy — call at a few Hz, not per frame. */
  stats(): FrameStats {
    if (this.filled === 0) return { ...EMPTY_STATS };
    const times: number[] = [];
    const calls: number[] = [];
    let sum = 0;
    for (let i = 0; i < this.filled; i++) {
      const t = this.times[i] as number;
      times.push(t);
      calls.push(this.calls[i] as number);
      sum += t;
    }
    times.sort((a, b) => a - b);
    calls.sort((a, b) => a - b);
    const p50 = percentile(times, 0.5);
    return {
      count: this.filled,
      p50,
      p95: percentile(times, 0.95),
      p99: percentile(times, 0.99),
      worst: times[times.length - 1] as number,
      mean: sum / this.filled,
      fps: p50 > 0 ? 1000 / p50 : 0,
      drawCalls: Math.round(percentile(calls, 0.5)),
      drawCallsMax: Math.round(calls[calls.length - 1] as number),
    };
  }
}
