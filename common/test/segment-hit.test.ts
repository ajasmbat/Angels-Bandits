// D1: firstSolidHit (a bullet step's first entry into the city) and
// forEachBuildingNear (the blast query). The property test pins the
// classifier to losClear: for any segment that neither starts inside a solid
// nor grazes a face, "enters a solid" and "the sight line is blocked" are
// the same verdict — the two read the same solids with the same clip.

import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import type { Building } from "@angels-bandits/common/city";
import {
  FACE_NX,
  FACE_PY,
  FACE_SIDE,
  buildCityIndex,
  collideCity,
  createSegmentHit,
  firstSolidHit,
  forEachBuildingNear,
  losClear,
} from "@angels-bandits/common/collision";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import { wrapCoord, wrapDelta } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const tower = (x: number, z: number, w = 100, d = 60, h = 120): Building => ({
  x,
  z,
  width: w,
  depth: d,
  height: h,
  tiers: [{ width: w, depth: d, height: h }],
});

describe("firstSolidHit — entry point and face", () => {
  it("enters a tower's −x face at the right t", () => {
    const city = [tower(500, 500)];
    const hit = createSegmentHit();
    const ok = firstSolidHit(
      { x: 400, y: 50, z: 500 },
      { x: 460, y: 50, z: 500 },
      city,
      buildCityIndex(city),
      hit,
    );
    expect(ok).toBe(true);
    expect(hit.building).toBe(0);
    expect(hit.solid).toBe(0);
    expect(hit.face).toBe(FACE_NX);
    expect(hit.t).toBeCloseTo(50 / 60, 9);
  });

  it("is seam-safe: a step across x = 0 enters a tower straddling it", () => {
    const city = [tower(10, 500, 40, 40, 80)]; // x ∈ [−10, 30] ≡ [1990, 30]
    const hit = createSegmentHit();
    const ok = firstSolidHit(
      { x: 1980, y: 50, z: 500 },
      { x: 5, y: 50, z: 500 }, // +25 m through the seam
      city,
      buildCityIndex(city),
      hit,
    );
    expect(ok).toBe(true);
    expect(hit.face).toBe(FACE_NX);
    expect(hit.t).toBeCloseTo(10 / 25, 9);
  });

  it("ignores a step that starts inside a solid", () => {
    const city = [tower(500, 500)];
    const hit = createSegmentHit();
    expect(
      firstSolidHit(
        { x: 500, y: 50, z: 500 },
        { x: 600, y: 50, z: 500 },
        city,
        buildCityIndex(city),
        hit,
      ),
    ).toBe(false);
    expect(hit.building).toBe(-1);
  });

  it("hits a roof from above, and a round roof structure on its curved wall", () => {
    const b = tower(500, 500);
    b.roof = [
      {
        kind: "waterTank",
        dx: 0,
        dz: 0,
        baseY: 120,
        width: 10,
        depth: 10,
        height: 8,
        round: true,
        face: 0,
        seed: 0,
      },
    ];
    const city = [b];
    const index = buildCityIndex(city);
    const hit = createSegmentHit();
    expect(
      firstSolidHit(
        { x: 470, y: 124, z: 500 },
        { x: 510, y: 124, z: 500 },
        city,
        index,
        hit,
      ),
    ).toBe(true);
    expect(hit.structure).toBe(0);
    expect(hit.solid).toBe(-1);
    expect(hit.face).toBe(FACE_SIDE);
    expect(hit.t).toBeCloseTo(25 / 40, 9); // x = 495, the tank's rim
    expect(
      firstSolidHit(
        { x: 460, y: 140, z: 470 },
        { x: 460, y: 100, z: 470 },
        city,
        index,
        hit,
      ),
    ).toBe(true);
    expect(hit.face).toBe(FACE_PY);
    expect(hit.t).toBeCloseTo(20 / 40, 9);
  });

  it("picks the NEARER of two buildings along the step", () => {
    const city = [tower(700, 500, 40, 40), tower(560, 500, 40, 40)];
    const hit = createSegmentHit();
    firstSolidHit(
      { x: 500, y: 50, z: 500 },
      { x: 720, y: 50, z: 500 },
      city,
      buildCityIndex(city),
      hit,
    );
    expect(hit.building).toBe(1);
  });
});

describe("firstSolidHit ⇔ !losClear over the real city", () => {
  const city = generateCity(42);
  const index = buildCityIndex(city);
  const hit = createSegmentHit();

  it("agrees on random bullet-length steps, seam crossings included", () => {
    const rand = mulberry32(0xd1d1);
    let hits = 0;
    let checked = 0;
    for (let n = 0; n < 4000; n++) {
      // Every 4th step starts within 30 m of a seam, heading across it.
      const nearSeam = n % 4 === 0;
      const from = {
        x: nearSeam
          ? wrapCoord(WORLD_SIZE - 15 + rand() * 30)
          : rand() * WORLD_SIZE,
        // Clear of the river's banks, decks and parapets (all near y = 0).
        y: 15 + rand() * 245,
        z: rand() * WORLD_SIZE,
      };
      const len = 5 + rand() * 35;
      const yaw = rand() * Math.PI * 2;
      const pitch = (rand() - 0.5) * 1.2;
      const to = {
        x: wrapCoord(from.x + Math.cos(yaw) * Math.cos(pitch) * len),
        y: from.y + Math.sin(pitch) * len,
        z: wrapCoord(from.z + Math.sin(yaw) * Math.cos(pitch) * len),
      };
      // The whole step stays clear of the river's solids (all near y = 0),
      // and starting inside (or on) a solid is the one documented difference.
      if (to.y < 15) continue;
      if (collideCity(from, 0, city, index)) continue;
      checked++;
      const entered = firstSolidHit(from, to, city, index, hit);
      if (entered) hits++;
      expect(entered, `segment ${n}`).toBe(!losClear(from, to, city));
    }
    expect(checked).toBeGreaterThan(2000);
    expect(hits).toBeGreaterThan(100); // the test reached real facades
  });
});

describe("forEachBuildingNear", () => {
  const city = generateCity(42);
  const index = buildCityIndex(city);

  it("visits exactly the buildings in reach, each once (seam included)", () => {
    const rand = mulberry32(7);
    for (let n = 0; n < 60; n++) {
      const centre = {
        x: n % 3 === 0 ? wrapCoord(rand() * 20 - 10) : rand() * WORLD_SIZE,
        y: 40,
        z: rand() * WORLD_SIZE,
      };
      const r = 35;
      const seen = new Map<number, number>();
      forEachBuildingNear(index, centre, r, (i) => {
        seen.set(i, (seen.get(i) ?? 0) + 1);
      });
      const expected = new Set<number>();
      city.forEach((b, i) => {
        const o = wrapDelta(centre, { x: b.x, y: 0, z: b.z });
        const gx = Math.max(Math.abs(o.x) - b.width / 2, 0);
        const gz = Math.max(Math.abs(o.z) - b.depth / 2, 0);
        if (gx * gx + gz * gz <= r * r) expected.add(i);
      });
      expect([...seen.keys()].sort((a, b) => a - b)).toEqual(
        [...expected].sort((a, b) => a - b),
      );
      for (const count of seen.values()) expect(count).toBe(1);
    }
  });
});
