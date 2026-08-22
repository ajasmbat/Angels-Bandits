// Facade archetype seam (ANGE-XY8LH8): pure deterministic classification of
// every building into GLASS / MASONRY / OFFICE — same inputs on every client,
// so all clients paint identical facades. Worked examples pin the spec rules
// (landmarks and supertalls are GLASS, low-and-wide is MASONRY); the real
// seed-42 city pins totality, determinism, and a mixed skyline in aggregate.

import { type Building, generateCity } from "@angels-bandits/common/city";
import { CITY_SEED, LANDMARK_HEIGHT } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { FacadeArchetype, archetypeFor } from "../src/render/archetypes";

/** Hand-built worked examples — heights/footprints from the ticket spec. */
const box = (width: number, depth: number, height: number): Building => ({
  x: 500,
  z: 500,
  width,
  depth,
  height,
  tiers: [{ width, depth, height }],
});

describe("archetypeFor", () => {
  it("classifies landmarks as GLASS (spec: ALL landmarks)", () => {
    const landmark = box(90, 90, LANDMARK_HEIGHT);
    expect(archetypeFor(landmark)).toBe(FacadeArchetype.GLASS);
  });

  it("classifies tall towers as GLASS (spec: height > 120)", () => {
    expect(archetypeFor(box(120, 120, 176))).toBe(FacadeArchetype.GLASS);
  });

  it("classifies slim towers as GLASS even under 120 m (slim aspect)", () => {
    // 110 m tall on a 60×55 footprint: aspect 2.0 — a slim shaft.
    expect(archetypeFor(box(60, 55, 110))).toBe(FacadeArchetype.GLASS);
  });

  it("classifies low, wide slabs as MASONRY (spec: height < 70 and wide)", () => {
    expect(archetypeFor(box(152, 121, 45))).toBe(FacadeArchetype.MASONRY);
  });

  it("classifies the in-between as OFFICE", () => {
    // 83 m mid-rise on a squat footprint: neither tall/slim nor low/wide.
    expect(archetypeFor(box(103, 104, 83))).toBe(FacadeArchetype.OFFICE);
  });

  it("is total and deterministic over the real city", () => {
    const all = Object.values(FacadeArchetype);
    const a = generateCity(CITY_SEED).map(archetypeFor);
    const b = generateCity(CITY_SEED).map(archetypeFor);
    expect(a).toEqual(b);
    for (const kind of a) expect(all).toContain(kind);
  });

  it("produces a mixed skyline: every archetype present, none over 70%", () => {
    const city = generateCity(CITY_SEED);
    const counts = new Map<FacadeArchetype, number>();
    for (const b of city) {
      const kind = archetypeFor(b);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    for (const kind of Object.values(FacadeArchetype)) {
      const n = counts.get(kind) ?? 0;
      expect(n).toBeGreaterThan(0);
      expect(n / city.length).toBeLessThanOrEqual(0.7);
    }
  });
});
