// D5 destruction director, server side: WHAT the city does to the fight,
// WHERE and WHEN — and how it heals. One DestructionDirector per room;
// index.ts and the bot-sim harness both drive exactly this.
//
// The event, per slot (common/src/director.ts directorSlotsInWindow — a
// pure function of (seed, server time), 2–4 min apart — C2's slotScale of
// 1/12 makes that 10–20 s, constant chaos):
//
//   slot → ARMED (a pick is tried every retryMs for slotPatienceMs)
//        → WARNED (`directorWarn` broadcast; it happens DIRECTOR_WARN_MS on)
//        → FIRED at `at` — or CANCELLED (implicitly: no event follows) when a
//          freshly spawned plane is inside its danger zone by then.
//
// The pick: only around a fight a human is in (an anchor is a human, or a
// bot within DIRECTOR_ACTION_M of one); targets within DIRECTOR_ACTION_M of
// an anchor; a tower with a plane within DIRECTOR_NEAR_M is PREFERRED and
// topples across that plane's projected DIRECTOR_PATH_S path (scored on the
// candidate's REAL debris, buildCollapse); worn towers (X1 strikes, gunfire)
// are preferred too. Never with a fresh (spawn-protected or just-respawned)
// plane or a plane on its post-event cooldown inside the zone; never on a
// building whose rebuild is about to come; never once the room's destroyed
// share reaches stopShare (director demolitions skip DESTROY_CAP and
// COLLAPSE_CAP, so this is their bound).
//
// The rebuild, per damaged building (and felled crane):
//
//   damaged (firstDamageAt) → due at firstDamageAt + a seeded 3–5 min, and
//   ≥ rebuildAfterCollapseMs after its last collapse → DEFERRED while its
//   debris still falls, a warning or a queued chain impact targets it, or a
//   plane's projected path enters its volume → ANNOUNCED (`rebuild` go:false,
//   cosmetic, at = now + rebuildLeadMs) → APPLIED at the first check ≥ `at`
//   that still passes (`rebuild` go:true, applied by clients on arrival).

import {
  type Building,
  chunkBuilding,
  mulberry32,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  type CollapsePlan,
  type CollapseWire,
  KIND_CRANE,
  PANCAKE,
  TOPPLE,
  buildCollapse,
  buildCraneCollapse,
  collapseWire,
  craneAlignAfter,
  craneDown,
  craneFallDir,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import { type CraneSite, slewAngle } from "@angels-bandits/common/city/movers";
import { underCover } from "@angels-bandits/common/city/tunnels";
import {
  DIRECTOR_ACTION_M,
  DIRECTOR_DIRS,
  DIRECTOR_NEAR_M,
  DIRECTOR_PATH_S,
  DIRECTOR_WARN_MS,
  type DangerZone,
  type DirectorEvent,
  EVENT_COLLAPSE,
  EVENT_CRANE,
  EVENT_GAS,
  GAS_BLAST_M,
  GAS_CHUNK_DAMAGE,
  GAS_CHUNK_RADIUS,
  GAS_CHUNK_Y,
  GAS_COLUMN_H,
  type RebuildWire,
  decodeDirectorEvent,
  directorSlotsInWindow,
  encodeDirectorEvent,
  fallFootprint,
  gasDamage,
  gasDistance,
  gasMainNear,
  inDangerZone,
  pathCrossing,
} from "@angels-bandits/common/director";
import {
  type Vec3,
  wrapDeltaAxis,
  wrapDistance,
} from "@angels-bandits/common/world";
import type { DangerBudget, DangerPlane } from "./danger";
import {
  type RoomCity,
  rebuildBuilding,
  rebuildCrane,
  stageCollapse,
  stageCraneFall,
} from "./destruction";

export interface DestructionTuning {
  /** Slot times are directorSlotsInWindow's, scaled by this (QA: < 1). */
  slotScale: number;
  /** An armed slot retries its pick this often, for this long, ms. */
  retryMs: number;
  slotPatienceMs: number;
  /** Kind roll: a crane this often, a gas main this often, else a tower. */
  craneShare: number;
  gasShare: number;
  /** Planes inside a fired event's zone + cooldownMarginM sit out the next
   * events for cooldownMs. */
  cooldownMs: number;
  cooldownMarginM: number;
  /** A plane respawned within this is fresh (besides spawn protection). */
  freshMs: number;
  /** Fresh planes this close to a zone call an event off, m. */
  freshMarginM: number;
  /** No new warning at or above this destroyed share of the room's city. */
  stopShare: number;
  /** A tower is at least this tall, m. */
  towerMinM: number;
  /** Rebuild: seeded delay after first damage, ms. */
  rebuildMinMs: number;
  rebuildMaxMs: number;
  /** ...and never sooner than this after the building's last collapse, ms. */
  rebuildAfterCollapseMs: number;
  /** Debris must have rested this long, ms. */
  rebuildSettleMs: number;
  /** The announce leads the apply by this, ms. */
  rebuildLeadMs: number;
  /** A plane's projected path this close to the volume defers it, m. */
  rebuildMarginM: number;
  rebuildCheckMs: number;
  /** No warning on a building whose rebuild is due within this, ms. */
  rebuildQuietMs: number;
}

/** C2 constant chaos: a staged collapse, gas main or crane near the action
 * every 10–20 s (the slots of directorSlotsInWindow, scaled by 1/12), a
 * short cooldown so it keeps happening around the same fight, and a rebuild
 * fast enough to keep up: 20–40 s after the first damage, 15 s after the
 * building's last collapse. */
export const DESTRUCTION_TUNING: DestructionTuning = {
  slotScale: 1 / 12,
  retryMs: 1000,
  slotPatienceMs: 8000,
  craneShare: 0.2,
  gasShare: 0.3,
  cooldownMs: 12_000,
  cooldownMarginM: 50,
  freshMs: 5000,
  freshMarginM: 30,
  stopShare: 0.18,
  towerMinM: 60,
  rebuildMinMs: 20_000,
  rebuildMaxMs: 40_000,
  rebuildAfterCollapseMs: 15_000,
  rebuildSettleMs: 10_000,
  rebuildLeadMs: 2000,
  rebuildMarginM: 25,
  rebuildCheckMs: 1000,
  rebuildQuietMs: 8000,
};

/** D5 as it shipped, before C2 (AB_CHAOS=0 restores it): an event every
 * 2–4 min, rebuilds 3–5 min after the damage. */
export const D5_TUNING: DestructionTuning = {
  slotScale: 1,
  retryMs: 1000,
  slotPatienceMs: 60_000,
  craneShare: 0.2,
  gasShare: 0.3,
  cooldownMs: 30_000,
  cooldownMarginM: 50,
  freshMs: 3000,
  freshMarginM: 30,
  stopShare: 0.1,
  towerMinM: 60,
  rebuildMinMs: 180_000,
  rebuildMaxMs: 300_000,
  rebuildAfterCollapseMs: 60_000,
  rebuildSettleMs: 10_000,
  rebuildLeadMs: 2000,
  rebuildMarginM: 25,
  rebuildCheckMs: 1000,
  rebuildQuietMs: 30_000,
};

/** AB_DIRECTOR_FAST=1 (tests and QA only): an event every ~5–10 s and a
 * rebuild ~10–15 s after the damage. */
export const DESTRUCTION_FAST: DestructionTuning = {
  ...DESTRUCTION_TUNING,
  slotScale: 1 / 24,
  slotPatienceMs: 4000,
  cooldownMs: 6000,
  rebuildMinMs: 10_000,
  rebuildMaxMs: 15_000,
  rebuildAfterCollapseMs: 8000,
};

/** One plane as the director sees it this tick (the caller leaves out
 * pending, away and dead planes). */
export interface DestructionPlane {
  id: string;
  pos: Vec3;
  /** m/s. */
  vel: Vec3;
  human: boolean;
  /** Spawn-protected right now (Combat.isProtected). */
  protected: boolean;
  /** How old the on-record pose is, ms (humans; 0 for bots). */
  ageMs: number;
}

/** What the director reads besides the planes. */
export interface DestructionWorld {
  city: RoomCity;
  /** The room's crane sites (its movers). */
  cranes: readonly CraneSite[];
  /** C2: the room's danger budget (absent: none — D5 as it shipped). A
   * warning is staged only when it allows the event's zone, and charges it. */
  budget?: DangerBudget;
}

/** A fired event and what it did to the city. */
export interface FiredEvent {
  event: DirectorEvent;
  /** A demolition's or a crane fall's collapse record (already in the
   * room's field — broadcast it). */
  collapse: CollapseWire | null;
  /** A gas main: the chunks it broke (already pending in the damage — the
   * tick's `chunks` batch carries them). */
  broke: number[];
}

export interface DirectorTick {
  warned: DirectorEvent[];
  fired: FiredEvent[];
  cancelled: DirectorEvent[];
}

/** Chunks' worth of damage that makes a tower fully "softened" (an X1
 * strike breaks ~2–4 and chips more). */
const SOFT_CHUNKS = 4;

/** Plan-view gap from `p` to building `b`'s footprint, m. */
function gapTo(b: Building, p: Vec3): number {
  return Math.hypot(
    Math.max(Math.abs(wrapDeltaAxis(b.x, p.x)) - b.width / 2, 0),
    Math.max(Math.abs(wrapDeltaAxis(b.z, p.z)) - b.depth / 2, 0),
  );
}

/** A Collapse's swept plan-view bounds grown by `m`, as a danger zone. */
function zoneOf(c: Collapse, m: number): DangerZone {
  return {
    x0: c.bounds.x0 - m,
    x1: c.bounds.x1 + m,
    z0: c.bounds.z0 - m,
    z1: c.bounds.z1 + m,
    top: c.bounds.y1 + m,
  };
}

/** Seeded rebuild delay for (kind, id, first damage time), ms. */
function rebuildDelay(
  seed: number,
  kind: number,
  id: number,
  first: number,
  t: DestructionTuning,
): number {
  const r = mulberry32(
    (seed ^
      0x7eb1d ^
      Math.imul(kind + 1, 0x85ebca6b) ^
      Math.imul(id + 1, 0x9e3779b1) ^
      Math.imul(Math.floor(first / 1000), 0xc2b2ae35)) >>>
      0,
  )();
  return t.rebuildMinMs + (t.rebuildMaxMs - t.rebuildMinMs) * r;
}

/** Gas victims: every plane within GAS_BLAST_M of the column (by `pos` —
 * the caller extrapolates on-record poses to the fire instant) that is not
 * fresh. */
export function gasVictims(
  e: DirectorEvent,
  planes: readonly { id: string; pos: Vec3; fresh: boolean }[],
): { id: string; damage: number }[] {
  const out: { id: string; damage: number }[] = [];
  for (const p of planes) {
    if (p.fresh) continue;
    const damage = gasDamage(gasDistance(e, p.pos));
    if (damage > 0) out.push({ id: p.id, damage });
  }
  return out;
}

/** A warned event's zone as budget sample points: its centre and the four
 * corners of its plan-view rect at half its top (a topple's strip is long). */
function zonePoints(e: Pick<DirectorEvent, "x" | "z" | "zone">): Vec3[] {
  const y = e.zone.top / 2;
  const at = (dx: number, dz: number): Vec3 => ({
    x: e.x + dx,
    y,
    z: e.z + dz,
  });
  return [
    at((e.zone.x0 + e.zone.x1) / 2, (e.zone.z0 + e.zone.z1) / 2),
    at(e.zone.x0, e.zone.z0),
    at(e.zone.x0, e.zone.z1),
    at(e.zone.x1, e.zone.z0),
    at(e.zone.x1, e.zone.z1),
  ];
}

const budgetPlanes = (planes: readonly DestructionPlane[]): DangerPlane[] =>
  planes.map((p) => ({ id: p.id, pos: p.pos, vel: p.vel, prot: p.protected }));

/** What the tower pick needs of one candidate collapse: its danger zone and
 * (a topple's) fall footprint. */
interface CollapseShape {
  zone: DangerZone;
  fp: DangerZone | null;
}

/** A1: shapes kept at most; past it the oldest goes first. */
const SHAPE_CACHE_MAX = 256;
/** Towers the pick simulates (and the prefill warms), best scored first. */
const PICK_CANDIDATES = 4;
/** A1: how often the prefill re-scores the towers, ms. */
const PREFILL_RESCAN_MS = 500;

/** A tower the pick weighs: its index, score and the plane it aims at. */
interface ScoredTower {
  i: number;
  score: number;
  near: DestructionPlane | null;
}

interface PrefillItem {
  i: number;
  plan: CollapsePlan;
}

export class DestructionDirector {
  private scanFrom: number | null = null;
  private armed: { slot: number; until: number } | null = null;
  private nextTry = 0;
  private warned: DirectorEvent[] = [];
  private readonly cooldown = new Map<string, number>();
  private readonly spawns = new Map<string, number>();
  /** Announced rebuilds: key (kind · 1e6 + id) → apply time. */
  private readonly announced = new Map<number, RebuildWire>();
  private nextRebuildCheck = 0;
  private nextId = 1;
  /**
   * A1: candidate collapse shapes by (building, style, dir, chunk set).
   * buildCollapse is a pure function of its wire and the generated city,
   * and simulating a tower's debris is the costliest thing a tick does
   * (~10–60 ms each, up to 20 per pick); a pick re-scores the same few
   * towers every retry, so each shape is simulated once per standing state.
   */
  private readonly shapes = new Map<string, CollapseShape | null>();
  private readonly prefillQueue: PrefillItem[] = [];
  private nextPrefillScan = 0;

  constructor(
    private readonly seed: number,
    private readonly rand: () => number,
    private readonly tuning: DestructionTuning = DESTRUCTION_TUNING,
  ) {}

  /** Warned events still to happen, oldest first (the welcome's replay and
   * the bots' no-fly zones). */
  pending(): readonly DirectorEvent[] {
    return this.warned;
  }

  /** Rebuilds announced and not yet applied. */
  announcedRebuilds(): RebuildWire[] {
    return [...this.announced.values()];
  }

  /** A plane (re)spawned at `now`: fresh for freshMs. */
  noteSpawn(id: string, now: number): void {
    this.spawns.set(id, now);
  }

  /** A plane left the room. */
  forget(id: string): void {
    this.spawns.delete(id);
    this.cooldown.delete(id);
  }

  /** The room's city went back to whole (its last human left). */
  reset(): void {
    this.scanFrom = null;
    this.armed = null;
    this.warned = [];
    this.cooldown.clear();
    this.spawns.clear();
    this.announced.clear();
  }

  private fresh(p: DestructionPlane, now: number): boolean {
    const at = this.spawns.get(p.id);
    return p.protected || (at !== undefined && now - at < this.tuning.freshMs);
  }

  /**
   * One tick: fire what is due, then (inside a slot's patience) try to warn
   * the next event. `planes` are the living planes in the air.
   */
  tick(
    now: number,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ): DirectorTick {
    const t = this.tuning;
    const out: DirectorTick = { warned: [], fired: [], cancelled: [] };
    for (const [id, until] of this.cooldown) {
      if (now >= until) this.cooldown.delete(id);
    }
    for (const [id, at] of this.spawns) {
      if (now - at >= t.freshMs) this.spawns.delete(id);
    }

    // Fire (or call off) what is due.
    const due = this.warned.filter((e) => e.at <= now);
    if (due.length > 0) {
      this.warned = this.warned.filter((e) => e.at > now);
      for (const e of due) {
        const blocked = planes.some(
          (p) => this.fresh(p, now) && inDangerZone(e, p.pos, t.freshMarginM),
        );
        const fired = blocked ? null : this.fire(e, world);
        if (!fired) {
          out.cancelled.push(e);
          continue;
        }
        out.fired.push(fired);
        for (const p of planes) {
          if (inDangerZone(e, p.pos, t.cooldownMarginM)) {
            this.cooldown.set(p.id, now + t.cooldownMs);
          }
        }
      }
    }

    // Arm the latest slot that came round.
    if (this.scanFrom === null) this.scanFrom = now;
    const s = t.slotScale;
    const slots = directorSlotsInWindow(this.seed, this.scanFrom / s, now / s);
    this.scanFrom = now;
    const last = slots[slots.length - 1];
    if (last !== undefined) {
      this.armed = { slot: last * s, until: last * s + t.slotPatienceMs };
      this.nextTry = 0;
    }
    const picking = this.armed !== null && now >= this.nextTry;
    if (this.armed && now >= this.nextTry) {
      if (now > this.armed.until) {
        this.armed = null;
      } else {
        let e =
          this.goneShare(world) < t.stopShare
            ? this.pick(now, planes, world)
            : null;
        // C2: the danger budget has the last word on a lethal event near a
        // plane — its whole zone, landing at `at`.
        if (e && world.budget) {
          const pts = zonePoints(e);
          const bp = budgetPlanes(planes);
          if (world.budget.allows("director", pts, e.at - now, now, bp)) {
            world.budget.charge("director", pts, e.at - now, now, bp);
          } else {
            e = null;
          }
        }
        if (e) {
          this.warned.push(e);
          out.warned.push(e);
          this.armed = null;
        } else {
          this.nextTry = now + t.retryMs;
        }
      }
    }
    // A1: an idle tick warms the next pick's debris (see prefill).
    if (!picking && this.goneShare(world) < t.stopShare) {
      this.prefill(now, planes, world);
    }
    return out;
  }

  /** (destroyed + fallen) / chunks of the room's city. */
  private goneShare(world: DestructionWorld): number {
    const d = world.city.damage;
    return (d.destroyedCount + d.fallenCount) / Math.max(1, d.chunkCount);
  }

  private fire(e: DirectorEvent, world: DestructionWorld): FiredEvent | null {
    const city = world.city;
    if (e.k === EVENT_COLLAPSE) {
      const b = city.buildings[e.b];
      const plan =
        b && demolitionPlan(b, e.b, e.s === TOPPLE ? TOPPLE : PANCAKE, e.d);
      if (!plan) return null;
      return {
        event: e,
        collapse: stageCollapse(city, plan, e.b, e.at, null),
        broke: [],
      };
    }
    if (e.k === EVENT_CRANE) {
      const site = world.cranes.find((c) => c.id === e.b);
      if (!site || craneDown(city.collapses, site.id, e.at)) return null;
      return {
        event: e,
        collapse: stageCraneFall(city, site, e.at),
        broke: [],
      };
    }
    const broke = city.damage.damageAt(
      { x: e.x, y: GAS_CHUNK_Y, z: e.z },
      GAS_CHUNK_RADIUS,
      GAS_CHUNK_DAMAGE,
    );
    // A collapse a gas main sets off is the environment's — nobody's.
    for (const id of broke) city.breakers.set(chunkBuilding(id), null);
    return { event: e, collapse: null, broke };
  }

  // --- The pick -------------------------------------------------------------

  /** The planes the action is around: humans, and planes near one. */
  private anchorsOf(
    now: number,
    planes: readonly DestructionPlane[],
  ): DestructionPlane[] {
    const humans = planes.filter((p) => p.human);
    return planes.filter(
      (p) =>
        !this.fresh(p, now) &&
        (p.human ||
          humans.some((h) => wrapDistance(h.pos, p.pos) <= DIRECTOR_ACTION_M)),
    );
  }

  /**
   * A1: warm the shape cache for the towers the next pick would weigh — the
   * top PICK_CANDIDATES as they score now, each way it could fall — at most
   * one debris simulation a call. A cold pick simulated up to 20 in ONE tick
   * (a 250–430 ms server stall under load); spread over the idle ticks
   * before it, the pick finds them cached. buildCollapse is pure, so what
   * the pick decides is exactly what it would have decided.
   */
  private prefill(
    now: number,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ): void {
    if (now >= this.nextPrefillScan) {
      this.nextPrefillScan = now + PREFILL_RESCAN_MS;
      this.prefillQueue.length = 0;
      const anchors = this.anchorsOf(now, planes);
      if (anchors.length === 0) return;
      const city = world.city;
      const top = this.scoreTowers(now, anchors, planes, world);
      for (const cand of top.slice(0, PICK_CANDIDATES)) {
        const b = city.buildings[cand.i] as Building;
        if (cand.near) {
          for (const dir of DIRECTOR_DIRS) {
            const plan = demolitionPlan(b, cand.i, TOPPLE, dir);
            if (plan) this.prefillQueue.push({ i: cand.i, plan });
          }
        }
        const plan = demolitionPlan(b, cand.i, PANCAKE, 0);
        if (plan) this.prefillQueue.push({ i: cand.i, plan });
      }
    }
    while (this.prefillQueue.length > 0) {
      const q = this.prefillQueue.shift() as PrefillItem;
      if (this.shapeOf(world.city.buildings, q.i, q.plan, true)) return;
    }
  }

  /** Pick and build the next event, or null when nothing fits right now. */
  pick(
    now: number,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ): DirectorEvent | null {
    const t = this.tuning;
    const anchors = this.anchorsOf(now, planes);
    if (anchors.length === 0) return null;
    // C2: a zone the danger budget refuses is blocked like a cooled-down
    // plane's, so the pick moves on to a tower clear of the planes whose
    // share is spent instead of losing the slot.
    const bp = world.budget ? budgetPlanes(planes) : null;
    const blocked = (x: number, z: number, zone: DangerZone): boolean =>
      planes.some(
        (p) =>
          (this.fresh(p, now) || this.cooldown.has(p.id)) &&
          inDangerZone({ x, z, zone }, p.pos, t.cooldownMarginM),
      ) ||
      (bp !== null &&
        !world.budget?.allows(
          "director",
          zonePoints({ x, z, zone }),
          DIRECTOR_WARN_MS,
          now,
          bp,
        ));
    const roll = this.rand();
    const order =
      roll < t.craneShare
        ? [EVENT_CRANE, EVENT_COLLAPSE, EVENT_GAS]
        : roll < t.craneShare + t.gasShare
          ? [EVENT_GAS, EVENT_COLLAPSE]
          : [EVENT_COLLAPSE, EVENT_GAS];
    for (const kind of order) {
      const e =
        kind === EVENT_COLLAPSE
          ? this.pickTower(now, anchors, planes, world, blocked)
          : kind === EVENT_GAS
            ? this.pickGas(now, anchors, planes, blocked)
            : this.pickCrane(now, anchors, world, blocked);
      if (e) return e;
    }
    return null;
  }

  private event(
    k: number,
    b: number,
    at: Vec3,
    s: number,
    d: number,
    now: number,
    fireAt: number,
    zone: DangerZone,
  ): DirectorEvent {
    // Through the wire codec, so the server holds exactly what clients do.
    return decodeDirectorEvent(
      encodeDirectorEvent({
        id: this.nextId++,
        k,
        b,
        x: at.x,
        y: at.y,
        z: at.z,
        s,
        d,
        w: now,
        at: fireAt,
        zone,
      }),
    ) as DirectorEvent;
  }

  /** Is building `i` due a rebuild within rebuildQuietMs of `now`? */
  private rebuildSoon(
    world: DestructionWorld,
    i: number,
    now: number,
  ): boolean {
    const first = world.city.firstDamageAt.get(i);
    if (first === undefined) return false;
    const due = first + rebuildDelay(this.seed, 0, i, first, this.tuning);
    return due - now < this.tuning.rebuildQuietMs + DIRECTOR_WARN_MS;
  }

  /** The shape of building `i` brought down as `plan` (null: no debris).
   * `built`: return whether this call simulated it instead (prefill). */
  private shapeOf(
    buildings: readonly Building[],
    i: number,
    plan: CollapsePlan,
  ): CollapseShape | null;
  private shapeOf(
    buildings: readonly Building[],
    i: number,
    plan: CollapsePlan,
    built: true,
  ): boolean;
  private shapeOf(
    buildings: readonly Building[],
    i: number,
    plan: CollapsePlan,
    built = false,
  ): CollapseShape | null | boolean {
    // Built at t = 0: the shape is the same at any start time, and a fixed
    // one keeps the cached value exactly what a fresh build would give.
    const wire = collapseWire(plan, i, 0, 0);
    const key = `${i}:${wire.s}:${wire.d}:${wire.c}`;
    const cached = this.shapes.get(key);
    if (cached !== undefined) return built ? false : cached;
    const b = buildings[i] as Building;
    const c = buildCollapse(buildings, wire);
    const shape = c && { zone: zoneOf(c, 10), fp: fallFootprint(c, b) };
    if (this.shapes.size >= SHAPE_CACHE_MAX) {
      const oldest = this.shapes.keys().next();
      if (!oldest.done) this.shapes.delete(oldest.value);
    }
    this.shapes.set(key, shape);
    return built ? true : shape;
  }

  /** Every tower near the action that could come down, near a plane first,
   * then by score — the pick's candidates, best first. */
  private scoreTowers(
    now: number,
    anchors: readonly DestructionPlane[],
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ): ScoredTower[] {
    const t = this.tuning;
    const city = world.city;
    const wear = city.damage.wear();
    const busy = new Set(
      this.warned.filter((e) => e.k === EVENT_COLLAPSE).map((e) => e.b),
    );
    const scored: ScoredTower[] = [];
    for (let i = 0; i < city.buildings.length; i++) {
      const b = city.buildings[i] as Building;
      if (b.height < t.towerMinM || busy.has(i)) continue;
      const g = tierGrids(b)[0];
      if (!g || g.ny < 3) continue;
      const worn = wear.get(i);
      if (worn && worn.share >= 0.5) continue; // already a wreck
      let action = Number.POSITIVE_INFINITY;
      for (const a of anchors) action = Math.min(action, gapTo(b, a.pos));
      if (action > DIRECTOR_ACTION_M) continue;
      if (this.rebuildSoon(world, i, now)) continue;
      // The plane the topple aims across: the nearest within NEAR (humans
      // count double).
      let near: DestructionPlane | null = null;
      let nearScore = Number.POSITIVE_INFINITY;
      for (const p of planes) {
        if (this.fresh(p, now)) continue;
        const gap = gapTo(b, p.pos);
        if (gap > DIRECTOR_NEAR_M) continue;
        const s = gap / (p.human ? 2 : 1);
        if (s < nearScore) {
          nearScore = s;
          near = p;
        }
      }
      // Softened: a missile strike (or a burst of gunfire) knocks out a few
      // chunks — SOFT_CHUNKS of them make a tower fully "softened".
      const soft = Math.min(1, (worn?.lost ?? 0) / SOFT_CHUNKS);
      const score =
        (near ? (near.human ? 8 : 4) : 1) +
        8 * soft +
        (1 - action / DIRECTOR_ACTION_M);
      scored.push({ i, score, near });
    }
    // Near a plane first, then by score.
    scored.sort(
      (a, b) =>
        Number(!!b.near) - Number(!!a.near) || b.score - a.score || a.i - b.i,
    );
    return scored;
  }

  private pickTower(
    now: number,
    anchors: readonly DestructionPlane[],
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
    blocked: (x: number, z: number, zone: DangerZone) => boolean,
  ): DirectorEvent | null {
    const city = world.city;
    const scored = this.scoreTowers(now, anchors, planes, world);
    // The real debris of the best few, each way it could fall.
    const options: {
      i: number;
      style: number;
      dir: number;
      zone: DangerZone;
      score: number;
      /** 2: a plane within NEAR and the topple crosses its path; 1: a
       * plane within NEAR; 0: near the action only. */
      rank: number;
    }[] = [];
    const warnAt = now + DIRECTOR_WARN_MS;
    for (const cand of scored.slice(0, PICK_CANDIDATES)) {
      const b = city.buildings[cand.i] as Building;
      let best: { shape: CollapseShape; dir: number; cross: number } | null =
        null;
      if (cand.near) {
        for (const dir of DIRECTOR_DIRS) {
          const plan = demolitionPlan(b, cand.i, TOPPLE, dir);
          if (!plan) continue;
          const shape = this.shapeOf(city.buildings, cand.i, plan);
          const fp = shape?.fp;
          if (!shape || !fp) continue;
          const cross = pathCrossing(
            fp,
            b.x,
            b.z,
            cand.near.pos,
            cand.near.vel,
            DIRECTOR_PATH_S,
          );
          if (cross > 0 && (!best || cross > best.cross)) {
            best = { shape, dir, cross };
          }
        }
      }
      let style = TOPPLE;
      let shape = best?.shape ?? null;
      let dir = best?.dir ?? 0;
      if (!shape) {
        const plan = demolitionPlan(b, cand.i, PANCAKE, 0);
        if (!plan) continue;
        shape = this.shapeOf(city.buildings, cand.i, plan);
        style = PANCAKE;
        dir = 0;
        if (!shape) continue;
      }
      const zone = shape.zone;
      if (blocked(b.x, b.z, zone)) continue;
      options.push({
        i: cand.i,
        style,
        dir,
        zone,
        score: cand.score,
        rank: best ? 2 : cand.near ? 1 : 0,
      });
    }
    if (options.length === 0) return null;
    // Only the best rank competes — a tower with a plane alongside whose
    // fall crosses its path beats any other — weighted by score² within it.
    let top = 0;
    for (const o of options) top = Math.max(top, o.rank);
    let total = 0;
    for (const o of options) if (o.rank === top) total += o.score * o.score;
    let r = this.rand() * total;
    let pick = options[0] as (typeof options)[number];
    for (const o of options) {
      if (o.rank !== top) continue;
      pick = o;
      r -= o.score * o.score;
      if (r <= 0) break;
    }
    const b = city.buildings[pick.i] as Building;
    return this.event(
      EVENT_COLLAPSE,
      pick.i,
      { x: b.x, y: 0, z: b.z },
      pick.style,
      pick.dir,
      now,
      warnAt,
      pick.zone,
    );
  }

  private pickGas(
    now: number,
    anchors: readonly DestructionPlane[],
    planes: readonly DestructionPlane[],
    blocked: (x: number, z: number, zone: DangerZone) => boolean,
  ): DirectorEvent | null {
    const lead = DIRECTOR_WARN_MS / 1000;
    // U4: never a plane under a tunnel's ceiling — the blast cannot reach it.
    const low = anchors
      .filter(
        (a) =>
          a.pos.y < GAS_COLUMN_H + GAS_BLAST_M &&
          !(a.pos.y < 0 && underCover(a.pos)),
      )
      .sort((a, b) => Number(b.human) - Number(a.human) || a.pos.y - b.pos.y);
    const zone: DangerZone = {
      x0: -GAS_BLAST_M - 10,
      x1: GAS_BLAST_M + 10,
      z0: -GAS_BLAST_M - 10,
      z1: GAS_BLAST_M + 10,
      top: GAS_COLUMN_H + GAS_BLAST_M,
    };
    for (const a of low) {
      const ahead = (s: number): Vec3 => ({
        x: a.pos.x + a.vel.x * s,
        y: Math.max(0, a.pos.y + a.vel.y * s),
        z: a.pos.z + a.vel.z * s,
      });
      const there = ahead(lead);
      for (const dt of [0, 0.4, -0.4, 0.8, -0.8, 1.2]) {
        const site = gasMainNear(this.seed, ahead(lead + dt));
        if (!site) continue;
        const d = gasDistance(site, there);
        if (d < 20 || d > 60) continue;
        // Never right on top of another plane either.
        if (
          planes.some((p) => {
            const at = {
              x: p.pos.x + p.vel.x * lead,
              y: p.pos.y + p.vel.y * lead,
              z: p.pos.z + p.vel.z * lead,
            };
            return gasDistance(site, at) < 20;
          })
        ) {
          continue;
        }
        if (blocked(site.x, site.z, zone)) continue;
        return this.event(
          EVENT_GAS,
          -1,
          { x: site.x, y: 0, z: site.z },
          0,
          0,
          now,
          now + DIRECTOR_WARN_MS,
          zone,
        );
      }
    }
    return null;
  }

  private pickCrane(
    now: number,
    anchors: readonly DestructionPlane[],
    world: DestructionWorld,
    blocked: (x: number, z: number, zone: DangerZone) => boolean,
  ): DirectorEvent | null {
    const field = world.city.collapses;
    for (const site of world.cranes) {
      if (craneDown(field, site.id, now)) continue;
      if (this.warned.some((e) => e.k === EVENT_CRANE && e.b === site.id)) {
        continue;
      }
      const near = anchors.some(
        (a) =>
          Math.hypot(
            wrapDeltaAxis(site.x, a.pos.x),
            wrapDeltaAxis(site.z, a.pos.z),
          ) <=
          DIRECTOR_NEAR_M + site.jibLength,
      );
      if (!near) continue;
      const at = craneAlignAfter(site, now + DIRECTOR_WARN_MS);
      if (at - now > DIRECTOR_WARN_MS + 20_000) continue;
      const c = buildCraneCollapse(site, {
        id: 0,
        b: site.id,
        t: at,
        s: TOPPLE,
        d: craneFallDir(site, at),
        c: [],
        k: KIND_CRANE,
      });
      if (!c) continue;
      const zone = zoneOf(c, 10);
      if (blocked(site.x, site.z, zone)) continue;
      return this.event(
        EVENT_CRANE,
        site.id,
        { x: site.x, y: 0, z: site.z },
        TOPPLE,
        c.dir,
        now,
        at,
        zone,
      );
    }
    return null;
  }

  // --- The rebuild ----------------------------------------------------------

  /** A1: does `rebuild(now, …)` do anything this tick? (It checks once per
   * rebuildCheckMs; the caller skips building its plane list otherwise.) */
  rebuildDue(now: number): boolean {
    return now >= this.nextRebuildCheck;
  }

  /**
   * The rebuild cycle for one tick: apply announced rebuilds that are due
   * (and still clear), then announce new ones. Returns the wires to
   * broadcast, in order. The caller runs this AFTER the tick's destruction
   * (tickDestruction), so nothing broken earlier in the tick is pending.
   */
  rebuild(
    now: number,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ): RebuildWire[] {
    const t = this.tuning;
    if (now < this.nextRebuildCheck) return [];
    this.nextRebuildCheck = now + t.rebuildCheckMs;
    const city = world.city;
    const out: RebuildWire[] = [];
    for (const [key, r] of [...this.announced]) {
      if (r.at > now || !this.clearToRebuild(r.k, r.b, now, planes, world)) {
        continue;
      }
      this.announced.delete(key);
      if (r.k === 0) rebuildBuilding(city, r.b);
      else rebuildCrane(city, r.b);
      out.push({ k: r.k, b: r.b, at: now, go: true });
    }
    const announce = (k: 0 | 1, b: number) => {
      const key = k * 1e6 + b;
      if (this.announced.has(key)) return;
      if (!this.clearToRebuild(k, b, now, planes, world)) return;
      const r: RebuildWire = { k, b, at: now + t.rebuildLeadMs, go: false };
      this.announced.set(key, r);
      out.push(r);
    };
    for (const [i, first] of city.firstDamageAt) {
      if (now < first + rebuildDelay(this.seed, 0, i, first, t)) continue;
      const last = city.lastStructuralAt.get(i);
      if (last !== undefined && now < last + t.rebuildAfterCollapseMs) continue;
      announce(0, i);
    }
    for (const [id, fell] of city.collapses.felled) {
      if (now < fell + rebuildDelay(this.seed, 1, id, fell, t)) continue;
      if (now < fell + t.rebuildAfterCollapseMs) continue;
      announce(1, id);
    }
    return out;
  }

  /** May target (k, b) be rebuilt right now? */
  private clearToRebuild(
    k: 0 | 1,
    b: number,
    now: number,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ): boolean {
    const t = this.tuning;
    const city = world.city;
    const kind = k === 0 ? 0 : KIND_CRANE;
    for (const c of city.collapses.list) {
      if (c.kind !== kind || c.building !== b) continue;
      if (now < c.t0 + c.endMs + t.rebuildSettleMs) return false;
    }
    const ek = k === 0 ? EVENT_COLLAPSE : EVENT_CRANE;
    if (this.warned.some((e) => e.k === ek && e.b === b)) return false;
    let cx: number;
    let cz: number;
    let hx: number;
    let hz: number;
    let top: number;
    if (k === 0) {
      if (city.impacts.some((i) => i.building === b)) return false;
      const bd = city.buildings[b];
      if (!bd) return false;
      cx = bd.x;
      cz = bd.z;
      hx = bd.width / 2;
      hz = bd.depth / 2;
      top = bd.height;
    } else {
      const site = world.cranes.find((c) => c.id === b);
      if (!site) return true; // nothing to stand back up
      cx = site.x;
      cz = site.z;
      hx = hz = Math.max(site.jibLength, site.counterLength) + 3;
      top = site.hubY + 3;
    }
    const m = t.rebuildMarginM;
    for (const p of planes) {
      const span = (p.ageMs + t.rebuildLeadMs) / 1000;
      for (let s = 0; s <= span + 1e-9; s += 0.25) {
        const x = wrapDeltaAxis(cx, p.pos.x + p.vel.x * s);
        const z = wrapDeltaAxis(cz, p.pos.z + p.vel.z * s);
        const y = p.pos.y + p.vel.y * s;
        if (Math.abs(x) <= hx + m && Math.abs(z) <= hz + m && y <= top + m) {
          return false;
        }
      }
    }
    return true;
  }
}
