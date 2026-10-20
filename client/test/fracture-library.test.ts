// DS2 the fracture library: baked at boot, a variety of irregular cells per
// material within a vertex budget — every cell inside the unit box (drawn ⊆
// collided), no two variants of a class alike, each class breaking its own
// way — and the new destruction emissives under the bloom threshold.

import { describe, expect, it } from "vitest";
import { INTERIOR_PEAK, triplanarWeights } from "../src/render/broken-shading";
import {
  REST_JAG_M,
  libraryVertex,
  patternAxis,
  permute,
} from "../src/render/debris";
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

describe("G8 no stretched pattern on any piece", () => {
  // Pieces as a collapse poses them: a crushed rest slab (the pile in
  // `ruin-detail`), a storey slab, a facade sheet, a column.
  const sizes: [number, number, number][] = [
    [20, 0.46, 20],
    [20.2, 0.49, 2],
    [20, 3.83, 20],
    [2, 12, 20],
    [1.2, 11.6, 1.2],
  ];
  /** How far a face's pattern stretches projected along `axis`: 1 / |m·axis|
   * for its unit METRIC normal m (1 on the plane, ∞ edge-on). */
  const stretch = (
    n: readonly number[],
    size: readonly number[],
    axis: number,
  ) => {
    const m = n.map((c, k) => c / (size[k] as number));
    const len = Math.hypot(...m);
    return len / Math.abs(m[axis] as number);
  };
  const faces = cells
    .slice(0, INTACT_ROW)
    .flatMap((c) => c.faces.filter((f) => f !== null))
    .map((f) => (f as { n: [number, number, number] }).n);

  it("projects every library face, on every piece, within √3 of true", () => {
    let unitWorst = 0;
    for (const size of sizes) {
      for (let axis = 0; axis < 3; axis++) {
        for (const nc of faces) {
          const n = permute(nc, axis);
          const s = stretch(n, size, patternAxis(n, size));
          expect(s).toBeLessThanOrEqual(Math.sqrt(3) + 1e-9);
          // The old pick (the unit-box normal's nearest axis), for scale.
          const unit = patternAxis(n, [1, 1, 1]);
          unitWorst = Math.max(unitWorst, stretch(n, size, unit));
        }
      }
    }
    // The bug this holds off: on a crushed slab the unit-box pick smeared
    // a face's pattern across metres.
    expect(unitWorst).toBeGreaterThan(10);
  });

  it("triplanar weights sum to 1, and an axis-aligned face takes one plane", () => {
    for (const nc of faces) {
      const w = triplanarWeights(nc);
      expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 12);
      for (const v of w) expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(triplanarWeights([0, 1, 0])).toEqual([0, 1, 0]);
    expect(triplanarWeights([0, 0, -1])).toEqual([0, 0, 1]);
  });

  it("a resting piece's cuts bite at most REST_JAG_M deep, in metres", () => {
    const texels = libraryTexels(cells);
    for (const size of sizes) {
      for (let row = 0; row < FracClass.STEEL * FRACTURE_VARIANTS; row++) {
        for (let v = 0; v < LIB_VERTS; v++) {
          const q = libraryVertex(texels, row, v, size, 1, null, true);
          const p = [q[0], q[1] - 0.5, q[2]];
          for (let k = 0; k < 3; k++) {
            const inset =
              (0.5 - Math.abs(p[k] as number)) * (size[k] as number);
            expect(inset).toBeLessThanOrEqual(REST_JAG_M + 0.05 + 1e-9);
          }
        }
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
