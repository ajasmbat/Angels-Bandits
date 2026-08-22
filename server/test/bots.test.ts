// RoomBots seam: the server-side bot population of one room — spawn/despawn
// sync, the 4-state brain, shared-stepFlight simulation, and the combat
// routing (applyBotFire). Everything is seeded (mulberry32) — no Math.random
// — so every expectation here is deterministic.

import { generateCity } from "@angels-bandits/common/city";
import { collideCity, hitsGround } from "@angels-bandits/common/collision";
import {
  CITY_SEED,
  PLAYER_RADIUS,
  RESPAWN_SPEED,
} from "@angels-bandits/common/constants";
import type { SpawnState } from "@angels-bandits/common/protocol";
import { describe, expect, it } from "vitest";
import { RoomBots } from "../src/bots";

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
    const [entry] = bots.syncTo(
      1,
      () => spawnAt(500, 1002, Math.PI / 2, 60),
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

  it("a bot pose carries the spawn position, yaw attitude, and speed", () => {
    const bots = new RoomBots("room-1", 7, []);
    const [entry] = bots.syncTo(1, () => spawnAt(100, 200, Math.PI / 2)).spawned;
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
