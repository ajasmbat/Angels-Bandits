// Traffic model seam: pure deterministic lane graph + car poses — no THREE,
// no netcode. Worked examples use the shipped constants (WORLD_SIZE = 2000,
// BLOCK_PITCH = 200 → 10 street lines per axis): every street line carries two
// lanes on the S1 contract's lane centers, ±5 m from the centerline, opposite
// directions, each a full torus loop.

import { isInRoadway } from "@angels-bandits/common/city/street";
import { wrapDelta } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  CARS_PER_LANE,
  carPose,
  laneSpeed,
  trafficLanes,
} from "../src/render/traffic";

const SEED = 42;

describe("trafficLanes", () => {
  const lanes = trafficLanes();

  it("carries 40 lanes: 10 streets per axis × 2 axes × 2 lanes", () => {
    expect(lanes).toHaveLength(40);
  });

  it("offsets every lane ±5 m from a street centerline, in canonical coords", () => {
    for (const lane of lanes) {
      // cross ± 5 must sit on a BLOCK_PITCH multiple; 1995 wraps line x = 0.
      const onLine = (v: number) => ((v % 200) + 200) % 200 === 0;
      expect(onLine(lane.cross - 5) || onLine(lane.cross + 5)).toBe(true);
      expect(lane.cross).toBeGreaterThanOrEqual(0);
      expect(lane.cross).toBeLessThan(2000);
    }
  });

  it("gives each street one lane per direction on opposite sides", () => {
    // Street line x = 400 (a 'z' axis street): its two lanes sit at 395 and
    // 405 and drive opposite ways.
    const pair = lanes.filter(
      (l) => l.axis === "z" && (l.cross === 395 || l.cross === 405),
    );
    expect(pair).toHaveLength(2);
    expect(pair[0].dir + pair[1].dir).toBe(0);
  });

  it("keeps every car in the roadway (the contract agrees with the lane graph)", () => {
    for (const lane of lanes) {
      for (const t of [0, 987.5]) {
        expect(isInRoadway(carPose(lane, 0, t, SEED).pos)).toBe(true);
      }
    }
  });

  it("assigns every lane a unique stable id", () => {
    expect(new Set(lanes.map((l) => l.id)).size).toBe(lanes.length);
  });
});

describe("carPose", () => {
  const lanes = trafficLanes();

  it("is a pure function: same inputs, same pose", () => {
    for (const lane of lanes.slice(0, 4)) {
      const a = carPose(lane, 1, 123456789.5, SEED);
      const b = carPose(lane, 1, 123456789.5, SEED);
      expect(b).toEqual(a);
    }
  });

  it("keeps every lane's speed in the plan's [8, 14] m/s band", () => {
    for (const lane of lanes) {
      const speed = laneSpeed(lane, SEED);
      expect(speed).toBeGreaterThanOrEqual(8);
      expect(speed).toBeLessThanOrEqual(14);
    }
  });

  it("loops the torus cleanly: pose at t + WORLD_SIZE/speed matches pose at t", () => {
    for (const lane of lanes.slice(0, 8)) {
      const period = 2000 / laneSpeed(lane, SEED);
      for (let i = 0; i < CARS_PER_LANE; i++) {
        const a = carPose(lane, i, 1000, SEED);
        const b = carPose(lane, i, 1000 + period, SEED);
        expect(b.pos.x).toBeCloseTo(a.pos.x, 6);
        expect(b.pos.z).toBeCloseTo(a.pos.z, 6);
        expect(b.yaw).toBe(a.yaw);
      }
    }
  });

  it("stays on its lane: canonical coords, cross axis fixed, y on the street", () => {
    for (const lane of lanes.slice(0, 6)) {
      for (const t of [0, 777.7, 4321]) {
        const { pos } = carPose(lane, 2, t, SEED);
        const along = lane.axis === "x" ? pos.x : pos.z;
        const cross = lane.axis === "x" ? pos.z : pos.x;
        expect(cross).toBe(lane.cross);
        expect(along).toBeGreaterThanOrEqual(0);
        expect(along).toBeLessThan(2000);
        expect(pos.y).toBe(0);
      }
    }
  });

  it("crosses the seam without a jump: WORLD_SIZE - ε to ε is a 2ε step", () => {
    const lane = lanes.find((l) => l.axis === "z" && l.dir === 1);
    if (!lane) throw new Error("lane not found");
    const speed = laneSpeed(lane, SEED);
    const epsilon = 0.5;
    // Locate car 0 via the public seam, then drive it to z = WORLD_SIZE − ε.
    const start = carPose(lane, 0, 0, SEED).pos.z;
    const tBefore = (2000 - epsilon - start) / speed;
    const before = carPose(lane, 0, tBefore, SEED).pos;
    const after = carPose(lane, 0, tBefore + (2 * epsilon) / speed, SEED).pos;
    expect(before.z).toBeCloseTo(2000 - epsilon, 6);
    expect(after.z).toBeCloseTo(epsilon, 6);
    // The shortest torus step between the two poses is 2ε — no 1999 m jump.
    const d = wrapDelta(before, after);
    expect(d.z).toBeCloseTo(2 * epsilon, 6);
    expect(d.x).toBe(0);
  });

  it("never lets cars in a lane overlap: consecutive gaps stay >= 200 m", () => {
    for (const lane of lanes) {
      for (const t of [0, 999.25, 123456]) {
        const along = Array.from({ length: CARS_PER_LANE }, (_, i) => {
          const { pos } = carPose(lane, i, t, SEED);
          return lane.axis === "x" ? pos.x : pos.z;
        }).sort((a, b) => a - b);
        for (let i = 0; i < along.length; i++) {
          const next = along[(i + 1) % along.length];
          const gap = (((next - along[i]) % 2000) + 2000) % 2000 || 2000;
          expect(gap).toBeGreaterThanOrEqual(200 - 1e-6);
        }
      }
    }
  });

  it("faces the lane direction (yaw convention: forward = -Z at yaw 0)", () => {
    // Worked examples: +Z travel → yaw π; -Z → 0; +X → -π/2; -X → π/2.
    const byAxisDir = (axis: "x" | "z", dir: 1 | -1) => {
      const lane = lanes.find((l) => l.axis === axis && l.dir === dir);
      if (!lane) throw new Error("lane not found");
      return carPose(lane, 0, 50, SEED).yaw;
    };
    expect(byAxisDir("z", 1)).toBeCloseTo(Math.PI, 10);
    expect(byAxisDir("z", -1)).toBeCloseTo(0, 10);
    expect(byAxisDir("x", 1)).toBeCloseTo(-Math.PI / 2, 10);
    expect(byAxisDir("x", -1)).toBeCloseTo(Math.PI / 2, 10);
  });
});
