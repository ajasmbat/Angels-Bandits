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

describe("bot backfill math", () => {
  it("a fresh standing room wants BOT_FLOOR bots (6, from PLAN's ≥6 combatants)", () => {
    const mgr = new RoomManager();
    const room = mgr.ensureRoom();
    expect(mgr.desiredBots(room)).toBe(6);
  });

  it("each human join displaces one bot: 1 human → 5 bots, 6+ humans → 0", () => {
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    expect(mgr.desiredBots(room)).toBe(5);
    fill(mgr, 5, 1);
    expect(mgr.desiredBots(room)).toBe(0);
    fill(mgr, 6, 6);
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
