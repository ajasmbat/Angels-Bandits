// Street traffic (V3): deterministic cosmetic cars on the street grid.
// Purely visual — zero netcode, zero collision, zero server involvement.
// Every car's pose is a PURE FUNCTION of (lane, car index, server time, seed),
// so all clients — late joiners included — see identical traffic with no
// per-frame integration state to drift. Same pure-layout/renderer split as
// streetlights.ts: the exported functions are the tested seam.

import { mulberry32 } from "@angels-bandits/common/city";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";

/** Sideways offset of each lane from its street centerline, meters. */
const LANE_OFFSET = 3;
/** Cars on every lane. 40 lanes × 4 = 160 cars total (~the plan's ~150). */
export const CARS_PER_LANE = 4;
/** Speed band from the plan, m/s — one shared speed per lane, so the fixed
 * phase offsets keep cars in a lane from ever overlapping. */
const SPEED_MIN = 8;
const SPEED_SPAN = 6;
/** Even car spacing along a lane, meters. */
const SPACING = WORLD_SIZE / CARS_PER_LANE;
/** Per-car phase jitter, ± meters. Must stay < SPACING/2 minus a car length
 * so the in-lane no-overlap guarantee holds (worst-case gap 200 m). */
const PHASE_JITTER = 150;

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

/** A car's rendered state: canonical ground position + heading. Forward is
 * −Z at yaw 0 — the same convention the planes use. */
export interface CarPose {
  pos: Vec3;
  yaw: number;
}

/** The lane's PRNG stream: draw 0 is the lane speed, draws 1..CARS_PER_LANE
 * are the per-car phase jitters. Seeded from world seed + lane id. */
const laneRand = (lane: TrafficLane, seed: number): (() => number) =>
  mulberry32((seed + lane.id) >>> 0);

/** Shared speed of every car on `lane`, m/s, in [SPEED_MIN, SPEED_MIN + SPEED_SPAN]. */
export function laneSpeed(lane: TrafficLane, seed: number): number {
  return SPEED_MIN + laneRand(lane, seed)() * SPEED_SPAN;
}

const YAW_BY_HEADING: Record<string, number> = {
  "z,1": Math.PI, // +Z
  "z,-1": 0, // −Z (forward at yaw 0)
  "x,1": -Math.PI / 2, // +X
  "x,-1": Math.PI / 2, // −X
};

/**
 * The pose of car `carIndex` on `lane` at server time `timeSeconds` — a pure
 * function, so every client (late joiners included) computes identical
 * traffic from its synced clock. No integration state, nothing to drift.
 */
export function carPose(
  lane: TrafficLane,
  carIndex: number,
  timeSeconds: number,
  seed: number,
): CarPose {
  const rand = laneRand(lane, seed);
  const speed = SPEED_MIN + rand() * SPEED_SPAN;
  let jitter = 0;
  for (let i = 0; i <= carIndex; i++) jitter = (rand() * 2 - 1) * PHASE_JITTER;
  const along = carIndex * SPACING + jitter + lane.dir * speed * timeSeconds;
  const pos = canonicalize(
    lane.axis === "x"
      ? { x: along, y: 0, z: lane.cross }
      : { x: lane.cross, y: 0, z: along },
  );
  return { pos, yaw: YAW_BY_HEADING[`${lane.axis},${lane.dir}`] };
}
