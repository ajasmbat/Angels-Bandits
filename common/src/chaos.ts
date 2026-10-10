// C2 constant chaos — the shared, pure half. Three layers on top of X1's
// missiles, D5's director and S4's boss, all server-authoritative like them
// (server/src/chaos.ts decides WHEN and WHERE and broadcasts one event; the
// rest is a pure function of that event and the synced clock):
//
//  - METEORS: fiery streaks from ~900 m up into a roof or facade, near the
//    fight or anywhere in the city. A meteor is a MissileStrike of kind
//    "meteor" (common/src/strike.ts), so it flies, lands, damages and
//    replays through X1's whole pipeline.
//    (W1 retired C2's formation jets: every enemy plane comes from the
//    war-zeppelin carrier now.)
//  - QUAKES: a city-wide tremor, announced QUAKE_LEAD_MS ahead; the camera
//    shakes by quakeAmp (pure), and at its instant the server weakens chunks.
//  - FIRE: burning chunks that spread to their neighbours (fireNeighbours).
//
// WHEN is the storm's / director's bucket trick, one salted stream per layer
// (chaosSlotsInWindow): random access, abutting windows partition the
// timeline, consecutive slots inside each layer's band.
//
// Not re-exported from common/src/index.ts; import "@angels-bandits/common/chaos".

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
import { mulberry32 } from "./city/rng";
import { standingTopAt } from "./city/standing";
import { WORLD_SIZE } from "./constants";
import {
  METEOR_FLIGHT_MS,
  type MissileStrike,
  missilePathClear,
} from "./strike";
import { type Vec3, wrapCoord, wrapDeltaAxis } from "./world/index";

// --- When ----------------------------------------------------------------------

export const CHAOS_METEOR = 0;
export const CHAOS_QUAKE = 1;
export type ChaosLayer = 0 | 1;

/** Consecutive slots of each layer are this far apart, ms: a meteor every
 * 4–9 s, a quake every 60–100 s. */
export const CHAOS_CADENCE: readonly (readonly [number, number])[] = [
  [4000, 9000],
  [60_000, 100_000],
];
/** Each layer's stream salt — the same values C2 shipped, so the meteor and
 * quake schedules are unchanged by W1 retiring the jet layer that sat
 * between them. */
const LAYER_SALT = [0x3e7e02a1, 0x9a4e1d23] as const;

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

const finiteTuple = (w: unknown, n: number): w is number[] =>
  Array.isArray(w) &&
  w.length === n &&
  w.every((v) => typeof v === "number" && Number.isFinite(v));

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

/** The welcome's C2 replay: quakes still to come or shaking, and the
 * burning chunks (delta-encoded with encodeChunkIds). */
export interface WireChaosState {
  quakes: WireQuake[];
  fires: number[];
}

/** METEOR_FLIGHT_MS re-exported for callers that only import chaos. */
export { METEOR_FLIGHT_MS };
