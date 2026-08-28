// RoomBots seam: the server-side bot population of one room — spawn/despawn
// sync, the 4-state brain, shared-stepFlight simulation, and the combat
// routing (applyBotFire). Everything is seeded (mulberry32) — no Math.random
// — so every expectation here is deterministic.

import { generateCity } from "@angels-bandits/common/city";
import {
  aircraftBox,
  collideMovers,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import { isInRoadway } from "@angels-bandits/common/city/street";
import { collideCity, hitsGround } from "@angels-bandits/common/collision";
import {
  BOT_CANYON_ALT_MAX,
  BOT_CANYON_HOP,
  BOT_CANYON_PROBE_ALT,
  BOT_DECISION_EVERY,
  BOT_MIN_ALT,
  BOT_PATROL_ALT_MIN,
  BOT_REACTION_MS,
  CITY_SEED,
  CLOUD_BASE,
  KILL_CAM_MS,
  MAX_HP,
  PLAYER_RADIUS,
  RESPAWN_ALTITUDE,
  RESPAWN_SPEED,
  SNAPSHOT_INTERVAL_MS,
  TICK_DOWN_HZ,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { flightForward } from "@angels-bandits/common/flight";
import type { SpawnState } from "@angels-bandits/common/protocol";
import { canonicalize, wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { type BotShot, RoomBots, applyBotFire } from "../src/bots";
import { Combat } from "../src/combat";
import { pickRespawn } from "../src/respawn";

/** A fixed mid-altitude spawn: tests place bots explicitly. */
const spawnAt = (x: number, z: number, yaw = 0, y = 300): SpawnState => ({
  pos: { x, y, z },
  yaw,
  speed: RESPAWN_SPEED,
});

describe("RoomBots population sync", () => {
  it("syncTo(6) on an empty room spawns BANDIT-1..6 with room-scoped ids", () => {
    const bots = new RoomBots("room-1", 7, []);
    const { spawned, despawned } = bots.syncTo(6, () => spawnAt(1000, 1000));
    expect(despawned).toEqual([]);
    expect(spawned.map((e) => e.name)).toEqual([
      "BANDIT-1",
      "BANDIT-2",
      "BANDIT-3",
      "BANDIT-4",
      "BANDIT-5",
      "BANDIT-6",
    ]);
    expect(spawned.map((e) => e.id)).toEqual([
      "bot:room-1:1",
      "bot:room-1:2",
      "bot:room-1:3",
      "bot:room-1:4",
      "bot:room-1:5",
      "bot:room-1:6",
    ]);
    expect(spawned.every((e) => e.isBot)).toBe(true);
    expect(bots.count).toBe(6);
  });

  it("syncTo below the current count despawns down to the target", () => {
    const bots = new RoomBots("room-1", 7, []);
    bots.syncTo(6, () => spawnAt(1000, 1000));
    const { spawned, despawned } = bots.syncTo(5, () => spawnAt(1000, 1000));
    expect(spawned).toEqual([]);
    expect(despawned).toHaveLength(1);
    expect(bots.count).toBe(5);
    expect(bots.poseOf(despawned[0])).toBeNull();
  });

  it("a lowered count takes the IDLE bot: one engaging a human keeps its seat", () => {
    // ANGE-6STDNN: the shared slider can cut the population mid-fight, so
    // the idle-first despawn rule is now load-bearing. Two bots far apart;
    // only the first has a human in front of it, so only it ENGAGEs.
    const bots = new RoomBots("room-1", 7, []);
    const [engager, idler] = bots.syncTo(
      2,
      (() => {
        let n = 0;
        return () => (n++ === 0 ? spawnAt(1000, 1000) : spawnAt(200, 200));
      })(),
    ).spawned;
    const human = {
      id: "11111111-aaaa-bbbb-cccc-000000000001",
      pos: { x: 1000, y: 300, z: 900 },
      vel: { x: 0, y: 0, z: 0 },
      prot: false,
    };
    const contacts = () =>
      [engager.id, idler.id]
        .map((id) => {
          const self = bots.contactOf(id);
          if (!self) throw new Error("bot vanished");
          return { id, ...self, prot: false };
        })
        .concat([human]);
    // One brain decision is enough to acquire and engage.
    for (let i = 0; i < BOT_DECISION_EVERY; i++) bots.tick(i, contacts());
    expect(bots.stateOf(engager.id)).toBe("ENGAGE");
    expect(bots.stateOf(idler.id)).toBe("PATROL");

    const { despawned } = bots.syncTo(1, () => spawnAt(1000, 1000));
    expect(despawned).toEqual([idler.id]);
    expect(bots.poseOf(engager.id)).not.toBeNull();
  });

  it("seam pursuit: a bot at x=10 chases a target at x=1990 across the seam, not across the map", () => {
    const bots = new RoomBots("room-1", 7, []);
    // Facing -Z (yaw 0): the target sits 20 m to the LEFT through the seam
    // (wrapDelta x = -20; 1980 m the naive way) and ahead so the
    // threat-behind break doesn't apply.
    const [entry] = bots.syncTo(1, () => spawnAt(10, 1000)).spawned;
    const target = {
      id: "11111111-aaaa-bbbb-cccc-000000000001",
      pos: { x: 1990, y: 300, z: 900 },
      vel: { x: 0, y: 0, z: 0 },
      prot: false,
    };
    const contacts = () => {
      const self = bots.contactOf(entry.id);
      if (!self) throw new Error("bot vanished");
      return [{ id: entry.id, ...self, prot: false }, target];
    };

    // One decision (every BOT_DECISION_EVERY-th tick) acquires and engages.
    for (let i = 0; i < BOT_DECISION_EVERY; i++) bots.tick(i, contacts());
    expect(bots.stateOf(entry.id)).toBe("ENGAGE");
    expect(bots.targetOf(entry.id)).toBe(target.id);

    // Steering points across the seam: within a second the nose swings
    // toward NEGATIVE x (the short way), never the +x trek across the map.
    let crossed = false;
    for (let i = 3; i < 45; i++) {
      bots.tick(i * SNAPSHOT_INTERVAL_MS, contacts());
      const flight = bots.flightOf(entry.id);
      if (!flight) throw new Error("bot vanished");
      expect(flight.pos.x < 500 || flight.pos.x > 1500).toBe(true);
      if (flight.pos.x > 1700) crossed = true;
    }
    const flight = bots.flightOf(entry.id);
    expect(crossed).toBe(true);
    expect(flight).toBeDefined();
  });

  it("survival: 60 s in the real seeded city from a canyon start, no crash", () => {
    const city = generateCity(CITY_SEED);
    // Room seed 3 draws BANDIT-1 as a canyon pilot (band ~50 m) — this test
    // is about the low layer, so it needs a bot that lives there.
    const bots = new RoomBots("room-1", 3, city);
    // Spawn deep in a street canyon at 60 m, flying west along the z=1000
    // street between tower rows. 900 ticks = 60 s at 15 Hz.
    const [entry] = bots.syncTo(1, () =>
      spawnAt(500, 1002, Math.PI / 2, 60),
    ).spawned;
    let onStreet = 0;
    for (let i = 1; i <= 900; i++) {
      const result = bots.tick(i * SNAPSHOT_INTERVAL_MS, []);
      expect(result.crashes).toEqual([]);
      const flight = bots.flightOf(entry.id);
      if (!flight) throw new Error("bot vanished");
      expect(hitsGround(flight.pos)).toBe(false);
      expect(collideCity(flight.pos, PLAYER_RADIUS, city)).toBeNull();
      if (isInRoadway(flight.pos)) onStreet++;
      // ANGE-SINI5F: this bot patrols the canyons, so it must STAY in them —
      // it never climbs out over the rooftops it used to live above.
      expect(flight.pos.y).toBeLessThan(BOT_CANYON_PROBE_ALT);
    }
    // Vacuity guard, replacing the old "the probes fired at least once": a low
    // bot no longer needs RECOVER here, so the meaningful claim is that it
    // spent the minute flying the street grid rather than surviving by luck.
    // Streets are 27.75% of the world's area — random flight scores about that.
    expect(onStreet / 900).toBeGreaterThan(0.6);
    // ...and that it is still down in the canyons at the end of the minute.
    const flight = bots.flightOf(entry.id);
    if (!flight) throw new Error("bot vanished");
    expect(flight.pos.y).toBeLessThan(BOT_CANYON_ALT_MAX + BOT_CANYON_HOP);
  });

  it("ceiling: 120 s chasing a carrot above the clouds never exceeds CLOUD_BASE", () => {
    const bots = new RoomBots("room-1", 7, []);
    const [entry] = bots.syncTo(1, () => spawnAt(1000, 1000)).spawned;
    let engaged = false;
    // The worst case for the ceiling: an unprotected bait that is ALWAYS
    // 250 m ahead of the bot's nose and parked above the cloud deck at
    // 700 m, so pursuit wants to climb forever. 1800 ticks is well over a
    // minute of flight at the snapshot cadence bots are simulated on.
    for (let i = 1; i <= 1800; i++) {
      const flight = bots.flightOf(entry.id);
      if (!flight) throw new Error("bot vanished");
      const fwd = flightForward(flight);
      const bait = {
        id: "11111111-aaaa-bbbb-cccc-000000000002",
        pos: canonicalize({
          x: flight.pos.x + fwd.x * 250,
          y: 700,
          z: flight.pos.z + fwd.z * 250,
        }),
        vel: { x: 0, y: 0, z: 0 },
        prot: false,
      };
      bots.tick(i * SNAPSHOT_INTERVAL_MS, [bait]);
      const after = bots.flightOf(entry.id);
      if (!after) throw new Error("bot vanished");
      // The hidden storm rule must be unreachable for a bot — it may brush
      // the cloud deck's underside, never enter the clouds at 500 m.
      expect(after.pos.y).toBeLessThanOrEqual(CLOUD_BASE);
      if (bots.stateOf(entry.id) === "ENGAGE") engaged = true;
    }
    // Vacuity guard: the bait really was acquired and chased.
    expect(engaged).toBe(true);
  });

  it("a bot pose carries the spawn position, yaw attitude, and speed", () => {
    const bots = new RoomBots("room-1", 7, []);
    const [entry] = bots.syncTo(1, () =>
      spawnAt(100, 200, Math.PI / 2),
    ).spawned;
    const pose = bots.poseOf(entry.id);
    expect(pose?.pos).toEqual({ x: 100, y: 300, z: 200 });
    expect(pose?.speed).toBe(RESPAWN_SPEED);
    // Yaw-only attitude: quat is a pure Y rotation of π/2 (matches poseFromSpawn).
    expect(pose?.quat.y).toBeCloseTo(Math.sin(Math.PI / 4), 5);
    expect(pose?.quat.w).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    expect(pose?.quat.x).toBeCloseTo(0, 5);
    expect(pose?.quat.z).toBeCloseTo(0, 5);
  });
});

// --- Bot fire routed through the existing Combat seam ---
// Heat worked example (same as combat.test.ts, from the spec constants):
// at exact 100 ms cadence each interval nets 0.055 − 0.03 = 0.025 heat, so
// shot k=42 reaches 1.105 ≥ 1.1 (server lock) — 43 shots land, the 44th is
// the first overheat reject.

describe("applyBotFire — bots use human combat rules", () => {
  const BOT_ID = "bot:room-1:1";
  const TARGET = "22222222-aaaa-bbbb-cccc-000000000002";

  /** A dead-on shot from (1000,300,1000) at a target 50 m ahead (-z). */
  const deadOn = (seq: number): BotShot => ({
    botId: BOT_ID,
    targetId: TARGET,
    seq,
    origin: { x: 1000, y: 300, z: 1000 },
    dir: { x: 0, y: 0, z: -1 },
  });
  const targetPos = { x: 1000, y: 300, z: 950 };

  it("respects the shared heat model: 43 shots at max cadence, then overheat", () => {
    const combat = new Combat();
    combat.addPlayer(BOT_ID, 0);
    let accepted = 0;
    for (let k = 0; k < 60; k++) {
      // Fire without a target so only the heat model is in play.
      const { accepted: ok } = applyBotFire(combat, deadOn(k), null, k * 100);
      if (ok) accepted++;
    }
    expect(accepted).toBe(43);
  });

  it("respects the fire-rate token bucket at bot tick cadence", () => {
    const combat = new Combat();
    combat.addPlayer(BOT_ID, 0);
    let accepted = 0;
    // 3 s of attempts, one per snapshot tick: the bucket caps sustained fire
    // at 10/s (FIRE_INTERVAL_MS) plus the FIRE_BURST_SLACK burst of 5,
    // whatever cadence the bots are actually simulated at.
    const attempts = Math.round(3000 / SNAPSHOT_INTERVAL_MS);
    for (let k = 0; k < attempts; k++) {
      const { accepted: ok } = applyBotFire(
        combat,
        deadOn(k),
        null,
        k * SNAPSHOT_INTERVAL_MS,
      );
      if (ok) accepted++;
    }
    expect(accepted).toBeLessThanOrEqual(35);
    expect(accepted).toBeGreaterThanOrEqual(30);
  });

  it("cannot damage a spawn-protected target, and firing forfeits its own protection", () => {
    const combat = new Combat();
    const now = 1000;
    combat.addPlayer(BOT_ID, now);
    combat.addPlayer(TARGET, now); // protected for SPAWN_PROTECTION_MS
    expect(combat.isProtected(BOT_ID, now + 1)).toBe(true);
    const result = applyBotFire(combat, deadOn(1), targetPos, now + 1);
    expect(result.accepted).toBe(true);
    expect(result.hit).toEqual({ ok: false, reason: "protected" });
    expect(combat.hpOf(TARGET)).toBe(MAX_HP);
    // Firing forfeits the bot's own spawn protection (PLAN.md rule).
    expect(combat.isProtected(BOT_ID, now + 2)).toBe(false);
  });

  it("kill credit lands on the bot; a clean miss ray damages nothing", () => {
    const combat = new Combat();
    combat.addPlayer(BOT_ID, 0);
    combat.addPlayer(TARGET, 0);
    // A ray 20 m wide of the target: accepted fire, no hit.
    const miss = applyBotFire(
      combat,
      { ...deadOn(0), origin: { x: 1020, y: 300, z: 1000 } },
      targetPos,
      10_000,
    );
    expect(miss.accepted).toBe(true);
    expect(miss.hit).toBeNull();
    expect(combat.hpOf(TARGET)).toBe(MAX_HP);

    // 15 dead-on hits at 7 damage kill the 100 HP target (worked: ⌈100/7⌉).
    let death: unknown = null;
    for (let k = 1; k <= 15; k++) {
      const r = applyBotFire(combat, deadOn(k), targetPos, 10_000 + k * 100);
      if (r.hit?.ok && r.hit.death) death = r.hit.death;
    }
    expect(death).toEqual({
      victimId: TARGET,
      killerId: BOT_ID,
      cause: "shot",
    });
    expect(combat.scoreOf(BOT_ID).kills).toBe(1);
  });

  it("a dead bot respawns through Combat timing + the respawn sampler", () => {
    const combat = new Combat();
    const bots = new RoomBots("room-1", 7, []);
    const [entry] = bots.syncTo(1, () => ({
      pos: { x: 100, y: 300, z: 100 },
      yaw: 0,
      speed: RESPAWN_SPEED,
    })).spawned;
    combat.addPlayer(entry.id, 0);

    // Crash the bot (identical to a human crash death).
    const death = combat.crash(entry.id, 5000);
    expect(death?.victimId).toBe(entry.id);
    bots.setDead(entry.id);
    expect(bots.poseOf(entry.id)).toBeNull();

    // Kill-cam beat elapses → Combat marks the respawn due; the sampler
    // places it far from enemies and RoomBots reseeds the flight there.
    expect(combat.tick(5000 + KILL_CAM_MS - 1).respawnsDue).toEqual([]);
    const due = combat.tick(5000 + KILL_CAM_MS).respawnsDue;
    expect(due).toEqual([entry.id]);
    const spawn = pickRespawn([{ x: 1000, y: 300, z: 1000 }], () => 0.25);
    combat.respawned(entry.id, 5000 + KILL_CAM_MS);
    bots.respawn(entry.id, spawn);
    expect(combat.isAlive(entry.id)).toBe(true);
    expect(bots.poseOf(entry.id)?.pos).toEqual(spawn.pos);
    expect(bots.stateOf(entry.id)).toBe("PATROL");
  });

  it("holds fire for the reaction delay after acquiring a target", () => {
    const bots = new RoomBots("room-1", 7, []);
    const [entry] = bots.syncTo(1, () => ({
      pos: { x: 1000, y: 300, z: 1000 },
      yaw: 0,
      speed: RESPAWN_SPEED,
    })).spawned;
    // Target dead ahead (-z), well inside fire range and the aim cone.
    const target = {
      id: "33333333-aaaa-bbbb-cccc-000000000003",
      pos: { x: 1000, y: 300, z: 850 },
      vel: { x: 0, y: 0, z: 0 },
      prot: false,
    };
    const shotTimes: number[] = [];
    let acquiredAt: number | null = null;
    for (let i = 1; i <= 15; i++) {
      const now = i * SNAPSHOT_INTERVAL_MS;
      const self = bots.contactOf(entry.id);
      if (!self) throw new Error("bot vanished");
      const r = bots.tick(now, [
        { id: entry.id, ...self, prot: false },
        target,
      ]);
      if (acquiredAt === null && bots.targetOf(entry.id) === target.id) {
        acquiredAt = now;
      }
      for (const s of r.shots) shotTimes.push(now);
    }
    if (acquiredAt === null) throw new Error("never acquired");
    expect(shotTimes.length).toBeGreaterThan(0);
    // No trigger pull before the ~400 ms reaction beat after acquisition.
    expect(Math.min(...shotTimes)).toBeGreaterThanOrEqual(
      acquiredAt + BOT_REACTION_MS,
    );
  });
});

// --- ANGE-SINI5F: bots fly the canyons ---

/** Contact-free patrol: no acquisition, so this is pure PATROL/RECOVER. */
const patrol = (rooms: RoomBots[], seconds: number, from = 1): number => {
  const ticks = Math.round(seconds * TICK_DOWN_HZ);
  for (let i = from; i < from + ticks; i++) {
    for (const bots of rooms) bots.tick(i * (1000 / TICK_DOWN_HZ), []);
  }
  return from + ticks;
};

/** Spread spawns around the map so a roster isn't stacked on one street. */
const spreadSpawner = () => {
  let n = 0;
  return () => {
    n++;
    return spawnAt((n * 137) % WORLD_SIZE, (n * 311) % WORLD_SIZE, n);
  };
};

describe("canyon disposition", () => {
  it("seeds ~60% of bots into the canyons and the rest high, with nothing in between", () => {
    // Empty city: isolates the seeded disposition draw from terrain avoidance.
    const rooms = [11, 22, 33, 44].map(
      (seed, n) => new RoomBots(`room-${n}`, seed, []),
    );
    const roster: { bots: RoomBots; id: string }[] = [];
    for (const bots of rooms) {
      for (const e of bots.syncTo(50, spreadSpawner()).spawned) {
        roster.push({ bots, id: e.id });
      }
    }
    // Long enough for a bot spawned at RESPAWN_ALTITUDE to reach its band.
    patrol(rooms, 90);

    let canyon = 0;
    for (const { bots, id } of roster) {
      const y = bots.flightOf(id)?.pos.y ?? Number.NaN;
      if (y < BOT_CANYON_ALT_MAX + 30) {
        expect(y).toBeGreaterThan(0);
        canyon++;
      } else {
        // The layers must be clean: anything not in the canyons is up high.
        expect(y).toBeGreaterThan(BOT_PATROL_ALT_MIN - 30);
      }
    }
    const share = canyon / roster.length;
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(0.7);
    // Long seeded sims: generous timeout so a loaded CI box cannot flake it.
  }, 30_000);

  it("keeps a bot in its own layer across a respawn", () => {
    const bots = new RoomBots("room-1", 11, []);
    const roster = bots.syncTo(20, spreadSpawner()).spawned;
    let now = patrol([bots], 90);
    const before = roster.map((e) => bots.flightOf(e.id)?.pos.y ?? Number.NaN);

    // Respawn every bot high, the way Combat does after a kill.
    for (const e of roster) {
      bots.respawn(e.id, spawnAt(1000, 1000, 0, RESPAWN_ALTITUDE));
      expect(bots.flightOf(e.id)?.pos.y).toBe(RESPAWN_ALTITUDE);
    }
    now = patrol([bots], 90, now);

    for (const [i, e] of roster.entries()) {
      const after = bots.flightOf(e.id)?.pos.y ?? Number.NaN;
      const wasCanyon = (before[i] ?? 0) < BOT_CANYON_ALT_MAX + 30;
      expect(after < BOT_CANYON_ALT_MAX + 30).toBe(wasCanyon);
    }
    expect(now).toBeGreaterThan(0);
    // Long seeded sims: generous timeout so a loaded CI box cannot flake it.
  }, 30_000);
});

describe("canyon patrol in the real seeded city", () => {
  it("descends into the band, flies the streets, and stops thrashing in RECOVER", () => {
    const city = generateCity(CITY_SEED);
    const bots = new RoomBots("room-1", 11, city);
    const roster = bots.syncTo(12, spreadSpawner()).spawned;
    const stat = new Map(
      roster.map((e) => [
        e.id,
        {
          ticks: 0,
          recover: 0,
          road: 0,
          minY: Number.POSITIVE_INFINITY,
          maxY: 0,
        },
      ]),
    );
    // Bots spawn at RESPAWN_ALTITUDE; give them 30 s to get down before the
    // behaviour is scored, then watch two full minutes.
    const settleAt = 30 * TICK_DOWN_HZ;
    for (let i = 1; i <= 150 * TICK_DOWN_HZ; i++) {
      bots.tick(i * (1000 / TICK_DOWN_HZ), []);
      if (i < settleAt) continue;
      for (const e of roster) {
        const flight = bots.flightOf(e.id);
        // poseOf goes null the moment a bot is dead — only score live flying.
        if (!flight || !bots.poseOf(e.id)) continue;
        const s = stat.get(e.id);
        if (!s) throw new Error("bot vanished");
        s.ticks++;
        if (bots.stateOf(e.id) === "RECOVER") s.recover++;
        if (isInRoadway(flight.pos)) s.road++;
        s.minY = Math.min(s.minY, flight.pos.y);
        s.maxY = Math.max(s.maxY, flight.pos.y);
      }
    }

    const scored = roster.filter((e) => (stat.get(e.id)?.ticks ?? 0) > 100);
    const canyons = scored.filter((e) => (stat.get(e.id)?.maxY ?? 0) < 120);
    const highs = scored.filter((e) => (stat.get(e.id)?.maxY ?? 0) >= 120);
    // Vacuity guards: the run has to contain both layers to mean anything.
    expect(canyons.length).toBeGreaterThanOrEqual(4);
    expect(highs.length).toBeGreaterThanOrEqual(2);

    const roadFrac = (e: { id: string }) => {
      const s = stat.get(e.id);
      if (!s) throw new Error("bot vanished");
      return s.road / s.ticks;
    };
    for (const e of canyons) {
      const s = stat.get(e.id);
      if (!s) throw new Error("bot vanished");
      // The regression this ticket exists for: today's probe geometry pins a
      // low bot in RECOVER essentially every tick.
      expect(s.recover / s.ticks).toBeLessThan(0.05);
      // Independent reference: streets are 1 - (1 - 30/200)^2 = 27.75% of the
      // world's area, so a bot wandering at random sits in one about a quarter
      // of the time. Following them is a different number entirely.
      expect(roadFrac(e)).toBeGreaterThan(0.6);
      expect(s.minY).toBeGreaterThan(BOT_MIN_ALT);
    }
    // Control: the high patrollers still wander, so they hit roughly the
    // area share — proof the canyon number above is street-following.
    for (const e of highs) expect(roadFrac(e)).toBeLessThan(0.45);
    // Long seeded sims: generous timeout so a loaded CI box cannot flake it.
  }, 30_000);
});

describe("canyon patrol across the torus seam", () => {
  it("follows the same street straight through x = 0 without recovering", () => {
    const city = generateCity(CITY_SEED);
    // Room seed 3 draws BANDIT-1 as a canyon pilot. Spawn it on the z = 600
    // street heading -X (yaw +pi/2 points the nose at -X), 60 m from the seam,
    // so its next intersections are x = 0 and then x = 1800 the far side.
    const bots = new RoomBots("room-1", 3, city);
    const [entry] = bots.syncTo(1, () =>
      spawnAt(60, 600, Math.PI / 2, 60),
    ).spawned;
    if (!entry) throw new Error("no bot");
    let sawLow = false;
    let sawHigh = false;
    let recover = 0;
    let road = 0;
    const ticks = 60 * TICK_DOWN_HZ;
    for (let i = 1; i <= ticks; i++) {
      const result = bots.tick(i * (1000 / TICK_DOWN_HZ), []);
      expect(result.crashes).toEqual([]);
      const flight = bots.flightOf(entry.id);
      if (!flight) throw new Error("bot vanished");
      if (flight.pos.x < 100) sawLow = true;
      if (flight.pos.x > 1900) sawHigh = true;
      if (bots.stateOf(entry.id) === "RECOVER") recover++;
      if (isInRoadway(flight.pos)) road++;
      // It must cross the seam, not turn round and fly the long way.
      expect(flight.pos.y).toBeLessThan(BOT_CANYON_PROBE_ALT);
    }
    expect(sawLow).toBe(true);
    expect(sawHigh).toBe(true);
    expect(recover / ticks).toBeLessThan(0.05);
    expect(road / ticks).toBeGreaterThan(0.6);
    // Long seeded sim: generous timeout so a loaded CI box cannot flake it.
  }, 30_000);
});

describe("terrain shapes pursuit instead of cancelling it", () => {
  // A slab squarely across the z = 600 street, far too tall to climb over.
  const WALL = {
    x: 700,
    z: 600,
    width: 120,
    depth: 200,
    height: 300,
    tiers: [{ width: 120, depth: 200, height: 300 }],
  };
  const HUNTED = "11111111-aaaa-bbbb-cccc-000000000009";
  /** yaw for a nose pointing at +X (yaw 0 faces -Z). */
  const EAST = -Math.PI / 2;

  /**
   * Fly east down the street straight at the slab, 45 m out — inside probe
   * range, and closer than the ~85 m it takes to turn away, so the terrain
   * danger is real and unavoidable either way. The only question under test
   * is what the brain DOES with it. Scoring stops if the bot dies: crashing
   * here is allowed (see the crash policy), dropping the target is not.
   */
  const runAtWall = (contact: boolean) => {
    const bots = new RoomBots("room-1", 3, [WALL]);
    const [entry] = bots.syncTo(1, () => spawnAt(595, 600, EAST, 100)).spawned;
    if (!entry) throw new Error("no bot");
    // Well off to the side down the cross street: the sight line and the
    // pursuit line both stay clear of the slab.
    const target = {
      id: HUNTED,
      pos: { x: 595, y: 100, z: 250 },
      vel: { x: 0, y: 0, z: 0 },
      prot: false,
    };
    let sawRecover = false;
    let sawEngage = false;
    let ticks = 0;
    for (let i = 1; i <= 12; i++) {
      const self = bots.contactOf(entry.id);
      if (!self) break;
      bots.tick(
        i * SNAPSHOT_INTERVAL_MS,
        contact ? [{ id: entry.id, ...self, prot: false }, target] : [],
      );
      if (!bots.poseOf(entry.id)) break;
      ticks++;
      if (bots.stateOf(entry.id) === "RECOVER") sawRecover = true;
      if (bots.stateOf(entry.id) === "ENGAGE") sawEngage = true;
    }
    return { sawRecover, sawEngage, ticks, bots, id: entry.id };
  };

  it("with no contact, the same approach trips the RECOVER guard", () => {
    // The control: this geometry IS dangerous, so the test below cannot pass
    // merely because the probes never fired.
    const { sawRecover, ticks } = runAtWall(false);
    expect(ticks).toBeGreaterThan(3);
    expect(sawRecover).toBe(true);
  });

  it("with a contact off to the side, it weaves instead of abandoning the chase", () => {
    const { sawRecover, sawEngage, bots, id } = runAtWall(true);
    expect(sawEngage).toBe(true);
    expect(bots.targetOf(id)).toBe(HUNTED);
    expect(sawRecover).toBe(false);
  });
});

describe("RECOVER survives as the last-resort guard", () => {
  /**
   * Four CITY-SCALE slabs boxing in an 80 m courtyard around (540, 500).
   * Depth matters: probes are sampled, not swept, so a thin wall can be
   * stepped over by a long lookahead — these are as deep as real blocks, and
   * they overlap at the corners, so there is genuinely no way out.
   */
  const wall = (x: number, z: number, width: number, depth: number) => ({
    x,
    z,
    width,
    depth,
    height: 300,
    tiers: [{ width, depth, height: 300 }],
  });
  const BOX = [
    wall(440, 500, 120, 400), // west  — x 380..500
    wall(680, 500, 200, 400), // east  — x 580..780
    wall(540, 360, 400, 200), // north — z 260..460
    wall(540, 640, 400, 200), // south — z 540..740
  ];

  it("falls through to RECOVER when every heading in the fan is blocked", () => {
    const bots = new RoomBots("room-1", 3, BOX);
    const [entry] = bots.syncTo(1, () => spawnAt(540, 500, 0, 100)).spawned;
    if (!entry) throw new Error("no bot");
    // A contact 30 m dead ahead, in the open and plainly visible — so the bot
    // WANTS to chase, and only the boxed-in terrain can stop it.
    const target = {
      id: "11111111-aaaa-bbbb-cccc-00000000000a",
      pos: { x: 540, y: 100, z: 470 },
      vel: { x: 0, y: 0, z: 0 },
      prot: false,
    };
    let recovered = false;
    for (let i = 1; i <= 2 * BOT_DECISION_EVERY; i++) {
      const self = bots.contactOf(entry.id);
      if (!self) break;
      bots.tick(i * SNAPSHOT_INTERVAL_MS, [
        { id: entry.id, ...self, prot: false },
        target,
      ]);
      if (bots.stateOf(entry.id) === "RECOVER") recovered = true;
    }
    expect(recovered).toBe(true);
  });

  it("keeps the altitude floor as a hard override even mid-chase", () => {
    // Open sky, nothing to probe: the ONLY danger is being under BOT_MIN_ALT.
    const bots = new RoomBots("room-1", 3, []);
    const [entry] = bots.syncTo(1, () =>
      spawnAt(1000, 1000, 0, BOT_MIN_ALT - 5),
    ).spawned;
    if (!entry) throw new Error("no bot");
    const target = {
      id: "11111111-aaaa-bbbb-cccc-00000000000b",
      pos: { x: 1000, y: 10, z: 850 },
      vel: { x: 0, y: 0, z: 0 },
      prot: false,
    };
    for (let i = 1; i <= BOT_DECISION_EVERY; i++) {
      const self = bots.contactOf(entry.id);
      if (!self) throw new Error("bot vanished");
      bots.tick(i * SNAPSHOT_INTERVAL_MS, [
        { id: entry.id, ...self, prot: false },
        target,
      ]);
    }
    expect(bots.stateOf(entry.id)).toBe("RECOVER");
    // ...and the pull-up is real: it climbs back out instead of mushing in.
    for (let i = BOT_DECISION_EVERY + 1; i <= 30; i++) {
      const self = bots.contactOf(entry.id);
      if (!self) throw new Error("bot vanished");
      bots.tick(i * SNAPSHOT_INTERVAL_MS, [
        { id: entry.id, ...self, prot: false },
        target,
      ]);
    }
    const flight = bots.flightOf(entry.id);
    expect(flight?.pos.y).toBeGreaterThan(BOT_MIN_ALT);
  });
});

describe("line of sight gates acquisition", () => {
  // A 100 m parapet across the sight line. Sight lines that pass over its roof
  // are clear; ones that pass through it are not — so occlusion is switched by
  // moving the contact a few metres in ALTITUDE, which keeps it inside the
  // fire cone throughout. Bot flies -Z (yaw 0) at 110 m, level.
  // Far enough down the bot's track that it cannot overfly the parapet and
  // regain the sight line inside the window under test.
  const PARAPET = {
    x: 1000,
    z: 1000,
    width: 200,
    depth: 20,
    height: 100,
    tiers: [{ width: 200, depth: 20, height: 100 }],
  };
  const HUNTED = "11111111-aaaa-bbbb-cccc-00000000000c";
  /** Sight line clears the roof at the crossing (y ≈ 119 > 100). */
  const SEEN = { x: 1000, y: 120, z: 950 };
  /** Sight line passes through it (y ≈ 91 < 100), 0.05 rad off the nose. */
  const HIDDEN = { x: 1000, y: 88, z: 950 };

  const fly = (
    at: (tick: number) => { x: number; y: number; z: number },
    ticks: number,
  ) => {
    const bots = new RoomBots("room-1", 3, [PARAPET]);
    const [entry] = bots.syncTo(1, () => spawnAt(1000, 1400, 0, 110)).spawned;
    if (!entry) throw new Error("no bot");
    const held: (string | null)[] = [];
    const shotTimes: number[] = [];
    let acquiredAt: number | null = null;
    for (let i = 1; i <= ticks; i++) {
      const now = i * SNAPSHOT_INTERVAL_MS;
      const self = bots.contactOf(entry.id);
      if (!self) throw new Error("bot vanished");
      const result = bots.tick(now, [
        { id: entry.id, ...self, prot: false },
        { id: HUNTED, pos: at(i), vel: { x: 0, y: 0, z: 0 }, prot: false },
      ]);
      if (acquiredAt === null && bots.targetOf(entry.id) === HUNTED) {
        acquiredAt = now;
      }
      held.push(bots.targetOf(entry.id));
      for (const _ of result.shots) shotTimes.push(now);
    }
    return { bots, id: entry.id, held, shotTimes, acquiredAt };
  };

  it("never acquires a contact standing behind a tier box", () => {
    const { held } = fly(() => HIDDEN, 30);
    expect(held.every((t) => t === null)).toBe(true);
  });

  it("acquires the same contact the moment the sight line clears the roof", () => {
    const { held } = fly(() => SEEN, 30);
    expect(held.some((t) => t === HUNTED)).toBe(true);
  });

  it("holds a lost contact for the memory window, then lets it go", () => {
    // Visible for the first second, hidden from then on.
    const seenUntil = TICK_DOWN_HZ; // visible for the first second
    const { held } = fly(
      (i) => (i <= seenUntil ? SEEN : HIDDEN),
      4 * TICK_DOWN_HZ,
    );
    const at = (second: number) =>
      held[Math.round(seenUntil + second * TICK_DOWN_HZ) - 1];
    expect(at(0.5)).toBe(HUNTED);
    expect(at(1.9)).toBe(HUNTED);
    expect(at(2.4)).toBeNull();
  });

  it("is not blinded by nearer contacts hiding behind a tower", () => {
    // Three bandits dogfighting behind the parapet, all closer than a human in
    // open air off to the side. Walking only the nearest few sight lines would
    // spend the whole budget on the hidden three and acquire nobody.
    const bots = new RoomBots("room-1", 3, [PARAPET]);
    const [entry] = bots.syncTo(1, () => spawnAt(1000, 1400, 0, 110)).spawned;
    if (!entry) throw new Error("no bot");
    const OPEN = "11111111-aaaa-bbbb-cccc-00000000000d";
    const decoys = [0, 1, 2].map((i) => ({
      id: `bot:other:${i}`,
      pos: { x: 990 + i * 10, y: 88, z: 950 },
      vel: { x: 0, y: 0, z: 0 },
      prot: false,
    }));
    // Level with the bot and well clear of the parapet, so the sight line to
    // it never approaches the slab — but at 480 m it is FURTHER than all
    // three decoys (450 m), so distance order reaches it last.
    const open = {
      id: OPEN,
      pos: { x: 1480, y: 110, z: 1400 },
      vel: { x: 0, y: 0, z: 0 },
      prot: false,
    };
    let acquired: string | null = null;
    for (let i = 1; i <= 12; i++) {
      const self = bots.contactOf(entry.id);
      if (!self) throw new Error("bot vanished");
      bots.tick(i * SNAPSHOT_INTERVAL_MS, [
        { id: entry.id, ...self, prot: false },
        ...decoys,
        open,
      ]);
      acquired = bots.targetOf(entry.id) ?? acquired;
    }
    expect(acquired).toBe(OPEN);
  });

  it("still shoots while the sight line flickers — the reaction delay arms once", () => {
    // 0.4 s seen, 0.4 s hidden, repeatedly. A naive gate would drop and
    // re-acquire on every flicker, re-arming BOT_REACTION_MS (400 ms) each
    // time, and the bot would never get a shot off at all.
    const { shotTimes, acquiredAt } = fly(
      (i) => (Math.floor((i - 1) / 6) % 2 === 0 ? SEEN : HIDDEN),
      60,
    );
    expect(acquiredAt).not.toBeNull();
    expect(shotTimes.length).toBeGreaterThan(0);
    expect(Math.min(...shotTimes)).toBeGreaterThanOrEqual(
      (acquiredAt ?? 0) + BOT_REACTION_MS,
    );
  });
});

describe("long-sim regressions", () => {
  it("is deterministic: the same seed and inputs replay the same flight", () => {
    const city = generateCity(CITY_SEED);
    const run = () => {
      const bots = new RoomBots("room-1", 77, city);
      const roster = bots.syncTo(8, spreadSpawner()).spawned;
      for (let i = 1; i <= 90 * TICK_DOWN_HZ; i++) {
        bots.tick(i * (1000 / TICK_DOWN_HZ), []);
      }
      return roster.map((e) => {
        const f = bots.flightOf(e.id);
        if (!f) throw new Error("bot vanished");
        return [f.pos.x, f.pos.y, f.pos.z, f.yaw, f.pitch, f.speed];
      });
    };
    // Exact equality, not approximate: any Math.random leaking into the brain
    // would show up here within a tick or two.
    expect(run()).toEqual(run());
    // Long seeded sims: generous timeout so a loaded CI box cannot flake it.
  }, 30_000);

  it("keeps terrain crashes a minority of deaths in a live furball", () => {
    const city = generateCity(CITY_SEED);
    let crashed = 0;
    let shot = 0;
    let ceilingBreaches = 0;
    for (let room = 0; room < 3; room++) {
      const bots = new RoomBots(`room-${room}`, 2024 + room * 31, city);
      const combat = new Combat();
      const roster = bots.syncTo(11, spreadSpawner()).spawned;
      for (const e of roster) combat.addPlayer(e.id, 0);
      for (let i = 1; i <= 200 * TICK_DOWN_HZ; i++) {
        const now = i * (1000 / TICK_DOWN_HZ);
        for (const id of combat.tick(now).respawnsDue) {
          bots.respawn(
            id,
            pickRespawn([], () => 0.5),
          );
          combat.respawned(id, now);
        }
        const contacts = roster.flatMap((e) => {
          const self = bots.contactOf(e.id);
          return self
            ? [{ id: e.id, ...self, prot: combat.isProtected(e.id, now) }]
            : [];
        });
        const { shots, crashes } = bots.tick(now, contacts);
        for (const id of crashes) {
          if (combat.crash(id, now)) crashed++;
        }
        for (const s of shots) {
          if (!combat.isAlive(s.botId)) continue;
          const victim = bots.contactOf(s.targetId);
          const { hit } = applyBotFire(combat, s, victim?.pos ?? null, now);
          if (hit?.ok && hit.death) {
            bots.setDead(s.targetId);
            shot++;
          }
        }
        for (const e of roster) {
          const f = bots.flightOf(e.id);
          if (f && bots.poseOf(e.id) && f.pos.y > CLOUD_BASE) ceilingBreaches++;
        }
      }
    }
    // ST1's rule is absolute: weather must never kill a bot.
    expect(ceilingBreaches).toBe(0);
    // Vacuity guard — a furball with no gunfire would make the ratio trivial.
    expect(shot).toBeGreaterThan(0);
    expect(crashed / (crashed + shot)).toBeLessThan(0.4);
    // Long seeded sims: generous timeout so a loaded CI box cannot flake it.
  }, 30_000);
});

// --- L2 (ANGE-1PVSJE): bots and the moving obstacles ---

describe("bots vs the L2 movers", () => {
  const l2City = generateCity(CITY_SEED);
  const l2Field = generateMovers(CITY_SEED, l2City);

  /** Is this bot inside a mover right now? Measured EXTERNALLY, against the
   * real field — never against whatever field the RoomBots under test was
   * handed. That is what makes the negative control below mean anything: a
   * bot given an empty field is also crane-IMMORTAL, so asking its own crash
   * list would report zero in both runs and prove nothing. */
  const insideMover = (bots: RoomBots, id: string, now: number) => {
    const f = bots.flightOf(id);
    return f ? collideMovers(f.pos, PLAYER_RADIUS, l2Field, now) : null;
  };

  /** Within a crane's swept disc, at jib altitude — the volume a bot has to
   * spend real time in before "it never hit anything" says anything. */
  const inSweep = (pos: Vec3) =>
    l2Field.cranes.some((site) => {
      const dx = wrapDeltaAxis(site.x, pos.x);
      const dz = wrapDeltaAxis(site.z, pos.z);
      return (
        Math.hypot(dx, dz) < site.jibLength + PLAYER_RADIUS &&
        Math.abs(pos.y - site.hubY) < site.jibLength
      );
    });

  /** 120 s of contact-free patrol seeded around the three crane sites. */
  function patrolCranes(seed: number, probeMovers: boolean) {
    const bots = new RoomBots("room-0", seed, l2City, l2Field, probeMovers);
    let n = 0;
    const spawn = (): SpawnState => {
      const site = l2Field.cranes[n % l2Field.cranes.length];
      if (!site) throw new Error("no crane sites");
      const a = (n++ / 6) * Math.PI * 2;
      const p = canonicalize({
        x: site.x + Math.cos(a) * 150,
        y: 0,
        z: site.z + Math.sin(a) * 150,
      });
      // Nose pointed at the mast: forward is (-sin yaw, -cos yaw), and the
      // inward direction from the ring is (-cos a, -sin a).
      return {
        pos: { x: p.x, y: site.hubY, z: p.z },
        yaw: Math.atan2(Math.cos(a), Math.sin(a)),
        speed: RESPAWN_SPEED,
      };
    };
    bots.syncTo(11, spawn);

    let moverDeaths = 0;
    let sweepTicks = 0;
    const ticks = Math.round(120 * TICK_DOWN_HZ);
    for (let i = 1; i <= ticks; i++) {
      const now = i * (1000 / TICK_DOWN_HZ);
      for (const id of bots.tick(now, []).crashes) {
        if (insideMover(bots, id, now)) moverDeaths++;
        bots.respawn(id, spawn());
      }
      for (const id of bots.ids()) {
        const f = bots.flightOf(id);
        if (f && inSweep(f.pos)) sweepTicks++;
      }
    }
    return { moverDeaths, sweepTicks };
  }

  it("never flies a bot into a crane over 120 s of patrol at the crane sites", () => {
    let deaths = 0;
    let sweepTicks = 0;
    for (const seed of [1234, 7, 20260826]) {
      const r = patrolCranes(seed, true);
      deaths += r.moverDeaths;
      sweepTicks += r.sweepTicks;
    }
    // Vacuity guard: bots must spend real time inside the swept disc, or
    // "they never hit it" is only saying they flew somewhere else.
    expect(sweepTicks).toBeGreaterThan(800);
    expect(deaths).toBe(0);
  }, 60_000);

  /**
   * The adversarial version: a stationary decoy parked in the construction
   * block's open air, ~90 m from the mast — outside the sweep, so the bots'
   * GOAL is not itself inside solid geometry, but reaching it means crossing
   * the sweep over and over for two minutes. Nothing in a real match is this
   * relentless; it exists to make the probe's contribution measurable.
   */
  function orbitCrane(seed: number, probeMovers: boolean) {
    const site = l2Field.cranes[0];
    if (!site) throw new Error("no crane site");
    const bots = new RoomBots("room-0", seed, l2City, l2Field, probeMovers);
    let n = 0;
    const spawn = (): SpawnState => {
      const a = (n++ / 8) * Math.PI * 2;
      const p = canonicalize({
        x: site.x + Math.cos(a) * 230,
        y: 0,
        z: site.z + Math.sin(a) * 230,
      });
      return {
        pos: { x: p.x, y: site.hubY, z: p.z },
        yaw: Math.atan2(Math.cos(a), Math.sin(a)),
        speed: RESPAWN_SPEED,
      };
    };
    bots.syncTo(8, spawn);
    const lure = canonicalize({ x: site.x + 92, y: 0, z: site.z + 92 });
    const contacts = [
      {
        id: "decoy",
        pos: { x: lure.x, y: site.hubY, z: lure.z },
        vel: { x: 0, y: 0, z: 0 },
        prot: false,
      },
    ];

    let moverDeaths = 0;
    let sweepTicks = 0;
    const ticks = Math.round(120 * TICK_DOWN_HZ);
    for (let i = 1; i <= ticks; i++) {
      const now = i * (1000 / TICK_DOWN_HZ);
      for (const id of bots.tick(now, contacts).crashes) {
        if (insideMover(bots, id, now)) moverDeaths++;
        bots.respawn(id, spawn());
      }
      for (const id of bots.ids()) {
        const f = bots.flightOf(id);
        if (f && inSweep(f.pos)) sweepTicks++;
      }
    }
    return { moverDeaths, sweepTicks };
  }

  it("negative control: the probe is load-bearing, not decorative", () => {
    // The measured contribution of wiring movers into blockedAlong. Blind,
    // eight bots dogfighting through a crane's sweep for two minutes die to
    // it 42-46 times (mostly mast and jib, roughly evenly); with the probe on
    // it is 0-1, across every seed tried. This asserts the gap, not a
    // fragile exact count.
    const seeing = orbitCrane(1234, true);
    const blind = orbitCrane(1234, false);
    expect(blind.sweepTicks).toBeGreaterThan(800);
    expect(seeing.sweepTicks).toBeGreaterThan(800);
    expect(blind.moverDeaths).toBeGreaterThan(20);
    expect(seeing.moverDeaths * 10).toBeLessThan(blind.moverDeaths);
  }, 60_000);

  it("keeps the storm ceiling while it is busy dodging a crane", () => {
    // The mover probe must not have cost bots a guarantee they already had.
    let breaches = 0;
    const bots = new RoomBots("room-0", 99, l2City, l2Field);
    const site = l2Field.cranes[0];
    if (!site) throw new Error("no crane site");
    let n = 0;
    bots.syncTo(8, () => {
      const a = (n++ / 8) * Math.PI * 2;
      const p = canonicalize({
        x: site.x + Math.cos(a) * 150,
        y: 0,
        z: site.z + Math.sin(a) * 150,
      });
      return {
        pos: { x: p.x, y: site.hubY, z: p.z },
        yaw: Math.atan2(Math.cos(a), Math.sin(a)),
        speed: RESPAWN_SPEED,
      };
    });
    const ticks = Math.round(120 * TICK_DOWN_HZ);
    for (let i = 1; i <= ticks; i++) {
      bots.tick(i * (1000 / TICK_DOWN_HZ), []);
      for (const id of bots.ids()) {
        const f = bots.flightOf(id);
        if (f && f.pos.y > CLOUD_BASE) breaches++;
      }
    }
    expect(breaches).toBe(0);
  }, 60_000);

  it("crashes a bot into the blimp but never into a helicopter — D3, in the sim", () => {
    const heli = l2Field.aircraft.find((a) => a.kind === "helicopter");
    const blimp = l2Field.aircraft.find((a) => a.kind === "blimp");
    if (!heli || !blimp) throw new Error("missing aircraft");
    const bots = new RoomBots("room-0", 5, [], l2Field);
    bots.syncTo(2, () => spawnAt(0, 0));
    const [inHeli, inBlimp] = bots.ids();
    if (!inHeli || !inBlimp) throw new Error("expected two bots");

    const now = 1000 / TICK_DOWN_HZ;
    const hf = bots.flightOf(inHeli);
    const bf = bots.flightOf(inBlimp);
    if (!hf || !bf) throw new Error("no flight state");
    const hb = aircraftBox(heli, now);
    const bb = aircraftBox(blimp, now);
    hf.pos = { x: hb.x, y: hb.y, z: hb.z };
    bf.pos = { x: bb.x, y: bb.y, z: bb.z };

    const { crashes } = bots.tick(now, []);
    expect(crashes).toContain(inBlimp);
    expect(crashes).not.toContain(inHeli);
  });
});
