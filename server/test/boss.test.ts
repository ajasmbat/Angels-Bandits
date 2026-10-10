// S4 sky boss, server side (server/src/boss.ts): the turrets keep the bots'
// fairness rules, a weak-point claim is judged like a plane hit plus the
// round's line, credit pays real damage only, and the zeppelin's fall is the
// D4 path into D3 collapses — the same way every time.

import {
  BOSS_FAST_TUNING,
  BOSS_FLAK_DPS_CAP,
  BOSS_FLAK_INTERVAL_MS,
  BOSS_FLAK_REACTION_MS,
  BOSS_PARTS,
  BOSS_TUNING,
  BOSS_WEAK_POINTS,
  type BossFlak,
  type BossRaid,
  blankPose,
  bossPoseAt,
  breakUp,
  raidEnd,
  raidMaxHp,
  weakPointInto,
} from "@angels-bandits/common/boss";
import { bossSpawnClear } from "@angels-bandits/common/boss";
import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import {
  BULLET_DAMAGE,
  CITY_SEED,
  MAX_HP,
} from "@angels-bandits/common/constants";
import { MedalLedger } from "@angels-bandits/common/medals";
import { type Vec3, wrapCoord, wrapDelta } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  BossDirector,
  type BossPlane,
  applyBossImpact,
  bossContactIndex,
  claimBossHit,
  landBotBossRound,
} from "../src/boss";
import { Combat } from "../src/combat";
import { createRoomCity, tickDestruction } from "../src/destruction";
import { pickRespawn } from "../src/respawn";

const city = generateCity(CITY_SEED);
const world = (() => {
  const rc = createRoomCity(city);
  return { buildings: rc.buildings, index: rc.index };
})();
const T0 = 1_787_000_000_000;
const TICK = 50;

/** A director whose first raid starts on the first tick a human is in. */
function startedDirector(seed = 1): { boss: BossDirector; raid: BossRaid } {
  const boss = new BossDirector(mulberry32(seed), {
    ...BOSS_FAST_TUNING,
    firstMinMs: 0,
    firstMaxMs: 0,
  });
  const out = boss.tick(T0, true, [], world);
  if (!out.started) throw new Error("no raid");
  return { boss, raid: out.started };
}

const unit = (d: Vec3): Vec3 => {
  const len = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / len, y: d.y / len, z: d.z / len };
};

/** A plane parked `below` m under weak point 0 (an engine) at `t`. */
function under(raid: BossRaid, t: number, below = 160): Vec3 {
  const wp = weakPointInto(bossPoseAt(raid, t, blankPose()), 0, {
    x: 0,
    y: 0,
    z: 0,
  });
  return { x: wrapCoord(wp.x + 20), y: wp.y - below, z: wrapCoord(wp.z + 15) };
}

describe("raid schedule (server)", () => {
  it("starts only with a human in the room, then never overlaps raids", () => {
    const boss = new BossDirector(mulberry32(2), BOSS_TUNING);
    // Bots alone: nothing, however long.
    for (let t = T0; t < T0 + 20 * 60_000; t += 10_000) {
      expect(boss.tick(t, false, [], world).started).toBeNull();
    }
    // A human arrives: the first raid inside the first window.
    let started: BossRaid | null = null;
    let t = T0 + 20 * 60_000;
    const arrived = t;
    for (; t < arrived + BOSS_TUNING.firstMaxMs + TICK; t += TICK) {
      started = boss.tick(t, true, [], world).started ?? started;
      if (started) break;
    }
    if (!started) throw new Error("no raid");
    expect(started.t0 - arrived).toBeGreaterThanOrEqual(BOSS_TUNING.firstMinMs);
    expect(boss.state(t)?.hp).toEqual(raidMaxHp(started));
    // C2: the next one comes period ± jitter after this one ENDS (its
    // run-out done) — never while it is still up.
    let second: BossRaid | null = null;
    for (t += TICK; t < started.t0 + 40 * 60_000; t += 1000) {
      second = boss.tick(t, true, [], world).started;
      if (second) break;
    }
    if (!second) throw new Error("no second raid");
    expect(second.t0 - raidEnd(started)).toBeGreaterThanOrEqual(
      BOSS_TUNING.periodMs - BOSS_TUNING.periodJitterMs,
    );
    expect(second.t0 - raidEnd(started)).toBeLessThanOrEqual(
      BOSS_TUNING.periodMs + BOSS_TUNING.periodJitterMs + 1000,
    );
    expect(second.id).toBe(started.id + 1);
  });
});

describe("turret fire is fair (director)", () => {
  /** Run the director for `ms` with `planes(t)` and collect its output. */
  function run(
    boss: BossDirector,
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

  it("waits out its reaction on a new target, then keeps its cadence", () => {
    const { boss, raid } = startedDirector();
    const t1 = raid.t0 + 60_000;
    // Quiet until t1 (no planes), then a plane parks under the engines.
    run(boss, raid.t0 + TICK, t1 - raid.t0 - TICK, () => []);
    const { shells } = run(boss, t1, 12_000, (t) => [
      { id: "p", pos: under(raid, t), vel: { x: 0, y: 0, z: 0 }, prot: false },
    ]);
    expect(shells.length).toBeGreaterThan(3);
    for (const s of shells) {
      expect(s.t0 - t1).toBeGreaterThanOrEqual(BOSS_FLAK_REACTION_MS);
    }
    const byTurret = new Map<number, number[]>();
    for (const s of shells) {
      byTurret.set(s.turret, [...(byTurret.get(s.turret) ?? []), s.t0]);
    }
    for (const times of byTurret.values()) {
      for (let i = 1; i < times.length; i++) {
        expect(
          (times[i] as number) - (times[i - 1] as number),
        ).toBeGreaterThanOrEqual(BOSS_FLAK_INTERVAL_MS);
      }
    }
  });

  it("never fires at a protected or freshly spawned plane", () => {
    const { boss, raid } = startedDirector();
    const t1 = raid.t0 + 60_000;
    const prot = run(boss, t1, 8000, (t) => [
      { id: "p", pos: under(raid, t), vel: { x: 0, y: 0, z: 0 }, prot: true },
    ]);
    expect(prot.shells).toEqual([]);
    const t2 = t1 + 8000;
    boss.noteSpawn("q", t2);
    const fresh = run(boss, t2, 4500, (t) => [
      { id: "q", pos: under(raid, t), vel: { x: 0, y: 0, z: 0 }, prot: false },
    ]);
    expect(fresh.shells).toEqual([]);
  });

  it("caps what any plane takes per second, and never one-shots", () => {
    const { boss, raid } = startedDirector();
    const t1 = raid.t0 + 60_000;
    const { damage } = run(boss, t1, 30_000, (t) => [
      // Parked dead still: every shell is a perfect solution.
      { id: "p", pos: under(raid, t), vel: { x: 0, y: 0, z: 0 }, prot: false },
    ]);
    expect(damage.length).toBeGreaterThan(0);
    for (const d of damage) {
      expect(d.dmg).toBeLessThanOrEqual(MAX_HP / 4);
      const window = damage
        .filter((e) => e.t > d.t - 1000 && e.t <= d.t)
        .reduce((s, e) => s + e.dmg, 0);
      expect(window).toBeLessThanOrEqual(BOSS_FLAK_DPS_CAP + 1e-9);
    }
  });
});

describe("weak-point hit claims", () => {
  /** A shooter 160 m under engine 0, its round's line straight at it. */
  function setup(seed = 1) {
    const { boss, raid } = startedDirector(seed);
    const combat = new Combat();
    const t = raid.t0 + 60_000;
    combat.addPlayer("s", t - 10_000);
    const pos = under(raid, t);
    const wp = weakPointInto(bossPoseAt(raid, t, blankPose()), 0, {
      x: 0,
      y: 0,
      z: 0,
    });
    const dir = unit(wrapDelta(pos, wp));
    return { boss, raid, combat, t, pos, dir };
  }

  it("a fired round on the line lands: HP down, the shooter credited", () => {
    const { boss, raid, combat, t, pos, dir } = setup();
    expect(combat.fire("s", 1, t - 300, dir).ok).toBe(true);
    const hit = claimBossHit(
      combat,
      boss,
      "s",
      { wp: 0, seq: 1, origin: pos, dir, t: t - 50 },
      pos,
      t,
      world,
    );
    expect(hit?.hp[0]).toBe(raidMaxHp(raid)[0] - BULLET_DAMAGE);
    expect(boss.damageLedger().get("s")).toBe(BULLET_DAMAGE);
    expect(boss.takeHpChanged()).toBe(true);
    // One bullet, one hit.
    expect(
      claimBossHit(
        combat,
        boss,
        "s",
        { wp: 0, seq: 1, origin: pos, dir, t },
        pos,
        t,
        world,
      ),
    ).toBeNull();
  });

  it("refuses what the server can see is false", () => {
    const { boss, combat, t, pos, dir } = setup();
    const claim = (seq: number, over: object, at = pos) =>
      claimBossHit(
        combat,
        boss,
        "s",
        { wp: 0, seq, origin: pos, dir, t, ...over },
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
    // Not a unit direction / not a weak point at all.
    combat.fire("s", 5, t - 300, dir);
    expect(claim(5, { dir: { x: 2, y: 0, z: 0 } })).toBeNull();
    combat.fire("s", 6, t - 300, dir);
    expect(claim(6, { wp: 99 })).toBeNull();
    expect(boss.damageLedger().size).toBe(0);
  });

  it("a bot's round is judged on its line the same way", () => {
    const { boss, combat, t, pos, dir } = setup();
    combat.addPlayer("bot:r:1", t - 10_000);
    expect(bossContactIndex("@boss:0")).toBe(0);
    expect(bossContactIndex("bot:r:1")).toBe(-1);
    const shot = {
      botId: "bot:r:1",
      targetId: "@boss:0",
      seq: 1,
      origin: pos,
      dir,
    };
    combat.fire(shot.botId, shot.seq, t - 500, dir);
    const round = { shot, shooterPos: pos, targetPos: pos };
    expect(landBotBossRound(combat, boss, round, t, world)).not.toBeNull();
    // A round whose line misses (fired straight up the side) is refused.
    const wide = unit({ x: 1, y: 0.2, z: 0 });
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

  it("brings it down at zero; nothing lands after", () => {
    const { boss, raid, combat, t, pos } = setup();
    let seq = 1;
    let downAt: number | null = null;
    // Every weak point, each from outside its own face, shots spaced so
    // the gun never overheats.
    for (let k = 0; k < BOSS_WEAK_POINTS.length && downAt === null; k++) {
      const part = BOSS_PARTS[BOSS_WEAK_POINTS[k] as number];
      if (!part) throw new Error("no part");
      // Outward in the hull frame: engines below, flank cells to their side,
      // the dorsal cell above.
      const out =
        part.kind === "engine"
          ? { x: 0, y: -1, z: 0 }
          : part.y > 15
            ? { x: 0, y: 1, z: 0 }
            : { x: 0, y: 0, z: Math.sign(part.z) };
      for (let n = 0; n < 100 && downAt === null; n++) {
        const now = t + seq * 400;
        const pose = bossPoseAt(raid, now, blankPose());
        const wp = weakPointInto(pose, k, { x: 0, y: 0, z: 0 });
        const c = Math.cos(pose.yaw);
        const sn = Math.sin(pose.yaw);
        const from = {
          x: wrapCoord(wp.x + 120 * (out.x * c + out.z * sn)),
          y: wp.y + 120 * out.y,
          z: wrapCoord(wp.z + 120 * (-out.x * sn + out.z * c)),
        };
        const dir = unit(wrapDelta(from, wp));
        expect(combat.fire("s", seq, now - 200, dir).ok).toBe(true);
        const hit = claimBossHit(
          combat,
          boss,
          "s",
          { wp: k, seq, origin: from, dir, t: now },
          from,
          now,
          world,
        );
        seq++;
        if (!hit) break; // this one is spent
        if (hit.down) downAt = now;
      }
    }
    if (downAt === null) throw new Error("never came down");
    expect(boss.hp.every((v) => v === 0)).toBe(true);
    expect(boss.slot.down?.id).toBe(raid.id);
    expect(boss.activeRaid(downAt)).toBeNull();
    combat.fire("s", seq, downAt + 100, unit({ x: 0, y: 1, z: 0 }));
    expect(
      claimBossHit(
        combat,
        boss,
        "s",
        {
          wp: 0,
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
    void pos;
  });

  it("the top dealer's medal is SKY-BOSS SLAYER — no streak, no chain", () => {
    const ledger = new MedalLedger();
    const award = ledger.bossKill("s");
    expect(award.medals).toEqual(["boss"]);
    expect(award.tier).toBeNull();
    expect(ledger.streakOf("s")).toBe(0);
    // A kill right after is not a DOUBLE KILL off the boss.
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

describe("the wreck falls via D4 and triggers D3 deterministically", () => {
  /** Down it over a block where its mid section hits a roof; land every
   * section through the director; run the room's destruction ticks. */
  function crash() {
    const rc = createRoomCity(city);
    const boss = new BossDirector(mulberry32(3), {
      ...BOSS_FAST_TUNING,
      firstMinMs: 0,
      firstMaxMs: 0,
      hpScale: 0.01,
    });
    const raid = boss.tick(T0, true, [], world).started;
    if (!raid) throw new Error("no raid");
    // The first second of the orbit whose break-up puts the mid section on
    // a building (the search is itself deterministic).
    let t = raid.t0 + 50_000;
    for (; t < raid.t0 + 140_000; t += 1000) {
      const probe = breakUp(raid, t, {
        buildings: rc.buildings,
        index: rc.index,
      });
      if (probe.pieces[1]?.hit === "city") break;
    }
    // Spend every weak point (hpScale 0.01: one round each) at time t.
    for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
      boss.damage("top", k, t, { buildings: rc.buildings, index: rc.index });
    }
    const down = boss.slot.down;
    if (!down) throw new Error("not down");
    const collapses: unknown[] = [];
    const chunks: number[] = [];
    let landed = 0;
    for (let now = t; now < t + 20_000; now += TICK) {
      const out = boss.tick(now, true, [], {
        buildings: rc.buildings,
        index: rc.index,
      });
      for (const { at, building } of out.landed) {
        landed++;
        chunks.push(...applyBossImpact(rc, at, "top", building));
      }
      collapses.push(...tickDestruction(rc, now).collapses);
    }
    return {
      down,
      landed,
      chunks,
      collapses,
      collapseBy: [...rc.collapseBy.values()],
    };
  }

  it("lands all three sections, breaks the city and brings a building down", () => {
    const a = crash();
    expect(a.landed).toBe(3);
    expect(a.down.pieces[1]?.hit).toBe("city");
    expect(a.chunks.length).toBeGreaterThan(0);
    expect(a.collapses.length).toBeGreaterThan(0);
    // D3 credits the collapse to whoever the impact names: the top dealer.
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

describe("respawns during a raid", () => {
  it("pickRespawn never hands out a spawn pointed into the hull", () => {
    const { boss, raid } = startedDirector(5);
    const t = raid.t0 + 60_000;
    const enemies = [
      // An enemy on the far side of the hull: the natural spawn faces it.
      { pos: under(raid, t, -60), fwd: null },
    ];
    const rand = mulberry32(8);
    for (let n = 0; n < 200; n++) {
      const spawn = pickRespawn(enemies, rand, (pos, yaw) =>
        bossSpawnClear(boss.slot, pos, yaw, 65, t),
      );
      expect(bossSpawnClear(boss.slot, spawn.pos, spawn.yaw, 65, t)).toBe(true);
    }
  });
});
