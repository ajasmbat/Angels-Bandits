// W3 rooftop AA nests — the shared, pure half. Every nest is a D9 roof prop
// of kind PROP_NEST (common/src/city/props.ts) standing on its generated
// `aaNest` roof structure (common/src/city/roof-structures.ts): solid while
// manned, a non-solid ruin once its prop is down, back with its building's
// D5 rebuild. This file is the arithmetic both sides agree on:
//
//  - which nests there are and where their guns sit (aaNestsOf);
//  - how a gun swings (slew-limited, elevation-limited) and when it may
//    fire (aim error inside the cone);
//  - where a burst is aimed: lead on the target's velocity for the rounds'
//    flight, wandered by a seeded tracking error;
//  - the per-intensity tuning (hit chance and damage), the heavy flak's
//    falloff;
//  - the `aa` message on the wire.
//
// AUTHORITY (PLAN.md's split): the SERVER (server/src/aa.ts) picks targets,
// rolls every hit and applies the damage — to the carrier's enemy planes
// only, never a human. Clients draw the bursts the server sent and swing
// the guns; nothing a client does reaches a nest's fire.
//
// Not re-exported from common/src/index.ts; import "@angels-bandits/common/aa".

import type { Building } from "./city/index";
import { PROP_NEST, type PropLayout, type PropState } from "./city/props";
import {
  AA_FLAK_HEIGHT,
  AA_FLAK_RADIUS,
  AA_NEST_HEIGHT,
} from "./city/roof-structures";
import { generatedRoof } from "./city/standing";
import { WORLD_SIZE } from "./constants";
import type { Intensity } from "./waves";
import { type Vec3, wrapCoord, wrapDelta } from "./world/index";

/** Killer id of a plane the AA downs (a `death`'s `killerId`, a `damage`'s
 * `shooterId`) — never a pilot's, like BOSS_ID. */
export const AA_ID = "@aa";

// --- The nests ------------------------------------------------------------------

/** One nest as the guns see it. */
export interface AaNest {
  /** Its prop id (PROP_NEST) — the wire's nest id. */
  id: number;
  /** Building index. */
  b: number;
  /** The gun's pivot, canonical, m — on the mount, inside the ring. */
  x: number;
  y: number;
  z: number;
  /** Heavy flak (the tallest towers) or a light machine-gun nest. */
  heavy: boolean;
  /** Where the gun points at rest, rad (yaw: 0 faces −Z, like the planes). */
  yaw0: number;
  /** Per-nest roll in [0, 1) (crew, sweep phase, dressing). */
  seed: number;
}

/** The gun pivot above the roof deck, m (light, heavy). */
export const AA_PIVOT_Y: readonly [number, number] = [1.7, 2.2];
/** Sight lines leave this far above the nest's own collider top, m — the
 * barrels clear the sandbags, and a nest never blocks its own fire. */
export const AA_SIGHT_LIFT = 0.4;

/** Every nest of a prop layout, ascending prop ids. Pure. */
export function aaNestsOf(layout: PropLayout): AaNest[] {
  const out: AaNest[] = [];
  const first = layout.first[PROP_NEST];
  if (first === undefined) return out;
  for (let id = first; id < layout.props.length; id++) {
    const p = layout.props[id];
    if (!p || p.kind !== PROP_NEST) continue;
    const heavy = p.hx >= AA_FLAK_RADIUS - 1e-6;
    out.push({
      id: p.id,
      b: p.b,
      x: p.x,
      y: p.landY + (AA_PIVOT_Y[heavy ? 1 : 0] as number),
      z: p.z,
      heavy,
      yaw0: (p.seed * 4 - 2) * Math.PI,
      seed: p.seed,
    });
  }
  return out;
}

/**
 * Is nest `n` manned: its prop standing, and its roof structure still in
 * its building's live `b.roof` (D8: a deck that went takes the nest with
 * it)? Server guns and client guns ask exactly this.
 */
export function aaManned(
  n: AaNest,
  buildings: readonly Building[],
  props: PropState,
): boolean {
  if (props.isDown(n.id)) return false;
  const b = buildings[n.b];
  if (!b) return false;
  const gen = generatedRoof(b);
  if (b.roof === gen) return gen !== undefined;
  const s = gen?.[props.bound?.props[n.id]?.ref ?? -1];
  return s !== undefined && (b.roof?.includes(s) ?? false);
}

/** Where a nest's sight lines start (just over its own collider). */
export function aaSightFrom(n: AaNest, out: Vec3): Vec3 {
  out.x = n.x;
  out.y =
    n.y -
    (AA_PIVOT_Y[n.heavy ? 1 : 0] as number) +
    (n.heavy ? AA_FLAK_HEIGHT : AA_NEST_HEIGHT) +
    AA_SIGHT_LIFT;
  out.z = n.z;
  return out;
}

// --- The guns -------------------------------------------------------------------

/** One gun type's mechanics (the intensity table scales the outcome). */
export interface AaGun {
  /** No target further, or nearer, m. */
  range: number;
  minRange: number;
  /** Traverse and elevation rates, rad/s — what a fast crossing plane
   * close in outruns. */
  slewYaw: number;
  slewPitch: number;
  /** Elevation limits, rad (a roof gun depresses a little, never far). */
  pitchMin: number;
  pitchMax: number;
  /** Fires only with the aim within this of the lead point, rad. */
  cone: number;
  /** A burst every this long while on target, ms; how long it lasts. */
  intervalMs: number;
  burstMs: number;
  /** Round (or shell) speed, m/s; a shell's shortest fuse, ms. */
  speed: number;
  minFuseMs: number;
  /** Seeded tracking error: lead off by up to this share of itself, and a
   * wander of up to this many rad off the aim line. */
  leadErr: number;
  wander: number;
  /** A new target is held this long before the first burst, ms. */
  reactionMs: number;
}

export const AA_LIGHT: AaGun = {
  range: 340,
  minRange: 25,
  slewYaw: 1.5,
  slewPitch: 1.0,
  pitchMin: -0.2,
  pitchMax: 1.45,
  cone: 0.07,
  intervalMs: 1500,
  burstMs: 550,
  speed: 620,
  minFuseMs: 0,
  leadErr: 0.3,
  wander: 0.02,
  reactionMs: 900,
};

export const AA_HEAVY: AaGun = {
  range: 520,
  minRange: 90,
  slewYaw: 0.75,
  slewPitch: 0.55,
  pitchMin: 0.05,
  pitchMax: 1.5,
  cone: 0.05,
  intervalMs: 2800,
  burstMs: 0,
  speed: 320,
  minFuseMs: 700,
  leadErr: 0.2,
  wander: 0.035,
  reactionMs: 1400,
};

export const aaGun = (n: { heavy: boolean }): AaGun =>
  n.heavy ? AA_HEAVY : AA_LIGHT;

/** What a burst does, by the room's enemy intensity (common/src/waves.ts):
 * the AA is a helper — the harder the level, the less it takes off the
 * pilots' plates. Balance target: AA alone downs ~15–25% of a NORMAL
 * war's enemies (server/src/aa.ts; the W3 scratch sim measured it). */
export interface AaLevel {
  /** A light burst's hit chance at point blank, falling with range. */
  hit: number;
  /** A light burst's damage when it hits (several rounds). */
  burstDamage: number;
  /** Heavy flak: damage at the burst's centre, falling to 0 at radius. */
  flakDamage: number;
  flakRadius: number;
  /** Chance an enemy the AA hit turns to strafe that nest (rising edge). */
  provoke: number;
}

export const AA_LEVELS: readonly AaLevel[] = [
  // EASY
  {
    hit: 0.62,
    burstDamage: 30,
    flakDamage: 56,
    flakRadius: 15,
    provoke: 0.15,
  },
  // NORMAL
  {
    hit: 0.55,
    burstDamage: 28,
    flakDamage: 50,
    flakRadius: 14,
    provoke: 0.3,
  },
  // HARD
  {
    hit: 0.48,
    burstDamage: 25,
    flakDamage: 44,
    flakRadius: 13,
    provoke: 0.45,
  },
  // INSANE
  {
    hit: 0.46,
    burstDamage: 25,
    flakDamage: 42,
    flakRadius: 12,
    provoke: 0.6,
  },
];

export const aaLevel = (level: Intensity): AaLevel =>
  AA_LEVELS[level] as AaLevel;

/** A gun's attitude: yaw (0 faces −Z, positive turns toward −X — the
 * planes' convention) and elevation, rad. */
export interface GunAim {
  yaw: number;
  pitch: number;
}

const wrapAngle = (a: number): number => {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
};

/** The attitude that points along `d` (any length). */
export function aimOf(d: Vec3, out: GunAim): GunAim {
  out.yaw = Math.atan2(-d.x, -d.z);
  out.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  return out;
}

/** Unit direction of an attitude. */
export function dirOf(a: GunAim, out: Vec3): Vec3 {
  const c = Math.cos(a.pitch);
  out.x = -Math.sin(a.yaw) * c;
  out.y = Math.sin(a.pitch);
  out.z = -Math.cos(a.yaw) * c;
  return out;
}

/**
 * Swing `cur` toward `want` for `dt` s at the gun's rate caps, the
 * elevation clamped to its limits. Mutates and returns `cur`. Pure in its
 * inputs — the server's guns and every client's drawn guns swing alike.
 */
export function slewGun(
  cur: GunAim,
  want: GunAim,
  dt: number,
  gun: AaGun,
): GunAim {
  const dy = wrapAngle(want.yaw - cur.yaw);
  const sy = gun.slewYaw * dt;
  cur.yaw = wrapAngle(cur.yaw + Math.max(-sy, Math.min(sy, dy)));
  const wp = Math.max(gun.pitchMin, Math.min(gun.pitchMax, want.pitch));
  const sp = gun.slewPitch * dt;
  cur.pitch += Math.max(-sp, Math.min(sp, wp - cur.pitch));
  return cur;
}

/** The angle between two attitudes, rad. */
export function aimError(a: GunAim, b: GunAim): number {
  const da = dirOf(a, scratchA);
  const db = dirOf(b, scratchB);
  const dot = da.x * db.x + da.y * db.y + da.z * db.z;
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}
const scratchA: Vec3 = { x: 0, y: 0, z: 0 };
const scratchB: Vec3 = { x: 0, y: 0, z: 0 };

/** A plane as a gun sees it. */
export interface AaTarget {
  pos: Vec3;
  vel: Vec3;
}

/**
 * The lead point on `t` from pivot `from` (a wrapDelta offset, m) and the
 * rounds' flight time, s: where it will be when they arrive (two
 * refinements). Null when it is out of the gun's reach.
 */
export function leadOf(
  from: Vec3,
  t: AaTarget,
  gun: AaGun,
): { d: Vec3; flight: number } | null {
  const d0 = wrapDelta(from, t.pos);
  const dist = Math.hypot(d0.x, d0.y, d0.z);
  if (dist > gun.range || dist < gun.minRange) return null;
  let flight = Math.max(gun.minFuseMs / 1000, dist / gun.speed);
  const d = { x: d0.x, y: d0.y, z: d0.z };
  for (let i = 0; i < 2; i++) {
    d.x = d0.x + t.vel.x * flight;
    d.y = d0.y + t.vel.y * flight;
    d.z = d0.z + t.vel.z * flight;
    flight = Math.max(
      gun.minFuseMs / 1000,
      Math.hypot(d.x, d.y, d.z) / gun.speed,
    );
  }
  return { d, flight };
}

/**
 * Where a burst actually goes: the lead offset `d` (from leadOf) with the
 * gun's tracking error — the lead mis-judged by up to ±leadErr of itself
 * along the target's track, then wandered by up to `wander` rad off the
 * aim line. Three draws from `rand`, always. Returns the offset from the
 * pivot and how far off the true lead point it lands, m.
 */
export function burstAim(
  d: Vec3,
  t: AaTarget,
  flight: number,
  gun: AaGun,
  rand: () => number,
): { d: Vec3; miss: number } {
  const lead = (rand() * 2 - 1) * gun.leadErr * flight;
  const wa = rand() * Math.PI * 2;
  const wr = Math.sqrt(rand()) * gun.wander * Math.hypot(d.x, d.y, d.z);
  // A basis square to the aim line: horizontal (u) and the rest (w).
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  const hl = Math.hypot(d.x, d.z) || 1;
  const ux = -d.z / hl;
  const uz = d.x / hl;
  const wx = (-d.y * uz) / len;
  const wy = (d.z * ux - d.x * uz) / len;
  const wz = (d.y * ux) / len;
  const ou = Math.cos(wa) * wr;
  const ow = Math.sin(wa) * wr;
  const out = {
    x: d.x + t.vel.x * lead + ux * ou + wx * ow,
    y: d.y + t.vel.y * lead + wy * ow,
    z: d.z + t.vel.z * lead + uz * ou + wz * ow,
  };
  const miss = Math.hypot(out.x - d.x, out.y - d.y, out.z - d.z);
  return { d: out, miss };
}

/** A light burst's hit chance: the level's point-blank chance, falling to
 * 35 % of it at full range, and by how far the tracking error put the
 * stream off the plane (a fighter is ~10 m across). */
export function burstHitChance(
  dist: number,
  miss: number,
  gun: AaGun,
  level: AaLevel,
): number {
  const range = 1 - 0.65 * Math.min(1, Math.max(0, dist / gun.range));
  return level.hit * range * Math.exp(-miss / 9);
}

/** Heavy flak damage `d` m from the burst (linear falloff). */
export function aaFlakDamage(d: number, level: AaLevel): number {
  if (!(d >= 0) || d >= level.flakRadius) return 0;
  return (level.flakDamage * (level.flakRadius - d)) / level.flakRadius;
}

// --- Wire -----------------------------------------------------------------------

/** One burst, exactly as broadcast: nest `n` (its prop id) fires at `t0`
 * (server ms) toward `to` (canonical, 0.1 m grid); the first round (a
 * heavy's shell) gets there `fl` ms later. A light burst streams rounds
 * for its gun's burstMs; a heavy one bursts at `to` at t0 + fl. */
export interface AaBurst {
  n: number;
  t0: number;
  to: Vec3;
  fl: number;
}

/** On the wire: [nest, t0, x ×10, y ×10, z ×10, flight ms]. */
export type WireAaBurst = [
  n: number,
  t0: number,
  x: number,
  y: number,
  z: number,
  fl: number,
];

export const encodeAaBurst = (b: AaBurst): WireAaBurst => [
  b.n,
  Math.round(b.t0),
  Math.round(b.to.x * 10),
  Math.round(b.to.y * 10),
  Math.round(b.to.z * 10),
  Math.round(b.fl),
];

const int = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v);

/** Inverse of encodeAaBurst; null for anything malformed. */
export function decodeAaBurst(w: unknown): AaBurst | null {
  if (!Array.isArray(w) || w.length !== 6 || !w.every(int)) return null;
  const [n, t0, x, y, z, fl] = w as number[];
  if ((n as number) < 0 || (fl as number) < 0 || (fl as number) > 10_000) {
    return null;
  }
  const c = (v: number) => {
    const q = wrapCoord(v / 10);
    return q >= WORLD_SIZE ? 0 : q;
  };
  return {
    n: n as number,
    t0: t0 as number,
    to: { x: c(x as number), y: (y as number) / 10, z: c(z as number) },
    fl: fl as number,
  };
}

/** Canonical burst point on the 0.1 m grid from a pivot and an offset. */
export function burstPoint(from: Vec3, d: Vec3): Vec3 {
  const q = (v: number) => Math.round(v * 10) / 10;
  const qc = (v: number) => {
    const c = q(wrapCoord(v));
    return c >= WORLD_SIZE ? 0 : c;
  };
  return { x: qc(from.x + d.x), y: q(from.y + d.y), z: qc(from.z + d.z) };
}
