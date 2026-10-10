// The single home for ALL client↔server message types (PLAN.md → Networking).
// Every wire message — join, pose updates up, snapshots down — is typed HERE
// and nowhere else, shared verbatim by client and server. JSON over plain ws;
// keeping every shape in this one file is what makes a binary encoder a later
// drop-in swap.

import type { WireRacks } from "./bombs";
import type {
  BossDown,
  WireBossRaid,
  WireBossState,
  WireFlak,
  WireLaunch,
} from "./boss";
import type { WireChaosState, WireQuake } from "./chaos";
import type { WireCaveIn } from "./city/caveins";
import type { CollapseWire } from "./city/collapse";
import type { NewsHeliSlot, NewsHeliTarget } from "./city/newsheli";
import type { WireCrater, WirePropState } from "./city/props";
import type { CityEvent } from "./cityevents";
import type { RebuildWire, WireDirectorEvent } from "./director";
import type { MedalKind, StreakTier } from "./medals";
import type { WireMissile } from "./strike";
import type { WireWaves } from "./waves";
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
  /** Set (true) only on server-flown planes (W1: the carrier's enemies) —
   * drives client styling. */
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
  /**
   * FL1: join the Flight Lab — a private solo room of this player's own,
   * whose pose validation reads the room's lab tuning. A lab join never
   * resumes (any `resume` is ignored) and never shares a room.
   */
  lab?: boolean;
}

/**
 * FL1: the Flight Lab's controls, lab rooms only (ignored anywhere else).
 * `tuning` is a decoded export (`JSON.parse(exportTuning(t))`, common/src/
 * tuning.ts) — the server re-imports and clamps it, and the room's pose
 * validation caps speed by it. `chaos` lets the boss, missiles, chaos and
 * destruction run in the room (off by default). The newest message wins.
 */
export interface LabMsg {
  type: "lab";
  tuning?: unknown;
  chaos?: boolean;
  /** W1: the carrier and its enemy waves (off by default). */
  waves?: boolean;
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
  /** D3: the server-clock time the crash was detected at — the movers'
   * render time, which falling collapse debris is posed at. The server
   * clamps it to the pose-age window and uses it only to tell a collapse
   * kill from a plain crash; absent means "now". */
  t?: number;
  /** D4: the falling wreck (its id) this plane flew into — sent only when
   * the wreck, and no static solid, was what the local check hit. The
   * server credits the wreck's shooter only if its own geometry agrees. */
  wreck?: number;
}

/**
 * W1: a claim on the room's shared enemy intensity (ANGE-6STDNN's slider,
 * now Easy / Normal / Hard / Insane = 0–3, common/src/waves.ts) — anyone may
 * send it, any time. The server clamps, rate-limits, and answers with
 * intensityConfig; a claim it drops is simply never echoed, so the sender's
 * control snaps back. It shapes the room's waves from the next one on.
 */
export interface SetIntensityMsg {
  type: "setIntensity";
  level: number;
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

/**
 * S4: a shooter-side hit claim on the sky boss's weak point `wp` (an index
 * into common/src/boss.ts BOSS_WEAK_POINTS). Unlike a plane, the boss's pose
 * is the server's own, so the claim carries the round's whole line — the
 * muzzle `bulletOrigin`, the unit `dir` it flew and the server-clock time
 * `t` it met the weak point (the render time) — and the server re-runs the
 * ray against the armour itself (bossHitValid).
 */
export interface BossHitMsg {
  type: "bossHit";
  wp: number;
  seq: number;
  bulletOrigin: Vec3;
  dir: Vec3;
  t: number;
}

export type ClientMsg =
  | JoinMsg
  | BossHitMsg
  | PingMsg
  | AwayMsg
  | PoseMsg
  | FireMsg
  | BoostMsg
  | HitClaimMsg
  | CrashMsg
  | SetIntensityMsg
  | LabMsg;

// --- Server → client ---

/** One player's kill/death tally (server-owned; resets only on rejoin). */
export interface ScoreEntry {
  id: string;
  kills: number;
  deaths: number;
  /** S7: the pilot's current kill streak — the one source of truth for the
   * scoreboard glow and the streak smoke. Omitted while 0. */
  streak?: number;
}

/** Reply to a join: identity, room, shared city seed, spawn, current roster. */
export interface WelcomeMsg {
  type: "welcome";
  id: string;
  roomId: string;
  /** FL1: set only when this is a Flight Lab room — the one place a client
   * may apply lab tuning. */
  lab?: true;
  seed: number;
  spawn: SpawnState;
  roster: RosterEntry[];
  /** Current scoreboard, so a late joiner doesn't start from a blank board. */
  scores: ScoreEntry[];
  /** W1: the room's shared enemy intensity (0–3), so a late joiner's
   * control starts in the right place instead of guessing the default. */
  intensity: number;
  /** W1: the room's carrier war — the wave on or coming and the enemies
   * left (common/src/waves.ts). */
  waves: WireWaves;
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
  /** D3: every collapse event in the room, in order (city/collapse.ts
   * CollapseWire). The client rebuilds each one's debris — falling or long
   * since landed — and its fallen chunks from exactly these, so a late
   * joiner sees and collides with what everyone else does. */
  collapses: CollapseWire[];
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
  /** W2: the enemy planes that have dropped bombs, with the racks they
   * still carry (common/src/bombs.ts) — an enemy left out is fully loaded. */
  racks?: WireRacks;
  /** D5: the director's events warned and not yet happened (common/src/
   * director.ts encodeDirectorEvent), so a late joiner hears the same rumble
   * and sees the same dust. Applied rebuilds need nothing here: `destroyed`
   * and `collapses` already leave them out. */
  director?: WireDirectorEvent[];
  /** S4: the room's sky boss — the raid (in the air, falling or long gone),
   * every weak point's HP and its break-up once it went down. Explicitly
   * null when the room has none, so a resume into another room clears the
   * old room's boss. */
  boss?: WireBossState | null;
  /** C2: the room's quakes still to come or shaking, and the burning
   * chunks — so a late joiner sees and hears the same chaos. Meteors ride
   * `missiles`. Absent: none (and a resume clears what it held). */
  chaos?: WireChaosState;
  /** U6: the room's live cave-ins (common/src/city/caveins.ts), so a late
   * joiner sees, hears and collides with the same falling rock and rubble.
   * Absent: none (and a resume clears what it held). */
  caveIns?: WireCaveIn[];
  /** D9: the room's destructible props that are down (and their blasts),
   * its street craters and its sooted chunks (common/src/city/props.ts),
   * so a late joiner sees and collides with the same wrecks, fallen tanks
   * and broken bridges. Absent: none (and a resume clears what it held). */
  props?: WirePropState;
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
 * itself (⚡ environment). `"collapse"` (D3) = crushed by falling debris:
 * the credit goes to whoever brought the building down. `"storm"` is the hidden death ceiling's kill bolt —
 * clients render the bolt at the victim's last snapshot pose; the wire never
 * carries a warning or a timer (the rule is discovered, not announced).
 * `"wreck"` (D4): the victim flew into a falling wreck — `killerId` is the
 * pilot who shot that wreck down. `"missile"` (X1) is an incoming
 * strike's blast — environment, credited only by the crash rule. */
export interface DeathMsg {
  type: "death";
  victimId: string;
  killerId: string | null;
  /** `"flak"` (S4): a sky-boss flak burst — environment, credited only by
   * the crash rule, like a missile. `"meteor"` / `"bomb"` (C2): a meteor's
   * or a dropped bomb's blast, the same. */
  cause:
    | "shot"
    | "crash"
    | "storm"
    | "wreck"
    | "collapse"
    | "missile"
    | "blast"
    | "flak"
    | "meteor"
    | "bomb"
    // W1: an enemy plane that went down with its carrier (no killer).
    | "carrier";
  /** S1: the server's kill site — the victim's on-record position,
   * canonical and rounded to whole meters — so every client's jumbotron
   * headline names the same place. Absent when the server had no pose. */
  x?: number;
  z?: number;
  /** D4: a shot-down plane falls as this wreck (common/src/wreck.ts) and
   * hits the city at `wreck.t + wreck.end` instead of exploding in place.
   * Absent for crash/storm deaths and over the room's WRECKS_MAX. */
  wreck?: WreckParams;
  /** W2: an enemy shot down on a bomb run with its bombs still aboard —
   * the load went up with it here (canonical, whole meters): a bigger
   * mid-air fireball and a shock ring. Its wreck (if any) still falls. */
  boom?: [x: number, y: number, z: number];
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
 * W1: the room's enemy intensity changed. Broadcast to EVERYONE including
 * the setter — the server is the only authority on the applied value, so
 * every control renders this and never its own optimistic guess. `byName`
 * is for the attribution line and is free text: render it as textContent,
 * and never hand it to the radio voice.
 */
export interface IntensityConfigMsg {
  type: "intensityConfig";
  level: number;
  byName: string;
}

/**
 * W1: the room's carrier war moved on — a wave's banner (WAVE_BREATHER), a
 * wave launching and fighting (WAVE_LIVE, with its enemies left), or no
 * wave (WAVE_IDLE). Sent only when it changes.
 */
export interface WavesMsg {
  type: "waves";
  w: WireWaves;
}

/**
 * S7: the server's credit for one kill (common/src/medals.ts MedalLedger).
 * Sent to the whole room for EVERY credited kill — right after its `death`
 * and before its `score` — so every client shows the same medals and the
 * killer's client picks the kill's sting in one place. `medals` may be
 * empty; clients drop kinds they do not know. `tier` is present only on
 * the kill that crossed into a streak tier (the announcer's trigger); the
 * streak itself rides `score`.
 */
export interface AwardMsg {
  type: "award";
  id: string;
  victimId: string;
  medals: MedalKind[];
  tier?: StreakTier;
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
  /** W2: a bomb dropped by an enemy plane — its id and the rack it fell
   * from (common/src/bombs.ts); clients empty that rack. */
  by?: string;
  r?: number;
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

/**
 * D3: a section of a building collapses. Sent once, the tick it happens;
 * every client marks `c.c`'s chunks fallen and builds the same debris from
 * `c` alone (pure in the event and the clock). Old clients ignore it.
 */
export interface CollapseMsg {
  type: "collapse";
  c: CollapseWire;
}

/**
 * S4: a sky-boss raid begins (common/src/boss.ts). Everything about the
 * zeppelin's flight is a pure function of this and the synced clock; its
 * weak points start at full HP.
 */
export interface BossMsg {
  type: "boss";
  r: WireBossRaid;
}

/** S4: the boss's weak points' HP after this tick's hits (one per tick at
 * most, only when something changed). `id` is the raid's. */
export interface BossHpMsg {
  type: "bossHp";
  id: number;
  hp: number[];
}

/** S9: the boss carrier launches a bot (common/src/boss.ts BossLaunch):
 * the plane hangs on its rig from `t0` and is released — `bot` respawns —
 * at launchReleaseAt. Everything between is a pure function of the clock. */
export interface BossLaunchMsg {
  type: "bossLaunch";
  l: WireLaunch;
  bot: string;
}

/** S4: the shells the boss's turrets fired this tick (boss.ts BossFlak):
 * each flies from its turret's muzzle at its firing to its burst point. */
export interface FlakMsg {
  type: "flak";
  f: WireFlak[];
}

/**
 * S4: the boss is down. `d` is its break-up — three sections on the D4 wreck
 * path to impacts the server already swept; `dealers` every pilot who hurt
 * it with their share in thousandths, most first; `top` the pilot who dealt
 * the most (null: nobody — it can only come down to damage, so never in
 * practice). The credited dealers' kills ride the `score` after it.
 */
export interface BossDownMsg {
  type: "bossDown";
  d: BossDown;
  dealers: [id: string, permille: number][];
  top: string | null;
}

/**
 * D5: the destruction director staged an event (common/src/director.ts):
 * a demolition, a gas main or a crane, happening at `e.at` — at least
 * DIRECTOR_WARN_MIN_MS after this is sent. Clients rumble, groan, sound the
 * sirens and spill dust; the event itself arrives the usual way (`collapse`,
 * or a `gas` city event with `chunks` and damage). A warning with no event
 * after it was called off (a fresh spawn walked into it). Old clients
 * ignore it.
 */
export interface DirectorWarnMsg {
  type: "directorWarn";
  e: WireDirectorEvent;
}

/**
 * D5: a building (or a felled crane) is rebuilt. `go: false` is the 2 s
 * announce — scaffolding sparks, nothing changes; `go: true` applies it on
 * arrival: every chunk of the building is whole again and its collapse
 * records (debris, rubble) are gone — in message order, so a `chunks` batch
 * sent after it is applied after it everywhere.
 */
export interface RebuildMsg {
  type: "rebuild";
  r: RebuildWire;
}

/** C2: a quake is coming (common/src/chaos.ts): the ground starts rumbling
 * now and shakes from `q.t` — at least QUAKE_LEAD_MS after this is sent.
 * What it breaks arrives the usual way (`chunks`, `collapse`). */
export interface QuakeMsg {
  type: "quake";
  q: WireQuake;
}

/** C2: chunks catching fire (`on`) and going out (`off`) since the last
 * tick, each delta-encoded (encodeChunkIds) — one batch per tick. Fire is
 * cosmetic to planes; the damage it does arrives as `chunks`. */
export interface FiresMsg {
  type: "fires";
  on: number[];
  off: number[];
}

/** U6: the ceiling of a deep bore is coming down (common/src/city/
 * caveins.ts): the warning starts at `c[3]`, the rock falls WARN later, and
 * every piece is a pure function of this and the synced clock. */
export interface CaveInMsg {
  type: "caveIn";
  c: WireCaveIn;
}

/**
 * D9: what the city's destructible props did this tick (common/src/city/
 * props.ts), at most one per room per tick and only when something
 * changed, sent right after the tick's `chunks` and collapses. Every field
 * is optional; old clients ignore the message.
 * - `d`: props that went down — pairs [idΔ, t] (ids ascending, Δ from the
 *   previous id, the first absolute; t absolute server ms).
 * - `b`: blasts that landed this tick — pairs [idΔ, t], the same way.
 *   Clients draw a fireball from these, never from a prediction.
 * - `u`: props that stand again (encodeChunkIds delta form).
 * - `a`: bridge-span repairs announced — pairs [idΔ, at]; the span comes
 *   back only with a later `u`.
 * - `c`: new street craters; `cu`: crater ids repaired (delta form).
 */
export interface PropsMsg {
  type: "props";
  d?: number[];
  b?: number[];
  u?: number[];
  a?: number[];
  c?: WireCrater[];
  cu?: number[];
}

export type ServerMsg =
  | WelcomeMsg
  | PropsMsg
  | CaveInMsg
  | QuakeMsg
  | FiresMsg
  | DirectorWarnMsg
  | RebuildMsg
  | BossMsg
  | BossHpMsg
  | FlakMsg
  | BossLaunchMsg
  | BossDownMsg
  | ChunksMsg
  | CollapseMsg
  | MissileMsg
  | CourseResultMsg
  | CourseBoardMsg
  | AwayStartedMsg
  | NewsHeliMsg
  | IntensityConfigMsg
  | WavesMsg
  | PlayerJoinedMsg
  | PlayerLeftMsg
  | WireSnapshotMsg
  | FiredMsg
  | DamageMsg
  | DeathMsg
  | RespawnMsg
  | ScoreMsg
  | CityEventMsg
  | AwardMsg;
