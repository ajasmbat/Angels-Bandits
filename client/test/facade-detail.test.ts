// L13 facade detail seam (ANGE-G6JR64): pure deterministic fire escapes,
// balconies, AC units and scaffolding per building (facadeGarnishFor idiom —
// no Math.random). Hand-built worked examples pin the face rules; the real
// seed-42 city pins determinism, the 1.5 m protrusion envelope, and the
// hole / sign / canopy clearances in aggregate. Also pins the bit-exact
// window pitch seed the layout aligns to.

import {
  type Building,
  CITY_GRID,
  CONSTRUCTION_BLOCKS,
  generateCity,
} from "@angels-bandits/common/city";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { wrapDelta } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { FacadeArchetype, archetypeFor } from "../src/render/archetypes";
import {
  DETAIL_MIN_Y,
  type DetailBox,
  MAX_PROTRUSION,
  detailBounds,
  facadeDetailFor,
} from "../src/render/facade-detail";
import { facadeGarnishFor } from "../src/render/facade-garnish";
import { signageFor } from "../src/render/signage";
import { blockOf, blockWindow } from "../src/render/streetlife";
import { pitchSeed } from "../src/render/window-pattern";

const city = generateCity(CITY_SEED);
const layouts = city.map((b) => ({ b, d: facadeDetailFor(b, CITY_SEED) }));
const all = (d: { boxes: DetailBox[]; lights: DetailBox[] }) => [
  ...d.boxes,
  ...d.lights,
];

// A low, wide masonry lot on block (2,2) whose WEST side (x = 420) sits on
// the x = 400 street's lot line (sidewalk) and whose other sides are party
// walls inside the block. 90 m frontage, 40 m tall → MASONRY.
const MASONRY_LOT: Building = {
  x: 465,
  z: 500,
  width: 90,
  depth: 90,
  height: 40,
  tiers: [{ width: 90, depth: 90, height: 40 }],
};

describe("pitchSeed — the bit-exact window grid seed", () => {
  it("is pinned: same float32 bits in, same 24-bit seed out", () => {
    // Pinned pairs — a change here repaints every window grid on the GPU.
    expect(pitchSeed(40, 90, 30)).toBe(pitchSeed(40, 90, 30));
    expect(pitchSeed(40, 90, 30) * 16777216).toBe(
      Math.floor(pitchSeed(40, 90, 30) * 16777216),
    );
    expect(pitchSeed(40, 90, 30)).not.toBe(pitchSeed(41, 90, 30));
    // float32 rounding is part of the contract (aParent is a Float32 attribute).
    expect(pitchSeed(40.1, 90, 30)).toBe(pitchSeed(Math.fround(40.1), 90, 30));
    for (const b of city.slice(0, 200)) {
      for (const t of b.tiers) {
        const s = pitchSeed(t.width, t.height, t.depth);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(1);
      }
    }
    expect(pitchSeed(40, 90, 30)).toBe(0.1851932406425476);
    expect(pitchSeed(120, 50, 120)).toBe(0.1125783920288086);
  });
});

describe("facadeDetailFor — worked example", () => {
  it("classifies the example as masonry", () => {
    expect(archetypeFor(MASONRY_LOT)).toBe(FacadeArchetype.MASONRY);
  });

  it("puts a fire escape on the street side only, never on a party wall", () => {
    const { boxes } = facadeDetailFor(MASONRY_LOT, CITY_SEED);
    const escapes = boxes.filter((b) => b.kind === "fireEscape");
    expect(escapes.length).toBeGreaterThan(10);
    for (const b of boxes) {
      expect(b.axis).toBe("x");
      expect(b.dir).toBe(-1);
      expect(b.plane).toBe(420);
    }
  });

  it("leaves a holed axis bare (the signage rule)", () => {
    const holed: Building = {
      ...MASONRY_LOT,
      holes: [
        {
          kind: "tunnel",
          axis: "x",
          tierIndex: 0,
          offset: 0,
          y0: 6,
          width: 30,
          height: 20,
        },
      ],
    };
    expect(facadeDetailFor(holed, CITY_SEED).boxes).toHaveLength(0);
  });
});

describe("facadeDetailFor — seed-42 city", () => {
  it("is deterministic", () => {
    for (const { b, d } of layouts.slice(0, 120)) {
      expect(JSON.stringify(facadeDetailFor(b, CITY_SEED))).toBe(
        JSON.stringify(d),
      );
    }
  });

  it("grows every kind of detail somewhere, and nothing on glass", () => {
    const kinds = new Map<string, number>();
    for (const { b, d } of layouts) {
      if (archetypeFor(b) === FacadeArchetype.GLASS) {
        expect(all(d)).toHaveLength(0);
      }
      for (const box of d.boxes)
        kinds.set(box.kind, (kinds.get(box.kind) ?? 0) + 1);
    }
    expect(kinds.get("fireEscape") ?? 0).toBeGreaterThan(1000);
    expect(kinds.get("balcony") ?? 0).toBeGreaterThan(1000);
    expect(kinds.get("ac") ?? 0).toBeGreaterThan(500);
    expect(kinds.get("scaffold") ?? 0).toBeGreaterThan(50);
    // Most masonry lots with street frontage carry a fire escape.
    const masonry = layouts.filter(
      ({ b }) => archetypeFor(b) === FacadeArchetype.MASONRY,
    );
    const escaped = masonry.filter(({ d }) =>
      d.boxes.some((x) => x.kind === "fireEscape"),
    );
    expect(escaped.length / masonry.length).toBeGreaterThan(0.5);
  });

  it("never stands more than 1.5 m off its facade, nor below DETAIL_MIN_Y", () => {
    for (const { b, d } of layouts) {
      for (const box of all(d)) {
        const { min, max } = detailBounds(box);
        const lo = box.axis === "x" ? min.x : min.z;
        const hi = box.axis === "x" ? max.x : max.z;
        // Outward distance of both faces of the box from the plane.
        const out = [(lo - box.plane) * box.dir, (hi - box.plane) * box.dir];
        expect(Math.min(...out)).toBeGreaterThanOrEqual(-1e-9);
        expect(Math.max(...out)).toBeLessThanOrEqual(MAX_PROTRUSION + 1e-9);
        expect(min.y).toBeGreaterThanOrEqual(DETAIL_MIN_Y - 1e-9);
        // ...and inside its own tier's height span and along-face extent.
        const tier = b.tiers[box.tierIndex];
        expect(tier).toBeDefined();
        if (!tier) continue;
        const base = b.tiers
          .slice(0, box.tierIndex)
          .reduce((s, t) => s + t.height, 0);
        expect(max.y).toBeLessThanOrEqual(base + tier.height);
        const halfAlong = (box.axis === "x" ? tier.depth : tier.width) / 2;
        const c = box.axis === "x" ? b.z : b.x;
        expect(box.axis === "x" ? min.z : min.x).toBeGreaterThanOrEqual(
          c - halfAlong,
        );
        expect(box.axis === "x" ? max.z : max.x).toBeLessThanOrEqual(
          c + halfAlong,
        );
      }
    }
  });

  it("stays off hole mouths, signs and canopies", () => {
    for (const { b, d } of layouts) {
      const boxes = all(d);
      if (boxes.length === 0) continue;
      // Holes: no box on a face of a holed tier along the hole's axis.
      for (const h of b.holes ?? []) {
        expect(
          boxes.some((x) => x.tierIndex === h.tierIndex && x.axis === h.axis),
        ).toBe(false);
      }
      // Signs: no box intersects a sign panel's volume.
      const sign = signageFor(b, CITY_SEED);
      const panels = [...sign.marquees, ...sign.billboards, ...sign.strips];
      // Canopy: a slab over the sidewalk, also never intersected.
      const canopy = facadeGarnishFor(b).canopy;
      for (const box of boxes) {
        const { min, max } = detailBounds(box);
        for (const s of panels) {
          if (s.axis !== box.axis || s.dir !== box.dir) continue;
          const dd = wrapDelta(
            { x: b.x, y: 0, z: b.z },
            { x: s.x, y: 0, z: s.z },
          );
          const along = box.axis === "x" ? b.z + dd.z : b.x + dd.x;
          const lo = box.axis === "x" ? min.z : min.x;
          const hi = box.axis === "x" ? max.z : max.x;
          const hit =
            lo < along + s.width / 2 &&
            along - s.width / 2 < hi &&
            min.y < s.y + s.height &&
            s.y < max.y;
          expect(hit).toBe(false);
        }
        if (canopy) {
          expect(min.y).toBeGreaterThan(canopy.y + 0.6);
        }
      }
    }
  });

  it("only scaffolds buildings across a street from a crane site", () => {
    const wrap = (v: number) => ((v % CITY_GRID) + CITY_GRID) % CITY_GRID;
    for (const { b, d } of layouts) {
      if (!d.boxes.some((x) => x.kind === "scaffold")) continue;
      const { bx, bz } = blockOf({ x: b.x, y: 0, z: b.z });
      const beside = CONSTRUCTION_BLOCKS.some(
        ([cx, cz]) =>
          Math.min(wrap(bx - cx), wrap(cx - bx)) +
            Math.min(wrap(bz - cz), wrap(cz - bz)) ===
          1,
      );
      expect(beside).toBe(true);
      expect(d.lights.length).toBeGreaterThan(0);
    }
  });

  it("keeps every camera window under the instance budget", () => {
    const perBlock = new Map<number, number>();
    for (const { b, d } of layouts) {
      const { bx, bz } = blockOf({ x: b.x, y: 0, z: b.z });
      const k = bx * CITY_GRID + bz;
      perBlock.set(k, (perBlock.get(k) ?? 0) + all(d).length);
    }
    let worst = 0;
    for (let bx = 0; bx < CITY_GRID; bx++) {
      for (let bz = 0; bz < CITY_GRID; bz++) {
        const p = { x: (bx + 0.5) * 200, y: 0, z: (bz + 0.5) * 200 };
        const n = blockWindow(p).reduce(
          (s, w) => s + (perBlock.get(w.bx * CITY_GRID + w.bz) ?? 0),
          0,
        );
        worst = Math.max(worst, n);
      }
    }
    // 12 triangles a box: 24k boxes is < 300k triangles in the worst window.
    expect(worst).toBeLessThan(24_000);
  });
});
