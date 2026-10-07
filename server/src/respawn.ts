// Torus-aware respawn placement (PLAN.md: death → airborne respawn at a
// farthest-from-enemies point, mid altitude, combat speed — never a runway).
// Farthest on a torus means maximizing the MINIMUM wrapDistance to any
// living enemy: sample random points and keep the best. RESPAWN_ALTITUDE is
// above every rooftop, so any x/z is safe — no building check needed.
//
// The RNG is injected (like the city generator's seeding) so tests choose
// the candidates and the winner is deterministic.

import { ROADWAY_HALF } from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  BOT_CANYON_SLOW_RADIUS,
  BOT_SPAWN_ALT_MAX,
  BOT_SPAWN_ALT_MIN,
  BOT_SPAWN_SPEED,
  RESPAWN_ALTITUDE,
  RESPAWN_SAMPLES,
  RESPAWN_SPEED,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import type { SpawnState } from "@angels-bandits/common/protocol";
import {
  type Vec3,
  canonicalize,
  wrapDistance,
} from "@angels-bandits/common/world";

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

/**
 * A bot's (re)spawn: already IN the canyons (B1) instead of at
 * RESPAWN_ALTITUDE, where a bot spent ~10 s gliding down before it joined the
 * city fight. Each candidate stands on a street centreline at
 * BOT_SPAWN_ALT_MIN..MAX, nose along the street, with at least
 * BOT_CANYON_SLOW_RADIUS to the next intersection so the first corner can be
 * flown at BOT_SPAWN_SPEED. `clear` (RoomBots.spawnClear) vetoes candidates
 * that would spawn into a facade or a mover; among the rest the same
 * farthest-from-enemies rule as pickRespawn picks the winner. Nothing clear
 * (never, in practice) falls back to the high spawn, which is always safe.
 */
export function pickBotRespawn(
  enemies: readonly Vec3[],
  clear: (pos: Vec3, yaw: number) => boolean,
  rand: () => number = Math.random,
): SpawnState {
  const lines = WORLD_SIZE / BLOCK_PITCH;
  let best: SpawnState | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < RESPAWN_SAMPLES; i++) {
    // Every draw is taken whether or not the candidate survives, so the
    // stream stays aligned for injected-RNG tests.
    const line = Math.floor(rand() * lines) * BLOCK_PITCH;
    const block = Math.floor(rand() * lines) * BLOCK_PITCH;
    const toCorner =
      BOT_CANYON_SLOW_RADIUS +
      rand() * (BLOCK_PITCH - ROADWAY_HALF - BOT_CANYON_SLOW_RADIUS);
    const alongX = rand() < 0.5;
    const dir = rand() < 0.5 ? 1 : -1;
    const y =
      BOT_SPAWN_ALT_MIN + rand() * (BOT_SPAWN_ALT_MAX - BOT_SPAWN_ALT_MIN);
    // `toCorner` short of the next intersection in the direction of travel.
    const along = dir === 1 ? block + BLOCK_PITCH - toCorner : block + toCorner;
    const pos = canonicalize(
      alongX ? { x: along, y, z: line } : { x: line, y, z: along },
    );
    // Nose along the street: yaw 0 flies -Z, +π/2 flies -X.
    const yaw = alongX
      ? (dir === 1 ? -Math.PI : Math.PI) / 2
      : dir === 1
        ? Math.PI
        : 0;
    if (!clear(pos, yaw)) continue;
    let score = Number.POSITIVE_INFINITY;
    for (const enemy of enemies) {
      score = Math.min(score, wrapDistance(pos, enemy));
    }
    if (score > bestScore) {
      best = { pos, yaw, speed: BOT_SPAWN_SPEED };
      bestScore = score;
    }
  }
  return best ?? pickRespawn(enemies, rand);
}
