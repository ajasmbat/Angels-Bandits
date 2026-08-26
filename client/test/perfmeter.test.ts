// The frame meter (P1): the one source of every perf number this project
// reports. If it lies, the harness lies, the HUD lies, and the resolution
// controller acts on a lie — so the percentile arithmetic is pinned here
// against hand-worked expectations, not against a second implementation.

import { describe, expect, it } from "vitest";
import { FrameMeter, percentile } from "../src/render/perfmeter";

/** 1..100 ascending — every percentile is readable by eye. */
const ONE_TO_100 = Array.from({ length: 100 }, (_, i) => i + 1);

describe("percentile", () => {
  it("is nearest-rank over an ascending array", () => {
    expect(percentile(ONE_TO_100, 0.5)).toBe(50);
    expect(percentile(ONE_TO_100, 0.95)).toBe(95);
    expect(percentile(ONE_TO_100, 0.99)).toBe(99);
    expect(percentile(ONE_TO_100, 1)).toBe(100);
  });

  it("clamps at both ends instead of reading off the array", () => {
    expect(percentile(ONE_TO_100, 0)).toBe(1);
    expect(percentile(ONE_TO_100, 2)).toBe(100);
    expect(percentile([7], 0.95)).toBe(7);
  });

  it("is 0 for an empty window — a fresh meter reports zeros, not NaN", () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("FrameMeter", () => {
  it("reports zeros before it has seen a frame", () => {
    expect(new FrameMeter().stats()).toEqual({
      count: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      worst: 0,
      mean: 0,
      fps: 0,
      drawCalls: 0,
      drawCallsMax: 0,
    });
  });

  it("summarises a window: percentiles, worst, mean, draw calls", () => {
    const meter = new FrameMeter();
    for (const ms of ONE_TO_100) meter.push(ms, 200);
    const s = meter.stats();
    expect(s.count).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.worst).toBe(100);
    expect(s.mean).toBeCloseTo(50.5, 6);
    expect(s.drawCalls).toBe(200);
    expect(s.drawCallsMax).toBe(200);
  });

  it("derives fps from p50, never from the mean", () => {
    // 99 clean 60 fps frames and one 1 s catastrophe. The mean frame is
    // 26.5 ms — "38 fps", which describes no frame that actually happened.
    // p50 says 60 and the worst frame carries the disaster; that split IS
    // the ticket's framing (never report mean fps).
    const meter = new FrameMeter();
    for (let i = 0; i < 99; i++) meter.push(1000 / 60, 10);
    meter.push(1000, 10);
    const s = meter.stats();
    expect(s.fps).toBeCloseTo(60, 6);
    expect(s.worst).toBe(1000);
    expect(1000 / s.mean).toBeCloseTo(37.7, 1); // what a mean would claim
  });

  it("keeps only the newest `capacity` frames", () => {
    const meter = new FrameMeter(4);
    for (const ms of [100, 100, 100, 100, 5, 6, 7, 8]) meter.push(ms, 1);
    expect(meter.count).toBe(4);
    expect(meter.stats().worst).toBe(8);
    expect([...meter.tail(4)]).toEqual([5, 6, 7, 8]);
  });

  it("tails the newest frames, oldest first, across the ring wrap", () => {
    const meter = new FrameMeter(4);
    for (const ms of [1, 2, 3, 4, 5]) meter.push(ms, 1); // wraps once
    expect([...meter.tail(3)]).toEqual([3, 4, 5]);
    expect([...meter.tail(99)]).toEqual([2, 3, 4, 5]);
  });

  it("tails what it has when asked for more than it holds", () => {
    const meter = new FrameMeter(10);
    meter.push(9, 1);
    expect([...meter.tail(45)]).toEqual([9]);
  });

  it("reset drops the window (the harness's segment boundary)", () => {
    const meter = new FrameMeter();
    for (const ms of ONE_TO_100) meter.push(ms, 5);
    meter.reset();
    expect(meter.count).toBe(0);
    expect(meter.stats().p50).toBe(0);
    meter.push(3, 5);
    expect(meter.stats()).toMatchObject({ count: 1, p50: 3, worst: 3 });
  });

  it("takes the median AND the max of draw calls", () => {
    const meter = new FrameMeter();
    for (const calls of [100, 100, 100, 100, 900]) meter.push(16, calls);
    const s = meter.stats();
    expect(s.drawCalls).toBe(100);
    expect(s.drawCallsMax).toBe(900);
  });

  it("samples() returns every held frame, oldest first", () => {
    const meter = new FrameMeter(3);
    for (const ms of [1, 2, 3, 4]) meter.push(ms, 1);
    expect(meter.samples()).toEqual([2, 3, 4]);
  });
});
