// W2 enemy bombs — the shared, pure half. The carrier's enemy planes carry
// DT1's five bombs (client/src/render/fighter.ts FIGHTER_BOMB_RACKS: bit 0
// the heavy one on the centreline trapeze, bits 1–4 the wing racks) and drop
// them on the city in two kinds of run:
//
//  - a DIVE: climb over a rooftop near the hunted pilot, push over into a
//    shallow glide-bomb dive and throw the heavy bomb (rack 0);
//  - a CARPET: level down a street toward the pilot, the four wing bombs
//    one after another (racks 1–4).
//
// The server decides when and whether (server/src/bombs.ts, the brain in
// server/src/bots.ts); this file is what both sides agree on: the racks, and
// where a bomb released from a plane lands. A drop is an X1 strike of kind
// "bomb" (common/src/strike.ts): it leaves the plane at the plane's ground
// speed and sink (`vy`), falls along the shared pure curve for BOMB_FALL_MS
// and lands on whatever stands under its ground track — the drop is only
// made when that whole path is clear of the city, so the bomb every client
// draws is the bomb the server lands (draw == collide).
//
// Not re-exported from common/src/index.ts; import "@angels-bandits/common/bombs".

import type { Building } from "./city/index";
import { standingTopAt } from "./city/standing";
import { type CityIndex, forEachBuildingNear } from "./collision";
import { WORLD_SIZE } from "./constants";
import {
  BOMB_FALL_MS,
  type MissileStrike,
  decodeMissile,
  encodeMissile,
  missilePathClear,
} from "./strike";
import { type Vec3, wrapCoord } from "./world/index";

// --- Racks ----------------------------------------------------------------------

/** Bombs an enemy plane is launched with, one per rack. */
export const BOMB_RACKS = 5;
/** Every rack loaded. */
export const BOMBS_LOADED = (1 << BOMB_RACKS) - 1;
/** The heavy centreline bomb a dive throws. */
export const DIVE_RACK = 0;
/** The wing racks a carpet empties, in order. */
export const CARPET_RACKS: readonly number[] = [1, 2, 3, 4];

export type BombRunKind = "dive" | "carpet";

/** The next rack a run of `kind` drops from `mask`, or -1 when that kind's
 * racks are empty. */
export function nextRack(kind: BombRunKind, mask: number): number {
  if (kind === "dive") return mask & (1 << DIVE_RACK) ? DIVE_RACK : -1;
  for (const r of CARPET_RACKS) if (mask & (1 << r)) return r;
  return -1;
}

/** Bombs still on the racks of `kind` in `mask`. */
export function bombsFor(kind: BombRunKind, mask: number): number {
  if (kind === "dive") return mask & (1 << DIVE_RACK) ? 1 : 0;
  let n = 0;
  for (const r of CARPET_RACKS) if (mask & (1 << r)) n++;
  return n;
}

// --- Where a drop lands -----------------------------------------------------------

/** The release envelope. A bomb falls BOMB_FALL_MS whatever its height, so
 * its pull down is 2(h + vy·T)/T²: inside these bounds it visibly falls —
 * neither drifting down a straight line nor slammed into the street — which
 * holds a dive's release height to its sink rate. m/s². */
export const BOMB_G_MIN = 6;
export const BOMB_G_MAX = 40;
/** No bomb is released more than this over where it lands, m. */
export const BOMB_DROP_MAX_M = 250;

/** The wire's 0.1 m grid. */
const q = (v: number): number => Math.round(v * 10) / 10;
/** A horizontal coordinate wrapped THEN put on the grid. */
const qc = (v: number): number => {
  const r = Math.round(wrapCoord(v) * 10) / 10;
  return r >= WORLD_SIZE ? 0 : r;
};

/** The height of whatever stands at (x, z) in `index`'s city as it stands
 * now — a roof, a broken tower's stump — or 0 (the street). */
export function bombSurfaceY(index: CityIndex, x: number, z: number): number {
  const buildings = index.buildings;
  let top = 0;
  forEachBuildingNear(index, { x, y: 0, z }, 0.5, (i, o) => {
    // `o` is building − point: the point in the building's frame is −o.
    const t = standingTopAt(buildings[i] as Building, -o.x, -o.z);
    if (t > top) top = t;
  });
  return top;
}

/** Where a bomb released at `from` flying `vel` (m/s) lands, on the wire
 * grid: half its ground speed × the fall ahead along its ground track (the
 * curve's u(2 − u) leaves at exactly that ground speed), on the surface
 * there. */
export function bombImpactPoint(from: Vec3, vel: Vec3, index: CityIndex): Vec3 {
  const s = BOMB_FALL_MS / 2000;
  const x = qc(from.x + vel.x * s);
  const z = qc(from.z + vel.z * s);
  return { x, y: q(bombSurfaceY(index, x, z)), z };
}

/** The constant pull down a bomb falls with, m/s² (see BOMB_G_MIN). */
export function bombGravity(s: MissileStrike): number {
  const t = BOMB_FALL_MS / 1000;
  const h = s.from.y - s.to.y;
  return (2 * (h + (s.vy ?? 0) * t)) / (t * t);
}

/** Inside the release envelope: falling down onto `to` from no higher than
 * BOMB_DROP_MAX_M, with a pull between BOMB_G_MIN and BOMB_G_MAX. */
export function bombCurveOk(s: MissileStrike): boolean {
  const h = s.from.y - s.to.y;
  if (!(h > 0) || h > BOMB_DROP_MAX_M) return false;
  const g = bombGravity(s);
  return g >= BOMB_G_MIN && g <= BOMB_G_MAX;
}

/** Why a drop was not made. */
export type BombRefusal = "curve" | "path";

/**
 * The bomb a plane at `from` flying `vel` would drop at `t0` — exactly as
 * every client will decode it — or why it cannot: outside the release
 * envelope ("curve"), or its fall meets the city as it stands (`buildings`)
 * before its impact ("path"). Pure.
 */
export function planBombDrop(
  id: number,
  from: Vec3,
  vel: Vec3,
  t0: number,
  index: CityIndex,
  buildings: readonly Building[],
): MissileStrike | BombRefusal {
  const planned: MissileStrike = {
    id,
    kind: "bomb",
    from: { x: qc(from.x), y: q(from.y), z: qc(from.z) },
    to: bombImpactPoint(from, vel, index),
    t0: Math.round(t0),
    vy: q(vel.y),
  };
  // What the wire carries is what lands: keep the round trip's values.
  const s = decodeMissile(encodeMissile(planned)) as MissileStrike;
  if (!bombCurveOk(s)) return "curve";
  if (!missilePathClear(s, buildings)) return "path";
  return s;
}

// --- Wire -----------------------------------------------------------------------

/** The welcome's racks: [enemy id, mask] for every enemy that has dropped
 * anything (an enemy left out is fully loaded). */
export type WireRacks = [id: string, mask: number][];

/** Inverse of a WireRacks list; malformed rows are dropped. */
export function decodeRacks(w: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(w)) return out;
  for (const row of w) {
    if (!Array.isArray(row) || row.length !== 2) continue;
    const [id, mask] = row as unknown[];
    if (typeof id !== "string" || !Number.isInteger(mask)) continue;
    out.set(id, (mask as number) & BOMBS_LOADED);
  }
  return out;
}
