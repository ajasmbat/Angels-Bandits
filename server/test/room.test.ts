// RoomManager seam: join/leave/room assignment, no sockets involved.
// ROOM_CAP is pinned to 12 by PLAN.md, so the literals here (13 joins → a
// second room) come from the spec, not from re-reading the constant.

import { describe, expect, it } from "vitest";
import { RoomManager } from "../src/room";

const fill = (mgr: RoomManager, n: number, offset = 0) => {
  const rooms = [];
  for (let i = 1 + offset; i <= n + offset; i++) {
    rooms.push(mgr.join(`p${i}`, `Pilot ${i}`));
  }
  return rooms;
};

describe("RoomManager", () => {
  it("13 sequential joins: the first 12 share one room, player 13 lands in a second", () => {
    const mgr = new RoomManager();
    const rooms = fill(mgr, 13);
    for (let i = 0; i < 12; i++) {
      expect(rooms[i].id).toBe(rooms[0].id);
    }
    expect(rooms[12].id).not.toBe(rooms[0].id);
    expect(mgr.rooms).toHaveLength(2);
  });

  it("a leave frees a slot: the next join fills the first room again", () => {
    const mgr = new RoomManager();
    fill(mgr, 13);
    mgr.leave("p5");
    const room = mgr.join("p14", "Pilot 14");
    expect(room.id).toBe(mgr.roomOf("p1")?.id);
    expect(mgr.rooms).toHaveLength(2);
  });

  it("removes a room once its last member leaves", () => {
    const mgr = new RoomManager();
    fill(mgr, 13);
    mgr.leave("p13");
    expect(mgr.rooms).toHaveLength(1);
  });

  it("tracks each member's room and roster entry", () => {
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Maverick");
    expect(mgr.roomOf("p1")?.id).toBe(room.id);
    expect(room.roster()).toEqual([{ id: "p1", name: "Maverick" }]);
    mgr.leave("p1");
    expect(mgr.roomOf("p1")).toBeUndefined();
  });
});

describe("bot population math", () => {
  it("a fresh standing room wants the default bot target (5, ANGE-6STDNN spec)", () => {
    const mgr = new RoomManager();
    const room = mgr.ensureRoom();
    expect(room.botTarget).toBe(5);
    expect(mgr.desiredBots(room)).toBe(5);
  });

  it("the target is ABSOLUTE: humans take seats only once the room fills", () => {
    // Spec: actualBots = min(T, ROOM_CAP − humans). With T=8 and 10 humans
    // only 2 seats are left, so 6 bots are pushed out; 12 humans leave none.
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    room.setBotTarget("p1", 8, 0);
    expect(mgr.desiredBots(room)).toBe(8);
    fill(mgr, 9, 1);
    expect(room.humanCount).toBe(10);
    expect(mgr.desiredBots(room)).toBe(2);
    fill(mgr, 2, 10);
    expect(room.humanCount).toBe(12);
    expect(mgr.desiredBots(room)).toBe(0);
  });

  it("bots never block humans: a room with 12 humans is full regardless of bots", () => {
    const mgr = new RoomManager();
    const room = mgr.ensureRoom();
    mgr.addBot(room, "bot:room-1:1", "BANDIT-1");
    fill(mgr, 12);
    // 12 humans + 1 lingering bot: full for the NEXT human, who gets room 2.
    expect(room.full).toBe(true);
    const other = mgr.join("p13", "Pilot 13");
    expect(other.id).not.toBe(room.id);
  });

  it("clamps a claim to the 0–11 range instead of refusing it", () => {
    // Spec range: 0–11 (ROOM_CAP − 1 — one seat is always left for a human).
    // Different setters so the per-player rate limit isn't what's under test.
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    expect(room.setBotTarget("p1", 25, 0)).toBe(11);
    expect(room.botTarget).toBe(11);
    expect(room.setBotTarget("p2", -3, 0)).toBe(0);
    expect(room.botTarget).toBe(0);
  });

  it("refuses a claim that is not a whole number, leaving the target alone", () => {
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    room.setBotTarget("p1", 7, 0);
    for (const [i, bad] of [4.7, Number.NaN, "8", null, undefined].entries()) {
      // Fresh setter per case: a refusal must not consume the rate limit.
      expect(room.setBotTarget(`bad${i}`, bad, 0)).toBeNull();
    }
    expect(room.botTarget).toBe(7);
  });

  it("rate-limits each player to one accepted change per 3 s, last write wins", () => {
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    expect(room.setBotTarget("p1", 2, 0)).toBe(2);
    // 1 s later, same player: dropped (3 s window), target untouched.
    expect(room.setBotTarget("p1", 9, 1000)).toBeNull();
    expect(room.botTarget).toBe(2);
    // A DIFFERENT player is not rate-limited by p1's write — and wins.
    expect(room.setBotTarget("p2", 4, 1000)).toBe(4);
    expect(room.botTarget).toBe(4);
    // Once p1's window has passed, p1 can take it back.
    expect(room.setBotTarget("p1", 9, 3001)).toBe(9);
    expect(room.botTarget).toBe(9);
  });

  it("a bot-only room that is not the standing (first) room wants 0 bots", () => {
    const mgr = new RoomManager();
    fill(mgr, 13); // rooms 1 and 2 exist
    const second = mgr.roomOf("p13");
    if (!second) throw new Error("expected a second room");
    mgr.leave("p13");
    // p13 left but the room lingers only if it still has members; simulate
    // the bot that was backfilled into it surviving the leave.
    mgr.addBot(second, "bot:room-2:1", "BANDIT-1");
    expect(mgr.desiredBots(second)).toBe(0);
  });

  it("addBot registers the bot as a member; leave() despawns it and can empty the room", () => {
    const mgr = new RoomManager();
    const room = mgr.ensureRoom();
    const entry = mgr.addBot(room, "bot:room-1:1", "BANDIT-1");
    expect(entry).toEqual({
      id: "bot:room-1:1",
      name: "BANDIT-1",
      isBot: true,
    });
    expect(room.humanCount).toBe(0);
    expect(room.members.size).toBe(1);
    expect(mgr.roomOf("bot:room-1:1")?.id).toBe(room.id);
    mgr.leave("bot:room-1:1");
    expect(mgr.rooms).toHaveLength(0);
  });

  it("ensureRoom returns the existing first room instead of minting a new one", () => {
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    expect(mgr.ensureRoom().id).toBe(room.id);
    expect(mgr.rooms).toHaveLength(1);
  });
});
