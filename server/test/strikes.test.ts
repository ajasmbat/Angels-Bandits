// X1 missile strikes, server side: the director's launch rules and the
// impact's bookkeeping. Spec literals from the ticket (C2's cadence): ≤ one
// launch per 4–8 s per area, a city-wide cap, never within 5 s of a nearby respawn,
// D2 chunk damage exactly once, and missile damage that never stretches a
// shooter's kill credit (8 s DAMAGE_MEMORY_MS).

import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import { buildCityIndex } from "@angels-bandits/common/collision";
import { CITY_SEED, WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  MISSILE_LETHAL_RADIUS,
  type MissileStrike,
  missileImpactAt,
} from "@angels-bandits/common/strike";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { nearBuildingProbe } from "../src/cityevents";
import { Combat } from "../src/combat";
import { createRoomCity } from "../src/destruction";
import {
  DEFAULT_TUNING,
  type DirectorPlane,
  type DirectorWorld,
  FAST_TUNING,
  MissileDirector,
  X1_TUNING,
  applyMissileImpact,
} from "../src/strikes";

const seedCity = generateCity(CITY_SEED);
const near = nearBuildingProbe(seedCity);

/** A human hovering (zero velocity) beside a building, `n`-th of a seeded
 * set — near buildings, low, so it always draws fire. */
function hoverers(count: number, seed: number): DirectorPlane[] {
  const rand = mulberry32(seed);
  const out: DirectorPlane[] = [];
  while (out.length < count) {
    const b = seedCity[Math.floor(rand() * seedCity.length)];
    if (!b || b.height < 40) continue;
    const pos = {
      x: (b.x + b.width / 2 + 15 + WORLD_SIZE) % WORLD_SIZE,
      y: 30,
      z: b.z,
    };
    if (!near(pos)) continue;
    out.push({
      id: `p${out.length}`,
      pos,
      vel: { x: 0, y: 0, z: 0 },
      human: true,
      eligible: true,
    });
  }
  return out;
}

function roomWorld() {
  const rc = createRoomCity(seedCity);
  const world: DirectorWorld = {
    nearBuilding: nearBuildingProbe(rc.buildings),
    index: buildCityIndex(rc.buildings),
    buildings: rc.buildings,
    destroyedShare: 0,
  };
  return { rc, world };
}

/** Tick a director at 20 Hz until it launches (or `maxMs` passes). */
function untilLaunch(
  director: MissileDirector,
  planes: DirectorPlane[],
  world: DirectorWorld,
  from: number,
  maxMs = 60_000,
): { strike: MissileStrike; at: number } | null {
  for (let t = from; t <= from + maxMs; t += 50) {
    const strike = director.tick(t, planes, world);
    if (strike) return { strike, at: t };
  }
  return null;
}

describe("applyMissileImpact via settle", () => {
  it("applies D2 chunk damage exactly once per missile", () => {
    const { rc, world } = roomWorld();
    const director = new MissileDirector(mulberry32(7), FAST_TUNING);
    const planes = hoverers(1, 11);
    const launch = untilLaunch(director, planes, world, 0);
    expect(launch).not.toBeNull();
    const m = (launch as { strike: MissileStrike }).strike;
    const impact = missileImpactAt(m);

    expect(director.settle(impact - 1)).toEqual([]); // not due yet
    const due = director.settle(impact);
    expect(due).toEqual([m]);
    // The same tick asks again (a second settle, a re-entrant tick): nothing.
    expect(director.settle(impact)).toEqual([]);
    expect(director.settle(impact + 10_000)).toEqual([]);

    let destroyed = 0;
    for (const d of due) destroyed += applyMissileImpact(rc, d).length;
    expect(destroyed).toBeGreaterThan(0);
    expect(rc.damage.destroyedCount).toBe(destroyed);
    expect(rc.damage.takeDestroyed()).toHaveLength(destroyed); // one batch

    // The very same blast on an untouched copy breaks the same chunks.
    const fresh = createRoomCity(seedCity);
    expect(applyMissileImpact(fresh, m).length).toBe(destroyed);
  });
});

describe("MissileDirector cadence", () => {
  it("stays capped: ≤ 8 in the air, ≥ 0.75 s apart, ≤ one per area per 4 s", () => {
    const { world } = roomWorld();
    const director = new MissileDirector(mulberry32(42));
    const planes = hoverers(12, 3);
    const launches: { at: number; area: string; strike: MissileStrike }[] = [];
    const areaOf = (p: Vec3) =>
      `${Math.floor(p.x / 250)}:${Math.floor(p.z / 250)}`;
    let maxInFlight = 0;
    const MINUTES = 10;
    for (let t = 0; t < MINUTES * 60_000; t += 50) {
      director.settle(t);
      const strike = director.tick(t, planes, world);
      if (strike) {
        // The area is the subject's: the nearest hoverer to the target.
        const subject = planes.reduce((a, b) =>
          wrapDistance(a.pos, strike.to) < wrapDistance(b.pos, strike.to)
            ? a
            : b,
        );
        launches.push({ at: t, area: areaOf(subject.pos), strike });
      }
      maxInFlight = Math.max(maxInFlight, director.missiles().length);
    }
    expect(launches.length).toBeGreaterThan(10);
    expect(maxInFlight).toBeLessThanOrEqual(DEFAULT_TUNING.maxInFlight);
    for (let i = 1; i < launches.length; i++) {
      const gap =
        (launches[i] as { at: number }).at -
        (launches[i - 1] as { at: number }).at;
      expect(gap).toBeGreaterThanOrEqual(DEFAULT_TUNING.minGapMs);
    }
    // Hard ceiling from the city-wide gap, and well under it in practice.
    expect(launches.length).toBeLessThanOrEqual(
      (MINUTES * 60_000) / DEFAULT_TUNING.minGapMs,
    );
    expect(DEFAULT_TUNING.maxInFlight).toBe(8);
    expect(DEFAULT_TUNING.minGapMs).toBe(750);
    expect(DEFAULT_TUNING.areaMinMs).toBe(4000);
    expect(DEFAULT_TUNING.areaMaxMs).toBe(8000);
    const byArea = new Map<string, number[]>();
    for (const l of launches)
      byArea.set(l.area, [...(byArea.get(l.area) ?? []), l.at]);
    for (const times of byArea.values()) {
      for (let i = 1; i < times.length; i++) {
        expect(
          (times[i] as number) - (times[i - 1] as number),
        ).toBeGreaterThanOrEqual(DEFAULT_TUNING.areaMinMs);
      }
    }
  });

  it("keeps striking at the destruction cap — the city's hold, not silence, is the brake", () => {
    const { rc, world } = roomWorld();
    const director = new MissileDirector(mulberry32(5), FAST_TUNING);
    const planes = hoverers(4, 9);
    const launch = untilLaunch(
      director,
      planes,
      { ...world, destroyedShare: 0.24 },
      0,
    );
    expect(launch).not.toBeNull();
    // With the room holding (C2 gone-share backstop) it lands and breaks
    // nothing; X1's own tuning still went quiet that close to its cap.
    rc.damage.hold = true;
    const m = (launch as { strike: MissileStrike }).strike;
    expect(applyMissileImpact(rc, m)).toEqual([]);
    const x1 = new MissileDirector(mulberry32(5), X1_TUNING);
    expect(
      untilLaunch(x1, planes, { ...world, destroyedShare: 0.24 }, 0),
    ).toBeNull();
  });

  it("only lets a bot draw fire with a human near it", () => {
    const { world } = roomWorld();
    const bot = {
      ...(hoverers(1, 21)[0] as DirectorPlane),
      id: "bot:a",
      human: false,
    };
    const lonely = new MissileDirector(mulberry32(3), FAST_TUNING);
    expect(untilLaunch(lonely, [bot], world, 0, 30_000)).toBeNull();
    const watched = new MissileDirector(mulberry32(3), FAST_TUNING);
    const human = { ...bot, id: "h", human: true, pos: { ...bot.pos, y: 300 } };
    expect(untilLaunch(watched, [bot, human], world, 0, 30_000)).not.toBeNull();
  });
});

describe("the respawn rule (never within 5 s of a nearby respawn)", () => {
  it("launches nothing near a respawn from the last 5 s", () => {
    const { world } = roomWorld();
    const director = new MissileDirector(mulberry32(17), FAST_TUNING);
    const planes = hoverers(1, 31);
    const subject = planes[0] as DirectorPlane;
    // Someone respawns right beside the subject at t = 0.
    director.noteSpawn("x", subject.pos, 0);
    for (let t = 0; t < 5000; t += 50) {
      const strike = director.tick(t, planes, world);
      if (strike) {
        expect(wrapDistance(strike.to, subject.pos)).toBeGreaterThanOrEqual(
          150,
        );
      }
    }
    // After the window the area is fair game again.
    expect(untilLaunch(director, planes, world, 5000)).not.toBeNull();
  });

  it("deals no damage to a plane that respawned at the target under 5 s before impact", () => {
    const { world } = roomWorld();
    const director = new MissileDirector(mulberry32(17), FAST_TUNING);
    const launch = untilLaunch(director, hoverers(1, 31), world, 0);
    const m = (launch as { strike: MissileStrike }).strike;
    const impact = missileImpactAt(m);
    // Launched first, THEN a plane spawns at the impact point 1 s before.
    director.noteSpawn("fresh", m.to, impact - 1000);
    director.noteSpawn("old", m.to, impact - 6000);
    const at = [
      { id: "fresh", pos: { ...m.to } },
      { id: "old", pos: { ...m.to } },
    ];
    const victims = director.blastVictims(m, at, impact);
    expect(victims.map((v) => v.id)).toEqual(["old"]);
    // Inside the lethal radius it is lethal; the fresh plane is untouched.
    expect((victims[0] as { damage: number }).damage).toBeGreaterThanOrEqual(
      100,
    );
    const edge = director.blastVictims(
      m,
      [{ id: "old", pos: { ...m.to, y: m.to.y + MISSILE_LETHAL_RADIUS + 20 } }],
      impact,
    );
    expect((edge[0] as { damage: number }).damage).toBeLessThan(100);
  });
});

describe("Combat.environmentDamage (missile blasts)", () => {
  const at = { x: 0, y: 100, z: 0 };
  /** p0 lands one validated hit on p1 at 6000 (past spawn protection). */
  const arena = (): Combat => {
    const combat = new Combat();
    combat.addPlayer("p0", 0);
    combat.addPlayer("p1", 0);
    expect(combat.fire("p0", 1, 6000).ok).toBe(true);
    expect(combat.hit("p0", "p1", 1, at, at, at, 6000).ok).toBe(true);
    return combat;
  };

  it("never stretches an earlier shooter's kill credit", () => {
    const combat = arena();
    // A non-lethal blast 7 s after the hit, a lethal one 9 s after it.
    expect(combat.environmentDamage("p1", 20, 13_000)?.death).toBeNull();
    const hit = combat.environmentDamage("p1", 100, 15_000);
    expect(hit?.death).toEqual({
      victimId: "p1",
      killerId: null,
      cause: "missile",
    });
    expect(combat.scoreOf("p0").kills).toBe(0);
  });

  it("pays the last damager within 8 s (the crash rule), cause missile", () => {
    const combat = arena();
    const hit = combat.environmentDamage("p1", 100, 13_000);
    expect(hit?.death).toEqual({
      victimId: "p1",
      killerId: "p0",
      cause: "missile",
    });
  });

  it("respects spawn protection and holds off regen", () => {
    const combat = new Combat();
    combat.addPlayer("p", 0);
    expect(combat.environmentDamage("p", 50, 1000)).toBeNull(); // protected
    expect(combat.environmentDamage("p", 50, 6000)?.hp).toBe(50);
    combat.tick(6000);
    combat.tick(9000); // inside the regen delay since the blast
    expect(combat.hpOf("p")).toBe(50);
  });
});
