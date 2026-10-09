// D2 breakable buildings, server side: each room's own breakable copy of the
// city, and the two ways a fight breaks it — a bullet's ray and a death's
// blast. index.ts and the bot-sim harness both call exactly these, so the sim
// measures the damage the live server deals.
//
// The server is the only authority on what breaks (PLAN.md authority split:
// combat is server-side). Movement and crash DETECTION stay with each client,
// which subtracts the same destroyed set from the same city.
//
// D3: and what falls. Once per tick `tickDestruction` takes what broke,
// runs the collapse planner over every building it touched, marks the
// fallen chunks and records each event in the room's CollapseField — the
// field the room's movers (so the bots) collide with, and the welcome
// replays. Each event remembers who brought it down (`by`), for credit.

import {
  type Building,
  CityDamage,
  chunkBuilding,
  makeBuilding,
  raycastChunk,
} from "@angels-bandits/common/city";
import {
  CollapseField,
  type CollapseWire,
  collapseChunks,
  collapseWire,
  collideCollapses,
  planCollapses,
} from "@angels-bandits/common/city/collapse";
import {
  BULLET_DAMAGE,
  BULLET_RANGE,
  COLLAPSE_CAP,
  COLLAPSE_TICK_LIMIT,
  DEATH_BLAST_DAMAGE,
  DEATH_BLAST_RADIUS,
} from "@angels-bandits/common/constants";
import type { Quat } from "@angels-bandits/common/protocol";
import type { Vec3 } from "@angels-bandits/common/world";

/**
 * A breakable copy of `buildings`: new Building objects in the same order
 * (chunk ids are building indices, so the order IS the protocol), sharing
 * the immutable tiers, holes and roofs, built through makeBuilding so they
 * keep the seed city's one object shape.
 */
export function cloneCity(buildings: readonly Building[]): Building[] {
  return buildings.map((b) => makeBuilding({ ...b, damage: undefined }));
}

/** One room's city and what has been broken — and has fallen — in it. One
 * owner, one reset (resetRoomCity): the damage and the collapses never
 * disagree about what stands. */
export interface RoomCity {
  readonly buildings: Building[];
  readonly damage: CityDamage;
  /** D3: the room's collapses. The SAME object for the room's life (reset in
   * place): the room's MoverField and its bots hold it. */
  readonly collapses: CollapseField;
  /** D3: who last broke a chunk of each building (null: nobody to credit). */
  readonly breakers: Map<number, string | null>;
  /** D3: who brought each collapse down, by collapse id. */
  readonly collapseBy: Map<number, string | null>;
  /** Buildings to run the collapse planner on (carried over a tick when
   * COLLAPSE_TICK_LIMIT is reached). */
  readonly dirty: Set<number>;
  nextCollapseId: number;
}

export function createRoomCity(buildings: readonly Building[]): RoomCity {
  const copy = cloneCity(buildings);
  const damage = new CityDamage();
  damage.bind(copy);
  const collapses = new CollapseField();
  collapses.bind(copy);
  return {
    buildings: copy,
    damage,
    collapses,
    breakers: new Map(),
    collapseBy: new Map(),
    dirty: new Set(),
    nextCollapseId: 1,
  };
}

/** The room's city is whole again (its last human left). */
export function resetRoomCity(city: RoomCity): void {
  city.damage.reset([]);
  city.collapses.reset([]);
  city.breakers.clear();
  city.collapseBy.clear();
  city.dirty.clear();
}

/** Unit nose vector of a wire attitude (the same math as bots.poseVelocity
 * at speed 1: the plane flies along its local −Z). */
export function noseOf(quat: Quat): Vec3 {
  const { x, y, z, w } = quat;
  const v = {
    x: -2 * w * y - 2 * x * z,
    y: 2 * w * x - 2 * y * z,
    z: -1 + 2 * x * x + 2 * y * y,
  };
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * One accepted round: ray it from `origin` along `dir` (unit) through the
 * room's city for BULLET_RANGE and take BULLET_DAMAGE off the first chunk it
 * meets. The ray only knows the city — a round that hit a plane may chip the
 * wall behind it too. Returns the chunk hit, or -1.
 */
export function applyShotDamage(
  city: RoomCity,
  origin: Vec3,
  dir: Vec3,
  by: string | null = null,
): number {
  const hit = raycastChunk(city.buildings, origin, dir, BULLET_RANGE);
  if (!hit || hit.chunk < 0) return -1;
  if (city.damage.damageChunk(hit.chunk, BULLET_DAMAGE)) {
    city.breakers.set(hit.building, by);
  }
  return hit.chunk;
}

/** A plane died at `pos`: blow out every chunk near enough (point-to-box,
 * DEATH_BLAST_RADIUS, falling off to 0). Returns the chunks destroyed.
 * `by` (the death's killer, if any) is what a collapse it causes credits. */
export function applyDeathBlast(
  city: RoomCity,
  pos: Vec3,
  by: string | null = null,
): number[] {
  const out = city.damage.damageAt(pos, DEATH_BLAST_RADIUS, DEATH_BLAST_DAMAGE);
  for (const id of out) city.breakers.set(chunkBuilding(id), by);
  return out;
}

/** What one tick of destruction produced, in broadcast order. */
export interface DestructionTick {
  /** Chunks broken since the last tick (the `chunks` batch). */
  broke: number[];
  /** Collapse events started this tick. */
  collapses: CollapseWire[];
}

/**
 * One tick: take what broke, then plan the collapses of every building it
 * touched (and any carried over). Each event's chunks are marked fallen and
 * the event added to the room's field at server time `now`. At most
 * COLLAPSE_TICK_LIMIT events start per tick; none once COLLAPSE_CAP of the
 * room's chunks are gone.
 */
export function tickDestruction(city: RoomCity, now: number): DestructionTick {
  const broke = city.damage.takeDestroyed();
  for (const id of broke) city.dirty.add(chunkBuilding(id));
  const collapses: CollapseWire[] = [];
  const damage = city.damage;
  const capped = () =>
    damage.destroyedCount + damage.fallenCount >=
    COLLAPSE_CAP * damage.chunkCount;
  for (const index of [...city.dirty].sort((a, b) => a - b)) {
    if (collapses.length >= COLLAPSE_TICK_LIMIT) break;
    city.dirty.delete(index);
    if (capped()) continue;
    const b = city.buildings[index];
    if (!b) continue;
    for (const plan of planCollapses(b, index)) {
      const wire = collapseWire(plan, index, city.nextCollapseId++, now);
      damage.collapse(collapseChunks(wire));
      city.collapses.add(wire);
      city.collapseBy.set(wire.id, city.breakers.get(index) ?? null);
      collapses.push(wire);
    }
  }
  return { broke, collapses };
}

/**
 * Kill credit for a crash at `pos` at server time `t`: if falling collapse
 * debris (within `radius`) is what it hit, the collapse and who brought it
 * down; else null (a plain crash).
 */
export function collapseCulprit(
  city: RoomCity,
  pos: Vec3,
  radius: number,
  t: number,
): { id: number; by: string | null } | null {
  const hit = collideCollapses(pos, radius, city.collapses.list, t, true);
  if (!hit) return null;
  return {
    id: hit.collapse.id,
    by: city.collapseBy.get(hit.collapse.id) ?? null,
  };
}
