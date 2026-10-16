// Z1 airship fleet, server side (server/src/boss.ts): the director keeps a
// ship on every lane and refills a downed one out of sight; only the armed
// ships' turrets fire, under the bots' fairness rules and the per-plane
// cap; a hit claim is judged like a plane hit plus the round's line; credit
// pays real damage only; launches spread across the fleet; and a crash is
// the D4 path into D3 collapses — the same way every time.

import {
  BOSS_FLAK_DPS_CAP,
  BOSS_FLAK_INTERVAL_MS,
  BOSS_FLAK_REACTION_MS,
  type BossFlak,
  FLEET_FAST_TUNING,
  FLEET_FLAK_SCALE,
  FLEET_HIDE_M,
  FLEET_LANES,
  FLEET_SIZE,
  FLEET_TUNING,
  FLEET_WEAK_MULT,
  type FleetShip,
  type FleetTuning,
  SHIP_CLASSES,
  blankPose,
  bossSpawnClear,
  fleetPoseAt,
  shipClass,
  shipCrash,
  shipFullHp,
  shipPresent,
  weakPointInto,
} from "@angels-bandits/common/boss";
import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import {
  BULLET_DAMAGE,
  CITY_SEED,
  MAX_HP,
} from "@angels-bandits/common/constants";
import { MedalLedger } from "@angels-bandits/common/medals";
import {
  type Vec3,
  wrapCoord,
  wrapDelta,
  wrapDistance,
} from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  type BossPlane,
  FleetDirector,
  applyBossImpact,
  bossContactIndex,
  claimBossHit,
  landBotBossRound,
} from "../src/boss";
import { Combat } from "../src/combat";
import { createRoomCity, tickDestruction } from "../src/destruction";
import { pickRespawn, respawnIfUnsafe } from "../src/respawn";
import { poseFromSpawn } from "../src/validate";

const city = generateCity(CITY_SEED);
const world = (() => {
  const rc = createRoomCity(city);
  return { buildings: rc.buildings, index: rc.index };
})();
const T0 = 1_787_000_000_000;
const TICK = 50;

/** A director whose fleet came on at T0. */
function startedDirector(
  seed = 1,
  tuning: FleetTuning = FLEET_TUNING,
): { boss: FleetDirector; ships: FleetShip[] } {
  const boss = new FleetDirector(mulberry32(seed), tuning);
  const out = boss.tick(T0, true, [], world);
  return { boss, ships: out.started };
}

const unit = (d: Vec3): Vec3 => {
  const len = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / len, y: d.y / len, z: d.z / len };
};

/** The first ship of class `cls`. */
const firstOf = (ships: readonly FleetShip[], cls: number): FleetShip => {
  const s = ships.find((x) => shipClass(x) === cls);
  if (!s) throw new Error("no such ship");
  return s;
};

/** A point `below` m under weak point 0 (an engine) of `ship` at `t`. */
function under(ship: FleetShip, t: number, below = 160): Vec3 {
  const wp = weakPointInto(
    fleetPoseAt(ship, t, blankPose()),
    shipClass(ship),
    0,
    {
      x: 0,
      y: 0,
      z: 0,
    },
  );
  return { x: wrapCoord(wp.x + 20), y: wp.y - below, z: wrapCoord(wp.z + 15) };
}

/** Shoot `ship` down at `t` with full-HP rounds on its hull. */
function down(boss: FleetDirector, ship: FleetShip, t: number) {
  let hit = null;
  for (let n = 0; n < 200 && !hit?.down; n++) {
    hit = boss.damage("s", ship.id, -1, t, world);
  }
  return hit;
}

describe("the fleet's schedule", () => {
  it("comes on with a human: one ship on every lane, at full HP", () => {
    const boss = new FleetDirector(mulberry32(2), FLEET_TUNING);
    // Nobody flying: nothing, however long.
    for (let t = T0; t < T0 + 10 * 60_000; t += 10_000) {
      expect(boss.tick(t, false, [], world).started).toEqual([]);
    }
    expect(boss.state(T0)).toBeNull();
    const t = T0 + 10 * 60_000;
    const started = boss.tick(t, true, [], world).started;
    expect(started).toHaveLength(FLEET_SIZE);
    expect(started.map((s) => s.lane)).toEqual(FLEET_LANES.map((_, i) => i));
    for (const s of started) {
      expect(s.hp0).toBe(shipFullHp(shipClass(s), 1));
      expect(boss.hp.get(s.id)).toBe(s.hp0);
    }
    expect(boss.state(t)?.s).toHaveLength(FLEET_SIZE);
    expect(boss.activeShips(t)).toHaveLength(FLEET_SIZE);
    // Only once.
    expect(boss.tick(t + TICK, true, [], world).started).toEqual([]);
  });

  it("refills a downed lane after refillMs, out of every human's sight", () => {
    const { boss, ships } = startedDirector(4);
    const victim = ships[5] as FleetShip;
    const t = T0 + 30_000;
    const hit = down(boss, victim, t);
    if (!hit?.down) throw new Error("not down");
    expect(boss.activeShips(t)).toHaveLength(FLEET_SIZE - 1);
    expect(boss.downs()).toBe(1);
    const human: BossPlane = {
      id: "h",
      pos: { x: 400, y: 300, z: 700 },
      vel: { x: 0, y: 0, z: 0 },
      prot: true,
    };
    let refill: FleetShip | null = null;
    for (let now = t; now < t + 120_000 && !refill; now += TICK) {
      const out = boss.tick(now, true, [human], world);
      for (const s of out.started) refill = s;
      if (!refill) {
        // Never before its delay, nor while the crash still falls.
        expect(now - t < FLEET_TUNING.refillMs || refill === null).toBe(true);
      }
    }
    if (!refill) throw new Error("no refill");
    expect(refill.lane).toBe(victim.lane);
    expect(refill.id).toBeGreaterThan(victim.id);
    expect(refill.t0 - t).toBeGreaterThanOrEqual(FLEET_TUNING.refillMs);
    expect(refill.t0).toBeGreaterThanOrEqual(hit.down.t + hit.down.end);
    const at = fleetPoseAt(refill, refill.t0, blankPose());
    expect(
      wrapDistance({ ...at, y: 0 }, { ...human.pos, y: 0 }),
    ).toBeGreaterThanOrEqual(FLEET_HIDE_M);
    expect(boss.activeShips(refill.t0)).toHaveLength(FLEET_SIZE);
  });

  it("keeps the sky full: FLEET_SIZE up again after every kill", () => {
    const { boss } = startedDirector(6, FLEET_FAST_TUNING);
    let kills = 0;
    let lowest = FLEET_SIZE;
    for (let now = T0 + 250; now < T0 + 600_000; now += 250) {
      // A kill every 15 s, the oldest ship up.
      if ((now - T0) % 15_000 === 0) {
        const s = boss.activeShips(now)[0];
        if (s && down(boss, s, now)?.down) kills++;
      }
      boss.tick(now, true, [], world);
      lowest = Math.min(lowest, boss.activeShips(now).length);
    }
    expect(kills).toBeGreaterThan(30);
    expect(boss.downs()).toBe(kills);
    // Never more than the falling one and its refill delay short.
    expect(lowest).toBeGreaterThanOrEqual(FLEET_SIZE - 2);
    expect(boss.activeShips(T0 + 600_000)).toHaveLength(FLEET_SIZE);
    // Landed ships are pruned: the welcome stays a fleet, not a graveyard.
    expect(boss.state(T0 + 600_000)?.s.length).toBeLessThanOrEqual(
      FLEET_SIZE + 2,
    );
    boss.resetSession();
    expect(boss.downs()).toBe(0);
  });
});

describe("turret fire is fair (director)", () => {
  /** Run the director for `ms` with `planes(t)` and collect its output. */
  function run(
    boss: FleetDirector,
    from: number,
    ms: number,
    planes: (t: number) => BossPlane[],
  ) {
    const shells: BossFlak[] = [];
    const damage: { t: number; id: string; dmg: number }[] = [];
    for (let t = from; t < from + ms; t += TICK) {
      const out = boss.tick(t, true, planes(t), world);
      shells.push(...out.flak);
      for (const b of out.bursts) {
        for (const v of b.victims) damage.push({ t, id: v.id, dmg: v.damage });
      }
    }
    return { shells, damage };
  }

  it("only armed ships fire, after their reaction, at their cadence", () => {
    const { boss, ships } = startedDirector();
    const cruiser = firstOf(ships, 1);
    const t1 = T0 + 60_000;
    const { shells } = run(boss, t1, 14_000, (t) => [
      {
        id: "p",
        pos: under(cruiser, t),
        vel: { x: 0, y: 0, z: 0 },
        prot: false,
      },
    ]);
    expect(shells.length).toBeGreaterThan(3);
    const pose = blankPose();
    const byShip = new Map<number, number[]>();
    for (const s of shells) {
      expect(s.t0 - t1).toBeGreaterThanOrEqual(BOSS_FLAK_REACTION_MS);
      // The muzzle is on an armed ship.
      let best: FleetShip | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const sh of ships) {
        const d = wrapDistance(fleetPoseAt(sh, s.t0, pose), s.from);
        if (d < bestD) {
          bestD = d;
          best = sh;
        }
      }
      if (!best) throw new Error("no ship");
      const guns = SHIP_CLASSES[shipClass(best)]?.turrets ?? [];
      expect(guns.length).toBeGreaterThan(0);
      byShip.set(best.id, [...(byShip.get(best.id) ?? []), s.t0]);
    }
    // No ship fires more shells in any cadence window than it has guns.
    for (const [id, times] of byShip) {
      const s = ships.find((x) => x.id === id) as FleetShip;
      const guns = SHIP_CLASSES[shipClass(s)]?.turrets.length ?? 0;
      for (const t of times) {
        const inWindow = times.filter(
          (u) => u >= t && u < t + BOSS_FLAK_INTERVAL_MS,
        ).length;
        expect(inWindow).toBeLessThanOrEqual(guns);
      }
    }
  });

  it("never fires at a protected or freshly spawned plane", () => {
    const { boss, ships } = startedDirector();
    const cruiser = firstOf(ships, 1);
    const t1 = T0 + 60_000;
    const prot = run(boss, t1, 8000, (t) => [
      {
        id: "p",
        pos: under(cruiser, t),
        vel: { x: 0, y: 0, z: 0 },
        prot: true,
      },
    ]);
    expect(prot.shells).toEqual([]);
    const t2 = t1 + 8000;
    boss.noteSpawn("q", t2);
    const fresh = run(boss, t2, 4500, (t) => [
      {
        id: "q",
        pos: under(cruiser, t),
        vel: { x: 0, y: 0, z: 0 },
        prot: false,
      },
    ]);
    expect(fresh.shells).toEqual([]);
  });

  it("caps what any plane takes per second across the fleet, never one-shots", () => {
    const { boss, ships } = startedDirector();
    const carrier = firstOf(ships, 2);
    const t1 = T0 + 60_000;
    const { damage } = run(boss, t1, 40_000, (t) => [
      // Parked dead still: every shell is a perfect solution.
      {
        id: "p",
        pos: under(carrier, t),
        vel: { x: 0, y: 0, z: 0 },
        prot: false,
      },
    ]);
    expect(damage.length).toBeGreaterThan(0);
    for (const d of damage) {
      expect(d.dmg).toBeLessThanOrEqual(MAX_HP / 4);
      const window = damage
        .filter((e) => e.t > d.t - 1000 && e.t <= d.t)
        .reduce((s, e) => s + e.dmg, 0);
      expect(window).toBeLessThanOrEqual(
        BOSS_FLAK_DPS_CAP * FLEET_FLAK_SCALE + 1e-9,
      );
    }
  });
});

describe("hit claims", () => {
  /** A shooter 160 m under engine 0 of a carrier, its line straight at it. */
  function setup(seed = 1) {
    const { boss, ships } = startedDirector(seed);
    const ship = firstOf(ships, 2);
    const combat = new Combat();
    const t = T0 + 60_000;
    combat.addPlayer("s", t - 10_000);
    const pos = under(ship, t);
    const wp = weakPointInto(fleetPoseAt(ship, t, blankPose()), 2, 0, {
      x: 0,
      y: 0,
      z: 0,
    });
    const dir = unit(wrapDelta(pos, wp));
    return { boss, ship, combat, t, pos, dir };
  }

  it("a fired round on the line lands: HP down, the shooter credited", () => {
    const { boss, ship, combat, t, pos, dir } = setup();
    expect(combat.fire("s", 1, t - 300, dir).ok).toBe(true);
    const claim = { ship: ship.id, wp: 0, seq: 1, origin: pos, dir, t: t - 50 };
    const hit = claimBossHit(combat, boss, "s", claim, pos, t, world);
    const weak = BULLET_DAMAGE * FLEET_WEAK_MULT;
    expect(hit?.hp).toBe(ship.hp0 - weak);
    expect(boss.damageLedger(ship.id).get("s")).toBe(weak);
    expect(boss.takeHpChanged()).toEqual([[ship.id, ship.hp0 - weak]]);
    expect(boss.takeHpChanged()).toEqual([]);
    // One bullet, one hit.
    expect(claimBossHit(combat, boss, "s", claim, pos, t, world)).toBeNull();
    // A hull claim on the same line is a hull round's damage.
    combat.fire("s", 2, t - 300, dir);
    const hull = claimBossHit(
      combat,
      boss,
      "s",
      { ...claim, seq: 2, wp: -1 },
      pos,
      t,
      world,
    );
    expect(hull?.hp).toBe(ship.hp0 - weak - BULLET_DAMAGE);
  });

  it("refuses what the server can see is false", () => {
    const { boss, ship, combat, t, pos, dir } = setup();
    const claim = (seq: number, over: object, at = pos) =>
      claimBossHit(
        combat,
        boss,
        "s",
        { ship: ship.id, wp: 0, seq, origin: pos, dir, t, ...over },
        at,
        t,
        world,
      );
    // Never fired.
    expect(claim(50, {})).toBeNull();
    // Fired one way, claimed another (behind it): the nose kept at the shot.
    combat.fire("s", 2, t - 400, { x: -dir.x, y: -dir.y, z: -dir.z });
    expect(claim(2, {})).toBeNull();
    // Fired from nowhere near where the shooter is on record.
    combat.fire("s", 3, t - 300, dir);
    expect(claim(3, {}, { x: pos.x + 400, y: pos.y, z: pos.z })).toBeNull();
    // Claimed on another weak point than the line meets.
    combat.fire("s", 4, t - 300, dir);
    expect(claim(4, { wp: 5 })).toBeNull();
    // Not a unit direction / not a weak point / no such ship.
    combat.fire("s", 5, t - 300, dir);
    expect(claim(5, { dir: { x: 2, y: 0, z: 0 } })).toBeNull();
    combat.fire("s", 6, t - 300, dir);
    expect(claim(6, { wp: 99 })).toBeNull();
    combat.fire("s", 7, t - 300, dir);
    expect(claim(7, { ship: 999 })).toBeNull();
    // Another ship's id on this ship's line.
    combat.fire("s", 8, t - 300, dir);
    expect(claim(8, { ship: ship.id + 1, wp: -1 })).toBeNull();
    expect(boss.damageLedger(ship.id).size).toBe(0);
  });

  it("a bot's round is judged on its line the same way", () => {
    const { boss, ship, combat, t, pos, dir } = setup();
    combat.addPlayer("bot:r:1", t - 10_000);
    expect(bossContactIndex(`@boss:${ship.id}:0`)).toEqual({
      ship: ship.id,
      k: 0,
    });
    expect(bossContactIndex("bot:r:1")).toBeNull();
    expect(
      boss.contacts(t, pos, 400).some((c) => c.id === `@boss:${ship.id}:0`),
    ).toBe(true);
    const shot = {
      botId: "bot:r:1",
      targetId: `@boss:${ship.id}:0`,
      seq: 1,
      origin: pos,
      dir,
    };
    combat.fire(shot.botId, shot.seq, t - 500, dir);
    const round = { shot, shooterPos: pos, targetPos: pos };
    expect(landBotBossRound(combat, boss, round, t, world)).not.toBeNull();
    // A round whose line misses (fired off sideways) is refused.
    const wide = unit({ x: 1, y: 0.05, z: 0 });
    const shot2 = { ...shot, seq: 2, dir: wide };
    combat.fire(shot2.botId, 2, t - 500, wide);
    expect(
      landBotBossRound(
        combat,
        boss,
        { shot: shot2, shooterPos: pos, targetPos: pos },
        t,
        world,
      ),
    ).toBeNull();
  });

  it("a short burst brings a ship down; nothing lands on it after", () => {
    const { boss, ship, combat, t, pos } = setup();
    let seq = 1;
    let downAt: number | null = null;
    let rounds = 0;
    for (let n = 0; n < 60 && downAt === null; n++) {
      const now = t + n * 100;
      const pose = fleetPoseAt(ship, now, blankPose());
      const wp = weakPointInto(pose, 2, 0, { x: 0, y: 0, z: 0 });
      const from = {
        x: wrapCoord(wp.x + 20),
        y: wp.y - 160,
        z: wrapCoord(wp.z + 15),
      };
      const dir = unit(wrapDelta(from, wp));
      expect(combat.fire("s", seq, now - 50, dir).ok).toBe(true);
      const hit = claimBossHit(
        combat,
        boss,
        "s",
        { ship: ship.id, wp: -1, seq, origin: from, dir, t: now },
        from,
        now,
        world,
      );
      seq++;
      if (!hit) throw new Error("refused");
      rounds++;
      if (hit.down) downAt = now;
    }
    if (downAt === null) throw new Error("never came down");
    // About 3 s of one plane's sustained fire on a carrier's hull.
    expect(rounds).toBe(Math.ceil(ship.hp0 / BULLET_DAMAGE));
    expect(rounds * 100).toBeLessThanOrEqual(3200);
    expect(boss.hp.get(ship.id)).toBe(0);
    expect(ship.down?.t).toBe(downAt);
    expect(boss.activeShip(ship.id, downAt)).toBeNull();
    combat.fire("s", seq, downAt + 100, unit({ x: 0, y: 1, z: 0 }));
    expect(
      claimBossHit(
        combat,
        boss,
        "s",
        {
          ship: ship.id,
          wp: -1,
          seq,
          origin: pos,
          dir: unit({ x: 0, y: 1, z: 0 }),
          t: downAt + 150,
        },
        pos,
        downAt + 200,
        world,
      ),
    ).toBeNull();
  });

  it("the top dealer's medal is AIRSHIP BREAKER — no streak, no chain", () => {
    const ledger = new MedalLedger();
    const award = ledger.bossKill("s");
    expect(award.medals).toEqual(["boss"]);
    expect(award.tier).toBeNull();
    expect(ledger.streakOf("s")).toBe(0);
    const next = ledger.kill({
      killerId: "s",
      victimId: "v",
      cause: "shot",
      now: T0,
      killerAlive: true,
      needle: false,
      train: false,
    });
    expect(next.medals).toEqual([]);
  });
});

describe("launches spread across the fleet", () => {
  it("successive launches come from different ships near the humans", () => {
    const { boss, ships } = startedDirector(7);
    const t = T0 + 20_000;
    const near = [fleetPoseAt(ships[9] as FleetShip, t, blankPose())];
    const from = new Set<number>();
    for (let n = 0; n < 6; n++) {
      const l = boss.planLaunch(`bot:${n}`, t + 3000, t, near, () => true);
      if (!l) throw new Error("no launch");
      from.add(l.ship);
      const s = ships.find((x) => x.id === l.ship) as FleetShip;
      expect(SHIP_CLASSES[shipClass(s)]?.rigs.includes(l.kind as 0 | 1)).toBe(
        true,
      );
      const at = fleetPoseAt(s, t, blankPose());
      expect(
        wrapDistance({ ...at, y: 0 }, { ...(near[0] as Vec3), y: 0 }),
      ).toBeLessThanOrEqual(900);
    }
    expect(from.size).toBeGreaterThan(1);
  });

  it("a downed ship's rigs go with it", () => {
    const { boss, ships } = startedDirector(7);
    const t = T0 + 20_000;
    const s = ships[0] as FleetShip;
    const near = [fleetPoseAt(s, t, blankPose())];
    const l = boss.planLaunch("bot:1", t + 3000, t, near, () => true);
    if (!l) throw new Error("no launch");
    const host = ships.find((x) => x.id === l.ship) as FleetShip;
    down(boss, host, t + 500);
    expect(boss.slot.launches.some((x) => x.id === l.id)).toBe(false);
  });
});

describe("a crash falls via D4 and triggers D3 deterministically", () => {
  /** Down a carrier where its crash hits a roof; land it through the
   * director; run the room's destruction ticks. */
  function crash() {
    const rc = createRoomCity(city);
    const w = { buildings: rc.buildings, index: rc.index };
    const boss = new FleetDirector(mulberry32(3), FLEET_FAST_TUNING);
    const ships = boss.tick(T0, true, [], w).started;
    const s = firstOf(ships, 2);
    // The first second whose crash hits a building (the search is itself
    // deterministic).
    let t = T0 + 1000;
    for (; t < T0 + 400_000; t += 1000) {
      if (shipCrash(s, t, w).hit === "city") break;
    }
    const hit = down(boss, s, t);
    if (!hit?.down) throw new Error("not down");
    const collapses: unknown[] = [];
    const chunks: number[] = [];
    let landed = 0;
    for (let now = t; now < t + 20_000; now += TICK) {
      const out = boss.tick(now, true, [], w);
      for (const { at, building, by } of out.landed) {
        landed++;
        expect(by).toBe("s");
        chunks.push(...applyBossImpact(rc, at, "top", building));
      }
      collapses.push(...tickDestruction(rc, now).collapses);
    }
    return {
      down: hit.down,
      landed,
      chunks,
      collapses,
      collapseBy: [...rc.collapseBy.values()],
    };
  }

  it("lands once, breaks the city and brings a building down", () => {
    const a = crash();
    expect(a.landed).toBe(1);
    expect(a.down.hit).toBe("city");
    expect(a.chunks.length).toBeGreaterThan(0);
    expect(a.collapses.length).toBeGreaterThan(0);
    expect(a.collapseBy).toContain("top");
  });

  it("is the same crash every time", () => {
    const a = crash();
    const b = crash();
    expect(b.down).toEqual(a.down);
    expect(b.chunks).toEqual(a.chunks);
    expect(b.collapses).toEqual(a.collapses);
  });
});

describe("respawns under the fleet", () => {
  it("pickRespawn never hands out a spawn pointed into a hull", () => {
    const { boss } = startedDirector(5);
    const t = T0 + 60_000;
    const rand = mulberry32(8);
    for (let n = 0; n < 200; n++) {
      const spawn = pickRespawn([], rand, undefined, (pos, yaw) =>
        bossSpawnClear(boss.slot, pos, yaw, 65, t),
      );
      expect(bossSpawnClear(boss.slot, spawn.pos, spawn.yaw, 65, t)).toBe(true);
    }
  });

  it("a join spawn a ship moved onto is re-placed when the plane goes live (A2)", () => {
    const { boss, ships } = startedDirector(5);
    const t = T0 + 60_000;
    const clear = (pos: Vec3, yaw: number | null) =>
      bossSpawnClear(boss.slot, pos, yaw, 65, t);
    const rand = mulberry32(9);
    const heldAt = under(firstOf(ships, 2), t, 0);
    expect(clear(heldAt, 0)).toBe(false);
    const moved = respawnIfUnsafe(
      poseFromSpawn({ pos: heldAt, yaw: 0, speed: 65 }),
      [],
      rand,
      () => false,
      clear,
    );
    expect(moved).not.toBeNull();
    expect(clear(moved?.pos as Vec3, moved?.yaw ?? null)).toBe(true);
    const fine = pickRespawn([], rand, undefined, clear);
    expect(
      respawnIfUnsafe(poseFromSpawn(fine), [], rand, () => false, clear),
    ).toBeNull();
    expect(
      respawnIfUnsafe(poseFromSpawn(fine), [], rand, () => true, clear),
    ).not.toBeNull();
  });
});

describe("ship credit across a drop (A2)", () => {
  it("a W2 drop keeps the pilot's damage on the ship", () => {
    const { boss, ships } = startedDirector(3);
    const s = ships[2] as FleetShip;
    const t = T0 + 60_000;
    expect(boss.damage("s", s.id, -1, t, world)).not.toBeNull();
    boss.forget("s");
    expect(boss.damageLedger(s.id).get("s")).toBe(BULLET_DAMAGE);
    expect(shipPresent(s, t)).toBe(true);
  });
});
