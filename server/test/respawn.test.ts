// pickRespawn seam: torus-aware near-the-fight spawn sampling (U2 band).
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
  it("measures the band across the seam (the seam is not distance)", () => {
    // Candidates (x, z as fractions of WORLD_SIZE = 2000), band middle 500 m:
    //   A = (490, 1000)  — raw |Δx| to the enemy is 1500, but on the torus it
    //                      is 500 m away, dead on the band: A must win.
    //   B = (1000, 1000) — 990 m from the enemy either way (raw would win).
    // pickRespawn draws x,z per candidate, then one final yaw draw.
    const enemy = { pos: { x: 1990, y: 300, z: 1000 }, fwd: null };
    const rand = seq([
      490 / WORLD_SIZE,
      1000 / WORLD_SIZE, // candidate A
      1000 / WORLD_SIZE,
      1000 / WORLD_SIZE, // candidate B
      // remaining candidate draws repeat B's z → duplicates of B, harmless
    ]);
    const spawn = pickRespawn([enemy], rand);
    expect(spawn.pos.x).toBeCloseTo(490, 6);
    expect(spawn.pos.z).toBeCloseTo(1000, 6);
  });

  it("scores the NEAREST enemy against the band, not the average", () => {
    // Enemies at x=200 and x=1000 (z=1000), band middle 500 m. Candidates:
    //   W = (1100, 1000): distances 900 and 100 → average 500 (perfect), but
    //       the nearest is 100 m — far inside the band: W must lose.
    //   X = (600, 1000): distances 400 and 400 → nearest 400, 100 m off.
    const enemies = [
      { pos: { x: 200, y: 300, z: 1000 }, fwd: null },
      { pos: { x: 1000, y: 300, z: 1000 }, fwd: null },
    ];
    const rand = seq([
      1100 / WORLD_SIZE,
      1000 / WORLD_SIZE, // W first
      600 / WORLD_SIZE,
      1000 / WORLD_SIZE, // then X
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
