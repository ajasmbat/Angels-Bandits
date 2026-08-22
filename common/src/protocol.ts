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
}

/** The client flew into a building or the ground (client-auth movement). */
export interface CrashMsg {
  type: "crash";
}

export type ClientMsg = JoinMsg | PoseMsg | FireMsg | HitClaimMsg | CrashMsg;

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
}

export interface PlayerJoinedMsg {
  type: "playerJoined";
  player: RosterEntry;
}

export interface PlayerLeftMsg {
  type: "playerLeft";
  id: string;
}

export interface SnapshotEntry {
  id: string;
  pose: Pose;
  /** Server-owned HP, rounded to whole points (regen arrives through here). */
  hp: number;
  /** True while spawn protection is active (clients render the shimmer). */
  prot: boolean;
}

/**
 * Room state at TICK_DOWN_HZ. `time` is the server's clock (ms) — the client
 * buffers snapshots and renders remotes INTERP_DELAY_MS behind it. Includes
 * every player (sender too — receivers skip their own id).
 */
export interface SnapshotMsg {
  type: "snapshot";
  time: number;
  players: SnapshotEntry[];
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

/** Server-declared death. `killerId` null = un-credited crash. */
export interface DeathMsg {
  type: "death";
  victimId: string;
  killerId: string | null;
  cause: "shot" | "crash";
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

export type ServerMsg =
  | WelcomeMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | SnapshotMsg
  | FiredMsg
  | DamageMsg
  | DeathMsg
  | RespawnMsg
  | ScoreMsg;
