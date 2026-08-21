// Torus-aware respawn placement (PLAN.md: death → airborne respawn at a
// farthest-from-enemies point, mid altitude, combat speed — never a runway).
// Farthest on a torus means maximizing the MINIMUM wrapDistance to any
// living enemy: sample random points and keep the best. RESPAWN_ALTITUDE is
// above every rooftop, so any x/z is safe — no building check needed.
//
// The RNG is injected (like the city generator's seeding) so tests choose
// the candidates and the winner is deterministic.

import {
  RESPAWN_ALTITUDE,
  RESPAWN_SAMPLES,
  RESPAWN_SPEED,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import type { SpawnState } from "@angels-bandits/common/protocol";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";

/** Pick a spawn maximizing the minimum torus distance to `enemies`. */
export function pickRespawn(
  enemies: readonly Vec3[],
  rand: () => number = Math.random,
): SpawnState {
  let best: Vec3 | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < RESPAWN_SAMPLES; i++) {
    const candidate: Vec3 = {
      x: rand() * WORLD_SIZE,
      y: RESPAWN_ALTITUDE,
      z: rand() * WORLD_SIZE,
    };
    let score = Number.POSITIVE_INFINITY;
    for (const enemy of enemies) {
      score = Math.min(score, wrapDistance(candidate, enemy));
    }
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return {
    // RESPAWN_SAMPLES ≥ 1, so `best` is always set.
    pos: best as Vec3,
    yaw: rand() * Math.PI * 2,
    speed: RESPAWN_SPEED,
  };
}
