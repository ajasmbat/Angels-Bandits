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
//
// C1 low-flying chaos, on top of all that (common/src/lowchaos.ts): while a
// human flies low among the towers (lowChaosLevel, with hysteresis) the
// low slots — 2–4 s apart — each try to stage ONE event near and ahead of
// that human, warned DIRECTOR_WARN_MS ahead like every director event: a
// tower toppled across or beside the path, a facade peeled into the
// street, a gas main beside the path, a roof tank or billboard sent over
// the edge, a bridge span dropped, a chain of cars and trucks set off.
// Fair: every plane keeps a way out (escapeFrom: straight on, a normal
// turn, a gentle climb), a lethal one near a plane is charged to the
// danger budget's `lowchaos` share, and no tower is felled near a human
// with LOW_FALLING_MAX collapses already coming down round them (the cap
// holds for the regular picks too). Low events neither set nor read the
// post-event cooldown (that paces D5's own cadence, which runs on as
// before). Towers come down from shapes already simulated (prefillLow,
// one at most every prefillMs), so a low pick never stalls a tick.
//
// And the city never runs out (the recycling rule): a ruin farther than
// recycleFarM from every human — out in the fog — is rebuilt as soon as it
// has settled, without waiting out its timer, so the destruction can go on
// round the players indefinitely under DESTROY_CAP and the stop shares.

import {
  type Building,
  chunkBuilding,
  mulberry32,
  standingProfile,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  type CollapsePlan,
  type CollapseWire,
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
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
import type { CraneSite } from "@angels-bandits/common/city/movers";
import {
  PROP_BILLBOARD,
  PROP_BRIDGE,
  PROP_CAR,
  PROP_FUEL,
  PROP_HP,
  PROP_TANK,
  PROP_TAXI,
  type Prop,
  fallSeconds,
  propsNear,
} from "@angels-bandits/common/city/props";
import { underCover } from "@angels-bandits/common/city/tunnels";
import {
  COLLAPSE_LEAD_MS,
  FOG_DISTANCE,
} from "@angels-bandits/common/constants";
import {
  DIRECTOR_ACTION_M,
  DIRECTOR_DIRS,
  DIRECTOR_NEAR_M,
  DIRECTOR_PATH_S,
  DIRECTOR_WARN_MS,
  type DangerZone,
  type DirectorEvent,
  EVENT_CARS,
  EVENT_COLLAPSE,
  EVENT_CRANE,
  EVENT_FACADE,
  EVENT_GAS,
  EVENT_ROOF,
  EVENT_SPAN,
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
  ESCAPE_STRAIGHT,
  LOW_FALLING_MAX,
  LOW_FALLING_R,
  escapeFrom,
  lowChaosLevel,
  lowSlotsInWindow,
} from "@angels-bandits/common/lowchaos";
import {
  type Vec3,
  canonicalize,
  wrapDeltaAxis,
  wrapDistance,
} from "@angels-bandits/common/world";
import type { DangerBudget, DangerPlane } from "./danger";
import {
  type RoomCity,
  blastProps,
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
  /** C1: the low-flying chaos (null: off — D5 as it shipped). */
  low: LowChaosTuning | null;
  /** C1 recycling: a ruin this far (plan-view gap) from every human is
   * rebuilt once settled and recycleAfterMs past its last collapse, its
   * timer or not, m (0: off). */
  recycleFarM: number;
  recycleAfterMs: number;
}

/** C1: the low-flying chaos's kinds, by the order the pick weighs them. */
export type LowKind = "topple" | "facade" | "gas" | "roof" | "span" | "cars";

export interface LowChaosTuning {
  /** An armed low slot retries its pick this often, for this long, ms. */
  retryMs: number;
  patienceMs: number;
  /** How often each kind is tried first (relative). */
  weights: Readonly<Record<LowKind, number>>;
  /** No low topple or facade at or above this gone share of the city (the
   * props kinds go on: PROP_DOWN_CAP and their repairs bound them). */
  stopShare: number;
  /** At most one low-topple debris simulation this often, ms. */
  prefillMs: number;
}

/** C1: an event every 2–4 s near a human flying low — a topple one time in
 * five, the rest the cheaper street-level kinds. */
export const LOW_CHAOS_TUNING: LowChaosTuning = {
  retryMs: 250,
  patienceMs: 1500,
  weights: { topple: 2, facade: 2, gas: 1.5, roof: 2, span: 1, cars: 2 },
  stopShare: 0.12,
  prefillMs: 500,
};

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
  low: LOW_CHAOS_TUNING,
  recycleFarM: FOG_DISTANCE,
  recycleAfterMs: 6000,
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
  low: null,
  recycleFarM: 0,
  recycleAfterMs: 0,
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

/** C1: where plane `p` is `s` seconds on, flying straight (not wrapped). */
const ahead = (p: DestructionPlane, s: number): Vec3 => ({
  x: p.pos.x + p.vel.x * s,
  y: Math.max(0, p.pos.y + p.vel.y * s),
  z: p.pos.z + p.vel.z * s,
});

/** Plan-view distance from (x, z) to `p`, m. */
const planGap = (x: number, z: number, p: Vec3): number =>
  Math.hypot(wrapDeltaAxis(x, p.x), wrapDeltaAxis(z, p.z));

/** C1 facade peel: the blast that takes a face's slabs and glass off (a
 * few chunks round the peel point, point-to-box), m and HP. */
export const FACADE_RADIUS = 7;
export const FACADE_DAMAGE = 160;
/** ...and the strip in front of the face its debris rains into, m: the
 * sidewalk (rubble lands within RUBBLE_REACH of the face) with margin — a
 * plane down the middle of the street (LOT_LINE from each face) is clear. */
const FACADE_REACH = 8;
/** C1: the vehicles a car chain starts from. */
const VEHICLES = [PROP_CAR, PROP_TAXI, PROP_FUEL] as const;
/** C1: the roof props that go over the edge. */
const ROOF_FALLERS = [PROP_TANK, PROP_BILLBOARD] as const;
/** C1: a low tower is one whose footprint lies within this of the path
 * ahead, m. */
const LOW_TOWER_REACH = 120;
/** C1: towers a low pick (and its prefill) weighs. */
const LOW_TOWERS = 2;

/** What the tower pick needs of one candidate collapse: its danger zone and
 * (a topple's) fall footprint. */
interface CollapseShape {
  zone: DangerZone;
  fp: DangerZone | null;
  /** C1: when its last piece comes to rest, ms after the event. */
  endMs: number;
}

/** A1: shapes kept at most; past it the oldest goes first. */
const SHAPE_CACHE_MAX = 256;
/** Towers the pick simulates (and the prefill warms), best scored first. */
const PICK_CANDIDATES = 4;
/** A1: how often the prefill re-scores the towers, ms. */
const PREFILL_RESCAN_MS = 500;
/** A1: the prefill starts this long before a slot arms, ms (≥ 20 ticks:
 * one simulation a tick covers a full pick's 4 towers × 5 shapes). */
const PREFILL_LEAD_MS = 2000;

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
  /** D9: crane sites shot to 0 HP, waiting to be warned (in order). */
  private condemned: number[] = [];
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
  /** Debris simulations run so far (the tick bench sorts ticks by it). */
  simulations = 0;
  /** C1: humans flying low, by id → lowChaosLevel. */
  private readonly low = new Map<string, number>();
  /** C1: the low events among the warned (no cooldown either way). */
  private readonly lowIds = new Set<number>();
  private lowScanFrom: number | null = null;
  /** C1: the armed low slot's patience runs out at this, ms. */
  private lowArmed: number | null = null;
  private lowNextTry = 0;
  private lowTurn = 0;
  private nextLowPrefill = 0;

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
    this.low.delete(id);
  }

  /** The room's city went back to whole (its last human left). */
  reset(): void {
    this.scanFrom = null;
    this.armed = null;
    this.warned = [];
    this.condemned = [];
    this.cooldown.clear();
    this.spawns.clear();
    this.announced.clear();
    this.low.clear();
    this.lowIds.clear();
    this.lowScanFrom = null;
    this.lowArmed = null;
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
          this.lowIds.delete(e.id);
          out.cancelled.push(e);
          continue;
        }
        out.fired.push(fired);
        if (this.lowIds.delete(e.id)) continue;
        for (const p of planes) {
          if (inDangerZone(e, p.pos, t.cooldownMarginM)) {
            this.cooldown.set(p.id, now + t.cooldownMs);
          }
        }
      }
    }

    // D9: shot cranes are warned before anything else is picked.
    this.warnCondemned(now, planes, world, out);

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
    // C1: and the low-flying chaos round every human in the canyons.
    this.tickLow(now, planes, world, out);
    // A1: an idle tick warms the next pick's debris (see prefill) — only
    // while a slot is armed or about to be (the schedule is a pure function
    // of seed and time), so towers broken between slots are not simulated
    // over and over for nothing.
    const soon =
      this.armed !== null ||
      directorSlotsInWindow(this.seed, now / s, (now + PREFILL_LEAD_MS) / s)
        .length > 0;
    if (!picking && soon && this.goneShare(world) < t.stopShare) {
      this.prefill(now, planes, world);
    }
    return out;
  }

  /** (destroyed + fallen) / chunks of the room's city (T1: its capBasis). */
  private goneShare(world: DestructionWorld): number {
    const d = world.city.damage;
    return (d.destroyedCount + d.fallenCount) / Math.max(1, d.capBasis);
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
    if (e.k === EVENT_FACADE) {
      // C1: the face's slabs and glass come off into the street (the D2
      // break of the chunks round the peel point — the `chunks` batch).
      const broke = city.damage.damageAt(e, FACADE_RADIUS, FACADE_DAMAGE);
      for (const id of broke) city.breakers.set(chunkBuilding(id), null);
      return { event: e, collapse: null, broke };
    }
    if (e.k === EVENT_ROOF || e.k === EVENT_SPAN || e.k === EVENT_CARS) {
      // C1: the prop goes down the D9 way — a roof faller over the edge, a
      // span into the river, the first vehicle's blast setting off the
      // rest (tickProps: fuses, chain links, crushes; the `props` batch).
      const state = city.props.slot.state;
      const p = city.props.layout.props[e.b];
      if (!p || state.isDown(e.b)) return null;
      state.damage(e.b, 10 * (PROP_HP[p.kind] ?? 100), 0, null);
      return { event: e, collapse: null, broke: [] };
    }
    const broke = city.damage.damageAt(
      { x: e.x, y: GAS_CHUNK_Y, z: e.z },
      GAS_CHUNK_RADIUS,
      GAS_CHUNK_DAMAGE,
    );
    // D9: and the street round it — cars, lamps, a crater.
    blastProps(
      city,
      { x: e.x, y: 1, z: e.z },
      GAS_CHUNK_RADIUS,
      GAS_CHUNK_DAMAGE,
    );
    // A collapse a gas main sets off is the environment's — nobody's.
    for (const id of broke) city.breakers.set(chunkBuilding(id), null);
    return { event: e, collapse: null, broke };
  }

  /**
   * D9: crane site `id` was shot (or blasted) to 0 HP. It does not fall on
   * the spot: like every lethal director event it is WARNED first — the
   * next tick turns it into an EVENT_CRANE at craneAlignAfter, at least
   * DIRECTOR_WARN_MS out, through the danger budget (retried each tick
   * while refused). It stays solid until it actually falls.
   */
  condemnCrane(id: number): void {
    if (!this.condemned.includes(id)) this.condemned.push(id);
  }

  /** D9: warn every condemned crane the budget allows now. */
  private warnCondemned(
    now: number,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
    out: DirectorTick,
  ): void {
    if (this.condemned.length === 0) return;
    const bp = world.budget ? budgetPlanes(planes) : null;
    const field = world.city.collapses;
    this.condemned = this.condemned.filter((id) => {
      const site = world.cranes.find((c) => c.id === id);
      if (!site || craneDown(field, id, now)) return false;
      if (this.warned.some((e) => e.k === EVENT_CRANE && e.b === id)) {
        return false;
      }
      const at = craneAlignAfter(site, now + DIRECTOR_WARN_MS);
      const c = buildCraneCollapse(site, {
        id: 0,
        b: id,
        t: at,
        s: TOPPLE,
        d: craneFallDir(site, at),
        c: [],
        k: KIND_CRANE,
      });
      if (!c) return false;
      const zone = zoneOf(c, 10);
      // C1: not while LOW_FALLING_MAX already come down round a human.
      if (this.fallingCapped(world, now, planes, site.x, site.z)) return true;
      const e = this.event(
        EVENT_CRANE,
        id,
        { x: site.x, y: 0, z: site.z },
        TOPPLE,
        c.dir,
        now,
        at,
        zone,
      );
      if (world.budget && bp) {
        const pts = zonePoints(e);
        if (!world.budget.allows("director", pts, e.at - now, now, bp)) {
          return true; // keep it; try again next tick
        }
        world.budget.charge("director", pts, e.at - now, now, bp);
      }
      this.warned.push(e);
      out.warned.push(e);
      return false;
    });
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
    this.simulations++;
    const shape = c && {
      zone: zoneOf(c, 10),
      fp: fallFootprint(c, b),
      endMs: c.endMs,
    };
    if (this.shapes.size >= SHAPE_CACHE_MAX) {
      const oldest = this.shapes.keys().next();
      if (!oldest.done) this.shapes.delete(oldest.value);
    }
    this.shapes.set(key, shape);
    return built ? true : shape;
  }

  /** C1: has building `i` brought down as `plan` been simulated already? */
  private shapeCached(i: number, plan: CollapsePlan): boolean {
    const wire = collapseWire(plan, i, 0, 0);
    return this.shapes.has(`${i}:${wire.s}:${wire.d}:${wire.c}`);
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
      if (this.fallingCapped(world, now, planes, b.x, b.z)) continue;
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
      if (this.fallingCapped(world, now, anchors, site.x, site.z)) continue;
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

  // --- C1: the low-flying chaos ---------------------------------------------

  /** C1: how deep in the canyons human `id` was at the last tick (0: not
   * low — lowChaosLevel). */
  lowLevel(id: string): number {
    return this.low.get(id) ?? 0;
  }

  /** C1: every human's low level, with hysteresis; the rest forgotten. */
  private updateLow(
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ) {
    for (const id of this.low.keys()) {
      if (!planes.some((p) => p.id === id && p.human)) this.low.delete(id);
    }
    for (const p of planes) {
      if (!p.human) continue;
      const level = lowChaosLevel(
        { pos: p.pos, wasLow: this.low.has(p.id) },
        world.city,
      );
      if (level > 0) this.low.set(p.id, level);
      else this.low.delete(p.id);
    }
  }

  /** C1: one tick of the low-flying chaos — arm the low slot that came
   * round while a human is low, try its pick, warm the next topple. */
  private tickLow(
    now: number,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
    out: DirectorTick,
  ): void {
    const lt = this.tuning.low;
    if (!lt) return;
    this.updateLow(planes, world);
    if (this.lowScanFrom === null) this.lowScanFrom = now;
    const slots = lowSlotsInWindow(this.seed, this.lowScanFrom, now);
    this.lowScanFrom = now;
    if (this.low.size === 0) {
      this.lowArmed = null;
      return;
    }
    const last = slots[slots.length - 1];
    if (last !== undefined) {
      this.lowArmed = last + lt.patienceMs;
      this.lowNextTry = 0;
    }
    if (this.lowArmed !== null && now >= this.lowNextTry) {
      if (now > this.lowArmed) {
        this.lowArmed = null;
      } else {
        const e = this.pickLow(now, planes, world);
        if (e) {
          this.warned.push(e);
          out.warned.push(e);
          this.lowArmed = null;
        } else {
          this.lowNextTry = now + lt.retryMs;
        }
      }
    }
    if (now >= this.nextLowPrefill) {
      this.nextLowPrefill = now + lt.prefillMs;
      this.prefillLow(now, planes, world);
    }
  }

  /** C1: the kinds in the order this pick tries them — a weighted draw
   * without replacement. */
  private lowOrder(lt: LowChaosTuning): LowKind[] {
    const left = (Object.keys(lt.weights) as LowKind[]).filter(
      (k) => lt.weights[k] > 0,
    );
    const order: LowKind[] = [];
    while (left.length > 0) {
      let total = 0;
      for (const k of left) total += lt.weights[k];
      let r = this.rand() * total;
      let j = 0;
      for (; j < left.length - 1; j++) {
        r -= lt.weights[left[j] as LowKind];
        if (r <= 0) break;
      }
      order.push(left.splice(j, 1)[0] as LowKind);
    }
    return order;
  }

  /**
   * C1: pick and build the next low event — near and ahead of a low human
   * (in turn, when there are several), or null when nothing fits. Two
   * passes: first only what every plane is clear of flying STRAIGHT on
   * (beside or beyond the path), then what a normal turn or a gentle
   * climb gets out of (across the path), which the budget's `lowchaos`
   * share bounds.
   */
  pickLow(
    now: number,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ): DirectorEvent | null {
    const lt = this.tuning.low;
    if (!lt) return null;
    const anchors = planes.filter(
      (p) => p.human && this.low.has(p.id) && !this.fresh(p, now),
    );
    if (anchors.length === 0) return null;
    const structural = this.goneShare(world) < lt.stopShare;
    const order = this.lowOrder(lt);
    const first = this.lowTurn++ % anchors.length;
    for (const strict of [true, false]) {
      for (let j = 0; j < anchors.length; j++) {
        const a = anchors[(first + j) % anchors.length] as DestructionPlane;
        for (const kind of order) {
          const e =
            kind === "topple"
              ? structural && this.lowTopple(now, a, planes, world, strict)
              : kind === "facade"
                ? structural && this.lowFacade(now, a, planes, world, strict)
                : kind === "gas"
                  ? this.lowGas(now, a, planes, world, strict)
                  : kind === "roof"
                    ? this.lowRoof(now, a, planes, world, strict)
                    : kind === "span"
                      ? this.lowSpan(now, a, planes, world, strict)
                      : strict && this.lowCars(now, a, planes, world);
          if (e) return e;
        }
      }
    }
    return null;
  }

  /**
   * C1: stage low event (k, b) at `at` with danger `zone` — or null when it
   * is not fair. Never with a fresh plane in the zone, now or at the
   * instant. A LETHAL event (`window`: the seconds from now its danger is
   * live) must leave every other plane a way out (escapeFrom — `strict`:
   * straight on), and goes through the danger budget's `lowchaos` share:
   * the planes it is near (points), and every plane that would have to
   * turn or climb out of it (path), charged once each.
   */
  private stageLow(
    now: number,
    k: number,
    b: number,
    at: Vec3,
    s: number,
    d: number,
    zone: DangerZone,
    window: readonly [number, number] | null,
    strict: boolean,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ): DirectorEvent | null {
    const t = this.tuning;
    const lead = DIRECTOR_WARN_MS / 1000;
    // Judged as broadcast — the wire's 0.1 m position and whole-metre zone,
    // rounded outward — so a client (or a test) re-checking the warning
    // finds exactly what the server did. Numbered once staged.
    const e = decodeDirectorEvent(
      encodeDirectorEvent({
        id: 0,
        k,
        b,
        ...canonicalize(at),
        s,
        d,
        w: now,
        at: now + DIRECTOR_WARN_MS,
        zone,
      }),
    ) as DirectorEvent;
    const z = e.zone;
    // The zone's plan-view reach from (x, z), m.
    const reach = Math.max(-z.x0, z.x1, -z.z0, z.z1);
    const path: string[] = [];
    for (const p of planes) {
      if (this.fresh(p, now)) {
        if (
          inDangerZone(e, p.pos, t.freshMarginM) ||
          inDangerZone(e, ahead(p, lead), t.freshMarginM)
        ) {
          return null;
        }
        continue;
      }
      if (!window) continue;
      // Out of reach for the whole window: nothing to check.
      const speed = Math.hypot(p.vel.x, p.vel.z);
      if (planGap(e.x, e.z, p.pos) > reach * 1.5 + speed * window[1] + 20) {
        continue;
      }
      const how = escapeFrom(z, e.x, e.z, p.pos, p.vel, ...window);
      if (how < 0 || (strict && how !== ESCAPE_STRAIGHT)) return null;
      if (how !== ESCAPE_STRAIGHT) path.push(p.id);
    }
    const budget = world.budget;
    if (window && budget) {
      const pts = zonePoints(e);
      const bp = budgetPlanes(planes);
      if (!budget.allows("lowchaos", pts, DIRECTOR_WARN_MS, now, bp)) {
        return null;
      }
      if (path.length > 0 && !budget.allowsIds("lowchaos", path, now, bp)) {
        return null;
      }
      const charged = budget.charge("lowchaos", pts, DIRECTOR_WARN_MS, now, bp);
      const rest = path.filter((id) => !charged.includes(id));
      if (rest.length > 0) budget.chargeIds("lowchaos", rest, now);
    }
    e.id = this.nextId++;
    this.lowIds.add(e.id);
    return e;
  }

  /**
   * C1: the towers a low topple weighs for plane `a` — standing, whole
   * enough, not busy or about to be rebuilt, ahead of the plane and within
   * LOW_TOWER_REACH of where it will be when the warning is up (and, for
   * the prefill, `extraS` further on) — nearest first, LOW_TOWERS of them,
   * each with the ways it may fall: away from the path first, then along
   * it, then across it.
   */
  private lowTowers(
    now: number,
    a: DestructionPlane,
    world: DestructionWorld,
    extraS = 0,
  ): { i: number; dirs: number[] }[] {
    const t = this.tuning;
    const city = world.city;
    const q = ahead(a, DIRECTOR_WARN_MS / 1000 + extraS);
    const wear = city.damage.wear();
    const busy = new Set(
      this.warned.filter((e) => e.k === EVENT_COLLAPSE).map((e) => e.b),
    );
    const found: { i: number; gap: number }[] = [];
    for (let i = 0; i < city.buildings.length; i++) {
      const b = city.buildings[i] as Building;
      if (b.height < t.towerMinM || busy.has(i)) continue;
      const gap = gapTo(b, q);
      if (gap > LOW_TOWER_REACH) continue;
      // Ahead of the plane, not behind it.
      const dx = wrapDeltaAxis(a.pos.x, b.x);
      const dz = wrapDeltaAxis(a.pos.z, b.z);
      if (dx * a.vel.x + dz * a.vel.z <= 0) continue;
      const g = tierGrids(b)[0];
      if (!g || g.ny < 3) continue;
      const worn = wear.get(i);
      if (worn && worn.share >= 0.5) continue;
      if (b.damage && standingProfile(b).top < b.height * 0.8) continue;
      if (this.rebuildSoon(world, i, now)) continue;
      found.push({ i, gap });
    }
    found.sort((x, y) => x.gap - y.gap || x.i - y.i);
    const alongX = Math.abs(a.vel.x) >= Math.abs(a.vel.z);
    return found.slice(0, LOW_TOWERS).map(({ i }) => {
      const b = city.buildings[i] as Building;
      // Which side of the path the tower stands on, across the path axis.
      const side = alongX
        ? wrapDeltaAxis(a.pos.z, b.z)
        : wrapDeltaAxis(a.pos.x, b.x);
      const away = alongX
        ? side >= 0
          ? DIR_POS_Z
          : DIR_NEG_Z
        : side >= 0
          ? DIR_POS_X
          : DIR_NEG_X;
      const toward = away ^ 1;
      const fwd = alongX
        ? a.vel.x >= 0
          ? DIR_POS_X
          : DIR_NEG_X
        : a.vel.z >= 0
          ? DIR_POS_Z
          : DIR_NEG_Z;
      return { i, dirs: [away, fwd, fwd ^ 1, toward] };
    });
  }

  /** C1: warm the low topple's shapes — the towers a pick 3 s from now
   * would weigh, at most ONE debris simulation a call. */
  private prefillLow(
    now: number,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ): void {
    if (this.goneShare(world) >= (this.tuning.low?.stopShare ?? 0)) return;
    const city = world.city;
    for (const p of planes) {
      if (!this.low.has(p.id) || this.fresh(p, now)) continue;
      for (const extra of [0, 3]) {
        for (const c of this.lowTowers(now, p, world, extra)) {
          const b = city.buildings[c.i] as Building;
          for (const dir of c.dirs) {
            const plan = demolitionPlan(b, c.i, TOPPLE, dir);
            if (plan && this.shapeOf(city.buildings, c.i, plan, true)) return;
          }
        }
      }
    }
  }

  /** C1: a tower near and ahead of `a` toppled beside (strict) or across
   * its path. One debris simulation at most (the rest must be cached). */
  private lowTopple(
    now: number,
    a: DestructionPlane,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
    strict: boolean,
  ): DirectorEvent | null {
    const city = world.city;
    let budget = 1;
    for (const c of this.lowTowers(now, a, world)) {
      const b = city.buildings[c.i] as Building;
      if (this.fallingCapped(world, now, planes, b.x, b.z)) continue;
      for (const dir of c.dirs) {
        const plan = demolitionPlan(b, c.i, TOPPLE, dir);
        if (!plan) continue;
        if (!this.shapeCached(c.i, plan)) {
          if (budget === 0) continue;
          budget--;
        }
        const shape = this.shapeOf(city.buildings, c.i, plan);
        if (!shape?.fp) continue;
        const e = this.stageLow(
          now,
          EVENT_COLLAPSE,
          c.i,
          { x: b.x, y: 0, z: b.z },
          TOPPLE,
          dir,
          shape.zone,
          [
            (DIRECTOR_WARN_MS + COLLAPSE_LEAD_MS) / 1000,
            (DIRECTOR_WARN_MS + shape.endMs) / 1000 + 1,
          ],
          strict,
          planes,
          world,
        );
        if (e) return e;
      }
    }
    return null;
  }

  /** C1: a facade beside the path ahead of `a` peels into the street — the
   * face toward the plane, at about the plane's height. */
  private lowFacade(
    now: number,
    a: DestructionPlane,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
    strict: boolean,
  ): DirectorEvent | null {
    const city = world.city;
    const lead = DIRECTOR_WARN_MS / 1000;
    const busy = new Set(this.warned.map((e) => e.b));
    for (const s of [lead, lead + 0.6, lead + 1.2]) {
      const q = ahead(a, s);
      const options: { i: number; dir: number; at: Vec3 }[] = [];
      for (let i = 0; i < city.buildings.length; i++) {
        const b = city.buildings[i] as Building;
        if (b.height < 40 || busy.has(i)) continue;
        const dx = wrapDeltaAxis(b.x, q.x);
        const dz = wrapDeltaAxis(b.z, q.z);
        const hw = (b.tiers[0]?.width ?? b.width) / 2;
        const hd = (b.tiers[0]?.depth ?? b.depth) / 2;
        const gx = Math.abs(dx) - hw;
        const gz = Math.abs(dz) - hd;
        // The face the plane is in front of (not off a corner).
        let dir: number;
        let gap: number;
        if (gx > 0 && gz < -4) {
          dir = dx > 0 ? DIR_POS_X : DIR_NEG_X;
          gap = gx;
        } else if (gz > 0 && gx < -4) {
          dir = dz > 0 ? DIR_POS_Z : DIR_NEG_Z;
          gap = gz;
        } else continue;
        if (gap < 12 || gap > 50) continue;
        const top = b.damage ? standingProfile(b).top : b.height;
        const y = Math.min(Math.max(q.y + 10, 12), top - 6);
        if (y < 12) continue;
        const ox =
          dir === DIR_POS_X
            ? hw + 0.5
            : dir === DIR_NEG_X
              ? -hw - 0.5
              : Math.max(-hw + 4, Math.min(hw - 4, dx));
        const oz =
          dir === DIR_POS_Z
            ? hd + 0.5
            : dir === DIR_NEG_Z
              ? -hd - 0.5
              : Math.max(-hd + 4, Math.min(hd - 4, dz));
        options.push({ i, dir, at: { x: b.x + ox, y, z: b.z + oz } });
      }
      while (options.length > 0) {
        const k = Math.floor(this.rand() * options.length);
        const o = options.splice(k, 1)[0] as (typeof options)[number];
        const r = FACADE_REACH;
        const zone: DangerZone =
          o.dir === DIR_POS_X
            ? { x0: -2, x1: r, z0: -r, z1: r, top: o.at.y + 8 }
            : o.dir === DIR_NEG_X
              ? { x0: -r, x1: 2, z0: -r, z1: r, top: o.at.y + 8 }
              : o.dir === DIR_POS_Z
                ? { x0: -r, x1: r, z0: -2, z1: r, top: o.at.y + 8 }
                : { x0: -r, x1: r, z0: -r, z1: 2, top: o.at.y + 8 };
        const e = this.stageLow(
          now,
          EVENT_FACADE,
          o.i,
          o.at,
          0,
          o.dir,
          zone,
          [lead, lead + 3],
          strict,
          planes,
          world,
        );
        if (e) return e;
      }
    }
    return null;
  }

  /** C1: a gas main bursting in the street beside the path ahead of `a` —
   * never closer to where it will be than GAS_BLAST_M + 6, so a plane
   * flying on takes nothing but the heat. */
  private lowGas(
    now: number,
    a: DestructionPlane,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
    strict: boolean,
  ): DirectorEvent | null {
    if (a.pos.y >= GAS_COLUMN_H + GAS_BLAST_M + 40) return null;
    const lead = DIRECTOR_WARN_MS / 1000;
    const there = ahead(a, lead);
    const zone: DangerZone = {
      x0: -GAS_BLAST_M,
      x1: GAS_BLAST_M,
      z0: -GAS_BLAST_M,
      z1: GAS_BLAST_M,
      top: GAS_COLUMN_H + GAS_BLAST_M,
    };
    const busy = (site: Vec3) =>
      this.warned.some(
        (e) => e.k === EVENT_GAS && planGap(e.x, e.z, site) < 2 * GAS_BLAST_M,
      );
    for (const dt of [0.8, 1.4, 0.3, 2, -0.3]) {
      const site = gasMainNear(this.seed, ahead(a, lead + dt));
      if (!site || busy(site)) continue;
      const d = gasDistance(site, there);
      if (d < GAS_BLAST_M + 6 || d > 90) continue;
      const e = this.stageLow(
        now,
        EVENT_GAS,
        -1,
        site,
        0,
        0,
        zone,
        [lead - 0.1, lead + 0.1],
        strict,
        planes,
        world,
      );
      if (e) return e;
    }
    return null;
  }

  /** C1: standing props of `kinds` near the path ahead of `a` (plan view
   * within [rMin, rMax] of one of its points), nearest first. */
  private propsAhead(
    a: DestructionPlane,
    world: DestructionWorld,
    kinds: readonly number[],
    rMin: number,
    rMax: number,
  ): Prop[] {
    const props = world.city.props;
    const state = props.slot.state;
    const lead = DIRECTOR_WARN_MS / 1000;
    const best = new Map<number, number>();
    for (const s of [lead, lead + 0.7, lead + 1.4]) {
      const q = ahead(a, s);
      propsNear(props.layout, q.x, q.z, rMax, (id) => {
        const p = props.layout.props[id];
        if (!p || !kinds.includes(p.kind) || state.isDown(id)) return;
        const d = planGap(p.x, p.z, q);
        if (d < rMin || d > rMax) return;
        best.set(id, Math.min(best.get(id) ?? d, d));
      });
    }
    return [...best]
      .sort((x, y) => x[1] - y[1] || x[0] - y[0])
      .map(([id]) => props.layout.props[id] as Prop);
  }

  /** C1: a roof tank or billboard beside the path ahead goes over the edge
   * (D9's solid faller: what falls is what collides). */
  private lowRoof(
    now: number,
    a: DestructionPlane,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
    strict: boolean,
  ): DirectorEvent | null {
    const lead = DIRECTOR_WARN_MS / 1000;
    const busy = new Set(
      this.warned.filter((e) => e.k === EVENT_ROOF).map((e) => e.b),
    );
    for (const p of this.propsAhead(a, world, ROOF_FALLERS, 15, 110)) {
      if (busy.has(p.id)) continue;
      const r = Math.max(p.hx, p.hz) + 2 * p.hy + 6;
      const zone: DangerZone = {
        x0: -r,
        x1: r,
        z0: -r,
        z1: r,
        top: p.y + p.hy + 4,
      };
      const e = this.stageLow(
        now,
        EVENT_ROOF,
        p.id,
        { x: p.x, y: p.y, z: p.z },
        0,
        p.dir,
        zone,
        [lead, lead + fallSeconds(p) + 1],
        strict,
        planes,
        world,
      );
      if (e) return e;
    }
    return null;
  }

  /** C1: a bridge span near the path ahead drops into the river. */
  private lowSpan(
    now: number,
    a: DestructionPlane,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
    strict: boolean,
  ): DirectorEvent | null {
    const lead = DIRECTOR_WARN_MS / 1000;
    for (const p of this.propsAhead(a, world, [PROP_BRIDGE], 30, 220)) {
      if (this.warned.some((e) => e.k === EVENT_SPAN && e.b === p.id)) {
        continue;
      }
      const zone: DangerZone = {
        x0: -p.hx - 6,
        x1: p.hx + 6,
        z0: -p.hz - 6,
        z1: p.hz + 6,
        top: p.y + p.hy + 3,
      };
      const e = this.stageLow(
        now,
        EVENT_SPAN,
        p.id,
        { x: p.x, y: p.y, z: p.z },
        0,
        0,
        zone,
        [lead, lead + fallSeconds(p) + 1],
        strict,
        planes,
        world,
      );
      if (e) return e;
    }
    return null;
  }

  /** C1: a car, taxi or fuel truck in the street ahead blows and sets off
   * the vehicles round it (D9's chain). Prop blasts break chunks and props,
   * never planes: nothing to charge. The one with most neighbours first. */
  private lowCars(
    now: number,
    a: DestructionPlane,
    planes: readonly DestructionPlane[],
    world: DestructionWorld,
  ): DirectorEvent | null {
    const layout = world.city.props.layout;
    const state = world.city.props.slot.state;
    const busy = new Set(
      this.warned.filter((e) => e.k === EVENT_CARS).map((e) => e.b),
    );
    const scored = this.propsAhead(a, world, VEHICLES, 30, 130)
      .filter((p) => !busy.has(p.id))
      .slice(0, 12)
      .map((p) => {
        let n = 0;
        propsNear(layout, p.x, p.z, 14, (id) => {
          const q = layout.props[id];
          if (!q || id === p.id || state.isDown(id)) return;
          if (VEHICLES.includes(q.kind as (typeof VEHICLES)[number])) {
            if (planGap(q.x, q.z, p) <= 14) n++;
          }
        });
        return { p, n };
      })
      .sort((x, y) => y.n - x.n || x.p.id - y.p.id);
    for (const { p } of scored) {
      const e = this.stageLow(
        now,
        EVENT_CARS,
        p.id,
        { x: p.x, y: p.y, z: p.z },
        0,
        0,
        { x0: -20, x1: 20, z0: -20, z1: 20, top: 30 },
        null,
        true,
        planes,
        world,
      );
      if (e) return e;
    }
    return null;
  }

  /** C1: collapses coming down within LOW_FALLING_R of `pos` — warned, or
   * with debris still in the air. */
  private fallingNear(world: DestructionWorld, now: number, pos: Vec3): number {
    let n = 0;
    for (const c of world.city.collapses.list) {
      if (now > c.t0 + c.endMs) continue;
      if (planGap(c.x, c.z, pos) <= LOW_FALLING_R) n++;
    }
    for (const e of this.warned) {
      if (e.k !== EVENT_COLLAPSE && e.k !== EVENT_CRANE) continue;
      if (planGap(e.x, e.z, pos) <= LOW_FALLING_R) n++;
    }
    return n;
  }

  /** C1: would one more collapse at (x, z) be over LOW_FALLING_MAX for a
   * human within LOW_FALLING_R of it? */
  private fallingCapped(
    world: DestructionWorld,
    now: number,
    planes: readonly DestructionPlane[],
    x: number,
    z: number,
  ): boolean {
    for (const p of planes) {
      if (!p.human || planGap(x, z, p.pos) > LOW_FALLING_R) continue;
      if (this.fallingNear(world, now, p.pos) >= LOW_FALLING_MAX) return true;
    }
    return false;
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
    const humans = planes.filter((p) => p.human);
    // C1 recycling: out in the fog of every human, and settled.
    const recycles = (k: 0 | 1, b: number): boolean =>
      t.recycleFarM > 0 && this.farFromHumans(k, b, humans, world);
    for (const [key, r] of [...this.announced]) {
      if (r.at > now || !this.clearToRebuild(r.k, r.b, now, planes, world)) {
        continue;
      }
      // A recycle a human has come back to waits for its timer (or for
      // them to leave again): never a rebuild in sight that is not due.
      if (!this.timedDue(r.k, r.b, now, city) && !recycles(r.k, r.b)) {
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
    for (const i of city.firstDamageAt.keys()) {
      if (this.timedDue(0, i, now, city)) {
        announce(0, i);
        continue;
      }
      const last = city.lastStructuralAt.get(i);
      if (last !== undefined && now < last + t.recycleAfterMs) continue;
      if (recycles(0, i)) announce(0, i);
    }
    for (const [id, fell] of city.collapses.felled) {
      if (this.timedDue(1, id, now, city)) announce(1, id);
      else if (now >= fell + t.recycleAfterMs && recycles(1, id)) {
        announce(1, id);
      }
    }
    return out;
  }

  /** Is (k, b)'s own rebuild timer up — the seeded delay after its first
   * damage (fall), and rebuildAfterCollapseMs after its last collapse? */
  private timedDue(k: 0 | 1, b: number, now: number, city: RoomCity): boolean {
    const t = this.tuning;
    if (k === 0) {
      const first = city.firstDamageAt.get(b);
      if (first === undefined) return true; // whole again: nothing to time
      if (now < first + rebuildDelay(this.seed, 0, b, first, t)) return false;
      const last = city.lastStructuralAt.get(b);
      return last === undefined || now >= last + t.rebuildAfterCollapseMs;
    }
    const fell = city.collapses.felled.get(b);
    if (fell === undefined) return true;
    return (
      now >= fell + rebuildDelay(this.seed, 1, b, fell, t) &&
      now >= fell + t.rebuildAfterCollapseMs
    );
  }

  /** C1: is target (k, b) farther than recycleFarM (plan-view gap from its
   * footprint, or a crane's reach) from every one of `humans`? */
  private farFromHumans(
    k: 0 | 1,
    b: number,
    humans: readonly DestructionPlane[],
    world: DestructionWorld,
  ): boolean {
    let cx: number;
    let cz: number;
    let hx: number;
    let hz: number;
    if (k === 0) {
      const bd = world.city.buildings[b];
      if (!bd) return false;
      cx = bd.x;
      cz = bd.z;
      hx = bd.width / 2;
      hz = bd.depth / 2;
    } else {
      const site = world.cranes.find((c) => c.id === b);
      if (!site) return false;
      cx = site.x;
      cz = site.z;
      hx = hz = Math.max(site.jibLength, site.counterLength);
    }
    const far = this.tuning.recycleFarM;
    for (const h of humans) {
      const gx = Math.max(Math.abs(wrapDeltaAxis(cx, h.pos.x)) - hx, 0);
      const gz = Math.max(Math.abs(wrapDeltaAxis(cz, h.pos.z)) - hz, 0);
      if (Math.hypot(gx, gz) <= far) return false;
    }
    return true;
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
