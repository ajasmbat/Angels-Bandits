// Drop-in FFA room manager — pure bookkeeping, no sockets, unit-testable.
// A joining player fills the first non-full room; a fresh room spawns when
// every room is full; an emptied room is discarded. Socket wiring lives in
// index.ts and only ever talks to this through join/leave/roomOf.
//
// B1 bots live here as ordinary members (RosterEntry.isBot) so rosters and
// broadcasts need no special casing; only capacity math tells them apart:
// `full` counts HUMANS (bots always yield seats), and desiredBots() is the
// backfill target index.ts syncs each room's bot population to.

import {
  BOT_FLOOR,
  CITY_SEED,
  ROOM_CAP,
} from "@angels-bandits/common/constants";
import type { RosterEntry } from "@angels-bandits/common/protocol";

export class Room {
  readonly members = new Map<string, RosterEntry>();

  constructor(
    readonly id: string,
    /** City seed every member must generate from (shared by all rooms for now). */
    readonly seed: number,
  ) {}

  /** Humans only — bots never count against the room cap. */
  get humanCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (!m.isBot) n++;
    return n;
  }

  get full(): boolean {
    return this.humanCount >= ROOM_CAP;
  }

  botIds(): string[] {
    return [...this.members.values()].filter((m) => m.isBot).map((m) => m.id);
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
    const room = this.list.find((r) => !r.full) ?? this.spawnRoom();
    room.members.set(id, { id, name });
    this.byMember.set(id, room);
    return room;
  }

  /** The standing room: the first one, created empty if none exists yet —
   * the arena bots keep alive so the first joiner never sees a dead sky. */
  ensureRoom(): Room {
    return this.list[0] ?? this.spawnRoom();
  }

  /** Register a server-flown bot as an ordinary member of `room`. */
  addBot(room: Room, id: string, name: string): RosterEntry {
    const entry: RosterEntry = { id, name, isBot: true };
    room.members.set(id, entry);
    this.byMember.set(id, room);
    return entry;
  }

  /**
   * The bot population `room` should be synced to: backfill to BOT_FLOOR
   * combatants, each human displacing one bot. A room with no humans keeps
   * flying only as the standing (first) room; other human-less rooms wind
   * down to zero so a join spike doesn't leave bot-only rooms forever.
   */
  desiredBots(room: Room): number {
    const humans = room.humanCount;
    if (humans === 0 && this.list[0] !== room) return 0;
    return Math.max(0, BOT_FLOOR - humans);
  }

  /** Remove `id` (human or bot); returns the room it left (dropped from the
   * list if now empty). */
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

  private spawnRoom(): Room {
    const room = new Room(`room-${this.nextRoomId++}`, CITY_SEED);
    this.list.push(room);
    return room;
  }
}
