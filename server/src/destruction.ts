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
// D9: and everything else that breaks. Each room also holds the city's
// destructible props (common/src/city/props.ts) — cars, fuel trucks, gas
// stations, lamps, signals, poles, roof tanks/billboards/masts, jumbotrons,
// bridge spans and cranes: every bullet ray and blast below damages them
// too (blastProps), and tickProps — inside tickDestruction — lands their
// chain explosions, crushes, falls and repairs under the per-tick caps.
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
  encodeChunkIds,
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
  CRATERS_MAX,
  CRATER_MERGE_M,
  type Crater,
  LANDING_BLAST,
  PROP_BLAST,
  PROP_BLASTS_PER_TICK,
  PROP_BRIDGE,
  PROP_CHAIN_DEPTH_MAX,
  PROP_CRANE,
  PROP_JUMBO,
  PROP_REPAIR_MS,
  type PropDown,
  type PropLayout,
  type PropSlot,
  SPAN_REPAIR_LEAD_MS,
  SPAN_REPAIR_MS,
  type WireCrater,
  type WirePropState,
  collapseCrushes,
  collideProps,
  craterRadius,
  craterWater,
  encodeCrater,
  encodeIdRecords,
  fallSeconds,
  fallerCrushes,
  fallerLanding,
  generateProps,
  isExplosive,
  isFaller,
  isRoofProp,
  propDistance,
  propFuseMs,
  propRepairMs,
  propSlot,
  propsNear,
  raycastProps,
  roofKey,
} from "@angels-bandits/common/city/props";
import type { TrainLine } from "@angels-bandits/common/city/train";
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
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";

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
  /** D9: the room's destructible props. */
  readonly props: PropRoom;
}

/** One queued prop event: when, which prop, the chain link that set it off,
 * who it credits, and the instant the prop went down (a repair in between
 * makes the entry stale). */
interface PropEvent {
  t: number;
  id: number;
  depth: number;
  by: string | null;
  downAt: number;
}

/** D9: one room's props, server side — the shared PropState (also the
 * room's MoverField slot) plus what only the server schedules. */
export interface PropRoom {
  readonly layout: PropLayout;
  /** layout + state: the MoverField's `props`. */
  readonly slot: PropSlot;
  readonly seed: number;
  /** Explosions due, crushes due, solid fallers landing, repairs due —
   * each kept sorted by (t, id). */
  blasts: PropEvent[];
  crushes: PropEvent[];
  landings: PropEvent[];
  repairs: PropEvent[];
  /** Bridge spans whose repair is announced, prop id → go time. */
  readonly spanGo: Map<number, number>;
  readonly craters: Crater[];
  nextCraterId: number;
  /** Chunks lit since their building last rebuilt (the welcome's soot). */
  readonly soot: Set<number>;
  /** What this tick produced, drained by tickProps' caller. */
  out: PropsTick;
}

/** D9: what the props did in one tick, in broadcast order. */
export interface PropsTick {
  down: PropDown[];
  blasts: PropDown[];
  restored: number[];
  announced: PropDown[];
  craters: Crater[];
  cratersGone: number[];
  /** Crane site ids condemned this tick (the director fells them). */
  condemned: number[];
  /** Chunks the props' blasts broke (they also ride `broke`); the caller
   * lights fires from them. */
  broke: number[];
}

const emptyPropsTick = (): PropsTick => ({
  down: [],
  blasts: [],
  restored: [],
  announced: [],
  craters: [],
  cratersGone: [],
  condemned: [],
  broke: [],
});

/** A layout with no props (a room built without a seed — the older tests). */
const NO_PROPS: PropLayout = {
  props: [],
  buckets: Array.from({ length: 100 }, () => []),
  first: [],
  roofOf: new Map(),
  roofProp: new Map(),
  spanLamps: [],
  bridges: [],
  cranes: new Map(),
};

/** Layouts are pure in (seed, generated city, movers): one per seed. */
const layoutCache = new Map<number, PropLayout>();

function createPropRoom(
  buildings: readonly Building[],
  copy: readonly Building[],
  cranes: readonly CraneSite[],
  seed: number | undefined,
  trains: readonly TrainLine[],
  given?: PropLayout,
): PropRoom {
  let layout = given ?? NO_PROPS;
  if (!given && seed !== undefined) {
    layout =
      layoutCache.get(seed) ??
      generateProps(seed, buildings, { cranes, trains });
    layoutCache.set(seed, layout);
  }
  return {
    layout,
    slot: propSlot(layout, copy),
    seed: seed ?? 0,
    blasts: [],
    crushes: [],
    landings: [],
    repairs: [],
    spanGo: new Map(),
    craters: [],
    nextCraterId: 1,
    soot: new Set(),
    out: emptyPropsTick(),
  };
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
  /** D9: the room's seed — its props are generated from it (with the
   * train lines, which they stay clear of). Omitted: a room with no props. */
  seed?: number,
  trains: readonly TrainLine[] = [],
  /** Tests: these props instead of the seed's. */
  layout?: PropLayout,
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
    props: createPropRoom(buildings, copy, cranes, seed, trains, layout),
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
  const props = city.props;
  props.slot.state.reset([]);
  props.blasts = [];
  props.crushes = [];
  props.landings = [];
  props.repairs = [];
  props.spanGo.clear();
  props.craters.length = 0;
  props.soot.clear();
  props.out = emptyPropsTick();
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
  // D9: a prop (a car, a lamp, a span…) in front of the wall takes it.
  const props = city.props;
  const prop = raycastProps(
    props.slot,
    origin,
    dir,
    hit ? hit.t : BULLET_RANGE,
  );
  if (prop) {
    props.slot.state.damage(prop.id, BULLET_DAMAGE, 0, by);
    return -1;
  }
  if (!hit) return -1;
  if (hit.roof >= 0) {
    // A roof tank, billboard or mast: its prop takes the round.
    const id = props.layout.roofProp.get(roofKey(hit.building, hit.roof));
    if (id !== undefined) props.slot.state.damage(id, BULLET_DAMAGE, 0, by);
  }
  if (hit.chunk < 0) return -1;
  if (city.damage.damageChunk(hit.chunk, BULLET_DAMAGE)) {
    city.breakers.set(hit.building, by);
  }
  return hit.chunk;
}

/**
 * D9: a blast at `pos` (radius `r`, `amount` at the centre, falling off
 * linearly) reaches the room's props: each standing prop in reach takes its
 * share (`depth` = the chain link it is, `by` = whom a fall credits), and a
 * blast low over a roadway leaves a crater. Every blast path calls this
 * beside its own damageAt.
 */
export function blastProps(
  city: RoomCity,
  pos: Vec3,
  r: number,
  amount: number,
  by: string | null = null,
  depth = 0,
  now?: number,
): void {
  const props = city.props;
  const state = props.slot.state;
  if (depth <= PROP_CHAIN_DEPTH_MAX) {
    propsNear(props.layout, pos.x, pos.z, r, (id) => {
      if (state.isDown(id)) return;
      const p = props.layout.props[id];
      if (!p) return;
      const d = propDistance(p, pos);
      if (d >= r) return;
      state.damage(id, amount * (1 - d / r), depth, by);
    });
  }
  const cr = props.layout.props.length > 0 ? craterRadius(pos, r) : 0;
  if (cr > 0) addCrater(props, pos, cr, now ?? lastTick);
}

/** The latest tick's clock — a blast outside a tick (a death) stamps its
 * crater with it. */
let lastTick = 0;

function addCrater(props: PropRoom, pos: Vec3, r: number, t: number): void {
  for (const c of props.craters) {
    const dx = wrapDeltaAxis(c.x, pos.x);
    const dz = wrapDeltaAxis(c.z, pos.z);
    if (Math.hypot(dx, dz) < CRATER_MERGE_M) return;
  }
  while (props.craters.length >= CRATERS_MAX) {
    const gone = props.craters.shift() as Crater;
    props.out.cratersGone.push(gone.id);
  }
  const id = props.nextCraterId++;
  const c: Crater = {
    id,
    x: Math.round(pos.x * 10) / 10,
    z: Math.round(pos.z * 10) / 10,
    r,
    t: Math.round(t),
    water: craterWater(props.seed, pos.x, pos.z),
  };
  props.craters.push(c);
  props.out.craters.push(c);
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
  blastProps(city, pos, DEATH_BLAST_RADIUS, DEATH_BLAST_DAMAGE, by);
  return out;
}

/** What one tick of destruction produced, in broadcast order. */
export interface DestructionTick {
  /** Chunks broken since the last tick (the `chunks` batch). */
  broke: number[];
  /** Collapse events started this tick. */
  collapses: CollapseWire[];
  /** D9: what the props did this tick. */
  props: PropsTick;
}

/**
 * One tick: take what broke, then plan the collapses of every building it
 * touched (and any carried over). Each event's chunks are marked fallen and
 * the event added to the room's field at server time `now`. At most
 * COLLAPSE_TICK_LIMIT events start per tick; none once COLLAPSE_CAP of the
 * room's chunks are gone.
 */
export function tickDestruction(
  city: RoomCity,
  now: number,
  /** D9: the room's living planes (a bridge span is only rebuilt clear of
   * them). Omitted: nobody in the way. */
  planes: readonly { pos: Vec3; vel: Vec3 }[] = [],
): DestructionTick {
  landImpacts(city, now);
  tickProps(city, now, planes);
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
  const props = city.props.out;
  city.props.out = emptyPropsTick();
  return { broke, collapses, props };
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
  // D9: what its pieces come to rest on is crushed as each one lands.
  if (
    c &&
    depth + 1 <= PROP_CHAIN_DEPTH_MAX &&
    city.props.layout.props.length > 0
  ) {
    for (const k of collapseCrushes(c, city.props.layout)) {
      queue(city.props.crushes, {
        t: k.t,
        id: k.id,
        depth: depth + 1,
        by,
        downAt: Number.NaN,
      });
    }
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
    blastProps(
      city,
      i,
      CHAIN_BLAST_RADIUS,
      CHAIN_BLAST_DAMAGE,
      i.by,
      i.depth + 1,
      now,
    );
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
  // D9: its roof props and jumbotron come back with it (clients do the same
  // on the `rebuild`), and its soot goes.
  city.props.slot.state.restoreBuilding(index);
  for (const id of [...city.props.soot]) {
    if (chunkBuilding(id) === index) city.props.soot.delete(id);
  }
  return restored;
}

/** D5 rebuild: the crane at site `id` stands again. */
export function rebuildCrane(city: RoomCity, id: number): void {
  forgetRecords(city, city.collapses.removeCrane(id));
  const prop = city.props.layout.cranes.get(id);
  if (prop !== undefined) city.props.slot.state.restore(prop);
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

// --- D9 props ------------------------------------------------------------------

/** Insert `e` keeping the queue sorted by (t, id). */
function queue(list: PropEvent[], e: PropEvent): void {
  let i = list.length;
  while (i > 0) {
    const o = list[i - 1] as PropEvent;
    if (o.t < e.t || (o.t === e.t && o.id <= e.id)) break;
    i--;
  }
  list.splice(i, 0, e);
}

/** Is the queued event still about the down it was queued for? */
const live = (city: RoomCity, e: PropEvent): boolean =>
  city.props.slot.state.isDown(e.id) &&
  (Number.isNaN(e.downAt) || city.props.slot.state.downAt(e.id) === e.downAt);

/**
 * D9: one tick of the props, inside tickDestruction (after landImpacts,
 * before the tick's chunk batch is taken). Fixed order, ascending (t, id)
 * within each step:
 *  1. land due blasts (at most PROP_BLASTS_PER_TICK; the rest wait);
 *  2. land due crushes;
 *  3. stamp this tick's downs (explosives queue a blast, fallers a landing,
 *     cranes are condemned, street props a repair, roof props start their
 *     building's D5 rebuild timer, a span knocks its lamps down);
 *  4. land due faller landings;
 *  5. repairs (street props and craters; span repairs announced, then gone
 *     ahead only if still clear).
 */
export function tickProps(
  city: RoomCity,
  now: number,
  planes: readonly { pos: Vec3; vel: Vec3 }[] = [],
): void {
  lastTick = now;
  const props = city.props;
  if (props.layout.props.length === 0) return;
  const state = props.slot.state;
  state.hold = city.damage.hold;
  const out = props.out;

  // 1. Blasts.
  let landed = 0;
  while (props.blasts.length > 0 && landed < PROP_BLASTS_PER_TICK) {
    const e = props.blasts[0] as PropEvent;
    if (e.t > now) break;
    props.blasts.shift();
    if (!live(city, e)) continue;
    const p = props.layout.props[e.id];
    const blast = p && PROP_BLAST[p.kind];
    if (!p || !blast) continue;
    landed++;
    const at = { x: p.x, y: p.y, z: p.z };
    const broke = city.damage.damageAt(at, blast[0], blast[1]);
    noteBroken(city, broke, e.by, e.depth);
    out.broke.push(...broke);
    blastProps(city, at, blast[0], blast[1], e.by, e.depth + 1, now);
    state.blasted(e.id, now);
    out.blasts.push({ id: e.id, t: now });
  }

  // 2. Crushes.
  while (props.crushes.length > 0 && (props.crushes[0] as PropEvent).t <= now) {
    const e = props.crushes.shift() as PropEvent;
    state.knockDown(e.id, e.depth, e.by);
  }

  // 3. Stamp the downs.
  for (const d of state.take(now)) {
    out.down.push(d);
    const p = props.layout.props[d.id];
    if (!p) continue;
    const e = (t: number): PropEvent => ({
      t,
      id: d.id,
      depth: state.depthOf(d.id),
      by: state.byOf(d.id),
      downAt: now,
    });
    if (isExplosive(p.kind)) queue(props.blasts, e(now + propFuseMs(d.id)));
    if (isFaller(p.kind)) {
      queue(props.landings, e(now + fallSeconds(p) * 1000));
    }
    if (p.kind === PROP_CRANE) out.condemned.push(p.ref);
    if (p.kind === PROP_BRIDGE) {
      for (const lamp of props.layout.spanLamps[p.ref] ?? []) {
        state.knockDown(lamp, state.depthOf(d.id), state.byOf(d.id));
      }
      queue(props.repairs, e(now + SPAN_REPAIR_MS));
    } else if (isRoofProp(p.kind) || p.kind === PROP_JUMBO) {
      // The D5 rebuild brings it back with its building.
      if (!city.firstDamageAt.has(p.b)) city.firstDamageAt.set(p.b, now);
    } else if (p.kind !== PROP_CRANE) {
      queue(props.repairs, e(now + propRepairMs(d.id)));
    }
  }

  // 4. Faller landings: a D2 blast into the deck it lands on, and a crush
  // of what lies under it.
  while (
    props.landings.length > 0 &&
    (props.landings[0] as PropEvent).t <= now
  ) {
    const e = props.landings.shift() as PropEvent;
    if (!live(city, e)) continue;
    const p = props.layout.props[e.id];
    if (!p) continue;
    if (p.kind !== PROP_BRIDGE) {
      const at = fallerLanding(props.layout, e.id);
      const broke = city.damage.damageAt(
        at,
        LANDING_BLAST[0],
        LANDING_BLAST[1],
      );
      noteBroken(city, broke, e.by, e.depth);
      out.broke.push(...broke);
    }
    if (e.depth + 1 <= PROP_CHAIN_DEPTH_MAX) {
      for (const q of fallerCrushes(props.layout, e.id)) {
        state.knockDown(q, e.depth + 1, e.by);
      }
    }
  }

  // 5. Repairs.
  while (props.repairs.length > 0 && (props.repairs[0] as PropEvent).t <= now) {
    const e = props.repairs.shift() as PropEvent;
    if (!live(city, e)) continue;
    const p = props.layout.props[e.id];
    // A lamp on a fallen span waits for its deck.
    const deck = p && p.span >= 0 ? props.layout.bridges[p.span] : undefined;
    if (deck !== undefined && state.isDown(deck)) {
      queue(props.repairs, { ...e, t: now + 5000 });
      continue;
    }
    if (p?.kind === PROP_BRIDGE) {
      if (spanClear(props, e.id, planes, SPAN_REPAIR_LEAD_MS)) {
        props.spanGo.set(e.id, now + SPAN_REPAIR_LEAD_MS);
        out.announced.push({ id: e.id, t: now + SPAN_REPAIR_LEAD_MS });
      } else {
        queue(props.repairs, { ...e, t: now + 5000 });
      }
      continue;
    }
    state.restore(e.id);
    out.restored.push(e.id);
  }
  for (const [id, at] of [...props.spanGo]) {
    if (at > now) continue;
    props.spanGo.delete(id);
    if (!state.isDown(id)) continue;
    if (spanClear(props, id, planes, 0)) {
      state.restore(id);
      out.restored.push(id);
    } else {
      // Someone flew into it: call it off, try again later.
      queue(props.repairs, {
        t: now + 5000,
        id,
        depth: 0,
        by: null,
        downAt: state.downAt(id),
      });
    }
  }
  while (props.craters.length > 0) {
    const c = props.craters[0] as Crater;
    if (now < c.t + PROP_REPAIR_MS[1]) break;
    props.craters.shift();
    out.cratersGone.push(c.id);
  }
  out.restored.sort((a, b) => a - b);
}

/** Credit and chain link for chunks a prop event broke. */
function noteBroken(
  city: RoomCity,
  broke: readonly number[],
  by: string | null,
  depth: number,
): void {
  for (const id of broke) {
    const b = chunkBuilding(id);
    city.breakers.set(b, by);
    city.chainDepth.set(b, Math.max(city.chainDepth.get(b) ?? 0, depth + 1));
  }
}

/** Margin round a span that a plane must stay out of while it comes back. */
const SPAN_CLEAR_M = 12;

/** Is span `id`'s deck volume clear of every plane now and on its straight
 * path over the next `leadMs` (+ 0.5 s)? */
function spanClear(
  props: PropRoom,
  id: number,
  planes: readonly { pos: Vec3; vel: Vec3 }[],
  leadMs: number,
): boolean {
  const p = props.layout.props[id];
  if (!p) return true;
  const span = leadMs / 1000 + 0.5;
  for (const plane of planes) {
    for (let s = 0; s <= span + 1e-9; s += 0.25) {
      const x = wrapDeltaAxis(p.x, plane.pos.x + plane.vel.x * s);
      const z = wrapDeltaAxis(p.z, plane.pos.z + plane.vel.z * s);
      const y = plane.pos.y + plane.vel.y * s - p.y;
      if (
        Math.abs(x) <= p.hx + SPAN_CLEAR_M &&
        Math.abs(z) <= p.hz + SPAN_CLEAR_M &&
        Math.abs(y) <= p.hy + SPAN_CLEAR_M
      ) {
        return false;
      }
    }
  }
  return true;
}

/** D9: the room's props for the welcome. */
export function propsWireState(city: RoomCity): WirePropState {
  const state = city.props.slot.state;
  const d = encodeIdRecords(
    state.downIds().map((id) => {
      const te = state.blastAt(id);
      return [id, state.downAt(id), Number.isNaN(te) ? -1 : te];
    }),
    3,
  );
  return {
    d,
    c: city.props.craters.map(encodeCrater),
    s: encodeChunkIds([...city.props.soot]),
  };
}

/** D9: one tick's props as the `props` message's fields — null when nothing
 * happened. */
export function propsMessage(tick: PropsTick): {
  d?: number[];
  b?: number[];
  u?: number[];
  a?: number[];
  c?: WireCrater[];
  cu?: number[];
} | null {
  const msg: {
    d?: number[];
    b?: number[];
    u?: number[];
    a?: number[];
    c?: WireCrater[];
    cu?: number[];
  } = {};
  const pairs = (l: readonly PropDown[]) =>
    encodeIdRecords(
      l.map((x) => [x.id, x.t]),
      2,
    );
  if (tick.down.length > 0) msg.d = pairs(tick.down);
  if (tick.blasts.length > 0) msg.b = pairs(tick.blasts);
  if (tick.restored.length > 0) msg.u = encodeChunkIds(tick.restored);
  if (tick.announced.length > 0) msg.a = pairs(tick.announced);
  if (tick.craters.length > 0) msg.c = tick.craters.map(encodeCrater);
  if (tick.cratersGone.length > 0) msg.cu = encodeChunkIds(tick.cratersGone);
  return Object.keys(msg).length > 0 ? msg : null;
}

/**
 * D9 kill credit: if a FALLING prop (a tank, a jumbotron, a span) within
 * `radius` of `pos` at `t` is what a crash hit, the prop and who brought it
 * down; else null.
 */
export function propCulprit(
  city: RoomCity,
  pos: Vec3,
  radius: number,
  t: number,
): { id: number; by: string | null } | null {
  const hit = collideProps(pos, radius, city.props.slot, t, true);
  return hit ? { id: hit.id, by: city.props.slot.state.byOf(hit.id) } : null;
}
