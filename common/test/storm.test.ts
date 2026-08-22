import {
  CLOUD_BASE,
  STORM_CELL_SIZE,
  STORM_GRACE_MS,
  STORM_KILL_ALT,
  STRIKE_INTERVAL_MAX_MS,
  STRIKE_INTERVAL_MIN_MS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Strike, strikesInWindow } from "@angels-bandits/common/storm";
import { wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

// Spec literals (the ticket + the approved Concept D), independent of the
// implementation: strikes 8–15 s apart, positions canonical, every 500 m map
// cell visited once per 16-strike epoch, and strikes whose cell holds one of
// the four landmark supertalls snap to that tower's roof (~60 m).
const HOUR_MS = 3_600_000;
const CELL = 500; // 4×4 coverage grid of the 2 km map, from Concept D
/** Landmark supertall centers: LANDMARK_BLOCKS (2,3)(7,1)(5,8)(8,6), each
 * centered in its 200 m block (bx·200+100) — same layout city.test.ts pins. */
const LANDMARKS = [
  { x: 500, y: 0, z: 700 },
  { x: 1500, y: 0, z: 300 },
  { x: 1100, y: 0, z: 1700 },
  { x: 1700, y: 0, z: 1300 },
];

const hourOfStorm = (seed: number): Strike[] =>
  strikesInWindow(seed, 0, HOUR_MS);

describe("strikesInWindow determinism", () => {
  it("returns identical strikes for the same (seed, window) twice", () => {
    expect(JSON.stringify(hourOfStorm(42))).toBe(
      JSON.stringify(hourOfStorm(42)),
    );
  });

  it("produces different storms for different seeds", () => {
    expect(JSON.stringify(hourOfStorm(1))).not.toBe(
      JSON.stringify(hourOfStorm(2)),
    );
  });

  it("is windowed, not walked: abutting half-open windows partition the hour", () => {
    const whole = hourOfStorm(42);
    const parts: Strike[] = [];
    for (let t = 0; t < HOUR_MS; t += 600_000) {
      parts.push(...strikesInWindow(42, t, t + 600_000));
    }
    expect(JSON.stringify(parts)).toBe(JSON.stringify(whole));
  });

  it("supports server-clock-sized times (Date.now() epoch ms)", () => {
    const t0 = 1_766_000_000_000; // a real 2026 wall-clock time
    const strikes = strikesInWindow(42, t0, t0 + 60_000);
    expect(strikes.length).toBeGreaterThan(0);
    for (const s of strikes) {
      expect(s.timeMs).toBeGreaterThanOrEqual(t0);
      expect(s.timeMs).toBeLessThan(t0 + 60_000);
    }
  });
});

describe("strike cadence (one strike every 8–15 s, seeded jitter)", () => {
  it("keeps every gap between consecutive strikes inside the band", () => {
    const strikes = hourOfStorm(42);
    // ~3600/11.5 strikes in an hour — the band makes the count a spec bound.
    expect(strikes.length).toBeGreaterThanOrEqual(
      HOUR_MS / STRIKE_INTERVAL_MAX_MS,
    );
    expect(strikes.length).toBeLessThanOrEqual(
      HOUR_MS / STRIKE_INTERVAL_MIN_MS,
    );
    for (let i = 1; i < strikes.length; i++) {
      const gap = (strikes[i]?.timeMs ?? 0) - (strikes[i - 1]?.timeMs ?? 0);
      expect(gap).toBeGreaterThanOrEqual(STRIKE_INTERVAL_MIN_MS);
      expect(gap).toBeLessThanOrEqual(STRIKE_INTERVAL_MAX_MS);
    }
  });

  it("returns strikes sorted by time", () => {
    const strikes = hourOfStorm(7);
    const times = strikes.map((s) => s.timeMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("strike positions (Concept D: rods over a marching front)", () => {
  it("keeps every position canonical in [0, WORLD_SIZE)", () => {
    for (const s of hourOfStorm(42)) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThan(WORLD_SIZE);
      expect(s.z).toBeGreaterThanOrEqual(0);
      expect(s.z).toBeLessThan(WORLD_SIZE);
    }
  });

  it("covers the whole map: every 500 m cell is struck within an hour", () => {
    const cells = new Set<number>();
    for (const s of hourOfStorm(42)) {
      cells.add(
        Math.floor(s.z / CELL) * (WORLD_SIZE / CELL) + Math.floor(s.x / CELL),
      );
    }
    expect(cells.size).toBe((WORLD_SIZE / CELL) ** 2);
  });

  it("strikes the landmark supertalls far more often than chance (~25% within rod range)", () => {
    const strikes = hourOfStorm(42);
    const nearRod = strikes.filter((s) =>
      LANDMARKS.some((lm) => wrapDistance({ x: s.x, y: 0, z: s.z }, lm) < 90),
    ).length;
    // Spec: 4 rod cells of 16 → 25% of strikes snap to a tower. Uniform
    // chance inside 90 m of the 4 towers would be ~2.5% of the map.
    expect(nearRod / strikes.length).toBeGreaterThan(0.15);
    expect(nearRod / strikes.length).toBeLessThan(0.35);
  });
});

describe("storm constants (spec values from the ticket)", () => {
  it("pins the storm altitudes and grace: clouds at 500, kill at 600, 3 s grace", () => {
    expect(CLOUD_BASE).toBe(500);
    expect(STORM_KILL_ALT).toBe(600);
    expect(STORM_GRACE_MS).toBe(3000);
  });

  it("keeps the cadence band at 8–15 s and the 500 m cells tiling the world", () => {
    expect(STRIKE_INTERVAL_MIN_MS).toBe(8000);
    expect(STRIKE_INTERVAL_MAX_MS).toBe(15_000);
    expect(STORM_CELL_SIZE).toBe(CELL);
    expect(WORLD_SIZE % STORM_CELL_SIZE).toBe(0);
  });
});
