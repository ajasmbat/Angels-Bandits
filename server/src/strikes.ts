// X1 missile strikes, server side: WHEN and WHERE a missile comes in, and
// what its impact breaks. One MissileDirector per room. index.ts and the
// bot-sim harness both drive exactly this, so the sim measures the strikes
// the live server launches.
//
// The rules, in the order they gate a launch:
//  - a SUBJECT is a living plane in the air (not booting, not away, not on a
//    timed course run) that has stayed within 60 m of buildings (the L1
//    nearBuildingProbe) for more than MISSILE_DWELL_MS; a bot is a subject
//    only with a human near it — strikes are for the fight someone watches;
//  - each AREA (a 250 m cell) fires every 4–8 s (C2 constant chaos; X1
//    shipped 20–40 s), the first one 1–4 s after it goes active;
//  - city-wide, at most maxInFlight missiles in the air and a gap between
//    launches (meteors the C2 chaos director injects ride the same
//    settle/landing path but never count against either);
//  - C2: the room's DangerBudget (server/src/danger.ts) must allow it — at
//    most two missiles near one plane per 30 s, among four lethal events;
//  - no target near a respawn from the last 5 s, and no plane takes missile
//    damage within 5 s of (re)spawning — whichever came first;
//  - the target itself is never a plane (common/src/strike.ts picker), and
//    the arc must clear the city as it stands.

import { type Building, chunkBuilding } from "@angels-bandits/common/city";
import type { CityIndex } from "@angels-bandits/common/collision";
import { DESTROY_CAP_D2, WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  type MissilePlane,
  type MissileStrike,
  missileChunkDamage,
  missileDamage,
  missileFlightMs,
  missileImpactAt,
  pickMissileTarget,
  planMissile,
} from "@angels-bandits/common/strike";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import type { DangerBudget } from "./danger";
import type { RoomCity } from "./destruction";

export interface DirectorTuning {
  /** Continuous time near buildings before a plane draws fire, ms. */
  dwellMs: number;
  /** First strike in a freshly active area, ms after it goes active. */
  firstMinMs: number;
  firstMaxMs: number;
  /** Between strikes in one area, ms. */
  areaMinMs: number;
  areaMaxMs: number;
  /** An area quiet this long is "fresh" again, ms. */
  areaIdleMs: number;
  /** City-wide cap on missiles in the air, and the gap between launches. */
  maxInFlight: number;
  minGapMs: number;
  /** A bot draws fire only with a human within this, m. */
  botHumanRangeM: number;
  /** Respawn quiet rule: radius, m, and window, ms. */
  respawnClearM: number;
  respawnQuietMs: number;
}

/** C2 constant chaos: roughly one strike every 4–8 s per active area. */
export const DEFAULT_TUNING: DirectorTuning = {
  dwellMs: 3000,
  firstMinMs: 1000,
  firstMaxMs: 4000,
  areaMinMs: 4000,
  areaMaxMs: 8000,
  areaIdleMs: 30_000,
  maxInFlight: 8,
  minGapMs: 750,
  botHumanRangeM: 400,
  respawnClearM: 150,
  respawnQuietMs: 5000,
};

/** X1 as it shipped, before C2 (AB_CHAOS=0 restores it): one per area every
 * 20–40 s, three in the air, 4 s apart, slowing as the city erodes. */
export const X1_TUNING: DirectorTuning & { erosion: true } = {
  dwellMs: 3000,
  firstMinMs: 4000,
  firstMaxMs: 12_000,
  areaMinMs: 20_000,
  areaMaxMs: 40_000,
  areaIdleMs: 30_000,
  maxInFlight: 3,
  minGapMs: 4000,
  botHumanRangeM: 400,
  respawnClearM: 150,
  respawnQuietMs: 5000,
  erosion: true,
};

/** AB_MISSILE_FAST=1 (tests and QA only): strikes come quickly. */
export const FAST_TUNING: DirectorTuning = {
  ...DEFAULT_TUNING,
  dwellMs: 1000,
  firstMinMs: 0,
  firstMaxMs: 500,
  areaMinMs: 2000,
  areaMaxMs: 3000,
  minGapMs: 500,
};

/** Area cells per world side (250 m cells). */
const AREA_CELLS = 8;
const AREA_M = WORLD_SIZE / AREA_CELLS;
const areaOf = (p: Vec3): number =>
  (Math.floor(p.x / AREA_M) % AREA_CELLS) * AREA_CELLS +
  (Math.floor(p.z / AREA_M) % AREA_CELLS);

/** X1_TUNING only: no launches once the destroyed share reaches this part
 * of D2's DESTROY_CAP, and gaps stretched on the way there. C2 drops it — the
 * room's gone-share hold (CityDamage.hold) is the brake, so strikes keep
 * coming and simply break nothing more. */
const EROSION_STOP = 0.8;
const erodes = (t: DirectorTuning): boolean =>
  (t as { erosion?: boolean }).erosion === true;

/** Strikes the director launched itself (meteors are injected). */
const launched = (m: MissileStrike): boolean =>
  m.kind === "cruise" || m.kind === "artillery";

/** One plane as the director sees it this tick. */
export interface DirectorPlane extends MissilePlane {
  id: string;
  human: boolean;
  /** May draw fire: not on a timed course run (the caller already left
   * out pending, away and dead planes). */
  eligible: boolean;
  /** Spawn-protected right now (the danger budget leaves it alone). */
  prot?: boolean;
}

/** The room's world as the director reads it. */
export interface DirectorWorld {
  /** Within 60 m of a building's solids (the L1 probe). */
  nearBuilding: (pos: Vec3) => boolean;
  /** Target picking (the seed city's index). */
  index: CityIndex;
  /** Path clearance: the room's buildings as they stand. */
  buildings: readonly Building[];
  /** Destroyed chunks / all chunks in the room's city. */
  destroyedShare: number;
  /** C2: the room's danger budget (absent: none — X1 as it shipped). */
  budget?: DangerBudget;
}

interface Area {
  nextAt: number;
  lastActive: number;
}

export class MissileDirector {
  private readonly dwell = new Map<string, number>();
  private readonly areas = new Map<number, Area>();
  private readonly spawns = new Map<string, { pos: Vec3; t: number }>();
  private inFlight: MissileStrike[] = [];
  private lastLaunch = Number.NEGATIVE_INFINITY;
  private nextId = 1;

  constructor(
    private readonly rand: () => number,
    private readonly tuning: DirectorTuning = DEFAULT_TUNING,
  ) {}

  /** Missiles in the air, oldest first (the welcome's replay). */
  missiles(): readonly MissileStrike[] {
    return this.inFlight;
  }

  /** C2: a fresh id from the room's ONE strike id space — meteors share
   * it, so a client's missile map never confuses two strikes. */
  allocId(): number {
    return this.nextId++;
  }

  /** C2: a meteor the chaos director planned (its id from
   * allocId): it lands through settle() like any missile, but never counts
   * against maxInFlight or the launch gap. */
  inject(strike: MissileStrike): void {
    this.inFlight.push(strike);
  }

  /** A plane (re)spawned or came back at `pos`: its area stays quiet and it
   * takes no missile damage for the respawn window. */
  noteSpawn(id: string, pos: Vec3, now: number): void {
    this.spawns.set(id, { pos: { ...pos }, t: now });
    this.dwell.delete(id);
  }

  /** A plane left the room or died: forget its dwell. */
  forget(id: string): void {
    this.dwell.delete(id);
  }

  /** Spawned less than the quiet window ago. */
  freshlySpawned(id: string, now: number): boolean {
    const s = this.spawns.get(id);
    return s !== undefined && now - s.t < this.tuning.respawnQuietMs;
  }

  /**
   * One tick: update every plane's dwell, then launch at most one missile.
   * `planes` are the living planes in the air. Returns the launch, or null.
   */
  tick(
    now: number,
    planes: readonly DirectorPlane[],
    world: DirectorWorld,
  ): MissileStrike | null {
    const t = this.tuning;
    for (const [id, s] of this.spawns) {
      if (now - s.t >= t.respawnQuietMs) this.spawns.delete(id);
    }
    const subjects: DirectorPlane[] = [];
    const seen = new Set<string>();
    for (const p of planes) {
      seen.add(p.id);
      if (!p.eligible || !world.nearBuilding(p.pos)) {
        this.dwell.delete(p.id);
        continue;
      }
      const since = this.dwell.get(p.id) ?? now;
      this.dwell.set(p.id, since);
      if (now - since < t.dwellMs) continue;
      if (
        !p.human &&
        !planes.some(
          (h) => h.human && wrapDistance(h.pos, p.pos) <= t.botHumanRangeM,
        )
      ) {
        continue;
      }
      subjects.push(p);
    }
    for (const id of this.dwell.keys())
      if (!seen.has(id)) this.dwell.delete(id);

    // Areas with a subject in them are active; a fresh one arms its first.
    const active: { area: number; subject: DirectorPlane }[] = [];
    for (const p of subjects) {
      const key = areaOf(p.pos);
      let area = this.areas.get(key);
      if (!area || now - area.lastActive > t.areaIdleMs) {
        area = {
          nextAt:
            now + t.firstMinMs + (t.firstMaxMs - t.firstMinMs) * this.rand(),
          lastActive: now,
        };
        this.areas.set(key, area);
      }
      area.lastActive = now;
      if (!active.some((a) => a.area === key))
        active.push({ area: key, subject: p });
    }

    let flying = 0;
    for (const m of this.inFlight) if (launched(m)) flying++;
    if (flying >= t.maxInFlight) return null;
    if (now - this.lastLaunch < t.minGapMs) return null;
    const erosion = erodes(t)
      ? world.destroyedShare / (DESTROY_CAP_D2 * EROSION_STOP)
      : 0;
    if (erosion >= 1) return null;

    for (const { area: key, subject } of active) {
      const area = this.areas.get(key) as Area;
      if (now < area.nextAt) continue;
      const strike = this.launchAt(now, subject, planes, world);
      if (!strike) {
        area.nextAt = now + 1000; // nothing clear here right now: retry
        continue;
      }
      const gap = t.areaMinMs + (t.areaMaxMs - t.areaMinMs) * this.rand();
      area.nextAt = now + gap / (1 - erosion);
      this.lastLaunch = now;
      this.inFlight.push(strike);
      return strike;
    }
    return null;
  }

  /** Every missile due by `now`, each handed back exactly once. */
  settle(now: number): MissileStrike[] {
    const due: MissileStrike[] = [];
    const left: MissileStrike[] = [];
    for (const m of this.inFlight) {
      (missileImpactAt(m) <= now ? due : left).push(m);
    }
    this.inFlight = left;
    return due;
  }

  /**
   * Who missile `m` hurts and by how much: every plane in MISSILE_BLAST_RADIUS
   * (by `pos` — the caller extrapolates on-record poses to the impact) that
   * did not (re)spawn within the quiet window. Spawn protection is the
   * Combat's own check on top.
   */
  blastVictims(
    m: MissileStrike,
    planes: readonly { id: string; pos: Vec3 }[],
    now: number,
  ): { id: string; damage: number }[] {
    const out: { id: string; damage: number }[] = [];
    for (const p of planes) {
      if (this.freshlySpawned(p.id, now)) continue;
      const damage = missileDamage(wrapDistance(p.pos, m.to), m.kind);
      if (damage > 0) out.push({ id: p.id, damage });
    }
    return out;
  }

  private launchAt(
    now: number,
    subject: DirectorPlane,
    planes: readonly DirectorPlane[],
    world: DirectorWorld,
  ): MissileStrike | null {
    const target = pickMissileTarget(this.rand, subject, planes, world.index);
    if (!target) return null;
    for (const s of this.spawns.values()) {
      if (wrapDistance(s.pos, target.to) < this.tuning.respawnClearM) {
        return null;
      }
    }
    // C2: the danger budget, asked before the (costlier) path sweep.
    const lead = missileFlightMs("cruise");
    if (
      world.budget &&
      !world.budget.allows("missile", [target.to], lead, now, planes)
    ) {
      return null;
    }
    const strike = planMissile(
      this.rand,
      this.nextId,
      target,
      now,
      world.buildings,
    );
    if (strike) {
      this.nextId++;
      world.budget?.charge("missile", [strike.to], lead, now, planes);
    }
    return strike;
  }
}

/** A missile landed: blow out the room city's chunks around the impact
 * (D2's damage API, so D3 collapses ride the same destroyed set). Returns
 * the chunks destroyed. Call once per settled missile. */
export function applyMissileImpact(city: RoomCity, m: MissileStrike): number[] {
  const { radius, damage } = missileChunkDamage(m.kind);
  const out = city.damage.damageAt(m.to, radius, damage);
  // D3: a collapse a missile sets off is the environment's — nobody's.
  for (const id of out) city.breakers.set(chunkBuilding(id), null);
  return out;
}
