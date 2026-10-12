// Torus-aware respawn placement (PLAN.md: death → airborne respawn, mid
// altitude, combat speed — never a runway). U2: not the farthest point any
// more — that left a pilot ~800 m from anyone, past the fog, for 10–20 s of
// empty flying. A respawn now aims for RESPAWN_BAND_MIN..MAX to its NEAREST
// living enemy (torus wrapDistance), never inside any enemy's nose cone, and
// faces that enemy; the 5.5 s spawn protection covers the approach. Sampled:
// random candidates, best band score wins. RESPAWN_ALTITUDE is above every
// generated rooftop; H1's landmark supertalls rise through it, so a
// candidate whose straight run-out meets one is vetoed (landmarkClearance).
//
// The RNG is injected (like the city generator's seeding) so tests choose
// the candidates and the winner is deterministic.

import {
  BOSS_SPAWN_MARGIN,
  BOSS_SPAWN_RUNOUT_S,
} from "@angels-bandits/common/boss";
import { landmarkProfile } from "@angels-bandits/common/city/landmarks";
import { LANDMARK_BLOCKS } from "@angels-bandits/common/city/layout";
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
import type { Pose, SpawnState } from "@angels-bandits/common/protocol";
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

/**
 * H1: each landmark supertall as the spawn layer sees it — its centre and
 * the plan radius (half-diagonal) of its widest tier reaching within
 * BOSS_SPAWN_MARGIN of RESPAWN_ALTITUDE. Pure in the fixed landmark layout,
 * so no city is needed (a broken tower is only ever smaller).
 */
const LANDMARK_SPAWN_SOLIDS = LANDMARK_BLOCKS.map(([bx, bz], i) => {
  let base = 0;
  let half = 0;
  for (const t of landmarkProfile(i).tiers) {
    if (base + t.height >= RESPAWN_ALTITUDE - BOSS_SPAWN_MARGIN) {
      half = Math.max(half, Math.hypot(t.width, t.depth) / 2);
    }
    base += t.height;
  }
  return {
    x: bx * BLOCK_PITCH + BLOCK_PITCH / 2,
    z: bz * BLOCK_PITCH + BLOCK_PITCH / 2,
    r: half,
  };
}).filter((s) => s.r > 0);

/**
 * H1: the closest a spawn at `pos` flying `yaw` level at RESPAWN_SPEED for
 * BOSS_SPAWN_RUNOUT_S comes to a landmark supertall, plan metres (negative:
 * it flies into one). `yaw` null (not known yet) asks for every heading,
 * like bossSpawnClear: the whole run-out disc counts.
 */
export function landmarkClearance(pos: Vec3, yaw: number | null): number {
  const reach = RESPAWN_SPEED * BOSS_SPAWN_RUNOUT_S;
  const fx = yaw === null ? 0 : -Math.sin(yaw);
  const fz = yaw === null ? 0 : -Math.cos(yaw);
  const disc = yaw === null ? reach : 0;
  let clearance = Number.POSITIVE_INFINITY;
  for (let s = 0; s <= BOSS_SPAWN_RUNOUT_S; s += 0.25) {
    const p: Vec3 = {
      x: pos.x + fx * RESPAWN_SPEED * s,
      y: pos.y,
      z: pos.z + fz * RESPAWN_SPEED * s,
    };
    for (const l of LANDMARK_SPAWN_SOLIDS) {
      const d = wrapDelta(p, { x: l.x, y: pos.y, z: l.z });
      clearance = Math.min(clearance, Math.hypot(d.x, d.z) - l.r - disc);
    }
    if (yaw === null) break;
  }
  return clearance;
}

/** H1: a spawn clears the landmarks when its run-out keeps this far off. */
const landmarkClear = (pos: Vec3, yaw: number | null): boolean =>
  landmarkClearance(pos, yaw) >= BOSS_SPAWN_MARGIN;

/** The default `avoid`: nothing. */
const NO_AVOID = (): boolean => false;

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
 * A sky where nothing is clear keeps the unvetoed pick. H1: the landmark
 * supertalls are always asked (landmarkClear) — and if every candidate
 * fails, the one whose run-out stays farthest from them wins, never an
 * unchecked one.
 */
export function pickRespawn(
  enemies: readonly RespawnEnemy[],
  rand: () => number = Math.random,
  avoid: (pos: Vec3) => boolean = NO_AVOID,
  clear?: (pos: Vec3, yaw: number | null) => boolean,
): SpawnState {
  let best: Vec3 | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let far: Vec3 | null = null;
  let farScore = Number.NEGATIVE_INFINITY;
  let safest: Vec3 | null = null;
  let safestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < RESPAWN_BAND_SAMPLES; i++) {
    const candidate: Vec3 = {
      x: rand() * WORLD_SIZE,
      y: RESPAWN_ALTITUDE,
      z: rand() * WORLD_SIZE,
    };
    const nearest = nearestDistance(candidate, enemies);
    const heading = facing(candidate, enemies);
    const room = landmarkClearance(candidate, heading);
    if (room > safestScore) {
      safest = candidate;
      safestScore = room;
    }
    if (room < BOSS_SPAWN_MARGIN) continue;
    if (clear && !clear(candidate, heading)) continue;
    if (nearest > farScore) {
      far = candidate;
      farScore = nearest;
    }
    if (inNoseCone(candidate, enemies)) continue;
    // D5: never into a warned director event's danger zone.
    if (avoid(candidate)) continue;
    const score = bandScore(nearest);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  // Every candidate vetoed (never, in practice): drop the caller's vetoes,
  // keep the landmarks' — and if even that leaves nothing, the candidate
  // flying farthest from the supertalls.
  if (!best && !far) {
    if (clear || avoid !== NO_AVOID) return pickRespawn(enemies, rand);
    const pos = safest as Vec3;
    return { pos, yaw: yawToNearest(pos, enemies, rand), speed: RESPAWN_SPEED };
  }
  // RESPAWN_BAND_SAMPLES ≥ 1, so `far` is otherwise always set.
  const pos = best ?? (far as Vec3);
  return { pos, yaw: yawToNearest(pos, enemies, rand), speed: RESPAWN_SPEED };
}

/**
 * A2: a join spawn is picked at JOIN, but the plane only enters the world
 * when its first pose arrives — up to BOOT_TIMEOUT_MS later, time enough for
 * a raid or a warned hazard to move onto it. Null while the
 * held pose (heading included) is still clear; otherwise a fresh spawn by
 * pickRespawn's own rules.
 */
export function respawnIfUnsafe(
  held: Pose,
  enemies: readonly RespawnEnemy[],
  rand: () => number,
  avoid: (pos: Vec3) => boolean,
  clear: (pos: Vec3, yaw: number | null) => boolean,
): SpawnState | null {
  // The heading of the nose (−Z rotated by the attitude), yaw 0 facing −Z.
  const { x, y, z, w } = held.quat;
  const yaw = Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
  if (!avoid(held.pos) && clear(held.pos, yaw) && landmarkClear(held.pos, yaw))
    return null;
  return pickRespawn(enemies, rand, avoid, clear);
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
