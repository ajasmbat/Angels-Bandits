// Drop-in FFA room manager — pure bookkeeping, no sockets, unit-testable.
// A joining player fills the first non-full room; a fresh room spawns when
// every room is full; an emptied room is discarded. Socket wiring lives in
// index.ts and only ever talks to this through join/leave/roomOf.
//
// The carrier's enemy planes (W1) live here as ordinary members
// (RosterEntry.isBot) so rosters and broadcasts need no special casing; only
// capacity math tells them apart: `full` counts HUMANS. A room exists while
// anyone is in it — enemies come and go with the carrier's waves
// (server/src/waves.ts), and the last human out takes them with them.
//
// ANGE-6STDNN → W1: the room owns an enemy INTENSITY every member's
// scoreboard control sets through setIntensity(). Governance is
// last-write-wins plus a per-player rate limit, both enforced HERE so the
// socket layer only has to relay; the value is per-room and in-memory, dying
// with the room.
//
// FL1 Flight Lab: a lab joiner gets a room of their own (`Room.lab`). Normal
// joins never land in one, and only a lab room ever holds a tuning other
// than DEFAULT_TUNING — which its pose validation (validate.ts roomPoseCap)
// is the only reader of.

import {
  CITY_SEED,
  LAB_ROOM_CAP,
  ROOM_CAP,
} from "@angels-bandits/common/constants";
import type { RosterEntry } from "@angels-bandits/common/protocol";
import {
  DEFAULT_TUNING,
  type FlightTuning,
  importTuningObject,
} from "@angels-bandits/common/tuning";
import {
  INTENSITY_DEFAULT,
  INTENSITY_RATE_MS,
  type Intensity,
  asIntensity,
} from "@angels-bandits/common/waves";

export class Room {
  readonly members = new Map<string, RosterEntry>();
  /** W1: the room's enemy intensity (common/src/waves.ts). */
  private level: Intensity = INTENSITY_DEFAULT;
  /** setterId → when their last accepted change landed (rate-limit clock). */
  private readonly lastSetAt = new Map<string, number>();
  /** FL1: the lab tuning this room's pose validation reads. Stays exactly
   * DEFAULT_TUNING's values in every non-lab room (applyLab refuses). */
  labTuning: FlightTuning = { ...DEFAULT_TUNING };
  /** FL1: boss, missiles, chaos and destruction run in a lab room only when
   * its pilot turns them on. */
  labChaos = false;
  /** W1: the carrier and its enemy waves run in a lab room only when its
   * pilot turns them on. */
  labWaves = false;

  constructor(
    readonly id: string,
    /** City seed every member must generate from (shared by all rooms for now). */
    readonly seed: number,
    /** FL1: a Flight Lab room — one pilot's private sandbox. */
    readonly lab = false,
  ) {}

  /**
   * FL1: apply a `lab` message's fields. A tuning is re-imported through the
   * shared importer (unknown keys and non-finite values dropped, ranges
   * clamped); one that fails to import is ignored. Returns false — and
   * changes nothing — in a non-lab room.
   */
  applyLab(msg: {
    tuning?: unknown;
    chaos?: unknown;
    waves?: unknown;
  }): boolean {
    if (!this.lab) return false;
    if (msg.tuning !== undefined) {
      const imported = importTuningObject(msg.tuning);
      if (imported.ok) this.labTuning = imported.tuning;
    }
    if (typeof msg.chaos === "boolean") this.labChaos = msg.chaos;
    if (typeof msg.waves === "boolean") this.labWaves = msg.waves;
    return true;
  }

  get intensity(): Intensity {
    return this.level;
  }

  /**
   * Apply one player's intensity claim. Anyone may set it at any time (last
   * write wins), but a claim is refused when it is not an integer or when
   * that player already landed one inside INTENSITY_RATE_MS — refused
   * silently, by design: a rate-limited drag is noise, not an error.
   * Out-of-range values are CLAMPED rather than refused. Returns the
   * accepted level, or null when the claim was refused.
   */
  setIntensity(
    setterId: string,
    level: unknown,
    now: number,
  ): Intensity | null {
    const v = asIntensity(level);
    if (v === null) return null;
    const last = this.lastSetAt.get(setterId);
    if (last !== undefined && now - last < INTENSITY_RATE_MS) return null;
    this.lastSetAt.set(setterId, now);
    this.level = v;
    return v;
  }

  /** Humans only — enemy planes never count against the room cap. */
  get humanCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (!m.isBot) n++;
    return n;
  }

  get full(): boolean {
    return this.humanCount >= ROOM_CAP;
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

  /** Put `id` in the first non-full room, spawning a new room if all are
   * full. `preferRoomId` (a W2 resume) wins when that room still exists and
   * has a seat. */
  join(id: string, name: string, preferRoomId?: string): Room {
    const preferred = this.list.find(
      (r) => r.id === preferRoomId && !r.full && !r.lab,
    );
    const room =
      preferred ?? this.list.find((r) => !r.full && !r.lab) ?? this.spawnRoom();
    room.members.set(id, { id, name });
    this.byMember.set(id, room);
    return room;
  }

  /** FL1: a fresh lab room of `id`'s own, or null when LAB_ROOM_CAP lab
   * rooms are already open. Never shared, never resumed into. */
  joinLab(id: string, name: string): Room | null {
    if (this.list.filter((r) => r.lab).length >= LAB_ROOM_CAP) return null;
    const room = this.spawnRoom(true);
    room.members.set(id, { id, name });
    this.byMember.set(id, room);
    return room;
  }

  /** Register a carrier's enemy plane as an ordinary member of `room`. */
  addBot(room: Room, id: string, name: string): RosterEntry {
    const entry: RosterEntry = { id, name, isBot: true };
    room.members.set(id, entry);
    this.byMember.set(id, room);
    return entry;
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

  private spawnRoom(lab = false): Room {
    const room = new Room(`room-${this.nextRoomId++}`, CITY_SEED, lab);
    this.list.push(room);
    return room;
  }
}
