// W2 enemy bombs, server side: one BombDirector per room decides WHEN an
// enemy plane starts a bomb run, at WHAT, and whether each bomb it tries to
// release may fall. The brain (server/src/bots.ts) flies the run and cues
// its releases; index.ts and the scratch harness drive exactly this.
//
// The rules, in the order they gate a run:
//  - only while the room's city may break (index.ts breakable), the war is
//    on, and the city's gone-hold is off (C2's backstop: nothing more to
//    break, so nothing more is aimed at it);
//  - the room's pace (common/src/waves.ts waveBombing — heavier with the
//    intensity and the wave): a gap between two runs starting, a cap on runs
//    at once, each enemy resting between its runs, and none before an enemy
//    has flown FIRST_RUN_MS off its carrier;
//  - the run's subject is the enemy's W1 quarry — a human, never the carrier
//    — and a quarry that is spawn-protected or freshly (re)spawned is left
//    alone; the target (a rooftop near it for a DIVE, a street point near it
//    for a CARPET) keeps clear of every such human, of a recent respawn and
//    of the carrier's ground track.
// And each release:
//  - the run's own racks (common/src/bombs.ts: the heavy bomb for a dive,
//    the wing bombs for a carpet, one stick slot apart), at most
//    maxInFlight of the room's bombs in the air;
//  - planBombDrop: inside the release envelope, a fall clear of the city as
//    it stands, landing within the run's reach of its target;
//  - never at a plane (MISSILE_PLANE_CLEAR_M off every human now and at the
//    impact), never near a fresh or spawn-protected human, never inside a
//    respawn's quiet zone, never with the dropper beside the carrier;
//  - C2's DangerBudget on its `bomb` layer: a human near a run's bombs is
//    charged ONCE for the whole run.
// A refused release is simply not made (the brain retries inside its
// window). What lands goes through the X1 pipeline (MissileDirector.inject
// → settle → index.ts landMissile): D2 chunks, collapses, fire, craters,
// plane damage — humans only (enemies are immune to their own side's
// bombs; they still fly around them as hazard discs).

import {
  BOMBS_LOADED,
  type BombRunKind,
  type WireRacks,
  bombSurfaceY,
  bombsFor,
  nextRack,
  planBombDrop,
} from "@angels-bandits/common/bombs";
import { BOSS_REACH_XZ } from "@angels-bandits/common/boss";
import { roofPoint } from "@angels-bandits/common/chaos";
import {
  type Building,
  chunkBuilding,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  type CityIndex,
  forEachBuildingNear,
} from "@angels-bandits/common/collision";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import {
  BOMB_CHUNK_DAMAGE,
  BOMB_CHUNK_RADIUS,
  BOMB_FALL_MS,
  MISSILE_PLANE_CLEAR_M,
  type MissileStrike,
  missileImpactAt,
  predictedPos,
} from "@angels-bandits/common/strike";
import { type Intensity, waveBombing } from "@angels-bandits/common/waves";
import {
  type Vec3,
  canonicalize,
  wrapDeltaAxis,
  wrapDistance,
} from "@angels-bandits/common/world";
import type { DangerBudget } from "./danger";
import { type RoomCity, blastProps } from "./destruction";
import type { MissileDirector } from "./strikes";

export interface BombTuning {
  /** Room cap on bombs in the air. */
  maxInFlight: number;
  /** An enemy's first run comes no sooner than this after its launch, ms
   * (it settles off the carrier first — bots.ts LAUNCH_SETTLE_MS). */
  firstRunMs: number;
  /** The run's pace (waveBombing) is scaled by this: < 1 is faster. */
  paceScale: number;
  /** A carpet's wing bombs fall this far apart, ms. */
  stickGapMs: number;
  /** A dive's roof, and a carpet's street point, lies this far from the
   * quarry, m. */
  targetMinM: number;
  targetMaxM: number;
  /** A drop lands within this of its run's target, m (plan view). */
  diveReachM: number;
  carpetReachM: number;
  /** Plan-view clearance of targets and droppers from the carrier, m. */
  carrierClearM: number;
  /** Plan-view clearance of a target from a fresh or protected human, m. */
  freshClearM: number;
  /** A run the brain could not start rests its enemy this long, ms. */
  refusedRestMs: number;
  /** Only an enemy within this of its quarry starts a run, m (from further
   * the run would be over before it got there). */
  runRangeM: number;
}

export const BOMB_TUNING: BombTuning = {
  maxInFlight: 6,
  firstRunMs: 30_000,
  paceScale: 1,
  stickGapMs: 450,
  targetMinM: 30,
  targetMaxM: 170,
  diveReachM: 30,
  carpetReachM: 70,
  carrierClearM: BOSS_REACH_XZ + 80,
  freshClearM: 80,
  refusedRestMs: 4000,
  runRangeM: 600,
};

/** AB_BOMBS_FAST=1 (QA only): runs come quickly. */
export const BOMB_FAST_TUNING: BombTuning = {
  ...BOMB_TUNING,
  firstRunMs: 3000,
  paceScale: 0.25,
  refusedRestMs: 1000,
};

/** One enemy plane as the director sees it this tick. */
export interface BombEnemy {
  id: string;
  pos: Vec3;
  vel: Vec3;
  /** Its W1 quarry (a human id), or null. */
  quarry: string | null;
  /** Its brain may start a run now (RoomBots.canBomb). */
  ready: boolean;
  /** Its brain is flying a run right now (RoomBots.runOf). */
  onRun: boolean;
  /** When its launch was planned, server ms. */
  launchedAt: number;
}

/** One human in the air: on-record position (extrapolated) and velocity. */
export interface BombHuman {
  id: string;
  pos: Vec3;
  vel: Vec3;
  prot: boolean;
}

/** The room as the director reads it. */
export interface BombWorld {
  index: CityIndex;
  /** The room's buildings as they stand (path clearance). */
  buildings: readonly Building[];
  /** The room's strike pipeline: ids, injection, respawn quiet zones. */
  missiles: MissileDirector;
  /** C2's danger budget (absent with AB_CHAOS=0: the plane rules only). */
  budget?: DangerBudget;
  /** The carrier's position now, or null when none is up. */
  carrier: Vec3 | null;
  /** C2's gone-hold is on: the city takes no more damage for now. */
  hold: boolean;
  /** W1 intensity and the wave on (1-based). */
  intensity: Intensity;
  wave: number;
}

/** A run the brain should start. */
export interface BombRunOrder {
  enemyId: string;
  kind: BombRunKind;
  target: Vec3;
}

/** A release the brain cued this tick. */
export interface BombCue {
  enemyId: string;
  pos: Vec3;
  vel: Vec3;
}

/** A release the director made: broadcast `missile` with `by` and `r`. */
export interface BombDrop {
  strike: MissileStrike;
  enemyId: string;
  rack: number;
  /** The run's last bomb: the brain pulls out (RoomBots.endRun). */
  done: boolean;
}

export type BombRefusalReason =
  | "norun"
  | "stick"
  | "cap"
  | "carrier"
  | "curve"
  | "path"
  | "reach"
  | "plane"
  | "fresh"
  | "spawn"
  | "budget";

/** The scratch harness's (and a curious operator's) view of what happened. */
export interface BombStats {
  runs: Record<BombRunKind, number>;
  drops: Record<BombRunKind, number>;
  refused: Partial<Record<BombRefusalReason, number>>;
  /** Runs that ended with bombs of their kind still aboard (hit, blocked,
   * timed out, refused by the brain). */
  cancelled: number;
  detonations: number;
  /** Runs not started: no target near the quarry passed, or the brain
   * could not take the order. */
  noTarget: number;
  brainRefused: number;
  peakInFlight: number;
  /** Releases made within freshClearM of a fresh or protected human, or a
   * target picked so — must stay 0. */
  freshViolations: number;
}

interface Run {
  kind: BombRunKind;
  target: Vec3;
  /** No release before this, ms (a carpet's stick spacing). */
  nextDropAt: number;
  /** Humans this run's bombs have been charged to (DangerBudget). */
  charged: Set<string>;
  /** The rest this enemy takes when the run ends, ms. */
  restMs: number;
}

export class BombDirector {
  private readonly rand: () => number;
  private readonly racks = new Map<string, number>();
  private readonly runs = new Map<string, Run>();
  private readonly restUntil = new Map<string, number>();
  /** The bombs this director put in the air: strike id → impact time. */
  private readonly flying = new Map<number, number>();
  private lastStart = Number.NEGATIVE_INFINITY;
  readonly stats: BombStats = {
    runs: { dive: 0, carpet: 0 },
    drops: { dive: 0, carpet: 0 },
    refused: {},
    cancelled: 0,
    detonations: 0,
    noTarget: 0,
    brainRefused: 0,
    peakInFlight: 0,
    freshViolations: 0,
  };

  constructor(
    seed: number,
    private readonly tuning: BombTuning = BOMB_TUNING,
  ) {
    this.rand = mulberry32((seed ^ 0xb0b5) >>> 0);
  }

  /** The racks `id` still carries (an unknown enemy is fully loaded). */
  racksOf(id: string): number {
    return this.racks.get(id) ?? BOMBS_LOADED;
  }

  /** The welcome's racks: every enemy that has dropped anything. */
  wire(): WireRacks {
    const out: WireRacks = [];
    for (const [id, mask] of this.racks) {
      if (mask !== BOMBS_LOADED) out.push([id, mask]);
    }
    return out;
  }

  /** The run `id` is on, or null. */
  runOf(id: string): { kind: BombRunKind; target: Vec3 } | null {
    const r = this.runs.get(id);
    return r ? { kind: r.kind, target: r.target } : null;
  }

  /** Bombs this director has in the air at `now`. */
  inFlight(now: number): number {
    let n = 0;
    for (const at of this.flying.values()) if (at > now) n++;
    return n;
  }

  /** An enemy left the room for good. */
  forget(id: string): void {
    this.racks.delete(id);
    this.runs.delete(id);
    this.restUntil.delete(id);
  }

  /** The war stopped (last human out, war off): every run and rest gone. */
  reset(): void {
    this.racks.clear();
    this.runs.clear();
    this.restUntil.clear();
    this.flying.clear();
    this.lastStart = Number.NEGATIVE_INFINITY;
  }

  /**
   * `id` went down (any cause that settles a death): its run is over.
   * True when it was `shot` down ON a run with that run's bombs aboard —
   * the load goes up with it (a bigger mid-air blast; index.ts) and its
   * racks are empty from here.
   */
  downed(id: string, now: number, shot: boolean): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    this.endRun(id, now);
    if (!shot) return false;
    if (bombsFor(run.kind, this.racksOf(id)) === 0) return false;
    this.racks.set(id, 0);
    this.stats.detonations++;
    return true;
  }

  /** The brain dropped its run (or never took it): rest, count it. */
  private endRun(id: string, now: number, restMs?: number): void {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.delete(id);
    if (bombsFor(run.kind, this.racksOf(id)) > 0) this.stats.cancelled++;
    this.restUntil.set(id, now + (restMs ?? run.restMs));
  }

  /** The brain refused an order: no run after all, a short rest. */
  refused(id: string, now: number): void {
    this.stats.brainRefused++;
    this.endRun(id, now, this.tuning.refusedRestMs);
  }

  /**
   * One tick: end the runs the brain is no longer flying, then start at
   * most one new run. Returns the orders for the brain (RoomBots.startRun;
   * hand a refusal back through refused()).
   */
  tick(
    now: number,
    enemies: readonly BombEnemy[],
    humans: readonly BombHuman[],
    world: BombWorld,
  ): BombRunOrder[] {
    const t = this.tuning;
    for (const [id, at] of this.flying) if (at <= now) this.flying.delete(id);
    const byId = new Map(enemies.map((e) => [e.id, e]));
    for (const id of [...this.runs.keys()]) {
      if (!byId.get(id)?.onRun) this.endRun(id, now);
    }
    if (world.hold) return [];
    const pace = waveBombing(world.wave, world.intensity);
    if (this.runs.size >= pace.maxRuns) return [];
    if (now - this.lastStart < pace.gapMs * t.paceScale) return [];

    const candidates: { enemy: BombEnemy; quarry: BombHuman }[] = [];
    for (const e of enemies) {
      if (!e.ready || e.onRun || this.runs.has(e.id)) continue;
      if (now - e.launchedAt < t.firstRunMs) continue;
      if (now < (this.restUntil.get(e.id) ?? Number.NEGATIVE_INFINITY)) {
        continue;
      }
      const mask = this.racksOf(e.id);
      if (mask === 0) continue;
      const quarry = humans.find((h) => h.id === e.quarry);
      if (!quarry || this.isFresh(quarry, now, world)) continue;
      if (this.planDist(e.pos, quarry.pos) > t.runRangeM) continue;
      candidates.push({ enemy: e, quarry });
    }
    if (candidates.length === 0) return [];
    const pick = candidates[
      Math.floor(this.rand() * candidates.length)
    ] as (typeof candidates)[number];
    const mask = this.racksOf(pick.enemy.id);
    const dive = bombsFor("dive", mask) > 0;
    const carpet = bombsFor("carpet", mask) > 0;
    const kind: BombRunKind =
      dive && carpet
        ? this.rand() < 0.5
          ? "dive"
          : "carpet"
        : dive
          ? "dive"
          : "carpet";
    const target = this.pickTarget(kind, pick.quarry, humans, now, world);
    if (!target) {
      this.stats.noTarget++;
      this.restUntil.set(pick.enemy.id, now + t.refusedRestMs);
      return [];
    }
    this.runs.set(pick.enemy.id, {
      kind,
      target,
      nextDropAt: now,
      charged: new Set(),
      restMs: pace.restMs * t.paceScale,
    });
    this.lastStart = now;
    this.stats.runs[kind]++;
    return [{ enemyId: pick.enemy.id, kind, target }];
  }

  /**
   * The brain cued a release: plan the bomb and check every rule. A made
   * drop is injected into the room's strike pipeline and its rack emptied;
   * the caller broadcasts it. A refusal returns its reason.
   */
  drop(
    now: number,
    cue: BombCue,
    humans: readonly BombHuman[],
    world: BombWorld,
  ): BombDrop | BombRefusalReason {
    const t = this.tuning;
    const run = this.runs.get(cue.enemyId);
    if (!run) return this.refuse("norun");
    if (now < run.nextDropAt) return this.refuse("stick");
    const mask = this.racksOf(cue.enemyId);
    const rack = nextRack(run.kind, mask);
    if (rack < 0) {
      this.endRun(cue.enemyId, now);
      return this.refuse("norun");
    }
    if (this.inFlight(now) >= t.maxInFlight) return this.refuse("cap");
    if (
      world.carrier &&
      this.planDist(cue.pos, world.carrier) < t.carrierClearM
    ) {
      return this.refuse("carrier");
    }
    const planned = planBombDrop(
      0,
      cue.pos,
      cue.vel,
      now,
      world.index,
      world.buildings,
    );
    if (planned === "curve" || planned === "path") return this.refuse(planned);
    const to = planned.to;
    const reach = run.kind === "dive" ? t.diveReachM : t.carpetReachM;
    if (this.planDist(to, run.target) > reach) return this.refuse("reach");
    for (const h of humans) {
      if (
        wrapDistance(h.pos, to) < MISSILE_PLANE_CLEAR_M ||
        wrapDistance(predictedPos(h, BOMB_FALL_MS), to) < MISSILE_PLANE_CLEAR_M
      ) {
        return this.refuse("plane");
      }
      if (
        this.isFresh(h, now, world) &&
        (this.planDist(h.pos, to) < t.freshClearM ||
          this.planDist(predictedPos(h, BOMB_FALL_MS), to) < t.freshClearM)
      ) {
        return this.refuse("fresh");
      }
    }
    if (world.missiles.nearSpawn(to, now)) return this.refuse("spawn");
    if (world.budget) {
      // One charge per human per run: only the humans this run has not yet
      // been charged to are asked (and charged) again.
      const uncharged = humans.filter((h) => !run.charged.has(h.id));
      if (!world.budget.allows("bomb", [to], BOMB_FALL_MS, now, uncharged)) {
        return this.refuse("budget");
      }
      for (const id of world.budget.charge(
        "bomb",
        [to],
        BOMB_FALL_MS,
        now,
        uncharged,
      )) {
        run.charged.add(id);
      }
    }
    const strike: MissileStrike = { ...planned, id: world.missiles.allocId() };
    world.missiles.inject(strike);
    this.flying.set(strike.id, missileImpactAt(strike));
    this.stats.peakInFlight = Math.max(
      this.stats.peakInFlight,
      this.inFlight(now),
    );
    const left = mask & ~(1 << rack);
    this.racks.set(cue.enemyId, left);
    this.stats.drops[run.kind]++;
    run.nextDropAt = now + t.stickGapMs;
    const done = nextRack(run.kind, left) < 0;
    if (done) this.endRun(cue.enemyId, now);
    return { strike, enemyId: cue.enemyId, rack, done };
  }

  private refuse(reason: BombRefusalReason): BombRefusalReason {
    this.stats.refused[reason] = (this.stats.refused[reason] ?? 0) + 1;
    return reason;
  }

  /** Spawn-protected, or (re)spawned inside the quiet windows. */
  private isFresh(h: BombHuman, now: number, world: BombWorld): boolean {
    if (h.prot) return true;
    if (world.missiles.freshlySpawned(h.id, now)) return true;
    return world.budget ? world.budget.fresh(h, now) : false;
  }

  private planDist(a: Vec3, b: Vec3): number {
    return Math.hypot(wrapDeltaAxis(a.x, b.x), wrapDeltaAxis(a.z, b.z));
  }

  /** A run's target near `quarry`: a rooftop for a dive, a street point
   * for a carpet — clear of fresh humans, recent respawns and the carrier.
   * Null when nothing near passes. */
  private pickTarget(
    kind: BombRunKind,
    quarry: BombHuman,
    humans: readonly BombHuman[],
    now: number,
    world: BombWorld,
  ): Vec3 | null {
    const t = this.tuning;
    const ok = (p: Vec3): boolean => {
      const d = this.planDist(p, quarry.pos);
      if (d < t.targetMinM || d > t.targetMaxM) return false;
      if (world.carrier && this.planDist(p, world.carrier) < t.carrierClearM) {
        return false;
      }
      if (world.missiles.nearSpawn(p, now)) return false;
      for (const h of humans) {
        if (
          this.isFresh(h, now, world) &&
          this.planDist(h.pos, p) < t.freshClearM
        ) {
          return false;
        }
      }
      return true;
    };
    if (kind === "dive") {
      const roofs: number[] = [];
      forEachBuildingNear(world.index, quarry.pos, t.targetMaxM, (i) => {
        roofs.push(i);
      });
      for (let n = 0; n < 8 && roofs.length > 0; n++) {
        const b = world.index.buildings[
          roofs[Math.floor(this.rand() * roofs.length)] as number
        ] as Building;
        const p = roofPoint(b, this.rand);
        if (p.y >= 20 && ok(p)) return p;
      }
      return null;
    }
    // A street centreline near the quarry: the nearer of its two street
    // lines, a seeded way along it.
    for (let n = 0; n < 8; n++) {
      const cx = Math.round(quarry.pos.x / BLOCK_PITCH) * BLOCK_PITCH;
      const cz = Math.round(quarry.pos.z / BLOCK_PITCH) * BLOCK_PITCH;
      const along = (this.rand() * 2 - 1) * t.targetMaxM;
      const onX =
        Math.abs(wrapDeltaAxis(quarry.pos.x, cx)) <
        Math.abs(wrapDeltaAxis(quarry.pos.z, cz));
      const p = canonicalize(
        onX
          ? { x: cx, y: 0, z: quarry.pos.z + along }
          : { x: quarry.pos.x + along, y: 0, z: cz },
      );
      if (bombSurfaceY(world.index, p.x, p.z) === 0 && ok(p)) return p;
    }
    return null;
  }
}

/** A load detonation's D2 reach over a bomb's, and its chunk damage. */
const LOAD_BLAST_SCALE = 1.5;

/** W2: an enemy's bomb load went up with it at `pos` (BombDirector.downed):
 * blow out the room city's chunks and props around it — a bomb's blast, half
 * as wide again. A collapse it sets off is the killer's (`by`, D3). It never
 * hurts a plane, so it can never kill the pilot who shot the load. Returns
 * the chunks destroyed. */
export function applyLoadBlast(
  city: RoomCity,
  pos: Vec3,
  by: string | null,
): number[] {
  const r = BOMB_CHUNK_RADIUS * LOAD_BLAST_SCALE;
  const out = city.damage.damageAt(pos, r, BOMB_CHUNK_DAMAGE);
  for (const id of out) city.breakers.set(chunkBuilding(id), by);
  blastProps(city, pos, r, BOMB_CHUNK_DAMAGE, by);
  return out;
}
