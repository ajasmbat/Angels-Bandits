// C2 constant chaos, server side: WHEN and WHERE meteors fall, quakes shake
// the city and fires spread — one ChaosDirector per room.
// index.ts and the bot-sim harness both drive exactly this, so the sim
// measures the chaos the live server stages. The shared, pure half (poses,
// boxes, schedules, wire) is common/src/chaos.ts.
//
// The rules:
//  - only while a human is in the room (index.ts's `breakable` gate), and
//    only around a human: meteors land near one 60 % of the time (else
//    anywhere in the city), quakes centre on one;
//  - every lethal thing — a meteor — must be allowed by the room's
//    DangerBudget (server/src/danger.ts) and is charged to it;
//  - meteors are MissileStrikes injected into the room's
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
  type BossTuning,
} from "@angels-bandits/common/boss";
import {
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
  chaosSlotsInWindow,
  encodeQuake,
  fireNeighbours,
  holdNear,
  planMeteor,
  planQuake,
  quakeFalloff,
  quakeLive,
  roofPoint,
} from "@angels-bandits/common/chaos";
import {
  type Building,
  chunkBuilding,
  chunkId,
  chunksOf,
  encodeChunkIds,
  mulberry32,
  tierGrids,
} from "@angels-bandits/common/city";
import { pickFireJump } from "@angels-bandits/common/city/props";
import {
  type CityIndex,
  forEachBuildingNear,
} from "@angels-bandits/common/collision";
import {
  DESTROY_CAP,
  DESTROY_CAP_D2,
  GONE_HOLD_SHARE,
} from "@angels-bandits/common/constants";
import {
  METEOR_FLIGHT_MS,
  type MissileStrike,
  pickMissileTarget,
  predictedPos,
} from "@angels-bandits/common/strike";
import {
  type Vec3,
  wrapCoord,
  wrapDistance,
} from "@angels-bandits/common/world";
import { BOMB_FAST_TUNING, BOMB_TUNING, type BombTuning } from "./bombs";
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
   * layer (meteor, quake). */
  retryMs: number;
  patienceMs: readonly [number, number];
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
  patienceMs: [3000, 10_000],
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
  patienceMs: [1500, 5000],
};

/** Every tuning the room's chaos reads, from the environment — the one seam
 * production rollback (`AB_CHAOS=0`) goes through. */
export interface ChaosTunings {
  /** W1: the carrier's schedule — the game loop, not a C2 layer, so
   * AB_CHAOS=0 leaves it alone. */
  boss: BossTuning;
  /** W1: the carrier war (the carrier and its enemy waves) on. AB_WAVES=0
   * turns it off server-wide — the real-server tests and the perf/QA tools
   * that need an empty sky. */
  waves: boolean;
  missile: DirectorTuning;
  director: DestructionTuning;
  /** The C2 layers (null: off). */
  chaos: ChaosTuning | null;
  /** The danger budget (null: none — the pre-C2 rules only). */
  danger: DangerTuning | null;
  /** The room city's DESTROY_CAP, and whether the gone-share hold runs. */
  destroyCap: number;
  hold: boolean;
  /** W2: the enemy planes' bomb runs — part of the carrier war, not a C2
   * layer, so AB_CHAOS=0 leaves them alone (AB_BOMBS_FAST=1: QA pace). */
  bombs: BombTuning;
}

/**
 * The tunings for an environment. `AB_CHAOS=0` restores every pre-C2 chaos
 * value exactly (X1's strikes, D5's director, D2's cap) and switches the C2
 * layers, the budget and the hold off; the `*_FAST` flags (tests and QA
 * only) work either way. The carrier keeps W1's schedule under either.
 */
export function chaosTunings(
  env: Readonly<Record<string, string | undefined>>,
): ChaosTunings {
  const off = env.AB_CHAOS === "0";
  return {
    boss: env.AB_BOSS_FAST === "1" ? BOSS_FAST_TUNING : BOSS_TUNING,
    waves: env.AB_WAVES !== "0",
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
    bombs: env.AB_BOMBS_FAST === "1" ? BOMB_FAST_TUNING : BOMB_TUNING,
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
  /** The room's missile director: meteors ride its pipeline. */
  missiles: MissileDirector;
  budget: DangerBudget;
  index: CityIndex;
}

/** What one tick produced, in broadcast order. */
export interface ChaosTick {
  /** Meteors launched (already injected) — broadcast as `missile`. */
  meteors: MissileStrike[];
  /** Quakes warned this tick — `quake`. */
  quakes: QuakeEvent[];
  /** Chunks quakes and fire broke this tick (they ride the `chunks`
   * batch; listed for the caller's telemetry). */
  broke: number[];
  /** Fires lit / out since the last tick — one `fires` batch. */
  firesOn: number[];
  firesOff: number[];
}

interface Fire {
  since: number;
}

export class ChaosDirector {
  private scanFrom: number | null = null;
  private readonly armed: ({ until: number; next: number } | null)[] = [
    null,
    null,
  ];
  private quakes: QuakeEvent[] = [];
  private readonly quakeDone = new Set<number>();
  private readonly fires = new Map<number, Fire>();
  private firesOn: number[] = [];
  private firesOff: number[] = [];
  private nextFireTick = 0;
  private nextQuake = 1;
  private readonly meteorRand: () => number;
  private readonly quakeRand: () => number;
  private readonly fireRand: () => number;

  constructor(
    private readonly seed: number,
    private readonly tuning: ChaosTuning = CHAOS_TUNING,
  ) {
    // One salted stream per layer: a layer's draws never shift another's.
    this.meteorRand = mulberry32((seed ^ 0x6e7e0a5) >>> 0);
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

  /** The welcome's replay. */
  state(now: number): WireChaosState {
    return {
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
  }

  /**
   * One tick: arm the slots that came round, try what is armed, apply due
   * quakes, and burn/spread the fires.
   */
  tick(
    now: number,
    planes: readonly ChaosPlane[],
    world: ChaosWorld,
  ): ChaosTick {
    const out: ChaosTick = {
      meteors: [],
      quakes: [],
      broke: [],
      firesOn: [],
      firesOff: [],
    };
    this.prune(now);
    this.arm(now);
    const humans = planes.filter((p) => p.human && !world.budget.fresh(p, now));
    for (const layer of [CHAOS_METEOR, CHAOS_QUAKE] as const) {
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
          : this.quake(now, humans, out));
      if (done) this.armed[layer] = null;
      else a.next = now + this.tuning.retryMs;
    }
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
    for (const layer of [CHAOS_METEOR, CHAOS_QUAKE] as const) {
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
    if (
      to &&
      !world.budget.allows("meteor", [to], METEOR_FLIGHT_MS, now, planes)
    ) {
      to = null;
    }
    // Refused (or nothing clear): a roof near the action but away from
    // every plane — the shower keeps falling where the fight can see it.
    if (!to) to = this.actionRoof(humans, planes, world, now);
    if (!to) return false;
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

  /** A roof 120–400 m from a random human that the budget allows (in
   * practice: no plane within its reach), or null. */
  private actionRoof(
    humans: readonly ChaosPlane[],
    planes: readonly ChaosPlane[],
    world: ChaosWorld,
    now: number,
  ): Vec3 | null {
    const rand = this.meteorRand;
    const anchor = humans[Math.floor(rand() * humans.length)] as ChaosPlane;
    const buildings = world.city.buildings;
    for (let n = 0; n < 10; n++) {
      const a = rand() * Math.PI * 2;
      const r = 120 + 280 * rand();
      let best: Building | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      const probe = {
        x: wrapCoord(anchor.pos.x + Math.cos(a) * r),
        y: 0,
        z: wrapCoord(anchor.pos.z + Math.sin(a) * r),
      };
      forEachBuildingNear(world.index, probe, 40, (i) => {
        const b = buildings[i] as Building;
        const d = wrapDistance({ x: b.x, y: 0, z: b.z }, probe);
        if (b.height >= 20 && d < bestD) {
          bestD = d;
          best = b;
        }
      });
      if (!best) continue;
      const p = roofPoint(best, rand);
      if (world.budget.allows("meteor", [p], METEOR_FLIGHT_MS, now, planes)) {
        return p;
      }
    }
    return null;
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
      // D9: and it jumps to a damaged neighbour (common/src/city/props.ts).
      const jump =
        this.fires.size < FIRE_MAX
          ? pickFireJump(city.buildings, id, this.fireRand)
          : -1;
      if (jump >= 0 && !this.fires.has(jump) && !city.damage.isGone(jump)) {
        this.fires.set(jump, { since: now });
        this.firesOn.push(jump);
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
