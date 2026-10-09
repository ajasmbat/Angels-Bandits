// S4 sky boss — the shared, pure half. Every ~15 minutes the SERVER sends an
// armoured war zeppelin over a room (server/src/boss.ts): it broadcasts one
// raid (id, start time, orbit centre, entry angle), and from there the
// zeppelin's pose is a pure function of (raid, synced clock) — the L2 movers'
// trick — so every client draws, collides with and shoots at the same hull at
// the same server instant. What only the server knows is streamed: weak-point
// HP, flak shells (each one a burst point and a fuse) and, when it goes down,
// the break-up — three hull sections falling on the D4 wreck path to impacts
// the server swept once.
//
// Draw == collide: the hull is ONE table of yaw-only boxes (BOSS_PARTS) and
// one derivation of where each is (bossPartBoxInto / bossPiecePartBoxInto).
// The renderer instances exactly those boxes and collideBoss tests exactly
// those boxes. The weak points are some of those boxes (engine pods and
// armoured gas-cell blisters) — solid like the rest, drawn glowing.
//
// Not re-exported from common/src/index.ts; import "@angels-bandits/common/boss".

import type { Building } from "./city/index";
import { type MoverBox, type MoverHit, sphereHitsBox } from "./city/movers";
import { type CityIndex, collideCity, hitsGround } from "./collision";
import {
  BOT_AIM_JITTER,
  BOT_REACTION_MS,
  BULLET_RANGE,
  HIT_RADIUS,
  MAX_HP,
  WORLD_SIZE,
  WRECK_MAX_MS,
  WRECK_STEP_MS,
} from "./constants";
import {
  type Vec3,
  wrapCoord,
  wrapDelta,
  wrapDeltaAxis,
  wrapDeltaInto,
} from "./world/index";
import { type WreckHit, type WreckPath, wreckPosAt } from "./wreck";

// --- Flight envelope ----------------------------------------------------------

/** Cruise altitude of the hull's centre, m. The whole hull (268–337 m) sits
 * over every roof (250 m) and helicopter (≤ 263 m), under the news heli
 * (≥ 346.8 m), the blimp (≥ 416 m) and CLOUD_BASE. */
export const BOSS_ALT = 305;
/** Cruise speed, m/s — a lumbering thing, slower than any plane's MIN_SPEED. */
export const BOSS_SPEED = 16;
/** Orbit radius around the raid's centre, m. */
export const BOSS_ORBIT_R = 360;
/** Straight run-in along the orbit's tangent, m, and the run-out after. */
export const BOSS_INGRESS_M = 720;
export const BOSS_EGRESS_M = 900;
/** Time on station (the orbit) before it gives up and leaves, ms. */
export const BOSS_ORBIT_MS = 300_000;

/** DamageMsg shooter id for flak, and the AwardMsg victim id of the boss
 * itself. Player ids are UUIDs and bots `bot:<room>:<n>`, so it can never
 * name a plane (like MISSILE_SHOOTER_ID). */
export const BOSS_ID = "@boss";
/** Bot contacts for weak point k are `@boss:<k>` (server only). */
export const BOSS_CONTACT_PREFIX = "@boss:";

// --- The hull -----------------------------------------------------------------

export type BossPartKind =
  | "hull"
  | "fin"
  | "gondola"
  | "engine"
  | "cell"
  | "turret";

/** One box of the hull in its own frame: +X the nose, +Y up, +Z starboard
 * (the MoverBox convention), centre and half-extents in m. `piece` is the
 * section it falls with when the boss breaks up (0 fore, 1 mid, 2 aft). */
export interface BossPart {
  kind: BossPartKind;
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  piece: 0 | 1 | 2;
}

const part = (
  kind: BossPartKind,
  piece: 0 | 1 | 2,
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
): BossPart => ({ kind, x, y, z, hx, hy, hz, piece });

/**
 * THE hull. 260 m nose to tail (the L2 blimp is 92 m), 56 m deep, 76 m
 * across the engine pods. Order is protocol: weak points and turrets index
 * into it, and the renderer's instances are these, in this order.
 */
export const BOSS_PARTS: readonly BossPart[] = [
  part("hull", 1, 0, 0, 0, 70, 26, 28), // 0 mid section
  part("hull", 0, 95, 0, 0, 25, 21, 23), // 1 fore section
  part("hull", 0, 128, -1, 0, 8, 14, 15), // 2 armoured nose
  part("hull", 2, -95, 0, 0, 25, 21, 23), // 3 aft section
  part("hull", 2, -126, 0, 0, 6, 13, 14), // 4 tail cone
  part("fin", 2, -110, 26.5, 0, 14, 5.5, 1.2), // 5 dorsal fin
  part("fin", 2, -110, -26.5, 0, 14, 5.5, 1.2), // 6 ventral fin
  part("fin", 2, -110, 0, 29.5, 14, 1.2, 6.5), // 7 starboard fin
  part("fin", 2, -110, 0, -29.5, 14, 1.2, 6.5), // 8 port fin
  part("gondola", 1, 12, -31, 0, 24, 5, 8), // 9 command gondola
  part("engine", 1, 48, -14, 33, 8, 4.5, 5), // 10 engine, fore starboard
  part("engine", 1, 48, -14, -33, 8, 4.5, 5), // 11 engine, fore port
  part("engine", 1, -48, -14, 33, 8, 4.5, 5), // 12 engine, aft starboard
  part("engine", 1, -48, -14, -33, 8, 4.5, 5), // 13 engine, aft port
  part("cell", 1, 28, 8, 29.5, 7, 6, 1.5), // 14 gas cell, starboard
  part("cell", 1, -28, 8, -29.5, 7, 6, 1.5), // 15 gas cell, port
  part("cell", 1, 0, 27.5, 0, 8, 1.5, 7), // 16 gas cell, dorsal
  part("turret", 1, 45, 28, 0, 3, 2, 3), // 17 dorsal turret, fore
  part("turret", 1, -45, 28, 0, 3, 2, 3), // 18 dorsal turret, aft
  part("turret", 1, 58, -28, 14, 3, 2, 3), // 19 ventral turrets
  part("turret", 1, 58, -28, -14, 3, 2, 3), // 20
  part("turret", 1, -58, -28, 14, 3, 2, 3), // 21
  part("turret", 1, -58, -28, -14, 3, 2, 3), // 22
];

/** Furthest any part reaches from the hull centre, per axis, m (reject
 * tests: the hull is never further than this from its centre). */
export const BOSS_REACH_X = 136;
export const BOSS_REACH_Y = 36;
export const BOSS_REACH_Z = 38;
/** Plan-view reach of the hull from its centre (its length and beam), m. */
export const BOSS_REACH_XZ = Math.hypot(BOSS_REACH_X, BOSS_REACH_Z);
/** Bounding radius of the whole hull about its centre, m. */
export const BOSS_RADIUS = Math.hypot(BOSS_REACH_X, BOSS_REACH_Y, BOSS_REACH_Z);

/** The weak points: indices into BOSS_PARTS (4 engines, then 3 gas cells). */
export const BOSS_WEAK_POINTS: readonly number[] = [10, 11, 12, 13, 14, 15, 16];
/** Each weak point's full HP at hpScale 1 (engines, then gas cells). */
export const BOSS_WEAK_HP: readonly number[] = [
  260, 260, 260, 260, 380, 380, 380,
];
/** A weak point's bullet target: a sphere this big round its box centre, m —
 * the plane hit radius, so a round that would hit a plane there hits it. */
export const BOSS_WEAK_RADIUS = HIT_RADIUS;

/** Flak turrets: their BOSS_PARTS index and which way they face (+1 dorsal,
 * -1 ventral). The muzzle is the middle of that face. */
export const BOSS_TURRETS: readonly { part: number; up: 1 | -1 }[] = [
  { part: 17, up: 1 },
  { part: 18, up: 1 },
  { part: 19, up: -1 },
  { part: 20, up: -1 },
  { part: 21, up: -1 },
  { part: 22, up: -1 },
];

/** The three sections it breaks into: their anchor (the frame they fall and
 * turn about) in the hull frame, and the boxes whose bottoms the impact sweep
 * tests (the big section and whatever hangs lowest under it). */
export const BOSS_PIECES: readonly {
  ax: number;
  sweep: readonly number[];
}[] = [
  { ax: 100, sweep: [1, 2] },
  { ax: 0, sweep: [0, 9] },
  { ax: -100, sweep: [3, 4] },
];

// --- Raids --------------------------------------------------------------------

/** One raid, exactly as broadcast. `cx`/`cz` canonical, on the wire's 0.1 m
 * grid; `th0` on a 0.001 rad grid; `hpScale` on a 0.01 grid. */
export interface BossRaid {
  id: number;
  /** When the run-in starts, server clock ms. */
  t0: number;
  cx: number;
  cz: number;
  /** Orbit angle where the run-in joins the circle, rad. */
  th0: number;
  /** Time on station, ms. */
  orbitMs: number;
  /** Weak-point HP multiplier (tests and QA run small bosses). */
  hpScale: number;
}

const ingressMs = (): number => (BOSS_INGRESS_M / BOSS_SPEED) * 1000;
const egressMs = (): number => (BOSS_EGRESS_M / BOSS_SPEED) * 1000;

/** When it is first in the air, and when the run-out ends (gone), ms. */
export const raidStart = (r: BossRaid): number => r.t0;
export const raidEnd = (r: BossRaid): number =>
  r.t0 + ingressMs() + r.orbitMs + egressMs();
/** When the orbit ends and the run-out begins, ms. */
export const raidEgressAt = (r: BossRaid): number =>
  r.t0 + ingressMs() + r.orbitMs;

/** The zeppelin's pose: centre (canonical x/z), the yaw its boxes carry, and
 * its unit heading in (x, z). */
export interface BossPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  hx: number;
  hz: number;
}

export const blankPose = (): BossPose => ({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  hx: 1,
  hz: 0,
});

/**
 * Where the raid's zeppelin is at server time `t`, into `out`. The path: a
 * straight run-in along the orbit's tangent at `th0`, a counter-clockwise
 * (increasing angle) orbit of BOSS_ORBIT_R around (cx, cz) for `orbitMs`, a
 * straight run-out along the tangent where it left. Constant speed, C1 at
 * both joins. Clamped to the path's ends outside [t0, raidEnd]. Pure.
 */
export function bossPoseAt(r: BossRaid, t: number, out: BossPose): BossPose {
  const total =
    BOSS_INGRESS_M + BOSS_SPEED * (r.orbitMs / 1000) + BOSS_EGRESS_M;
  const s = Math.min(total, Math.max(0, (BOSS_SPEED * (t - r.t0)) / 1000));
  const orbitLen = BOSS_SPEED * (r.orbitMs / 1000);
  let x: number;
  let z: number;
  let th: number;
  if (s < BOSS_INGRESS_M) {
    th = r.th0;
    const back = BOSS_INGRESS_M - s;
    x = r.cx + BOSS_ORBIT_R * Math.cos(th) + Math.sin(th) * back;
    z = r.cz + BOSS_ORBIT_R * Math.sin(th) - Math.cos(th) * back;
  } else if (s < BOSS_INGRESS_M + orbitLen) {
    th = r.th0 + (s - BOSS_INGRESS_M) / BOSS_ORBIT_R;
    x = r.cx + BOSS_ORBIT_R * Math.cos(th);
    z = r.cz + BOSS_ORBIT_R * Math.sin(th);
  } else {
    th = r.th0 + orbitLen / BOSS_ORBIT_R;
    const on = s - BOSS_INGRESS_M - orbitLen;
    x = r.cx + BOSS_ORBIT_R * Math.cos(th) - Math.sin(th) * on;
    z = r.cz + BOSS_ORBIT_R * Math.sin(th) + Math.cos(th) * on;
  }
  // Heading: the tangent (−sin θ, cos θ). Local +X = world (cos yaw, −sin yaw).
  out.hx = -Math.sin(th);
  out.hz = Math.cos(th);
  out.yaw = Math.atan2(-out.hz, out.hx);
  out.x = wrapCoord(x);
  out.y = BOSS_ALT;
  out.z = wrapCoord(z);
  return out;
}

/** Its velocity at `t`, m/s (zero outside the flight). */
export function bossVelAt(r: BossRaid, t: number, out: Vec3): Vec3 {
  const pose = bossPoseAt(r, t, scratchPose);
  const flying = t >= r.t0 && t < raidEnd(r);
  out.x = flying ? pose.hx * BOSS_SPEED : 0;
  out.y = 0;
  out.z = flying ? pose.hz * BOSS_SPEED : 0;
  return out;
}

// --- Schedule -----------------------------------------------------------------

export interface BossTuning {
  /** First raid this long after a human is in the room, ms. */
  firstMinMs: number;
  firstMaxMs: number;
  /** Start to start, ms, ± jitter. */
  periodMs: number;
  periodJitterMs: number;
  orbitMs: number;
  hpScale: number;
}

export const BOSS_TUNING: BossTuning = {
  firstMinMs: 240_000,
  firstMaxMs: 360_000,
  periodMs: 900_000,
  periodJitterMs: 90_000,
  orbitMs: BOSS_ORBIT_MS,
  hpScale: 1,
};

/** AB_BOSS_FAST=1 (tests and QA only): a small boss, right away. */
export const BOSS_FAST_TUNING: BossTuning = {
  firstMinMs: 2000,
  firstMaxMs: 3000,
  periodMs: 120_000,
  periodJitterMs: 0,
  orbitMs: 90_000,
  hpScale: 0.1,
};

/**
 * When the next raid starts: the first one firstMin..firstMax after a human
 * arrived (`humanSince`), every later one periodMs ± periodJitterMs after the
 * previous START. Pure in its inputs and `rand`; whole ms.
 */
export function nextRaidAt(
  prevStart: number | null,
  humanSince: number,
  rand: () => number,
  tuning: BossTuning = BOSS_TUNING,
): number {
  if (prevStart === null) {
    return Math.round(
      humanSince +
        tuning.firstMinMs +
        (tuning.firstMaxMs - tuning.firstMinMs) * rand(),
    );
  }
  return Math.round(
    prevStart + tuning.periodMs + (rand() * 2 - 1) * tuning.periodJitterMs,
  );
}

/** The raid itself: a seeded centre and entry angle, quantised to the wire. */
export function planRaid(
  rand: () => number,
  id: number,
  t0: number,
  tuning: BossTuning = BOSS_TUNING,
): BossRaid {
  const qc = (v: number) => {
    const c = Math.round(wrapCoord(v) * 10) / 10;
    return c >= WORLD_SIZE ? 0 : c;
  };
  return {
    id,
    t0: Math.round(t0),
    cx: qc(rand() * WORLD_SIZE),
    cz: qc(rand() * WORLD_SIZE),
    th0: Math.round(rand() * Math.PI * 2 * 1000) / 1000,
    orbitMs: Math.round(tuning.orbitMs),
    hpScale: Math.round(tuning.hpScale * 100) / 100,
  };
}

/** Full HP of weak point `k` on this raid. */
export const weakMaxHp = (r: BossRaid, k: number): number =>
  Math.max(1, Math.round((BOSS_WEAK_HP[k] ?? 0) * r.hpScale));

/** Every weak point's full HP. */
export const raidMaxHp = (r: BossRaid): number[] =>
  BOSS_WEAK_HP.map((_, k) => weakMaxHp(r, k));

// --- Where the parts are --------------------------------------------------------

const scratchPose = blankPose();

/** Hull-frame offset (lx, ly, lz) placed by `pose` into world `out`. */
function placeLocal(
  pose: BossPose,
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

/**
 * THE definition of where part `i` of an intact hull at `pose` is: writes its
 * canonical box into `out` (the renderer and collideBoss both come here).
 */
export function bossPartBoxInto(
  pose: BossPose,
  i: number,
  out: MoverBox,
): MoverBox {
  const p = BOSS_PARTS[i] as BossPart;
  placeLocal(pose, p.x, p.y, p.z, out);
  out.hx = p.hx;
  out.hy = p.hy;
  out.hz = p.hz;
  out.yaw = pose.yaw;
  out.kind = "boss";
  out.id = i;
  return out;
}

/** The centre of weak point `k` (its box centre) at `pose`. */
export function weakPointInto(pose: BossPose, k: number, out: Vec3): Vec3 {
  const p = BOSS_PARTS[BOSS_WEAK_POINTS[k] as number] as BossPart;
  return placeLocal(pose, p.x, p.y, p.z, out);
}

/** Turret `k`'s muzzle (the middle of its outer face) at `pose`. */
export function turretMuzzleInto(pose: BossPose, k: number, out: Vec3): Vec3 {
  const t = BOSS_TURRETS[k] as { part: number; up: 1 | -1 };
  const p = BOSS_PARTS[t.part] as BossPart;
  return placeLocal(pose, p.x, p.y + t.up * p.hy, p.z, out);
}

// --- Break-up -----------------------------------------------------------------

/** How fast a falling section turns about its anchor, rad/s (× spin). */
export const BOSS_PIECE_YAW_RATE = 0.22;
/** Extra speed each section leaves with, m/s: the fore section surges on,
 * the aft one drags; the mid section drops out from under the gas cells. */
const PIECE_KICK: readonly { along: number; up: number }[] = [
  { along: 7, up: -2 },
  { along: 0, up: 1.5 },
  { along: -6, up: -1 },
];

/** One falling section, exactly as it crosses the wire. Its anchor follows
 * the D4 wreck path (p, v, t = the down's time, spin, end); its boxes turn
 * about the anchor at BOSS_PIECE_YAW_RATE from `yaw`. */
export interface BossPiece {
  k: 0 | 1 | 2;
  p: Vec3;
  v: Vec3;
  yaw: number;
  spin: 1 | -1;
  /** ms after the down when it hits (server-swept), ≤ WRECK_MAX_MS. */
  end: number;
  hit: WreckHit;
  /** Where it hits: the bottom of the sweep sphere that touched first (an
   * air burst: the bottom of its main box), canonical. Swept once against
   * the city as it stood at the down — never re-derived after other
   * sections have broken it. */
  at: Vec3;
  /** The building it came down on (index into the city, the chunk-id
   * order), or -1: the street, the river, the air. */
  b: number;
}

/** The boss went down: when, and its three sections. */
export interface BossDown {
  /** The raid it ends. */
  id: number;
  t: number;
  pieces: BossPiece[];
}

/** The part of a falling section its pose depends on. */
export type BossPiecePath = Pick<BossPiece, "k" | "p" | "v" | "yaw" | "spin">;

const pathOf = (piece: BossPiecePath, t: number, end: number): WreckPath => ({
  p: piece.p,
  v: piece.v,
  t,
  spin: piece.spin,
  end,
});

/** The section's anchor pose at server time `ms` (clamped to the fall), as a
 * BossPose (y = the anchor's altitude). */
export function piecePoseAt(
  piece: BossPiecePath,
  t: number,
  end: number,
  ms: number,
  out: BossPose,
): BossPose {
  const path = pathOf(piece, t, end);
  wreckPosAt(path, ms, anchor);
  const s = Math.min(Math.max(ms - t, 0), end) / 1000;
  out.x = anchor.x;
  out.y = anchor.y;
  out.z = anchor.z;
  out.yaw = piece.yaw + piece.spin * BOSS_PIECE_YAW_RATE * s;
  out.hx = Math.cos(out.yaw);
  out.hz = -Math.sin(out.yaw);
  return out;
}
const anchor: Vec3 = { x: 0, y: 0, z: 0 };

/** Part `i` (which must belong to the section) of a falling section posed at
 * `pose` (its anchor pose, from piecePoseAt): the same box as the intact hull
 * at the down instant, then falling and turning with the section. */
export function bossPiecePartBoxInto(
  piece: BossPiecePath,
  pose: BossPose,
  i: number,
  out: MoverBox,
): MoverBox {
  const p = BOSS_PARTS[i] as BossPart;
  const ax = (BOSS_PIECES[piece.k] as { ax: number }).ax;
  placeLocal(pose, p.x - ax, p.y, p.z, out);
  out.hx = p.hx;
  out.hy = p.hy;
  out.hz = p.hz;
  out.yaw = pose.yaw;
  out.kind = "bossDebris";
  out.id = i;
  return out;
}

/** Parts of section `k`, in BOSS_PARTS order. */
export const PIECE_PARTS: readonly (readonly number[])[] = [0, 1, 2].map((k) =>
  BOSS_PARTS.flatMap((p, i) => (p.piece === k ? [i] : [])),
);

/** How far any box of section `k` reaches from its anchor, m (its reject
 * radius while it falls). */
export const PIECE_REACH: readonly number[] = PIECE_PARTS.map((parts, k) => {
  const ax = (BOSS_PIECES[k] as { ax: number }).ax;
  let reach = 0;
  for (const i of parts) {
    const p = BOSS_PARTS[i] as BossPart;
    reach = Math.max(
      reach,
      Math.hypot(
        Math.abs(p.x - ax) + p.hx,
        Math.abs(p.y) + p.hy,
        Math.abs(p.z) + p.hz,
      ),
    );
  }
  return reach;
});

/** Spin of section `k` of raid `id`: from the ids, never from where. */
const pieceSpin = (id: number, k: number): 1 | -1 =>
  (id + k) % 2 === 0 ? 1 : -1;

/** What a falling section is swept against: the room's city as it stands. */
export interface BossSweepWorld {
  buildings: readonly Building[];
  index?: CityIndex;
}

const sweepBox: MoverBox = {
  x: 0,
  y: 0,
  z: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  yaw: 0,
  kind: "bossDebris",
  id: 0,
};
const sweepPose = blankPose();
const sweepAt: Vec3 = { x: 0, y: 0, z: 0 };

/** What touched at `ms`: the sphere of the chain that did (its centre, in
 * `contactAt`, and radius), what it hit, and the building when it was one. */
interface Contact {
  hit: WreckHit;
  r: number;
  building: Building | null;
}
const contactAt: Vec3 = { x: 0, y: 0, z: 0 };

function pieceContactAt(
  piece: BossPiecePath,
  t: number,
  ms: number,
  world: BossSweepWorld,
): Contact | null {
  piecePoseAt(piece, t, WRECK_MAX_MS, ms, sweepPose);
  for (const i of (BOSS_PIECES[piece.k] as { sweep: readonly number[] })
    .sweep) {
    bossPiecePartBoxInto(piece, sweepPose, i, sweepBox);
    const r = Math.min(sweepBox.hy, sweepBox.hz);
    const n = Math.max(1, Math.ceil(sweepBox.hx / r));
    const c = Math.cos(sweepBox.yaw);
    const s = Math.sin(sweepBox.yaw);
    for (let j = 0; j < n; j++) {
      const lx =
        n === 1
          ? 0
          : -sweepBox.hx + r + ((2 * sweepBox.hx - 2 * r) * j) / (n - 1);
      contactAt.x = wrapCoord(sweepBox.x + lx * c);
      contactAt.y = sweepBox.y;
      contactAt.z = wrapCoord(sweepBox.z - lx * s);
      if (hitsGround(contactAt, r)) return { hit: "ground", r, building: null };
      const b = collideCity(contactAt, r, world.buildings, world.index);
      if (b) return { hit: "city", r, building: b };
    }
  }
  return null;
}

/**
 * Sweep a section's fall for its first solid (the D4 recipe: fixed
 * WRECK_STEP_MS steps, then bisection). Nothing by WRECK_MAX_MS → it bursts
 * in the air there. Deterministic in its inputs.
 */
export function bossPieceImpact(
  piece: BossPiecePath,
  t: number,
  world: BossSweepWorld,
): { end: number; hit: WreckHit; at: Vec3; b: number } {
  let lo = 0;
  for (let ms = WRECK_STEP_MS; ms <= WRECK_MAX_MS; ms += WRECK_STEP_MS) {
    let c = pieceContactAt(piece, t, t + ms, world);
    if (!c) {
      lo = ms;
      continue;
    }
    let hi = ms;
    // The contact (and contactAt) of the latest touching time is the one
    // reported: keep a copy, bisection overwrites the scratch.
    let at = { ...contactAt };
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      const h = pieceContactAt(piece, t, t + mid, world);
      if (h) {
        hi = mid;
        c = h;
        at = { ...contactAt };
      } else lo = mid;
    }
    return {
      end: Math.round(hi * 10) / 10,
      hit: c.hit,
      at: { x: at.x, y: Math.max(0, at.y - c.r), z: at.z },
      b: c.building ? world.buildings.indexOf(c.building) : -1,
    };
  }
  const pose = piecePoseAt(
    piece,
    t,
    WRECK_MAX_MS,
    t + WRECK_MAX_MS,
    blankPose(),
  );
  const main = (BOSS_PIECES[piece.k] as { sweep: readonly number[] })
    .sweep[0] as number;
  const box = bossPiecePartBoxInto(piece, pose, main, { ...sweepBox });
  return {
    end: WRECK_MAX_MS,
    hit: "air",
    at: { x: box.x, y: Math.max(0, box.y - box.hy), z: box.z },
    b: -1,
  };
}

/**
 * The boss goes down at server time `t`: its three sections, each leaving
 * from exactly where it was on the intact hull with the hull's velocity plus
 * its kick, swept once against `world` for where it lands. Pure.
 */
export function breakUp(
  r: BossRaid,
  t: number,
  world: BossSweepWorld,
): BossDown {
  const pose = bossPoseAt(r, t, blankPose());
  const pieces: BossPiece[] = [];
  for (const k of [0, 1, 2] as const) {
    const ax = (BOSS_PIECES[k] as { ax: number }).ax;
    const kick = PIECE_KICK[k] as { along: number; up: number };
    const p = placeLocal(pose, ax, 0, 0, { x: 0, y: 0, z: 0 });
    const path: BossPiecePath = {
      k,
      p,
      v: {
        x: pose.hx * (BOSS_SPEED + kick.along),
        y: kick.up,
        z: pose.hz * (BOSS_SPEED + kick.along),
      },
      yaw: pose.yaw,
      spin: pieceSpin(r.id, k),
    };
    pieces.push({ ...path, ...bossPieceImpact(path, t, world) });
  }
  return { id: r.id, t, pieces };
}

// --- The room's boss, as both sides hold it ------------------------------------

/** A room's boss state on both sides: the raid in progress (or the last
 * one) and, once it went down, its break-up. Mutated in place (a mover
 * field holds it, like the news heli's slot). */
export interface BossSlot {
  raid: BossRaid | null;
  down: BossDown | null;
}

export const emptyBossSlot = (): BossSlot => ({ raid: null, down: null });

/** Is the intact zeppelin in the air at `t`? */
export function bossPresent(slot: BossSlot, t: number): boolean {
  const r = slot.raid;
  if (!r || t < r.t0 || t >= raidEnd(r)) return false;
  return !(slot.down && slot.down.id === r.id && t >= slot.down.t);
}

/** Is any section of a broken-up boss still falling at `t`? */
export function piecesFalling(slot: BossSlot, t: number): boolean {
  const d = slot.down;
  if (!d || t < d.t) return false;
  return d.pieces.some((p) => t < d.t + p.end);
}

const hitBox: MoverBox = { ...sweepBox };
const hitPose = blankPose();

/**
 * The mover-field query: first box of the zeppelin (intact, or a section
 * still falling) a sphere at `pos` touches at server time `t`, or null.
 * Cheap rejects first — an altitude band, then the bounding radius — so it
 * can sit in the bot probe loop.
 */
export function collideBoss(
  slot: BossSlot,
  pos: Vec3,
  radius: number,
  t: number,
): MoverHit | null {
  const r = slot.raid;
  if (r && bossPresent(slot, t)) {
    if (Math.abs(pos.y - BOSS_ALT) <= BOSS_REACH_Y + radius) {
      const pose = bossPoseAt(r, t, hitPose);
      const dx = wrapDeltaAxis(pose.x, pos.x);
      const dz = wrapDeltaAxis(pose.z, pos.z);
      const reach = BOSS_REACH_XZ + radius;
      if (dx * dx + dz * dz <= reach * reach) {
        for (let i = 0; i < BOSS_PARTS.length; i++) {
          if (sphereHitsBox(bossPartBoxInto(pose, i, hitBox), pos, radius)) {
            return { kind: "boss", id: r.id };
          }
        }
      }
    }
  }
  const d = slot.down;
  if (!d || t < d.t) return null;
  for (const piece of d.pieces) {
    if (t >= d.t + piece.end) continue;
    const pose = piecePoseAt(piece, d.t, piece.end, t, hitPose);
    const dx = wrapDeltaAxis(pose.x, pos.x);
    const dz = wrapDeltaAxis(pose.z, pos.z);
    const dy = pos.y - pose.y;
    const reach = (PIECE_REACH[piece.k] as number) + radius;
    if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
    for (const i of PIECE_PARTS[piece.k] as readonly number[]) {
      if (
        sphereHitsBox(bossPiecePartBoxInto(piece, pose, i, hitBox), pos, radius)
      ) {
        return { kind: "bossDebris", id: d.id };
      }
    }
  }
  return null;
}

/** Seconds of straight run-out a respawn must have clear of the zeppelin. */
export const BOSS_SPAWN_RUNOUT_S = 6;
/** ...by this margin, m. */
export const BOSS_SPAWN_MARGIN = 30;

/**
 * Is a spawn at `pos` flying `yaw` (flight convention: yaw 0 faces −Z) at
 * `speed` clear of the zeppelin — intact or falling — for its first
 * BOSS_SPAWN_RUNOUT_S, by BOSS_SPAWN_MARGIN? Spawn protection does not stop
 * a crash, so a spawn must never be pointed into the hull. `yaw` null (not
 * known yet) asks for every heading: the whole run-out disc must be clear.
 */
export function bossSpawnClear(
  slot: BossSlot,
  pos: Vec3,
  yaw: number | null,
  speed: number,
  now: number,
): boolean {
  if (!slot.raid && !slot.down) return true;
  const fx = yaw === null ? 0 : -Math.sin(yaw);
  const fz = yaw === null ? 0 : -Math.cos(yaw);
  const margin =
    yaw === null
      ? BOSS_SPAWN_MARGIN + speed * BOSS_SPAWN_RUNOUT_S
      : BOSS_SPAWN_MARGIN;
  for (let s = 0; s <= BOSS_SPAWN_RUNOUT_S; s += 0.25) {
    spawnAt.x = wrapCoord(pos.x + fx * speed * s);
    spawnAt.y = pos.y;
    spawnAt.z = wrapCoord(pos.z + fz * speed * s);
    if (collideBoss(slot, spawnAt, margin, now + s * 1000)) return false;
    if (yaw === null) break;
  }
  return true;
}
const spawnAt: Vec3 = { x: 0, y: 0, z: 0 };

// --- Hits ---------------------------------------------------------------------

/** rayBox's running interval (module scratch: the hit test allocates
 * nothing — it runs per round per frame near the zeppelin). */
let slabT0 = 0;
let slabT1 = 0;

/** Clip the running interval to one axis's slab; false once it is empty. */
function slab(o: number, d: number, h: number): boolean {
  if (Math.abs(d) < 1e-12) return Math.abs(o) <= h;
  let a = (-h - o) / d;
  let b = (h - o) / d;
  if (a > b) {
    const t = a;
    a = b;
    b = t;
  }
  if (a > slabT0) slabT0 = a;
  if (b < slabT1) slabT1 = b;
  return slabT0 <= slabT1;
}

/** Distance along a unit ray from `o` to an oriented box, or Infinity.
 * `o` is a delta from the box centre in world axes. */
function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  box: MoverBox,
  maxDist: number,
): number {
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  // World → box frame (the inverse of placeLocal's rotation).
  const lox = c * ox - s * oz;
  const loz = s * ox + c * oz;
  const ldx = c * dx - s * dz;
  const ldz = s * dx + c * dz;
  slabT0 = 0;
  slabT1 = maxDist;
  if (!slab(lox, ldx, box.hx)) return Number.POSITIVE_INFINITY;
  if (!slab(oy, dy, box.hy)) return Number.POSITIVE_INFINITY;
  if (!slab(loz, ldz, box.hz)) return Number.POSITIVE_INFINITY;
  return slabT0;
}

/** Distance along a unit ray from `o` (a delta from the centre) to a sphere,
 * or Infinity. */
function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  radius: number,
  maxDist: number,
): number {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return Number.POSITIVE_INFINITY;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= maxDist ? t : Number.POSITIVE_INFINITY;
}

/** What a round meets first along its line. */
export interface BossRayHit {
  /** The weak point hit (index into BOSS_WEAK_POINTS), or -1: armour. */
  weak: number;
  dist: number;
}

const rayBoxScratch: MoverBox = { ...sweepBox };
const rayOff: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The first thing on the intact hull at `pose` a round from `origin` along
 * unit `dir` meets within `maxDist`: a LIVE weak point (its sphere or its own
 * box) or armour (every other box, dead weak points included). Null: a miss.
 * `alive[k]` false = weak point k is spent armour now.
 */
export function bossRayHit(
  pose: BossPose,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  alive: readonly boolean[],
): BossRayHit | null {
  let bestWeak = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < BOSS_PARTS.length; i++) {
    bossPartBoxInto(pose, i, rayBoxScratch);
    wrapDeltaInto(rayBoxScratch, origin, rayOff);
    const k = BOSS_WEAK_POINTS.indexOf(i);
    const live = k >= 0 && alive[k] === true;
    let d = rayBox(
      rayOff.x,
      rayOff.y,
      rayOff.z,
      dir.x,
      dir.y,
      dir.z,
      rayBoxScratch,
      maxDist,
    );
    if (live) {
      d = Math.min(
        d,
        raySphere(
          rayOff.x,
          rayOff.y,
          rayOff.z,
          dir.x,
          dir.y,
          dir.z,
          BOSS_WEAK_RADIUS,
          maxDist,
        ),
      );
    }
    if (d < bestDist) {
      bestDist = d;
      bestWeak = live ? k : -1;
    }
  }
  return bestDist === Number.POSITIVE_INFINITY
    ? null
    : { weak: bestWeak, dist: bestDist };
}

/** How far past a weak point's own sphere the server's ray test still
 * credits it, m — absorbs the claimed time's rounding. */
export const BOSS_HIT_SLACK = 3;

/**
 * The server's judgement of a round claimed to hit weak point `k`: along the
 * claimed line, at the pose for the claimed time, `k` must be live and be
 * what the round meets first — never armour, never another weak point, and
 * within BULLET_RANGE. The slack only ever widens `k`'s own sphere.
 */
export function bossHitValid(
  pose: BossPose,
  k: number,
  origin: Vec3,
  dir: Vec3,
  alive: readonly boolean[],
): boolean {
  if (!Number.isInteger(k) || k < 0 || k >= BOSS_WEAK_POINTS.length) {
    return false;
  }
  if (alive[k] !== true) return false;
  const first = bossRayHit(pose, origin, dir, BULLET_RANGE, alive);
  if (first && first.weak === k) return true;
  // Not first on the exact line: still fair if the round passed within the
  // slack of k's sphere before anything else stopped it.
  weakPointInto(pose, k, slackAt);
  wrapDeltaInto(slackAt, origin, rayOff);
  const t = raySphere(
    rayOff.x,
    rayOff.y,
    rayOff.z,
    dir.x,
    dir.y,
    dir.z,
    BOSS_WEAK_RADIUS + BOSS_HIT_SLACK,
    BULLET_RANGE,
  );
  if (t === Number.POSITIVE_INFINITY) return false;
  return !first || first.dist >= t;
}
const slackAt: Vec3 = { x: 0, y: 0, z: 0 };

// --- Flak ---------------------------------------------------------------------

/** Turret reach, m: no shell at anything further, or nearer than MIN. */
export const BOSS_FLAK_RANGE = 460;
export const BOSS_FLAK_MIN_RANGE = 60;
/** A turret's traverse: its target within this of its face normal, rad —
 * so a plane level with the hull's flanks is in every turret's blind band. */
export const BOSS_FLAK_CONE = 1.45;
/** Shell speed, m/s, and the shortest fuse any shell is given, ms: every
 * shell is in the air (tracer drawn) at least this long — the telegraph. */
export const BOSS_FLAK_SPEED = 260;
export const BOSS_FLAK_MIN_FUSE_MS = 1200;
/** Aim wander, rad — the bots' own cap, never tighter. */
export const BOSS_FLAK_JITTER = BOT_AIM_JITTER;
/** A turret holds fire this long on a new target, ms — never quicker than a
 * bot's reaction. */
export const BOSS_FLAK_REACTION_MS = Math.max(900, BOT_REACTION_MS);
/** One shell per turret per this, ms. */
export const BOSS_FLAK_INTERVAL_MS = 1800;
/** The burst as drawn, m — and as judged, smaller (the victim's slack). */
export const BOSS_FLAK_BURST_R = 14;
export const BOSS_FLAK_DAMAGE_R = 11;
/** Damage at the burst's centre, falling to 0 at BOSS_FLAK_DAMAGE_R. */
export const BOSS_FLAK_DAMAGE = 22;
/** No plane takes more flak than this in any rolling second, across every
 * turret. */
export const BOSS_FLAK_DPS_CAP = 30;

/** One shell, exactly as broadcast. `to` canonical on the 0.1 m grid. */
export interface BossFlak {
  id: number;
  turret: number;
  to: Vec3;
  /** Fired at, server ms; bursts at t0 + fuse. */
  t0: number;
  fuse: number;
}

/** A plane as a turret sees it. */
export interface FlakTarget {
  pos: Vec3;
  vel: Vec3;
}

/**
 * Where turret `k` (muzzle `muzzle`, facing `up`) puts a shell at `target`:
 * lead on its velocity for the shell's flight, then wandered by up to
 * BOSS_FLAK_JITTER inside a cone (uniform over the disc). Null when the
 * target is out of range or outside the turret's traverse. The fuse is never
 * under BOSS_FLAK_MIN_FUSE_MS. Deterministic in `rand`.
 */
export function flakSolution(
  muzzle: Vec3,
  up: 1 | -1,
  target: FlakTarget,
  rand: () => number,
): { to: Vec3; fuse: number } | null {
  const d = wrapDelta(muzzle, target.pos);
  const dist = Math.hypot(d.x, d.y, d.z);
  if (dist > BOSS_FLAK_RANGE || dist < BOSS_FLAK_MIN_RANGE) return null;
  if ((d.y * up) / dist < Math.cos(BOSS_FLAK_CONE)) return null;
  // Lead: where it will be when a shell gets there (one refinement).
  let fuse = Math.max(BOSS_FLAK_MIN_FUSE_MS / 1000, dist / BOSS_FLAK_SPEED);
  let ax = d.x + target.vel.x * fuse;
  let ay = d.y + target.vel.y * fuse;
  let az = d.z + target.vel.z * fuse;
  fuse = Math.max(
    BOSS_FLAK_MIN_FUSE_MS / 1000,
    Math.hypot(ax, ay, az) / BOSS_FLAK_SPEED,
  );
  ax = d.x + target.vel.x * fuse;
  ay = d.y + target.vel.y * fuse;
  az = d.z + target.vel.z * fuse;
  const len = Math.hypot(ax, ay, az) || 1;
  // A basis square to the aim line (u, w unit), then a uniform point in the
  // jitter disc: the wander is never more than BOSS_FLAK_JITTER off the aim.
  const steep = Math.abs(ay / len) >= 0.9;
  const hx = steep ? 1 : 0;
  const hy = steep ? 0 : 1;
  let ux = -az * hy;
  let uy = az * hx;
  let uz = ax * hy - ay * hx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const wx = (ay * uz - az * uy) / len;
  const wy = (az * ux - ax * uz) / len;
  const wz = (ax * uy - ay * ux) / len;
  const rad = Math.sqrt(rand()) * Math.tan(BOSS_FLAK_JITTER) * len;
  const ang = rand() * Math.PI * 2;
  const ou = Math.cos(ang) * rad;
  const ow = Math.sin(ang) * rad;
  const q = (v: number) => Math.round(v * 10) / 10;
  const qc = (v: number) => {
    const c = q(wrapCoord(v));
    return c >= WORLD_SIZE ? 0 : c;
  };
  return {
    to: {
      x: qc(muzzle.x + ax + ux * ou + wx * ow),
      y: q(muzzle.y + ay + uy * ou + wy * ow),
      z: qc(muzzle.z + az + uz * ou + wz * ow),
    },
    fuse: Math.round(fuse * 1000),
  };
}

/** Damage a plane `d` m from a burst takes (never more than a quarter of a
 * full plane). */
export function flakDamage(d: number): number {
  if (!(d >= 0) || d >= BOSS_FLAK_DAMAGE_R) return 0;
  return Math.min(
    MAX_HP / 4,
    (BOSS_FLAK_DAMAGE * (BOSS_FLAK_DAMAGE_R - d)) / BOSS_FLAK_DAMAGE_R,
  );
}

/** The shell's position at server time `ms` (clamped to its flight): a
 * straight line from the muzzle at its firing to the burst point. */
export function flakPosAt(
  r: BossRaid,
  f: BossFlak,
  ms: number,
  out: Vec3,
): Vec3 {
  turretMuzzleInto(bossPoseAt(r, f.t0, flakPose), f.turret, out);
  const u = Math.min(1, Math.max(0, (ms - f.t0) / f.fuse));
  const dx = wrapDeltaAxis(out.x, f.to.x);
  const dz = wrapDeltaAxis(out.z, f.to.z);
  out.x = wrapCoord(out.x + dx * u);
  out.y = out.y + (f.to.y - out.y) * u;
  out.z = wrapCoord(out.z + dz * u);
  return out;
}
const flakPose = blankPose();

// --- Credit -------------------------------------------------------------------

/** A dealer needs this share of the damage to be credited with the kill. */
export const BOSS_CREDIT_MIN_SHARE = 0.1;

export interface BossCredit {
  /** Every dealer, most damage first (ties: lower id first). */
  dealers: { id: string; damage: number; share: number }[];
  /** The dealers who earned the kill (share ≥ BOSS_CREDIT_MIN_SHARE). */
  credited: string[];
  /** Who dealt the most — the medal and the headline. */
  top: string | null;
}

/** Split the credit for a downed boss by damage dealt. Pure. */
export function bossCredit(damage: ReadonlyMap<string, number>): BossCredit {
  let total = 0;
  for (const v of damage.values()) if (v > 0) total += v;
  const dealers = [...damage]
    .filter(([, v]) => v > 0)
    .map(([id, v]) => ({ id, damage: v, share: total > 0 ? v / total : 0 }))
    .sort(
      (a, b) => b.damage - a.damage || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return {
    dealers,
    credited: dealers
      .filter((d) => d.share >= BOSS_CREDIT_MIN_SHARE)
      .map((d) => d.id),
    top: dealers[0]?.id ?? null,
  };
}

// --- Wire ---------------------------------------------------------------------

/** A raid on the wire: integers only, exactly reconstructible —
 * [id, t0, cx ×10, cz ×10, th0 ×1000, orbitMs, hpScale ×100]. */
export type WireBossRaid = [
  id: number,
  t0: number,
  cx: number,
  cz: number,
  th0: number,
  orbitMs: number,
  hpScale: number,
];

export function encodeRaid(r: BossRaid): WireBossRaid {
  return [
    r.id,
    r.t0,
    Math.round(r.cx * 10),
    Math.round(r.cz * 10),
    Math.round(r.th0 * 1000),
    r.orbitMs,
    Math.round(r.hpScale * 100),
  ];
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Inverse of encodeRaid; null for anything malformed. */
export function decodeRaid(w: unknown): BossRaid | null {
  if (!Array.isArray(w) || w.length !== 7 || !w.every(finite)) return null;
  const [id, t0, cx, cz, th0, orbitMs, hp] = w as number[];
  if ((orbitMs as number) < 0 || (hp as number) <= 0) return null;
  return {
    id: id as number,
    t0: t0 as number,
    cx: (cx as number) / 10,
    cz: (cz as number) / 10,
    th0: (th0 as number) / 1000,
    orbitMs: orbitMs as number,
    hpScale: (hp as number) / 100,
  };
}

/** A shell on the wire: [id, turret, to ×10 (x, y, z), t0, fuse]. */
export type WireFlak = [
  id: number,
  turret: number,
  x: number,
  y: number,
  z: number,
  t0: number,
  fuse: number,
];

export function encodeFlak(f: BossFlak): WireFlak {
  return [
    f.id,
    f.turret,
    Math.round(f.to.x * 10),
    Math.round(f.to.y * 10),
    Math.round(f.to.z * 10),
    f.t0,
    f.fuse,
  ];
}

export function decodeFlak(w: unknown): BossFlak | null {
  if (!Array.isArray(w) || w.length !== 7 || !w.every(finite)) return null;
  const [id, turret, x, y, z, t0, fuse] = w as number[];
  if (
    !Number.isInteger(turret) ||
    (turret as number) < 0 ||
    (turret as number) >= BOSS_TURRETS.length ||
    (fuse as number) <= 0
  ) {
    return null;
  }
  return {
    id: id as number,
    turret: turret as number,
    to: { x: (x as number) / 10, y: (y as number) / 10, z: (z as number) / 10 },
    t0: t0 as number,
    fuse: fuse as number,
  };
}

const HITS: readonly WreckHit[] = [
  "city",
  "ground",
  "river",
  "tree",
  "mover",
  "air",
];
const isVec = (v: unknown): v is Vec3 =>
  typeof v === "object" &&
  v !== null &&
  finite((v as Vec3).x) &&
  finite((v as Vec3).y) &&
  finite((v as Vec3).z);

/** Shape check for a break-up off the wire (a client never trusts a NaN). */
export function isBossDown(d: unknown): d is BossDown {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  if (!finite(o.id) || !finite(o.t) || !Array.isArray(o.pieces)) return false;
  if (o.pieces.length !== 3) return false;
  return o.pieces.every((p: unknown, i: number) => {
    if (typeof p !== "object" || p === null) return false;
    const q = p as Record<string, unknown>;
    return (
      q.k === i &&
      isVec(q.p) &&
      isVec(q.v) &&
      finite(q.yaw) &&
      (q.spin === 1 || q.spin === -1) &&
      finite(q.end) &&
      (q.end as number) >= 0 &&
      (q.end as number) <= WRECK_MAX_MS &&
      HITS.includes(q.hit as WreckHit) &&
      isVec(q.at) &&
      Number.isInteger(q.b) &&
      (q.b as number) >= -1
    );
  });
}

/** A room's whole boss state, as a welcome replays it: the raid (null when
 * there has been none, or the last one is long over), every weak point's HP,
 * and the break-up once it went down. */
export interface WireBossState {
  r: WireBossRaid;
  hp: number[];
  d?: BossDown;
}

/** Install a welcome's boss state into a slot (null clears it — a resume
 * into another room must not keep the old room's boss). Returns the HP list
 * to hold beside it (empty with no raid). */
export function applyBossState(
  slot: BossSlot,
  state: WireBossState | null | undefined,
): number[] {
  const raid = state ? decodeRaid(state.r) : null;
  slot.raid = raid;
  slot.down =
    raid && state?.d && isBossDown(state.d) && state.d.id === raid.id
      ? state.d
      : null;
  if (!raid || !state) return [];
  return raidMaxHp(raid).map((max, k) => {
    const v = state.hp[k];
    return finite(v) ? Math.max(0, Math.min(max, v)) : max;
  });
}
