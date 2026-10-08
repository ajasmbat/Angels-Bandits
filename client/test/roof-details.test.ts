// R2 roofs, client side: no skylight grids, and the height rule — anything
// drawn on a roof more than ROOF_CLUTTER_MAX_HEIGHT above the deck belongs
// to a solid roof structure (common's roofStructuresFor), and every
// structure is drawn 1:1 with its collider.

import { type Building, generateCity } from "@angels-bandits/common/city";
import { ROOF_CLUTTER_MAX_HEIGHT } from "@angels-bandits/common/city/roof-structures";
import { CITY_SEED } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { type RoofPart, roofDetailsFor } from "../src/render/roof-details";
import { roofClutterFor } from "../src/render/roof-layout";
import { RoofKind, roofStyleFor } from "../src/render/roofs";

const CITIES = [generateCity(CITY_SEED), generateCity(42), generateCity(7)];
const ALL = CITIES.flat();

/** World AABB of a drawn part: its unit shape (box half-size 0.5, cylinder
 * radius 1, base at y = 0) scaled, tilted, turned and placed. */
function bounds(p: RoofPart, radius: number) {
  const m = new THREE.Matrix4()
    .makeRotationY(p.yaw)
    .multiply(new THREE.Matrix4().makeRotationX(p.tilt))
    .multiply(new THREE.Matrix4().makeScale(p.sx, p.sy, p.sz));
  const lo = new THREE.Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const hi = lo.clone().negate();
  const v = new THREE.Vector3();
  for (const x of [-radius, radius]) {
    for (const y of [0, 1]) {
      for (const z of [-radius, radius]) {
        v.set(x, y, z)
          .applyMatrix4(m)
          .add(new THREE.Vector3(p.x, p.y, p.z));
        lo.min(v);
        hi.max(v);
      }
    }
  }
  return { lo, hi };
}

const partsOf = (b: Building) => {
  const d = roofDetailsFor(b);
  return [
    ...d.boxes.map((p) => ({ p, r: 0.5 })),
    ...d.cylinders.map((p) => ({ p, r: 1 })),
    ...d.lit.map((p) => ({ p, r: 0.5 })),
  ];
};

describe("R2 roofs: no window-like skylights", () => {
  it("roofStyleFor never yields the retired SKYLIGHTS kind (2)", () => {
    expect(Object.values(RoofKind)).not.toContain(2);
    let tiers = 0;
    for (const b of ALL) {
      for (const k of roofStyleFor(b).tierKinds) {
        tiers++;
        expect(Object.values(RoofKind)).toContain(k);
      }
    }
    expect(tiers).toBeGreaterThan(1000);
  });
});

describe("R2 roofs: the height rule", () => {
  it("draws nothing more than 2.5 m above a roof outside a solid roof structure", () => {
    let tall = 0;
    for (const b of ALL) {
      for (const { p, r } of partsOf(b)) {
        const { lo, hi } = bounds(p, r);
        if (hi.y <= b.height + ROOF_CLUTTER_MAX_HEIGHT + 1e-6) continue;
        tall++;
        const pad = 0.1;
        const inside = (b.roof ?? []).some(
          (s) =>
            lo.x >= b.x + s.dx - s.width / 2 - pad &&
            hi.x <= b.x + s.dx + s.width / 2 + pad &&
            lo.z >= b.z + s.dz - s.depth / 2 - pad &&
            hi.z <= b.z + s.dz + s.depth / 2 + pad &&
            lo.y >= s.baseY - pad &&
            hi.y <= s.baseY + s.height + pad,
        );
        expect(inside).toBe(true);
      }
      // HVAC units and masts come from the clutter seam: units under the
      // line, masts only as structures.
      const c = roofClutterFor(b);
      for (const box of c.acBoxes) {
        expect(box.height).toBeLessThanOrEqual(ROOF_CLUTTER_MAX_HEIGHT);
      }
      expect(c.masts.length).toBe(
        (b.roof ?? []).filter((s) => s.kind === "mast").length,
      );
    }
    expect(tall).toBeGreaterThan(100);
  });

  it("draws every structure's body exactly where it collides", () => {
    for (const b of ALL) {
      const d = roofDetailsFor(b);
      for (const s of b.roof ?? []) {
        if (s.kind === "mast") continue; // roofclutter's mast mesh, from c.masts
        const list = s.round ? d.cylinders : d.boxes;
        const body = list.find(
          (p) =>
            p.solid &&
            p.x === b.x + s.dx &&
            p.z === b.z + s.dz &&
            p.y === s.baseY,
        );
        expect(body).toBeDefined();
        if (!body) continue;
        // Round bodies scale a radius-1 cylinder; boxes a unit box.
        expect(body.sx).toBeCloseTo(s.round ? s.width / 2 : s.width, 9);
        expect(body.sz).toBeCloseTo(s.round ? s.depth / 2 : s.depth, 9);
        // A cooling tower's top COOLING_SHROUD is its (GPU-spun) fan.
        expect(body.sy).toBeLessThanOrEqual(s.height);
        expect(body.sy).toBeGreaterThan(s.height - 0.75);
      }
    }
  });

  it("is deterministic: two independently generated cities dress alike", () => {
    // Fresh Building objects, so the per-building cache cannot answer twice.
    const again = generateCity(CITY_SEED);
    (CITIES[0] as Building[]).forEach((b, i) => {
      expect(JSON.stringify(roofDetailsFor(again[i] as Building))).toBe(
        JSON.stringify(roofDetailsFor(b)),
      );
    });
  });
});
