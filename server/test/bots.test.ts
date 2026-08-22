// RoomBots seam: the server-side bot population of one room — spawn/despawn
// sync, the 4-state brain, shared-stepFlight simulation, and the combat
// routing (applyBotFire). Everything is seeded (mulberry32) — no Math.random
// — so every expectation here is deterministic.

import { generateCity } from "@angels-bandits/common/city";
import { collideCity, hitsGround } from "@angels-bandits/common/collision";
import {
  BOT_REACTION_MS,
  CITY_SEED,
  CLOUD_BASE,
  KILL_CAM_MS,
  MAX_HP,
  PLAYER_RADIUS,
  RESPAWN_SPEED,
} from "@angels-bandits/common/constants";
import { flightForward } from "@angels-bandits/common/flight";
import type { SpawnState } from "@angels-bandits/common/protocol";
import { canonicalize } from "@angels-bandits/common/world";
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

    // One decision (every 3rd tick) is enough to acquire and engage.
    for (let i = 0; i < 3; i++) bots.tick(i, contacts());
    expect(bots.stateOf(entry.id)).toBe("ENGAGE");
    expect(bots.targetOf(entry.id)).toBe(target.id);

    // Steering points across the seam: within a second the nose swings
    // toward NEGATIVE x (the short way), never the +x trek across the map.
    let crossed = false;
    for (let i = 3; i < 45; i++) {
      bots.tick(i * (1000 / 15), contacts());
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
    const bots = new RoomBots("room-1", 7, city);
    // Spawn deep in a street canyon at 60 m, flying west along the z=1000
    // street between tower rows — the climb-out forces RECOVER episodes
    // against real tier boxes. 900 ticks = 60 s at 15 Hz.
    const [entry] = bots.syncTo(1, () =>
      spawnAt(500, 1002, Math.PI / 2, 60),
    ).spawned;
    let sawRecover = false;
    for (let i = 1; i <= 900; i++) {
      const result = bots.tick(i * (1000 / 15), []);
      expect(result.crashes).toEqual([]);
      const flight = bots.flightOf(entry.id);
      if (!flight) throw new Error("bot vanished");
      expect(hitsGround(flight.pos)).toBe(false);
      expect(collideCity(flight.pos, PLAYER_RADIUS, city)).toBeNull();
      if (bots.stateOf(entry.id) === "RECOVER") sawRecover = true;
    }
    // The scenario is only meaningful if the probes actually fired.
    expect(sawRecover).toBe(true);
  });

  it("ceiling: 120 s chasing a carrot above the clouds never exceeds CLOUD_BASE", () => {
    const bots = new RoomBots("room-1", 7, []);
    const [entry] = bots.syncTo(1, () => spawnAt(1000, 1000)).spawned;
    let engaged = false;
    // The worst case for the ceiling: an unprotected bait that is ALWAYS
    // 250 m ahead of the bot's nose and parked above the cloud deck at
    // 700 m, so pursuit wants to climb forever. 1800 ticks = 120 s at 15 Hz.
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
      bots.tick(i * (1000 / 15), [bait]);
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

  it("respects the fire-rate token bucket at bot tick cadence (~15 Hz attempts)", () => {
    const combat = new Combat();
    combat.addPlayer(BOT_ID, 0);
    let accepted = 0;
    // 45 attempts over 3 s: the bucket caps sustained fire at 10/s
    // (FIRE_INTERVAL_MS) plus the FIRE_BURST_SLACK burst of 5.
    for (let k = 0; k < 45; k++) {
      const { accepted: ok } = applyBotFire(
        combat,
        deadOn(k),
        null,
        (k * 1000) / 15,
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
      const now = i * (1000 / 15);
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
