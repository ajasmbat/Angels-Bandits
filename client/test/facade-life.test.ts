// A1 facade life: laundry lines, facade flags and banners, pigeons. The
// plan's garnish contract, checked on the seed-42 city every client builds:
// nothing stands more than MAX_PROTRUSION (1.5 m) off its own facade, nothing
// hangs below DETAIL_MIN_Y, nothing spans a street (each item hangs off ONE
// face, inside that face's length), and every pigeon perches on a real ledge.

import { generateCity } from "@angels-bandits/common/city";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { FacadeArchetype, archetypeFor } from "../src/render/archetypes";
import { DETAIL_MIN_Y, MAX_PROTRUSION } from "../src/render/facade-detail";
import {
  CANOPY_THICKNESS,
  CANOPY_Y,
  PARAPET_HEIGHT,
  facadeGarnishFor,
} from "../src/render/facade-garnish";
import {
  bakeFacadeLife,
  facadeLifeFor,
  itemExtent,
} from "../src/render/facade-life";

const SEED = 42;
const city = generateCity(SEED);
const lives = city.map((b) => facadeLifeFor(b, SEED));

describe("facadeLifeFor", () => {
  it("is deterministic per (seed, building) and depends on the seed", () => {
    expect(JSON.stringify(city.map((b) => facadeLifeFor(b, SEED)))).toBe(
      JSON.stringify(lives),
    );
    expect(
      JSON.stringify(city.map((b) => facadeLifeFor(b, SEED + 1))),
    ).not.toBe(JSON.stringify(lives));
  });

  it("dresses the city: laundry, flags, banners and pigeons all appear", () => {
    const count = (k: "laundry" | "flags" | "banners" | "pigeons") =>
      lives.reduce((n, l) => n + l[k].length, 0);
    expect(count("laundry")).toBeGreaterThan(40);
    expect(count("flags")).toBeGreaterThan(20);
    expect(count("banners")).toBeGreaterThan(20);
    expect(count("pigeons")).toBeGreaterThan(400);
  });

  it("hangs laundry only in the masonry district", () => {
    city.forEach((b, i) => {
      if ((lives[i]?.laundry.length ?? 0) > 0) {
        expect(archetypeFor(b)).toBe(FacadeArchetype.MASONRY);
      }
    });
  });

  it("keeps every item within 1.5 m of its facade, above the shop band, on one face", () => {
    city.forEach((b, i) => {
      const life = lives[i];
      const t0 = b.tiers[0];
      if (!life || !t0) return;
      for (const item of [...life.laundry, ...life.flags, ...life.banners]) {
        const e = itemExtent(item);
        expect(e.out).toBeLessThanOrEqual(MAX_PROTRUSION);
        expect(e.low).toBeGreaterThanOrEqual(DETAIL_MIN_Y);
        // On the building's own ground-tier face, inside its length: so no
        // line can ever span the street to the facing block.
        const half = item.axis === "x" ? t0.width / 2 : t0.depth / 2;
        const centre = item.axis === "x" ? b.x : b.z;
        expect(Math.abs(item.plane - (centre + item.dir * half))).toBeLessThan(
          1e-6,
        );
        const length = item.axis === "x" ? t0.depth : t0.width;
        const along = item.axis === "x" ? b.z : b.x;
        expect(e.a0).toBeGreaterThanOrEqual(along - length / 2);
        expect(e.a1).toBeLessThanOrEqual(along + length / 2);
      }
    });
  });

  it("perches every pigeon on a parapet lip or the entrance canopy", () => {
    city.forEach((b, i) => {
      const life = lives[i];
      if (!life) return;
      const g = facadeGarnishFor(b);
      for (const p of life.pigeons) {
        const onLip = g.parapets.some(
          (l) =>
            Math.abs(p.y - (l.y + PARAPET_HEIGHT)) < 1e-6 &&
            Math.abs(wrapDeltaAxis(l.x, p.x)) <= l.width / 2 + 1e-6 &&
            Math.abs(wrapDeltaAxis(l.z, p.z)) <= l.depth / 2 + 1e-6,
        );
        const c = g.canopy;
        const onCanopy =
          c !== null &&
          Math.abs(p.y - (CANOPY_Y + CANOPY_THICKNESS)) < 1e-6 &&
          Math.abs(wrapDeltaAxis(c.x, p.x)) <= c.sizeX / 2 + 1e-6 &&
          Math.abs(wrapDeltaAxis(c.z, p.z)) <= c.sizeZ / 2 + 1e-6;
        expect(onLip || onCanopy).toBe(true);
      }
    });
  });

  it("bakes inside a fixed vertex budget", () => {
    const baked = bakeFacadeLife(lives);
    expect(baked.vertexCount).toBeGreaterThan(10_000);
    expect(baked.vertexCount).toBeLessThan(120_000);
    expect(baked.pivots.length).toBe(baked.vertexCount * 4);
  });
});
