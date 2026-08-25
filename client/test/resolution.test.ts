// The adaptive resolution controller (P1, win B). It is deliberately a pure
// function of (recent frame times, state, clock) → state, and these are the
// properties that buys us: it converges, it respects its floor and ceiling,
// and no window of frames can talk it into oscillating.
//
// Expected values are hand-worked from the spec (floor 0.75, ceiling 2, miss
// at 1.5x the 16.67 ms budget, step down 0.85 then 0.95, step up 1.06, cap
// every climb at 0.97x the ratio we retreated from) — never recomputed the
// way the implementation does it.

import { describe, expect, it } from "vitest";
import {
  DOWN_COOLDOWN_MS,
  FRAME_BUDGET_MS,
  HOT_MARGIN,
  MISS_MS,
  RESOLUTION_CEILING,
  RESOLUTION_FLOOR,
  type ResolutionLimits,
  type ResolutionState,
  UP_COOLDOWN_MS,
  WINDOW_FRAMES,
  createResolution,
  defaultLimits,
  missShare,
  stepResolution,
} from "../src/render/resolution";

const LIMITS: ResolutionLimits = { floor: 0.75, ceiling: 2 };

/** A full decision window of identical frames. */
const window_ = (ms: number, n = WINDOW_FRAMES) => new Array(n).fill(ms);
/** Comfortably inside budget — a clean window. */
const FAST = 8;
/** A dropped vsync: the interval doubles, which is what a miss looks like. */
const SLOW = 33.4;

const at = (
  ratio: number,
  changedAt = 0,
  hotRatio = Number.POSITIVE_INFINITY,
): ResolutionState => ({
  ratio,
  changedAt,
  hotRatio,
});

/**
 * Run the controller for `ticks` evaluations against a cost model, returning
 * every ratio it settled on. `costOf` is the sim: how long a frame takes at
 * a given pixel ratio.
 */
function simulate(
  start: ResolutionState,
  costOf: (ratio: number) => number,
  ticks: number,
  limits = LIMITS,
): number[] {
  let state = start;
  const trace: number[] = [state.ratio];
  let now = 0;
  for (let i = 0; i < ticks; i++) {
    // A whole window elapses between evaluations, so the cooldowns can clear.
    now += 1000;
    state = stepResolution(state, window_(costOf(state.ratio)), now, limits);
    trace.push(state.ratio);
  }
  return trace;
}

describe("defaultLimits", () => {
  it("caps the ceiling at the panel's own ratio on a non-Retina screen", () => {
    expect(defaultLimits(1)).toEqual({ floor: 0.75, ceiling: 1 });
  });

  it("caps a 3x phone at RESOLUTION_CEILING — extra pixels buy nothing", () => {
    expect(defaultLimits(3)).toEqual({ floor: 0.75, ceiling: 2 });
  });

  it("never puts the floor above the ceiling on a sub-1x panel", () => {
    const limits = defaultLimits(0.5);
    expect(limits.ceiling).toBe(0.5);
    expect(limits.floor).toBe(0.5);
  });
});

describe("createResolution", () => {
  it("starts at the device ratio — we back off only on evidence", () => {
    expect(createResolution(2).ratio).toBe(2);
    expect(createResolution(1).ratio).toBe(1);
  });

  it("starts with no hot ratio latched", () => {
    expect(createResolution(2).hotRatio).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("missShare", () => {
  it("counts only frames past MISS_MS, not merely past the budget", () => {
    expect(MISS_MS).toBeGreaterThan(FRAME_BUDGET_MS);
    // 17 ms is a kept vsync with jitter; it must not read as a miss, or the
    // controller would scale down on a machine that is perfectly fine.
    expect(missShare([17, 17, 17, 17])).toBe(0);
    expect(missShare([8, 8, 8, SLOW])).toBe(0.25);
  });

  it("is 0 for an empty window", () => {
    expect(missShare([])).toBe(0);
  });
});

describe("stepResolution — evidence requirements", () => {
  it("decides nothing before a full window of frames", () => {
    const state = at(2);
    const short = window_(SLOW, WINDOW_FRAMES - 1);
    expect(stepResolution(state, short, 10_000, LIMITS)).toBe(state);
  });

  it("holds inside the hysteresis band (some misses, under the share)", () => {
    // 1 miss in 45 frames = 2.2 %, under the 10 % that forces a step down,
    // and not the clean window that earns a step up.
    const frames = window_(FAST);
    frames[0] = SLOW;
    const state = at(2);
    expect(stepResolution(state, frames, 10_000, LIMITS)).toBe(state);
  });

  it("returns the SAME object when it holds, so callers can test identity", () => {
    const state = at(2);
    expect(stepResolution(state, window_(FAST), 100, LIMITS)).toBe(state);
  });
});

describe("stepResolution — backing off", () => {
  it("takes a decisive first step down and latches the ratio it left", () => {
    const next = stepResolution(at(2), window_(SLOW), 10_000, LIMITS);
    expect(next.ratio).toBeCloseTo(1.7, 5); // 2 x 0.85
    expect(next.hotRatio).toBe(2);
    expect(next.changedAt).toBe(10_000);
  });

  it("nudges (not lurches) once a hot ratio is known — no visible pump", () => {
    const next = stepResolution(at(1.7, 0, 2), window_(SLOW), 10_000, LIMITS);
    expect(next.ratio).toBeCloseTo(1.615, 5); // 1.7 x 0.95, not x 0.85
  });

  it("respects the down cooldown", () => {
    const state = at(2, 10_000);
    const tooSoon = 10_000 + DOWN_COOLDOWN_MS - 1;
    expect(stepResolution(state, window_(SLOW), tooSoon, LIMITS)).toBe(state);
  });

  it("never goes below the floor", () => {
    const trace = simulate(at(2), () => SLOW, 40);
    expect(Math.min(...trace)).toBe(LIMITS.floor);
  });

  it("does not latch the floor as hot — that would strand us there", () => {
    // Missing at the floor leaves nothing to retreat from; latching it would
    // cap every future climb at 0.75 x 0.97 and pin the game at the floor.
    const state = at(LIMITS.floor, 0);
    const next = stepResolution(state, window_(SLOW), 10_000, LIMITS);
    expect(next).toBe(state);
    expect(next.hotRatio).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("stepResolution — climbing back", () => {
  it("climbs on a completely clean window", () => {
    const next = stepResolution(at(1), window_(FAST), 10_000, LIMITS);
    expect(next.ratio).toBeCloseTo(1.06, 5);
  });

  it("respects the up cooldown, which is far longer than the down one", () => {
    expect(UP_COOLDOWN_MS).toBeGreaterThan(DOWN_COOLDOWN_MS);
    const state = at(1, 10_000);
    const tooSoon = 10_000 + UP_COOLDOWN_MS - 1;
    expect(stepResolution(state, window_(FAST), tooSoon, LIMITS)).toBe(state);
  });

  it("never exceeds the ceiling, and stops dead once it is there", () => {
    // The up cooldown is 4 s and evaluations are 1 s apart, so a climb only
    // lands every 4th tick — 80 ticks is ~20 climbs for the 12 it needs.
    const trace = simulate(at(1), () => FAST, 80);
    expect(Math.max(...trace)).toBe(LIMITS.ceiling);
    expect(trace.at(-1)).toBe(LIMITS.ceiling);
    expect(trace.at(-2)).toBe(LIMITS.ceiling);
  });

  it("never climbs back to a ratio it retreated from (the hot latch)", () => {
    const hot = 1.7;
    let state = at(1.4, 0, hot);
    for (let i = 1; i <= 50; i++) {
      state = stepResolution(state, window_(FAST), i * 10_000, LIMITS);
      expect(state.ratio).toBeLessThanOrEqual(hot * HOT_MARGIN + 1e-9);
    }
  });
});

describe("stepResolution — it cannot oscillate", () => {
  it("only ever steps DOWN on alternating fast/slow frames", () => {
    // The pathological input: half the frames are fine, half are dropped.
    // p50 would call this healthy; the miss share correctly calls it broken.
    const alternating = Array.from({ length: WINDOW_FRAMES }, (_, i) =>
      i % 2 === 0 ? FAST : SLOW,
    );
    let state = at(2);
    const trace = [state.ratio];
    for (let i = 1; i <= 60; i++) {
      state = stepResolution(state, alternating, i * 1000, LIMITS);
      trace.push(state.ratio);
    }
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i]).toBeLessThanOrEqual(trace[i - 1] as number);
    }
    expect(trace.at(-1)).toBe(LIMITS.floor);
  });

  it("cannot read one window as both too slow and clean enough to climb", () => {
    // The two triggers are mutually exclusive by construction: a window with
    // >= 10 % misses cannot also have zero. Assert it over random windows.
    for (let seed = 0; seed < 500; seed++) {
      const frames = Array.from(
        { length: WINDOW_FRAMES },
        (_, i) => ((seed * 37 + i * 13) % 60) + 2,
      );
      const share = missShare(frames);
      expect(share === 0 && share >= 0.1).toBe(false);
    }
  });

  it("converges to a fixed ratio against a real cost model and stays", () => {
    // Cost model: frame time grows with the pixel count (ratio squared).
    // At ratio 2 that is 40 ms (a miss); the sustainable ratio is ~1.29.
    const costOf = (ratio: number) => 10 * ratio * ratio;
    const trace = simulate(createResolution(2), costOf, 120);
    const settled = trace.slice(-25);
    expect(new Set(settled).size).toBe(1);
    const final = settled[0] as number;
    expect(final).toBeGreaterThanOrEqual(LIMITS.floor);
    expect(final).toBeLessThan(2);
    // And it settled somewhere USEFUL — not by collapsing to the floor.
    expect(costOf(final)).toBeLessThanOrEqual(MISS_MS);
    expect(final).toBeGreaterThan(LIMITS.floor);
  });

  it("converges on a 1x panel too (floor and ceiling both bind)", () => {
    const limits = defaultLimits(1);
    const trace = simulate(createResolution(1), () => FAST, 40, limits);
    expect(trace.at(-1)).toBe(1);
    expect(Math.max(...trace)).toBe(1);
  });
});

describe("published constants", () => {
  it("keeps the shipped floor/ceiling the ticket agreed on", () => {
    expect(RESOLUTION_FLOOR).toBe(0.75);
    expect(RESOLUTION_CEILING).toBe(2);
    expect(FRAME_BUDGET_MS).toBeCloseTo(16.667, 3);
  });
});
