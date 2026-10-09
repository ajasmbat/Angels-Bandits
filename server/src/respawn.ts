// Torus-aware respawn placement (PLAN.md: death → airborne respawn, mid
// altitude, combat speed — never a runway). U2: not the farthest point any
// more — that left a pilot ~800 m from anyone, past the fog, for 10–20 s of
// empty flying. A respawn now aims for RESPAWN_BAND_MIN..MAX to its NEAREST
// living enemy (torus wrapDistance), never inside any enemy's nose cone, and
// faces that enemy; the 5.5 s spawn protection covers the approach. Sampled:
// random candidates, best band score wins. RESPAWN_ALTITUDE is above every
// rooftop, so any x/z is safe — no building check needed.
//
// The RNG is injected (like the city generator's seeding) so tests choose
// the candidates and the winner is deterministic.

import { overChannel } from "@angels-bandits/common/city/river";
import { ROADWAY_HALF } from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  BOT_CANYON_SLOW_RADIUS,
  BOT_SPAWN_ALT_MAX,
  BOT_SPAWN_ALT_MIN,
  BOT_SPAWN_SPEED,
  RESPAWN_ALTITUDE,
  RESPAWN_BAND_MAX,
  RESPAWN_BAND_MIN,
  RESPAWN_BAND_SAMPLES,
  RESPAWN_NOSE_CONE,
  RESPAWN_NOSE_RANGE,
  RESPAWN_SAMPLES,
  RESPAWN_SPEED,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import type { SpawnState } from "@angels-bandits/common/protocol";
import {
  type Vec3,
  canonicalize,
  wrapDelta,
  wrapDistance,
} from "@angels-bandits/common/world";

/** A living enemy as the respawn picker sees it: where it is and where its
 * nose points (unit vector; null = unknown, so it casts no cone). */
export interface RespawnEnemy {
  pos: Vec3;
  fwd: Vec3 | null;
}

const BAND_MID = (RESPAWN_BAND_MIN + RESPAWN_BAND_MAX) / 2;
const COS_NOSE_CONE = Math.cos(RESPAWN_NOSE_CONE);

/** Torus distance from `p` to its nearest enemy (Infinity with none). */
function nearestDistance(p: Vec3, enemies: readonly RespawnEnemy[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    nearest = Math.min(nearest, wrapDistance(p, enemy.pos));
  }
  return nearest;
}

/** True when `p` sits in front of any enemy's guns: inside its
 * RESPAWN_NOSE_CONE half-angle and closer than RESPAWN_NOSE_RANGE. */
function inNoseCone(p: Vec3, enemies: readonly RespawnEnemy[]): boolean {
  for (const { pos, fwd } of enemies) {
    if (!fwd) continue;
    const d = wrapDelta(pos, p);
    const dist = Math.hypot(d.x, d.y, d.z);
    if (dist >= RESPAWN_NOSE_RANGE) continue;
    if (fwd.x * d.x + fwd.y * d.y + fwd.z * d.z > COS_NOSE_CONE * dist) {
      return true;
    }
  }
  return false;
}

/** How far a candidate `nearest` distance misses the band's middle, m —
 * lower is better. Infinity (no enemies) never beats anything. */
const bandScore = (nearest: number): number => Math.abs(nearest - BAND_MID);

/**
 * Pick a pilot's spawn near the fight: the candidate whose nearest enemy is
 * closest to the RESPAWN_BAND middle, outside every nose cone, facing that
 * enemy. Every candidate in a cone (a crowded sky) falls back to the old
 * farthest-from-enemies rule; no enemies at all is a random spawn and yaw.
 *
 * `clear` (S4) vetoes candidates outright — a sky boss's hull crosses the
 * spawn layer, and spawn protection does not stop a crash. It is asked with
 * the heading the spawn would get (null: none yet — no enemies to face).
 * A sky where nothing is clear keeps the unvetoed pick.
 */
export function pickRespawn(
  enemies: readonly RespawnEnemy[],
  rand: () => number = Math.random,
  clear?: (pos: Vec3, yaw: number | null) => boolean,
): SpawnState {
  let best: Vec3 | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let far: Vec3 | null = null;
  let farScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < RESPAWN_BAND_SAMPLES; i++) {
    const candidate: Vec3 = {
      x: rand() * WORLD_SIZE,
      y: RESPAWN_ALTITUDE,
      z: rand() * WORLD_SIZE,
    };
    const nearest = nearestDistance(candidate, enemies);
    if (clear && !clear(candidate, facing(candidate, enemies))) continue;
    if (nearest > farScore) {
      far = candidate;
      farScore = nearest;
    }
    if (inNoseCone(candidate, enemies)) continue;
    const score = bandScore(nearest);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  // Every candidate vetoed (never, in practice): the plain pick instead.
  if (!best && !far) return pickRespawn(enemies, rand);
  // RESPAWN_BAND_SAMPLES ≥ 1, so `far` is otherwise always set.
  const pos = best ?? (far as Vec3);
  return { pos, yaw: yawToNearest(pos, enemies, rand), speed: RESPAWN_SPEED };
}

/** The yaw yawToNearest would give `pos` without drawing from the stream:
 * null when there is no enemy to face (the yaw would be random). */
function facing(pos: Vec3, enemies: readonly RespawnEnemy[]): number | null {
  if (enemies.length === 0) return null;
  let target: Vec3 | null = null;
  let nearest = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    const dist = wrapDistance(pos, enemy.pos);
    if (dist < nearest) {
      nearest = dist;
      target = enemy.pos;
    }
  }
  const d = wrapDelta(pos, target as Vec3);
  return Math.atan2(-d.x, -d.z);
}

/** Yaw that puts the nose on the nearest enemy (yaw 0 flies -Z, so
 * atan2(-dx, -dz)); a random heading with no enemy to face. */
function yawToNearest(
  pos: Vec3,
  enemies: readonly RespawnEnemy[],
  rand: () => number,
): number {
  let target: Vec3 | null = null;
  let nearest = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    const dist = wrapDistance(pos, enemy.pos);
    if (dist < nearest) {
      nearest = dist;
      target = enemy.pos;
    }
  }
  if (!target) return rand() * Math.PI * 2;
  const d = wrapDelta(pos, target);
  return Math.atan2(-d.x, -d.z);
}

/**
 * A bot's (re)spawn: already IN the canyons (B1) instead of at
 * RESPAWN_ALTITUDE, where a bot spent ~10 s gliding down before it joined the
 * city fight. Each candidate stands on a street centreline at
 * BOT_SPAWN_ALT_MIN..MAX, nose along the street, with at least
 * BOT_CANYON_SLOW_RADIUS to the next intersection so the first corner can be
 * flown at BOT_SPAWN_SPEED. `clear` (RoomBots.spawnClear) vetoes candidates
 * that would spawn into a facade or a mover; among the rest the same band
 * and nose-cone rule as pickRespawn picks the winner (U2), falling back to
 * the farthest clear candidate — but the nose stays along the street, never
 * turned toward an enemy into a wall. Nothing clear (never, in practice)
 * falls back to the high spawn, which is always safe.
 */
export function pickBotRespawn(
  enemies: readonly RespawnEnemy[],
  clear: (pos: Vec3, yaw: number) => boolean,
  rand: () => number = Math.random,
): SpawnState {
  const lines = WORLD_SIZE / BLOCK_PITCH;
  let best: SpawnState | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let far: SpawnState | null = null;
  let farScore = Number.NEGATIVE_INFINITY;
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
    // L11: never a low spawn over the river — a north–south street there is
    // a bridge, and a bot appearing over open water is one dive from it.
    if (overChannel(pos.z)) continue;
    if (!clear(pos, yaw)) continue;
    const nearest = nearestDistance(pos, enemies);
    if (nearest > farScore) {
      far = { pos, yaw, speed: BOT_SPAWN_SPEED };
      farScore = nearest;
    }
    if (inNoseCone(pos, enemies)) continue;
    const score = bandScore(nearest);
    if (score < bestScore) {
      best = { pos, yaw, speed: BOT_SPAWN_SPEED };
      bestScore = score;
    }
  }
  return best ?? far ?? pickRespawn(enemies, rand);
}
