// S8 perf gate: the spectacle the harness stages on the client, so a
// measured window shows the same airship fleet and the same record ghost on
// every pass. QA only — reached through `__ab.qaFleet` (and S8's
// `__ab.qaBoss`, the same staging) / `__ab.qaCourseGhost` (main.ts), never
// from gameplay; a plain visit runs none of it.
//
// Why staged rather than live: the real fleet is put up by the server on
// its wall clock (server/src/boss.ts), its flak aims at wherever planes
// happen to be, and a record ghost exists only once someone has set a
// record. None of that can be pinned. Here everything is a pure function of
// the pinned WORLD clock (`__ab.pinWorld`) or of the course: Z1 puts `count`
// ships on their own lanes (FleetShip records the server could send), each
// at the spot along its lane nearest a point receding ahead of the held
// view at a known instant, and shell k of the flak schedule is fired at a
// fixed world time from a fixed turret of a fixed armed ship at a fixed
// point. Same inputs, same frame.

import {
  BOSS_FLAK_INTERVAL_MS,
  BOSS_FLAK_MIN_FUSE_MS,
  BOSS_FLAK_SPEED,
  type BossFlak,
  FLEET_LANES,
  FLEET_LAYERS,
  FLEET_SIZE,
  type FleetLane,
  type FleetShip,
  PATH_LINE,
  PATH_ORBIT,
  SHIP_CLASSES,
  SHIP_REACH,
  blankPose,
  fleetPoseAt,
  gridCoord,
  laneLength,
  lanePath,
  lanePoseInto,
  shipFullHp,
  turretMuzzleInto,
} from "@angels-bandits/common/boss";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  type Course,
  GHOST_HZ,
  GHOST_MAX_SAMPLES,
  type GhostTrack,
} from "@angels-bandits/common/courses";
import {
  type Vec3,
  wrapCoord,
  wrapDelta,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";

/** Staged ships' ids: far above any the server hands out (1, 2, …). */
export const QA_SHIP_BASE = 900_001;
/** Staged shells are numbered from here; anything below is the server's. */
export const QA_SHELL_BASE = 1_000_000_000;
/** The flak schedule starts this long before the segment's world instant,
 * so shells are already in the air when the window opens and the shell
 * draw never switches on inside it. */
export const QA_FLAK_LEAD_MS = 3000;
/** How long the staged ships have been up at the segment's instant. */
const ON_STATION_MS = 60_000;
/** Each staged ship's point recedes this much further ahead, m. */
const QA_SHIP_STEP_M = 45;
/** No staged hull comes nearer the held view than this past its own plan
 * reach (plan view), m. */
const QA_VIEW_CLEAR_M = 60;

/** Where the fake pilots weave, relative to the held view (see pilots.mjs). */
export interface QaCorridor {
  /** Ahead of the view, m. */
  near: number;
  far: number;
  /** Either side of the view's line, m. */
  lateral: number;
  /** Height band, m. */
  yLo: number;
  yHi: number;
}

export interface QaFleetSpec {
  /** The held view: position and yaw (yaw 0 faces −Z). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** How far ahead of the view the nearest ship crosses, m. */
  ahead: number;
  /** The world instant the segment is pinned to, ms. */
  worldMs: number;
  /** The ships are where they are staged this long after `worldMs`
   * (mid-window), ms. */
  crossMs: number;
  /** The flak's aim points. */
  corridor: QaCorridor;
  /** How many ships (default the whole fleet, FLEET_SIZE). */
  count?: number;
  /** The first (nearest) ship's class — a close-up's hero; default
   * whichever lane passes nearest. */
  heroClass?: 0 | 1 | 2;
  /** K1: the hero's lane outright (a break-through's), over `heroClass`. */
  heroLane?: number;
}
/** S8's name for the same spec. */
export type QaBossSpec = QaFleetSpec;

export interface QaFleetStage {
  readonly ships: readonly FleetShip[];
  readonly spec: QaFleetSpec;
  /** World time shell 0 is fired at, ms. */
  readonly flakFromMs: number;
  /** The next shell not yet handed to the socket's map. */
  next: number;
}
export type QaBossStage = QaFleetStage;

/** The plan offsets of every image of `d` near the origin (the torus). */
const IMAGES = [-2, -1, 0, 1, 2];

/**
 * `count` ships on as many lanes, each `crossMs` after `worldMs` at the
 * spot along its lane nearest its own point ahead of the view — the first
 * `ahead` m out, each next one QA_SHIP_STEP_M further — but never within
 * QA_VIEW_CLEAR_M of the view past its hull's reach. The lanes are the ones
 * passing nearest the first point. Records on the wire's grids, so they are
 * ships the server could send.
 */
export function stageFleet(spec: QaFleetSpec): QaFleetStage {
  const count = Math.max(1, Math.min(FLEET_SIZE, spec.count ?? FLEET_SIZE));
  const fx = -Math.sin(spec.yaw);
  const fz = -Math.cos(spec.yaw);
  const view = { x: spec.x, y: 0, z: spec.z };
  const crossAt = spec.worldMs + spec.crossMs;
  const t0 = Math.round(crossAt - ON_STATION_MS - spec.crossMs);
  const anchor = {
    x: wrapCoord(spec.x + fx * spec.ahead),
    y: 0,
    z: wrapCoord(spec.z + fz * spec.ahead),
  };
  /** Lane `lane`'s spot nearest plan point `t`: [s, distance across].
   * T1: an orbit's nearest spot is round its circle toward the point, a
   * berth's its dock. */
  const nearestOn = (lane: number, t: Vec3): [number, number] => {
    const ln = FLEET_LANES[lane] as FleetLane;
    const path = lanePath(lane);
    if (path !== PATH_LINE) {
      const c = wrapDelta({ x: ln.cx, y: 0, z: ln.cz }, t);
      const d = Math.hypot(c.x, c.z);
      return path === PATH_ORBIT
        ? [ln.r * Math.atan2(c.z, c.x), Math.abs(d - ln.r)]
        : [0, d];
    }
    const ly = FLEET_LAYERS[ln.layer] as { dx: number; dz: number };
    const d = wrapDelta({ x: -ly.dz * ln.u, y: 0, z: ly.dx * ln.u }, t);
    let best: [number, number] = [0, Number.POSITIVE_INFINITY];
    for (const a of IMAGES) {
      for (const b of IMAGES) {
        const x = d.x + a * WORLD_SIZE;
        const z = d.z + b * WORLD_SIZE;
        const across = Math.abs(-ly.dz * x + ly.dx * z);
        if (across < best[1]) best = [ly.dx * x + ly.dz * z, across];
      }
    }
    return best;
  };
  const byNear = FLEET_LANES.map((_, i) => i).sort(
    (a, b) => nearestOn(a, anchor)[1] - nearestOn(b, anchor)[1] || a - b,
  );
  const hero =
    spec.heroLane !== undefined && FLEET_LANES[spec.heroLane]
      ? spec.heroLane
      : (byNear.find(
          (i) =>
            spec.heroClass === undefined ||
            FLEET_LANES[i]?.cls === spec.heroClass,
        ) as number);
  const lanes = [hero, ...byNear.filter((i) => i !== hero)].slice(0, count);
  const pose = blankPose();
  const ships: FleetShip[] = lanes.map((lane, i) => {
    const ln = FLEET_LANES[lane] as FleetLane;
    const len = laneLength(lane);
    const reach = (SHIP_REACH[ln.cls] as { xz: number }).xz;
    const ahead = spec.ahead + QA_SHIP_STEP_M * i;
    const target = {
      x: wrapCoord(spec.x + fx * ahead),
      y: 0,
      z: wrapCoord(spec.z + fz * ahead),
    };
    // The nearest spot to its point that keeps the view clear of the hull.
    const [s0] = nearestOn(lane, target);
    let best = s0;
    let bestD = Number.POSITIVE_INFINITY;
    // T1: an orbit is searched round its circle, a berth not at all.
    const step = lanePath(lane) === PATH_LINE ? 20 : len / 81;
    for (let k = -40; k <= 40; k++) {
      const sk = s0 + k * step;
      lanePoseInto(lane, sk, pose);
      const p = { x: pose.x, y: 0, z: pose.z };
      const off = wrapDelta(view, p);
      if (Math.hypot(off.x, off.z) < reach + QA_VIEW_CLEAR_M) continue;
      const to = wrapDelta(target, p);
      const dist = Math.hypot(to.x, to.z);
      if (dist < bestD) {
        bestD = dist;
        best = sk;
      }
    }
    // Where it starts so it is there at the crossing.
    const start = best - (ln.v * (crossAt - t0)) / 1000;
    const wrapped = ((start % len) + len) % len;
    const q = Math.round(wrapped * 10) / 10;
    return {
      id: QA_SHIP_BASE + i,
      lane,
      t0,
      s0: q >= len ? 0 : q,
      hp0: shipFullHp(ln.cls, 1),
      down: null,
    };
  });
  return {
    ships,
    spec,
    flakFromMs: spec.worldMs - QA_FLAK_LEAD_MS,
    next: 0,
  };
}
/** S8's name for the same staging. */
export const stageBoss = stageFleet;

/** Shell k's share of [0, 1) for channel `c`: an integer hash, no state. */
function unit(k: number, c: number): number {
  let h = Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(c + 1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** The staged fleet's guns, in order: [ship index, turret]. */
function gunsOf(stage: QaFleetStage): [number, number][] {
  const out: [number, number][] = [];
  stage.ships.forEach((s, i) => {
    const cls = (FLEET_LANES[s.lane] as { cls: number }).cls;
    for (const k of SHIP_CLASSES[cls]?.turrets ?? []) out.push([i, k]);
  });
  return out;
}

/** One shell per gun per BOSS_FLAK_INTERVAL_MS, the guns staggered (at
 * least one gun's pace when the staged ships carry none). */
const shellEveryMs = (stage: QaFleetStage): number =>
  BOSS_FLAK_INTERVAL_MS / Math.max(1, gunsOf(stage).length);
const muzzlePose = blankPose();
const muzzle: Vec3 = { x: 0, y: 0, z: 0 };

/** Shell k of the stage's schedule (a new object: QA, a few a second), or
 * null when no staged ship is armed. */
export function qaShell(stage: QaFleetStage, k: number): BossFlak | null {
  const guns = gunsOf(stage);
  if (guns.length === 0) return null;
  const s = stage.spec;
  const c = s.corridor;
  const t0 = Math.round(stage.flakFromMs + k * shellEveryMs(stage));
  const [i, turret] = guns[k % guns.length] as [number, number];
  const ship = stage.ships[i] as FleetShip;
  const ahead = c.near + (c.far - c.near) * unit(k, 0);
  const side = c.lateral * (2 * unit(k, 1) - 1);
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  const to: Vec3 = {
    x: gridCoord(s.x + fx * ahead + Math.cos(s.yaw) * side),
    y: Math.round((c.yLo + (c.yHi - c.yLo) * unit(k, 2)) * 10) / 10,
    z: gridCoord(s.z + fz * ahead - Math.sin(s.yaw) * side),
  };
  const cls = (FLEET_LANES[ship.lane] as { cls: 0 | 1 | 2 }).cls;
  turretMuzzleInto(fleetPoseAt(ship, t0, muzzlePose), cls, turret, muzzle);
  const from = {
    x: gridCoord(muzzle.x),
    y: Math.round(muzzle.y * 10) / 10,
    z: gridCoord(muzzle.z),
  };
  const dist = Math.hypot(
    wrapDeltaAxis(from.x, to.x),
    to.y - from.y,
    wrapDeltaAxis(from.z, to.z),
  );
  const fuse = Math.max(
    BOSS_FLAK_MIN_FUSE_MS,
    Math.round((dist / BOSS_FLAK_SPEED) * 1000),
  );
  return { id: QA_SHELL_BASE + k, from, to, t0, fuse };
}

/** Is this a staged shell (vs one the server sent)? */
export const isQaShell = (id: number): boolean => id >= QA_SHELL_BASE;

/**
 * Hand `into` every shell fired by world time `nowMs` that it has not had
 * yet. Returns how many were added. The renderer bursts and drops them.
 */
export function qaFlakDue(
  stage: QaFleetStage,
  nowMs: number,
  into: Map<number, BossFlak>,
): number {
  let added = 0;
  const every = shellEveryMs(stage);
  while (stage.flakFromMs + stage.next * every <= nowMs) {
    const f = qaShell(stage, stage.next++);
    if (!f) break;
    into.set(f.id, f);
    added++;
  }
  return added;
}

/**
 * A record ghost for `course`: its ring centres in order, flown at a
 * constant `speed` m/s from the start ring, sampled on the GHOST_HZ grid
 * (the decoded wire form, so CourseGhost plays it like a real record).
 */
export function qaGhostTrack(course: Course, speed: number): GhostTrack {
  const dt = 1000 / GHOST_HZ;
  const rings = course.rings;
  // Unwrapped polyline through the ring centres.
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const along: number[] = [0];
  for (let i = 0; i < rings.length; i++) {
    const p = (rings[i] as Course["rings"][number]).pos;
    if (i === 0) {
      px.push(p.x);
      py.push(p.y);
      pz.push(p.z);
      continue;
    }
    const x = (px[i - 1] as number) + wrapDeltaAxis(px[i - 1] as number, p.x);
    const z = (pz[i - 1] as number) + wrapDeltaAxis(pz[i - 1] as number, p.z);
    px.push(x);
    py.push(p.y);
    pz.push(z);
    along.push(
      (along[i - 1] as number) +
        Math.hypot(
          x - (px[i - 1] as number),
          p.y - (py[i - 1] as number),
          z - (pz[i - 1] as number),
        ),
    );
  }
  const total = along[along.length - 1] as number;
  const durMs = (total / speed) * 1000;
  const count = Math.min(GHOST_MAX_SAMPLES, Math.ceil(durMs / dt) + 1);
  const pts = new Float64Array(count * 3);
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = Math.min(total, (speed * k * dt) / 1000);
    while (seg < along.length - 2 && (along[seg + 1] as number) < d) seg++;
    const a = along[seg] as number;
    const b = along[seg + 1] as number;
    const f = b > a ? (d - a) / (b - a) : 0;
    const lerp = (xs: number[]) =>
      (xs[seg] as number) + ((xs[seg + 1] as number) - (xs[seg] as number)) * f;
    pts[k * 3] = wrapCoord(lerp(px));
    pts[k * 3 + 1] = lerp(py);
    pts[k * 3 + 2] = wrapCoord(lerp(pz));
  }
  return { pts, count, durMs };
}
