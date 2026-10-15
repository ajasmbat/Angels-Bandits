// DL1 Destruction Lab clock: the server time the lab poses its collapses at
// — debris, dust, the collapse detail, ruin smoke, the shake. Live, it IS
// the render clock. Paused, slowed or scrubbed, it is a view time of its own,
// never ahead of the live one (nothing later has happened yet).
//
// Exactness is the collapse model's: every piece's pose and every dust puff
// is a pure function of (wire, server time), so scrubbing to t draws exactly
// what the live view drew at t, whichever way the scrub came. (The
// particle dressing is a pool sprayed frame by frame: a scrub restarts it
// from the new time instead of replaying it.)

/** One frame at 60 Hz, ms: what a frame step moves. */
export const FRAME_STEP_MS = 1000 / 60;
/** The slow-motion range. */
export const SPEED_MIN = 0.1;
export const SPEED_MAX = 1;

export class LabClock {
  private view: number | null = null;
  private live = true;
  private paused = false;
  private rate = 1;
  /** Bumped whenever the view time jumps (a scrub, a step, back to live):
   * the stateful dressing restarts on it. */
  jumps = 0;

  get isLive(): boolean {
    return this.live;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get speed(): number {
    return this.rate;
  }

  /** The view time of the last frame (null before the first live time). */
  get viewMs(): number | null {
    return this.view;
  }

  /** This frame's view time, from the live render clock and the real time
   * since the last frame, s. */
  frame(liveMs: number | null, dt: number): number | null {
    if (liveMs === null) return this.view;
    if (this.view === null || (this.live && !this.paused && this.rate === 1)) {
      this.view = liveMs;
      return this.view;
    }
    if (!this.paused) {
      this.view += Math.max(0, dt) * 1000 * this.rate;
    }
    if (this.view >= liveMs) {
      this.view = liveMs;
      // Caught up at full speed: real time again.
      if (!this.paused && this.rate === 1) this.live = true;
    }
    return this.view;
  }

  /** Pause or play. Pausing live freezes the view where it is. */
  togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) this.live = false;
  }

  /** Slow motion, SPEED_MIN..SPEED_MAX (1 with play catches back up). */
  setSpeed(speed: number): void {
    this.rate = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
    if (this.rate < 1) this.live = false;
  }

  /** Jump the view to `tMs` (never past `liveMs`) and hold it there. */
  scrub(tMs: number, liveMs: number | null): void {
    if (!Number.isFinite(tMs)) return;
    this.view = liveMs === null ? tMs : Math.min(liveMs, tMs);
    this.paused = true;
    this.live = false;
    this.jumps++;
  }

  /** Step `frames` frames (negative: back), paused. */
  step(frames: number, liveMs: number | null): void {
    const from = this.view ?? liveMs;
    if (from === null) return;
    this.scrub(from + frames * FRAME_STEP_MS, liveMs);
  }

  /** Back to real time, full speed. */
  goLive(): void {
    this.live = true;
    this.paused = false;
    this.rate = 1;
    this.jumps++;
  }
}
