// Facade garnish seam (ANGE-XY8LH8): pure deterministic parapet caps +
// entrance canopies per building (roofClutterFor idiom — no THREE, no
// Math.random). Hand-built worked examples pin the geometry rules; the real
// seed-42 city pins determinism and roadway safety in aggregate. Street
// geometry facts come from the S1 contract (isInRoadway/nearestStreet),
// never re-derived.

import { type Building, generateCity } from "@angels-bandits/common/city";
import { isInRoadway, nearestStreet } from "@angels-bandits/common/city/street";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { facadeGarnishFor } from "../src/render/facade-garnish";

// Setback tower on block (2,2): tier-1 25 m of sidewalk clearance
// ((200 − 120) / 2 − 15) — plenty of room for a canopy.
const TOWER: Building = {
  x: 500,
  z: 500,
  width: 120,
  depth: 120,
  height: 160,
  tiers: [
    { width: 120, depth: 120, height: 50 },
    { width: 40, depth: 40, height: 110 },
  ],
};

// Maximum footprint: the facade sits ON the curb line (clearance 0), so no
// canopy can stay out of the roadway on any face (S2's clearance rule).
const MAX_FOOTPRINT: Building = {
  x: 500,
  z: 500,
  width: 170,
  depth: 170,
  height: 60,
  tiers: [{ width: 170, depth: 170, height: 60 }],
};

describe("facadeGarnishFor — parapets", () => {
  it("caps every roof edge of every tier (4 lips per tier)", () => {
    const { parapets } = facadeGarnishFor(TOWER);
    expect(parapets).toHaveLength(8);
  });

  it("traces the worked example's tier edges at the right heights", () => {
    const { parapets } = facadeGarnishFor(TOWER);
    // Tier 1: 120×120 box topping out at y=50 → lips on z=440/560, x=440/560.
    const tier1 = parapets.filter((p) => p.y === 50);
    expect(tier1).toHaveLength(4);
    const northSouth = tier1
      .filter((p) => p.width > p.depth)
      .map((p) => p.z)
      .sort((a, b) => a - b);
    expect(northSouth).toEqual([440, 560]);
    const eastWest = tier1
      .filter((p) => p.depth > p.width)
      .map((p) => p.x)
      .sort((a, b) => a - b);
    expect(eastWest).toEqual([440, 560]);
    // Long lips span the full 120 m facade (plus a small overhang).
    for (const p of tier1)
      expect(Math.max(p.width, p.depth)).toBeGreaterThanOrEqual(120);
    // Tier 2: 40×40 crown topping out at y=160.
    const tier2 = parapets.filter((p) => p.y === 160);
    expect(tier2).toHaveLength(4);
  });
});

describe("facadeGarnishFor — canopies", () => {
  it("is deterministic: same building → identical layout", () => {
    expect(JSON.stringify(facadeGarnishFor(TOWER))).toBe(
      JSON.stringify(facadeGarnishFor(TOWER)),
    );
  });

  it("puts the worked example's canopy on its street-facing east side", () => {
    // nearestStreet((500,500)) is the x=600 line, so the east facade
    // (x = 560) faces the street; the awning protrudes east of it.
    const { canopy } = facadeGarnishFor(TOWER);
    expect(canopy).not.toBeNull();
    if (!canopy) return;
    expect(canopy.x).toBeGreaterThan(560);
    expect(canopy.x - canopy.sizeX / 2).toBeCloseTo(560, 5);
    expect(Math.abs(canopy.z - 500)).toBeLessThanOrEqual(60);
  });

  it("skips buildings whose facade sits on the curb (no sidewalk room)", () => {
    expect(facadeGarnishFor(MAX_FOOTPRINT).canopy).toBeNull();
  });

  it("never protrudes into the roadway, anywhere in the real city", () => {
    let canopies = 0;
    for (const b of generateCity(CITY_SEED)) {
      const { canopy } = facadeGarnishFor(b);
      if (!canopy) continue;
      canopies++;
      for (const cx of [
        canopy.x - canopy.sizeX / 2,
        canopy.x + canopy.sizeX / 2,
      ]) {
        for (const cz of [
          canopy.z - canopy.sizeZ / 2,
          canopy.z + canopy.sizeZ / 2,
        ]) {
          expect(isInRoadway({ x: cx, y: 0, z: cz })).toBe(false);
        }
      }
    }
    // The rule must not silently disable canopies city-wide.
    expect(canopies).toBeGreaterThan(50);
  });

  it("faces the nearest street per the S1 contract, city-wide", () => {
    for (const b of generateCity(CITY_SEED)) {
      const { canopy } = facadeGarnishFor(b);
      if (!canopy) continue;
      const street = nearestStreet({ x: b.x, y: 0, z: b.z });
      if (street.axis === "z") {
        // North–south street on a line of constant x: canopy off an x facade,
        // on the building's street side.
        const dir = Math.sign(canopy.x - b.x);
        expect(dir).toBe(-street.side);
        expect(Math.abs(canopy.x - b.x)).toBeGreaterThan(b.width / 2);
      } else {
        const dir = Math.sign(canopy.z - b.z);
        expect(dir).toBe(-street.side);
        expect(Math.abs(canopy.z - b.z)).toBeGreaterThan(b.depth / 2);
      }
    }
  });
});
