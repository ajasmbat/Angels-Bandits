// Signage layout seam (S2): pure deterministic placement derived from
// (world seed, building) — no Math.random, no THREE (mirrors the
// roofClutterFor idiom). Hand-built worked examples pin the rules; the real
// seed-42 city pins determinism and roadway safety in aggregate. Street
// geometry facts come from the S1 contract (isInRoadway), never re-derived.

import { type Building, generateCity } from "@angels-bandits/common/city";
import { isInRoadway } from "@angels-bandits/common/city/street";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { type SignPlacement, signageFor } from "../src/render/signage";

// Mid-block slab at (500, 500): 120×120 footprint leaves a 25 m clearance
// between each facade and the curb ((200 − 120) / 2 − 15) — signs fit.
const MIDRISE: Building = {
  x: 500,
  z: 500,
  width: 120,
  depth: 120,
  height: 60,
  tiers: [{ width: 120, depth: 120, height: 60 }],
};

// Maximum footprint: the facade sits ON the curb line (clearance 0), so no
// flush-mounted sign can stay out of the roadway on any face.
const MAX_FOOTPRINT: Building = {
  x: 500,
  z: 500,
  width: 170,
  depth: 170,
  height: 60,
  tiers: [{ width: 170, depth: 170, height: 60 }],
};

// Setback tower: marquees must respect TIER-1 (height 50), not the legacy
// 160 m total height.
const TOWER: Building = {
  x: 900,
  z: 300,
  width: 120,
  depth: 120,
  height: 160,
  tiers: [
    { width: 120, depth: 120, height: 50 },
    { width: 40, depth: 40, height: 110 },
  ],
};

const SEED = 42;

/** All four ground corners of a sign panel (outer face included). */
function panelCorners(s: SignPlacement): { x: number; z: number }[] {
  const half = s.width / 2;
  const out = s.depth / 2;
  if (s.axis === "x") {
    return [
      { x: s.x + s.dir * out, z: s.z - half },
      { x: s.x + s.dir * out, z: s.z + half },
      { x: s.x - s.dir * out, z: s.z - half },
      { x: s.x - s.dir * out, z: s.z + half },
    ];
  }
  return [
    { x: s.x - half, z: s.z + s.dir * out },
    { x: s.x + half, z: s.z + s.dir * out },
    { x: s.x - half, z: s.z - s.dir * out },
    { x: s.x + half, z: s.z - s.dir * out },
  ];
}

describe("signageFor — marquees", () => {
  it("is deterministic: same (building, seed) → identical layout", () => {
    expect(JSON.stringify(signageFor(MIDRISE, SEED))).toBe(
      JSON.stringify(signageFor(MIDRISE, SEED)),
    );
  });

  it("changes with the world seed", () => {
    expect(JSON.stringify(signageFor(MIDRISE, SEED))).not.toBe(
      JSON.stringify(signageFor(MIDRISE, 43)),
    );
  });

  it("dresses a mid-block slab with at least one marquee", () => {
    expect(signageFor(MIDRISE, SEED).marquees.length).toBeGreaterThan(0);
  });

  it("skips every face of a max-footprint building (facade on the curb)", () => {
    expect(signageFor(MAX_FOOTPRINT, SEED).marquees).toHaveLength(0);
  });

  it("keeps marquee dims in the plan's ranges: 2–3 wide, 8–25 tall, bottom 4–8 up", () => {
    for (const m of signageFor(MIDRISE, SEED).marquees) {
      expect(m.width).toBeGreaterThanOrEqual(2);
      expect(m.width).toBeLessThanOrEqual(3);
      expect(m.height).toBeGreaterThanOrEqual(8);
      expect(m.height).toBeLessThanOrEqual(25);
      expect(m.y).toBeGreaterThanOrEqual(4);
      expect(m.y).toBeLessThanOrEqual(8);
    }
  });

  it("caps marquees at the TIER-1 face, never the total building height", () => {
    const tier1Top = 50;
    const marquees = signageFor(TOWER, SEED).marquees;
    expect(marquees.length).toBeGreaterThan(0);
    for (const m of marquees) {
      expect(m.y + m.height).toBeLessThanOrEqual(tier1Top);
    }
  });

  it("mounts marquees flush on a tier-1 facade plane", () => {
    // MIDRISE facade planes: x or z at 440 / 560 (500 ± 60); a flush sign's
    // center sits depth/2 outside one of them.
    for (const m of signageFor(MIDRISE, SEED).marquees) {
      const facadeCoord = m.axis === "x" ? m.x : m.z;
      const expected = 500 + m.dir * (60 + m.depth / 2);
      expect(facadeCoord).toBeCloseTo(expected, 6);
    }
  });

  it("never puts any part of any sign in the roadway, across the whole seed-42 city", () => {
    for (const b of generateCity(CITY_SEED)) {
      for (const m of signageFor(b, CITY_SEED).marquees) {
        for (const c of panelCorners(m)) {
          expect(isInRoadway({ x: c.x, y: 0, z: c.z })).toBe(false);
        }
      }
    }
  });

  it("keeps every marquee in canonical [0, 2000) coordinates", () => {
    for (const b of generateCity(CITY_SEED)) {
      for (const m of signageFor(b, CITY_SEED).marquees) {
        expect(m.x).toBeGreaterThanOrEqual(0);
        expect(m.x).toBeLessThan(2000);
        expect(m.z).toBeGreaterThanOrEqual(0);
        expect(m.z).toBeLessThan(2000);
      }
    }
  });
});
