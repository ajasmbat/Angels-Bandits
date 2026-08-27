// The harness's own arithmetic. This exists because two of its bugs were the
// kind an eyeball cannot catch on a table of numbers — it reported the
// FASTEST of two passes while its comment claimed the median, and its
// determinism verdict could FAIL a run in which every segment passed. A
// harness nothing tests is a harness that gets believed anyway.

import { describe, expect, it } from "vitest";
import { TOLERANCE, determinism, pickMedianPass } from "./run.mjs";

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
