import { generateCity } from "@angels-bandits/common/city";
import {
  BLOCK_PITCH,
  BUILDING_MAX_HEIGHT,
  BUILDING_MIN_HEIGHT,
  LANDMARK_HEIGHT,
  STREET_WIDTH,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";

// The map is a 10×10 grid of 200 m blocks (2000/200). Hand-placed layout per
// PLAN.md: a handful of landmark supertalls and 2–3 empty plaza blocks.
// These literals are the spec for the generated city, independent of the
// generator's internals.
const EXPECTED_BUILDING_COUNT = 97; // 100 blocks − 3 plazas
const EXPECTED_LANDMARK_COUNT = 4;

describe("generateCity determinism", () => {
  it("produces byte-identical output across two invocations of the same seed", () => {
    expect(JSON.stringify(generateCity(42))).toBe(
      JSON.stringify(generateCity(42)),
    );
  });

  it("matches the committed snapshot for seed 42 (client and server must agree exactly)", () => {
    expect(generateCity(42)).toMatchSnapshot();
  });

  it("produces different cities for different seeds", () => {
    expect(JSON.stringify(generateCity(1))).not.toBe(
      JSON.stringify(generateCity(2)),
    );
  });
});

describe("generateCity layout", () => {
  const city = generateCity(42);

  it("fills every non-plaza block: 97 buildings on the 10×10 grid", () => {
    expect(city).toHaveLength(EXPECTED_BUILDING_COUNT);
  });

  it("keeps every building fully inside [0, WORLD_SIZE)", () => {
    for (const b of city) {
      expect(b.x - b.width / 2).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width / 2).toBeLessThan(WORLD_SIZE);
      expect(b.z - b.depth / 2).toBeGreaterThanOrEqual(0);
      expect(b.z + b.depth / 2).toBeLessThan(WORLD_SIZE);
    }
  });

  it("centers each building in its block: grid positions are multiples of BLOCK_PITCH", () => {
    for (const b of city) {
      expect((b.x - BLOCK_PITCH / 2) % BLOCK_PITCH).toBe(0);
      expect((b.z - BLOCK_PITCH / 2) % BLOCK_PITCH).toBe(0);
    }
  });

  it("leaves at least STREET_WIDTH of street between adjacent footprints", () => {
    for (const b of city) {
      expect(b.width).toBeLessThanOrEqual(BLOCK_PITCH - STREET_WIDTH);
      expect(b.depth).toBeLessThanOrEqual(BLOCK_PITCH - STREET_WIDTH);
    }
  });

  it("puts exactly one building per block", () => {
    const blocks = new Set(city.map((b) => `${b.x},${b.z}`));
    expect(blocks.size).toBe(EXPECTED_BUILDING_COUNT);
  });

  it("has 4 landmark supertalls at LANDMARK_HEIGHT and all other heights in [min, max]", () => {
    const landmarks = city.filter((b) => b.height === LANDMARK_HEIGHT);
    expect(landmarks).toHaveLength(EXPECTED_LANDMARK_COUNT);
    for (const b of city) {
      if (b.height === LANDMARK_HEIGHT) continue;
      expect(b.height).toBeGreaterThanOrEqual(BUILDING_MIN_HEIGHT);
      expect(b.height).toBeLessThanOrEqual(BUILDING_MAX_HEIGHT);
    }
  });

  it("stacks 1–3 tiers per building: heights sum to the total, tier 1 keeps the footprint", () => {
    for (const b of city) {
      expect(b.tiers.length).toBeGreaterThanOrEqual(1);
      expect(b.tiers.length).toBeLessThanOrEqual(3);
      // Tier 1 IS the building's footprint — streets and minimap unchanged.
      expect(b.tiers[0]?.width).toBe(b.width);
      expect(b.tiers[0]?.depth).toBe(b.depth);
      // The stack reaches exactly the building's total height.
      const sum = b.tiers.reduce((h, t) => h + t.height, 0);
      expect(sum).toBe(b.height);
      for (const t of b.tiers) expect(t.height).toBeGreaterThan(0);
    }
  });

  it("sets every upper tier strictly back inside the tier below (wedding-cake silhouette)", () => {
    for (const b of city) {
      for (let i = 1; i < b.tiers.length; i++) {
        const below = b.tiers[i - 1];
        const t = b.tiers[i];
        if (!below || !t) throw new Error("tier missing");
        expect(t.width).toBeLessThan(below.width);
        expect(t.depth).toBeLessThan(below.depth);
        // Centered stack ⇒ shrinking sides keep every tier inside tier 1.
        expect(t.width).toBeGreaterThan(0);
        expect(t.depth).toBeGreaterThan(0);
      }
    }
  });

  it("gives every landmark the fixed slim-shaft-and-crown profile (spec literals)", () => {
    const landmarks = city.filter((b) => b.height === LANDMARK_HEIGHT);
    for (const b of landmarks) {
      expect(b.tiers).toEqual([
        { width: 90, depth: 90, height: 60 },
        { width: 62, depth: 62, height: 150 },
        { width: 34, depth: 34, height: 40 },
      ]);
    }
  });

  it("varies the skyline: seed 42 has slabs, 2-tier and 3-tier towers", () => {
    const counts = [0, 0, 0];
    for (const b of city) {
      if (b.height === LANDMARK_HEIGHT) continue;
      const i = b.tiers.length - 1;
      counts[i] = (counts[i] ?? 0) + 1;
    }
    expect(counts[0]).toBeGreaterThanOrEqual(10);
    expect(counts[1]).toBeGreaterThanOrEqual(10);
    expect(counts[2]).toBeGreaterThanOrEqual(5);
  });

  it("hand-places landmarks and plazas seed-independently (orientation must survive reseeds)", () => {
    const other = generateCity(7);
    const landmarkSpots = (bs: typeof city) =>
      bs
        .filter((b) => b.height === LANDMARK_HEIGHT)
        .map((b) => `${b.x},${b.z}`)
        .sort();
    expect(landmarkSpots(other)).toEqual(landmarkSpots(city));

    const occupied = (bs: typeof city) =>
      new Set(bs.map((b) => `${b.x},${b.z}`));
    const spotsA = occupied(city);
    for (const spot of occupied(other)) {
      expect(spotsA.has(spot)).toBe(true); // same blocks filled → same plaza blocks empty
    }
  });
});
