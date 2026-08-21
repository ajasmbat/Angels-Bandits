// Traffic model seam: pure deterministic lane graph + car poses — no THREE,
// no netcode. Worked examples use the shipped constants (WORLD_SIZE = 2000,
// BLOCK_PITCH = 200 → 10 street lines per axis): every street line carries two
// lanes offset ±3 m from the centerline, opposite directions, each a full
// torus loop.

import { describe, expect, it } from "vitest";
import { trafficLanes } from "../src/render/traffic";

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
