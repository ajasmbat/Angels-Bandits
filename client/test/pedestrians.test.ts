// The L1 pedestrian seam: static layout and time-parameterised pose, both
// pure. Worked examples use the shipped constants (CITY_GRID 10, the walkable
// band 16.9 … 19.2 m, PED_MIN 30 / PED_MAX 130 on a squared district heat).

import { CITY_GRID } from "@angels-bandits/common/city";
import { LOT_LINE, isInRoadway } from "@angels-bandits/common/city/street";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import { wrapDelta, wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  PED_MAX,
  PED_MIN,
  blockPedestrians,
  pedestrianCount,
  pedestrianPose,
} from "../src/render/pedestrians";
import { blockHeat } from "../src/render/signage";
import {
  PED_BAND_MAX,
  PED_BAND_MIN,
  microGate,
  microKeep,
} from "../src/render/streetlife";
import { nearestImage } from "../src/render/wrapPlacement";

const SEED = 42;

const offCenter = (v: number) => {
  const m = ((v % BLOCK_PITCH) + BLOCK_PITCH) % BLOCK_PITCH;
  return Math.min(m, BLOCK_PITCH - m);
};

describe("blockPedestrians", () => {
  it("is deterministic: same (seed, block) twice ⇒ identical layout", () => {
    const a = blockPedestrians(3, 7, SEED);
    const b = blockPedestrians(3, 7, SEED);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("depends on the seed and on the block", () => {
    expect(JSON.stringify(blockPedestrians(3, 7, SEED))).not.toBe(
      JSON.stringify(blockPedestrians(3, 7, SEED + 1)),
    );
    // Different blocks differ in their per-person draws, not merely in count.
    const a = blockPedestrians(3, 7, SEED)[0];
    const b = blockPedestrians(4, 7, SEED)[0];
    expect(a?.base).not.toBe(b?.base);
  });

  it("places everyone inside the walkable band", () => {
    for (const spec of blockPedestrians(5, 5, SEED)) {
      expect(spec.d).toBeGreaterThanOrEqual(PED_BAND_MIN);
      expect(spec.d).toBeLessThanOrEqual(PED_BAND_MAX);
      expect(spec.speed).toBeGreaterThanOrEqual(0);
      expect(spec.base).toBeGreaterThanOrEqual(0);
      expect(spec.base).toBeLessThan(spec.perimeter);
    }
  });

  it("leaves roughly the intended fraction standing still", () => {
    let people = 0;
    let standing = 0;
    for (let bx = 0; bx < CITY_GRID; bx++) {
      for (let bz = 0; bz < CITY_GRID; bz++) {
        for (const s of blockPedestrians(bx, bz, SEED)) {
          people++;
          if (s.speed === 0) standing++;
        }
      }
    }
    expect(standing / people).toBeGreaterThan(0.06);
    expect(standing / people).toBeLessThan(0.2);
  });
});

describe("pedestrianCount — the district gradient", () => {
  it("spans PED_MIN to PED_MAX end to end", () => {
    const counts: number[] = [];
    for (let bx = 0; bx < CITY_GRID; bx++) {
      for (let bz = 0; bz < CITY_GRID; bz++)
        counts.push(pedestrianCount(bx, bz));
    }
    expect(Math.min(...counts)).toBe(PED_MIN);
    expect(Math.max(...counts)).toBe(PED_MAX);
  });

  it("puts materially more people on core blocks than outskirt blocks", () => {
    // Asserted on MEDIANS, not on the two extremes: blockHeat is quantised to
    // four values, and a linear mix would put 98 of 100 blocks within 1.55× of
    // each other — a test on the extremes alone would pass while a player saw
    // a flat city.
    const hot: number[] = [];
    const cold: number[] = [];
    for (let bx = 0; bx < CITY_GRID; bx++) {
      for (let bz = 0; bz < CITY_GRID; bz++) {
        const n = pedestrianCount(bx, bz);
        if (blockHeat(bx, bz) >= 2 / 3) hot.push(n);
        else if (blockHeat(bx, bz) <= 1 / 3) cold.push(n);
      }
    }
    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
    expect(hot.length).toBeGreaterThan(0);
    expect(cold.length).toBeGreaterThan(0);
    expect(median(hot)).toBeGreaterThan(1.7 * median(cold));
  });

  it("agrees with the crowd the layout actually produces", () => {
    expect(blockPedestrians(2, 3, SEED)).toHaveLength(pedestrianCount(2, 3));
  });
});

describe("pedestrianPose", () => {
  const specs = blockPedestrians(5, 5, SEED);

  it("is deterministic at a pinned server time", () => {
    const at = 12_345.678;
    expect(JSON.stringify(specs.map((s) => pedestrianPose(s, at)))).toBe(
      JSON.stringify(specs.map((s) => pedestrianPose(s, at))),
    );
  });

  it("NEVER puts anyone in the roadway — every block, every walker, over time", () => {
    for (let bx = 0; bx < CITY_GRID; bx += 3) {
      for (let bz = 0; bz < CITY_GRID; bz += 3) {
        for (const spec of blockPedestrians(bx, bz, SEED)) {
          for (const t of [0, 7.5, 61, 340.25, 3600]) {
            const p = pedestrianPose(spec, t);
            expect(isInRoadway(p.pos)).toBe(false);
          }
        }
      }
    }
  });

  it("keeps everyone out of the buildings too — inside the lot line", () => {
    for (const spec of specs) {
      for (const t of [0, 33, 500.5]) {
        const p = pedestrianPose(spec, t);
        const near = Math.min(offCenter(p.pos.x), offCenter(p.pos.z));
        expect(near).toBeLessThan(LOT_LINE);
      }
    }
  });

  it("loops forever: a walker returns to its start after one lap", () => {
    const walker = specs.find((s) => s.speed > 0);
    expect(walker).toBeDefined();
    if (!walker) return;
    const lap = walker.perimeter / walker.speed;
    const a = pedestrianPose(walker, 100);
    const b = pedestrianPose(walker, 100 + lap);
    expect(b.pos.x).toBeCloseTo(a.pos.x, 5);
    expect(b.pos.z).toBeCloseTo(a.pos.z, 5);
  });

  it("holds standers still and bobs walkers", () => {
    const stander = specs.find((s) => s.speed === 0);
    const walker = specs.find((s) => s.speed > 0);
    if (stander) {
      expect(pedestrianPose(stander, 0).bob).toBe(0);
      const a = pedestrianPose(stander, 0);
      const b = pedestrianPose(stander, 900);
      expect(b.pos.x).toBeCloseTo(a.pos.x, 9);
      expect(b.pos.z).toBeCloseTo(a.pos.z, 9);
      expect(b.yaw).toBe(a.yaw);
    }
    if (walker) {
      // Bob is keyed to distance walked, so it cycles within a few strides.
      const bobs = [0, 0.2, 0.4, 0.6].map((t) => pedestrianPose(walker, t).bob);
      expect(Math.max(...bobs)).toBeGreaterThan(0);
      expect(Math.max(...bobs)).toBeLessThan(0.06);
    }
  });
});

describe("torus seam correctness", () => {
  it("draws a near-seam pedestrian NEXT to the viewer, not 2 km away", () => {
    // The classic regression: block (0,0)'s ring hugs x ≈ 17 and z ≈ 17, so a
    // viewer just the other side of the seam is a couple of dozen meters away
    // ACROSS it — never ~1978 m the long way round.
    const viewer = { x: WORLD_SIZE - 5, y: 0, z: WORLD_SIZE - 5 };
    const specs = blockPedestrians(0, 0, SEED);
    expect(specs.length).toBeGreaterThan(0);
    let sawNearSide = false;
    for (const spec of specs) {
      for (const t of [0, 10, 250]) {
        const pose = pedestrianPose(spec, t);
        const drawn = nearestImage(viewer, pose.pos);
        const dist = Math.hypot(drawn.x - viewer.x, drawn.z - viewer.z);
        // The drawn image must agree with the torus metric, always.
        expect(dist).toBeCloseTo(wrapDistance(viewer, pose.pos), 6);
        // ...and be the NEAR image: at most half a world away on each axis.
        expect(Math.abs(drawn.x - viewer.x)).toBeLessThanOrEqual(
          WORLD_SIZE / 2,
        );
        expect(Math.abs(drawn.z - viewer.z)).toBeLessThanOrEqual(
          WORLD_SIZE / 2,
        );
        // The block is 200 m on a side, so nobody on it is ever far.
        expect(dist).toBeLessThan(BLOCK_PITCH * 1.5);
        if (dist < 40) sawNearSide = true;
      }
    }
    // Somebody really is a few dozen meters away across the seam — the check
    // above would pass vacuously if the ring never came near the corner.
    expect(sawNearSide).toBe(true);
  });

  it("steps by 2ε across the seam, not by WORLD_SIZE − 2ε", () => {
    const eps = 3;
    const d = wrapDelta(
      { x: WORLD_SIZE - eps, y: 0, z: 0 },
      { x: eps, y: 0, z: 0 },
    );
    expect(d.x).toBeCloseTo(2 * eps, 9);
  });
});

describe("the altitude gate over a real crowd", () => {
  it("draws nobody above the cutoff", () => {
    const specs = blockPedestrians(5, 5, SEED);
    for (const y of [140, 180, 400, 900]) {
      const k = microGate(y);
      expect(k).toBe(0);
      expect(specs.filter((_, i) => microKeep(i, k))).toHaveLength(0);
    }
  });

  it("draws everybody below the full-detail altitude", () => {
    const specs = blockPedestrians(5, 5, SEED);
    for (const y of [0, 40, 100]) {
      const k = microGate(y);
      expect(specs.filter((_, i) => microKeep(i, k))).toHaveLength(
        specs.length,
      );
    }
  });

  it("thins smoothly through the band", () => {
    const specs = blockPedestrians(5, 5, SEED);
    let prev = specs.length + 1;
    for (let y = 100; y <= 140; y += 5) {
      const k = microGate(y);
      const n = specs.filter((_, i) => microKeep(i, k)).length;
      expect(n).toBeLessThanOrEqual(prev);
      prev = n;
    }
    expect(prev).toBe(0);
  });
});
