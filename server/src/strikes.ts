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
//  - each AREA (a 250 m cell) fires at most every 20–40 s, the first one
//    4–12 s after it goes active, stretched as the city nears DESTROY_CAP;
//  - city-wide, at most MAX_IN_FLIGHT missiles in the air and a gap between
//    launches;
//  - no target near a respawn from the last 5 s, and no plane takes missile
//    damage within 5 s of (re)spawning — whichever came first;
//  - the target itself is never a plane (common/src/strike.ts picker), and
//    the arc must clear the city as it stands.

import { type Building, chunkBuilding } from "@angels-bandits/common/city";
import type { CityIndex } from "@angels-bandits/common/collision";
import { DESTROY_CAP, WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  MISSILE_CHUNK_DAMAGE,
  MISSILE_CHUNK_RADIUS,
  type MissilePlane,
  type MissileStrike,
  missileDamage,
  missileImpactAt,
  pickMissileTarget,
  planMissile,
} from "@angels-bandits/common/strike";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
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

export const DEFAULT_TUNING: DirectorTuning = {
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
};

/** AB_MISSILE_FAST=1 (tests and QA only): strikes come quickly. */
export const FAST_TUNING: DirectorTuning = {
  ...DEFAULT_TUNING,
  dwellMs: 1000,
  firstMinMs: 0,
  firstMaxMs: 500,
  areaMinMs: 6000,
  areaMaxMs: 8000,
  minGapMs: 1000,
};

/** Area cells per world side (250 m cells). */
const AREA_CELLS = 8;
const AREA_M = WORLD_SIZE / AREA_CELLS;
const areaOf = (p: Vec3): number =>
  (Math.floor(p.x / AREA_M) % AREA_CELLS) * AREA_CELLS +
  (Math.floor(p.z / AREA_M) % AREA_CELLS);

/** No launches once the destroyed share reaches this part of DESTROY_CAP. */
const EROSION_STOP = 0.8;

/** One plane as the director sees it this tick. */
export interface DirectorPlane extends MissilePlane {
  id: string;
  human: boolean;
  /** May draw fire: not on a timed course run (the caller already left
   * out pending, away and dead planes). */
  eligible: boolean;
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

    if (this.inFlight.length >= t.maxInFlight) return null;
    if (now - this.lastLaunch < t.minGapMs) return null;
    const erosion = world.destroyedShare / (DESTROY_CAP * EROSION_STOP);
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
      const damage = missileDamage(wrapDistance(p.pos, m.to));
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
    const strike = planMissile(
      this.rand,
      this.nextId,
      target,
      now,
      world.buildings,
    );
    if (strike) this.nextId++;
    return strike;
  }
}

/** A missile landed: blow out the room city's chunks around the impact
 * (D2's damage API, so D3 collapses ride the same destroyed set). Returns
 * the chunks destroyed. Call once per settled missile. */
export function applyMissileImpact(city: RoomCity, m: MissileStrike): number[] {
  const out = city.damage.damageAt(
    m.to,
    MISSILE_CHUNK_RADIUS,
    MISSILE_CHUNK_DAMAGE,
  );
  // D3: a collapse a missile sets off is the environment's — nobody's.
  for (const id of out) city.breakers.set(chunkBuilding(id), null);
  return out;
}
