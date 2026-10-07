// N1 nature (V1, ANGE-6OM7QM): the tests N1 never committed. natureFor() is
// the one seam the renderer and collision both read, so it has to be
// deterministic, keep every tree out of the roadway and off every building,
// and keep the drawn tree inside what collides.
//
// Crown sway sampled at real server times (the actual wind) is pinned in
// wind.test.ts; here the crown is checked against the WORST sway the L9
// amplitude allows — every horizontal direction at full CROWN_SWAY_MAX·k(y)
// — so the box holds whatever the wind does.

import { type Building, generateCity } from "@angels-bandits/common/city";
import {
  type Nature,
  type NatureBox,
  type Tree,
  natureFor,
  treeBoxes,
  treeCollides,
} from "@angels-bandits/common/city/nature";
import { overChannel } from "@angels-bandits/common/city/river";
import { isInRoadway } from "@angels-bandits/common/city/street";
import {
  buildNatureIndex,
  collideNature,
} from "@angels-bandits/common/collision";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { CROWN_DRAW_SCALE, CROWN_SWAY_MAX } from "@angels-bandits/common/wind";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const SEEDS = [CITY_SEED, 7, 913_377];
const worlds = SEEDS.map((seed) => {
  const buildings = generateCity(seed);
  return { seed, buildings, nature: natureFor(seed, buildings) };
});

const f32 = Math.fround;

/** Evenly spread unit vectors (a Fibonacci sphere) plus the two poles —
 * every direction an icosahedron vertex can point in, densely sampled. */
function unitVectors(n: number): { x: number; y: number; z: number }[] {
  const out = [
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
  ];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    out.push({ x: Math.cos(golden * i) * r, y, z: Math.sin(golden * i) * r });
  }
  return out;
}

/** Horizontal footprint overlap of two boxes, torus-aware. */
const overlapsXZ = (
  a: { x: number; z: number; hx: number; hz: number },
  b: { x: number; z: number; hx: number; hz: number },
) =>
  Math.abs(wrapDeltaAxis(a.x, b.x)) < a.hx + b.hx &&
  Math.abs(wrapDeltaAxis(a.z, b.z)) < a.hz + b.hz;

/** A tree's widest horizontal reach as a footprint box. */
const reachOf = (t: Tree) => {
  const r = Math.max(t.canopyR, t.trunkR);
  return { x: t.x, z: t.z, hx: r, hz: r };
};

const corners = (b: NatureBox) =>
  [-1, 1].flatMap((sx) =>
    [-1, 1].map((sz) => ({ x: b.x + sx * b.hx, y: 0, z: b.z + sz * b.hz })),
  );

describe("natureFor is deterministic per seed", () => {
  it("the same seed gives the same nature, a different seed different trees", () => {
    for (const w of worlds) {
      const again = natureFor(w.seed, generateCity(w.seed));
      expect(JSON.stringify(again)).toBe(JSON.stringify(w.nature));
      expect(w.nature.trees.length).toBeGreaterThan(100);
    }
    const [a, b] = worlds as [(typeof worlds)[0], (typeof worlds)[0]];
    expect(JSON.stringify(a.nature.trees)).not.toBe(
      JSON.stringify(b.nature.trees),
    );
  });
});

describe("no tree stands where it must not", () => {
  for (const w of worlds) {
    it(`seed ${w.seed}: no trunk in a roadway or over the river channel`, () => {
      for (const t of w.nature.trees) {
        for (const c of corners(treeBoxes(t).trunk)) {
          expect(isInRoadway(c), `trunk at ${t.x}, ${t.z}`).toBe(false);
          expect(overChannel(c.z), `trunk at ${t.x}, ${t.z}`).toBe(false);
        }
      }
    });

    it(`seed ${w.seed}: no crown or trunk overlaps any building footprint`, () => {
      // Brute force over EVERY building, torus-aware — so it also checks
      // natureFor's own block bucketing, seam blocks included.
      const bad: string[] = [];
      for (const t of w.nature.trees) {
        const reach = reachOf(t);
        for (const b of w.buildings as Building[]) {
          const foot = { x: b.x, z: b.z, hx: b.width / 2, hz: b.depth / 2 };
          if (overlapsXZ(reach, foot)) bad.push(`${t.kind} ${t.x},${t.z}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it(`seed ${w.seed}: trees keep clear of ponds, park lamps, planters and hoardings`, () => {
      const n: Nature = w.nature;
      const bad: string[] = [];
      for (const t of n.trees) {
        const reach = reachOf(t);
        const at = `${t.kind} ${t.x},${t.z}`;
        for (const p of n.ponds) {
          const d = Math.hypot(
            wrapDeltaAxis(p.x, t.x),
            wrapDeltaAxis(p.z, t.z),
          );
          if (d <= p.radius + t.canopyR) bad.push(`${at} over a pond`);
        }
        for (const l of n.lamps) {
          const d = Math.hypot(
            wrapDeltaAxis(l.x, t.x),
            wrapDeltaAxis(l.z, t.z),
          );
          if (d <= t.canopyR) bad.push(`${at} on a park lamp`);
        }
        for (const p of n.planters) {
          if (overlapsXZ(reach, { x: p.x, z: p.z, hx: p.half, hz: p.half })) {
            bad.push(`${at} on a planter`);
          }
        }
        for (const h of n.hoardings) {
          if (overlapsXZ(reach, h)) bad.push(`${at} on a hoarding`);
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("the drawn tree stays inside its treeBoxes (draw == collide)", () => {
  // The renderer (client/src/render/nature.ts) draws the trunk as the unit
  // box scaled to the trunk box, and the crown as a unit-sphere icosahedron
  // shrunk by CROWN_DRAW_SCALE, swayed sideways by at most
  // CROWN_SWAY_MAX·k(vy), then scaled to the canopy box's half-extents and
  // centred in it.
  const dirs = unitVectors(64);
  const sways = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return { x: Math.cos(a), z: Math.sin(a) };
  });

  for (const w of worlds) {
    it(`seed ${w.seed}: every crown at maximum sway fits its canopy box and ellipsoid`, () => {
      let outsideBox = 0;
      let worst = 0;
      for (const tree of w.nature.trees) {
        const { canopy } = treeBoxes(tree);
        const hy = (canopy.y1 - canopy.y0) / 2;
        const cy = (canopy.y0 + canopy.y1) / 2;
        expect(canopy.hx).toBeGreaterThan(0);
        expect(hy).toBeGreaterThan(0);
        for (const v of dirs) {
          const k = Math.min(1, Math.max(0, 0.5 + 0.5 * v.y));
          const amp = CROWN_SWAY_MAX * k;
          for (const s of sways) {
            // The shader's arithmetic, in float32.
            const ux = f32(f32(v.x * CROWN_DRAW_SCALE) + f32(amp * s.x));
            const uy = f32(v.y * CROWN_DRAW_SCALE);
            const uz = f32(f32(v.z * CROWN_DRAW_SCALE) + f32(amp * s.z));
            const wx = ux * canopy.hx;
            const wy = uy * hy;
            const wz = uz * canopy.hz;
            if (
              Math.abs(wx) > canopy.hx ||
              Math.abs(wz) > canopy.hz ||
              cy + wy < canopy.y0 ||
              cy + wy > canopy.y1
            ) {
              outsideBox++;
            }
            worst = Math.max(
              worst,
              (wx / canopy.hx) ** 2 + (wy / hy) ** 2 + (wz / canopy.hz) ** 2,
            );
          }
        }
      }
      expect(outsideBox).toBe(0);
      // Inside the solid ellipsoid with zero slack (float32 rounding aside).
      expect(worst).toBeLessThanOrEqual(1 + 1e-6);
    });

    it(`seed ${w.seed}: the trunk is its own box and reaches into the drawn crown`, () => {
      for (const tree of w.nature.trees) {
        const { trunk, canopy } = treeBoxes(tree);
        // The drawn trunk IS the trunk box: on the ground, the tree's own
        // square post, centred on the tree.
        expect(trunk.y0).toBe(0);
        expect(trunk.x).toBe(tree.x);
        expect(trunk.z).toBe(tree.z);
        expect(trunk.hx).toBe(tree.trunkR);
        expect(trunk.hz).toBe(tree.trunkR);
        // The crown's lowest drawn point (vy = −1 never sways) sits below
        // the trunk's top, so no gap opens between them.
        const hy = (canopy.y1 - canopy.y0) / 2;
        const crownBase = (canopy.y0 + canopy.y1) / 2 - CROWN_DRAW_SCALE * hy;
        expect(trunk.y1).toBeGreaterThan(crownBase);
        expect(trunk.y1).toBeLessThan(canopy.y1);
      }
    });
  }
});

describe("what collides is exactly the solid trees", () => {
  for (const w of worlds) {
    it(`seed ${w.seed}: treeCollides ⇔ membership in the nature index`, () => {
      const index = buildNatureIndex(w.nature);
      const indexed = new Set(index.trees.map((t) => t.tree));
      const street = w.nature.trees.filter((t) => t.kind === "street");
      expect(street.length).toBeGreaterThan(0);
      for (const t of w.nature.trees) {
        expect(indexed.has(t), `${t.kind} ${t.x},${t.z}`).toBe(treeCollides(t));
      }
      // Every solid tree is found through the index's cells at its trunk.
      for (const t of w.nature.trees.filter(treeCollides)) {
        const hit = collideNature(
          { x: t.x, y: t.trunkH / 2, z: t.z },
          0.5,
          index,
        );
        expect(hit).not.toBeNull();
      }
    });
  }
});
