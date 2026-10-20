// Facade archetype seam (ANGE-XY8LH8): pure deterministic classification of
// every building into GLASS / MASONRY / OFFICE — same inputs on every client,
// so all clients paint identical facades. Worked examples pin the spec rules
// (L3: supertalls and slim shafts are GLASS, the prewar rest MASONRY with a
// seeded OFFICE share, landmarks by style); the real
// seed-42 city pins totality, determinism, and a mixed skyline in aggregate.

import {
  type Building,
  LANDMARK_BLOCKS,
  LANDMARK_PROFILES,
  generateCity,
} from "@angels-bandits/common/city";
import {
  BLOCK_PITCH,
  CITY_SEED,
  LANDMARK_HEIGHT,
} from "@angels-bandits/common/constants";
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
  it("classifies landmarks by their L3 style: the glass one GLASS, the Art Deco ones MASONRY stone", () => {
    const city = generateCity(CITY_SEED);
    LANDMARK_BLOCKS.forEach(([bx, bz], i) => {
      const b = city.find(
        (o) =>
          o.x === bx * BLOCK_PITCH + BLOCK_PITCH / 2 &&
          o.z === bz * BLOCK_PITCH + BLOCK_PITCH / 2,
      );
      expect(b).toBeDefined();
      expect(archetypeFor(b as Building)).toBe(
        LANDMARK_PROFILES[i]?.style === "glass"
          ? FacadeArchetype.GLASS
          : FacadeArchetype.MASONRY,
      );
    });
    // A landmark-height tower off the landmark blocks has no style: GLASS.
    expect(archetypeFor(box(90, 90, LANDMARK_HEIGHT))).toBe(
      FacadeArchetype.GLASS,
    );
  });

  it("classifies tall towers as GLASS (spec: height > 150; T1: > 250, the supertalls)", () => {
    expect(archetypeFor(box(150, 150, 276))).toBe(FacadeArchetype.GLASS);
  });

  it("classifies slim towers as GLASS even under 120 m (slim aspect)", () => {
    // 110 m tall on a 60×55 footprint: aspect 2.0 — a slim shaft. T1: the
    // ring's towers stand 2–3 footprints tall, so a shaft is 3 — 110 m on
    // a 36×32 footprint.
    expect(archetypeFor(box(36, 32, 110))).toBe(FacadeArchetype.GLASS);
  });

  it("classifies low, wide slabs as MASONRY (spec: height < 70 and wide)", () => {
    expect(archetypeFor(box(152, 121, 45))).toBe(FacadeArchetype.MASONRY);
  });

  it("classifies the in-between as prewar MASONRY or, for a seeded share, OFFICE (L3)", () => {
    // Squat mid-rises, neither tall/slim nor supertall: mostly brick and
    // stone, some strip-window offices — and never anything else.
    const kinds = new Set<FacadeArchetype>();
    let masonry = 0;
    let n = 0;
    for (let w = 90; w < 110; w++) {
      for (const h of [60, 83, 120]) {
        const kind = archetypeFor(box(w, w + 1, h));
        expect(kind).not.toBe(FacadeArchetype.GLASS);
        kinds.add(kind);
        if (kind === FacadeArchetype.MASONRY) masonry++;
        n++;
      }
    }
    expect(kinds).toEqual(
      new Set([FacadeArchetype.MASONRY, FacadeArchetype.OFFICE]),
    );
    expect(masonry / n).toBeGreaterThan(0.5);
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
