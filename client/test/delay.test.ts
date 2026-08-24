// The stateful half of the adaptive interpolation buffer (ANGE-4KO2W2). The
// math is proved in common/test/net.test.ts; what is only observable here is
// the controller driven by a stream of ARRIVAL TIMES, which is what the socket
// actually feeds it.
//
// Every arrival below is a plain number, so these are the real timings a
// client would see — no clock, no socket, no fake timers.

import {
  INTERP_DELAY_MAX_MS,
  INTERP_FLOOR_MS,
  SNAPSHOT_INTERVAL_MS,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { INITIAL_INTERP_DELAY_MS, InterpDelay } from "../src/net/delay";

/** Feed `gaps` (ms between snapshot arrivals) starting from t = 1000. */
const feed = (delay: InterpDelay, gaps: readonly number[]): InterpDelay => {
  let t = 1000;
  delay.observe(t);
  for (const gap of gaps) {
    t += gap;
    delay.observe(t);
  }
  return delay;
};

const perfect = (n: number) =>
  Array.from({ length: n }, () => SNAPSHOT_INTERVAL_MS);

describe("InterpDelay", () => {
  it("starts at the floor and stays there on a perfectly steady link", () => {
    expect(new InterpDelay().delayMs).toBe(INTERP_FLOOR_MS);
    expect(INITIAL_INTERP_DELAY_MS).toBe(INTERP_FLOOR_MS);
    const d = feed(new InterpDelay(), perfect(500));
    expect(d.delayMs).toBe(INTERP_FLOOR_MS);
    expect(d.jitter).toBe(0);
  });

  it("never dips below one snapshot interval, whatever the link does", () => {
    const d = new InterpDelay();
    let t = 1000;
    d.observe(t);
    for (const gap of [50, 1, 200, 3, 50, 0.5, 400, 50, 50]) {
      t += gap;
      d.observe(t);
      expect(d.delayMs).toBeGreaterThanOrEqual(SNAPSHOT_INTERVAL_MS);
      expect(d.delayMs).toBeGreaterThanOrEqual(INTERP_FLOOR_MS);
    }
  });

  it("deepens the buffer on the FIRST late snapshot, not after remotes stutter", () => {
    const d = new InterpDelay();
    d.observe(1000);
    const before = d.delayMs;
    d.observe(1000 + SNAPSHOT_INTERVAL_MS + 35); // one snapshot 35 ms late
    expect(d.delayMs).toBeGreaterThan(before);
    expect(d.delayMs).toBeCloseTo(INTERP_FLOOR_MS + 2 * 35, 6);
  });

  it("grows faster than it shrinks: one bad snapshot, many calm ones to give it back", () => {
    const d = feed(new InterpDelay(), [SNAPSHOT_INTERVAL_MS + 40]);
    const spiked = d.delayMs;
    expect(spiked).toBeCloseTo(INTERP_FLOOR_MS + 80, 6);

    let calm = 0;
    let t = 1000 + SNAPSHOT_INTERVAL_MS + 40;
    while (d.delayMs > INTERP_FLOOR_MS + 1 && calm < 10_000) {
      t += SNAPSHOT_INTERVAL_MS;
      d.observe(t);
      calm++;
    }
    // One snapshot up; seconds of a clean link back down.
    expect(calm).toBeGreaterThan(100);
    expect((calm * SNAPSHOT_INTERVAL_MS) / 1000).toBeGreaterThan(5);
  });

  it("holds a steady buffer on sustained jitter instead of chasing every gap", () => {
    // A wobbling link: gaps swing ±20 ms around nominal, every snapshot.
    const gaps: number[] = [];
    for (let i = 0; i < 300; i++) {
      gaps.push(SNAPSHOT_INTERVAL_MS + (i % 2 === 0 ? 20 : -20));
    }
    const d = new InterpDelay();
    let t = 1000;
    d.observe(t);
    const seen: number[] = [];
    for (const gap of gaps) {
      t += gap;
      d.observe(t);
      seen.push(d.delayMs);
    }
    const tail = seen.slice(150);
    expect(Math.max(...tail)).toBeCloseTo(INTERP_FLOOR_MS + 40, 6);
    // Bounded ripple, not a swing: under 1% of the buffer it is holding.
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(
      0.01 * Math.min(...tail),
    );
  });

  it("caps out on a hopeless link rather than buffering without limit", () => {
    const d = feed(new InterpDelay(), [5000]); // a five-second stall
    expect(d.delayMs).toBe(INTERP_DELAY_MAX_MS);
  });

  it("ignores the first arrival and a non-monotonic clock reading", () => {
    const d = new InterpDelay();
    d.observe(1000);
    expect(d.delayMs).toBe(INTERP_FLOOR_MS); // no gap to learn from yet
    d.observe(900); // clock went backwards: not evidence of jitter
    expect(d.delayMs).toBe(INTERP_FLOOR_MS);
  });

  it("forgets its history on reset, so a reconnect does not inherit old gaps", () => {
    const d = feed(new InterpDelay(), [SNAPSHOT_INTERVAL_MS + 60]);
    expect(d.delayMs).toBeGreaterThan(INTERP_FLOOR_MS);
    d.reset();
    expect(d.delayMs).toBe(INTERP_FLOOR_MS);
    expect(d.jitter).toBe(0);
  });

  it("beats the fixed 100 ms buffer it replaces on any link good enough to notice", () => {
    // Up to ~21 ms of jitter still lands under the old constant.
    const d = feed(new InterpDelay(), [
      SNAPSHOT_INTERVAL_MS + 6,
      SNAPSHOT_INTERVAL_MS - 4,
      ...perfect(20),
    ]);
    expect(d.delayMs).toBeLessThan(100);
  });
});
