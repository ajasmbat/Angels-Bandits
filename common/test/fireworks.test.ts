// The L2 firework schedule. Same contract as the storm's strikesInWindow, so
// the same properties are pinned: a burst is a pure function of (seed, window),
// abutting windows partition the timeline exactly (that is what lets a client
// poll [lastPoll, now) every frame without repeating or dropping one), and the
// cadence stays inside the band the constants promise.
//
// The one property that is NOT the storm's: the two schedules must not rhyme.
// Both are handed the same world seed, so a verbatim copy of the storm's
// bucket hash would give bucket n the identical PRNG stream in both systems —
// same jitter fraction, every time. fireworks.ts salts its stream to break
// that, and the last test here is what would catch the salt going missing.

import { PLAZA_BLOCKS } from "@angels-bandits/common/city";
import {
  BLOCK_PITCH,
  CITY_SEED,
  FIREWORK_ALT_MAX,
  FIREWORK_ALT_MIN,
  FIREWORK_INTERVAL_MAX_MS,
  FIREWORK_INTERVAL_MIN_MS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { burstsInWindow } from "@angels-bandits/common/fireworks";
import { strikesInWindow } from "@angels-bandits/common/storm";
import { describe, expect, it } from "vitest";

/** A server-clock-sized window, never a cosy t = 0. */
const T0 = 1_787_000_000_000;
const HOUR = 3_600_000;

describe("burstsInWindow", () => {
  it("is deterministic for a (seed, window)", () => {
    const a = burstsInWindow(CITY_SEED, T0, T0 + HOUR);
    const b = burstsInWindow(CITY_SEED, T0, T0 + HOUR);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("gives a different show for a different seed", () => {
    expect(burstsInWindow(CITY_SEED + 1, T0, T0 + HOUR)).not.toEqual(
      burstsInWindow(CITY_SEED, T0, T0 + HOUR),
    );
  });

  it("returns bursts in time order", () => {
    const bursts = burstsInWindow(CITY_SEED, T0, T0 + HOUR);
    for (let i = 1; i < bursts.length; i++) {
      expect(bursts[i]?.timeMs).toBeGreaterThanOrEqual(
        bursts[i - 1]?.timeMs ?? 0,
      );
    }
  });

  it("partitions the timeline across abutting windows — no repeat, no gap", () => {
    // The invariant a per-frame poll rests on.
    const whole = burstsInWindow(CITY_SEED, T0, T0 + HOUR);
    const pieces = [];
    const step = HOUR / 37; // deliberately not a bucket multiple
    for (let t = T0; t < T0 + HOUR; t += step) {
      pieces.push(
        ...burstsInWindow(CITY_SEED, t, Math.min(t + step, T0 + HOUR)),
      );
    }
    expect(pieces).toEqual(whole);
  });

  it("keeps consecutive bursts inside the cadence band", () => {
    const bursts = burstsInWindow(CITY_SEED, T0, T0 + 6 * HOUR);
    expect(bursts.length).toBeGreaterThan(1000); // vacuity guard
    const gaps = bursts
      .slice(1)
      .map((b, i) => b.timeMs - (bursts[i]?.timeMs ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(FIREWORK_INTERVAL_MIN_MS);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(FIREWORK_INTERVAL_MAX_MS);
  });

  it("bursts over the plazas, in canonical coordinates, inside the altitude band", () => {
    const plazas = new Set(PLAZA_BLOCKS.map(([bx, bz]) => `${bx},${bz}`));
    for (const b of burstsInWindow(CITY_SEED, T0, T0 + HOUR)) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThan(WORLD_SIZE);
      expect(b.z).toBeGreaterThanOrEqual(0);
      expect(b.z).toBeLessThan(WORLD_SIZE);
      expect(b.y).toBeGreaterThanOrEqual(FIREWORK_ALT_MIN);
      expect(b.y).toBeLessThanOrEqual(FIREWORK_ALT_MAX);
      expect(b.hue).toBeGreaterThanOrEqual(0);
      expect(b.hue).toBeLessThan(1);
      // Spread is +/- BLOCK_PITCH/4 around a plaza center, so a burst never
      // drifts out of its own block.
      const key = `${Math.floor(b.x / BLOCK_PITCH)},${Math.floor(b.z / BLOCK_PITCH)}`;
      expect(plazas.has(key)).toBe(true);
    }
  });

  it("uses every plaza, not just the first", () => {
    const used = new Set(
      burstsInWindow(CITY_SEED, T0, T0 + 6 * HOUR).map(
        (b) =>
          `${Math.floor(b.x / BLOCK_PITCH)},${Math.floor(b.z / BLOCK_PITCH)}`,
      ),
    );
    expect(used.size).toBe(PLAZA_BLOCKS.length);
  });

  it("handles an empty and a reversed window without inventing bursts", () => {
    expect(burstsInWindow(CITY_SEED, T0, T0)).toEqual([]);
    expect(burstsInWindow(CITY_SEED, T0 + 1000, T0)).toEqual([]);
  });
});

describe("fireworks do not rhyme with the storm", () => {
  it("draws a different jitter stream than strikesInWindow at the same seed", () => {
    // Both schedules bucket time and read their first PRNG draw as the offset
    // inside the bucket. Without a salt those fractions would be equal bucket
    // for bucket, and every firework would land on the same beat as a strike.
    const window = 12 * HOUR;
    const bursts = burstsInWindow(CITY_SEED, T0, T0 + window);
    const strikes = strikesInWindow(CITY_SEED, T0, T0 + window);
    expect(bursts.length).toBeGreaterThan(100);
    expect(strikes.length).toBeGreaterThan(100);

    const burstBucket =
      (FIREWORK_INTERVAL_MIN_MS + FIREWORK_INTERVAL_MAX_MS) / 2;
    const strikeBucket = (8000 + 15000) / 2; // STRIKE_INTERVAL_MIN/MAX_MS
    const fracOf = (times: number[], bucket: number) =>
      times.map((t) => (t % bucket) / bucket);

    const bf = fracOf(
      bursts.map((b) => b.timeMs),
      burstBucket,
    );
    const sf = fracOf(
      strikes.map((s) => s.timeMs),
      strikeBucket,
    );
    const n = Math.min(bf.length, sf.length);
    let same = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs((bf[i] ?? 0) - (sf[i] ?? 0)) < 1e-9) same++;
    }
    expect(same).toBe(0);
  });
});
