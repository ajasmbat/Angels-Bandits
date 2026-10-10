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

  it("a resume (W2) prefers its old room while that room has a seat", () => {
    const mgr = new RoomManager();
    fill(mgr, 13); // room-1 full, p13 in room-2
    mgr.leave("p3");
    // room-1 has a seat again, but the resume asked for room-2.
    expect(mgr.join("p3", "Pilot 3", "room-2").id).toBe("room-2");
  });

  it("a resume into a full or vanished room falls back to a normal join", () => {
    const mgr = new RoomManager();
    fill(mgr, 12); // room-1 full
    expect(mgr.join("p13", "Pilot 13", "room-1").id).toBe("room-2");
    expect(mgr.join("p14", "Pilot 14", "room-99").id).toBe("room-2");
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

describe("enemy intensity and enemy members (W1, ANGE-6STDNN's governance)", () => {
  it("a fresh room starts at NORMAL", () => {
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    expect(room.intensity).toBe(1);
  });

  it("enemies never block humans: a room with 12 humans is full regardless of enemies", () => {
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    mgr.addBot(room, "bot:room-1:1", "BANDIT-1");
    fill(mgr, 11, 1);
    // 12 humans + 1 enemy: full for the NEXT human, who gets room 2.
    expect(room.full).toBe(true);
    const other = mgr.join("p13", "Pilot 13");
    expect(other.id).not.toBe(room.id);
  });

  it("clamps a claim to the 0–3 range (EASY–INSANE) instead of refusing it", () => {
    // Different setters so the per-player rate limit isn't what's under test.
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    expect(room.setIntensity("p1", 25, 0)).toBe(3);
    expect(room.intensity).toBe(3);
    expect(room.setIntensity("p2", -3, 0)).toBe(0);
    expect(room.intensity).toBe(0);
  });

  it("refuses a claim that is not a whole number, leaving the level alone", () => {
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    room.setIntensity("p1", 2, 0);
    for (const [i, bad] of [1.7, Number.NaN, "3", null, undefined].entries()) {
      // Fresh setter per case: a refusal must not consume the rate limit.
      expect(room.setIntensity(`bad${i}`, bad, 0)).toBeNull();
    }
    expect(room.intensity).toBe(2);
  });

  it("rate-limits each player to one accepted change per 3 s, last write wins", () => {
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    expect(room.setIntensity("p1", 2, 0)).toBe(2);
    // 1 s later, same player: dropped (3 s window), level untouched.
    expect(room.setIntensity("p1", 3, 1000)).toBeNull();
    expect(room.intensity).toBe(2);
    // A DIFFERENT player is not rate-limited by p1's write — and wins.
    expect(room.setIntensity("p2", 0, 1000)).toBe(0);
    expect(room.intensity).toBe(0);
    // Once p1's window has passed, p1 can take it back.
    expect(room.setIntensity("p1", 3, 3001)).toBe(3);
    expect(room.intensity).toBe(3);
  });

  it("addBot registers an enemy as a member; leave() removes it and can empty the room", () => {
    const mgr = new RoomManager();
    const room = mgr.join("p1", "Pilot 1");
    const entry = mgr.addBot(room, "bot:room-1:1", "BANDIT-1");
    expect(entry).toEqual({
      id: "bot:room-1:1",
      name: "BANDIT-1",
      isBot: true,
    });
    mgr.leave("p1");
    // The last human gone, its enemies still hold the room until they go.
    expect(room.humanCount).toBe(0);
    expect(room.members.size).toBe(1);
    expect(mgr.roomOf("bot:room-1:1")?.id).toBe(room.id);
    mgr.leave("bot:room-1:1");
    expect(mgr.rooms).toHaveLength(0);
  });
});
