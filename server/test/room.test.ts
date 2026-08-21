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
