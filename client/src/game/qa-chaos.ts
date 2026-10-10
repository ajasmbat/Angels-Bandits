// P4 perf gate: the C2 chaos the harness stages on the client, so a measured
// window shows the same missiles, meteors, quake and fires on
// every pass. QA only — reached through `__ab.qaChaos` (main.ts), never from
// gameplay; a plain visit runs none of it.
//
// Why staged rather than live: C2's chaos is decided by the server on its
// wall clock (server/src/chaos.ts, strikes.ts) and aimed at wherever planes
// happen to be, and the harness's server runs D6's quiet city, which sends
// none of it. Here everything is a pure function of the spec and the pinned
// WORLD clock (`__ab.pinWorld`): strike k of a schedule is launched at a
// fixed world time at a target picked by a stream seeded from (seed, k),
// through the SAME planners the server uses (pickMissileTarget, planMissile,
// planMeteor); the quake shakes the whole window; the fires burn named chunks. The strikes
// then fly X1's whole pipeline from the socket's `missiles` map — flight,
// whistle, blast, debris — exactly as a server strike would.

import {
  type QuakeEvent,
  planMeteor,
  roofPoint,
} from "@angels-bandits/common/chaos";
import {
  type Building,
  chunkId,
  mulberry32,
  tierGrids,
} from "@angels-bandits/common/city";
import type { CityIndex } from "@angels-bandits/common/collision";
import {
  type MissileStrike,
  missileFlightMs,
  missileImpactAt,
  pickMissileTarget,
  planMissile,
} from "@angels-bandits/common/strike";
import { type Vec3, wrapCoord } from "@angels-bandits/common/world";

/** Staged strikes are numbered from here; anything below is the server's. */
export const QA_STRIKE_BASE = 2_000_000_000;
/** A staged quake's id. */
export const QA_QUAKE_ID = 900_201;
/** Strikes per schedule the stage plans up front (far more than a window
 * plus its settle and warm-up ever launches). */
const SCHEDULE_LEN = 64;

/** A point relative to the held view: `ahead` along the nose (yaw 0 faces
 * −Z), `side` to its right, at height `y`. */
export interface QaAim {
  ahead: number;
  side?: number;
  y: number;
}

/** A strike schedule: one every `every` ms of world time, from `leadMs`
 * before the segment's instant (so strikes are already in the air when the
 * window opens), aimed around `aim` by the planners' own picks. */
export interface QaStrikeSchedule {
  every: number;
  leadMs: number;
  aim: QaAim;
  seed: number;
}

export interface QaChaosSpec {
  /** The held view: position and yaw. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** The world instant the segment is pinned to, ms. */
  worldMs: number;
  /** X1 missiles (cruise, or an artillery lob when no cruise path clears). */
  missiles?: QaStrikeSchedule;
  /** C2 meteors onto roofs round `aim`. */
  meteors?: QaStrikeSchedule;
  /** A C2 quake shaking from `startMs` (offset from `worldMs`) for `dur`
   * ms at magnitude `mag`, its epicentre at `aim`. */
  quake?: { startMs: number; dur: number; mag: number; aim: QaAim };
  /** C2 fire on `chunks` chunks of building `b` (its height is `h`, so a
   * generator change throws instead of burning another building). */
  fires?: { b: number; h: number; chunks: number };
}

export interface QaChaosStage {
  readonly spec: QaChaosSpec;
  /** Every staged strike, ascending launch time. */
  readonly strikes: readonly MissileStrike[];
  readonly quake: QuakeEvent | null;
  readonly fires: readonly number[];
  /** The next strike not yet handed to the socket's map. */
  next: number;
  /** Strikes the server sent while staged (dropped every frame). */
  foreign: number;
}

/** The view-relative point `aim`, canonical. */
function aimPoint(spec: QaChaosSpec, aim: QaAim): Vec3 {
  const fx = -Math.sin(spec.yaw);
  const fz = -Math.cos(spec.yaw);
  const side = aim.side ?? 0;
  return {
    x: wrapCoord(spec.x + fx * aim.ahead + Math.cos(spec.yaw) * side),
    y: aim.y,
    z: wrapCoord(spec.z + fz * aim.ahead - Math.sin(spec.yaw) * side),
  };
}

/** Strike k's own stream (no state shared between strikes). */
const streamFor = (seed: number, k: number): (() => number) =>
  mulberry32((seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0);

/** The schedule's missiles: planned the way the server plans X1's. */
function planMissiles(
  spec: QaChaosSpec,
  s: QaStrikeSchedule,
  index: CityIndex,
  buildings: readonly Building[],
  out: MissileStrike[],
): void {
  const subject = { pos: aimPoint(spec, s.aim), vel: { x: 0, y: 0, z: 0 } };
  for (let k = 0; k < SCHEDULE_LEN; k++) {
    const rand = streamFor(s.seed, k);
    const t0 = Math.round(spec.worldMs - s.leadMs + k * s.every);
    const target = pickMissileTarget(rand, subject, [], index);
    if (!target) continue;
    const m = planMissile(rand, QA_STRIKE_BASE + k, target, t0, buildings);
    if (m) out.push(m);
  }
}

/** The schedule's meteors: onto the roof of a building near the aim. */
function planMeteors(
  spec: QaChaosSpec,
  s: QaStrikeSchedule,
  buildings: readonly Building[],
  out: MissileStrike[],
): void {
  const at = aimPoint(spec, s.aim);
  // The buildings within 160 m of the aim, nearest first (fixed order).
  const near: { b: Building; d: number }[] = [];
  for (const b of buildings) {
    const dx = wrapCoord(b.x - at.x + 1000) - 1000;
    const dz = wrapCoord(b.z - at.z + 1000) - 1000;
    const d = Math.hypot(dx, dz);
    if (d <= 160) near.push({ b, d });
  }
  near.sort((a, b) => a.d - b.d);
  if (near.length === 0) return;
  for (let k = 0; k < SCHEDULE_LEN; k++) {
    const rand = streamFor(s.seed, k);
    const t0 = Math.round(spec.worldMs - s.leadMs + k * s.every);
    const pick = near[Math.floor(rand() * near.length)] as { b: Building };
    const m = planMeteor(
      rand,
      QA_STRIKE_BASE + SCHEDULE_LEN + k,
      roofPoint(pick.b, rand),
      t0,
      buildings,
    );
    if (m) out.push(m);
  }
}

/** `n` chunks of building `bi` facing the view: its lowest tier's cells on
 * the face toward (x, z), bottom-up, then round the corners. */
function fireChunks(
  buildings: readonly Building[],
  f: NonNullable<QaChaosSpec["fires"]>,
  spec: QaChaosSpec,
): number[] {
  const b = buildings[f.b];
  if (!b || Math.round(b.height) !== f.h) {
    throw new Error(
      `qaChaos: building ${f.b} is ${b ? Math.round(b.height) : "missing"} m, the spec expects ${f.h} m — the city changed`,
    );
  }
  const g = tierGrids(b)[0];
  if (!g) return [];
  const dx = wrapCoord(spec.x - b.x + 1000) - 1000;
  const dz = wrapCoord(spec.z - b.z + 1000) - 1000;
  const onX = Math.abs(dx) / g.width >= Math.abs(dz) / g.depth;
  const out: number[] = [];
  for (let iy = 0; iy < g.ny && out.length < f.chunks; iy++) {
    const span = onX ? g.nz : g.nx;
    for (let i = 0; i < span && out.length < f.chunks; i++) {
      const ix = onX ? (dx > 0 ? g.nx - 1 : 0) : i;
      const iz = onX ? i : dz > 0 ? g.nz - 1 : 0;
      out.push(chunkId(f.b, 0, (iy * g.nz + iz) * g.nx + ix));
    }
  }
  return out;
}

/** Plan the whole stage: every strike, the quake, the fires. */
export function stageChaos(
  spec: QaChaosSpec,
  index: CityIndex,
  buildings: readonly Building[],
): QaChaosStage {
  const strikes: MissileStrike[] = [];
  if (spec.missiles)
    planMissiles(spec, spec.missiles, index, buildings, strikes);
  if (spec.meteors) planMeteors(spec, spec.meteors, buildings, strikes);
  strikes.sort((a, b) => a.t0 - b.t0 || a.id - b.id);
  let quake: QuakeEvent | null = null;
  if (spec.quake) {
    const at = aimPoint(spec, spec.quake.aim);
    quake = {
      id: QA_QUAKE_ID,
      t: Math.round(spec.worldMs + spec.quake.startMs),
      dur: spec.quake.dur,
      mag: spec.quake.mag,
      x: Math.round(at.x * 10) / 10,
      z: Math.round(at.z * 10) / 10,
    };
  }
  return {
    spec,
    strikes,
    quake,
    fires: spec.fires ? fireChunks(buildings, spec.fires, spec) : [],
    next: 0,
    foreign: 0,
  };
}

/** Is this a staged strike (vs one the server sent)? */
export const isQaStrike = (id: number): boolean => id >= QA_STRIKE_BASE;

/** What a frame holds of the stage. */
export interface QaChaosHeld {
  missiles: Map<number, MissileStrike>;
  quakes: Map<number, QuakeEvent>;
  fires: Set<number>;
}

/**
 * Re-apply the stage at world time `nowMs`: every staged strike launched by
 * now and still in the air joins `held.missiles` (once — the missile feed
 * removes it when it lands), any server strike is dropped and counted, and
 * the quake and the fires are held while they last. Allocates
 * nothing (the strikes are planned up front).
 */
export function qaChaosFrame(
  stage: QaChaosStage,
  nowMs: number,
  held: QaChaosHeld,
): void {
  for (const id of held.missiles.keys()) {
    if (isQaStrike(id)) continue;
    held.missiles.delete(id);
    stage.foreign++;
  }
  const strikes = stage.strikes;
  while (stage.next < strikes.length) {
    const m = strikes[stage.next] as MissileStrike;
    if (m.t0 > nowMs) break;
    stage.next++;
    // Launched before the stage was applied and already down: never seen.
    if (missileImpactAt(m) > nowMs) held.missiles.set(m.id, m);
  }
  const q = stage.quake;
  if (q && nowMs < q.t + q.dur && !held.quakes.has(q.id)) {
    held.quakes.set(q.id, q);
  }
  const fires = stage.fires;
  for (let i = 0; i < fires.length; i++) held.fires.add(fires[i] as number);
}

/** Take back everything the stage put into `held`. */
export function clearQaChaos(stage: QaChaosStage, held: QaChaosHeld): void {
  for (const id of held.missiles.keys()) {
    if (isQaStrike(id)) held.missiles.delete(id);
  }
  held.quakes.delete(QA_QUAKE_ID);
  for (const id of stage.fires) held.fires.delete(id);
}

/** Staged strikes in the air at `nowMs`, by kind (the verdict's read). */
export function qaStrikesInAir(
  held: ReadonlyMap<number, MissileStrike>,
  nowMs: number,
): { missiles: number; meteors: number; bombs: number } {
  const n = { missiles: 0, meteors: 0, bombs: 0 };
  for (const m of held.values()) {
    if (!isQaStrike(m.id) || m.t0 > nowMs || missileImpactAt(m) <= nowMs) {
      continue;
    }
    if (m.kind === "meteor") n.meteors++;
    else if (m.kind === "bomb") n.bombs++;
    else n.missiles++;
  }
  return n;
}

/** How long a strike of the schedule's kind flies (for spec sanity). */
export const scheduleFlightMs = (kind: "missile" | "meteor"): number =>
  missileFlightMs(kind === "meteor" ? "meteor" : "cruise");
