// The harness's own arithmetic. This exists because two of its bugs were the
// kind an eyeball cannot catch on a table of numbers — it reported the
// FASTEST of two passes while its comment claimed the median, and its
// determinism verdict could FAIL a run in which every segment passed. A
// harness nothing tests is a harness that gets believed anyway.

import { describe, expect, it } from "vitest";
import {
  SPIKE_EARLY_FRACTION,
  SPIKE_FACTOR,
  SPIKE_LIST_MAX,
  TOLERANCE,
  determinism,
  pickMedianPass,
  ratioHonoured,
  summariseSpikes,
} from "./run.mjs";

/** One segment's row as a pass produces it. */
const row = (p50, gpuP50, extra = {}) => ({
  p50,
  p95: p50 * 1.5,
  p99: p50 * 2,
  worst: p50 * 4,
  gpuP50,
  gpuP95: gpuP50 * 1.4,
  gpuWorst: gpuP50 * 3,
  drawCalls: 107,
  ...extra,
});

describe("pickMedianPass", () => {
  it("does not report the luckiest pass of two", () => {
    // The shipped `floor((n - 1) / 2)` returned index 0 of the sorted list —
    // the fastest — and every README recipe used --runs 2.
    const picked = pickMedianPass([row(8, 7), row(9, 11)]);
    expect(picked.gpuP50).toBe(11);
  });

  it("takes the true middle of an odd number of passes", () => {
    const picked = pickMedianPass([row(8, 12), row(9, 7), row(10, 9)]);
    expect(picked.gpuP50).toBe(9);
  });

  it("ranks by GPU cost, not by wall clock", () => {
    // The pass with the median WALL p50 is not the pass with the median GPU
    // p50 here, and the GPU column is the one every claim rests on.
    const picked = pickMedianPass([row(5, 20), row(9, 8), row(20, 14)]);
    expect(picked.gpuP50).toBe(14);
    expect(picked.p50).toBe(20);
  });

  it("returns a whole real pass, never a mix of columns", () => {
    // A row assembled column-by-column can publish gpuP95 < gpuP50, or a
    // `worst` from one pass beside draw calls from another.
    const passes = [row(8, 7), row(9, 11), row(10, 9)];
    const picked = pickMedianPass(passes);
    expect(passes).toContain(picked);
    expect(picked.gpuP95).toBeGreaterThanOrEqual(picked.gpuP50);
    expect(picked.worst).toBeGreaterThanOrEqual(picked.p99);
  });

  it("falls back to wall clock on a driver with no timer query", () => {
    const passes = [row(8, undefined), row(20, undefined), row(9, undefined)];
    expect(pickMedianPass(passes).p50).toBe(9);
  });
});

/** Build the shape `determinism()` consumes: N passes of the whole path. */
const passes = (perSegmentGpu) =>
  perSegmentGpu[0].map((_, pass) => ({
    segments: perSegmentGpu.map((gpus) => row(8, gpus[pass])),
  }));

describe("determinism", () => {
  it("says nothing at all with a single pass", () => {
    expect(determinism([{ segments: [row(8, 7)] }])).toBeNull();
  });

  it("passes when every pinned segment is inside the band", () => {
    // core / plaza / sky are the pinned three; canyon and storm follow.
    const d = determinism(
      passes([
        [7.5, 7.6, 7.55],
        [6.9, 6.95, 6.9],
        [7.2, 7.25, 7.2],
        [9.9, 14.0, 10.2],
        [6.6, 6.75, 6.6],
      ]),
    );
    expect(d.pass).toBe(true);
    expect(d.assertedOver).toEqual(["core", "plaza", "sky"]);
    expect(d.notAsserted).toEqual(["canyon", "storm"]);
  });

  it("does not FAIL a run in which every segment passed", () => {
    // The regression: max-of-pct and max-of-ms taken independently, then
    // OR-ed. Segment A spreads 20 % but only 0.9 ms; segment B spreads
    // 5.0 ms but only 9 %. Each satisfies "10 % or 1 ms" on its own, and the
    // aggregate used to read 20 % AND 5 ms and call the run non-deterministic.
    const d = determinism(
      passes([
        [4.5, 5.4, 4.5], // 20 %, 0.9 ms  → inside on the ms half
        [55.0, 60.0, 55.0], // 9.1 %, 5.0 ms → inside on the pct half
        [7.2, 7.25, 7.2],
        [9.9, 14.0, 10.2],
        [6.6, 6.75, 6.6],
      ]),
    );
    expect(d.perSegment[0].gpuP50SpreadPct).toBeCloseTo(20, 5);
    expect(d.perSegment[0].gpuP50SpreadMs).toBeCloseTo(0.9, 5);
    expect(d.perSegment[1].gpuP50SpreadMs).toBeCloseTo(5.0, 5);
    expect(d.pass).toBe(true);
  });

  it("still FAILS a segment that is outside BOTH halves of the band", () => {
    const d = determinism(
      passes([
        [7.5, 20.0, 7.5], // 167 %, 12.5 ms — outside on both
        [6.9, 6.95, 6.9],
        [7.2, 7.25, 7.2],
        [9.9, 14.0, 10.2],
        [6.6, 6.75, 6.6],
      ]),
    );
    expect(d.pass).toBe(false);
  });

  it("refuses to pass on a MISSING measurement", () => {
    // No timer-query extension gives a column of zeros. Zero spread is not
    // agreement, it is the absence of evidence.
    const d = determinism(
      passes([
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ]),
    );
    expect(d.pass).toBe(false);
    expect(d.worstGpuP50SpreadPct).toBe(0);
    expect(Number.isFinite(d.worstGpuP50SpreadPct)).toBe(true);
  });

  it("holds draw calls to identity everywhere except the storm", () => {
    const runs = passes([
      [7.5, 7.6, 7.55],
      [6.9, 6.95, 6.9],
      [7.2, 7.25, 7.2],
      [9.9, 14.0, 10.2],
      [6.6, 6.75, 6.6],
    ]);
    // The storm's strike CELL moves with absolute time, so its draw count may.
    runs[1].segments[4].drawCalls = 109;
    expect(determinism(runs).drawCallsAgreeEverywhere).toBe(true);
    // Canyon is unpinned for TIMING but still submits the same draws.
    runs[1].segments[3].drawCalls = 109;
    expect(determinism(runs).drawCallsAgreeEverywhere).toBe(false);
  });

  it("publishes the tolerance it judged against", () => {
    const d = determinism(
      passes([
        [7.5, 7.6, 7.55],
        [6.9, 6.95, 6.9],
        [7.2, 7.25, 7.2],
        [9.9, 14.0, 10.2],
        [6.6, 6.75, 6.6],
      ]),
    );
    expect(d.tolerance).toEqual(TOLERANCE);
  });
});

/** A window of `n` clean frames at `ms`, with spikes spliced in by index. */
const window_ = (n, ms, spikes = {}) =>
  Array.from({ length: n }, (_, i) => spikes[i] ?? ms);

describe("summariseSpikes", () => {
  it("finds nothing in a window with no spike in it", () => {
    // p95/p99 sit near 1.6-1.8x p50 in this scene; the factor has to clear
    // that shoulder or every report claims hundreds of spikes.
    const k = summariseSpikes(window_(600, 8, { 5: 14, 300: 13.5 }), 8);
    expect(k.count).toBe(0);
    expect(k.at).toEqual([]);
    expect(k.worst).toBe(14);
  });

  it("counts only frames past the factor", () => {
    const p50 = 8;
    const k = summariseSpikes(
      window_(600, p50, {
        100: p50 * SPIKE_FACTOR + 0.1,
        200: p50 * SPIKE_FACTOR - 0.1,
      }),
      p50,
    );
    expect(k.count).toBe(1);
    expect(k.threshold).toBe(p50 * SPIKE_FACTOR);
  });

  it("places a spike by ELAPSED TIME, not by frame index", () => {
    // The distinction is the point: a window whose first half was cheap and
    // second half expensive puts its midpoint frame nowhere near 50 %.
    const samples = [...window_(10, 1), ...window_(10, 9), 100];
    const k = summariseSpikes(samples, 1);
    const spike = k.at.at(-1);
    expect(spike.frame).toBe(20);
    // 10 + 90 = 100 ms elapsed before it, out of 200 ms of window.
    expect(spike.at).toBeCloseTo(0.5, 3);
    expect(k.worstAt).toBeCloseTo(0.5, 3);
  });

  it("separates first-sight cost from something spread through the window", () => {
    const p50 = 8;
    // Compilation / upload: everything in the opening tenth.
    const early = summariseSpikes(
      window_(600, p50, { 1: 120, 3: 90, 7: 60 }),
      p50,
    );
    expect(early.count).toBe(3);
    expect(early.early).toBe(3);
    // Something per-frame: the same three spikes, spread out.
    const spread = summariseSpikes(
      window_(600, p50, { 100: 120, 300: 90, 500: 60 }),
      p50,
    );
    expect(spread.count).toBe(3);
    expect(spread.early).toBe(0);
    expect(SPIKE_EARLY_FRACTION).toBeLessThan(0.5);
  });

  it("prices the tail against the whole window, not against p50", () => {
    // The number that keeps `worst` in proportion: one 150 ms frame in a 5 s
    // window is 142 ms of a 5000 ms window, i.e. under 3 %.
    const p50 = 8;
    const k = summariseSpikes(window_(600, p50, { 300: 150 }), p50);
    expect(k.costMs).toBeCloseTo(142, 5);
    expect(k.costMs / k.windowMs).toBeLessThan(0.05);
  });

  it("keeps an exact count while capping the itemised list", () => {
    const p50 = 8;
    const spikes = {};
    for (let i = 0; i < SPIKE_LIST_MAX + 5; i++) spikes[i * 10] = 100;
    const k = summariseSpikes(window_(600, p50, spikes), p50);
    expect(k.count).toBe(SPIKE_LIST_MAX + 5);
    expect(k.at).toHaveLength(SPIKE_LIST_MAX);
    expect(k.truncated).toBe(true);
  });

  it("reports zeros rather than NaN on a window that was never measured", () => {
    const k = summariseSpikes([], 0);
    expect(k).toMatchObject({ count: 0, frames: 0, windowMs: 0, worst: 0 });
    expect(Number.isNaN(k.worstAt)).toBe(false);
  });

  it("never calls a whole window one long spike when p50 is zero", () => {
    // p50 0 means the meter was empty, not that every frame beat the
    // threshold of 0 ms.
    expect(summariseSpikes([16, 16, 16], 0).count).toBe(0);
  });

  it("says nothing at all about a client with no GPU timer running", () => {
    // Without ?gputime=1 the hook answers null and the harness passes [],
    // and an empty GPU row must read as "not measured" — never as the
    // "no spike on the GPU clock" that would acquit the GPU.
    const k = summariseSpikes([], 0);
    expect(k.frames).toBe(0);
    expect(k.count).toBe(0);
  });
});

describe("summariseSpikes on the two clocks — the diagnosis", () => {
  // The pair is the instrument. Neither window alone names the culprit;
  // the harness prints both rows for exactly this reason.
  const CLEAN = 8;

  it("puts a JS pause in the wall window and NOT the GPU window", () => {
    // A GC or a long script blocks this thread while the GPU sits idle, so
    // the wall frame is enormous and every GPU frame is ordinary.
    const wall = summariseSpikes(window_(600, CLEAN, { 300: 120 }), CLEAN);
    const gpu = summariseSpikes(window_(598, 7), 7);
    expect(wall.count).toBe(1);
    expect(gpu.count).toBe(0);
  });

  it("puts a real GPU stall in BOTH windows", () => {
    // A driver or compositor stall is charged to the GPU clock too, and no
    // JavaScript change can move it.
    const wall = summariseSpikes(window_(600, CLEAN, { 300: 120 }), CLEAN);
    const gpu = summariseSpikes(window_(598, 7, { 299: 117 }), 7);
    expect(wall.count).toBe(1);
    expect(gpu.count).toBe(1);
    expect(gpu.worst).toBeCloseTo(117, 5);
  });

  it("compares the windows by POSITION, never sample by sample", () => {
    // A timer query resolves a frame or two after the frame it measured and
    // a starved frame never resolves at all, so the two windows hold
    // different counts. A spike at the same FRACTION is the same event.
    const wall = summariseSpikes(window_(600, CLEAN, { 300: 120 }), CLEAN);
    const gpu = summariseSpikes(window_(594, 7, { 297: 117 }), 7);
    expect(gpu.frames).not.toBe(wall.frames);
    expect(Math.abs(gpu.worstAt - wall.worstAt)).toBeLessThan(0.02);
  });
});

describe("ratioHonoured", () => {
  it("is true when the client drew at the ratio the URL asked for", () => {
    expect(ratioHonoured({ requestedPixelRatio: "2", pixelRatio: 2 })).toBe(
      true,
    );
  });

  it("is FALSE when the panel clamped it — the run measured other pixels", () => {
    // `--res 2` on a 1x display: the client honours the panel, so the
    // harness measured half the linear resolution the label claims.
    expect(ratioHonoured({ requestedPixelRatio: "2", pixelRatio: 1 })).toBe(
      false,
    );
  });

  it("does not accuse the scaler of disobeying an instruction to be free", () => {
    expect(
      ratioHonoured({ requestedPixelRatio: "auto", pixelRatio: 1.68 }),
    ).toBe(true);
    expect(ratioHonoured({ requestedPixelRatio: null, pixelRatio: 2 })).toBe(
      true,
    );
  });

  it("treats junk as the fallback it is, not as a mismatch", () => {
    // readRenderOptions ignores an unparseable ?res= and leaves the scaler on.
    expect(
      ratioHonoured({ requestedPixelRatio: "banana", pixelRatio: 1.5 }),
    ).toBe(true);
  });

  it("does not trip on float noise", () => {
    expect(
      ratioHonoured({ requestedPixelRatio: "1.5", pixelRatio: 0.5 + 1.0 }),
    ).toBe(true);
  });
});
