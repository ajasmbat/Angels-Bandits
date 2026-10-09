// The single home for ALL client↔server message types (PLAN.md → Networking).
// Every wire message — join, pose updates up, snapshots down — is typed HERE
// and nowhere else, shared verbatim by client and server. JSON over plain ws;
// keeping every shape in this one file is what makes a binary encoder a later
// drop-in swap.

import type { NewsHeliSlot, NewsHeliTarget } from "./city/newsheli";
import type { CityEvent } from "./cityevents";
import type { WireMissile } from "./strike";
import type { Vec3 } from "./world/index";
import type { WreckParams } from "./wreck";

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
  /**
   * W2: the `resumeToken` from this player's last welcome. A live token
   * restores the same id, name and kills/deaths (back in the same room when
   * it still has a seat); an unknown, spent or expired one is ignored and the
   * join is an ordinary fresh one — never an error.
   */
  resume?: string;
}

/** Streamed at TICK_UP_HZ once joined. */
export interface PoseMsg {
  type: "pose";
  pose: Pose;
  /**
   * When this pose was taken, on the client's estimate of the SERVER clock,
   * ms (O2). Absent until the client has seen a snapshot. The server clamps
   * it to [arrival − POSE_AGE_MAX_MS, arrival] and forwards it as each
   * snapshot entry's `age`, so receivers interpolate on when the pose was
   * taken instead of on the tick that happened to sample it.
   */
  t?: number;
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
 * SPACE boost edge (F2): `on: true` the instant a burn starts, `on: false`
 * the instant it ends (release or the gauge running dry). Sent immediately,
 * never batched — the socket is ordered, so a start always lands before the
 * first boosted pose. The server steps its mirror of the shared energy model
 * (common/src/boost.ts) from these edges and validates speed against it.
 */
export interface BoostMsg {
  type: "boost";
  on: boolean;
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
  /** D4: the falling wreck (its id) this plane flew into — sent only when
   * the wreck, and no static solid, was what the local check hit. The
   * server credits the wreck's shooter only if its own geometry agrees. */
  wreck?: number;
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

/**
 * Keepalive (W1): sent while the client boots (city build, shader pre-warm)
 * and nothing else is flowing yet. It only refreshes the server's liveness
 * clock — it never extends a pending player's boot deadline.
 */
export interface PingMsg {
  type: "ping";
}

/**
 * W2: the tab went hidden (`on: true`) or came back (`on: false`). Away, the
 * plane leaves snapshots and targeting, can't be hit or score, and keeps its
 * room seat. The server applies `on: true` only once the plane has gone
 * AWAY_COMBAT_LOCK_MS without taking damage (a burst already landing can't
 * be dodged), and answers the return of a living plane with a `respawn`.
 */
export interface AwayMsg {
  type: "away";
  on: boolean;
}

export type ClientMsg =
  | JoinMsg
  | PingMsg
  | AwayMsg
  | PoseMsg
  | FireMsg
  | BoostMsg
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
  /** L1: the room's city events from the last SMOKE_LIFE_MS, oldest first, so
   * a joiner sees the same smoke, alarms and responders as everyone else. */
  cityEvents: CityEvent[];
  /** The room's news heli (L10): current target and the one before it, so a
   * late joiner flies the same heli as everyone else. Welcome-only — live
   * changes arrive as NewsHeliMsg, so snapshots pay nothing for it. */
  newsHeli?: NewsHeliSlot;
  /** W2: single-use secret that lets this player's next `join` resume the
   * session (same id and score) within RESUME_WINDOW_MS of a drop. Fresh on
   * every welcome; never logged. */
  resumeToken: string;
  /** D2: the room's whole destroyed-chunk set, delta-encoded
   * (city/destruction.ts encodeChunkIds), so a late joiner — or a resume
   * into another room — sees and collides with the same broken city. The
   * client RESETS to it: the set may be smaller than what it held. */
  destroyed: number[];
  /** S3: every stunt course's leaderboard and record ghost, in course id
   * order (common/src/courses.ts generateCourses for this seed). The rings
   * themselves are never sent — both sides generate them from the seed. */
  courses?: CourseStanding[];
  /** D4: the room's wrecks still falling, so a late joiner (or a resume)
   * sees and collides with them too. */
  wrecks?: WreckParams[];
  /** X1: the room's missiles still in the air (common/src/strike.ts
   * encodeMissile), so a late joiner — or a resume — sees, hears and
   * dodges the same incoming strikes as everyone else. */
  missiles?: WireMissile[];
}

// --- S3 stunt courses ---

export type Medal = "gold" | "silver" | "bronze";

/**
 * A recorded flight path (S3 ghost), recorded by the SERVER from a run's
 * accepted poses. `d` is flat integers in POS_SCALE units: the first sample
 * absolute (x, y, z), every later one a wrap-safe delta from the one before.
 * Sample k is at min(k / hz, durMs) seconds after the start ring — the last
 * sample is the finish crossing, which may fall between two grid instants.
 * Positions only: playback derives attitude from the path itself.
 */
export interface GhostPath {
  hz: number;
  durMs: number;
  d: number[];
}

/** One row of a course leaderboard. `timeMs` includes miss penalties. */
export interface CourseBoardEntry {
  name: string;
  timeMs: number;
  missed: number;
  medal: Medal | null;
}

/** A course's leaderboard (best first, at most COURSE_BOARD_SIZE rows) and
 * the record holder's ghost, null until anyone finishes. */
export interface CourseStanding {
  course: number;
  board: CourseBoardEntry[];
  ghost: GhostPath | null;
}

/**
 * S3: the server's OFFICIAL result of the runner's own finished run, timed
 * from its accepted pose history (the client's HUD time is provisional).
 * Sent to the runner only. `rank` is the board position (1-based), or null
 * when the time did not make the board.
 */
export interface CourseResultMsg {
  type: "courseResult";
  course: number;
  timeMs: number;
  missed: number;
  medal: Medal | null;
  rank: number | null;
  record: boolean;
}

/**
 * S3: a course leaderboard changed. Sent to every client on the same city
 * seed (records are process-wide, not per room). `ghost` and `record` are
 * present only when the record itself fell — receivers keep the ghost they
 * have otherwise.
 */
export interface CourseBoardMsg {
  type: "courseBoard";
  course: number;
  board: CourseBoardEntry[];
  ghost?: GhostPath;
  record?: { name: string; timeMs: number };
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
  /** How long before the snapshot's `time` this pose was taken, whole ms
   * (O2): the pose's own time is `time − age`. 0 for bots (posed by the tick
   * itself); absent reads as 0. */
  age?: number;
}

/**
 * One snapshot entry as it actually crosses the wire (ANGE-4KO2W2): a fixed
 * tuple of quantised INTEGERS, which is both shorter than the float text it
 * replaces and exactly reconstructible.
 *
 *   [id, x, y, z, qx, qy, qz, qw, speed, hp, prot?, age?]
 *
 * Positions and airspeed are in tenths (POS_SCALE / SPEED_SCALE), attitude in
 * thousandths (QUAT_SCALE). `prot` is omitted while a plane is NOT
 * spawn-protected — the common case — and read back as false. `age` (O2,
 * whole ms) is omitted when 0 — every bot row — and when present `prot` is
 * written as an explicit 0/1 so the slot is never a JSON hole. Encode/decode
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
  age?: number,
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

/** A validated hit landed: the target's new server-owned HP. X1 missile
 * damage carries `shooterId` MISSILE_SHOOTER_ID (common/src/strike.ts —
 * never a plane's id) and the impact point in `from`, so the damage
 * indicator points at the blast rather than at a shooter. */
export interface DamageMsg {
  type: "damage";
  targetId: string;
  shooterId: string;
  hp: number;
  from?: Vec3;
}

/** Server-declared death. `killerId` null = un-credited crash or the storm
 * itself (⚡ environment). `"storm"` is the hidden death ceiling's kill bolt —
 * clients render the bolt at the victim's last snapshot pose; the wire never
 * carries a warning or a timer (the rule is discovered, not announced).
 * `"wreck"` (D4): the victim flew into a falling wreck — `killerId` is the
 * pilot who shot that wreck down. `"missile"` (X1) is an incoming
 * strike's blast — environment, credited only by the crash rule. */
export interface DeathMsg {
  type: "death";
  victimId: string;
  killerId: string | null;
  cause: "shot" | "crash" | "storm" | "wreck" | "missile";
  /** S1: the server's kill site — the victim's on-record position,
   * canonical and rounded to whole meters — so every client's jumbotron
   * headline names the same place. Absent when the server had no pose. */
  x?: number;
  z?: number;
  /** D4: a shot-down plane falls as this wreck (common/src/wreck.ts) and
   * hits the city at `wreck.t + wreck.end` instead of exploding in place.
   * Absent for crash/storm deaths and over the room's WRECKS_MAX. */
  wreck?: WreckParams;
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

/** L1: a server-accepted moment the city reacts to (gunfire near buildings,
 * a death). Sent right after the `death` it belongs to, same server `now`. */
export interface CityEventMsg {
  type: "cityEvent";
  event: CityEvent;
}

/**
 * The news heli takes a new story (L10): the server picked the latest kill
 * site and authored the route there. Every client installs it and derives the
 * pose from (target, server clock) — the same pure function the server's bot
 * probes use. Broadcast to the whole room.
 */
export interface NewsHeliMsg {
  type: "newsHeli";
  target: NewsHeliTarget;
}

/**
 * D2: chunks the server destroyed since the last tick, delta-encoded
 * (encodeChunkIds). At most one per room per TICK_DOWN_HZ tick, and only
 * when something broke. Every client adds them to its CityDamage, so its
 * collision and rendering subtract exactly what everyone else's do.
 */
export interface ChunksMsg {
  type: "chunks";
  d: number[];
}

/**
 * X1: the server launched a missile strike. Everything about its flight —
 * the arc, the whistle, the impact instant — is a pure function of this
 * event and the synced clock (common/src/strike.ts), so every client sees
 * the same missile. Its damage arrives the usual ways: `chunks`, `damage`,
 * `death` and a `missile` city event.
 */
export interface MissileMsg {
  type: "missile";
  m: WireMissile;
}

/**
 * W2: the player's own `away: true` has taken effect (sent to that player
 * only — to everyone else the plane just leaves snapshots). From here its
 * return is answered with a `respawn`, which the client waits for before
 * posing again.
 */
export interface AwayStartedMsg {
  type: "awayStarted";
}

export type ServerMsg =
  | WelcomeMsg
  | ChunksMsg
  | MissileMsg
  | CourseResultMsg
  | CourseBoardMsg
  | AwayStartedMsg
  | NewsHeliMsg
  | BotsConfigMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | WireSnapshotMsg
  | FiredMsg
  | DamageMsg
  | DeathMsg
  | RespawnMsg
  | ScoreMsg
  | CityEventMsg;
