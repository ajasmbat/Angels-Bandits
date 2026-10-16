// P1 penetrating impacts — the shared, pure half. Whatever hits the city
// (a crashing plane, a falling wreck, a meteor, a comet, a carrier section,
// a collapse's debris) no longer stops at the first wall in one radial
// blast: it keeps going along its velocity, breaking every chunk it reaches
// while its energy lasts — through the building, out the other side and
// into the next — and comes to rest where its velocity hits zero, leaving a
// TUNNEL of destruction.
//
// The model: the impactor carries E = ½·m·v². Breaking a chunk costs its
// volume × SWEEP_COST_PER_M3 × its material; that energy is released over
// the chunk's depth along the path, so the body decelerates THROUGH the
// chunk, not at its face. Air costs nothing. It stops when E hits zero, at
// the ground, at its kind's chunk cap, or at SWEEP_MAX_DIST. A chunk it
// cannot afford stops it partway in (and stands: the stop blast is what
// reaches it).
//
// sweepImpact is pure in (impactor, the buildings' shape and damage): the
// server runs it on an impact, stamps each chunk with its entry time and
// breaks it then (CityDamage.destroyChunk — DESTROY_CAP and the C2 hold
// still apply), and broadcasts the impact record (encodeImpact); every
// client replays the SAME sweep from the record for the visuals — the body
// moving through (sweepPosAt), a burst as it reaches each chunk. Late
// joiners need nothing: what broke is in the destroyed set.
//
// Not re-exported from city/index.ts; import "@angels-bandits/common/city/penetrate".

import { LANDMARK_HEIGHT, WORLD_SIZE } from "../constants";
import { type Vec3, wrapCoord } from "../world/index";
import {
  type LocalBox,
  type TierGrid,
  cellBox,
  cellIndex,
  chunkBuilding,
  chunkCell,
  chunkId,
  chunkMask,
  chunkTier,
  tierGrids,
} from "./destruction";
import type { Building } from "./index";

/** The sweep model's version, carried by every impact record: a client
 * whose model differs ignores the record (it would replay a different
 * tunnel). Bump on any change to sweepImpact's result for the same input. */
export const SWEEP_MODEL_VERSION = 1;

/** Energy to break 1 m³ of chunk (E is ½·m·v², m in the table's units). */
export const SWEEP_COST_PER_M3 = 1;
/** A landmark's steel frame costs this much more to break through. */
export const SWEEP_LANDMARK_HARDNESS = 1.6;
/** March step inside a building, m (chunks are 12 m floors × 13–27 m bays). */
export const SWEEP_STEP_M = 2;
/** The longest tunnel, m (well under WORLD_SIZE / 2: wrapDelta stays exact). */
export const SWEEP_MAX_DIST = 400;
/** Air an impactor may cross before it first touches something, m — a
 * crash's on-record pose is a little short of the wall; a plane that blew
 * up in open air touches nothing and sweeps nothing. */
export const SWEEP_AIR_REACH = 60;
/** Once it has hit something, crossing open air (a street between two
 * buildings) costs this deceleration, m/s² — a slow body that leaves a
 * building drops in its exit hole instead of drifting across the street. */
export const SWEEP_AIR_DECEL = 15;
/** Below this speed, m/s, nothing is swept. */
const SWEEP_MIN_SPEED = 0.5;

/** Impact kinds (the wire's codes). */
export const IMPACT_PLANE = 0;
export const IMPACT_WRECK = 1;
export const IMPACT_METEOR = 2;
export const IMPACT_COMET = 3;
export const IMPACT_SECTION = 4;
export const IMPACT_DEBRIS = 5;
export type ImpactKind = 0 | 1 | 2 | 3 | 4 | 5;
const IMPACT_KINDS = 6;

/** Per kind: the mass and radius it sweeps with, its chunk cap, and the
 * small radial blast where it stops (radius m, damage at the centre). A
 * debris impact's mass and radius come from the piece instead. */
export interface ImpactorSpec {
  mass: number;
  radius: number;
  maxChunks: number;
  /** Air it may cross before it first touches something, m: how far short
   * of the wall its record may start (a crash's pose is up to a tick old;
   * a wreck's, a strike's and debris' are at the surface). */
  airReach: number;
  blastRadius: number;
  blastDamage: number;
}

export const IMPACTORS: readonly ImpactorSpec[] = [
  // A crashing plane: ~2–4 chunks at combat speed (40–90 m/s).
  {
    mass: 5,
    radius: 3,
    maxChunks: 8,
    airReach: 20,
    blastRadius: 9,
    blastDamage: 160,
  },
  // A shot-down wreck: the airframe, fuel and all, at its fall speed
  // (30–75 m/s): 1–4 chunks.
  {
    mass: 9,
    radius: 4,
    maxChunks: 8,
    airReach: 12,
    blastRadius: 12,
    blastDamage: 240,
  },
  // A meteor: steep and fast — down through several floors.
  {
    mass: 1.6,
    radius: 5,
    maxChunks: 16,
    airReach: 12,
    blastRadius: 11,
    blastDamage: 240,
  },
  // A comet: shallow and fast — through a row of buildings.
  {
    mass: 2.6,
    radius: 6,
    maxChunks: 40,
    airReach: 12,
    blastRadius: 11,
    blastDamage: 240,
  },
  // A crashing airship (Z1; a carrier section before it): heavy, slow and
  // huge — its hull meets a roof edge well off its centre.
  {
    mass: 40,
    radius: 16,
    maxChunks: 24,
    airReach: 30,
    blastRadius: 34,
    blastDamage: 1400,
  },
  // Collapse debris (its blast is D5's chain blast, sized by the caller).
  {
    mass: 1,
    radius: 4,
    maxChunks: 6,
    airReach: 12,
    blastRadius: 0,
    blastDamage: 0,
  },
];

/** Debris mass per m³ of the piece that struck. */
export const DEBRIS_DENSITY = 0.005;
/** A debris impactor's radius for `vol` m³: half its edge, 2–8 m. */
export const debrisRadius = (vol: number): number =>
  Math.min(8, Math.max(2, Math.cbrt(Math.max(0, vol)) / 2));

/** What hits: where it touches (canonical), its velocity (m/s), its mass
 * (the table's units) and its radius (m). */
export interface Impactor {
  origin: Vec3;
  velocity: Vec3;
  mass: number;
  radius: number;
}

export interface SweepOptions {
  /** Chunks it may break (its kind's cap). */
  maxChunks?: number;
  maxDist?: number;
  airReach?: number;
}

/** What ended a sweep. */
export const SWEEP_END_ENERGY = 0;
export const SWEEP_END_GROUND = 1;
export const SWEEP_END_CAP = 2;
export const SWEEP_END_DIST = 3;
/** It touched nothing within its air reach. */
export const SWEEP_END_NONE = 4;

export interface SweepResult {
  /** The chunks it breaks, in the order it reaches them. */
  chunks: number[];
  /** Per chunk: when it is reached, s after the impact (non-decreasing). */
  times: number[];
  /** Per chunk: how far along the path it is reached, m. */
  dists: number[];
  /** The path: start (canonical), unit direction, initial speed. */
  origin: Vec3;
  dir: Vec3;
  speed: number;
  /** Distance to the first thing it touched (a chunk or the street), m;
   * −1 when it touched nothing. */
  contact: number;
  /** Where it comes to rest (canonical), how far along, and when, s. */
  stop: Vec3;
  stopDist: number;
  stopT: number;
  /** SWEEP_END_*. */
  end: number;
  /** The timeline: (distance m, time s, speed m/s) triplets, ascending —
   * sweepPosAt reads it. */
  knots: number[];
}

/** A candidate building: its index, centre in the path's frame, and the
 * span of the path inside its (radius-grown) bounds. */
interface Candidate {
  i: number;
  cx: number;
  cz: number;
  tIn: number;
  tOut: number;
}

/** Slab-clip [tIn, tOut] of the ray (origin 0, unit `dir`) through a box
 * within [0, range]; null for a miss. */
function slab(
  dir: Vec3,
  range: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): [number, number] | null {
  let t0 = 0;
  let t1 = range;
  for (let axis = 0; axis < 3; axis++) {
    const dv = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
    const lo = axis === 0 ? x0 : axis === 1 ? y0 : z0;
    const hi = axis === 0 ? x1 : axis === 1 ? y1 : z1;
    if (dv === 0) {
      if (lo > 0 || hi < 0) return null;
      continue;
    }
    const a = lo / dv;
    const b = hi / dv;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

/** Point-to-box distance, the point in the box's frame. */
function boxDistance(px: number, py: number, pz: number, b: LocalBox): number {
  const dx = Math.max(b.x0 - px, 0, px - b.x1);
  const dy = Math.max(b.y0 - py, 0, py - b.y1);
  const dz = Math.max(b.z0 - pz, 0, pz - b.z1);
  return Math.hypot(dx, dy, dz);
}

const clampI = (v: number, n: number) =>
  Math.min(n - 1, Math.max(0, Math.floor(v)));

/** A sweep that touched nothing: rest at the origin. */
function emptySweep(
  origin: Vec3,
  dir: Vec3,
  speed: number,
  end: number,
): SweepResult {
  return {
    chunks: [],
    times: [],
    dists: [],
    origin: { x: origin.x, y: origin.y, z: origin.z },
    dir,
    speed,
    contact: -1,
    stop: { x: origin.x, y: origin.y, z: origin.z },
    stopDist: 0,
    stopT: 0,
    end,
    knots: [0, 0, speed],
  };
}

/**
 * March `imp` along its velocity through `buildings` as they stand (gone
 * chunks are air), breaking every chunk within its radius of the path while
 * its energy lasts. Deterministic: the same impactor against the same city
 * (shape and damage) always gives the same tunnel. Torus-correct (every
 * building enters the path's frame through wrapDelta). Bounded: at most
 * `maxChunks` chunks, SWEEP_MAX_DIST of path, SWEEP_MAX_DIST / SWEEP_STEP_M
 * steps; air is crossed in one jump per gap.
 */
export function sweepImpact(
  imp: Impactor,
  buildings: readonly Building[],
  opts: SweepOptions = {},
): SweepResult {
  const v = imp.velocity;
  const speed = Math.hypot(v.x, v.y, v.z);
  const dir =
    speed > 0
      ? { x: v.x / speed, y: v.y / speed, z: v.z / speed }
      : { x: 0, y: -1, z: 0 };
  if (!(speed >= SWEEP_MIN_SPEED) || !(imp.mass > 0)) {
    return emptySweep(imp.origin, dir, speed, SWEEP_END_NONE);
  }
  const r = Math.max(0, imp.radius);
  const maxChunks = opts.maxChunks ?? 64;
  const maxDist = Math.min(opts.maxDist ?? SWEEP_MAX_DIST, WORLD_SIZE / 2 - 1);
  const airReach = opts.airReach ?? SWEEP_AIR_REACH;
  const oy = imp.origin.y;
  // The street: the path's centre reaching y = 0.
  const ground =
    oy <= 0 ? 0 : dir.y < 0 ? oy / -dir.y : Number.POSITIVE_INFINITY;
  const limit = Math.min(maxDist, ground);

  // Broad phase: every building whose grown bounds the path crosses.
  const cands: Candidate[] = [];
  // The path's plan bounds, for a cheap reject before the slab clip.
  const ex = dir.x * limit;
  const ez = dir.z * limit;
  const minX = Math.min(0, ex);
  const maxX = Math.max(0, ex);
  const minZ = Math.min(0, ez);
  const maxZ = Math.max(0, ez);
  // wrapDeltaAxis inlined: both ends canonical, so one fold per axis.
  const ox = wrapCoord(imp.origin.x);
  const oz = wrapCoord(imp.origin.z);
  const half = WORLD_SIZE / 2;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i] as Building;
    let cx = b.x - ox;
    if (cx > half) cx -= WORLD_SIZE;
    else if (cx < -half) cx += WORLD_SIZE;
    let cz = b.z - oz;
    if (cz > half) cz -= WORLD_SIZE;
    else if (cz < -half) cz += WORLD_SIZE;
    const hw = b.width / 2 + r;
    const hd = b.depth / 2 + r;
    if (cx + hw < minX || cx - hw > maxX || cz + hd < minZ || cz - hd > maxZ) {
      continue;
    }
    const span = slab(
      dir,
      limit,
      cx - hw,
      cx + hw,
      -r - oy,
      b.height + r - oy,
      cz - hd,
      cz + hd,
    );
    if (span) cands.push({ i, cx, cz, tIn: span[0], tOut: span[1] });
  }
  cands.sort((a, b) => a.tIn - b.tIn || a.i - b.i);

  const e0 = 0.5 * imp.mass * speed * speed;
  const chunks: number[] = [];
  const times: number[] = [];
  const dists: number[] = [];
  // Energy releases: cost, where it starts, over how long a stretch.
  const relCost: number[] = [];
  const relFrom: number[] = [];
  const relLen: number[] = [];
  let committed = 0;
  let releaseEnd = 0;
  const knots: number[] = [0, 0, speed];
  const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };

  const energyAt = (d: number): number => {
    let e = e0;
    for (let k = 0; k < relCost.length; k++) {
      const u = (d - (relFrom[k] as number)) / (relLen[k] as number);
      if (u <= 0) continue;
      e -= (relCost[k] as number) * Math.min(1, u);
    }
    // Float dust once every release has run out is rest, not a crawl.
    return e > e0 * 1e-9 ? e : 0;
  };
  const speedAt = (d: number): number =>
    Math.sqrt((2 * energyAt(d)) / imp.mass);

  let d = 0;
  let t = 0;
  let vNow = speed;
  let contact = -1;
  let end = SWEEP_END_DIST;
  let exhausted = false;
  let next = 0; // first candidate not yet entirely behind

  /** Advance to `to` (air at constant speed, or a release in progress
   * integrated step by step), writing knots. */
  const advance = (to: number): void => {
    if (to <= d) return;
    const vTo = speedAt(to);
    const avg = 0.5 * (vNow + vTo);
    t += avg > 1e-6 ? (to - d) / avg : 0;
    d = to;
    vNow = vTo;
    knots.push(d, t, vNow);
  };

  /** Visit every chunk within `r` of the path at distance `at`. */
  const visit = (at: number): void => {
    const py = oy + dir.y * at;
    for (let n = next; n < cands.length; n++) {
      const cand = cands[n] as Candidate;
      if (cand.tIn > at) break;
      if (cand.tOut < at) continue;
      const b = buildings[cand.i] as Building;
      const px = dir.x * at - cand.cx;
      const pz = dir.z * at - cand.cz;
      const grids = tierGrids(b);
      const masks = chunkMask(b);
      const hard = b.height >= LANDMARK_HEIGHT ? SWEEP_LANDMARK_HARDNESS : 1;
      for (let k = 0; k < grids.length && !exhausted; k++) {
        const g = grids[k] as TierGrid;
        if (py + r < g.baseY || py - r > g.baseY + g.height) continue;
        const hw = g.width / 2;
        const hd = g.depth / 2;
        if (px + r < -hw || px - r > hw || pz + r < -hd || pz - r > hd) {
          continue;
        }
        const mask = masks[k] as Uint8Array;
        const gone = b.damage?.cells[k];
        const ix0 = clampI((px - r + hw) / g.cw, g.nx);
        const ix1 = clampI((px + r + hw) / g.cw, g.nx);
        const iy0 = clampI((py - r - g.baseY) / g.ch, g.ny);
        const iy1 = clampI((py + r - g.baseY) / g.ch, g.ny);
        const iz0 = clampI((pz - r + hd) / g.cd, g.nz);
        const iz1 = clampI((pz + r + hd) / g.cd, g.nz);
        for (let iy = iy0; iy <= iy1 && !exhausted; iy++) {
          for (let iz = iz0; iz <= iz1 && !exhausted; iz++) {
            for (let ix = ix0; ix <= ix1 && !exhausted; ix++) {
              const cell = cellIndex(g, ix, iy, iz);
              if (!mask[cell] || gone?.[cell]) continue;
              const id = chunkId(cand.i, k, cell);
              if (chunks.includes(id)) continue;
              if (boxDistance(px, py, pz, cellBox(g, cell, box)) > r) continue;
              if (contact < 0) contact = at;
              const cost = g.cw * g.ch * g.cd * SWEEP_COST_PER_M3 * hard;
              const len = Math.max(
                1,
                Math.abs(dir.x) * g.cw +
                  Math.abs(dir.y) * g.ch +
                  Math.abs(dir.z) * g.cd,
              );
              const left = e0 - committed;
              if (chunks.length < maxChunks && left >= cost) {
                chunks.push(id);
                dists.push(at);
                times.push(t);
                relCost.push(cost);
                relFrom.push(at);
                relLen.push(len);
                committed += cost;
                releaseEnd = Math.max(releaseEnd, at + len);
                if (committed >= e0) {
                  exhausted = true;
                  end = SWEEP_END_ENERGY;
                }
              } else {
                // It cannot afford this one (or has broken its cap): what
                // energy is left is spent partway into it.
                const share = chunks.length < maxChunks ? left / cost : 1;
                const partial = Math.max(0.5, len * Math.min(1, share));
                relCost.push(left);
                relFrom.push(at);
                relLen.push(partial);
                releaseEnd = Math.max(releaseEnd, at + partial);
                committed = e0;
                exhausted = true;
                end =
                  chunks.length < maxChunks ? SWEEP_END_ENERGY : SWEEP_END_CAP;
              }
            }
          }
        }
      }
    }
  };

  // The march (a body already inside a wall breaks it at once).
  if (cands.length > 0 && (cands[0] as Candidate).tIn <= 0) visit(0);
  while (d < limit) {
    while (next < cands.length && (cands[next] as Candidate).tOut < d) next++;
    if (exhausted) {
      // Spend what is left over the last releases, then rest.
      const to = Math.min(limit, releaseEnd);
      while (d < to - 1e-9) advance(Math.min(to, d + SWEEP_STEP_M));
      if (to >= releaseEnd) return finish(d, end);
      break;
    }
    const inside =
      next < cands.length && (cands[next] as Candidate).tIn <= d + 1e-9;
    if (!inside && d >= releaseEnd) {
      // Air: one jump to the next building (or the limit).
      const to = next < cands.length ? (cands[next] as Candidate).tIn : limit;
      // Nothing within reach before the gap's end (the street included:
      // `limit` is it when it comes first).
      if (contact < 0 && Math.min(to, limit) > airReach) {
        return emptySweep(imp.origin, dir, speed, SWEEP_END_NONE);
      }
      const gapEnd = Math.min(to, limit);
      if (contact >= 0 && gapEnd > d) {
        // Past the first wall the gap costs SWEEP_AIR_DECEL; what cannot
        // cross it comes to rest just outside its exit hole.
        const perM = imp.mass * SWEEP_AIR_DECEL;
        const left = e0 - committed;
        const reach = left / perM;
        if (reach < gapEnd - d) {
          relCost.push(left);
          relFrom.push(d);
          relLen.push(Math.max(0.5, reach));
          releaseEnd = d + Math.max(0.5, reach);
          committed = e0;
          exhausted = true;
          end = SWEEP_END_ENERGY;
          continue;
        }
        relCost.push(perM * (gapEnd - d));
        relFrom.push(d);
        relLen.push(gapEnd - d);
        committed += perM * (gapEnd - d);
      }
      advance(gapEnd);
      if (d >= limit) break;
      visit(d);
      continue;
    }
    advance(Math.min(limit, d + SWEEP_STEP_M));
    visit(d);
  }
  if (d >= ground - 1e-9) {
    if (contact < 0) contact = ground;
    return finish(Math.min(d, ground), SWEEP_END_GROUND);
  }
  if (contact < 0) return emptySweep(imp.origin, dir, speed, SWEEP_END_NONE);
  return finish(d, SWEEP_END_DIST);

  function finish(stopDist: number, how: number): SweepResult {
    return {
      chunks,
      times,
      dists,
      origin: { x: imp.origin.x, y: imp.origin.y, z: imp.origin.z },
      dir,
      speed,
      contact,
      stop: {
        x: wrapCoord(imp.origin.x + dir.x * stopDist),
        y: Math.max(0, oy + dir.y * stopDist),
        z: wrapCoord(imp.origin.z + dir.z * stopDist),
      },
      stopDist,
      stopT: t,
      end: how,
      knots,
    };
  }
}

/**
 * Where the body is `s` seconds after the impact (clamped to the stop):
 * along the path at the timeline's speed, decelerating through each chunk.
 * Canonical; writes into `out` and returns it. Allocation-free.
 */
export function sweepPosAt(res: SweepResult, s: number, out: Vec3): Vec3 {
  const dist = sweepDistAt(res, s);
  out.x = wrapCoord(res.origin.x + res.dir.x * dist);
  out.y = Math.max(0, res.origin.y + res.dir.y * dist);
  out.z = wrapCoord(res.origin.z + res.dir.z * dist);
  return out;
}

/** Distance along the path at `s` seconds (clamped to [0, stopDist]). */
export function sweepDistAt(res: SweepResult, s: number): number {
  const k = res.knots;
  if (!(s > 0)) return 0;
  if (s >= res.stopT) return res.stopDist;
  for (let i = 3; i < k.length; i += 3) {
    const t1 = k[i + 1] as number;
    if (s > t1) continue;
    const d0 = k[i - 3] as number;
    const t0 = k[i - 2] as number;
    const v0 = k[i - 1] as number;
    const d1 = k[i] as number;
    const v1 = k[i + 2] as number;
    const dt = t1 - t0;
    if (dt <= 1e-9) return d1;
    const tau = s - t0;
    const a = (v1 - v0) / dt;
    return Math.min(d1, d0 + v0 * tau + 0.5 * a * tau * tau);
  }
  return res.stopDist;
}

/** The body's speed `s` seconds after the impact, m/s (0 once at rest). */
export function sweepSpeedAt(res: SweepResult, s: number): number {
  const k = res.knots;
  if (s >= res.stopT) return 0;
  if (!(s > 0)) return res.speed;
  for (let i = 3; i < k.length; i += 3) {
    const t1 = k[i + 1] as number;
    if (s > t1) continue;
    const t0 = k[i - 2] as number;
    const v0 = k[i - 1] as number;
    const v1 = k[i + 2] as number;
    const dt = t1 - t0;
    return dt <= 1e-9 ? v1 : v0 + ((v1 - v0) * (s - t0)) / dt;
  }
  return 0;
}

/** A chunk's centre in world coordinates (canonical), or null for an id
 * that names no cell. Writes into `out`. */
export function chunkCentre(
  buildings: readonly Building[],
  id: number,
  out: Vec3,
): Vec3 | null {
  const b = buildings[chunkBuilding(id)];
  const g = b && tierGrids(b)[chunkTier(id)];
  if (!b || !g || chunkCell(id) >= g.nx * g.ny * g.nz) return null;
  const box = cellBox(g, chunkCell(id));
  out.x = wrapCoord(b.x + (box.x0 + box.x1) / 2);
  out.y = (box.y0 + box.y1) / 2;
  out.z = wrapCoord(b.z + (box.z0 + box.z1) / 2);
  return out;
}

// --- The impact record (the wire) --------------------------------------------

/** One impact, exactly as broadcast: its kind, server time (ms), the
 * impactor (positions canonical, everything on the wire's 0.1 grid) and
 * what it came from (a wreck or strike id; 0 for nothing). */
export interface ImpactRecord {
  kind: ImpactKind;
  t: number;
  origin: Vec3;
  velocity: Vec3;
  mass: number;
  radius: number;
  src: number;
}

/** [kind, t, ox, oy, oz, vx, vy, vz, mass, radius, src] — ×10 integers
 * for the vectors, mass and radius. */
export type WireImpact = [
  kind: number,
  t: number,
  ox: number,
  oy: number,
  oz: number,
  vx: number,
  vy: number,
  vz: number,
  m: number,
  r: number,
  src: number,
];

const q = (v: number): number => Math.round(v * 10) / 10;
const qc = (v: number): number => {
  const c = Math.round(wrapCoord(v) * 10) / 10;
  return c >= WORLD_SIZE ? 0 : c;
};

/** A record on the wire's grid — the server sweeps exactly this, so every
 * client's replay starts from bit-equal numbers. */
export function makeImpact(
  kind: ImpactKind,
  t: number,
  origin: Vec3,
  velocity: Vec3,
  src = 0,
  mass: number = (IMPACTORS[kind] as ImpactorSpec).mass,
  radius: number = (IMPACTORS[kind] as ImpactorSpec).radius,
): ImpactRecord {
  return {
    kind,
    t: Math.round(t),
    origin: { x: qc(origin.x), y: q(Math.max(0, origin.y)), z: qc(origin.z) },
    velocity: { x: q(velocity.x), y: q(velocity.y), z: q(velocity.z) },
    mass: Math.max(0.1, q(mass)),
    radius: Math.max(0, q(radius)),
    src: Math.max(0, Math.round(src)),
  };
}

export function encodeImpact(r: ImpactRecord): WireImpact {
  const i = (v: number) => Math.round(v * 10);
  return [
    r.kind,
    r.t,
    i(r.origin.x),
    i(r.origin.y),
    i(r.origin.z),
    i(r.velocity.x),
    i(r.velocity.y),
    i(r.velocity.z),
    i(r.mass),
    i(r.radius),
    r.src,
  ];
}

/** Inverse of encodeImpact; null for anything malformed. */
export function decodeImpact(w: unknown): ImpactRecord | null {
  if (!Array.isArray(w) || w.length !== 11) return null;
  if (!w.every((v) => typeof v === "number" && Number.isInteger(v))) {
    return null;
  }
  const [kind, t, ox, oy, oz, vx, vy, vz, m, r, src] = w as number[];
  if ((kind as number) < 0 || (kind as number) >= IMPACT_KINDS) return null;
  if ((m as number) <= 0 || (r as number) < 0 || (src as number) < 0) {
    return null;
  }
  return {
    kind: kind as ImpactKind,
    t: t as number,
    origin: {
      x: (ox as number) / 10,
      y: (oy as number) / 10,
      z: (oz as number) / 10,
    },
    velocity: {
      x: (vx as number) / 10,
      y: (vy as number) / 10,
      z: (vz as number) / 10,
    },
    mass: (m as number) / 10,
    radius: (r as number) / 10,
    src: src as number,
  };
}

/** The sweep a record describes, against `buildings` as they stand. */
export function sweepRecord(
  rec: ImpactRecord,
  buildings: readonly Building[],
): SweepResult {
  const spec = IMPACTORS[rec.kind] as ImpactorSpec;
  return sweepImpact(rec, buildings, {
    maxChunks: spec.maxChunks,
    airReach: spec.airReach,
  });
}
