// Roof-clutter layout seam: pure deterministic placement derived from each
// building's position and dimensions — no Math.random, no THREE (mirrors the
// streetlampPositions idiom). Hand-built worked examples pin the rules; the
// real seed-42 city pins determinism and containment in aggregate.

import { type Building, generateCity } from "@angels-bandits/common/city";
import { LANDMARK_HEIGHT } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { roofClutterFor } from "../src/render/roofclutter";

// Mid-rise slab: big roof, too short for an antenna mast.
const MIDRISE: Building = {
  x: 500,
  z: 500,
  width: 120,
  depth: 120,
  height: 60,
  tiers: [{ width: 120, depth: 120, height: 60 }],
};

// Tall setback tower: top tier 40×40 at 160 m — mast + tip territory.
const TALL: Building = {
  x: 900,
  z: 300,
  width: 120,
  depth: 120,
  height: 160,
  tiers: [
    { width: 120, depth: 120, height: 90 },
    { width: 40, depth: 40, height: 70 },
  ],
};

// Landmark supertall (height IS the landmark test everywhere else too).
const LANDMARK: Building = {
  x: 500,
  z: 700,
  width: 90,
  depth: 90,
  height: LANDMARK_HEIGHT,
  tiers: [
    { width: 90, depth: 90, height: 60 },
    { width: 62, depth: 62, height: 150 },
    { width: 34, depth: 34, height: 40 },
  ],
};

/** Half-extent an item may reach from the building center on axis `size`. */
const roofHalf = (b: Building) => {
  const top = b.tiers[b.tiers.length - 1];
  if (!top) throw new Error("empty tiers");
  return { w: top.width / 2, d: top.depth / 2 };
};

describe("roofClutterFor", () => {
  it("is deterministic: same building → identical layout", () => {
    expect(JSON.stringify(roofClutterFor(TALL))).toBe(
      JSON.stringify(roofClutterFor(TALL)),
    );
  });

  it("keeps every item on the TOP tier's roof, standing at the building height", () => {
    for (const b of [MIDRISE, TALL, ...generateCity(42)]) {
      const { w, d } = roofHalf(b);
      const c = roofClutterFor(b);
      for (const t of c.waterTowers) {
        expect(Math.abs(t.x - b.x) + t.radius).toBeLessThanOrEqual(w);
        expect(Math.abs(t.z - b.z) + t.radius).toBeLessThanOrEqual(d);
        expect(t.y).toBe(b.height);
      }
      for (const box of c.acBoxes) {
        expect(Math.abs(box.x - b.x) + box.width / 2).toBeLessThanOrEqual(w);
        expect(Math.abs(box.z - b.z) + box.depth / 2).toBeLessThanOrEqual(d);
        expect(box.y).toBe(b.height);
      }
      for (const m of c.masts) {
        expect(Math.abs(m.x - b.x)).toBeLessThanOrEqual(w);
        expect(Math.abs(m.z - b.z)).toBeLessThanOrEqual(d);
        expect(m.y).toBe(b.height);
      }
    }
  });

  it("puts antenna masts only on tall buildings", () => {
    expect(roofClutterFor(MIDRISE).masts).toHaveLength(0);
    expect(roofClutterFor(TALL).masts.length).toBeGreaterThan(0);
  });

  it("gives landmarks a beacon and nothing else", () => {
    const c = roofClutterFor(LANDMARK);
    expect(c.beacon).not.toBeNull();
    expect(c.beacon?.x).toBe(LANDMARK.x);
    expect(c.beacon?.z).toBe(LANDMARK.z);
    // Beacon floats just above the crown.
    expect(c.beacon?.y).toBeGreaterThan(LANDMARK_HEIGHT);
    expect(c.waterTowers).toHaveLength(0);
    expect(c.acBoxes).toHaveLength(0);
    expect(c.masts).toHaveLength(0);
    // Non-landmarks never get one.
    expect(roofClutterFor(TALL).beacon).toBeNull();
  });

  it("populates the seed-42 city: clutter exists, exactly 4 beacons", () => {
    const city = generateCity(42);
    const all = city.map(roofClutterFor);
    const beacons = all.filter((c) => c.beacon !== null);
    expect(beacons).toHaveLength(4);
    const towers = all.reduce((n, c) => n + c.waterTowers.length, 0);
    const boxes = all.reduce((n, c) => n + c.acBoxes.length, 0);
    const masts = all.reduce((n, c) => n + c.masts.length, 0);
    expect(towers).toBeGreaterThan(20);
    expect(boxes).toBeGreaterThan(50);
    expect(masts).toBeGreaterThan(5);
  });
});
