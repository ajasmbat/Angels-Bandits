// S8 perf gate: the spectacle the harness stages on the client, so a
// measured window shows the same boss fight and the same record ghost on
// every pass. QA only — reached through `__ab.qaBoss` / `__ab.qaCourseGhost`
// (main.ts), never from gameplay; a plain visit runs none of it.
//
// Why staged rather than live: a real raid is started by the server on its
// wall clock (server/src/boss.ts), its flak aims at wherever planes happen to
// be, and a record ghost exists only once someone has set a record. None of
// that can be pinned. Here everything is a pure function of the pinned WORLD
// clock (`__ab.pinWorld`) or of the course: the zeppelin's pose is the shared
// `bossPoseAt` of a raid built to cross the held view at a known instant, and
// shell k of the flak schedule is fired at a fixed world time from a fixed
// turret at a fixed point. Same inputs, same frame.

import {
  BOSS_FLAK_INTERVAL_MS,
  BOSS_FLAK_MIN_FUSE_MS,
  BOSS_FLAK_SPEED,
  BOSS_INGRESS_M,
  BOSS_ORBIT_MS,
  BOSS_ORBIT_R,
  BOSS_SPEED,
  BOSS_TURRETS,
  type BossFlak,
  type BossRaid,
  blankPose,
  bossPoseAt,
  turretMuzzleInto,
} from "@angels-bandits/common/boss";
import {
  type Course,
  GHOST_HZ,
  GHOST_MAX_SAMPLES,
  type GhostTrack,
} from "@angels-bandits/common/courses";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";

/** A staged raid's id: far above any the server hands out (1, 2, …). */
export const QA_RAID_ID = 900_001;
/** Staged shells are numbered from here; anything below is the server's. */
export const QA_SHELL_BASE = 1_000_000_000;
/** The flak schedule starts this long before the segment's world instant,
 * so shells are already in the air when the window opens and the shell
 * draw never switches on inside it. */
export const QA_FLAK_LEAD_MS = 3000;
/** How long the zeppelin has been on station at the crossing instant. */
const ON_STATION_MS = 60_000;

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

export interface QaBossSpec {
  /** The held view: position and yaw (yaw 0 faces −Z). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** How far ahead of the view the hull's centre crosses, m. */
  ahead: number;
  /** The world instant the segment is pinned to, ms. */
  worldMs: number;
  /** The crossing happens this long after `worldMs` (mid-window), ms. */
  crossMs: number;
  /** The flak's aim points. */
  corridor: QaCorridor;
}

export interface QaBossStage {
  readonly raid: BossRaid;
  readonly spec: QaBossSpec;
  /** World time shell 0 is fired at, ms. */
  readonly flakFromMs: number;
  /** The next shell not yet handed to the socket's map. */
  next: number;
}

/**
 * A raid whose zeppelin, `crossMs` after `worldMs`, is `ahead` metres in
 * front of the view at its centre, flying across it left to right (the
 * view's +X side), on station for a minute already. On the wire's grids
 * (centre 0.1 m, angle 0.001 rad), so it is a raid the server could send.
 */
export function stageBoss(spec: QaBossSpec): QaBossStage {
  // Forward (yaw 0 faces −Z) and right of the view.
  const fx = -Math.sin(spec.yaw);
  const fz = -Math.cos(spec.yaw);
  const hx = Math.cos(spec.yaw);
  const hz = -Math.sin(spec.yaw);
  const px = spec.x + fx * spec.ahead;
  const pz = spec.z + fz * spec.ahead;
  // On the orbit the heading is (−sin θ, cos θ); centre = P − R (cos θ, sin θ).
  const th = Math.atan2(-hx, hz);
  const cx = px - BOSS_ORBIT_R * Math.cos(th);
  const cz = pz - BOSS_ORBIT_R * Math.sin(th);
  const onStationM = (BOSS_SPEED * ON_STATION_MS) / 1000;
  const crossAt = spec.worldMs + spec.crossMs;
  const q = (v: number) => Math.round(wrapCoord(v) * 10) / 10;
  const raid: BossRaid = {
    id: QA_RAID_ID,
    t0: Math.round(
      crossAt - ((BOSS_INGRESS_M + onStationM) / BOSS_SPEED) * 1000,
    ),
    cx: q(cx),
    cz: q(cz),
    th0: Math.round((th - onStationM / BOSS_ORBIT_R) * 1000) / 1000,
    orbitMs: BOSS_ORBIT_MS,
    hpScale: 1,
  };
  return {
    raid,
    spec,
    flakFromMs: spec.worldMs - QA_FLAK_LEAD_MS,
    next: 0,
  };
}

/** Shell k's share of [0, 1) for channel `c`: an integer hash, no state. */
function unit(k: number, c: number): number {
  let h = Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(c + 1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** One shell per turret per BOSS_FLAK_INTERVAL_MS, turrets staggered. */
const SHELL_EVERY_MS = BOSS_FLAK_INTERVAL_MS / BOSS_TURRETS.length;
const muzzlePose = blankPose();
const muzzle: Vec3 = { x: 0, y: 0, z: 0 };

/** Shell k of the stage's schedule (a new object: QA, a few a second). */
export function qaShell(stage: QaBossStage, k: number): BossFlak {
  const s = stage.spec;
  const c = s.corridor;
  const t0 = Math.round(stage.flakFromMs + k * SHELL_EVERY_MS);
  const turret = k % BOSS_TURRETS.length;
  const ahead = c.near + (c.far - c.near) * unit(k, 0);
  const side = c.lateral * (2 * unit(k, 1) - 1);
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  const to: Vec3 = {
    x:
      Math.round(wrapCoord(s.x + fx * ahead + Math.cos(s.yaw) * side) * 10) /
      10,
    y: Math.round((c.yLo + (c.yHi - c.yLo) * unit(k, 2)) * 10) / 10,
    z:
      Math.round(wrapCoord(s.z + fz * ahead - Math.sin(s.yaw) * side) * 10) /
      10,
  };
  turretMuzzleInto(bossPoseAt(stage.raid, t0, muzzlePose), turret, muzzle);
  const dist = Math.hypot(
    wrapDeltaAxis(muzzle.x, to.x),
    to.y - muzzle.y,
    wrapDeltaAxis(muzzle.z, to.z),
  );
  const fuse = Math.max(
    BOSS_FLAK_MIN_FUSE_MS,
    Math.round((dist / BOSS_FLAK_SPEED) * 1000),
  );
  return { id: QA_SHELL_BASE + k, turret, to, t0, fuse };
}

/** Is this a staged shell (vs one the server sent)? */
export const isQaShell = (id: number): boolean => id >= QA_SHELL_BASE;

/**
 * Hand `into` every shell fired by world time `nowMs` that it has not had
 * yet. Returns how many were added. The renderer bursts and drops them.
 */
export function qaFlakDue(
  stage: QaBossStage,
  nowMs: number,
  into: Map<number, BossFlak>,
): number {
  let added = 0;
  while (stage.flakFromMs + stage.next * SHELL_EVERY_MS <= nowMs) {
    const f = qaShell(stage, stage.next++);
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
