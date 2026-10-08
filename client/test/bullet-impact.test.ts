// D1 bullet impacts: the pure classifier — which building, face and window
// cell a bullet step strikes, and whether it struck a pane. The window cell
// must be the one the building SHADER paints under that point (the parent
// tier's frame, the bit-exact jittered pitch), and the answer must not
// depend on which side of the torus seam it is seen from.

import type { Building } from "@angels-bandits/common/city";
import { buildCityIndex } from "@angels-bandits/common/collision";
import { describe, expect, it } from "vitest";
import {
  FacadeFace,
  classifyBulletStep,
  closestApproachT,
  createBulletImpact,
  facadeCellCentre,
  tierPitch,
} from "../src/game/bullet-impact";
import { FacadeArchetype, archetypeFor } from "../src/render/archetypes";
import { FACADE, ROOF } from "../src/render/window-pattern";

/** A slim 40 m-wide, 90 m slab — a GLASS curtain-wall (height/side ≥ 1.4). */
const slab = (x: number, z: number): Building => ({
  x,
  z,
  width: 40,
  depth: 30,
  height: 90,
  tiers: [{ width: 40, depth: 30, height: 90 }],
});

const classify = (city: Building[], from: object, to: object) => {
  const out = createBulletImpact();
  const ok = classifyBulletStep(
    from as never,
    to as never,
    city,
    buildCityIndex(city),
    out,
  );
  return ok ? out : null;
};

describe("classifyBulletStep — facades", () => {
  const b = slab(500, 500);
  const [px, py] = tierPitch(b, 0);

  it("is a GLASS slab with a jittered pitch near the archetype's", () => {
    expect(archetypeFor(b)).toBe(FacadeArchetype.GLASS);
    expect(px / FACADE.glass.pitch[0]).toBeGreaterThan(0.83);
    expect(px / FACADE.glass.pitch[0]).toBeLessThan(1.17);
    expect(py / FACADE.glass.pitch[1]).toBeGreaterThan(0.83);
    expect(py / FACADE.glass.pitch[1]).toBeLessThan(1.17);
  });

  it("finds the +x face's cell at a pane centre, in the parent-tier frame", () => {
    // Cell (2, 5): run from the tier centre along z, height from its base.
    const run = (2 + 0.5) * px;
    const y = (5 + 0.5) * py;
    const hit = classify(
      [b],
      { x: 540, y, z: 500 + run },
      { x: 515, y, z: 500 + run },
    );
    expect(hit?.surface).toBe("facade");
    expect(hit?.face).toBe(FacadeFace.PX);
    expect(hit?.normal).toEqual({ x: 1, y: 0, z: 0 });
    expect(hit?.cellX).toBe(2);
    expect(hit?.cellY).toBe(5);
    expect(hit?.pane).toBe(true);
    expect(hit?.point.x).toBeCloseTo(520, 9);
  });

  it("signs the run: a −z face cell left of centre is negative", () => {
    const run = (-3 + 0.5) * px;
    const y = (4 + 0.5) * py;
    const hit = classify(
      [b],
      { x: 500 + run, y, z: 470 },
      { x: 500 + run, y, z: 490 },
    );
    expect(hit?.face).toBe(FacadeFace.NZ);
    expect(hit?.cellX).toBe(-3);
    expect(hit?.cellY).toBe(4);
  });

  it("a mullion, the roof band and the shop band are not panes", () => {
    // Mullion: the very edge of a cell (GLASS panes are 87 % wide).
    const edge = classify(
      [b],
      { x: 540, y: 5.5 * py, z: 500 + 2.01 * px },
      { x: 515, y: 5.5 * py, z: 500 + 2.01 * px },
    );
    expect(edge?.surface).toBe("facade");
    expect(edge?.pane).toBe(false);
    // R2: the top row whose top crosses height − windowBand is spandrel.
    const topRow = Math.floor((90 - ROOF.windowBand) / py);
    const roofBand = classify(
      [b],
      { x: 540, y: (topRow + 0.5) * py, z: 500 + 0.5 * px },
      { x: 515, y: (topRow + 0.5) * py, z: 500 + 0.5 * px },
    );
    expect(roofBand?.cellY).toBe(topRow);
    expect(roofBand?.pane).toBe(false);
    // V2 storefronts below 4 m.
    const shop = classify(
      [b],
      { x: 540, y: 2, z: 500 + 0.5 * px },
      { x: 515, y: 2, z: 500 + 0.5 * px },
    );
    expect(shop?.pane).toBe(false);
  });

  it("a roof hit carries no cell", () => {
    const hit = classify(
      [b],
      { x: 505, y: 100, z: 505 },
      { x: 505, y: 80, z: 505 },
    );
    expect(hit?.surface).toBe("roof");
    expect(hit?.face).toBe(-1);
  });

  it("facadeCellCentre is the classifier's inverse", () => {
    const p = facadeCellCentre(b, 0, FacadeFace.PZ, -1, 7, 0.5);
    const hit = classify([b], { x: p.x, y: p.y, z: p.z + 20 }, p);
    // The nudged point is 0.5 m off the wall: step a little further in.
    const hit2 = classify(
      [b],
      { x: p.x, y: p.y, z: p.z + 20 },
      { x: p.x, y: p.y, z: p.z - 1 },
    );
    expect(hit).toBeNull();
    expect(hit2?.face).toBe(FacadeFace.PZ);
    expect(hit2?.cellX).toBe(-1);
    expect(hit2?.cellY).toBe(7);
    expect(hit2?.pane).toBe(true);
  });
});

describe("classifyBulletStep — seam safety", () => {
  it("the same wall hit from across the seam gets the same face and cell", () => {
    // One slab straddling x = 0 (x ∈ [−20, 20]) struck on its −x face at
    // x = −20 ≡ 1980 by a round crossing nothing; and a copy at x = 1000
    // struck the same way. Same building index, face and cell.
    const across = slab(0, 500);
    const plain = slab(1000, 500);
    const [px, py] = tierPitch(across, 0);
    const y = 6.5 * py;
    const z = 500 + 1.5 * px;
    const a = classify([across], { x: 1960, y, z }, { x: 1990, y, z });
    const b = classify([plain], { x: 960, y, z }, { x: 990, y, z });
    expect(a?.face).toBe(FacadeFace.NX);
    expect(a?.building).toBe(b?.building);
    expect(a?.face).toBe(b?.face);
    expect(a?.cellX).toBe(b?.cellX);
    expect(a?.cellY).toBe(b?.cellY);
    expect(a?.pane).toBe(b?.pane);
    expect(a?.point.x).toBeCloseTo(1980, 9);
    // And a round whose step itself wraps the seam: +x face at x = 20.
    const c = classify([across], { x: 40, y, z }, { x: 10, y, z });
    expect(c?.face).toBe(FacadeFace.PX);
    const d = classify([plain], { x: 1040, y, z }, { x: 1010, y, z });
    expect(c?.cellX).toBe(d?.cellX);
    expect(c?.cellY).toBe(d?.cellY);
  });
});

describe("classifyBulletStep — holes", () => {
  it("a hole's inner wall is particles-only (no cell)", () => {
    const b: Building = {
      ...slab(500, 500),
      holes: [
        {
          kind: "arch",
          axis: "x",
          tierIndex: 0,
          offset: 0,
          y0: 10,
          width: 16,
          height: 20,
        },
      ],
    };
    // From the middle of the arch (open air) across to its +z wall at z = 508.
    const hit = classify(
      [b],
      { x: 500, y: 20, z: 500 },
      { x: 500, y: 20, z: 512 },
    );
    expect(hit?.surface).toBe("inner");
    expect(hit?.face).toBe(FacadeFace.NZ);
    // The lintel's underside.
    const up = classify(
      [b],
      { x: 500, y: 20, z: 500 },
      { x: 500, y: 40, z: 500 },
    );
    expect(up?.surface).toBe("underside");
  });
});

describe("closestApproachT", () => {
  it("is the step fraction nearest a point, seam-aware", () => {
    expect(
      closestApproachT(
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 3, y: 5, z: 0 },
      ),
    ).toBeCloseTo(0.3, 9);
    expect(
      closestApproachT(
        { x: 1995, y: 0, z: 0 },
        { x: 5, y: 0, z: 0 },
        { x: 0, y: 2, z: 0 },
      ),
    ).toBeCloseTo(0.5, 9);
  });
});
