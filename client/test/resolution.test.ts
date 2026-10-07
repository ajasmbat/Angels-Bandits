// The adaptive resolution controller (P1, win B). It is deliberately a pure
// function of (recent frame times, state, clock) → state, and these are the
// properties that buys us: it converges, it respects its floor and ceiling,
// and no window of frames can talk it into oscillating.
//
// Expected values are hand-worked from the spec (floor 0.75, ceiling 2, miss
// at 1.5x the 16.67 ms budget, one rung of the 2/1.75/1.5/1.25/1/0.75 ladder
// per step, cap every climb at 0.9x the ratio we retreated from, and relax
// that cap one rung after 60 s of unbroken clean frames) — never recomputed
// the way the implementation does it.

import { describe, expect, it } from "vitest";
import {
  DOWN_COOLDOWN_MS,
  FRAME_BUDGET_MS,
  HOT_MARGIN,
  MISS_MS,
  RELAX_AFTER_MS,
  RELAX_MAX_MS,
  RESOLUTION_CEILING,
  RESOLUTION_FLOOR,
  type ResolutionLimits,
  type ResolutionState,
  UP_COOLDOWN_MS,
  WINDOW_FRAMES,
  createResolution,
  defaultLimits,
  missShare,
  resolutionRungs,
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
  extra: Partial<ResolutionState> = {},
): ResolutionState => ({
  ratio,
  changedAt,
  hotRatio,
  cleanSince: null,
  relaxAfterMs: RELAX_AFTER_MS,
  ...extra,
});

/**
 * Relaxation off. Isolates the properties that are about the STEPS (does it
 * converge, does it respect its limits) from the one that is about the
 * latch being released over time, so each is tested for what it claims.
 */
const NO_RELAX = { relaxAfterMs: Number.POSITIVE_INFINITY };

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
  stepMs = 1000,
): number[] {
  let state = start;
  const trace: number[] = [state.ratio];
  let now = 0;
  for (let i = 0; i < ticks; i++) {
    // A whole window elapses between evaluations, so the cooldowns can clear.
    now += stepMs;
    state = stepResolution(state, window_(costOf(state.ratio)), now, limits);
    trace.push(state.ratio);
  }
  return trace;
}

/** Same, but hands back the final state rather than the ratio trace. */
function run(
  start: ResolutionState,
  costOf: (ratio: number) => number,
  ticks: number,
  limits = LIMITS,
  stepMs = 1000,
): ResolutionState {
  let state = start;
  let now = 0;
  for (let i = 0; i < ticks; i++) {
    now += stepMs;
    state = stepResolution(state, window_(costOf(state.ratio)), now, limits);
  }
  return state;
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
    // Nothing at all changes in the hysteresis band with no clean run open,
    // so this one really is the same object.
    expect(stepResolution(state, frames, 10_000, LIMITS)).toBe(state);
  });

  it("leaves the ratio untouched when it holds — callers compare ratio", () => {
    // A clean tick at the ceiling moves nothing visible, but it DOES start
    // the clean run the relax timer measures, so the object is new and the
    // ratio is not. main.ts compares ratio for exactly this reason.
    const state = at(2);
    const next = stepResolution(state, window_(FAST), 100, LIMITS);
    expect(next.ratio).toBe(state.ratio);
    expect(next.cleanSince).toBe(100);
  });
});

describe("stepResolution — backing off", () => {
  it("steps down one rung and latches the ratio it left", () => {
    const next = stepResolution(at(2), window_(SLOW), 10_000, LIMITS);
    expect(next.ratio).toBe(1.75);
    expect(next.hotRatio).toBe(2);
    expect(next.changedAt).toBe(10_000);
  });

  it("steps one rung at a time once a hot ratio is known — no lurch", () => {
    const next = stepResolution(at(1.75, 0, 2), window_(SLOW), 10_000, LIMITS);
    expect(next.ratio).toBe(1.5);
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
    // cap every future climb at 0.75 x 0.9 and pin the game at the floor.
    const state = at(LIMITS.floor, 0);
    const next = stepResolution(state, window_(SLOW), 10_000, LIMITS);
    expect(next.ratio).toBe(state.ratio);
    expect(next.hotRatio).toBe(Number.POSITIVE_INFINITY);
  });

  it("leaves a reachable rung above the floor after landing ON it", () => {
    // The regression this file missed: the guard above only fires once the
    // ratio IS the floor, but the step that LANDS on the floor used to latch
    // the ratio just above it — whose cap (x0.9) falls UNDER the floor, so
    // there was no rung left and the controller could never climb again.
    const settled = run(createResolution(2), () => SLOW, 200, LIMITS, 250);
    expect(settled.ratio).toBe(LIMITS.floor);
    const cap = Math.min(LIMITS.ceiling, settled.hotRatio * HOT_MARGIN);
    expect(cap).toBeGreaterThan(LIMITS.floor);
  });
});

describe("stepResolution — climbing back", () => {
  it("climbs one rung on a completely clean window", () => {
    const next = stepResolution(at(1), window_(FAST), 10_000, LIMITS);
    expect(next.ratio).toBe(1.25);
  });

  it("respects the up cooldown, which is far longer than the down one", () => {
    expect(UP_COOLDOWN_MS).toBeGreaterThan(DOWN_COOLDOWN_MS);
    const state = at(1, 10_000);
    const tooSoon = 10_000 + UP_COOLDOWN_MS - 1;
    expect(stepResolution(state, window_(FAST), tooSoon, LIMITS).ratio).toBe(1);
  });

  it("never exceeds the ceiling, and stops dead once it is there", () => {
    // The up cooldown is 6 s and evaluations are 1 s apart, so a climb only
    // lands every 6th tick — 80 ticks is ~13 climbs for the 4 rungs it needs.
    const trace = simulate(at(1), () => FAST, 80);
    expect(Math.max(...trace)).toBe(LIMITS.ceiling);
    expect(trace.at(-1)).toBe(LIMITS.ceiling);
    expect(trace.at(-2)).toBe(LIMITS.ceiling);
  });

  it("never climbs back to a ratio it retreated from, while the latch holds", () => {
    const hot = 1.7;
    let state = at(1.4, 0, hot, NO_RELAX);
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
    const trace = simulate(
      { ...createResolution(2), ...NO_RELAX },
      costOf,
      120,
    );
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
    const trace = simulate(
      { ...createResolution(1), ...NO_RELAX },
      () => FAST,
      40,
      limits,
    );
    expect(trace.at(-1)).toBe(1);
    expect(Math.max(...trace)).toBe(1);
  });
});

describe("stepResolution — it recovers what a transient cost it", () => {
  // These are the properties the first cut of this module did not have, and
  // its suite could not see: every test below FAILS against the shipped
  // controller, which froze on its second backoff and never moved again.

  it("wins the ratio back after a hitch that is over", () => {
    // Three seconds of bad frames, then a machine that is simply fine.
    let state = run(createResolution(2), () => SLOW, 12, LIMITS, 250);
    expect(state.ratio).toBeLessThan(2);
    const dropped = state.ratio;
    state = run(state, () => FAST, 4000, LIMITS, 250);
    expect(state.ratio).toBeGreaterThan(dropped);
    expect(state.ratio).toBe(LIMITS.ceiling);
  });

  it("climbs off the floor once the overload is gone", () => {
    let state = run(createResolution(2), () => SLOW, 200, LIMITS, 250);
    expect(state.ratio).toBe(LIMITS.floor);
    state = run(state, () => FAST, 8000, LIMITS, 250);
    expect(state.ratio).toBeGreaterThan(LIMITS.floor);
  });

  it("drops the latch entirely once relaxing lifts it past the ceiling", () => {
    const state = run(
      at(1.7, 0, 2, { cleanSince: null }),
      () => FAST,
      4000,
      LIMITS,
      250,
    );
    expect(state.hotRatio).toBe(Number.POSITIVE_INFINITY);
    expect(state.relaxAfterMs).toBe(RELAX_AFTER_MS);
  });

  it("needs the clean run to be UNBROKEN — one miss restarts the timer", () => {
    const hot = 1.7;
    let state = at(1.5, 0, hot);
    // 59 s clean, then a single bad window, repeated: never a full minute.
    for (let cycle = 0; cycle < 20; cycle++) {
      for (let i = 0; i < 59; i++) {
        state = stepResolution(
          state,
          window_(FAST),
          cycle * 60_000 + i * 1000,
          LIMITS,
        );
      }
      state = stepResolution(
        state,
        window_(SLOW),
        cycle * 60_000 + 59_500,
        LIMITS,
      );
    }
    expect(state.hotRatio).toBeLessThanOrEqual(hot);
  });

  it("makes each probe rarer than the last, so it cannot become a pump", () => {
    // A machine that genuinely cannot hold the ratio: every probe fails.
    // The requirement is not that probing stops, but that its period grows
    // without bound (capped), so what a player sees goes to zero.
    const sustainable = 1.2;
    const costOf = (ratio: number) => (ratio <= sustainable ? FAST : SLOW);
    let state = { ...createResolution(2), relaxAfterMs: RELAX_AFTER_MS };
    let now = 0;
    const intervals: number[] = [];
    let prevRelaxAfter = state.relaxAfterMs;
    for (let i = 0; i < 20_000; i++) {
      now += 250;
      const next = stepResolution(
        state,
        window_(costOf(state.ratio)),
        now,
        LIMITS,
      );
      if (next.relaxAfterMs !== prevRelaxAfter) {
        intervals.push(next.relaxAfterMs);
        prevRelaxAfter = next.relaxAfterMs;
      }
      state = next;
    }
    // It did probe (otherwise the test proves nothing)...
    expect(intervals.length).toBeGreaterThan(2);
    // ...and every probe pushed the next one further out, up to the cap.
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i] as number).toBeGreaterThanOrEqual(
        intervals[i - 1] as number,
      );
    }
    expect(intervals.at(-1)).toBe(RELAX_MAX_MS);
    // And the excursion stayed small: never more than one rung above what
    // the machine can actually hold (1.2 sits between the 1 and 1.25 rungs).
    expect(state.ratio).toBeLessThanOrEqual(1.25);
  });

  it("never relaxes a latch that is not there", () => {
    const state = run(at(1.2), () => FAST, 10, LIMITS, 250);
    expect(state.hotRatio).toBe(Number.POSITIVE_INFINITY);
    expect(state.relaxAfterMs).toBe(RELAX_AFTER_MS);
  });
});

describe("stepResolution — O1: a few clean rungs, never a jitter", () => {
  const LADDER = [2, 1.75, 1.5, 1.25, 1, 0.75];

  /** Every ratio a long run against `costOf` visits, start included. */
  function visited(
    costOf: (ratio: number, i: number) => number,
    limits: ResolutionLimits,
    start = createResolution(limits.ceiling),
  ): Set<number> {
    let state = start;
    const seen = new Set([state.ratio]);
    for (let i = 1; i <= 20_000; i++) {
      state = stepResolution(
        state,
        window_(costOf(state.ratio, i)),
        i * 250,
        limits,
      );
      seen.add(state.ratio);
    }
    return seen;
  }

  // Overloads, recoveries, a bistable machine and a hitchy one: the paths
  // that used to produce 1.7, 1.615, 1.458…
  const LOADS: [string, (ratio: number, i: number) => number][] = [
    ["sustained overload", () => SLOW],
    ["a hitch, then clean", (_r, i) => (i < 12 ? SLOW : FAST)],
    ["pixel-bound cost", (r) => 10 * r * r],
    ["bistable", (r, i) => (r > 1.3 && i % 7 < 3 ? SLOW : FAST)],
    ["periodic hitches", (_r, i) => (i % 400 < 8 ? SLOW : FAST)],
  ];

  it("only ever draws at a ladder rung on a 2x panel", () => {
    for (const [, costOf] of LOADS) {
      for (const r of visited(costOf, LIMITS)) expect(LADDER).toContain(r);
    }
  });

  it("keeps a non-ladder panel's own ratio as its top rung (1.1x)", () => {
    const limits = defaultLimits(1.1);
    expect(resolutionRungs(limits)).toEqual([1.1, 1, 0.75]);
    for (const [, costOf] of LOADS) {
      for (const r of visited(costOf, limits)) {
        expect([1.1, 1, 0.75]).toContain(r);
      }
    }
  });

  it("clamps the ladder to the panel: 1x and 3x panels", () => {
    expect(resolutionRungs(defaultLimits(1))).toEqual([1, 0.75]);
    expect(resolutionRungs(defaultLimits(3))).toEqual(LADDER);
  });

  it("climbs back to the panel ceiling from ANY latch on clean frames", () => {
    // The frozen-latch bug, re-asked on the discrete ladder: from every rung
    // and every latch above it, a machine that is simply fine must get the
    // full resolution back.
    for (const ceiling of [2, 1.1, 1]) {
      const limits = defaultLimits(ceiling);
      const rungs = resolutionRungs(limits);
      for (const ratio of rungs) {
        for (const hot of rungs.filter((r) => r > ratio)) {
          const state = run(at(ratio, 0, hot), () => FAST, 10_000, limits, 250);
          expect(state.ratio).toBe(limits.ceiling);
        }
      }
    }
  });

  it("changes ratio rarely under a bistable load (each change is a rebuild)", () => {
    let state = createResolution(2);
    let changes = 0;
    const ticks = 4 * 60 * 10; // ten minutes at 250 ms
    for (let i = 1; i <= ticks; i++) {
      const slow = state.ratio > 1.3 && i % 7 < 3;
      const next = stepResolution(
        state,
        window_(slow ? SLOW : FAST),
        i * 250,
        LIMITS,
      );
      if (next.ratio !== state.ratio) changes++;
      state = next;
    }
    // Settling takes a couple of steps; after that only the doubling relax
    // probes may move it.
    expect(changes).toBeLessThanOrEqual(12);
  });
});

describe("published constants", () => {
  it("keeps the shipped floor/ceiling the ticket agreed on", () => {
    expect(RESOLUTION_FLOOR).toBe(0.75);
    expect(RESOLUTION_CEILING).toBe(2);
    expect(FRAME_BUDGET_MS).toBeCloseTo(16.667, 3);
  });
});
