// Street traffic (V3): deterministic cosmetic cars on the street grid.
// Purely visual — zero netcode, zero collision, zero server involvement.
// Every car's pose is a PURE FUNCTION of (lane, car index, server time, seed),
// so all clients — late joiners included — see identical traffic with no
// per-frame integration state to drift. Same pure-layout/renderer split as
// streetlights.ts: the exported functions are the tested seam.

import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import { canonicalize } from "@angels-bandits/common/world";

/** Sideways offset of each lane from its street centerline, meters. */
const LANE_OFFSET = 3;

/** One directed traffic lane: a full torus loop parallel to a street line. */
export interface TrafficLane {
  /** Stable id, used to seed this lane's PRNG stream. */
  id: number;
  /** World axis the lane runs along ('z' lanes belong to north–south streets). */
  axis: "x" | "z";
  /** Canonical coordinate on the OTHER axis (centerline ± LANE_OFFSET). */
  cross: number;
  /** Direction of travel along `axis`. */
  dir: 1 | -1;
}

/**
 * The full lane graph, deterministic from the block grid: every street line
 * (each BLOCK_PITCH multiple, both axes) carries two lanes offset
 * ±LANE_OFFSET from the centerline, driving opposite directions — right-hand
 * traffic. Lanes are complete torus loops of length WORLD_SIZE.
 */
export function trafficLanes(): TrafficLane[] {
  const grid = WORLD_SIZE / BLOCK_PITCH;
  const lanes: TrafficLane[] = [];
  for (let line = 0; line < grid; line++) {
    const center = line * BLOCK_PITCH;
    // canonicalize wraps line 0's negative-side lane to WORLD_SIZE − offset.
    const minus = canonicalize({ x: center - LANE_OFFSET, y: 0, z: 0 }).x;
    const plus = center + LANE_OFFSET;
    lanes.push(
      { id: lanes.length, axis: "z", cross: minus, dir: -1 },
      { id: lanes.length + 1, axis: "z", cross: plus, dir: 1 },
    );
  }
  for (let line = 0; line < grid; line++) {
    const center = line * BLOCK_PITCH;
    const minus = canonicalize({ x: center - LANE_OFFSET, y: 0, z: 0 }).x;
    const plus = center + LANE_OFFSET;
    lanes.push(
      { id: lanes.length, axis: "x", cross: minus, dir: 1 },
      { id: lanes.length + 1, axis: "x", cross: plus, dir: -1 },
    );
  }
  return lanes;
}
