// Drop-in FFA room manager — pure bookkeeping, no sockets, unit-testable.
// A joining player fills the first non-full room; a fresh room spawns when
// every room is full; an emptied room is discarded. Socket wiring lives in
// index.ts and only ever talks to this through join/leave/roomOf.

import { CITY_SEED, ROOM_CAP } from "@angels-bandits/common/constants";
import type { RosterEntry } from "@angels-bandits/common/protocol";

export class Room {
  readonly members = new Map<string, RosterEntry>();

  constructor(
    readonly id: string,
    /** City seed every member must generate from (shared by all rooms for now). */
    readonly seed: number,
  ) {}

  get full(): boolean {
    return this.members.size >= ROOM_CAP;
  }

  roster(): RosterEntry[] {
    return [...this.members.values()];
  }
}

export class RoomManager {
  private readonly list: Room[] = [];
  private readonly byMember = new Map<string, Room>();
  private nextRoomId = 1;

  get rooms(): readonly Room[] {
    return this.list;
  }

  /** Put `id` in the first non-full room, spawning a new room if all are full. */
  join(id: string, name: string): Room {
    let room = this.list.find((r) => !r.full);
    if (!room) {
      room = new Room(`room-${this.nextRoomId++}`, CITY_SEED);
      this.list.push(room);
    }
    room.members.set(id, { id, name });
    this.byMember.set(id, room);
    return room;
  }

  /** Remove `id`; returns the room it left (dropped from the list if now empty). */
  leave(id: string): Room | undefined {
    const room = this.byMember.get(id);
    if (!room) return undefined;
    this.byMember.delete(id);
    room.members.delete(id);
    if (room.members.size === 0) {
      this.list.splice(this.list.indexOf(room), 1);
    }
    return room;
  }

  roomOf(id: string): Room | undefined {
    return this.byMember.get(id);
  }
}
