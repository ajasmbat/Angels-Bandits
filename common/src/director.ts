// D5 destruction director — the shared, pure half. The SERVER stages one
// dramatic event every 2–4 minutes near the fight (server/src/director.ts):
// a demolition-style collapse, a gas main blowing in a street, or a tower
// crane going over. Each is announced ≥ DIRECTOR_WARN_MS ahead as one
// `directorWarn` event — rumble, dust from the windows, sirens; never a HUD
// line — then arrives the usual way: a `collapse` record (the debris is
// D3's, so what falls is what collides), a `gas` city event with `chunks`
// and damage, or a crane-fall collapse record.
//
// WHEN is the storm's trick (common/src/storm.ts): hashed buckets of the
// cadence band's midpoint with a seeded offset, so the slot times are a pure
// function of (seed, server time) — random access, abutting windows
// partition the timeline, and consecutive slots are always 2–4 min apart.
// WHERE depends on the live fight, so the server decides it and broadcasts.
//
// Not re-exported from common/src/index.ts; import
// "@angels-bandits/common/director".

import {
  type Collapse,
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
  TOPPLE,
} from "./city/collapse";
import type { Building } from "./city/index";
import { RIVER_ROW } from "./city/river";
import { mulberry32 } from "./city/rng";
import { BLOCK_PITCH, MAX_HP, WORLD_SIZE } from "./constants";
import { type Vec3, wrapCoord, wrapDeltaAxis } from "./world/index";

/** Consecutive director slots are this far apart, ms (the ticket's 2–4 min). */
export const DIRECTOR_INTERVAL_MIN_MS = 120_000;
export const DIRECTOR_INTERVAL_MAX_MS = 240_000;
/** Warning → event, ms. A collapse's debris then waits COLLAPSE_LEAD_MS
 * more before it moves, so a pilot always has more than 3 s. */
export const DIRECTOR_WARN_MS = 3500;
/** The ticket's fairness floor: no event is ever announced later than this
 * before it happens, ms. */
export const DIRECTOR_WARN_MIN_MS = 3000;
/** "Near the action": a target within this of a plane, m (plan-view gap). */
export const DIRECTOR_ACTION_M = 400;
/** A tower with a plane this close is PREFERRED, m. */
export const DIRECTOR_NEAR_M = 150;
/** The anchor plane's projected straight path the topple must cross, s. */
export const DIRECTOR_PATH_S = 3;

/** Event kinds (DirectorEvent.k). */
export const EVENT_COLLAPSE = 0;
export const EVENT_GAS = 1;
export const EVENT_CRANE = 2;

/** Gas main: lethal inside GAS_LETHAL_M of the blast column, then
 * GAS_EDGE_DAMAGE falling to 0 at GAS_BLAST_M. The column is a fireball
 * standing GAS_COLUMN_H over the street; distance is to that column. */
export const GAS_LETHAL_M = 10;
export const GAS_BLAST_M = 36;
export const GAS_EDGE_DAMAGE = 60;
export const GAS_COLUMN_H = 45;
/** Gas main D2 damage (point-to-box from 4 m over the street), m and HP. */
export const GAS_CHUNK_RADIUS = 16;
export const GAS_CHUNK_DAMAGE = 260;
export const GAS_CHUNK_Y = 4;

/** A 2-D danger rect relative to the event's (x, z), m, plus its top
 * altitude: what bots refuse to enter while warned, and what the server's
 * spawn and cooldown checks read. */
export interface DangerZone {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  top: number;
}

/** One staged event, exactly as broadcast in `directorWarn`. */
export interface DirectorEvent {
  id: number;
  /** EVENT_COLLAPSE / EVENT_GAS / EVENT_CRANE. */
  k: number;
  /** Building index (collapse), crane site id (crane), −1 (gas). */
  b: number;
  /** Where: the building's / crane's centre, or the gas main; canonical,
   * on the wire's 0.1 m grid. y: the blast height (gas), else 0. */
  x: number;
  y: number;
  z: number;
  /** Collapse style (PANCAKE / TOPPLE) and topple direction (DIR_*). */
  s: number;
  d: number;
  /** Warned at, and happens at, server clock ms. */
  w: number;
  at: number;
  zone: DangerZone;
}

// --- When ----------------------------------------------------------------------

const BUCKET_MS = (DIRECTOR_INTERVAL_MIN_MS + DIRECTOR_INTERVAL_MAX_MS) / 2;
const JITTER_MS = (DIRECTOR_INTERVAL_MAX_MS - DIRECTOR_INTERVAL_MIN_MS) / 2;
const SLOT_SALT = 0x0d5d1ec7;

/** Per-bucket stream — random access by bucket index (storm.ts). */
const bucketRand = (seed: number, n: number): (() => number) =>
  mulberry32((seed ^ SLOT_SALT ^ Math.imul(n, 0x9e3779b9)) >>> 0);

/**
 * Every director slot in the half-open window [tStartMs, tEndMs), ascending.
 * One slot per BUCKET_MS bucket at a seeded 0..2·JITTER offset, so
 * consecutive slots are DIRECTOR_INTERVAL_MIN_MS..MAX_MS apart and abutting
 * windows partition the timeline. Pure in (seed, window).
 */
export function directorSlotsInWindow(
  seed: number,
  tStartMs: number,
  tEndMs: number,
): number[] {
  const out: number[] = [];
  const first = Math.max(0, Math.floor((tStartMs - 2 * JITTER_MS) / BUCKET_MS));
  for (let n = first; n * BUCKET_MS < tEndMs; n++) {
    const t = n * BUCKET_MS + bucketRand(seed, n)() * 2 * JITTER_MS;
    if (t >= tStartMs && t < tEndMs) out.push(t);
  }
  return out;
}

// --- Where: a topple across a plane's path --------------------------------------

/**
 * Where a topple's debris comes down, as a 2-D rect relative to the
 * building's centre: its real rest boxes (restBounds), stretched back along
 * the fall axis to the building's face — the strip it falls across. Null
 * for a pancake (it lands in its own footprint).
 */
export function fallFootprint(c: Collapse, b: Building): DangerZone | null {
  if (c.style !== TOPPLE) return null;
  const r = c.restBounds;
  const hw = (b.tiers[0]?.width ?? b.width) / 2;
  const hd = (b.tiers[0]?.depth ?? b.depth) / 2;
  const zone = { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, top: r.y1 };
  if (c.dir === DIR_POS_X) zone.x0 = hw;
  if (c.dir === DIR_NEG_X) zone.x1 = -hw;
  if (c.dir === DIR_POS_Z) zone.z0 = hd;
  if (c.dir === DIR_NEG_Z) zone.z1 = -hd;
  if (zone.x1 <= zone.x0 || zone.z1 <= zone.z0) return null;
  return zone;
}

/**
 * How many metres of a plane's projected straight path — from `pos` along
 * `vel` (m/s) for `seconds` — lie inside `rect` (relative to `cx`, `cz`),
 * plan view, torus-correct. 0 when it misses.
 */
export function pathCrossing(
  rect: DangerZone,
  cx: number,
  cz: number,
  pos: Vec3,
  vel: Vec3,
  seconds: number,
): number {
  const px = wrapDeltaAxis(cx, pos.x);
  const pz = wrapDeltaAxis(cz, pos.z);
  const dx = vel.x * seconds;
  const dz = vel.z * seconds;
  let t0 = 0;
  let t1 = 1;
  for (const [p, d, lo, hi] of [
    [px, dx, rect.x0, rect.x1],
    [pz, dz, rect.z0, rect.z1],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return 0;
      continue;
    }
    const a = (lo - p) / d;
    const b = (hi - p) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return 0;
  }
  return (t1 - t0) * Math.hypot(dx, dz);
}

// --- Gas main ----------------------------------------------------------------------

/** Along-street slots per street segment (between intersections), m from
 * the segment's start, and the seeded jitter on each, m. */
const GAS_SLOTS = [55, 100, 145] as const;
const GAS_JITTER_M = 14;
const GAS_SALT = 0x6a5e11;

/**
 * The gas main nearest `p`: the street under (or nearest) it, the segment
 * between intersections, and the closest of that segment's seeded slots —
 * seeded from (axis, line, segment, slot) grid ids, never a position. Null
 * on a segment crossing the river. Canonical, at street level.
 */
export function gasMainNear(seed: number, p: Vec3): Vec3 | null {
  const x = wrapCoord(p.x);
  const z = wrapCoord(p.z);
  const dx = x - Math.round(x / BLOCK_PITCH) * BLOCK_PITCH;
  const dz = z - Math.round(z / BLOCK_PITCH) * BLOCK_PITCH;
  // A street of constant x runs along z (and vice versa).
  const alongZ = Math.abs(dx) <= Math.abs(dz);
  const lines = WORLD_SIZE / BLOCK_PITCH;
  const line = Math.round((alongZ ? x : z) / BLOCK_PITCH) % lines;
  const along = alongZ ? z : x;
  const seg = Math.floor(along / BLOCK_PITCH) % lines;
  if (alongZ && seg === RIVER_ROW) return null;
  let best: number | null = null;
  for (let j = 0; j < GAS_SLOTS.length; j++) {
    const rand = mulberry32(
      (seed ^
        GAS_SALT ^
        Math.imul(alongZ ? 1 : 2, 0x27d4eb2f) ^
        Math.imul(line + 1, 0x85ebca6b) ^
        Math.imul(seg + 1, 0xc2b2ae35) ^
        Math.imul(j + 1, 0x9e3779b1)) >>>
        0,
    );
    const at =
      seg * BLOCK_PITCH +
      (GAS_SLOTS[j] as number) +
      (rand() * 2 - 1) * GAS_JITTER_M;
    if (best === null || Math.abs(at - along) < Math.abs(best - along)) {
      best = at;
    }
  }
  const lineAt = line * BLOCK_PITCH;
  const a = wrapCoord(best as number);
  return alongZ ? { x: lineAt, y: 0, z: a } : { x: a, y: 0, z: lineAt };
}

/** Distance from `pos` to a gas blast's fireball column standing on
 * `site`, m. */
export function gasDistance(site: Vec3, pos: Vec3): number {
  const h = Math.hypot(
    wrapDeltaAxis(site.x, pos.x),
    wrapDeltaAxis(site.z, pos.z),
  );
  const above = Math.max(0, pos.y - (site.y + GAS_COLUMN_H));
  const below = Math.max(0, site.y - pos.y);
  return Math.hypot(h, above + below);
}

/** Damage a plane takes `d` metres from the gas column. */
export function gasDamage(d: number): number {
  if (!(d >= 0)) return 0;
  if (d <= GAS_LETHAL_M) return MAX_HP;
  if (d >= GAS_BLAST_M) return 0;
  return (GAS_EDGE_DAMAGE * (GAS_BLAST_M - d)) / (GAS_BLAST_M - GAS_LETHAL_M);
}

// --- Wire --------------------------------------------------------------------------

/** An event on the wire: [id, k, b, x×10, y×10, z×10, s, d, w, at, x0, x1,
 * z0, z1, top] — integers only (the zone in whole metres, rounded
 * outward), exactly reconstructible. */
export type WireDirectorEvent = [
  id: number,
  k: number,
  b: number,
  x: number,
  y: number,
  z: number,
  s: number,
  d: number,
  w: number,
  at: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  top: number,
];

export function encodeDirectorEvent(e: DirectorEvent): WireDirectorEvent {
  const i = (v: number) => Math.round(v * 10);
  return [
    e.id,
    e.k,
    e.b,
    i(e.x),
    i(e.y),
    i(e.z),
    e.s,
    e.d,
    Math.round(e.w),
    Math.round(e.at),
    Math.floor(e.zone.x0),
    Math.ceil(e.zone.x1),
    Math.floor(e.zone.z0),
    Math.ceil(e.zone.z1),
    Math.ceil(e.zone.top),
  ];
}

/** Inverse of encodeDirectorEvent; null for anything malformed. */
export function decodeDirectorEvent(w: unknown): DirectorEvent | null {
  if (!Array.isArray(w) || w.length !== 15) return null;
  if (!w.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return null;
  }
  const [id, k, b, x, y, z, s, d, warn, at, x0, x1, z0, z1, top] =
    w as number[];
  return {
    id: id as number,
    k: k as number,
    b: b as number,
    x: (x as number) / 10,
    y: (y as number) / 10,
    z: (z as number) / 10,
    s: s as number,
    d: d as number,
    w: warn as number,
    at: at as number,
    zone: {
      x0: x0 as number,
      x1: x1 as number,
      z0: z0 as number,
      z1: z1 as number,
      top: top as number,
    },
  };
}

/** Is `pos` inside event `e`'s danger zone grown by `margin` (m), plan view
 * plus the zone's top? */
export function inDangerZone(
  e: Pick<DirectorEvent, "x" | "z" | "zone">,
  pos: Vec3,
  margin = 0,
): boolean {
  const dx = wrapDeltaAxis(e.x, pos.x);
  const dz = wrapDeltaAxis(e.z, pos.z);
  return (
    dx >= e.zone.x0 - margin &&
    dx <= e.zone.x1 + margin &&
    dz >= e.zone.z0 - margin &&
    dz <= e.zone.z1 + margin &&
    pos.y <= e.zone.top + margin
  );
}

/** D2 rebuild on the wire: building (k 0) or crane (k 1), applied at `at`.
 * `go: false` is the 2 s cosmetic announce; `go: true` is applied by every
 * client on arrival. */
export interface RebuildWire {
  k: 0 | 1;
  b: number;
  at: number;
  go: boolean;
}

export const DIRECTOR_DIRS = [
  DIR_NEG_X,
  DIR_POS_X,
  DIR_NEG_Z,
  DIR_POS_Z,
] as const;
