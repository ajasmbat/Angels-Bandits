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
 * Once a ratio has missed the budget we never climb straight back to it —
 * only to this fraction of it. The latch is what stops the controller
 * pumping between a ratio that works and one that does not.
 *
 * 0.9, not something closer to 1, because of what the browser QA showed
 * (tools/perf/scaler.mjs): at 0.97 the climb lands 3 % under a ratio we
 * already know misses, misses again, backs off 5 %, and repeats — a slow
 * 2-5 % pump that had not settled after 30 s.
 *
 * NOTE the trap this margin sets, which shipped as a bug and is the reason
 * `stepResolution` is shaped the way it is: a retreat that LANDS above
 * `hotRatio * HOT_MARGIN` can never climb again, because the up-branch
 * refuses any step that would not raise the ratio. `STEP_DOWN_FINE` (0.95)
 * is shallower than this margin, so every fine backoff lands above its own
 * cap. That froze the controller permanently — a 3 s hitch at boot pinned
 * the session at 1.46 and 83 simulated minutes of flawless frames never
 * recovered it. Headroom-for-recovery and room-to-pump are the same
 * quantity, so it cannot be fixed by widening the gap between the steps.
 * Recovery comes from RELAXING the latch on evidence instead — see
 * RELAX_AFTER_MS.
 */
export const HOT_MARGIN = 0.9;

/**
 * How long every frame must stay clean before the latch is relaxed one
 * notch (`hotRatio /= HOT_MARGIN`), letting the controller win resolution
 * back that a transient cost it.
 *
 * This is the "forget timer" the first cut of this module deliberately did
 * not have, and the objection it was left out for was FREQUENCY: re-climbing
 * 10 % of pixel ratio every time the view opens up trades a fixed, quiet
 * image for a twitchy one. A minute of UNBROKEN clean frames is not that —
 * it is a different machine state — and without it any transient hitch is a
 * permanent penalty for the rest of the session.
 *
 * The interval DOUBLES at every relaxation, capped at RELAX_MAX_MS, which is
 * what keeps this from becoming the pump it replaced. If the machine really
 * did get faster the ratio reaches the ceiling in three or four relaxations
 * and the latch stops binding entirely; if it did not, the probes fail and
 * get geometrically rarer (1 → 2 → 4 → 8 min) until they are invisible.
 * So the anti-pump guarantee is now: at most one +6 % probe per interval,
 * and the interval never shrinks.
 */
export const RELAX_AFTER_MS = 60_000;
/** Ceiling on the relax interval — past here, probing has effectively stopped. */
export const RELAX_MAX_MS = 480_000;

export interface ResolutionState {
  /** Device-pixel ratio to draw at. */
  ratio: number;
  /** Clock reading (ms) of the last accepted change — the rate limit. */
  changedAt: number;
  /**
   * Lowest ratio we have ever RETREATED from; Infinity until we retreat
   * once, and Infinity again once relaxation lifts it clear of the ceiling.
   * It caps every later climb — that is the convergence argument.
   */
  hotRatio: number;
  /**
   * Clock reading of the first tick of the current UNBROKEN clean run, or
   * null when the last window was not clean. A single missed window sends
   * this back to null, so the relax timer measures sustained health rather
   * than an average.
   */
  cleanSince: number | null;
  /** Clean time required before the next relaxation; doubles at each one. */
  relaxAfterMs: number;
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
    cleanSince: null,
    relaxAfterMs: RELAX_AFTER_MS,
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
 * One controller tick.
 *
 * Compare `ratio` — NOT object identity — to decide whether to resize the
 * renderer. The state also carries clean-run bookkeeping for the relax
 * timer, which advances on ticks that do not move the ratio at all; a caller
 * that treated every new object as a resize would reset its frame window
 * every tick and starve the controller of a full window forever.
 *
 * Four outcomes, and only ever one per call:
 *  - misses at or over MISS_SHARE  → step down (and latch `hotRatio`)
 *  - a clean window, latch due     → relax the latch one notch
 *  - a clean window, latch not due → step up, capped by the latch
 *  - anything between              → hold; this band is the hysteresis
 *
 * The down and clean triggers are mutually exclusive by construction (a
 * window cannot both contain >=10 % misses and zero misses), so no single
 * window can ever argue for both directions.
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
    // Any miss ends the clean run outright — the relax timer measures
    // sustained health, so it restarts rather than accumulating.
    const broken =
      state.cleanSince === null ? state : { ...state, cleanSince: null };
    if (now - state.changedAt < DOWN_COOLDOWN_MS) return broken;
    const step =
      state.hotRatio === Number.POSITIVE_INFINITY ? STEP_DOWN : STEP_DOWN_FINE;
    const next = clampRatio(state.ratio * step, limits);
    if (next >= state.ratio) return broken;
    // `hotRatio` names a ratio we RETREATED from, and it is only meaningful
    // while the cap it implies is still reachable. Latching a ratio whose
    // cap falls under the floor would pin the game at the floor with no rung
    // above it — which is exactly what the step that LANDS on the floor used
    // to do, one step before the guard that was written to prevent it.
    const latchable = state.ratio * HOT_MARGIN >= limits.floor;
    return {
      ...broken,
      ratio: next,
      changedAt: now,
      hotRatio: latchable
        ? Math.min(state.hotRatio, state.ratio)
        : state.hotRatio,
    };
  }

  if (share === 0) {
    const cleanSince = state.cleanSince ?? now;
    const base = state.cleanSince === null ? { ...state, cleanSince } : state;

    // Relaxation comes FIRST: while the latch binds, the climb below is
    // capped by it, and a frozen controller (ratio already at its cap) has
    // no other way out. Only relevant while there is a latch to relax.
    if (
      state.hotRatio !== Number.POSITIVE_INFINITY &&
      now - cleanSince >= state.relaxAfterMs
    ) {
      const relaxed = state.hotRatio / HOT_MARGIN;
      // Once the relaxed cap clears the ceiling the latch no longer binds
      // anything: drop it, and let the interval start over from scratch.
      const cleared = relaxed * HOT_MARGIN >= limits.ceiling;
      return {
        ...base,
        hotRatio: cleared ? Number.POSITIVE_INFINITY : relaxed,
        cleanSince: now,
        relaxAfterMs: cleared
          ? RELAX_AFTER_MS
          : Math.min(state.relaxAfterMs * 2, RELAX_MAX_MS),
      };
    }

    if (now - state.changedAt < UP_COOLDOWN_MS) return base;
    const cap = Math.min(limits.ceiling, state.hotRatio * HOT_MARGIN);
    const next = Math.max(limits.floor, Math.min(state.ratio * STEP_UP, cap));
    if (next <= state.ratio) return base;
    return { ...base, ratio: next, changedAt: now };
  }

  // The hysteresis band. Not clean, so the relax timer restarts; not bad
  // enough to be evidence for backing off.
  return state.cleanSince === null ? state : { ...state, cleanSince: null };
}
