// The L1 shared seam: the block sidewalk ring, the camera block window, and
// the altitude gate. Pure functions, no THREE construction, no DOM. Worked
// examples use the shipped contract (BLOCK_PITCH 200, ROADWAY_HALF 15,
// CURB_LINE 15, FURNITURE_LINE 16, LOT_LINE 20 → the walkable band is
// 16.9 … 19.2 m off a street centerline).

import { CITY_GRID } from "@angels-bandits/common/city";
import {
  CURB_LINE,
  FURNITURE_LINE,
  LOT_LINE,
  isInRoadway,
  nearestStreet,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import { wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  BLOCK_WINDOW_RADIUS,
  GUTTER_LINE,
  MICRO_GATE_FULL,
  MICRO_GATE_OFF,
  PED_BAND_MAX,
  PED_BAND_MIN,
  PED_HALF_WIDTH,
  blockStream,
  blockWindow,
  microGate,
  microKeep,
  ringPerimeter,
  ringPoint,
} from "../src/render/streetlife";
import { streetlampPositions } from "../src/render/streetlights";

/** Every lateral offset the tier actually uses, plus the band's own edges. */
const BAND_OFFSETS = [
  GUTTER_LINE,
  PED_BAND_MIN,
  (PED_BAND_MIN + PED_BAND_MAX) / 2,
  PED_BAND_MAX,
];

describe("the lateral-band contract", () => {
  it("derives every offset from the street contract, all roadway-clear", () => {
    expect(PED_BAND_MIN).toBeGreaterThan(FURNITURE_LINE);
    expect(PED_BAND_MAX).toBeLessThan(LOT_LINE);
    expect(PED_BAND_MIN).toBeLessThan(PED_BAND_MAX);
    for (const d of BAND_OFFSETS) expect(d).toBeGreaterThan(CURB_LINE);
  });
});

describe("ringPoint", () => {
  it("is a closed loop: s and s + perimeter coincide", () => {
    const d = PED_BAND_MIN;
    const per = ringPerimeter(d);
    for (const s of [0, 37, 180.5, per - 0.001]) {
      const a = ringPoint(3, 7, d, s);
      const b = ringPoint(3, 7, d, s + per);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.z).toBeCloseTo(a.z, 6);
    }
  });

  it("is continuous — no step bigger than the sample spacing, corners included", () => {
    const d = PED_BAND_MIN;
    const per = ringPerimeter(d);
    const step = per / 800;
    let prev = ringPoint(0, 0, d, 0);
    for (let i = 1; i <= 800; i++) {
      const p = ringPoint(0, 0, d, i * step);
      // wrapDistance, not raw subtraction: block (0,0)'s ring touches the seam.
      expect(
        wrapDistance({ x: prev.x, y: 0, z: prev.z }, { x: p.x, y: 0, z: p.z }),
      ).toBeLessThan(step * 1.5);
      prev = p;
    }
  });

  it("NEVER lands in the roadway — every block, every band offset, corners included", () => {
    // The corner case is the whole point: a ring corner sits at (d, d), so it
    // is exactly d from BOTH centerlines. d > CURB_LINE makes it clear on both
    // axes by construction rather than by tuning.
    for (let bx = 0; bx < CITY_GRID; bx++) {
      for (let bz = 0; bz < CITY_GRID; bz++) {
        for (const d of BAND_OFFSETS) {
          const per = ringPerimeter(d);
          for (let i = 0; i < 160; i++) {
            const p = ringPoint(bx, bz, d, (i / 160) * per);
            expect(isInRoadway({ x: p.x, y: 0, z: p.z })).toBe(false);
          }
        }
      }
    }
  });

  it("stays on a real sidewalk: d from the nearest centerline, inside the lot line", () => {
    const offCenter = (v: number) => {
      const m = ((v % BLOCK_PITCH) + BLOCK_PITCH) % BLOCK_PITCH;
      return Math.min(m, BLOCK_PITCH - m);
    };
    for (const d of [PED_BAND_MIN, PED_BAND_MAX]) {
      const per = ringPerimeter(d);
      for (let i = 0; i < 200; i++) {
        const p = ringPoint(4, 6, d, (i / 200) * per);
        const near = Math.min(offCenter(p.x), offCenter(p.z));
        expect(near).toBeCloseTo(d, 6);
        // Not merely out of the road — also not inside a building.
        expect(near).toBeLessThan(LOT_LINE);
        // And the street it belongs to is the one it is `d` from.
        const street = nearestStreet({ x: p.x, y: 0, z: p.z });
        expect(["x", "z"]).toContain(street.axis);
      }
    }
  });

  it("wraps into canonical coordinates on the seam blocks", () => {
    for (const d of [PED_BAND_MIN, PED_BAND_MAX]) {
      const per = ringPerimeter(d);
      for (const [bx, bz] of [
        [0, 0],
        [CITY_GRID - 1, CITY_GRID - 1],
      ] as const) {
        for (let i = 0; i < 64; i++) {
          const p = ringPoint(bx, bz, d, (i / 64) * per);
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThan(WORLD_SIZE);
          expect(p.z).toBeGreaterThanOrEqual(0);
          expect(p.z).toBeLessThan(WORLD_SIZE);
        }
      }
    }
  });

  it("keeps a body's clearance from every lamp post on the furniture line", () => {
    // The regression this guards: a ring at exactly FURNITURE_LINE would walk
    // ~31 % of the crowd straight through the lamp row every loop.
    const POLE_RADIUS = 0.16;
    const lamps = streetlampPositions();
    let worst = Number.POSITIVE_INFINITY;
    for (const d of [PED_BAND_MIN, PED_BAND_MAX]) {
      const per = ringPerimeter(d);
      for (let i = 0; i < 200; i++) {
        const p = ringPoint(2, 2, d, (i / 200) * per);
        for (const l of lamps) {
          const gap = wrapDistance(
            { x: p.x, y: 0, z: p.z },
            { x: l.x, y: 0, z: l.z },
          );
          if (gap < worst) worst = gap;
        }
      }
    }
    expect(worst).toBeGreaterThan(PED_HALF_WIDTH + POLE_RADIUS);
  });
});

describe("blockWindow", () => {
  it("returns (2r+1)² DISTINCT blocks — nobody is ever drawn twice", () => {
    const w = blockWindow({ x: 1234, y: 40, z: 567 });
    expect(w).toHaveLength((2 * BLOCK_WINDOW_RADIUS + 1) ** 2);
    expect(new Set(w.map((b) => `${b.bx},${b.bz}`)).size).toBe(w.length);
    expect(2 * BLOCK_WINDOW_RADIUS + 1).toBeLessThanOrEqual(CITY_GRID);
  });

  it("contains the camera's own block", () => {
    const w = blockWindow({ x: 1234, y: 40, z: 567 });
    expect(w).toContainEqual({ bx: 6, bz: 2 });
  });

  it("wraps mod CITY_GRID at the seam, staying distinct", () => {
    const w = blockWindow({ x: 5, y: 40, z: 5 });
    expect(new Set(w.map((b) => `${b.bx},${b.bz}`)).size).toBe(w.length);
    expect(w).toContainEqual({ bx: CITY_GRID - 1, bz: CITY_GRID - 1 });
    expect(w).toContainEqual({ bx: 0, bz: 0 });
    for (const b of w) {
      expect(b.bx).toBeGreaterThanOrEqual(0);
      expect(b.bx).toBeLessThan(CITY_GRID);
      expect(b.bz).toBeGreaterThanOrEqual(0);
      expect(b.bz).toBeLessThan(CITY_GRID);
    }
  });
});

describe("microGate", () => {
  it("is 1 at or below the full-detail altitude and 0 at or above the cutoff", () => {
    expect(microGate(0)).toBe(1);
    expect(microGate(MICRO_GATE_FULL)).toBe(1);
    expect(microGate(MICRO_GATE_OFF)).toBe(0);
    expect(microGate(400)).toBe(0);
  });

  it("falls monotonically across the fade band", () => {
    let prev = 1.0001;
    for (let y = MICRO_GATE_FULL; y <= MICRO_GATE_OFF; y += 1) {
      const k = microGate(y);
      expect(k).toBeLessThanOrEqual(prev);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
      prev = k;
    }
  });
});

describe("microKeep", () => {
  it("keeps nothing at k = 0 and everything at k = 1", () => {
    for (let i = 0; i < 500; i++) {
      expect(microKeep(i, 0)).toBe(false);
      expect(microKeep(i, 1)).toBe(true);
    }
  });

  it("keeps roughly the requested fraction", () => {
    for (const k of [0.25, 0.5, 0.75]) {
      let kept = 0;
      for (let i = 0; i < 1000; i++) if (microKeep(i, k)) kept++;
      expect(kept / 1000).toBeCloseTo(k, 1);
    }
  });

  it("thins UNIFORMLY along the ring — the bug a plain index threshold has", () => {
    // A walker's station grows with its index, so `i / n < k` would delete one
    // contiguous quarter of every sidewalk at k = 0.75. The golden-ratio
    // sequence is maximally spread, so the largest gap between kept indices
    // stays near the mean spacing.
    const k = 0.5;
    const n = 500;
    const kept: number[] = [];
    for (let i = 0; i < n; i++) if (microKeep(i, k)) kept.push(i);
    let maxGap = kept[0] as number;
    for (let i = 1; i < kept.length; i++) {
      maxGap = Math.max(maxGap, (kept[i] as number) - (kept[i - 1] as number));
    }
    const meanSpacing = n / kept.length;
    expect(maxGap).toBeLessThanOrEqual(3 * meanSpacing);
  });
});

describe("blockStream", () => {
  it("is deterministic and independent per (block, tag)", () => {
    const a = blockStream(42, 3, 4, 1);
    const b = blockStream(42, 3, 4, 1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    // A different tag, block, or seed is a different stream.
    expect(blockStream(42, 3, 4, 1)()).not.toBe(blockStream(42, 3, 4, 2)());
    expect(blockStream(42, 3, 4, 1)()).not.toBe(blockStream(42, 4, 3, 1)());
    expect(blockStream(42, 3, 4, 1)()).not.toBe(blockStream(43, 3, 4, 1)());
  });
});
