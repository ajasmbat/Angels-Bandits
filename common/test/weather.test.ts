// L4 weather cycle: the pure schedule both sides share. Spec literals from
// the ticket, independent of the implementation: clear → drizzle → downpour →
// clearing, 6–10 min phases on the synced clock, wetness lags the rain and
// dries slowly.

import {
  WEATHER_CYCLE_MS,
  WEATHER_PHASES,
  phaseWindow,
  weatherAt,
} from "@angels-bandits/common/weather";
import { describe, expect, it } from "vitest";

const MIN = 60_000;
/** A realistic synced-clock epoch (server Date.now()), plus a few cycles. */
const EPOCH = 1_791_000_000_000;
const SEEDS = [1, 42, 0xdeadbeef];
const CYCLES = 40;

const cycleStart = (k: number) =>
  (Math.floor(EPOCH / WEATHER_CYCLE_MS) + k) * WEATHER_CYCLE_MS;

describe("weatherAt", () => {
  it("is deterministic for a (seed, time) and differs between seeds", () => {
    const t = EPOCH + 1_234_567;
    expect(weatherAt(42, t)).toEqual(weatherAt(42, t));
    const lengths = (seed: number) =>
      WEATHER_PHASES.map((p) => phaseWindow(seed, t, p)[1]);
    expect(lengths(42)).not.toEqual(lengths(43));
  });

  it("runs clear → drizzle → downpour → clearing in 6–10 min phases that tile the cycle", () => {
    for (const seed of SEEDS) {
      for (let k = 0; k < CYCLES; k++) {
        const start = cycleStart(k);
        let cursor = start;
        for (const phase of WEATHER_PHASES) {
          const [a, b] = phaseWindow(seed, start, phase);
          expect(a).toBe(cursor); // no gap, no overlap
          expect(b - a).toBeGreaterThanOrEqual(6 * MIN);
          expect(b - a).toBeLessThanOrEqual(10 * MIN);
          expect(weatherAt(seed, a).phase).toBe(phase);
          expect(weatherAt(seed, b - 1).phase).toBe(phase);
          cursor = b;
        }
        expect(cursor).toBe(start + WEATHER_CYCLE_MS);
      }
    }
  });

  it("is continuous — no visible jumps across phase or cycle boundaries", () => {
    for (const seed of SEEDS) {
      const from = cycleStart(0) - 5 * MIN;
      let prev = weatherAt(seed, from);
      for (let t = from + 1000; t < cycleStart(3); t += 1000) {
        const w = weatherAt(seed, t);
        expect(Math.abs(w.rain - prev.rain)).toBeLessThan(0.02);
        expect(Math.abs(w.wetness - prev.wetness)).toBeLessThan(0.02);
        prev = w;
      }
    }
  });

  it("is dry around every cycle boundary, where the wind switches", () => {
    for (const seed of SEEDS) {
      for (let k = 1; k < CYCLES; k++) {
        for (let dt = -30_000; dt <= 30_000; dt += 5_000) {
          expect(weatherAt(seed, cycleStart(k) + dt).rain).toBe(0);
        }
      }
    }
  });

  it("wetness lags rain onset: rain is falling before the streets get wet", () => {
    for (const seed of SEEDS) {
      for (let k = 0; k < CYCLES; k++) {
        const [a] = phaseWindow(seed, cycleStart(k), "drizzle");
        const early = weatherAt(seed, a + 30_000);
        expect(early.rain).toBeGreaterThan(0.05);
        expect(early.wetness).toBeLessThan(0.02);
      }
    }
  });

  it("drying is slow: still soaked 2 min after the rain stops, damp for 5+", () => {
    for (const seed of SEEDS) {
      for (let k = 0; k < CYCLES; k++) {
        const [a, b] = phaseWindow(seed, cycleStart(k), "clearing");
        // Find the moment the rain stops in clearing.
        let stop = a;
        while (weatherAt(seed, stop).rain > 0 && stop < b) stop += 1000;
        expect(stop).toBeLessThan(b);
        expect(weatherAt(seed, stop + 2 * MIN).wetness).toBeGreaterThan(0.5);
        expect(weatherAt(seed, stop + 5 * MIN).wetness).toBeGreaterThan(0.2);
      }
    }
  });

  it("rain, haze and the lightning flash peak in the downpour", () => {
    for (const seed of SEEDS) {
      for (let k = 0; k < CYCLES; k++) {
        const mid = (p: (typeof WEATHER_PHASES)[number]) => {
          const [a, b] = phaseWindow(seed, cycleStart(k), p);
          return weatherAt(seed, (a + b) / 2);
        };
        const clear = mid("clear");
        const drizzle = mid("drizzle");
        const downpour = mid("downpour");
        expect(clear.rain).toBe(0);
        expect(drizzle.rain).toBeGreaterThan(0);
        expect(downpour.rain).toBeGreaterThan(drizzle.rain);
        expect(downpour.haze).toBeGreaterThan(drizzle.haze);
        expect(downpour.flash).toBe(1);
        expect(clear.flash).toBeLessThan(drizzle.flash);
        expect(downpour.wetness).toBeGreaterThan(0.9);
      }
    }
  });
});
