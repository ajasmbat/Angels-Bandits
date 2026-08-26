// Adaptive resolution scaling (P1, confirmed win B).
//
// The renderer used to pin `setPixelRatio(min(devicePixelRatio, 2))`. On a
// Retina panel that is FOUR times the CSS pixels, and UnrealBloomPass then
// runs a five-level blur chain over every one of them — the dominant GPU
// cost in this scene. This controller spends that budget instead of assuming
// it: draw at the device ratio while frames are clean, back off toward
// RESOLUTION_FLOOR when they are not.
//
// Deliberately a PURE function of (recent frame times, current state, clock)
// → next state. It never touches the renderer, the composer or the bloom
// pass; main.ts applies the ratio it returns. That is what makes the
// convergence and anti-oscillation properties testable at all.
//
// The decision metric is the share of MISSED frames, not the average frame
// time. Under vsync a kept frame reads ~16.7 ms whether it cost 3 ms or
// 16 ms of GPU work — average frame time simply cannot see headroom there.
// A *missed* vsync, though, doubles the interval, and that is unambiguous.

/** Lowest device-pixel ratio we will ever draw at — below this it reads soft. */
export const RESOLUTION_FLOOR = 0.75;
/** Highest ratio, regardless of the panel: 3x phones gain nothing visible. */
export const RESOLUTION_CEILING = 2;
/** The frame budget we are steering to, ms (60 fps). */
export const FRAME_BUDGET_MS = 1000 / 60;
/** Over this, a frame is a genuine miss — a dropped vsync is ~2x the budget. */
export const MISS_MS = FRAME_BUDGET_MS * 1.5;
/** Share of missed frames in the window that forces a step down. */
export const MISS_SHARE = 0.1;
/** Frames required before the controller will decide anything. */
export const WINDOW_FRAMES = 45;
/** Down is decisive; up is timid. Asymmetry is most of the anti-pump. */
export const STEP_DOWN = 0.85;
/**
 * Once `hotRatio` is latched we already know roughly where the cliff is, so
 * further backoffs are nudges — a second 15 % drop would be the visible pump.
 */
export const STEP_DOWN_FINE = 0.95;
export const STEP_UP = 1.06;
/** Rate limits, ms. Backing off is allowed ~7x more often than climbing. */
export const DOWN_COOLDOWN_MS = 600;
export const UP_COOLDOWN_MS = 6000;
/**
 * Once a ratio has missed the budget we never climb back to it — only to
 * this fraction of it. This latch is what makes the controller CONVERGE
 * rather than pump between a ratio that works and one that does not.
 *
 * 0.9, not something closer to 1, because of what the browser QA showed
 * (tools/perf/scaler.mjs): at 0.97 the climb lands 3 % under a ratio we
 * already know misses, misses again, backs off 5 %, and repeats — a slow
 * 2-5 % pump that had not settled after 30 s. Backing off a clear 10 %
 * costs a little sharpness and settles in at most two probes, because the
 * first backoff is 15 % and 0.85 < 0.9 means the retreat ratio is already
 * above the next cap.
 *
 * There is deliberately no "forget" timer: a resolution change is visible,
 * and re-climbing 10 % of pixel ratio every time the view opens up would
 * trade a fixed, quiet image for a twitchy one. The latch is cleared only
 * when the frame is RESIZED, because that changes the pixel count the
 * latch was learned at (see main.ts's resize handler).
 */
export const HOT_MARGIN = 0.9;

export interface ResolutionState {
  /** Device-pixel ratio to draw at. */
  ratio: number;
  /** Clock reading (ms) of the last accepted change — the rate limit. */
  changedAt: number;
  /**
   * Lowest ratio we have ever RETREATED from; Infinity until we retreat
   * once. Monotonically non-increasing, and it caps every later climb — that
   * is the whole convergence argument.
   */
  hotRatio: number;
}

export interface ResolutionLimits {
  floor: number;
  ceiling: number;
}

/** Start at the device's own ratio (clamped) — back off only on evidence. */
export function createResolution(
  devicePixelRatio: number,
  now = 0,
): ResolutionState {
  return {
    ratio: clampRatio(devicePixelRatio, defaultLimits(devicePixelRatio)),
    changedAt: now,
    hotRatio: Number.POSITIVE_INFINITY,
  };
}

/** Floor/ceiling for a panel: never above the panel's own ratio. */
export function defaultLimits(devicePixelRatio: number): ResolutionLimits {
  const ceiling = Math.min(devicePixelRatio, RESOLUTION_CEILING);
  return { floor: Math.min(RESOLUTION_FLOOR, ceiling), ceiling };
}

const clampRatio = (r: number, l: ResolutionLimits): number =>
  Math.min(l.ceiling, Math.max(l.floor, r));

/** Share of `frames` (ms) that missed the budget outright. */
export function missShare(frames: readonly number[]): number {
  if (frames.length === 0) return 0;
  let missed = 0;
  for (const f of frames) if (f > MISS_MS) missed++;
  return missed / frames.length;
}

/**
 * One controller tick. Returns the SAME state object when nothing changes,
 * so callers can test identity to know whether to resize the renderer.
 *
 * Three outcomes, and only ever one per call:
 *  - misses at or over MISS_SHARE  → step down (and latch `hotRatio`)
 *  - a completely clean window     → step up, capped by the latch
 *  - anything between              → hold; this band is the hysteresis
 *
 * The two triggers are mutually exclusive by construction (a window cannot
 * both contain >=10 % misses and zero misses), so no single window can ever
 * argue for both directions.
 */
export function stepResolution(
  state: ResolutionState,
  frames: readonly number[],
  now: number,
  limits: ResolutionLimits,
): ResolutionState {
  if (frames.length < WINDOW_FRAMES) return state;
  const share = missShare(frames);

  if (share >= MISS_SHARE) {
    if (now - state.changedAt < DOWN_COOLDOWN_MS) return state;
    const step =
      state.hotRatio === Number.POSITIVE_INFINITY ? STEP_DOWN : STEP_DOWN_FINE;
    const next = clampRatio(state.ratio * step, limits);
    // Already on the floor: nothing left to give, and nothing to latch —
    // `hotRatio` names a ratio we RETREATED from, so the floor never enters
    // it (latching it there would strand us at the floor forever).
    if (next >= state.ratio) return state;
    return {
      ratio: next,
      changedAt: now,
      hotRatio: Math.min(state.hotRatio, state.ratio),
    };
  }

  if (share === 0) {
    if (now - state.changedAt < UP_COOLDOWN_MS) return state;
    const cap = Math.min(limits.ceiling, state.hotRatio * HOT_MARGIN);
    const next = Math.max(limits.floor, Math.min(state.ratio * STEP_UP, cap));
    if (next <= state.ratio) return state;
    return { ...state, ratio: next, changedAt: now };
  }

  return state;
}
