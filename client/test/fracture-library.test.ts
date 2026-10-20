// DS2 the fracture library: baked at boot, a variety of irregular cells per
// material within a vertex budget — every cell inside the unit box (drawn ⊆
// collided), no two variants of a class alike, each class breaking its own
// way — and the new destruction emissives under the bloom threshold.

import { describe, expect, it } from "vitest";
import { INTERIOR_PEAK } from "../src/render/broken-shading";
import {
  FACE_SLOTS,
  FACE_VERTS,
  FRACTURE_VARIANTS,
  FRACTURE_VERT_BUDGET,
  FRAC_CLASSES,
  FracClass,
  INTACT_ROW,
  LIB_ROWS,
  LIB_VERTS,
  MAX_VOLUME_SHARE,
  MIN_VOLUME_SHARE,
  ROW_TEXELS,
  bakeLibrary,
  cellVolume,
  libraryIndices,
  libraryTexels,
} from "../src/render/fracture-library";
import { GLINT_MAX } from "../src/render/glass-rain";
import { BLOOM_THRESHOLD } from "../src/render/rooftop-life";
import { HEAP_GLINT_RGB } from "../src/render/rubble-heap";

const cells = bakeLibrary();

describe("DS2 fracture library: budget", () => {
  it("bakes every class's variants and the intact box, within the vertex budget", () => {
    expect(FRACTURE_VARIANTS).toBeGreaterThanOrEqual(6);
    expect(cells).toHaveLength(LIB_ROWS);
    expect(LIB_ROWS).toBe(FRAC_CLASSES * FRACTURE_VARIANTS + 1);
    expect(LIB_VERTS).toBeLessThanOrEqual(FRACTURE_VERT_BUDGET);
    const idx = libraryIndices();
    expect(Math.max(...idx)).toBeLessThan(LIB_VERTS);
    // Every polygon fits its slot.
    for (const c of cells) {
      expect(c.faces).toHaveLength(FACE_SLOTS);
      for (const f of c.faces) {
        if (f) expect(f.poly.length).toBeLessThanOrEqual(FACE_VERTS);
      }
    }
  });

  it("is the same library on every client (seeded)", () => {
    expect(libraryTexels(bakeLibrary())).toEqual(libraryTexels(cells));
  });
});

describe("DS2 fracture library: variety", () => {
  it("every cell lies inside the unit box and keeps a sane share of it", () => {
    for (let r = 0; r < INTACT_ROW; r++) {
      const c = cells[r];
      if (!c) throw new Error("no cell");
      const vol = cellVolume(c);
      expect(vol).toBeGreaterThanOrEqual(MIN_VOLUME_SHARE);
      expect(vol).toBeLessThanOrEqual(MAX_VOLUME_SHARE);
      for (const f of c.faces) {
        for (const p of f?.poly ?? []) {
          for (const v of p)
            expect(Math.abs(v)).toBeLessThanOrEqual(0.5 + 1e-9);
        }
      }
    }
    expect(cellVolume(cells[INTACT_ROW] as (typeof cells)[number])).toBeCloseTo(
      1,
      9,
    );
  });

  it("no two variants of a class are alike", () => {
    const texels = libraryTexels(cells);
    const row = (r: number) =>
      texels.subarray(
        r * ROW_TEXELS * LIB_VERTS * 4,
        (r * ROW_TEXELS + 1) * LIB_VERTS * 4,
      );
    for (let cls = 0; cls < FRAC_CLASSES; cls++) {
      for (let a = 0; a < FRACTURE_VARIANTS; a++) {
        for (let b = a + 1; b < FRACTURE_VARIANTS; b++) {
          const ra = row(cls * FRACTURE_VARIANTS + a);
          const rb = row(cls * FRACTURE_VARIANTS + b);
          let diff = 0;
          for (let i = 0; i < ra.length; i++)
            diff = Math.max(
              diff,
              Math.abs((ra[i] as number) - (rb[i] as number)),
            );
          expect(diff).toBeGreaterThan(0.05);
        }
      }
    }
  });

  it("each material breaks its own way", () => {
    const of = (cls: number) =>
      cells.slice(cls * FRACTURE_VARIANTS, (cls + 1) * FRACTURE_VARIANTS);
    const cuts = (cls: number) =>
      of(cls).flatMap((c) => c.faces.slice(6).filter((f) => f !== null));
    const meanVol = (cls: number) =>
      of(cls).reduce((s, c) => s + cellVolume(c), 0) / FRACTURE_VARIANTS;
    // Concrete: torn edges with rebar out of them.
    expect(of(FracClass.CONCRETE).every((c) => c.bars.length > 0)).toBe(true);
    expect(of(FracClass.MASONRY).every((c) => c.bars.length === 0)).toBe(true);
    // Glass splits into slivers: cut deepest, across the pane (canonical y
    // is a plate's thin axis, so the cuts stand across it).
    expect(meanVol(FracClass.GLASS)).toBeLessThan(meanVol(FracClass.CONCRETE));
    expect(meanVol(FracClass.GLASS)).toBeLessThan(meanVol(FracClass.MASONRY));
    expect(cuts(FracClass.GLASS).every((f) => Math.abs(f.n[1]) < 0.1)).toBe(
      true,
    );
    // Masonry crumbles: more cuts than a slab.
    expect(cuts(FracClass.MASONRY).length).toBeGreaterThan(
      cuts(FracClass.CONCRETE).length,
    );
    // Steel is torn off at a slant at its ends (canonical y is its length).
    for (const c of of(FracClass.STEEL)) {
      const ends = c.faces.slice(6, 8);
      for (const f of ends) {
        expect(f).not.toBeNull();
        expect(Math.abs((f as { n: number[] }).n[1] as number)).toBeGreaterThan(
          0.5,
        );
      }
    }
  });
});

describe("DS2 the new emissives stay under the bloom threshold", () => {
  it("glass glints, heap glitter and a lit room's ceiling panels", () => {
    expect(GLINT_MAX).toBeLessThan(BLOOM_THRESHOLD);
    // The glitter adds to the heap's own colour (its brightest, the settled
    // dust, ≤ 0.2 linear).
    expect(Math.max(...HEAP_GLINT_RGB) + 0.2).toBeLessThan(BLOOM_THRESHOLD);
    expect(INTERIOR_PEAK).toBeLessThan(BLOOM_THRESHOLD);
  });
});
