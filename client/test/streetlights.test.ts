// Street-lamp layout seam: pure deterministic placement derived from the
// block grid — no PRNG, no THREE. Worked examples use the shipped constants
// (WORLD_SIZE = 2000, BLOCK_PITCH = 200 → a 10×10 grid): each block owns its
// west and south street segments, 3 lamps per segment at 25 / 100 / 175 m
// along it, so every street line is covered exactly once despite the wrap.

import { describe, expect, it } from "vitest";
import { streetlampPositions } from "../src/render/streetlights";

describe("streetlampPositions", () => {
  const lamps = streetlampPositions();

  it("places 600 lamps: 10×10 blocks × 2 owned street segments × 3 lamps", () => {
    expect(lamps).toHaveLength(600);
  });

  it("contains the hand-placed corners of the pattern", () => {
    // Block (0,0) west segment: x = 0, z = 25 / 100 / 175.
    // Block (0,0) south segment: z = 0, x = 25 / 100 / 175.
    // Block (9,9) west segment ends at (1800, 1975).
    const has = (x: number, z: number) =>
      lamps.some((l) => l.x === x && l.z === z);
    expect(has(0, 25)).toBe(true);
    expect(has(0, 100)).toBe(true);
    expect(has(25, 0)).toBe(true);
    expect(has(1800, 1975)).toBe(true);
    // Mid-map: south segment of block (0,1) has its middle lamp at (100, 200).
    expect(has(100, 200)).toBe(true);
  });

  it("puts every lamp on exactly one street centerline (never a corner)", () => {
    for (const l of lamps) {
      const onVertical = l.x % 200 === 0;
      const onHorizontal = l.z % 200 === 0;
      expect(onVertical !== onHorizontal).toBe(true);
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

  it("never doubles up a lamp (each street segment owned by one block)", () => {
    const keys = new Set(lamps.map((l) => `${l.x},${l.z}`));
    expect(keys.size).toBe(600);
  });
});
