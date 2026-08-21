// Traffic model seam: pure deterministic lane graph + car poses — no THREE,
// no netcode. Worked examples use the shipped constants (WORLD_SIZE = 2000,
// BLOCK_PITCH = 200 → 10 street lines per axis): every street line carries two
// lanes offset ±3 m from the centerline, opposite directions, each a full
// torus loop.

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

  it("offsets every lane ±3 m from a street centerline, in canonical coords", () => {
    for (const lane of lanes) {
      // cross ± 3 must sit on a BLOCK_PITCH multiple; 1997 wraps line x = 0.
      const onLine = (v: number) => ((v % 200) + 200) % 200 === 0;
      expect(onLine(lane.cross - 3) || onLine(lane.cross + 3)).toBe(true);
      expect(lane.cross).toBeGreaterThanOrEqual(0);
      expect(lane.cross).toBeLessThan(2000);
    }
  });

  it("gives each street one lane per direction on opposite sides", () => {
    // Street line x = 400 (a 'z' axis street): its two lanes sit at 397 and
    // 403 and drive opposite ways.
    const pair = lanes.filter(
      (l) => l.axis === "z" && (l.cross === 397 || l.cross === 403),
    );
    expect(pair).toHaveLength(2);
    expect(pair[0].dir + pair[1].dir).toBe(0);
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
