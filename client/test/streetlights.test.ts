// Street-lamp layout seam: pure deterministic placement derived from the
// block grid — no PRNG, no THREE. Worked examples use the shipped constants
// (WORLD_SIZE = 2000, BLOCK_PITCH = 200 → a 10×10 grid; FURNITURE_LINE = 16):
// each block owns its west and south street LINES and places lamps on BOTH
// furniture lines of each — the positive side at 25 / 100 / 175 m along the
// segment, the negative side staggered to 37.5 / 87.5 / 162.5 m (same rhythm,
// clear of block corners so no station lands in a crossing street's roadway) —
// so every street is covered exactly once despite the wrap, and no lamp ever
// stands in the roadway (the S1 root-cause fix: poles used to sit ON the
// centerline, mid-road).

import { isInRoadway, nearestStreet } from "@angels-bandits/common/city/street";
import { describe, expect, it } from "vitest";
import { streetlampPositions } from "../src/render/streetlights";

describe("streetlampPositions", () => {
  const lamps = streetlampPositions();

  it("places 1200 lamps: 10×10 blocks × 2 owned street lines × 2 sides × 3 lamps", () => {
    expect(lamps).toHaveLength(1200);
  });

  it("never places a lamp in the roadway — the mid-road pole bug is impossible", () => {
    for (const l of lamps) {
      expect(isInRoadway({ x: l.x, y: 0, z: l.z })).toBe(false);
    }
  });

  it("contains the hand-placed corners of the pattern, wrap included", () => {
    const has = (x: number, z: number) =>
      lamps.some((l) => l.x === x && l.z === z);
    // Block (0,0) west line (x = 0): positive side at x = 16,
    // negative side wraps to x = 1984 with the staggered stations.
    expect(has(16, 25)).toBe(true);
    expect(has(16, 100)).toBe(true);
    expect(has(1984, 37.5)).toBe(true);
    expect(has(1984, 87.5)).toBe(true);
    // Block (0,0) south line (z = 0): same cross-section, axes swapped.
    expect(has(25, 16)).toBe(true);
    expect(has(37.5, 1984)).toBe(true);
    // Block (9,9) west line (x = 1800), last station: 1800 + 175 = 1975.
    expect(has(1816, 1975)).toBe(true);
    expect(has(1784, 1962.5)).toBe(true);
  });

  it("puts every lamp on a furniture line: 16 m off exactly one street centerline", () => {
    const offLine = (v: number) => {
      const m = ((v % 200) + 200) % 200;
      return Math.min(m, 200 - m);
    };
    for (const l of lamps) {
      const dx = offLine(l.x);
      const dz = offLine(l.z);
      expect(Math.min(dx, dz)).toBe(16);
      expect(Math.max(dx, dz)).toBeGreaterThan(16);
    }
  });

  it("staggers the two sides of a street: stations at 25/100/175 vs 37.5/87.5/162.5", () => {
    for (const l of lamps) {
      const street = nearestStreet({ x: l.x, y: 0, z: l.z });
      const along = street.axis === "z" ? l.z : l.x;
      const station = ((along % 200) + 200) % 200;
      if (street.side === 1) {
        expect([25, 100, 175]).toContain(station);
      } else {
        expect([37.5, 87.5, 162.5]).toContain(station);
      }
    }
  });

  it("keeps every lamp in canonical [0, WORLD_SIZE) coordinates", () => {
    for (const l of lamps) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x).toBeLessThan(2000);
      expect(l.z).toBeGreaterThanOrEqual(0);
      expect(l.z).toBeLessThan(2000);
    }
  });

  it("never doubles up a lamp (each street line owned by one block)", () => {
    const keys = new Set(lamps.map((l) => `${l.x},${l.z}`));
    expect(keys.size).toBe(1200);
  });
});
