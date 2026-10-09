// C2 constant chaos — the shared, pure half. Four layers on top of X1's
// missiles, D5's director and S4's boss, all server-authoritative like them
// (server/src/chaos.ts decides WHEN and WHERE and broadcasts one event; the
// rest is a pure function of that event and the synced clock):
//
//  - METEORS: fiery streaks from ~900 m up into a roof or facade, near the
//    fight or anywhere in the city. A meteor is a MissileStrike of kind
//    "meteor" (common/src/strike.ts), so it flies, lands, damages and
//    replays through X1's whole pipeline.
//  - BOMBER RUNS: a three-ship formation flies a street line and carpets it.
//    One `bombers` message carries the run AND every bomb (kind "bomb"
//    strikes with their drop instants), so a run costs one event however
//    many bombs it drops. The bombers are solid (one box table, the
//    MoverField's `bombers` slot — drawn == collided) and shootable.
//  - QUAKES: a city-wide tremor, announced QUAKE_LEAD_MS ahead; the camera
//    shakes by quakeAmp (pure), and at its instant the server weakens chunks.
//  - FIRE: burning chunks that spread to their neighbours (fireNeighbours).
//
// WHEN is the storm's / director's bucket trick, one salted stream per layer
// (chaosSlotsInWindow): random access, abutting windows partition the
// timeline, consecutive slots inside each layer's band.
//
// Not re-exported from common/src/index.ts; import "@angels-bandits/common/chaos".

import { rayBox } from "./boss";
import {
  type TierGrid,
  cellIndex,
  chunkBuilding,
  chunkCell,
  chunkId,
  chunkMask,
  chunkTier,
  tierGrids,
} from "./city/destruction";
import type { Building } from "./city/index";
import { type MoverBox, type MoverHit, sphereHitsBox } from "./city/movers";
import { mulberry32 } from "./city/rng";
import { standingTopAt } from "./city/standing";
import { BLOCK_PITCH, WORLD_SIZE } from "./constants";
import {
  BOMB_FALL_MS,
  METEOR_FLIGHT_MS,
  type MissileStrike,
  missilePathClear,
} from "./strike";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
  wrapDeltaInto,
} from "./world/index";

// --- When ----------------------------------------------------------------------

export const CHAOS_METEOR = 0;
export const CHAOS_BOMBER = 1;
export const CHAOS_QUAKE = 2;
export type ChaosLayer = 0 | 1 | 2;

/** Consecutive slots of each layer are this far apart, ms: a meteor every
 * 4–9 s, a bomber run every 45–75 s, a quake every 60–100 s. */
export const CHAOS_CADENCE: readonly (readonly [number, number])[] = [
  [4000, 9000],
  [45_000, 75_000],
  [60_000, 100_000],
];
const LAYER_SALT = [0x3e7e02a1, 0x0b0b3e55, 0x9a4e1d23] as const;

/**
 * Every slot of `layer` in [tStartMs, tEndMs), ascending — one per bucket of
 * the band's midpoint at a seeded offset, so consecutive slots are
 * CHAOS_CADENCE[layer] apart and abutting windows partition the timeline.
 * Pure in (seed, layer, window).
 */
export function chaosSlotsInWindow(
  seed: number,
  layer: ChaosLayer,
  tStartMs: number,
  tEndMs: number,
): number[] {
  const [min, max] = CHAOS_CADENCE[layer] as readonly [number, number];
  const bucket = (min + max) / 2;
  const jitter = (max - min) / 2;
  const salt = LAYER_SALT[layer];
  const out: number[] = [];
  const first = Math.max(0, Math.floor((tStartMs - jitter) / bucket));
  for (let n = first; n * bucket < tEndMs; n++) {
    const r = mulberry32((seed ^ salt ^ Math.imul(n, 0x9e3779b9)) >>> 0)();
    const t = n * bucket + r * jitter;
    if (t >= tStartMs && t < tEndMs) out.push(t);
  }
  return out;
}

// --- Meteors -------------------------------------------------------------------

/** Where a meteor starts: this high, m, and this far out (plan view). */
export const METEOR_ALT = 900;
const METEOR_RUN_MIN_M = 300;
const METEOR_RUN_MAX_M = 500;

/** The wire's 0.1 m grid. */
const q = (v: number): number => Math.round(v * 10) / 10;
const qc = (v: number): number => {
  const r = Math.round(wrapCoord(v) * 10) / 10;
  return r >= WORLD_SIZE ? 0 : r;
};

/**
 * A meteor onto `to` launched at `t0`: a straight streak from METEOR_ALT,
 * 300–500 m out at a seeded azimuth, swept clear of the city as it stands
 * (`buildings`). Null when no azimuth gets through. Quantised to the wire.
 */
export function planMeteor(
  rand: () => number,
  id: number,
  to: Vec3,
  t0: number,
  buildings: readonly Building[],
): MissileStrike | null {
  for (let n = 0; n < 8; n++) {
    const az = rand() * Math.PI * 2;
    const d = METEOR_RUN_MIN_M + (METEOR_RUN_MAX_M - METEOR_RUN_MIN_M) * rand();
    const s: MissileStrike = {
      id,
      kind: "meteor",
      from: {
        x: qc(to.x + Math.cos(az) * d),
        y: q(METEOR_ALT + 80 * rand()),
        z: qc(to.z + Math.sin(az) * d),
      },
      to: { x: qc(to.x), y: q(to.y), z: qc(to.z) },
      t0: Math.round(t0),
    };
    if (missilePathClear(s, buildings)) return s;
  }
  return null;
}

/** A roof point of building `b` (its top tier), seeded — a city-wide
 * meteor's target. D8: on a broken tower, where it still stands under that
 * point (its stump, or the street of a felled lot) — never the old roof's
 * height, where the meteor would burst in mid-air. Same two draws either
 * way, so the stream behind it never shifts. */
export function roofPoint(b: Building, rand: () => number): Vec3 {
  const grids = tierGrids(b);
  const top = grids[grids.length - 1] as TierGrid;
  const dx = (rand() - 0.5) * top.width * 0.8;
  const dz = (rand() - 0.5) * top.depth * 0.8;
  return {
    x: wrapCoord(b.x + dx),
    y: b.damage ? standingTopAt(b, dx, dz) : top.baseY + top.height,
    z: wrapCoord(b.z + dz),
  };
}

// --- Bomber runs ----------------------------------------------------------------

/** Ships in a formation, their cruise speed, m/s, and the run's legs, m:
 * the run-in to the bomb line, the line they carpet, the run-out. */
export const BOMBER_COUNT = 3;
export const BOMBER_SPEED = 55;
export const BOMBER_INGRESS_M = 650;
export const BOMBER_RUN_M = 360;
export const BOMBER_EGRESS_M = 650;
/** Bombs each ship drops along the line, evenly spaced. */
export const BOMBS_PER_BOMBER = 8;
/** Each ship's HP: ~20 rounds of BULLET_DAMAGE. */
export const BOMBER_HP = 140;
/** The formation flies this far over the tallest roof under its corridor,
 * m, and never outside [MIN, MAX] — MAX keeps the whole hull under the sky
 * boss's (BOSS_ALT − reach, 269 m). */
export const BOMBER_CLEAR_M = 35;
export const BOMBER_ALT_MIN = 110;
export const BOMBER_ALT_MAX = 262;
/** Half-width of the corridor the clearance reads, m (the wingmen's spread
 * plus a wingspan). */
export const BOMBER_CORRIDOR_M = 50;
/** How far a bomb carries forward from its drop, m (the bomber's way,
 * dragged to a halt over the fall: missilePosAt's u(2 − u)). */
export const BOMB_THROW_M = (BOMBER_SPEED * BOMB_FALL_MS) / 1000 / 2;

/** The formation in the run's frame (+x along travel, +z starboard), m:
 * the lead, then a wingman back and out on each side. */
export const BOMBER_FORMATION: readonly { x: number; z: number }[] = [
  { x: 0, z: 0 },
  { x: -32, z: -30 },
  { x: -32, z: 30 },
];

export interface BomberPart {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
}
const bpart = (
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
): BomberPart => ({ x, y, z, hx, hy, hz });

/** THE bomber: one table of yaw-only boxes in its own frame (+X the nose,
 * the MoverBox convention). The renderer instances exactly these and
 * collideBombers tests exactly these — drawn == collided. */
export const BOMBER_PARTS: readonly BomberPart[] = [
  bpart(0, 0, 0, 11, 1.9, 1.9), // fuselage
  bpart(1.5, 0.2, 0, 2.8, 0.5, 15), // wing
  bpart(3, -1, 6.5, 2.4, 1, 1), // starboard engine
  bpart(3, -1, -6.5, 2.4, 1, 1), // port engine
  bpart(-9.5, 0.6, 0, 1.6, 0.35, 5.5), // tailplane
  bpart(-9.8, 3, 0, 1.6, 2.4, 0.35), // fin
];
/** Furthest any part reaches from a bomber's centre, m (reject tests). */
export const BOMBER_REACH_Y = 5.4;
export const BOMBER_RADIUS = Math.hypot(11.4, BOMBER_REACH_Y, 15);
/** A whole formation's reach about its lead, plan view, m. */
const FORMATION_REACH = Math.hypot(32, 30) + BOMBER_RADIUS;

/** One run, exactly as broadcast. (x, z) is the LEAD's position at t0,
 * canonical on the 0.1 m grid; `dir` the travel axis (0 +x, 1 +z, 2 −x,
 * 3 −z); `alt` on the 0.1 m grid; `hp` each ship's full HP. */
export interface BomberRun {
  id: number;
  t0: number;
  x: number;
  z: number;
  dir: 0 | 1 | 2 | 3;
  alt: number;
  hp: number;
}

/** A ship shot down: run id, ship index, server time. */
export interface BomberDown {
  r: number;
  k: number;
  t: number;
}

/** The room's bombers on both sides (the MoverField's `bombers`): runs in
 * the air (or recently over) and the ships shot down. Mutated in place. */
export interface BomberSlot {
  runs: BomberRun[];
  downs: BomberDown[];
}

export const emptyBomberSlot = (): BomberSlot => ({ runs: [], downs: [] });

/** Unit travel vector of `dir`. */
export function dirVec(dir: number): { x: number; z: number } {
  return dir === 0
    ? { x: 1, z: 0 }
    : dir === 1
      ? { x: 0, z: 1 }
      : dir === 2
        ? { x: -1, z: 0 }
        : { x: 0, z: -1 };
}

/** The MoverBox yaw of a ship flying `dir` (local +X → world (cos, −sin)). */
export const bomberYaw = (dir: number): number =>
  dir === 0 ? 0 : dir === 1 ? -Math.PI / 2 : dir === 2 ? Math.PI : Math.PI / 2;

/** A run lasts this long, ms: the lead's whole path plus the tail ships'. */
export const runDurationMs = (): number =>
  ((BOMBER_INGRESS_M + BOMBER_RUN_M + BOMBER_EGRESS_M + 32) / BOMBER_SPEED) *
  1000;
export const runEnd = (r: BomberRun): number => r.t0 + runDurationMs();

/** When ship `k` went down on run `r` (Infinity: it did not). */
export function bomberDownAt(slot: BomberSlot, r: number, k: number): number {
  for (const d of slot.downs) if (d.r === r && d.k === k) return d.t;
  return Number.POSITIVE_INFINITY;
}

/** Is ship `k` of `run` in the air, intact, at `t`? */
export function bomberAlive(
  slot: BomberSlot,
  run: BomberRun,
  k: number,
  t: number,
): boolean {
  return t >= run.t0 && t < runEnd(run) && t < bomberDownAt(slot, run.id, k);
}

/** A ship's pose: centre and yaw. */
export interface BomberPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}
export const blankBomberPose = (): BomberPose => ({ x: 0, y: 0, z: 0, yaw: 0 });

/** Where ship `k` of `run` is at `t` (clamped to the run's start): pure in
 * (run, t) like every mover. Writes `out`. */
export function bomberPoseInto(
  run: BomberRun,
  k: number,
  t: number,
  out: BomberPose,
): BomberPose {
  const s = (BOMBER_SPEED * Math.max(0, t - run.t0)) / 1000;
  const f = BOMBER_FORMATION[k] ?? { x: 0, z: 0 };
  const d = dirVec(run.dir);
  // Formation offset: +x back along travel, +z to starboard (travel × up).
  const along = s + f.x;
  out.x = wrapCoord(run.x + d.x * along - d.z * f.z);
  out.y = run.alt;
  out.z = wrapCoord(run.z + d.z * along + d.x * f.z);
  out.yaw = bomberYaw(run.dir);
  return out;
}

/** Ship-frame offset placed by `pose` into world `out` (the boss's
 * placeLocal: local +X → (cos, −sin), local +Z → (sin, cos)). */
function placeLocal(
  pose: BomberPose,
  lx: number,
  ly: number,
  lz: number,
  out: Vec3,
): Vec3 {
  const c = Math.cos(pose.yaw);
  const s = Math.sin(pose.yaw);
  out.x = wrapCoord(pose.x + lx * c + lz * s);
  out.y = pose.y + ly;
  out.z = wrapCoord(pose.z - lx * s + lz * c);
  return out;
}

/** THE definition of where part `i` of a ship at `pose` is (the renderer
 * and collideBombers both come here). Writes `out`. */
export function bomberPartBoxInto(
  pose: BomberPose,
  i: number,
  out: MoverBox,
): MoverBox {
  const p = BOMBER_PARTS[i] as BomberPart;
  placeLocal(pose, p.x, p.y, p.z, out);
  out.hx = p.hx;
  out.hy = p.hy;
  out.hz = p.hz;
  out.yaw = pose.yaw;
  out.kind = "bomber";
  out.id = i;
  return out;
}

const hitPose = blankBomberPose();
const hitBox: MoverBox = {
  x: 0,
  y: 0,
  z: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  yaw: 0,
  kind: "bomber",
  id: 0,
};

/**
 * The mover-field query: the first ship whose boxes a sphere at `pos`
 * touches at `t`, or null (id = the run's id). Altitude, then formation,
 * then ship rejects first — cheap enough for the bot probe loop.
 */
export function collideBombers(
  slot: BomberSlot,
  pos: Vec3,
  radius: number,
  t: number,
): MoverHit | null {
  for (const run of slot.runs) {
    if (Math.abs(pos.y - run.alt) > BOMBER_REACH_Y + radius) continue;
    if (t < run.t0 || t >= runEnd(run)) continue;
    bomberPoseInto(run, 0, t, hitPose);
    const fx = wrapDeltaAxis(hitPose.x, pos.x);
    const fz = wrapDeltaAxis(hitPose.z, pos.z);
    const reach = FORMATION_REACH + radius;
    if (fx * fx + fz * fz > reach * reach) continue;
    for (let k = 0; k < BOMBER_COUNT; k++) {
      if (!bomberAlive(slot, run, k, t)) continue;
      bomberPoseInto(run, k, t, hitPose);
      const dx = wrapDeltaAxis(hitPose.x, pos.x);
      const dz = wrapDeltaAxis(hitPose.z, pos.z);
      const r = BOMBER_RADIUS + radius;
      if (dx * dx + dz * dz > r * r) continue;
      for (let i = 0; i < BOMBER_PARTS.length; i++) {
        if (sphereHitsBox(bomberPartBoxInto(hitPose, i, hitBox), pos, radius)) {
          return { kind: "bomber", id: run.id };
        }
      }
    }
  }
  return null;
}

/** What a round meets first among the ships. */
export interface BomberRayHit {
  run: number;
  k: number;
  dist: number;
}

const rayPose = blankBomberPose();
const rayOff: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The first live ship a round from `origin` along unit `dir` meets within
 * `maxDist` at `t`, or null. The client's bullet step and the server's
 * claim judgement both come here (one derivation of where the boxes are).
 */
export function bomberRayHit(
  slot: BomberSlot,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  t: number,
): BomberRayHit | null {
  let best: BomberRayHit | null = null;
  for (const run of slot.runs) {
    for (let k = 0; k < BOMBER_COUNT; k++) {
      if (!bomberAlive(slot, run, k, t)) continue;
      bomberPoseInto(run, k, t, rayPose);
      wrapDeltaInto(rayPose, origin, rayOff);
      // Reject: the ray never comes within the ship's radius.
      const along = -(rayOff.x * dir.x + rayOff.y * dir.y + rayOff.z * dir.z);
      const reach = BOMBER_RADIUS;
      if (along < -reach || along > maxDist + reach) continue;
      const cx = rayOff.x + dir.x * along;
      const cy = rayOff.y + dir.y * along;
      const cz = rayOff.z + dir.z * along;
      if (cx * cx + cy * cy + cz * cz > reach * reach) continue;
      for (let i = 0; i < BOMBER_PARTS.length; i++) {
        bomberPartBoxInto(rayPose, i, hitBox);
        wrapDeltaInto(hitBox, origin, rayOff);
        const d = rayBox(
          rayOff.x,
          rayOff.y,
          rayOff.z,
          dir.x,
          dir.y,
          dir.z,
          hitBox,
          maxDist,
        );
        if (d < (best?.dist ?? Number.POSITIVE_INFINITY)) {
          best = { run: run.id, k, dist: d };
        }
      }
    }
  }
  return best;
}

/** Seconds of straight run-out a respawn must have clear of every ship. */
export const BOMBER_SPAWN_RUNOUT_S = 6;
const BOMBER_SPAWN_MARGIN = 25;
const spawnAt: Vec3 = { x: 0, y: 0, z: 0 };

/** May a plane (re)spawn at `pos` heading `yaw` (null: unknown — the whole
 * run-out disc) at `speed` without flying into a ship within its run-out? */
export function bomberSpawnClear(
  slot: BomberSlot,
  pos: Vec3,
  yaw: number | null,
  speed: number,
  now: number,
): boolean {
  if (slot.runs.length === 0) return true;
  const fx = yaw === null ? 0 : -Math.sin(yaw);
  const fz = yaw === null ? 0 : -Math.cos(yaw);
  const margin =
    yaw === null
      ? BOMBER_SPAWN_MARGIN + speed * BOMBER_SPAWN_RUNOUT_S
      : BOMBER_SPAWN_MARGIN;
  for (let s = 0; s <= BOMBER_SPAWN_RUNOUT_S; s += 0.25) {
    spawnAt.x = wrapCoord(pos.x + fx * speed * s);
    spawnAt.y = pos.y;
    spawnAt.z = wrapCoord(pos.z + fz * speed * s);
    if (collideBombers(slot, spawnAt, margin, now + s * 1000)) return false;
    if (yaw === null) break;
  }
  return true;
}

/** One planned drop: ship `k`'s bomb `j`, released at `t` from `from`
 * (the ship's belly), carried BOMB_THROW_M along the run's travel. */
export interface BombDrop {
  k: number;
  j: number;
  t: number;
  from: Vec3;
  /** Plan-view impact point (the caller finds the height there). */
  x: number;
  z: number;
}

/** Every drop of `run`, ship-major, each ship's bombs evenly along the
 * line — the wingmen's land beside the lead's: a three-wide carpet. */
export function bombDrops(run: BomberRun): BombDrop[] {
  const out: BombDrop[] = [];
  const d = dirVec(run.dir);
  const step = BOMBER_RUN_M / (BOMBS_PER_BOMBER - 1);
  const pose = blankBomberPose();
  for (let k = 0; k < BOMBER_COUNT; k++) {
    const f = BOMBER_FORMATION[k] as { x: number; z: number };
    for (let j = 0; j < BOMBS_PER_BOMBER; j++) {
      // The lead's distance travelled when ship k is over drop point j.
      const s = BOMBER_INGRESS_M + j * step - f.x;
      const t = Math.round(run.t0 + (s / BOMBER_SPEED) * 1000);
      bomberPoseInto(run, k, t, pose);
      out.push({
        k,
        j,
        t,
        from: { x: qc(pose.x), y: q(run.alt - 2.5), z: qc(pose.z) },
        x: qc(pose.x + d.x * BOMB_THROW_M),
        z: qc(pose.z + d.z * BOMB_THROW_M),
      });
    }
  }
  return out;
}

/** The plan-view points of the bomb line (for budgets and spawn avoidance):
 * every drop's impact point. */
export function bombLinePoints(run: BomberRun): Vec3[] {
  return bombDrops(run).map((b) => ({ x: b.x, y: 0, z: b.z }));
}

/**
 * The street line a run over `anchor` would fly — the lattice line nearest
 * it along `dir` — with the lead placed so the bomb line is centred
 * `ahead` m past the anchor along travel. Altitude: BOMBER_CLEAR_M over the
 * tallest roof (and `obstacleTops`, e.g. crane hubs) within
 * BOMBER_CORRIDOR_M of its whole path; null when that is over
 * BOMBER_ALT_MAX. Quantised to the wire.
 */
export function planBomberRun(
  id: number,
  t0: number,
  anchor: Vec3,
  dir: 0 | 1 | 2 | 3,
  ahead: number,
  buildings: readonly Building[],
  obstacleTops: readonly { x: number; z: number; top: number }[] = [],
  hp = BOMBER_HP,
): BomberRun | null {
  const d = dirVec(dir);
  const alongX = d.x !== 0;
  // The street centreline across the travel axis.
  const across = alongX ? anchor.z : anchor.x;
  const line = wrapCoord(Math.round(across / BLOCK_PITCH) * BLOCK_PITCH);
  const centre = (alongX ? anchor.x : anchor.z) + (alongX ? d.x : d.z) * ahead;
  const back = BOMBER_INGRESS_M + BOMBER_RUN_M / 2;
  const startAlong = centre - (alongX ? d.x : d.z) * back;
  const x = alongX ? startAlong : line;
  const z = alongX ? line : startAlong;
  const len = BOMBER_INGRESS_M + BOMBER_RUN_M + BOMBER_EGRESS_M + 64;
  let top = 0;
  const inCorridor = (px: number, pz: number, hx: number, hz: number) => {
    // Plan-view gap from the path segment to the footprint.
    const ax = wrapDeltaAxis(x, px);
    const az = wrapDeltaAxis(z, pz);
    const u = alongX ? ax * d.x : az * d.z; // along travel from the start
    const v = alongX ? az : ax; // across
    const hu = alongX ? hx : hz;
    const hv = alongX ? hz : hx;
    const gapU = Math.max(0, -64 - (u + hu), u - hu - len);
    const gapV = Math.max(0, Math.abs(v) - hv - BOMBER_CORRIDOR_M);
    return gapU === 0 && gapV === 0;
  };
  for (const b of buildings) {
    if (b.height + BOMBER_CLEAR_M <= top) continue;
    if (inCorridor(b.x, b.z, b.width / 2, b.depth / 2)) top = b.height;
  }
  for (const o of obstacleTops) {
    if (o.top > top && inCorridor(o.x, o.z, 0, 0)) top = o.top;
  }
  const alt = Math.max(BOMBER_ALT_MIN, top + BOMBER_CLEAR_M);
  if (alt > BOMBER_ALT_MAX) return null;
  return {
    id,
    t0: Math.round(t0),
    x: qc(x),
    z: qc(z),
    dir,
    alt: q(alt),
    hp,
  };
}

// --- Quakes ---------------------------------------------------------------------

/** A quake is announced this long before the ground moves, ms (the
 * fairness floor for what it can bring down: D5's 3 s). */
export const QUAKE_LEAD_MS = 3000;
export const QUAKE_DUR_MIN_MS = 4000;
export const QUAKE_DUR_MAX_MS = 7000;
/** It is felt everywhere; strongest within this of the epicentre, m. */
export const QUAKE_RADIUS_M = 900;
/** Peak camera jolt at magnitude 1 right on the epicentre, m. */
export const QUAKE_SHAKE_M = 1.1;

/** One quake, as broadcast: shaking from `t` for `dur` ms, magnitude
 * 0.5–1, epicentre (x, z) canonical on the 0.1 m grid. */
export interface QuakeEvent {
  id: number;
  t: number;
  dur: number;
  mag: number;
  x: number;
  z: number;
}

/** A quake planned from a seeded stream (the server's). */
export function planQuake(
  rand: () => number,
  id: number,
  warnAt: number,
  epicentre: Vec3,
): QuakeEvent {
  return {
    id,
    t: Math.round(warnAt + QUAKE_LEAD_MS),
    dur: Math.round(
      QUAKE_DUR_MIN_MS + (QUAKE_DUR_MAX_MS - QUAKE_DUR_MIN_MS) * rand(),
    ),
    mag: Math.round((0.5 + 0.5 * rand()) * 100) / 100,
    x: qc(epicentre.x),
    z: qc(epicentre.z),
  };
}

/** How strongly quake `e` is felt at `pos`, 0..1: city-wide (never under a
 * quarter of its magnitude), stronger near the epicentre. */
export function quakeFalloff(e: QuakeEvent, pos: Vec3): number {
  const d = Math.hypot(wrapDeltaAxis(e.x, pos.x), wrapDeltaAxis(e.z, pos.z));
  return e.mag * Math.max(0.25, 1 - d / QUAKE_RADIUS_M);
}

/**
 * The shake quake `e` puts on a camera at `pos` at server time `t`, 0..1
 * (× QUAKE_SHAKE_M for metres): a low rumble building through the lead,
 * the jolt as it hits, then a long decay. Zero outside [t − lead, t + dur].
 * Pure.
 */
export function quakeAmp(e: QuakeEvent, pos: Vec3, t: number): number {
  if (t < e.t - QUAKE_LEAD_MS || t > e.t + e.dur) return 0;
  const f = quakeFalloff(e, pos);
  if (t < e.t) return f * 0.15 * (1 - (e.t - t) / QUAKE_LEAD_MS);
  const u = (t - e.t) / e.dur;
  // A fast rise to the peak, then a decay to nothing at the end.
  const env = u < 0.12 ? u / 0.12 : (1 - u) ** 1.5 / (1 - 0.12) ** 1.5;
  return f * env;
}

/** Quakes still to come or shaking at `t` (the welcome keeps these). */
export const quakeLive = (e: QuakeEvent, t: number): boolean =>
  t <= e.t + e.dur;

// --- Fire ----------------------------------------------------------------------

/** A fire burns this long, spreads (maybe) this often, takes this much
 * off its chunk per spread tick, and the room burns at most this many. */
export const FIRE_LIFE_MS = 30_000;
export const FIRE_SPREAD_MS = 3000;
export const FIRE_SPREAD_P = 0.45;
export const FIRE_CHUNK_DAMAGE = 8;
export const FIRE_MAX = 40;

/** The standing-or-not chunks face-adjacent to chunk `id` in its own tier
 * (±1 cell along each axis), ascending. Pure in the building. */
export function fireNeighbours(
  buildings: readonly Building[],
  id: number,
): number[] {
  const index = chunkBuilding(id);
  const b = buildings[index];
  if (!b) return [];
  const tier = chunkTier(id);
  const g = tierGrids(b)[tier];
  const mask = chunkMask(b)[tier];
  if (!g || !mask) return [];
  const cell = chunkCell(id);
  const ix = cell % g.nx;
  const iz = Math.floor(cell / g.nx) % g.nz;
  const iy = Math.floor(cell / (g.nx * g.nz));
  const out: number[] = [];
  const add = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) return;
    const c = cellIndex(g, x, y, z);
    if (mask[c]) out.push(chunkId(index, tier, c));
  };
  add(ix - 1, iy, iz);
  add(ix + 1, iy, iz);
  add(ix, iy - 1, iz);
  add(ix, iy + 1, iz);
  add(ix, iy, iz - 1);
  add(ix, iy, iz + 1);
  return out.sort((a, c) => a - c);
}

/** World centre of chunk `id` (canonical), written into `out`; null for an
 * unknown id. */
export function chunkCentreInto(
  buildings: readonly Building[],
  id: number,
  out: Vec3,
): Vec3 | null {
  const b = buildings[chunkBuilding(id)];
  const g = b && tierGrids(b)[chunkTier(id)];
  if (!b || !g) return null;
  const cell = chunkCell(id);
  const ix = cell % g.nx;
  const iz = Math.floor(cell / g.nx) % g.nz;
  const iy = Math.floor(cell / (g.nx * g.nz));
  if (iy >= g.ny) return null;
  out.x = wrapCoord(b.x - g.width / 2 + (ix + 0.5) * g.cw);
  out.y = g.baseY + (iy + 0.5) * g.ch;
  out.z = wrapCoord(b.z - g.depth / 2 + (iz + 0.5) * g.cd);
  return out;
}

// --- The near-plane hold ---------------------------------------------------------

/** A quake or fire never breaks a chunk of a building whose reach a plane
 * is in or will be in within this, s — the collapse it could set off has
 * only D3's 0.6 s lead, so it must not be anywhere a plane will be. */
export const HOLD_HORIZON_S = 8;
/** ...where a building's reach is its height plus this, plan view, m (a
 * topple lands within its height of the footprint). */
export const HOLD_MARGIN_M = 40;

/** Is any plane in `b`'s reach now or on its straight path over the next
 * HOLD_HORIZON_S? Then a quake or fire must not break `b` (hold at 1 HP). */
export function holdNear(
  b: Building,
  planes: readonly { pos: Vec3; vel: Vec3 }[],
): boolean {
  const reach = b.height + HOLD_MARGIN_M;
  for (const p of planes) {
    for (let s = 0; s <= HOLD_HORIZON_S + 1e-9; s += 0.5) {
      const gx = Math.max(
        0,
        Math.abs(wrapDeltaAxis(b.x, p.pos.x + p.vel.x * s)) - b.width / 2,
      );
      const gz = Math.max(
        0,
        Math.abs(wrapDeltaAxis(b.z, p.pos.z + p.vel.z * s)) - b.depth / 2,
      );
      if (gx <= reach && gz <= reach && Math.hypot(gx, gz) <= reach) {
        return true;
      }
    }
  }
  return false;
}

// --- Wire ----------------------------------------------------------------------

/** A run on the wire: [id, t0, x ×10, z ×10, dir, alt ×10, hp]. */
export type WireBomberRun = [
  id: number,
  t0: number,
  x: number,
  z: number,
  dir: number,
  alt: number,
  hp: number,
];

export function encodeBomberRun(r: BomberRun): WireBomberRun {
  return [
    r.id,
    r.t0,
    Math.round(r.x * 10),
    Math.round(r.z * 10),
    r.dir,
    Math.round(r.alt * 10),
    r.hp,
  ];
}

const finiteTuple = (w: unknown, n: number): w is number[] =>
  Array.isArray(w) &&
  w.length === n &&
  w.every((v) => typeof v === "number" && Number.isFinite(v));

export function decodeBomberRun(w: unknown): BomberRun | null {
  if (!finiteTuple(w, 7)) return null;
  const [id, t0, x, z, dir, alt, hp] = w as number[];
  if (dir !== 0 && dir !== 1 && dir !== 2 && dir !== 3) return null;
  return {
    id: id as number,
    t0: t0 as number,
    x: (x as number) / 10,
    z: (z as number) / 10,
    dir,
    alt: (alt as number) / 10,
    hp: hp as number,
  };
}

/** A quake on the wire: [id, t, dur, mag ×100, x ×10, z ×10]. */
export type WireQuake = [
  id: number,
  t: number,
  dur: number,
  mag: number,
  x: number,
  z: number,
];

export function encodeQuake(e: QuakeEvent): WireQuake {
  return [
    e.id,
    e.t,
    e.dur,
    Math.round(e.mag * 100),
    Math.round(e.x * 10),
    Math.round(e.z * 10),
  ];
}

export function decodeQuake(w: unknown): QuakeEvent | null {
  if (!finiteTuple(w, 6)) return null;
  const [id, t, dur, mag, x, z] = w as number[];
  return {
    id: id as number,
    t: t as number,
    dur: dur as number,
    mag: (mag as number) / 100,
    x: (x as number) / 10,
    z: (z as number) / 10,
  };
}

/** A downed ship on the wire: [run id, ship, t]. */
export type WireBomberDown = [r: number, k: number, t: number];

export const encodeBomberDown = (d: BomberDown): WireBomberDown => [
  d.r,
  d.k,
  d.t,
];

export function decodeBomberDown(w: unknown): BomberDown | null {
  if (!finiteTuple(w, 3)) return null;
  const [r, k, t] = w as number[];
  if (
    !Number.isInteger(k) ||
    (k as number) < 0 ||
    (k as number) >= BOMBER_COUNT
  )
    return null;
  return { r: r as number, k: k as number, t: t as number };
}

/** The welcome's C2 replay: runs still worth showing (and their downs),
 * quakes still to come or shaking, and the burning chunks (delta-encoded
 * with encodeChunkIds). */
export interface WireChaosState {
  runs: WireBomberRun[];
  downs: WireBomberDown[];
  quakes: WireQuake[];
  fires: number[];
}

/** METEOR_FLIGHT_MS re-exported for callers that only import chaos. */
export { METEOR_FLIGHT_MS };
