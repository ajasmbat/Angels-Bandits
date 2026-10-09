// C2 constant chaos, server side: WHEN and WHERE meteors fall, bomber runs
// fly, quakes shake the city and fires spread — one ChaosDirector per room.
// index.ts and the bot-sim harness both drive exactly this, so the sim
// measures the chaos the live server stages. The shared, pure half (poses,
// boxes, schedules, wire) is common/src/chaos.ts.
//
// The rules:
//  - only while a human is in the room (index.ts's `breakable` gate), and
//    only around a human: meteors land near one 60 % of the time (else
//    anywhere in the city), bomber runs fly the street line under one,
//    quakes centre on one;
//  - every lethal thing — a meteor, a run's whole carpet — must be allowed
//    by the room's DangerBudget (server/src/danger.ts) and is charged to it;
//    each bomb is re-checked at its drop and called off (`bombsOff`) when a
//    fresh plane is under it;
//  - meteors and bombs are MissileStrikes injected into the room's
//    MissileDirector, so they settle, land (applyMissileImpact), hurt planes
//    (blastVictims: the respawn quiet rule) and replay exactly as missiles;
//  - quakes and fire never break a chunk of a building a plane is in reach
//    of, now or on its path over HOLD_HORIZON_S (holdNear): what they set
//    off has only D3's 0.6 s lead, so it must happen where no one is;
//  - fire never hurts a plane;
//  - and the room's gone-share hold (applyGoneHold): at GONE_HOLD_SHARE of
//    the city broken or fallen, nothing breaks until rebuilds catch up.

import {
  BOSS_FAST_TUNING,
  BOSS_TUNING,
  BOSS_TUNING_S4,
  type BossTuning,
} from "@angels-bandits/common/boss";
import {
  BOMBER_COUNT,
  BOMB_THROW_M,
  type BomberDown,
  type BomberRun,
  CHAOS_BOMBER,
  CHAOS_METEOR,
  CHAOS_QUAKE,
  type ChaosLayer,
  FIRE_CHUNK_DAMAGE,
  FIRE_LIFE_MS,
  FIRE_MAX,
  FIRE_SPREAD_MS,
  FIRE_SPREAD_P,
  type QuakeEvent,
  type WireChaosState,
  bombDrops,
  bombLinePoints,
  bomberAlive,
  bomberRayHit,
  chaosSlotsInWindow,
  emptyBomberSlot,
  encodeBomberDown,
  encodeBomberRun,
  encodeQuake,
  fireNeighbours,
  holdNear,
  planBomberRun,
  planMeteor,
  planQuake,
  quakeFalloff,
  quakeLive,
  roofPoint,
  runEnd,
} from "@angels-bandits/common/chaos";
import {
  type Building,
  chunkBuilding,
  chunkId,
  chunksOf,
  encodeChunkIds,
  mulberry32,
  raycastChunk,
  tierGrids,
} from "@angels-bandits/common/city";
import type { CityIndex } from "@angels-bandits/common/collision";
import {
  BLOCK_PITCH,
  BULLET_DAMAGE,
  BULLET_RANGE,
  DESTROY_CAP,
  DESTROY_CAP_D2,
  GONE_HOLD_SHARE,
} from "@angels-bandits/common/constants";
import { type DirectorEvent, EVENT_GAS } from "@angels-bandits/common/director";
import {
  BOMB_FALL_MS,
  METEOR_BLAST_RADIUS,
  METEOR_FLIGHT_MS,
  MISSILE_BLAST_RADIUS,
  type MissileStrike,
  missileImpactAt,
  pickMissileTarget,
  predictedPos,
} from "@angels-bandits/common/strike";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import { BOSS_CLAIM_LOOKBACK_MS, BOSS_DIR_CONE } from "./boss";
import type { Combat, SpeedCapFn } from "./combat";
import { DANGER_TUNING, type DangerBudget, type DangerTuning } from "./danger";
import type { RoomCity } from "./destruction";
import {
  D5_TUNING,
  DESTRUCTION_FAST,
  DESTRUCTION_TUNING,
  type DestructionTuning,
} from "./director";
import {
  DEFAULT_TUNING,
  type DirectorTuning,
  FAST_TUNING,
  type MissileDirector,
  X1_TUNING,
} from "./strikes";

export interface ChaosTuning {
  /** Slot times are chaosSlotsInWindow's, scaled by this (QA: < 1). */
  slotScale: number;
  /** An armed slot retries its pick this often, for this long, ms — per
   * layer (meteor, bomber, quake). */
  retryMs: number;
  patienceMs: readonly [number, number, number];
  /** Share of meteors aimed near a human (the rest anywhere in the city). */
  meteorNearShare: number;
  /** A quake weakens this many seeded buildings' ground floors by
   * quakeWeakenDamage, and every worn building in its reach by
   * quakeWornDamage (× falloff) — breaking at most quakeBreakMax chunks. */
  quakeBuildings: number;
  quakeWeakenDamage: number;
  quakeWornDamage: number;
  quakeBreakMax: number;
  /** Spreading fire on or off. */
  fire: boolean;
}

export const CHAOS_TUNING: ChaosTuning = {
  slotScale: 1,
  retryMs: 500,
  patienceMs: [3000, 15_000, 10_000],
  meteorNearShare: 0.6,
  quakeBuildings: 40,
  quakeWeakenDamage: 20,
  quakeWornDamage: 45,
  quakeBreakMax: 8,
  fire: true,
};

/** AB_CHAOS_FAST=1 (tests and QA only): every layer four times as often. */
export const CHAOS_FAST: ChaosTuning = {
  ...CHAOS_TUNING,
  slotScale: 1 / 4,
  patienceMs: [1500, 8000, 5000],
};

/** Every tuning the room's chaos reads, from the environment — the one seam
 * production rollback (`AB_CHAOS=0`) goes through. */
export interface ChaosTunings {
  boss: BossTuning;
  missile: DirectorTuning;
  director: DestructionTuning;
  /** The C2 layers (null: off). */
  chaos: ChaosTuning | null;
  /** The danger budget (null: none — the pre-C2 rules only). */
  danger: DangerTuning | null;
  /** The room city's DESTROY_CAP, and whether the gone-share hold runs. */
  destroyCap: number;
  hold: boolean;
}

/**
 * The tunings for an environment. `AB_CHAOS=0` restores every pre-C2 value
 * exactly (S4's 15-min boss, X1's strikes, D5's director, D2's cap) and
 * switches the C2 layers, the budget and the hold off; the `*_FAST` flags
 * (tests and QA only) work either way.
 */
export function chaosTunings(
  env: Readonly<Record<string, string | undefined>>,
): ChaosTunings {
  const off = env.AB_CHAOS === "0";
  return {
    boss:
      env.AB_BOSS_FAST === "1"
        ? BOSS_FAST_TUNING
        : off
          ? BOSS_TUNING_S4
          : BOSS_TUNING,
    missile:
      env.AB_MISSILE_FAST === "1"
        ? FAST_TUNING
        : off
          ? X1_TUNING
          : DEFAULT_TUNING,
    director:
      env.AB_DIRECTOR_FAST === "1"
        ? DESTRUCTION_FAST
        : off
          ? D5_TUNING
          : DESTRUCTION_TUNING,
    chaos: off ? null : env.AB_CHAOS_FAST === "1" ? CHAOS_FAST : CHAOS_TUNING,
    danger: off ? null : DANGER_TUNING,
    destroyCap: off ? DESTROY_CAP_D2 : DESTROY_CAP,
    hold: !off,
  };
}

/** The room's gone-share backstop, once per tick: hold every chunk at 1 HP
 * while (broken + fallen) / chunks ≥ GONE_HOLD_SHARE. */
export function applyGoneHold(city: RoomCity): void {
  city.damage.hold = city.damage.goneShare >= GONE_HOLD_SHARE;
}

/** A plane as the chaos director sees it this tick (the caller leaves out
 * pending, away and dead planes; positions extrapolated to now). */
export interface ChaosPlane {
  id: string;
  pos: Vec3;
  vel: Vec3;
  human: boolean;
  /** Spawn-protected right now. */
  prot: boolean;
}

/** What the director reads besides the planes. */
export interface ChaosWorld {
  city: RoomCity;
  /** The room's missile director: meteors and bombs ride its pipeline. */
  missiles: MissileDirector;
  budget: DangerBudget;
  index: CityIndex;
  /** Tall things a bomber line must clear besides roofs (crane hubs). */
  obstacles?: readonly { x: number; z: number; top: number }[];
}

/** What one tick produced, in broadcast order. */
export interface ChaosTick {
  /** Meteors launched (already injected) — broadcast as `missile`. */
  meteors: MissileStrike[];
  /** Bomber runs planned, each with all its bombs — one `bombers` each. */
  runs: { run: BomberRun; bombs: MissileStrike[] }[];
  /** Bombs called off at their drop (a fresh plane under them). */
  bombsOff: number[];
  /** Quakes warned this tick — `quake`. */
  quakes: QuakeEvent[];
  /** Chunks quakes and fire broke this tick (they ride the `chunks`
   * batch; listed for the caller's telemetry). */
  broke: number[];
  /** Fires lit / out since the last tick — one `fires` batch. */
  firesOn: number[];
  firesOff: number[];
}

/** A run stays in the slot (and the welcome) this long after its end, ms. */
const RUN_TAIL_MS = 5000;

interface PendingBomb {
  run: number;
  k: number;
  t0: number;
  to: Vec3;
}

interface Fire {
  since: number;
}

export class ChaosDirector {
  /** The room's bombers as both sides hold them — the room's mover field
   * holds this very object (bots, crash checks, respawns). */
  readonly slot = emptyBomberSlot();
  private scanFrom: number | null = null;
  private readonly armed: ({ until: number; next: number } | null)[] = [
    null,
    null,
    null,
  ];
  private quakes: QuakeEvent[] = [];
  private readonly quakeDone = new Set<number>();
  private readonly fires = new Map<number, Fire>();
  private firesOn: number[] = [];
  private firesOff: number[] = [];
  private nextFireTick = 0;
  /** Bombs announced and not yet dropped, by strike id. */
  private readonly bombs = new Map<number, PendingBomb>();
  /** Each live ship's HP and who last hurt it, by `run:k`. */
  private readonly hp = new Map<string, number>();
  private readonly lastHit = new Map<string, string>();
  private nextRun = 1;
  private nextQuake = 1;
  private readonly meteorRand: () => number;
  private readonly bomberRand: () => number;
  private readonly quakeRand: () => number;
  private readonly fireRand: () => number;

  constructor(
    private readonly seed: number,
    private readonly tuning: ChaosTuning = CHAOS_TUNING,
  ) {
    // One salted stream per layer: a layer's draws never shift another's.
    this.meteorRand = mulberry32((seed ^ 0x6e7e0a5) >>> 0);
    this.bomberRand = mulberry32((seed ^ 0x0b0b3e5) >>> 0);
    this.quakeRand = mulberry32((seed ^ 0x9a4e1d2) >>> 0);
    this.fireRand = mulberry32((seed ^ 0x0f1e5ed) >>> 0);
  }

  /** Quakes still to come or shaking, oldest first. */
  pendingQuakes(): readonly QuakeEvent[] {
    return this.quakes;
  }

  /** The burning chunks, ascending. */
  burning(): number[] {
    return [...this.fires.keys()].sort((a, b) => a - b);
  }

  /** Bombs announced and not yet dropped: their impact points (spawn
   * avoidance). */
  pendingBombTargets(): Vec3[] {
    return [...this.bombs.values()].map((b) => b.to);
  }

  /** The welcome's replay. */
  state(now: number): WireChaosState {
    const runs = this.slot.runs.filter((r) => now <= runEnd(r) + RUN_TAIL_MS);
    const ids = new Set(runs.map((r) => r.id));
    return {
      runs: runs.map(encodeBomberRun),
      downs: this.slot.downs.filter((d) => ids.has(d.r)).map(encodeBomberDown),
      quakes: this.quakes.filter((q) => quakeLive(q, now)).map(encodeQuake),
      fires: encodeChunkIds(this.burning()),
    };
  }

  /** The room's city went back to whole (its last human left). */
  reset(): void {
    this.scanFrom = null;
    this.armed.fill(null);
    this.quakes = [];
    this.quakeDone.clear();
    this.fires.clear();
    this.firesOn = [];
    this.firesOff = [];
    this.bombs.clear();
    this.hp.clear();
    this.lastHit.clear();
    this.slot.runs.length = 0;
    this.slot.downs.length = 0;
  }

  /**
   * One tick: arm the slots that came round, try what is armed, re-check
   * the bombs dropping now, apply due quakes, and burn/spread the fires.
   */
  tick(
    now: number,
    planes: readonly ChaosPlane[],
    world: ChaosWorld,
  ): ChaosTick {
    const out: ChaosTick = {
      meteors: [],
      runs: [],
      bombsOff: [],
      quakes: [],
      broke: [],
      firesOn: [],
      firesOff: [],
    };
    this.prune(now);
    this.arm(now);
    const humans = planes.filter((p) => p.human && !world.budget.fresh(p, now));
    for (const layer of [CHAOS_METEOR, CHAOS_BOMBER, CHAOS_QUAKE] as const) {
      const a = this.armed[layer];
      if (!a || now < a.next) continue;
      if (now > a.until) {
        this.armed[layer] = null;
        continue;
      }
      const done =
        humans.length > 0 &&
        (layer === CHAOS_METEOR
          ? this.meteor(now, humans, planes, world, out)
          : layer === CHAOS_BOMBER
            ? this.bomberRun(now, humans, planes, world, out)
            : this.quake(now, humans, out));
      if (done) this.armed[layer] = null;
      else a.next = now + this.tuning.retryMs;
    }
    this.dropBombs(now, planes, world, out);
    for (const q of this.quakes) {
      if (q.t > now || this.quakeDone.has(q.id)) continue;
      this.quakeDone.add(q.id);
      out.broke.push(...this.applyQuake(q, planes, world.city));
    }
    if (this.tuning.fire && now >= this.nextFireTick) {
      this.nextFireTick = now + FIRE_SPREAD_MS;
      out.broke.push(...this.burn(now, planes, world.city));
    }
    out.firesOn = this.firesOn;
    out.firesOff = this.firesOff;
    this.firesOn = [];
    this.firesOff = [];
    return out;
  }

  private prune(now: number): void {
    const keep = this.slot.runs.filter((r) => now <= runEnd(r) + RUN_TAIL_MS);
    if (keep.length !== this.slot.runs.length) {
      const ids = new Set(keep.map((r) => r.id));
      this.slot.runs.splice(0, this.slot.runs.length, ...keep);
      const downs = this.slot.downs.filter((d) => ids.has(d.r));
      this.slot.downs.splice(0, this.slot.downs.length, ...downs);
      for (const key of [...this.hp.keys()]) {
        if (!ids.has(Number(key.split(":")[0]))) {
          this.hp.delete(key);
          this.lastHit.delete(key);
        }
      }
    }
    this.quakes = this.quakes.filter((q) => {
      if (quakeLive(q, now)) return true;
      this.quakeDone.delete(q.id);
      return false;
    });
  }

  /** Arm the latest slot of each layer that came round since last tick. */
  private arm(now: number): void {
    if (this.scanFrom === null) this.scanFrom = now;
    const s = this.tuning.slotScale;
    for (const layer of [CHAOS_METEOR, CHAOS_BOMBER, CHAOS_QUAKE] as const) {
      const slots = chaosSlotsInWindow(
        this.seed,
        layer as ChaosLayer,
        this.scanFrom / s,
        now / s,
      );
      const last = slots[slots.length - 1];
      if (last === undefined) continue;
      this.armed[layer] = {
        until: last * s + (this.tuning.patienceMs[layer] as number),
        next: 0,
      };
    }
    this.scanFrom = now;
  }

  // --- Meteors ---------------------------------------------------------------

  private meteor(
    now: number,
    humans: readonly ChaosPlane[],
    planes: readonly ChaosPlane[],
    world: ChaosWorld,
    out: ChaosTick,
  ): boolean {
    const rand = this.meteorRand;
    const city = world.city;
    let to: Vec3 | null = null;
    if (rand() < this.tuning.meteorNearShare) {
      const anchor = humans[Math.floor(rand() * humans.length)] as ChaosPlane;
      to =
        pickMissileTarget(
          rand,
          anchor,
          planes,
          world.index,
          12,
          METEOR_FLIGHT_MS,
        )?.to ?? null;
    } else {
      const b = city.buildings[Math.floor(rand() * city.buildings.length)];
      if (b && b.height >= 20) {
        const p = roofPoint(b, rand);
        // Never AT a plane, now or when it lands (X1's rule).
        const clear = planes.every(
          (pl) =>
            wrapDistance(pl.pos, p) >= 20 &&
            wrapDistance(predictedPos(pl, METEOR_FLIGHT_MS), p) >= 20,
        );
        if (clear) to = p;
      }
    }
    if (!to) return false;
    if (!world.budget.allows("meteor", [to], METEOR_FLIGHT_MS, now, planes)) {
      return false;
    }
    const m = planMeteor(
      rand,
      world.missiles.allocId(),
      to,
      now,
      city.buildings,
    );
    if (!m) return false;
    world.budget.charge("meteor", [m.to], METEOR_FLIGHT_MS, now, planes);
    world.missiles.inject(m);
    out.meteors.push(m);
    return true;
  }

  // --- Bomber runs -------------------------------------------------------------

  private bomberRun(
    now: number,
    humans: readonly ChaosPlane[],
    planes: readonly ChaosPlane[],
    world: ChaosWorld,
    out: ChaosTick,
  ): boolean {
    // One formation in the air at a time.
    if (this.slot.runs.some((r) => now < runEnd(r))) return false;
    const rand = this.bomberRand;
    const anchor = humans[Math.floor(rand() * humans.length)] as ChaosPlane;
    const first = Math.floor(rand() * 4);
    const city = world.city;
    for (let n = 0; n < 12; n++) {
      const dir = ((first + n) % 4) as 0 | 1 | 2 | 3;
      // This street line, then the ones either side of it.
      const shift = [0, 1, -1][Math.floor(n / 4)] as number;
      const alongX = dir === 0 || dir === 2;
      const at = {
        x: anchor.pos.x + (alongX ? 0 : shift * BLOCK_PITCH),
        y: 0,
        z: anchor.pos.z + (alongX ? shift * BLOCK_PITCH : 0),
      };
      const run = planBomberRun(
        this.nextRun,
        now,
        at,
        dir,
        -BOMB_THROW_M,
        city.buildings,
        world.obstacles,
      );
      if (!run) continue;
      const points = bombLinePoints(run);
      // Charged once per plane for the whole carpet; the drops are each
      // re-checked against fresh planes when they fall.
      if (!world.budget.allows("bomber", points, 0, now, planes)) continue;
      world.budget.charge("bomber", points, 0, now, planes);
      this.nextRun++;
      const bombs: MissileStrike[] = [];
      for (const d of bombDrops(run)) {
        // Straight down at the impact point: the city as it stands.
        const hit = raycastChunk(
          city.buildings,
          { x: d.x, y: d.from.y, z: d.z },
          { x: 0, y: -1, z: 0 },
          d.from.y + 1,
        );
        const y = hit
          ? Math.max(0, Math.round((d.from.y - hit.t) * 10) / 10)
          : 0;
        const m: MissileStrike = {
          id: world.missiles.allocId(),
          kind: "bomb",
          from: d.from,
          to: { x: d.x, y, z: d.z },
          t0: d.t,
        };
        world.missiles.inject(m);
        this.bombs.set(m.id, { run: run.id, k: d.k, t0: d.t, to: m.to });
        bombs.push(m);
      }
      for (let k = 0; k < BOMBER_COUNT; k++)
        this.hp.set(`${run.id}:${k}`, run.hp);
      this.slot.runs.push(run);
      out.runs.push({ run, bombs });
      return true;
    }
    return false;
  }

  /** Bombs whose drop came round: off the pending list, and called off when
   * a fresh plane would be under the blast. */
  private dropBombs(
    now: number,
    planes: readonly ChaosPlane[],
    world: ChaosWorld,
    out: ChaosTick,
  ): void {
    if (this.bombs.size === 0) return;
    const off = new Set<number>();
    for (const [id, b] of this.bombs) {
      if (b.t0 > now) continue;
      this.bombs.delete(id);
      const under = planes.some(
        (p) =>
          world.budget.fresh(p, now) &&
          world.budget.near(p, [b.to], BOMB_FALL_MS),
      );
      if (under) off.add(id);
    }
    if (off.size > 0) out.bombsOff.push(...world.missiles.cancel(off));
  }

  /** Ship `k` of run `runId` alive at `t`? */
  shipAlive(runId: number, k: number, t: number): boolean {
    const run = this.slot.runs.find((r) => r.id === runId);
    return !!run && bomberAlive(this.slot, run, k, t);
  }

  /**
   * One round on ship `k` of run `runId` by `shooter` at `now` (already
   * judged by claimBomberHit). Returns the ship's HP left, and — when that
   * was its last — its down and the bombs it will no longer drop (already
   * cancelled in `missiles`).
   */
  damageShip(
    runId: number,
    k: number,
    shooter: string,
    amount: number,
    now: number,
    missiles: MissileDirector,
  ): { hp: number; down: BomberDown | null; cancelled: number[] } | null {
    const key = `${runId}:${k}`;
    const hp = this.hp.get(key);
    if (hp === undefined || !(hp > 0)) return null;
    const left = Math.max(0, hp - amount);
    this.hp.set(key, left);
    this.lastHit.set(key, shooter);
    if (left > 0) return { hp: left, down: null, cancelled: [] };
    const down: BomberDown = { r: runId, k, t: now };
    this.slot.downs.push(down);
    const ids = new Set<number>();
    for (const [id, b] of this.bombs) {
      if (b.run === runId && b.k === k && b.t0 > now) {
        ids.add(id);
        this.bombs.delete(id);
      }
    }
    return { hp: 0, down, cancelled: missiles.cancel(ids) };
  }

  // --- Quakes ----------------------------------------------------------------

  private quake(
    now: number,
    humans: readonly ChaosPlane[],
    out: ChaosTick,
  ): boolean {
    const rand = this.quakeRand;
    const anchor = humans[Math.floor(rand() * humans.length)] as ChaosPlane;
    const q = planQuake(rand, this.nextQuake++, now, anchor.pos);
    this.quakes.push(q);
    out.quakes.push(q);
    return true;
  }

  /** The quake hits: seeded ground floors weakened city-wide, worn
   * buildings shaken harder — nothing breaking under a plane's reach, at
   * most quakeBreakMax chunks in all. Returns the chunks broken. */
  private applyQuake(
    q: QuakeEvent,
    planes: readonly ChaosPlane[],
    city: RoomCity,
  ): number[] {
    const t = this.tuning;
    const rand = mulberry32((this.seed ^ Math.imul(q.id, 0x2c1b3c6d)) >>> 0);
    const broke: number[] = [];
    const hit = (i: number, ids: readonly number[], amount: number) => {
      const b = city.buildings[i] as Building;
      const held = holdNear(b, planes);
      for (const id of ids) {
        if (broke.length >= t.quakeBreakMax) return;
        if (this.hurt(city, id, amount, held)) {
          broke.push(id);
          city.breakers.set(i, null);
        }
      }
    };
    // Worn buildings first: the ones a tremor can actually bring down.
    const wear = city.damage.wear();
    for (const i of [...wear.keys()].sort((a, b) => a - b)) {
      const b = city.buildings[i];
      if (!b) continue;
      const f = quakeFalloff(q, { x: b.x, y: 0, z: b.z });
      hit(i, groundFloor(b, i), t.quakeWornDamage * f);
    }
    for (let n = 0; n < t.quakeBuildings; n++) {
      const i = Math.floor(rand() * city.buildings.length);
      const b = city.buildings[i];
      if (!b) continue;
      const ids = groundFloor(b, i);
      const id = ids[Math.floor(rand() * ids.length)];
      if (id === undefined) continue;
      const f = quakeFalloff(q, { x: b.x, y: 0, z: b.z });
      hit(i, [id], t.quakeWeakenDamage * f);
    }
    return broke;
  }

  /** Take `amount` off chunk `id`, never breaking it while `held` (it
   * bottoms out at 1 HP). True when it broke. */
  private hurt(
    city: RoomCity,
    id: number,
    amount: number,
    held: boolean,
  ): boolean {
    if (city.damage.isGone(id)) return false;
    const a = held ? Math.min(amount, city.damage.hpOf(id) - 1) : amount;
    if (!(a > 0)) return false;
    return city.damage.damageChunk(id, a);
  }

  // --- Fire ------------------------------------------------------------------

  /** Chunks an impact just broke: each lights one standing neighbour (up to
   * FIRE_MAX burning in the room). Goes out in the next tick's batch. */
  ignite(broken: readonly number[], now: number, city: RoomCity): void {
    if (!this.tuning.fire) return;
    for (const id of broken) {
      if (this.fires.size >= FIRE_MAX) return;
      const next = fireNeighbours(city.buildings, id).filter(
        (n) => !city.damage.isGone(n) && !this.fires.has(n),
      );
      const pick = next[Math.floor(this.fireRand() * next.length)];
      if (pick === undefined) continue;
      this.fires.set(pick, { since: now });
      this.firesOn.push(pick);
    }
  }

  /** Building `index` was rebuilt: its fires are out. */
  rebuilt(index: number): void {
    for (const id of [...this.fires.keys()]) {
      if (chunkBuilding(id) !== index) continue;
      this.fires.delete(id);
      this.firesOff.push(id);
    }
  }

  /** One spread tick: burn every fire's chunk (held under a plane's reach),
   * put out the old and the fallen, spread the rest. Returns the chunks
   * fire broke. */
  private burn(
    now: number,
    planes: readonly ChaosPlane[],
    city: RoomCity,
  ): number[] {
    const broke: number[] = [];
    const held = new Map<number, boolean>();
    const heldFor = (i: number): boolean => {
      let h = held.get(i);
      if (h === undefined) {
        const b = city.buildings[i];
        h = b ? holdNear(b, planes) : true;
        held.set(i, h);
      }
      return h;
    };
    for (const id of [...this.fires.keys()].sort((a, b) => a - b)) {
      const f = this.fires.get(id) as Fire;
      if (city.damage.isGone(id) || now - f.since >= FIRE_LIFE_MS) {
        this.fires.delete(id);
        this.firesOff.push(id);
        continue;
      }
      const i = chunkBuilding(id);
      if (this.hurt(city, id, FIRE_CHUNK_DAMAGE, heldFor(i))) {
        broke.push(id);
        city.breakers.set(i, null);
        this.fires.delete(id);
        this.firesOff.push(id);
      }
      if (this.fires.size >= FIRE_MAX) continue;
      if (this.fireRand() >= FIRE_SPREAD_P) continue;
      const next = fireNeighbours(city.buildings, id).filter(
        (n) => !city.damage.isGone(n) && !this.fires.has(n),
      );
      const pick = next[Math.floor(this.fireRand() * next.length)];
      if (pick === undefined) continue;
      this.fires.set(pick, { since: now });
      this.firesOn.push(pick);
    }
    return broke;
  }
}

/** Building `b`'s ground-floor chunks (tier 0, the bottom band), ascending. */
function groundFloor(b: Building, index: number): number[] {
  const g = tierGrids(b)[0];
  if (!g) return [];
  const band = g.nx * g.nz;
  return chunksOf(b, index).filter(
    (id) => id < chunkId(index, 0, band) && id >= chunkId(index, 0, 0),
  );
}

/** In-flight strikes (missiles, meteors, bombs) landing within this, ms,
 * are hazards bots keep out of. */
const HAZARD_LEAD_MS = 5000;

/** The strikes about to land as warned-zone hazards for the bots
 * (RoomBots.setHazards): a box the blast reaches round each impact, from
 * HAZARD_LEAD_MS before it lands. Ids are negative so they never collide
 * with a director event's. */
export function strikeHazards(
  strikes: readonly MissileStrike[],
  now: number,
): DirectorEvent[] {
  const out: DirectorEvent[] = [];
  for (const m of strikes) {
    const at = missileImpactAt(m);
    if (at - now > HAZARD_LEAD_MS || at < now) continue;
    const r =
      (m.kind === "meteor" ? METEOR_BLAST_RADIUS : MISSILE_BLAST_RADIUS) + 10;
    out.push({
      id: -m.id,
      k: EVENT_GAS,
      b: -1,
      x: m.to.x,
      y: m.to.y,
      z: m.to.z,
      s: 0,
      d: 0,
      w: at - HAZARD_LEAD_MS,
      at,
      zone: { x0: -r, x1: r, z0: -r, z1: r, top: m.to.y + r },
    });
  }
  return out;
}

/** A round claimed on a bomber (the claim's line and time). */
export interface BomberHitClaim {
  run: number;
  k: number;
  seq: number;
  origin: Vec3;
  dir: Vec3;
  t: number;
}

/**
 * The server's judgement of a round a player says hit ship `k` of run
 * `run`: the bullet spent through Combat (existence, age, origin), its line
 * near the on-record nose, and — at the claimed time, held to the boss's
 * lookback — that ship the first thing on the line within BULLET_RANGE.
 * Then the damage. Null when refused.
 */
export function claimBomberHit(
  combat: Combat,
  chaos: ChaosDirector,
  missiles: MissileDirector,
  shooterId: string,
  claim: BomberHitClaim,
  shooterPos: Vec3,
  now: number,
  shooterCap?: SpeedCapFn,
): ReturnType<ChaosDirector["damageShip"]> {
  const { run, k, dir } = claim;
  if (!Number.isInteger(k) || k < 0 || k >= BOMBER_COUNT) return null;
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (!(Math.abs(len - 1) < 1e-3)) return null;
  const t = Math.min(now, Math.max(now - BOSS_CLAIM_LOOKBACK_MS, claim.t));
  if (!chaos.shipAlive(run, k, t)) return null;
  const bullet = combat.claimBullet(
    shooterId,
    claim.seq,
    claim.origin,
    shooterPos,
    now,
    shooterCap,
  );
  if (!bullet.ok) return null;
  if (bullet.dir) {
    const cos =
      bullet.dir.x * dir.x + bullet.dir.y * dir.y + bullet.dir.z * dir.z;
    if (cos < Math.cos(BOSS_DIR_CONE)) return null;
  }
  const first = bomberRayHit(chaos.slot, claim.origin, dir, BULLET_RANGE, t);
  if (!first || first.run !== run || first.k !== k) return null;
  return chaos.damageShip(run, k, shooterId, BULLET_DAMAGE, now, missiles);
}
