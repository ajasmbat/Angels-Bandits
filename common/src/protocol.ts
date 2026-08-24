// The single home for ALL client↔server message types (PLAN.md → Networking).
// Every wire message — join, pose updates up, snapshots down — is typed HERE
// and nowhere else, shared verbatim by client and server. JSON over plain ws;
// keeping every shape in this one file is what makes a binary encoder a later
// drop-in swap.

import type { Vec3 } from "./world/index";

/** Unit quaternion, Three.js component order. Attitude of a plane on the wire. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A plane's streamed pose. `pos` is canonical (x/z in [0, WORLD_SIZE)). */
export interface Pose {
  pos: Vec3;
  quat: Quat;
  speed: number;
}

/**
 * Server-assigned spawn. Yaw/pos/speed rather than a full Pose because the
 * joining client seeds its own FlightState from it (client-auth movement).
 */
export interface SpawnState {
  pos: Vec3;
  yaw: number;
  speed: number;
}

/** One player as the roster knows them. */
export interface RosterEntry {
  id: string;
  name: string;
  /** Set (true) only on server-flown backfill bots — drives client styling. */
  isBot?: boolean;
}

// --- Client → server ---

export interface JoinMsg {
  type: "join";
  name: string;
}

/** Streamed at TICK_UP_HZ once joined. */
export interface PoseMsg {
  type: "pose";
  pose: Pose;
}

/**
 * One shot fired. `seq` is a client-increasing bullet id — hit claims must
 * reference a fired seq, so one bullet can never land twice. Firing cancels
 * spawn protection server-side.
 */
export interface FireMsg {
  type: "fire";
  seq: number;
}

/**
 * Shooter-side hit claim (PLAN.md: hits resolve on the shooter's client,
 * favoring the shooter; the server only validates plausibility).
 */
export interface HitClaimMsg {
  type: "hit";
  targetId: string;
  bulletOrigin: Vec3;
  seq: number;
  /**
   * The shooter's live interpolation delay, ms (ANGE-4KO2W2). The server's
   * range slack exists to absorb the distance both planes cover during
   * exactly this window, so the claim has to declare it — a LAN shooter gets
   * a tight window, a buffered one gets the room it actually needs. The
   * server clamps it to [INTERP_FLOOR_MS, INTERP_DELAY_MAX_MS] and treats an
   * absent or nonsense value as the FLOOR, so declaring is never a way to buy
   * more than the ceiling already allows.
   */
  delay: number;
}

/** The client flew into a building or the ground (client-auth movement). */
export interface CrashMsg {
  type: "crash";
}

/**
 * A claim on the room's shared bot count (ANGE-6STDNN) — anyone may send it,
 * any time. `count` is ABSOLUTE (0–BOT_TARGET_MAX), not a delta. The server
 * clamps, rate-limits, and answers with botsConfig; a claim it drops is
 * simply never echoed, so the sender's slider snaps back.
 */
export interface SetBotsMsg {
  type: "setBots";
  count: number;
}

export type ClientMsg =
  | JoinMsg
  | PoseMsg
  | FireMsg
  | HitClaimMsg
  | CrashMsg
  | SetBotsMsg;

// --- Server → client ---

/** One player's kill/death tally (server-owned; resets only on rejoin). */
export interface ScoreEntry {
  id: string;
  kills: number;
  deaths: number;
}

/** Reply to a join: identity, room, shared city seed, spawn, current roster. */
export interface WelcomeMsg {
  type: "welcome";
  id: string;
  roomId: string;
  seed: number;
  spawn: SpawnState;
  roster: RosterEntry[];
  /** Current scoreboard, so a late joiner doesn't start from a blank board. */
  scores: ScoreEntry[];
  /** The room's shared bot count, so a late joiner's slider starts in the
   * right place instead of guessing the default. */
  botTarget: number;
}

export interface PlayerJoinedMsg {
  type: "playerJoined";
  player: RosterEntry;
}

export interface PlayerLeftMsg {
  type: "playerLeft";
  id: string;
}

/** One plane's snapshot state, DECODED — what the client actually consumes.
 * The wire carries `WireSnapshotEntry` instead; see common/src/net.ts. */
export interface SnapshotEntry {
  id: string;
  pose: Pose;
  /** Server-owned HP, rounded to whole points (regen arrives through here). */
  hp: number;
  /** True while spawn protection is active (clients render the shimmer). */
  prot: boolean;
}

/**
 * One snapshot entry as it actually crosses the wire (ANGE-4KO2W2): a fixed
 * tuple of quantised INTEGERS, which is both shorter than the float text it
 * replaces and exactly reconstructible.
 *
 *   [id, x, y, z, qx, qy, qz, qw, speed, hp, prot?]
 *
 * Positions and airspeed are in tenths (POS_SCALE / SPEED_SCALE), attitude in
 * thousandths (QUAT_SCALE). `prot` is omitted while a plane is NOT
 * spawn-protected — the common case — and read back as false. Encode/decode
 * live in common/src/net.ts; nothing else may build this tuple by hand.
 */
export type WireSnapshotEntry = [
  id: string,
  x: number,
  y: number,
  z: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  speed: number,
  hp: number,
  prot?: 0 | 1,
];

/**
 * Room state at TICK_DOWN_HZ, DECODED — the shape client code sees after
 * common/src/net.ts unpacks the wire. Includes every player (sender too —
 * receivers skip their own id).
 */
export interface SnapshotMsg {
  type: "snapshot";
  time: number;
  players: SnapshotEntry[];
}

/**
 * Room state as it crosses the wire. `time` is the server's clock (ms) — the
 * client buffers snapshots and renders remotes its own adaptive interpolation
 * delay behind it (common/src/net.ts). `p` is terse on purpose: at 20 Hz the
 * key name is paid for on every snapshot, forever.
 */
export interface WireSnapshotMsg {
  type: "snapshot";
  time: number;
  p: WireSnapshotEntry[];
}

/** Broadcast to everyone else when a player's shot passes validation —
 * receivers render that plane's muzzle flash + tracer (cosmetic only). */
export interface FiredMsg {
  type: "fired";
  id: string;
}

/** A validated hit landed: the target's new server-owned HP. */
export interface DamageMsg {
  type: "damage";
  targetId: string;
  shooterId: string;
  hp: number;
}

/** Server-declared death. `killerId` null = un-credited crash or the storm
 * itself (⚡ environment). `"storm"` is the hidden death ceiling's kill bolt —
 * clients render the bolt at the victim's last snapshot pose; the wire never
 * carries a warning or a timer (the rule is discovered, not announced). */
export interface DeathMsg {
  type: "death";
  victimId: string;
  killerId: string | null;
  cause: "shot" | "crash" | "storm";
}

/**
 * Server-issued respawn after the kill-cam beat. The respawning client seeds
 * its FlightState from `spawn`; everyone else resets that player's
 * interpolation buffer (a respawn teleports — it must not glide).
 * `protectedUntil` is on the server's snapshot clock.
 */
export interface RespawnMsg {
  type: "respawn";
  id: string;
  spawn: SpawnState;
  protectedUntil: number;
}

/** Scoreboard delta, broadcast whenever a death changes the tallies. */
export interface ScoreMsg {
  type: "score";
  scores: ScoreEntry[];
}

/**
 * The room's bot count changed (ANGE-6STDNN). Broadcast to EVERYONE including
 * the setter — the server is the only authority on the applied value, so
 * every slider renders this and never its own optimistic guess. `byName` is
 * for the comms ticker's attribution line and is free text: render it as
 * textContent, and never hand it to the radio voice.
 */
export interface BotsConfigMsg {
  type: "botsConfig";
  count: number;
  byName: string;
}

export type ServerMsg =
  | WelcomeMsg
  | BotsConfigMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | WireSnapshotMsg
  | FiredMsg
  | DamageMsg
  | DeathMsg
  | RespawnMsg
  | ScoreMsg;
