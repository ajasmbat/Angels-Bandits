// pickRespawn seam: torus-aware farthest-from-enemies spawn sampling.
// The RNG is injected, so candidate points are chosen by the test and the
// expected winner is worked out by hand with wrapDistance in mind.

import {
  RESPAWN_ALTITUDE,
  RESPAWN_SPEED,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { pickRespawn } from "../src/respawn";

/** RNG stub yielding a fixed sequence (repeating its last value when drained). */
const seq = (values: number[]): (() => number) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] as number;
};

describe("pickRespawn", () => {
  it("scores a candidate near x=0 as CLOSE to an enemy at x=1990 (the seam is not distance)", () => {
    // Candidates (x, z as fractions of WORLD_SIZE = 2000):
    //   A = (10, 1000)  — raw |Δx| to the enemy is 1980, but on the torus it
    //                     is only 20 m away: A must lose.
    //   B = (1000, 1000) — 990 m from the enemy: B must win.
    // pickRespawn draws x,z per candidate, then one final yaw draw.
    const enemy = { x: 1990, y: 300, z: 1000 };
    const rand = seq([
      10 / WORLD_SIZE,
      1000 / WORLD_SIZE, // candidate A
      1000 / WORLD_SIZE,
      1000 / WORLD_SIZE, // candidate B
      // remaining candidate draws repeat B's z → duplicates of B, harmless
    ]);
    const spawn = pickRespawn([enemy], rand);
    expect(spawn.pos.x).toBeCloseTo(1000, 6);
    expect(spawn.pos.z).toBeCloseTo(1000, 6);
  });

  it("maximizes the MINIMUM enemy distance, not the average", () => {
    // Enemies at x=200 and x=1000 (z=1000). Candidates:
    //   A = (600, 1000): min(400, 400) = 400
    //   B = (1800, 1000): distances 400 (torus: 200←1800 wraps) and 800 → min 400
    //   C = (100, 1000): min(100, 900) = 100 — closest approach, must lose
    // A and B tie on the min; the first best (A) wins. C never can.
    const enemies = [
      { x: 200, y: 300, z: 1000 },
      { x: 1000, y: 300, z: 1000 },
    ];
    const rand = seq([
      100 / WORLD_SIZE,
      1000 / WORLD_SIZE, // C first
      600 / WORLD_SIZE,
      1000 / WORLD_SIZE, // then A
    ]);
    const spawn = pickRespawn(enemies, rand);
    expect(spawn.pos.x).toBeCloseTo(600, 6);
  });

  it("spawns airborne at mid altitude and combat speed, never on the ground", () => {
    const spawn = pickRespawn([], seq([0.5]));
    expect(spawn.pos.y).toBe(RESPAWN_ALTITUDE);
    expect(spawn.speed).toBe(RESPAWN_SPEED);
    expect(spawn.pos.x).toBeGreaterThanOrEqual(0);
    expect(spawn.pos.x).toBeLessThan(WORLD_SIZE);
  });
});
