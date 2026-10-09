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
//
// D5: and what it hits. Every collapse — shot, missile, wreck or director —
// goes through recordCollapse, which queues where its falling pieces drive
// into neighbouring buildings (collapseImpacts); each impact lands at its
// instant as a D2 blast credited like the collapse, so a neighbour can come
// down in turn (at most CHAIN_DEPTH_MAX links). And what comes back: a
// rebuild (rebuildBuilding / rebuildCrane) restores a whole building, drops
// its collapse records and everything the room keeps about it.

import {
  type Building,
  CityDamage,
  chunkBuilding,
  makeBuilding,
  raycastChunk,
} from "@angels-bandits/common/city";
import {
  CollapseField,
  type CollapseImpact,
  type CollapsePlan,
  type CollapseWire,
  KIND_BUILDING,
  KIND_CRANE,
  TOPPLE,
  collapseChunks,
  collapseImpacts,
  collapseWire,
  collideCollapses,
  craneFallDir,
  planCollapses,
  wireKind,
} from "@angels-bandits/common/city/collapse";
import type { CraneSite } from "@angels-bandits/common/city/movers";
import {
  type CityIndex,
  buildCityIndex,
} from "@angels-bandits/common/collision";
import {
  BULLET_DAMAGE,
  BULLET_RANGE,
  CHAIN_BLAST_DAMAGE,
  CHAIN_BLAST_RADIUS,
  CHAIN_DEPTH_MAX,
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
  /** The block index of `buildings` (valid under damage: footprints never
   * change, and rubble's reach is already in it). */
  readonly index: CityIndex;
  /** D5: falling debris due to drive into a neighbour, earliest first. */
  impacts: ChainImpact[];
  /** D5: each collapse's link in its chain (0 = it started one). */
  readonly collapseDepth: Map<number, number>;
  /** D5: the chain link a building's next planned collapse would be (set
   * when debris breaks it, cleared once it has been planned). */
  readonly chainDepth: Map<number, number>;
  /** D5 rebuild timers, server ms: when each building was first damaged
   * since it was last whole, and when it last had a collapse. */
  readonly firstDamageAt: Map<number, number>;
  readonly lastStructuralAt: Map<number, number>;
}

/** One queued D5 impact: where and when, which collapse's debris (dropped
 * if that record is rebuilt away), its chain link and its credit. */
export interface ChainImpact extends CollapseImpact {
  source: number;
  depth: number;
  by: string | null;
}

export function createRoomCity(
  buildings: readonly Building[],
  cranes: readonly CraneSite[] = [],
): RoomCity {
  const copy = cloneCity(buildings);
  const damage = new CityDamage();
  damage.bind(copy);
  const collapses = new CollapseField();
  collapses.bind(copy);
  collapses.bindCranes(cranes);
  return {
    buildings: copy,
    damage,
    index: buildCityIndex(copy),
    collapses,
    breakers: new Map(),
    collapseBy: new Map(),
    dirty: new Set(),
    nextCollapseId: 1,
    impacts: [],
    collapseDepth: new Map(),
    chainDepth: new Map(),
    firstDamageAt: new Map(),
    lastStructuralAt: new Map(),
  };
}

/** The room's city is whole again (its last human left). */
export function resetRoomCity(city: RoomCity): void {
  city.damage.reset([]);
  city.collapses.reset([]);
  city.breakers.clear();
  city.collapseBy.clear();
  city.dirty.clear();
  city.impacts = [];
  city.collapseDepth.clear();
  city.chainDepth.clear();
  city.firstDamageAt.clear();
  city.lastStructuralAt.clear();
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
  landImpacts(city, now);
  const broke = city.damage.takeDestroyed();
  for (const id of broke) {
    const b = chunkBuilding(id);
    city.dirty.add(b);
    if (!city.firstDamageAt.has(b)) city.firstDamageAt.set(b, now);
  }
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
    const depth = city.chainDepth.get(index) ?? 0;
    city.chainDepth.delete(index);
    for (const plan of planCollapses(b, index)) {
      collapses.push(
        stageCollapse(
          city,
          plan,
          index,
          now,
          city.breakers.get(index) ?? null,
          depth,
        ),
      );
    }
  }
  return { broke, collapses };
}

/**
 * Record one collapse event in the room: its chunks fall, the field gets
 * the record, its credit and chain link are kept, the building's rebuild
 * timers start, and (below CHAIN_DEPTH_MAX) where its debris will drive
 * into neighbours is queued. Every collapse goes through here.
 */
export function recordCollapse(
  city: RoomCity,
  wire: CollapseWire,
  by: string | null,
  depth: number,
): void {
  city.damage.collapse(collapseChunks(wire));
  const c = city.collapses.add(wire);
  city.collapseBy.set(wire.id, by);
  city.collapseDepth.set(wire.id, depth);
  if (wireKind(wire) === KIND_BUILDING) {
    city.lastStructuralAt.set(wire.b, wire.t);
    if (!city.firstDamageAt.has(wire.b)) city.firstDamageAt.set(wire.b, wire.t);
  }
  if (!c || depth >= CHAIN_DEPTH_MAX) return;
  for (const i of collapseImpacts(c, city.buildings)) {
    city.impacts.push({ ...i, source: wire.id, depth, by });
  }
  city.impacts.sort((a, b) => a.t - b.t);
}

/** A plan as the room's next collapse event at `now`, recorded. */
export function stageCollapse(
  city: RoomCity,
  plan: CollapsePlan,
  index: number,
  now: number,
  by: string | null,
  depth = 0,
): CollapseWire {
  const wire = collapseWire(plan, index, city.nextCollapseId++, now);
  recordCollapse(city, wire, by, depth);
  return wire;
}

/** D5: crane `site` goes over at `now` (jib first), recorded. Nobody's. */
export function stageCraneFall(
  city: RoomCity,
  site: CraneSite,
  now: number,
): CollapseWire {
  const wire: CollapseWire = {
    id: city.nextCollapseId++,
    b: site.id,
    t: now,
    s: TOPPLE,
    d: craneFallDir(site, now),
    c: [],
    k: KIND_CRANE,
  };
  recordCollapse(city, wire, null, 0);
  return wire;
}

/** Land every queued impact due by `now`: a D2 blast where the debris
 * drove in, credited to the collapse's culprit; a building it breaks is
 * one chain link further down. */
function landImpacts(city: RoomCity, now: number): void {
  let k = 0;
  while (k < city.impacts.length && (city.impacts[k] as ChainImpact).t <= now) {
    const i = city.impacts[k] as ChainImpact;
    k++;
    const out = city.damage.damageAt(i, CHAIN_BLAST_RADIUS, CHAIN_BLAST_DAMAGE);
    for (const id of out) {
      const b = chunkBuilding(id);
      city.breakers.set(b, i.by);
      city.chainDepth.set(
        b,
        Math.max(city.chainDepth.get(b) ?? 0, i.depth + 1),
      );
    }
  }
  if (k > 0) city.impacts.splice(0, k);
}

/**
 * D5 rebuild: building `index` is whole again — every chunk restored, its
 * collapse records (debris and rubble) dropped, and everything the room
 * keeps about it forgotten: credit, chain links, timers, queued impacts of
 * its own debris. Returns the restored chunk ids.
 */
export function rebuildBuilding(city: RoomCity, index: number): number[] {
  const restored = city.damage.restoreBuilding(index);
  forgetRecords(city, city.collapses.removeBuilding(index));
  city.breakers.delete(index);
  city.dirty.delete(index);
  city.chainDepth.delete(index);
  city.firstDamageAt.delete(index);
  city.lastStructuralAt.delete(index);
  return restored;
}

/** D5 rebuild: the crane at site `id` stands again. */
export function rebuildCrane(city: RoomCity, id: number): void {
  forgetRecords(city, city.collapses.removeCrane(id));
}

function forgetRecords(city: RoomCity, ids: readonly number[]): void {
  if (ids.length === 0) return;
  const gone = new Set(ids);
  for (const id of ids) {
    city.collapseBy.delete(id);
    city.collapseDepth.delete(id);
  }
  city.impacts = city.impacts.filter((i) => !gone.has(i.source));
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
