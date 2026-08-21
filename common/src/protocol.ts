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

export type ClientMsg = JoinMsg | PoseMsg;

// --- Server → client ---

/** Reply to a join: identity, room, shared city seed, spawn, current roster. */
export interface WelcomeMsg {
  type: "welcome";
  id: string;
  roomId: string;
  seed: number;
  spawn: SpawnState;
  roster: RosterEntry[];
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

export type ServerMsg =
  | WelcomeMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | SnapshotMsg;
