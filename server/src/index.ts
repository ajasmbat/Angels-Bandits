// The Angels & Bandits server: one Node process serving /healthz, the built
// client statics (production), and the ws presence rooms. HUMAN movement stays
// client-authoritative (PLAN.md authority split) — pose claims are clamped via
// validatePose and relayed in snapshots. The one flight sim this process DOES
// run is the carrier's enemy planes (W1, server/src/waves.ts): RoomBots
// advances them with the shared stepFlight inside the same TICK_DOWN_HZ
// snapshot tick.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AA_ID, aaNestsOf, encodeAaBurst } from "@angels-bandits/common/aa";
import { bombSurfaceY } from "@angels-bandits/common/bombs";
import {
  type Boost,
  boostLevel,
  boostSpeedCap,
  createBoost,
  startBoost,
  stopBoost,
} from "@angels-bandits/common/boost";
import {
  BOSS_ID,
  type BossDown,
  blankPose,
  bossCredit,
  bossPoseAt,
  bossSpawnClear,
  encodeFlak,
  encodeRaid,
} from "@angels-bandits/common/boss";
import { encodeQuake } from "@angels-bandits/common/chaos";
import {
  encodeChunkIds,
  generateCity,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  type CaveInSlot,
  emptyCaveInSlot,
  encodeCaveIn,
} from "@angels-bandits/common/city/caveins";
import {
  type MoverField,
  generateMovers,
  withNewsHeli,
} from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import {
  canRetarget,
  retargetNewsHeli,
  setNewsTarget,
} from "@angels-bandits/common/city/newsheli";
import { PROP_NEST } from "@angels-bandits/common/city/props";
import {
  type CityIndex,
  type NatureIndex,
  buildCityIndex,
  buildNatureIndex,
} from "@angels-bandits/common/collision";
import {
  AWAY_COMBAT_LOCK_MS,
  AWAY_MIN_MS,
  AWAY_SILENCE_MS,
  AWAY_TIMEOUT_MS,
  BOOST_VALIDATION_SLACK,
  BOOT_TIMEOUT_MS,
  CITY_SEED,
  COLLAPSE_CREDIT_SLACK,
  INTERP_DELAY_MAX_MS,
  JOIN_DEADLINE_MS,
  LAB_FULL_CODE,
  LIVENESS_TIMEOUT_MS,
  NAME_MAX_LENGTH,
  PLAYER_RADIUS,
  POSE_AGE_MAX_MS,
  RESPAWN_SPEED,
  RESUME_WINDOW_MS,
  SPAWN_PROTECTION_MS,
  TICK_DOWN_HZ,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  COURSES_MIN,
  type Course,
  generateCourses,
} from "@angels-bandits/common/courses";
import {
  type DirectorEvent,
  EVENT_GAS,
  encodeDirectorEvent,
  inDangerZone,
} from "@angels-bandits/common/director";
import { flakHazard, missileHazard } from "@angels-bandits/common/hazards";
import {
  MedalLedger,
  NEEDLE_WINDOW_MS,
  TRAIN_SURFER_RANGE,
  nearTrainCar,
} from "@angels-bandits/common/medals";
import {
  clampInterpDelay,
  encodeSnapshotEntry,
} from "@angels-bandits/common/net";
import type {
  Pose,
  ScoreEntry,
  ServerMsg,
  SpawnState,
  WireSnapshotMsg,
} from "@angels-bandits/common/protocol";
import {
  MISSILE_SHOOTER_ID,
  type MissileStrike,
  encodeMissile,
} from "@angels-bandits/common/strike";
import { encodeWaves } from "@angels-bandits/common/waves";
import {
  type Vec3,
  canonicalize,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import type { WreckParams, WreckWorld } from "@angels-bandits/common/wreck";
import { type WebSocket, WebSocketServer } from "ws";
import { type AaEnemy, RoomAa, STRAFE_DAMAGE } from "./aa";
import {
  BombDirector,
  type BombHuman,
  type BombWorld,
  applyLoadBlast,
} from "./bombs";
import {
  BossDirector,
  type BossPlane,
  type BossWorld,
  applyBossImpact,
  claimBossHit,
} from "./boss";
import {
  type BombReleaseCue,
  RoomBots,
  applyBotFire,
  landBotRound,
  poseVelocity,
} from "./bots";
import { CAVEIN_FAST, CAVEIN_TUNING, CaveInDirector } from "./caveins";
import {
  ChaosDirector,
  type ChaosPlane,
  applyGoneHold,
  chaosTunings,
} from "./chaos";
import { CityEventLog, nearBuildingProbe } from "./cityevents";
import { Combat, type Death, type HitResult, type SpeedCapFn } from "./combat";
import {
  CourseBook,
  CourseTracker,
  type FinishedRun,
  type SweepWorld,
} from "./courses";
import { DangerBudget } from "./danger";
import {
  type RoomCity,
  applyDeathBlast,
  applyShotDamage,
  collapseCulprit,
  createRoomCity,
  propCulprit,
  propsMessage,
  propsWireState,
  resetRoomCity,
  tickDestruction,
  noseOf as wireNose,
} from "./destruction";
import {
  DestructionDirector,
  type DestructionPlane,
  type FiredEvent,
  gasVictims,
} from "./director";
import {
  type ClientEnvelope,
  isClientMsg,
  isPose,
  isResumeToken,
  isVec3,
} from "./guards";
import { type RespawnEnemy, pickRespawn, respawnIfUnsafe } from "./respawn";
import { type Room, RoomManager } from "./room";
import { createStaticHandler } from "./statics";
import { StormCeiling } from "./storm";
import {
  type DirectorPlane,
  MissileDirector,
  applyMissileImpact,
} from "./strikes";
import { createGuard } from "./tick-guard";
import { TickProfiler } from "./tickstats";
import { poseFromSpawn, roomPoseCap, validatePose } from "./validate";
import { RoomWaves, type WaveHuman, humanContacts } from "./waves";
import { RoomWrecks, applyWreckImpact, impactPos } from "./wrecks";

const PORT = Number(process.env.PORT ?? 8080);

/** How long a socket may stay open without sending `join` (S1). The env
 * override exists for tests; production always uses the shared constant. */
const JOIN_DEADLINE = Number(process.env.JOIN_DEADLINE_MS) || JOIN_DEADLINE_MS;
/** How long a joined player may stay pending (no pose yet) — W1. Same env
 * override pattern, for the same reason. */
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT_MS) || BOOT_TIMEOUT_MS;
/** W2 windows, same env override pattern (tests shorten them). */
const RESUME_WINDOW = Number(process.env.RESUME_WINDOW_MS) || RESUME_WINDOW_MS;
const AWAY_TIMEOUT = Number(process.env.AWAY_TIMEOUT_MS) || AWAY_TIMEOUT_MS;
const AWAY_SILENCE = Number(process.env.AWAY_SILENCE_MS) || AWAY_SILENCE_MS;
/** D6: the liveness bound, same pattern — the perf harness raises it, since
 * a software-rendered page can go seconds between frames and a dropped,
 * resumed session respawns mid-measurement. */
const LIVENESS = Number(process.env.LIVENESS_TIMEOUT_MS) || LIVENESS_TIMEOUT_MS;

/** Every chaos tuning, from the environment (server/src/chaos.ts
 * chaosTunings): C2's constant chaos by default; `AB_CHAOS=0` restores the
 * pre-C2 schedules and switches the C2 layers off (production rollback);
 * AB_DIRECTOR_FAST / AB_MISSILE_FAST / AB_BOSS_FAST / AB_CHAOS_FAST=1 (tests
 * and QA only) make each layer come quickly. */
const TUNINGS = chaosTunings(process.env);
const DIRECTOR_TUNING = TUNINGS.director;
const MISSILE_TUNING = TUNINGS.missile;
const BOSS_RAID_TUNING = TUNINGS.boss;

/** Test-only introspection of the per-room maps (`GET /debug/rooms`). */
const DEBUG_ROOMS = process.env.AB_DEBUG_ROOMS === "1";
/** A1: the tick's per-phase cost (`GET /debug/tick`; tools/perf/server-tick.mjs). */
const tickStats = new TickProfiler(process.env.AB_TICK_STATS === "1");

/** A2: `process.memoryUsage()` after a full GC when node exposes one. */
const memoryAfterGc = (): NodeJS.MemoryUsage => {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage();
};

/**
 * D6: AB_QUIET_CITY=1 (the perf harness only — tools/perf/run.mjs): no room's
 * city ever breaks (`breakable` is null: no bullet, blast, wreck, missile,
 * director, chain or rebuild damage) and no boss raid starts. All of that is
 * timed on the wall clock, which the harness cannot pin, so the destruction a
 * measured window shows is only what the harness stages on the client — the
 * same reasoning as its empty sky (no carrier, so no enemy waves). Never in
 * production.
 */
const QUIET_CITY = process.env.AB_QUIET_CITY === "1";
if (QUIET_CITY && process.env.NODE_ENV === "production") {
  console.error(
    "AB_QUIET_CITY=1 is a perf-harness switch: refusing to run in production",
  );
  process.exit(1);
}
if (QUIET_CITY) {
  console.warn(
    "!! AB_QUIET_CITY=1: destruction and boss raids are OFF in every room (perf harness only)",
  );
}

/** After this many consecutive snap-rejects, accept the claim as a re-sync —
 * a client-side respawn (crash death) legitimately teleports across the map. */
const RESYNC_AFTER_REJECTS = 10;

interface Client {
  id: string;
  name: string;
  ws: WebSocket;
  room: Room;
  /** W4: flying in Easy mode (the join's flag, then setEasy). */
  easy?: boolean;
  /** Last accepted pose — what snapshots broadcast. */
  pose: Pose;
  /** When `pose` was taken, server clock ms (O2): the client's own stamp,
   * clamped by poseTimeOf. Snapshots forward it as the entry's age. */
  poseTime: number;
  lastMsgAt: number;
  lastPoseAt: number;
  /** W1: joined but still booting — no pose sent yet. A pending player is in
   * the roster but not in the air: absent from snapshots, never a target,
   * can't fire, and its spawn protection hasn't started. Ends on the first
   * shape-valid pose, accepted or not. */
  pending: boolean;
  joinedAt: number;
  rejectStreak: number;
  /** Mirror of the client's boost energy (F2), stepped from its edges with
   * BOOST_VALIDATION_SLACK — the only thing that makes boost speed legal. */
  boost: Boost;
  /** W2: this session's secret for resuming after a drop (in its welcome). */
  resumeToken: string;
  /** W2: the token this session was resumed WITH. Still honoured until the
   * session's first frame, so a resume whose welcome was lost in flight can
   * simply be retried; dropped after that (tokens are single use). */
  prevToken: string | null;
  /** W2: the tab asked to be away. `away` is whether it has taken effect
   * (settleAway: not while the plane is still taking damage), since `awayAt`.
   * An away player keeps its seat but is absent from snapshots and
   * targeting, and its own pose/fire/hit/crash/boost frames are ignored. */
  wantsAway: boolean;
  away: boolean;
  awayAt: number;
  /** S3: this pilot's official course timing, fed from accepted poses. */
  course: CourseTracker;
}

/** W2: what a dropped session leaves behind for RESUME_WINDOW: enough to
 * come back as the same player with the same score. Never holds a seat. */
interface ResumeRecord {
  name: string;
  kills: number;
  deaths: number;
  /** S7: a drop is not a death — the streak survives the resume. */
  streak: number;
  best: number;
  roomId: string;
  expiresAt: number;
}

const rooms = new RoomManager();
const clients = new Map<string, Client>();
/** W2: resume token → player id. Covers live sessions (a resume can take one
 * over) and dropped ones (→ resumeRecords). Swept with the records. */
const resumeIds = new Map<string, string>();
/** W2: player id → its dropped session, until it expires or is resumed. */
const resumeRecords = new Map<string, ResumeRecord>();
/** Server-authoritative combat state (HP/kills/respawns). Keyed by the same
 * globally-unique player ids as `clients`; hit claims are gated to one room.
 * Bots are registered here too — identical rules, no special cases. */
const combat = new Combat();
/** The hidden death ceiling (ST1): continuous-time-above-600 m bookkeeping.
 * Nothing about it is ever sent to clients — only the resulting death. */
const storm = new StormCeiling();
/** S7 kill streaks and medals (common/src/medals.ts): the server's credit,
 * keyed by the same globally-unique ids as `combat`. Every credited death
 * goes through it in sendDeath. */
const medals = new MedalLedger();

/** A pilot's scoreboard row: Combat's tally plus the S7 streak (omitted
 * while 0). Every score that leaves the server is built here. */
function scoreEntryOf(id: string): ScoreEntry {
  const streak = medals.streakOf(id);
  return { ...combat.scoreOf(id), ...(streak > 0 && { streak }) };
}

/** The seeded city, generated once — bot collision probes fly against the
 * exact Building[] every client renders and collides with. */
const city = generateCity(CITY_SEED);

/**
 * The seeded moving obstacles (L2), memoised by the room's CITY seed.
 *
 * Keyed by `room.seed` rather than built once beside `city`, because Room
 * already carries a seed field that is only "shared by all rooms for now" —
 * the day rooms get distinct cities, their cranes follow instead of silently
 * desyncing from the buildings they were fitted to. `welcome.seed` is that
 * same value, which is what makes the client compute an identical field.
 */
const moversBySeed = new Map<number, MoverField>();
const moversFor = (seed: number): MoverField => {
  let field = moversBySeed.get(seed);
  if (!field) {
    field = generateMovers(
      seed,
      seed === CITY_SEED ? city : generateCity(seed),
    );
    moversBySeed.set(seed, field);
  }
  return field;
};

/**
 * The solid N1 trees, memoised per city seed exactly like `moversFor` — and
 * fitted to generateCity(seed), never to another seed's buildings, since a
 * tree is rejected wherever that city has a footprint.
 */
const natureBySeed = new Map<number, NatureIndex>();
const natureIndexFor = (seed: number): NatureIndex => {
  let index = natureBySeed.get(seed);
  if (!index) {
    index = buildNatureIndex(
      natureFor(seed, seed === CITY_SEED ? city : generateCity(seed)),
    );
    natureBySeed.set(seed, index);
  }
  return index;
};

/**
 * Each room's OWN mover field (L10): the seed's shared cranes and aircraft
 * plus that room's news heli, whose route follows that room's kills. The bots
 * fly against this field, so they see the heli exactly where clients draw it.
 * D3: and that room's collapses — the room city's own field (reset in place,
 * so this reference stays good for the room's life).
 * Created lazily, dropped with the room's bots.
 */
const roomMoversById = new Map<string, MoverField>();
const roomMovers = (room: Room): MoverField => {
  let field = roomMoversById.get(room.id);
  if (!field) {
    field = {
      ...withNewsHeli(moversFor(room.seed), room.seed),
      collapses: roomCity(room).collapses,
      // S4: and its sky boss — the director's own slot, mutated in place.
      boss: roomBoss(room).slot,
      // U6: and its cave-ins — the cave-in director's slot, the same way.
      caveins: roomCaveIns(room),
      // D9: and its props — the felled tanks, jumbotrons and bridge spans
      // (solid for bots too) and the gaps the spans left.
      props: roomCity(room).props.slot,
    };
    roomMoversById.set(room.id, field);
  }
  return field;
};
/** The newest kill site per room that the news heli has not taken yet. */
const pendingKillByRoom = new Map<string, { x: number; z: number }>();

/**
 * Each room's OWN breakable city (D2): a clone of its seed's city and the
 * room's damage state. Bots fly it, bullets and deaths break it, and its
 * destroyed set is what every member's client subtracts. Created lazily,
 * dropped with the room. (The L1 city-event probe keeps reading the seed
 * city on purpose: "near a building" is about where the fight is.)
 */
const roomCityById = new Map<string, RoomCity>();
const roomCity = (room: Room): RoomCity => {
  let rc = roomCityById.get(room.id);
  if (!rc) {
    rc = createRoomCity(
      room.seed === CITY_SEED ? city : generateCity(room.seed),
      moversFor(room.seed).cranes,
      // D9: and its destructible props (they stay clear of the trains).
      room.seed,
      moversFor(room.seed).trains ?? [],
    );
    rc.damage.setCap(TUNINGS.destroyCap);
    // W3: the room's AA nests are on the pilots' side — only an enemy
    // plane's rounds (strafing, or stray fire) chew them; every blast still
    // reaches them.
    const layout = rc.props.layout;
    rc.props.immune = (id, by) =>
      layout.props[id]?.kind === PROP_NEST &&
      !(by !== null && room.members.get(by)?.isBot === true);
    roomCityById.set(room.id, rc);
  }
  return rc;
};

/**
 * Is the room's city quiet — no destruction, missiles, chaos, director or
 * boss raids? A quiet city (D6), a room with no human in it, and (FL1) a
 * Flight Lab room whose pilot has not turned chaos on.
 */
const quiet = (room: Room): boolean =>
  QUIET_CITY || room.humanCount === 0 || (room.lab && !room.labChaos);

/**
 * Destruction applies only while the room has a human member (pending and
 * away ones count): nobody would see it otherwise — so an empty room stays
 * whole, and handleLeave clears it when its last human goes. FL1: and never in a lab room with chaos off (quiet).
 */
const breakable = (room: Room): RoomCity | null =>
  quiet(room) ? null : roomCity(room);

/**
 * Each room's missile director (X1) and the probes it reads, built against
 * that room's own breakable buildings. Created lazily, dropped with the
 * room; the stream is seeded from the room's number like its bots.
 */
interface RoomMissiles {
  director: MissileDirector;
  near: (pos: Vec3) => boolean;
  index: CityIndex;
}
const missilesByRoom = new Map<string, RoomMissiles>();
const missilesFor = (room: Room): RoomMissiles => {
  let rm = missilesByRoom.get(room.id);
  if (!rm) {
    const n = Number(room.id.split("-")[1] ?? 0);
    const rc = roomCity(room);
    rm = {
      director: new MissileDirector(
        mulberry32((CITY_SEED ^ Math.imul(n + 1, 0x51ed27)) >>> 0),
        MISSILE_TUNING,
      ),
      near: nearBuildingProbe(rc.buildings),
      index: rc.index,
    };
    missilesByRoom.set(room.id, rm);
  }
  return rm;
};

/**
 * Each room's sky boss (S4): its schedule, HP, turrets and break-up. Created
 * lazily, dropped with the room; seeded from the room's number like its
 * bots. Its slot rides the room's mover field (bots, crash checks, wrecks).
 */
const bossByRoom = new Map<string, BossDirector>();
const roomBoss = (room: Room): BossDirector => {
  let boss = bossByRoom.get(room.id);
  if (!boss) {
    const n = Number(room.id.split("-")[1] ?? 0);
    boss = new BossDirector(
      mulberry32((CITY_SEED ^ Math.imul(n + 1, 0x2b05d1)) >>> 0),
      BOSS_RAID_TUNING,
    );
    bossByRoom.set(room.id, boss);
  }
  return boss;
};

/** What the boss sweeps its break-up against and its turrets look past:
 * the room's city as it stands. */
const bossWorld = (room: Room): BossWorld => {
  const rc = roomCity(room);
  return { buildings: rc.buildings, index: rc.index };
};

/** S4: a human (re)spawn must never be pointed into the zeppelin's path. */
const spawnClearOfBoss =
  (room: Room, now: number) =>
  (pos: Vec3, yaw: number | null): boolean =>
    bossSpawnClear(roomBoss(room).slot, pos, yaw, RESPAWN_SPEED, now);

/**
 * Each room's destruction director (D5): timed events near the fight and
 * the rebuild cycle, against that room's own breakable city. Created
 * lazily, reset with the room's city, dropped with the room; seeded from
 * the room's number so rooms don't stage their events in the same tick.
 */
const directorsByRoom = new Map<string, DestructionDirector>();
const directorFor = (room: Room): DestructionDirector => {
  let d = directorsByRoom.get(room.id);
  if (!d) {
    const n = Number(room.id.split("-")[1] ?? 0);
    const seed = (room.seed ^ Math.imul(n + 1, 0x2545f491)) >>> 0;
    d = new DestructionDirector(
      seed,
      mulberry32((seed ^ 0xd5d5) >>> 0),
      DIRECTOR_TUNING,
    );
    directorsByRoom.set(room.id, d);
  }
  return d;
};

/**
 * C2: each room's danger budget (server/src/danger.ts) — the per-player cap
 * on lethal events the missile, chaos and destruction directors share.
 * Null under AB_CHAOS=0. Created lazily, dropped with the room.
 */
const budgetsByRoom = new Map<string, DangerBudget>();
const budgetFor = (room: Room): DangerBudget | undefined => {
  if (!TUNINGS.danger) return undefined;
  let b = budgetsByRoom.get(room.id);
  if (!b) {
    b = new DangerBudget(TUNINGS.danger);
    budgetsByRoom.set(room.id, b);
  }
  return b;
};

/**
 * C2: each room's chaos director (server/src/chaos.ts) — meteors, quakes,
 * spreading fire. Seeded from the room's number like the other directors;
 * null under AB_CHAOS=0. Created lazily, reset with the room's city, dropped
 * with it.
 */
const chaosByRoom = new Map<string, ChaosDirector>();
const chaosFor = (room: Room): ChaosDirector | null => {
  if (!TUNINGS.chaos) return null;
  let c = chaosByRoom.get(room.id);
  if (!c) {
    const n = Number(room.id.split("-")[1] ?? 0);
    c = new ChaosDirector(
      (room.seed ^ Math.imul(n + 1, 0x7c2ac0d5)) >>> 0,
      TUNINGS.chaos,
    );
    chaosByRoom.set(room.id, c);
  }
  return c;
};

/**
 * U6: each room's cave-in director (server/src/caveins.ts) — the ceiling of
 * a deep bore coming down ahead of the planes in it. Seeded from the room's
 * number like the other directors; null under AB_CHAOS=0 (its slot then
 * stays empty forever). Created lazily, reset with the room's city, dropped
 * with it.
 */
const caveInsByRoom = new Map<string, CaveInDirector>();
const caveInsFor = (room: Room): CaveInDirector | null => {
  if (!TUNINGS.chaos) return null;
  let c = caveInsByRoom.get(room.id);
  if (!c) {
    const n = Number(room.id.split("-")[1] ?? 0);
    c = new CaveInDirector(
      (room.seed ^ Math.imul(n + 1, 0x3ca7e1d5)) >>> 0,
      process.env.AB_CHAOS_FAST === "1" ? CAVEIN_FAST : CAVEIN_TUNING,
    );
    caveInsByRoom.set(room.id, c);
  }
  return c;
};
/** The room's cave-in slot (an empty one forever with chaos off). */
const noCaveIns: CaveInSlot = emptyCaveInSlot();
const roomCaveIns = (room: Room): CaveInSlot =>
  caveInsFor(room)?.slot ?? noCaveIns;

/** A plane (re)spawned or came back at `pos`: the missile and destruction
 * directors (and S4's turrets, and C2's budget) keep their quiet rules
 * around it. */
function noteSpawn(room: Room, id: string, pos: Vec3, now: number): void {
  missilesFor(room).director.noteSpawn(id, pos, now);
  directorFor(room).noteSpawn(id, now);
  roomBoss(room).noteSpawn(id, now); // S4: no flak at it for a beat
  budgetFor(room)?.noteSpawn(id, now); // C2: nothing lethal near it for 5 s
}

/** C2: a spawn stays this far from where a strike or meteor is about to
 * land, m (its blast radius and a margin). */
const SPAWN_STRIKE_CLEAR_M = 120;

/** D5: a spawn never lands inside a warned director event's danger zone —
 * C2: nor next to an incoming strike or meteor. */
const spawnAvoid =
  (room: Room) =>
  (pos: Vec3): boolean =>
    directorFor(room)
      .pending()
      .some((e) => inDangerZone(e, pos, 60)) ||
    missilesFor(room)
      .director.missiles()
      .some(
        (m) =>
          Math.hypot(
            wrapDeltaAxis(m.to.x, pos.x),
            wrapDeltaAxis(m.to.z, pos.z),
          ) < SPAWN_STRIKE_CLEAR_M,
      );

/** A plane died: blast the city at its last on-record position (alive or
 * dead — lastPosOf covers both). Call after the death is decided. A collapse
 * the blast sets off is credited to the death's killer (D3). */
function deathBlast(
  room: Room,
  victimId: string,
  killerId: string | null,
): void {
  const rc = breakable(room);
  const pos = rc && lastPosOf(room, victimId);
  if (rc && pos) applyDeathBlast(rc, pos, killerId);
}

/**
 * D3: the death of `id`, who crashed at `pos` at server time `at`. Falling
 * collapse debris there makes it a collapse kill — credited to whoever
 * brought the building down if they are still in the room — else it is a
 * plain crash.
 */
function crashDeath(
  room: Room,
  id: string,
  pos: Vec3 | null,
  at: number,
  now: number,
): Death | null {
  const rc = roomCityById.get(room.id);
  const culprit =
    rc && pos
      ? (collapseCulprit(rc, pos, PLAYER_RADIUS + COLLAPSE_CREDIT_SLACK, at) ??
        // D9: a falling tank, jumbotron or span — its feller's kill.
        propCulprit(rc, pos, PLAYER_RADIUS + COLLAPSE_CREDIT_SLACK, at))
      : null;
  if (!culprit) return combat.crash(id, now);
  const by =
    culprit.by !== null && room.members.has(culprit.by) ? culprit.by : null;
  return combat.collapseKill(id, by, now);
}

/**
 * Each room's falling wrecks (D4). They fall, kill and land whether or not
 * a human is there — only the city damage of a landing is gated by
 * breakable(). Created lazily, dropped with the room.
 */
const wrecksByRoom = new Map<string, RoomWrecks>();
const roomWrecks = (room: Room): RoomWrecks => {
  let wrecks = wrecksByRoom.get(room.id);
  if (!wrecks) {
    wrecks = new RoomWrecks();
    wrecksByRoom.set(room.id, wrecks);
  }
  return wrecks;
};

/** What a room's wreck sweeps against: its own breakable city as it stands,
 * the trees, and the seed's movers — WITHOUT the room's news heli, whose
 * future route depends on kills that have not happened yet. */
const wreckWorld = (room: Room): WreckWorld => {
  const rc = roomCity(room);
  return {
    buildings: rc.buildings,
    index: rc.index,
    nature: natureIndexFor(room.seed),
    // S4: plus the sky boss's hull — its path is pure, so a wreck falling
    // into it hits it (a later break-up is not foreseen; it hits the air).
    // D9: plus the room's props — a fallen span's gap is open air.
    movers: {
      ...moversFor(room.seed),
      boss: roomBoss(room).slot,
      props: rc.props.slot,
    },
  };
};

/**
 * A plane was shot down: it falls as a wreck from its on-record pose (a
 * human's validated claim at the time it was taken; a bot's sim state, read
 * BEFORE bots.setDead). Over WRECKS_MAX — or with no pose on record — it
 * explodes in place as before D4. Call after the death is decided.
 */
function shotDown(
  room: Room,
  victimId: string,
  killerId: string | null,
  now: number,
): WreckParams | null {
  let start: { pos: Vec3; vel: Vec3; t: number } | null = null;
  if (room.members.get(victimId)?.isBot) {
    const c = botsFor(room).contactOf(victimId);
    if (c) start = { pos: c.pos, vel: c.vel, t: now };
  } else {
    const client = clients.get(victimId);
    if (client) {
      start = {
        pos: client.pose.pos,
        vel: poseVelocity(client.pose),
        t: client.poseTime,
      };
    }
  }
  const wreck =
    start &&
    roomWrecks(room).spawn(
      victimId,
      killerId,
      start.pos,
      start.vel,
      start.t,
      wreckWorld(room),
    );
  if (!wreck) deathBlast(room, victimId, killerId);
  return wreck ?? null;
}

/**
 * Wrecks that hit by `now`: each lands exactly once — the D2 blast through
 * the room's city (when breakable) and the city's `death` event at the
 * impact point (D1 facade blast and burn, L1 reactions, welcome replay).
 * Call before the tick's chunk batch so the impact's chunks go out with it.
 */
function landWrecks(room: Room, now: number): void {
  const wrecks = wrecksByRoom.get(room.id);
  if (!wrecks) return;
  for (const { params, shooterId } of wrecks.settle(now)) {
    const pos = impactPos(params);
    const rc = breakable(room);
    // D3: a collapse the impact sets off is the shooter's.
    if (rc) applyWreckImpact(rc, pos, shooterId);
    const event = cityEvents.offer(
      room.id,
      "death",
      pos,
      params.t + params.end,
    );
    if (event) sendToRoom(room, { type: "cityEvent", event });
  }
}

/**
 * S3 stunt courses per city seed, memoised like `moversFor`: the courses
 * (generated from exactly the city, trees and static movers every client
 * generates them from), the process-wide boards, and what the solid sweep
 * tests. Boards live in this process's memory only.
 */
interface CourseSet {
  courses: Course[];
  book: CourseBook;
  world: SweepWorld;
}
const courseSetsBySeed = new Map<number, CourseSet>();
const courseSetFor = (seed: number): CourseSet => {
  let set = courseSetsBySeed.get(seed);
  if (!set) {
    const buildings = seed === CITY_SEED ? city : generateCity(seed);
    const index = buildCityIndex(buildings);
    const courses = generateCourses(seed, {
      buildings,
      index,
      nature: natureIndexFor(seed),
      movers: moversFor(seed),
    });
    const names = courses.map((c) => c.name).join(", ");
    const log = courses.length < COURSES_MIN ? console.warn : console.log;
    log(`stunt courses for seed ${seed}: ${courses.length} (${names})`);
    set = {
      courses,
      book: new CourseBook(courses),
      world: { buildings, index },
    };
    courseSetsBySeed.set(seed, set);
  }
  return set;
};

/** Per-room enemy pilots (W1: the carrier's planes). Created lazily; seeded
 * from the room's number so bot behavior is deterministic per room. */
const botsByRoom = new Map<string, RoomBots>();
const botsFor = (room: Room): RoomBots => {
  let bots = botsByRoom.get(room.id);
  if (!bots) {
    const n = Number(room.id.split("-")[1] ?? 0);
    bots = new RoomBots(
      room.id,
      CITY_SEED ^ (n * 0x9e3779b9),
      roomCity(room).buildings,
      roomMovers(room),
      true,
      natureIndexFor(room.seed),
    );
    botsByRoom.set(room.id, bots);
  }
  return bots;
};

/** On-record pose of any living room member — humans from their validated
 * claims, bots from the server-side sim. */
const memberPose = (room: Room, id: string): Pose | null => {
  const member = room.members.get(id);
  if (!member || !combat.isAlive(id)) return null;
  if (member.isBot) return botsFor(room).poseOf(id);
  // A pending human (W1) is still loading and an away one (W2) has its tab
  // hidden: neither is in the air for anyone.
  const client = clients.get(id);
  return client && !client.pending && !client.away ? client.pose : null;
};

/** How long before `time` a member's on-record pose was taken, ms (O2).
 * Bots are posed by the tick itself, so their age is always 0. */
const poseAgeOf = (id: string, time: number): number => {
  const client = clients.get(id);
  return client ? Math.max(0, time - client.poseTime) : 0;
};

// --- L1 reactive city: server-accepted events, broadcast + replayed ---
const cityEvents = new CityEventLog(nearBuildingProbe(city));

/** Where a member is on record, alive OR dead — memberPose() is null the
 * moment Combat marks a victim dead, which is exactly when a death's site is
 * needed. Humans: last validated pose. Bots: last sim position. */
const lastPosOf = (room: Room, id: string): Vec3 | null =>
  room.members.get(id)?.isBot
    ? botsFor(room).lastPosOf(id)
    : (clients.get(id)?.pose.pos ?? null);

/** Offer `id`'s position to the room's city-event log at server time `now`
 * and broadcast the event if the city reacts. Call it right after the
 * `death`/fire it belongs to, with the same `now`. */
function offerCityEvent(
  room: Room,
  kind: "gunfire" | "death",
  id: string,
  now: number,
): void {
  const pos = lastPosOf(room, id);
  if (!pos) return;
  const event = cityEvents.offer(room.id, kind, pos, now);
  if (event) sendToRoom(room, { type: "cityEvent", event });
}

/** Living roommates other than `exceptId` as the respawn picker sees them:
 * on-record position plus nose direction (U2: a spawn lands near the fight
 * but never in front of anyone's guns). */
const livingEnemies = (room: Room, exceptId: string): RespawnEnemy[] => {
  const enemies: RespawnEnemy[] = [];
  for (const { id } of room.members.values()) {
    if (id === exceptId) continue;
    const pose = memberPose(room, id);
    if (pose) enemies.push({ pos: pose.pos, fwd: noseOf(pose) });
  }
  return enemies;
};

/** Unit nose vector of a wire pose; null for a degenerate quaternion. */
const noseOf = (pose: Pose): Vec3 | null => {
  const v = poseVelocity({ ...pose, speed: 1 });
  const len = Math.hypot(v.x, v.y, v.z);
  return len > 1e-6 ? { x: v.x / len, y: v.y / len, z: v.z / len } : null;
};

/**
 * W1: each room's carrier war (server/src/waves.ts) — its waves, its enemy
 * planes and their lives, on the room's own carrier, pilots and Combat.
 * Seeded from the room's number like its bots; created lazily, dropped with
 * the room.
 */
const wavesByRoom = new Map<string, RoomWaves>();
const wavesFor = (room: Room): RoomWaves => {
  let w = wavesByRoom.get(room.id);
  if (!w) {
    const n = Number(room.id.split("-")[1] ?? 0);
    w = new RoomWaves(
      (CITY_SEED ^ Math.imul(n + 1, 0x3c6ef372)) >>> 0,
      botsFor(room),
      roomBoss(room),
      combat,
      {
        addEnemy: (entry) => {
          rooms.addBot(room, entry.id, entry.name);
          sendToRoom(room, { type: "playerJoined", player: entry });
        },
        removeEnemy: (id) => removeEnemy(room, id),
        send: (msg) => sendToRoom(room, msg),
        death: (death, now) => sendDeath(room, death, now),
      },
    );
    w.intensity = room.intensity;
    wavesByRoom.set(room.id, w);
  }
  return w;
};

/**
 * W2: each room's bomb runs (server/src/bombs.ts) — which enemy plane bombs
 * what, and which of its bombs fall. Seeded from the room's number like the
 * other directors; created lazily, dropped with the room.
 */
const bombsByRoom = new Map<string, BombDirector>();
const bombsFor = (room: Room): BombDirector => {
  let b = bombsByRoom.get(room.id);
  if (!b) {
    const n = Number(room.id.split("-")[1] ?? 0);
    b = new BombDirector(
      (room.seed ^ Math.imul(n + 1, 0x6b0b5e1d)) >>> 0,
      TUNINGS.bombs,
    );
    bombsByRoom.set(room.id, b);
  }
  return b;
};

/**
 * W3: each room's rooftop AA nests (server/src/aa.ts) over its own
 * breakable city's nest props. Seeded from the room's number like the
 * other directors; created lazily, reset with the room's city, dropped with
 * the room.
 */
const aaByRoom = new Map<string, RoomAa>();
const roomAa = (room: Room): RoomAa => {
  let aa = aaByRoom.get(room.id);
  if (!aa) {
    const n = Number(room.id.split("-")[1] ?? 0);
    aa = new RoomAa(
      (CITY_SEED ^ Math.imul(n + 1, 0x6a09e667)) >>> 0,
      aaNestsOf(roomCity(room).props.layout),
    );
    aaByRoom.set(room.id, aa);
  }
  return aa;
};

/**
 * W3: the AA nests for one room tick — only while the carrier war is on
 * (the enemies are their only targets). Bursts go out as one `aa`; each hit
 * goes through Combat.aaDamage (enemies only, never a human) — a kill falls
 * as a D4 wreck like any shot-down plane and counts for the wave; enemy
 * rounds at nests go out as `fired` and (in a breakable city) chew the
 * nest's prop. Provoked enemies' detours go to their pilots.
 */
function tickAa(room: Room, now: number): void {
  if (!wavesOn(room)) {
    aaByRoom.get(room.id)?.reset();
    botsByRoom.get(room.id)?.setDetours(new Map());
    return;
  }
  const waves = wavesFor(room);
  const bots = botsFor(room);
  const enemies: AaEnemy[] = [];
  for (const e of waves.enemies()) {
    if (e.down || !combat.isAlive(e.id)) continue;
    const c = bots.contactOf(e.id);
    if (!c) continue;
    enemies.push({
      id: e.id,
      pos: c.pos,
      vel: c.vel,
      prot: combat.isProtected(e.id, now),
    });
  }
  const aa = roomAa(room);
  const rc = roomCity(room);
  const state = rc.props.slot.state;
  const out = aa.tick(now, enemies, room.intensity, {
    buildings: rc.buildings,
    props: state,
    gaps: state.gapMask,
  });
  if (out.bursts.length > 0) {
    sendToRoom(room, { type: "aa", b: out.bursts.map(encodeAaBurst) });
  }
  for (const h of out.hits) {
    const hit = combat.aaDamage(h.target, h.damage, now, AA_ID);
    if (!hit) continue;
    sendToRoom(room, {
      type: "damage",
      targetId: h.target,
      shooterId: AA_ID,
      hp: hit.hp,
      from: h.from,
    });
    aa.noteHit(h.target, h.nest, room.intensity, now);
    if (!hit.death) {
      bots.onDamaged(h.target, now);
      continue;
    }
    aa.stats.downs++;
    // Shot down: it falls as a wreck (its impact breaks the city, D2/D3).
    const wreck = shotDown(room, h.target, AA_ID, now);
    bots.setDead(h.target);
    sendDeath(room, hit.death, now, wreck);
  }
  const breaks = breakable(room);
  for (const s of out.strafes) {
    sendToRoom(room, { type: "fired", id: s.enemy });
    if (s.hit && breaks) state.damage(s.nest, STRAFE_DAMAGE, 0, s.enemy);
  }
  bots.setDetours(aa.detours(now));
}

/** W1: an enemy plane leaves `room` for good (RoomWaves already dropped it
 * from its pilots, Combat and the carrier): every other per-plane record
 * forgotten, the roster left, `playerLeft` sent — and a room that held only
 * it is gone. */
function removeEnemy(room: Room, id: string): void {
  medals.forget(id);
  storm.forget(id);
  bombsByRoom.get(room.id)?.forget(id);
  directorsByRoom.get(room.id)?.forget(id);
  budgetsByRoom.get(room.id)?.forget(id);
  caveInsByRoom.get(room.id)?.forget(id);
  rooms.leave(id);
  sendToRoom(room, { type: "playerLeft", id });
  disposeRoom(room);
}

/** W1: is the carrier war on in `room` — the carrier flying and launching?
 * Off server-wide under AB_WAVES=0 or a quiet city; in a Flight Lab only
 * when its pilot turned it on. */
const wavesOn = (room: Room): boolean =>
  TUNINGS.waves && !QUIET_CITY && (!room.lab || room.labWaves);

/** W1: does the carrier fly in `room`? With its waves — or, in a lab, as
 * part of the chaos the pilot turned on (it launches nothing then). */
const carrierOn = (room: Room): boolean =>
  wavesOn(room) || (TUNINGS.waves && room.lab && room.labChaos && !QUIET_CITY);

/** W1: the humans in `room` who have started flying — past W1 loading and
 * not away. Dead in a kill-cam still counts: a death must not restart the
 * carrier's clock. */
const flyingHumanIn = (room: Room): boolean => {
  for (const m of room.members.values()) {
    if (m.isBot) continue;
    const c = clients.get(m.id);
    if (c && !c.pending && !c.away) return true;
  }
  return false;
};

/** W1: the humans in the air right now as the war sees them — on-record
 * pose, extrapolated to `now` unless `extrapolate` is false (the bots'
 * contacts read the pose as recorded, as they always have). */
function waveHumans(room: Room, now: number, extrapolate = true): WaveHuman[] {
  const out: WaveHuman[] = [];
  for (const member of room.members.values()) {
    if (member.isBot) continue;
    const pose = memberPose(room, member.id);
    if (!pose) continue;
    const age = extrapolate ? poseAgeOf(member.id, now) / 1000 : 0;
    const v = poseVelocity(pose);
    out.push({
      id: member.id,
      pos: canonicalize({
        x: pose.pos.x + v.x * age,
        y: pose.pos.y + v.y * age,
        z: pose.pos.z + v.z * age,
      }),
      vel: v,
      prot: combat.isProtected(member.id, now),
      hp: combat.hpOf(member.id),
    });
  }
  return out;
}

/**
 * Free everything kept per room id once `room` is gone from the manager.
 * Liveness is the only test: a room still listed keeps its
 * state, and a dead id is never reused (room ids only count up), so the lazy
 * getters can't resurrect it either — only listed rooms are ever ticked.
 */
function disposeRoom(room: Room): void {
  if (rooms.rooms.includes(room)) return;
  botsByRoom.delete(room.id);
  wavesByRoom.delete(room.id);
  bombsByRoom.delete(room.id);
  aaByRoom.delete(room.id);
  cityEvents.forget(room.id);
  roomMoversById.delete(room.id);
  pendingKillByRoom.delete(room.id);
  roomCityById.delete(room.id);
  missilesByRoom.delete(room.id);
  bossByRoom.delete(room.id);
  wrecksByRoom.delete(room.id);
  directorsByRoom.delete(room.id);
  chaosByRoom.delete(room.id);
  budgetsByRoom.delete(room.id);
  caveInsByRoom.delete(room.id);
}

const sanitizeName = (raw: unknown): string => {
  if (typeof raw !== "string") return "Pilot";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const name = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (name || "Pilot").slice(0, NAME_MAX_LENGTH);
};

function sendToRoom(room: Room, msg: ServerMsg, exceptId?: string): void {
  // A1: UTF-8 encoded once, not once per socket (ws re-encodes a string on
  // every send); still a text frame, exactly what a string send was.
  const data = Buffer.from(JSON.stringify(msg));
  for (const { id } of room.members.values()) {
    if (id === exceptId) continue;
    const member = clients.get(id);
    if (member && member.ws.readyState === member.ws.OPEN) {
      member.ws.send(data, { binary: false });
    }
  }
}

/**
 * A1: a player id — 72 random bits, base64url (12 chars). It rides in every
 * snapshot entry to every client, so the 36-char UUID it replaced was half
 * a human's entry. Never `bot:…` or `@…` (no ':' or '@' in base64url), so it
 * cannot name a bot or a MISSILE/BOSS shooter id.
 */
const mintPlayerId = (): string => randomBytes(9).toString("base64url");

/** 128 random bits, base64url (22 chars) — unguessable, and never logged. */
const mintResumeToken = (): string => randomBytes(16).toString("base64url");

/**
 * W2: the session a `join`'s resume token restores, or null for an ordinary
 * fresh join (no, malformed, unknown, spent or expired token — never an
 * error). A token whose session is still OPEN means the client noticed the
 * drop before this server did: that stale socket is terminated and left
 * first, which writes the record this resume then takes.
 */
function takeResume(
  token: unknown,
): { id: string; record: ResumeRecord } | null {
  if (!isResumeToken(token)) return null;
  const id = resumeIds.get(token);
  if (id === undefined) return null;
  const live = clients.get(id);
  if (live) {
    live.ws.terminate();
    handleLeave(id);
  }
  const record = resumeRecords.get(id);
  if (!record || record.expiresAt <= Date.now()) return null;
  resumeRecords.delete(id);
  return { id, record };
}

/** `id` is minted by the caller before any side effect, so a join that
 * throws half-way can still be undone by handleLeave(id). `resumed` (W2)
 * restores a dropped session: same id (the caller's), name and score, in
 * its old room when that still has a seat. */
function handleJoin(
  ws: WebSocket,
  rawName: unknown,
  id: string,
  resumed: { record: ResumeRecord; token: string } | null,
  lab = false,
): Client | null {
  const name = resumed ? resumed.record.name : sanitizeName(rawName);
  // FL1: a lab join gets a room of its own (never resumed — the caller
  // passes no record) or, over LAB_ROOM_CAP, nothing at all: refused before
  // any player state exists.
  const room = lab
    ? rooms.joinLab(id, name)
    : rooms.join(id, name, resumed?.record.roomId);
  if (!room) {
    ws.close(LAB_FULL_CODE, "Flight Lab is full");
    return null;
  }
  const now = Date.now();
  combat.addPlayer(id, now);
  // After addPlayer, which starts every tally at 0/0.
  if (resumed) {
    combat.restoreScore(id, resumed.record.kills, resumed.record.deaths);
    medals.restore(id, resumed.record.streak, resumed.record.best);
  }
  // Joiners get the same near-the-fight placement as respawns.
  const spawn = pickRespawn(
    livingEnemies(room, id),
    Math.random,
    spawnAvoid(room),
    spawnClearOfBoss(room, now),
  );
  const client: Client = {
    id,
    name,
    ws,
    room,
    pose: poseFromSpawn(spawn),
    poseTime: now,
    lastMsgAt: now,
    lastPoseAt: now,
    pending: true,
    joinedAt: now,
    rejectStreak: 0,
    boost: createBoost(now),
    resumeToken: mintResumeToken(),
    prevToken: resumed?.token ?? null,
    wantsAway: false,
    away: false,
    awayAt: 0,
    course: new CourseTracker(courseSetFor(room.seed).courses, {
      ...courseSetFor(room.seed).world,
      // D9: a dive through a fallen span is not "through the ground".
      gaps: () => roomCity(room).props.slot.state.gapMask,
    }),
  };
  clients.set(id, client);
  resumeIds.set(client.resumeToken, id);

  const welcome: ServerMsg = {
    type: "welcome",
    id,
    roomId: room.id,
    ...(room.lab && { lab: true as const }),
    seed: room.seed,
    spawn,
    roster: room.roster(),
    scores: room.roster().map(({ id: rid }) => scoreEntryOf(rid)),
    intensity: room.intensity,
    waves: encodeWaves(wavesFor(room).state()),
    cityEvents: cityEvents.recent(room.id, now),
    newsHeli: roomMovers(room).news,
    resumeToken: client.resumeToken,
    destroyed: encodeChunkIds(roomCity(room).damage.destroyedIds()),
    collapses: [...roomCity(room).collapses.records],
    courses: courseSetFor(room.seed).book.standings(),
    missiles: missilesFor(room).director.missiles().map(encodeMissile),
    racks: bombsByRoom.get(room.id)?.wire() ?? [],
    wrecks: wrecksByRoom.get(room.id)?.active() ?? [],
    director: directorFor(room).pending().map(encodeDirectorEvent),
    boss: roomBoss(room).state(now),
    ...(chaosFor(room) && { chaos: chaosFor(room)?.state(now) }),
    ...(caveInsFor(room) && { caveIns: caveInsFor(room)?.state(now) }),
    props: propsWireState(roomCity(room)),
  };
  ws.send(JSON.stringify(welcome));
  sendToRoom(room, { type: "playerJoined", player: { id, name } }, id);
  // Everyone else's board seeded this row at 0/0 from playerJoined.
  if (resumed) broadcastScores(room);
  return client;
}

/**
 * When a pose claim was taken, server clock ms (O2). The client's stamp is
 * trusted only inside [now − POSE_AGE_MAX_MS, now]: it can never claim the
 * future, and backdating itself buys at most the bound. An absent or
 * nonsense stamp reads as the arrival time — the pre-O2 behaviour.
 */
const poseTimeOf = (t: unknown, now: number): number =>
  typeof t === "number" && Number.isFinite(t)
    ? Math.min(now, Math.max(now - POSE_AGE_MAX_MS, t))
    : now;

function handlePose(client: Client, pose: Pose, t: unknown, now: number): void {
  // A dead plane has no pose: the client freezes for the kill-cam and the
  // respawn will reset the on-record pose server-side.
  if (!combat.isAlive(client.id)) return;
  // dt from wall time between claims, bounded: a hidden tab that resumes may
  // legally have moved far; a spammed socket must not shrink the bound to 0.
  const dt = Math.min(Math.max((now - client.lastPoseAt) / 1000, 0.02), 1);
  // Fastest the boost model allows since the last claim — levelled to now
  // first, so a burn whose stop edge never comes still runs dry on time.
  // FL1: a lab room judges by its own lab tuning's top speed instead.
  const cap = roomPoseCap(
    client.room,
    speedCapOf(client, now)(client.lastPoseAt),
  );
  client.lastPoseAt = now;
  const verdict = validatePose(client.pose, pose, dt, cap);
  if (verdict.ok) {
    const rejects = client.rejectStreak;
    client.pose = verdict.pose;
    client.poseTime = poseTimeOf(t, now);
    client.rejectStreak = 0;
    // S3: course timing reads accepted poses only, on the ARRIVAL clock.
    observeCourse(client, verdict.pose.pos, now, rejects);
    return;
  }
  client.rejectStreak++;
  // FL1: in a lab room a reject is a checkpoint teleport (the lab respawns
  // locally, never through the server): resync to it at once.
  if (client.room.lab || client.rejectStreak >= RESYNC_AFTER_REJECTS) {
    // Persistent disagreement = a real discontinuity (client respawn), not
    // jitter. Re-sync to the claim rather than freezing the plane forever.
    const resync = validatePose(pose, pose, dt, cap);
    if (resync.ok) {
      client.pose = resync.pose;
      client.poseTime = poseTimeOf(t, now);
      client.rejectStreak = 0;
      // A teleport is never part of a run: start the course stream over.
      client.course.reset();
      client.course.observe(resync.pose.pos, now);
    }
  }
}

/**
 * S3: one accepted pose into the pilot's course tracker. A finished run goes
 * on the board; the runner gets the official result, and everyone on the
 * same city seed gets the board when it changed — with the ghost when the
 * record fell.
 */
function observeCourse(
  client: Client,
  pos: Vec3,
  now: number,
  rejects: number,
): void {
  // FL1: lab tuning never times a run onto the shared course board.
  if (client.room.lab) return;
  const run = client.course.observe(pos, now, rejects);
  if (!run) return;
  const seed = client.room.seed;
  const outcome = courseSetFor(seed).book.submit(client.name, run);
  if (client.ws.readyState === client.ws.OPEN) {
    const result: ServerMsg = {
      type: "courseResult",
      course: run.course,
      timeMs: run.timeMs,
      missed: run.missed,
      medal: outcome.medal,
      rank: outcome.rank,
      record: outcome.record,
    };
    client.ws.send(JSON.stringify(result));
  }
  if (outcome.changed) {
    broadcastCourseBoard(seed, run, outcome.record ? client.name : null);
  }
}

/** S3: a course board changed — tell every client on that city seed. */
function broadcastCourseBoard(
  seed: number,
  run: FinishedRun,
  recordBy: string | null,
): void {
  const standing = courseSetFor(seed).book.standing(run.course);
  const msg: ServerMsg = {
    type: "courseBoard",
    course: run.course,
    board: standing.board,
    ...(recordBy !== null && standing.ghost
      ? {
          ghost: standing.ghost,
          record: { name: recordBy, timeMs: run.timeMs },
        }
      : {}),
  };
  const data = JSON.stringify(msg);
  for (const member of clients.values()) {
    if (member.room.seed !== seed) continue;
    if (member.ws.readyState === member.ws.OPEN) member.ws.send(data);
  }
}

/** The first pose (W1): the plane is in the air now, so it joins snapshots
 * and targeting, and its spawn protection starts from this moment rather
 * than from a join it spent loading. */
function goLive(client: Client, now: number): void {
  client.pending = false;
  // A2: the join spawn was checked at join; re-check it now the plane is
  // actually entering the world, and re-place it if danger moved onto it.
  const spawn = respawnIfUnsafe(
    client.pose,
    livingEnemies(client.room, client.id),
    Math.random,
    spawnAvoid(client.room),
    spawnClearOfBoss(client.room, now),
  );
  if (spawn) {
    resetOnRecord(client, spawn, now);
    sendToRoom(client.room, {
      type: "respawn",
      id: client.id,
      spawn,
      protectedUntil: now + SPAWN_PROTECTION_MS,
    });
  }
  combat.protectFrom(client.id, now);
  noteSpawn(client.room, client.id, client.pose.pos, now);
}

/** A human's boost window cap as of `now` (see SpeedCapFn); bots never
 * boost, so callers use the combat default for them. */
function speedCapOf(client: Client, now: number): SpeedCapFn {
  client.boost = boostLevel(client.boost, now, BOOST_VALIDATION_SLACK);
  const levelled = client.boost;
  return (since) => boostSpeedCap(levelled, since);
}

/** A boost edge (F2): step the mirror. A refused start simply leaves it
 * idle — the boosted poses that follow fail validation. */
function handleBoost(client: Client, on: unknown, now: number): void {
  if (typeof on !== "boolean" || !combat.isAlive(client.id)) return;
  client.boost = on
    ? startBoost(client.boost, now, BOOST_VALIDATION_SLACK)
    : stopBoost(client.boost, now, BOOST_VALIDATION_SLACK);
}

/** Idempotent: every step tolerates an id that never fully joined. */
function handleLeave(id: string): void {
  const client = clients.get(id);
  // FL1: a lab session leaves nothing to resume (lab joins never resume).
  if (client && !client.room.lab) {
    // W2: read the score BEFORE removePlayer (and medals.forget) forget it.
    const { kills, deaths } = combat.scoreOf(id);
    resumeRecords.set(id, {
      name: client.name,
      kills,
      deaths,
      streak: medals.streakOf(id),
      best: medals.bestOf(id),
      roomId: client.room.id,
      expiresAt: Date.now() + RESUME_WINDOW,
    });
  }
  clients.delete(id);
  combat.removePlayer(id);
  medals.forget(id);
  storm.forget(id);
  const room = rooms.leave(id);
  if (room) directorsByRoom.get(room.id)?.forget(id);
  if (room) {
    bossByRoom.get(room.id)?.forget(id);
    botsByRoom.get(room.id)?.forgetHuman(id);
    budgetsByRoom.get(room.id)?.forget(id);
    caveInsByRoom.get(room.id)?.forget(id); // U6
    sendToRoom(room, { type: "playerLeft", id });
    // D2: the last human out takes the damage with them (see breakable) —
    // D3: and the collapses, in the same reset.
    if (room.humanCount === 0) {
      const rc = roomCityById.get(room.id);
      if (rc) resetRoomCity(rc);
      // D5: and the director's warnings, cooldowns and rebuilds with it —
      // C2: and the chaos (runs, quakes, fires) and the budget.
      directorsByRoom.get(room.id)?.reset();
      chaosByRoom.get(room.id)?.reset();
      budgetsByRoom.get(room.id)?.reset();
      caveInsByRoom.get(room.id)?.reset(); // U6
      // W1: and the carrier war — every enemy plane despawned (the room
      // goes with the last of them), the next carrier tier 1 again.
      bossByRoom.get(room.id)?.resetSession();
      wavesByRoom.get(room.id)?.reset(Date.now());
      aaByRoom.get(room.id)?.reset(); // W3
    }
    // A room the last member just left is already gone — free its state.
    disposeRoom(room);
  }
}

/** Room-scoped scoreboard broadcast (after any death changes the tallies). */
function broadcastScores(room: Room): void {
  sendToRoom(room, {
    type: "score",
    scores: room.roster().map(({ id }) => scoreEntryOf(id)),
  });
}

function handleFire(client: Client, seq: unknown, now: number): void {
  if (typeof seq !== "number" || !Number.isFinite(seq)) return;
  // S4: the on-record nose rides with the bullet (a boss claim's line).
  const verdict = combat.fire(client.id, seq, now, wireNose(client.pose.quat));
  // Others render the muzzle flash/tracer; the shooter already did (favor
  // the shooter — a rejected shot just doesn't exist to anyone else).
  if (verdict.ok) {
    sendToRoom(client.room, { type: "fired", id: client.id }, client.id);
    offerCityEvent(client.room, "gunfire", client.id, now);
    // D2: the round flies from the shooter's on-record pose along its nose.
    const rc = breakable(client.room);
    if (rc) {
      applyShotDamage(
        rc,
        client.pose.pos,
        wireNose(client.pose.quat),
        client.id,
      );
    }
  }
}

function handleHitClaim(
  client: Client,
  msg: ClientEnvelope,
  now: number,
): void {
  const { targetId, bulletOrigin: origin, seq, delay } = msg;
  if (typeof targetId !== "string" || typeof seq !== "number") return;
  // You can't shoot yourself down: a self-claim would credit its own kill.
  if (targetId === client.id) return;
  if (!isVec3(origin)) return;
  // Bots are valid targets too: their on-record pose comes from the sim.
  const targetPose = memberPose(client.room, targetId);
  if (!targetPose) return;
  const targetClient = clients.get(targetId);

  const verdict = combat.hit(
    client.id,
    targetId,
    seq,
    origin,
    client.pose.pos,
    targetPose.pos,
    now,
    // The shooter's declared interpolation buffer sizes the range budget
    // (ANGE-4KO2W2). Clamped here: a nonsense claim reads as the tight floor.
    clampInterpDelay(delay),
    // Boost (F2) widens the origin and range windows only for a plane that
    // was actually burning. Bots never boost: their cap is the default.
    speedCapOf(client, now),
    targetClient ? speedCapOf(targetClient, now) : undefined,
  );
  if (!verdict.ok) return;

  sendToRoom(client.room, {
    type: "damage",
    targetId,
    shooterId: client.id,
    hp: verdict.hp,
  });
  if (client.room.members.get(targetId)?.isBot) {
    botsFor(client.room).onDamaged(targetId, now);
  }
  if (verdict.death) {
    // D4: it falls as a wreck (or, over the cap, explodes in place).
    const wreck = shotDown(client.room, targetId, client.id, now);
    if (client.room.members.get(targetId)?.isBot) {
      botsFor(client.room).setDead(targetId);
    }
    sendDeath(client.room, verdict.death, now, wreck);
  }
}

/**
 * S4: a shooter-side hit on the sky boss's weak point. The round's whole
 * line is re-judged against the zeppelin's own pose (server/src/boss.ts
 * claimBossHit); the HP change goes out with the tick's `bossHp`, a kill
 * at once.
 */
function handleBossHit(client: Client, msg: ClientEnvelope, now: number): void {
  const { wp, seq, bulletOrigin, dir, t } = msg;
  if (typeof wp !== "number" || typeof seq !== "number") return;
  if (typeof t !== "number" || !Number.isFinite(t)) return;
  if (!isVec3(bulletOrigin) || !isVec3(dir)) return;
  const boss = roomBoss(client.room);
  const hit = claimBossHit(
    combat,
    boss,
    client.id,
    { wp, seq, origin: bulletOrigin, dir, t },
    client.pose.pos,
    now,
    bossWorld(client.room),
    speedCapOf(client, now),
  );
  if (hit?.down) bossDowned(client.room, hit.down, now);
}

/**
 * S4: the sky boss is down. Credit by damage share (common/src/boss.ts
 * bossCredit, pilots still in the room): +1 kill for each dealer with
 * BOSS_CREDIT_MIN_SHARE, SKY-BOSS SLAYER for the top one (no streak, no
 * death — the boss is not a pilot), then the break-up, the award and the
 * new tallies. The news heli goes to cover the crash.
 */
function bossDowned(room: Room, down: BossDown, now: number): void {
  const ledger = new Map(
    [...roomBoss(room).damageLedger()].filter(([id]) => room.members.has(id)),
  );
  const credit = bossCredit(ledger);
  for (const id of credit.credited) combat.creditKill(id);
  sendToRoom(room, {
    type: "bossDown",
    d: down,
    dealers: credit.dealers.map((d) => [d.id, Math.round(d.share * 1000)]),
    top: credit.top,
  });
  if (credit.top !== null) {
    const award = medals.bossKill(credit.top);
    sendToRoom(room, {
      type: "award",
      id: credit.top,
      victimId: BOSS_ID,
      medals: award.medals,
    });
  }
  broadcastScores(room);
  const mid = down.pieces[1];
  if (mid) pendingKillByRoom.set(room.id, { x: mid.p.x, z: mid.p.z });
  // W1: its planes go down with it.
  const raid = roomBoss(room).slot.raid;
  if (raid && raid.id === down.id) {
    wavesFor(room).carrierDown(raid, now);
  }
}

/**
 * W1: a claim on the room's enemy intensity (ANGE-6STDNN's governance). The
 * Room seam owns it — clamp, whole-number check, per-player rate limit — so
 * a refusal is simply silence here: nothing is broadcast, and the
 * claimant's control snaps back to the last value the server confirmed.
 * The waves read it from their next wave on.
 */
/** W4: a pilot's Easy mode, kept on the client and handed to its room's
 * enemies (B3's skill scaler treats an Easy pilot as the most novice). */
function setEasy(client: Client, on: boolean): void {
  client.easy = on;
  botsFor(client.room).skill.setEasy(client.id, on);
}

function handleSetIntensity(client: Client, level: unknown, now: number): void {
  const accepted = client.room.setIntensity(client.id, level, now);
  if (accepted === null) return;
  wavesFor(client.room).intensity = accepted;
  sendToRoom(client.room, {
    type: "intensityConfig",
    level: accepted,
    byName: client.name,
  });
}

/**
 * A death happened: its position becomes the room's pending story for the
 * news heli (L10). Call BEFORE bots.setDead — a dead bot has no pose — though
 * lastPosOf also covers bots that crashed inside the sim tick.
 */
/**
 * Announce a server-declared death: the news heli's pending kill site, the
 * `death` itself carrying its canonical site (S1 jumbotron headlines) and,
 * for a plane shot down, its D4 `wreck`; the city event (a wreck's waits
 * for its landing) and the new tallies. Every death goes through here. Invariant
 * the clients rely on: the death is sent BEFORE its score broadcast, so the
 * tallies a client holds when a death lands are the pre-death ones (S1 seeds
 * each headline's verb from them, identically on every client).
 */
function sendDeath(
  room: Room,
  death: Death,
  now: number,
  wreck: WreckParams | null = null,
): void {
  const pos = lastPosOf(room, death.victimId);
  if (pos) pendingKillByRoom.set(room.id, { x: pos.x, z: pos.z });
  const site = pos ? canonicalize(pos) : null;
  // W2: an enemy shot down on a bomb run takes its load with it — a bigger
  // blast in the air where it was hit (its wreck, if any, still falls).
  const loadWent =
    bombsByRoom.get(room.id)?.downed(
      death.victimId,
      now,
      // A pilot's guns or (W3) an AA nest's: either may hit the load.
      death.cause === "shot" || death.cause === "aa",
    ) ?? false;
  const boom = loadWent && site ? site : null;
  if (boom) {
    const rc = breakable(room);
    if (rc) {
      const by =
        death.killerId !== null && room.members.has(death.killerId)
          ? death.killerId
          : null;
      chaosFor(room)?.ignite(applyLoadBlast(rc, boom, by), now, rc);
    }
  }
  sendToRoom(room, {
    type: "death",
    victimId: death.victimId,
    killerId: death.killerId,
    cause: death.cause,
    ...(site && {
      x: Math.round(site.x) % WORLD_SIZE,
      z: Math.round(site.z) % WORLD_SIZE,
    }),
    ...(wreck && { wreck }),
    ...(boom && {
      boom: [
        Math.round(boom.x) % WORLD_SIZE,
        Math.round(boom.y),
        Math.round(boom.z) % WORLD_SIZE,
      ] as [number, number, number],
    }),
    // W3: an AA kill of a plane a pilot had damaged — their assist.
    ...(death.assistId !== undefined && { assist: death.assistId }),
  });
  // D4: a wreck's city event comes when it lands, where it lands. X1: a
  // missile death's blast IS the missile's own event — never a second one
  // (D5: nor a gas main's).
  // W1: nor a plane going down with its carrier (its break-up is the event).
  if (
    !wreck &&
    death.cause !== "missile" &&
    death.cause !== "blast" &&
    death.cause !== "carrier"
  ) {
    offerCityEvent(room, "death", death.victimId, now);
  }
  creditMedals(room, death, now);
  // B3: human-vs-bot gun kills move the human's skill level.
  botsByRoom
    .get(room.id)
    ?.noteDeath(death.victimId, death.killerId, death.cause);
  // W1: an enemy plane down (the "enemy downed by X" hook fires here).
  wavesByRoom.get(room.id)?.downed(death, now);
  broadcastScores(room);
}

/**
 * S7: run one death through the medal ledger. A credited kill (by a pilot
 * still in the room) is announced to the whole room as an `award` — after
 * its `death`, before its `score`, so the streak the score carries already
 * counts it. The context is judged at the killer's on-record position on the
 * server clock: through a hole (the bots' transit tracking covers every
 * living member), beside a train car. A dead killer is threading nothing.
 */
function creditMedals(room: Room, death: Death, now: number): void {
  const { victimId, killerId } = death;
  if (
    killerId !== null &&
    killerId !== victimId &&
    room.members.has(killerId)
  ) {
    const pos = memberPose(room, killerId)?.pos ?? null;
    const trains = moversFor(room.seed).trains ?? [];
    const award = medals.kill({
      killerId,
      victimId,
      cause: death.cause,
      now,
      killerAlive: combat.isAlive(killerId),
      needle:
        pos !== null &&
        botsFor(room).threading(killerId, pos, now, NEEDLE_WINDOW_MS),
      train: pos !== null && nearTrainCar(trains, pos, TRAIN_SURFER_RANGE, now),
    });
    sendToRoom(room, {
      type: "award",
      id: killerId,
      victimId,
      medals: award.medals,
      ...(award.tier !== null && { tier: award.tier }),
      ...(award.chain >= 2 && { chain: award.chain }),
    });
  }
  medals.death(victimId, killerId);
}

/** Once the heli is free (arrived + dwelt), send it to the newest kill. */
function updateNewsHeli(room: Room, now: number): void {
  const site = pendingKillByRoom.get(room.id);
  const news = roomMovers(room).news;
  if (!site || !news || !canRetarget(news.target, now)) return;
  pendingKillByRoom.delete(room.id);
  const target = retargetNewsHeli(news.target, site, now);
  setNewsTarget(news, target);
  sendToRoom(room, { type: "newsHeli", target });
}

/** A crash report. `wreckId` (D4) names the falling wreck the client says
 * it flew into: credited to that wreck's shooter only if the server's own
 * geometry agrees. `t` (D3) is the server time the client's check ran at —
 * held to the window the on-record pose can be from, so a crash cannot be
 * backdated onto debris long gone — for telling a collapse kill from a
 * plain crash. */
function handleCrash(
  client: Client,
  t: unknown,
  wreckId: unknown,
  now: number,
): void {
  const credit = roomWrecks(client.room).creditFor(
    client.id,
    wreckId,
    client.pose.pos,
    now,
  );
  let death: Death | null;
  if (credit) {
    death = combat.wreckKill(client.id, credit.shooterId, now);
  } else {
    const earliest = now - POSE_AGE_MAX_MS - INTERP_DELAY_MAX_MS;
    const at =
      typeof t === "number" && Number.isFinite(t)
        ? Math.min(now, Math.max(earliest, t))
        : now;
    death = crashDeath(client.room, client.id, client.pose.pos, at, now);
  }
  if (!death) return;
  deathBlast(client.room, client.id, death.killerId);
  sendDeath(client.room, death, now);
}

/** Kill-cams that just ended: place each player near, not in front of,
 * living enemies, reset their on-record pose, and announce the respawn.
 * W1: an enemy plane's "respawn" is its release off the carrier's rig —
 * or, shot down or with its carrier gone, its exit from the room. */
function issueRespawns(due: string[], now: number): void {
  for (const id of due) {
    const room = rooms.roomOf(id);
    if (!room) continue;
    const enemies = livingEnemies(room, id);
    let spawn: SpawnState;
    if (room.members.get(id)?.isBot) {
      const released = wavesFor(room).release(id, now);
      // Still on the rig (at most a tick), or despawned: nothing to say.
      if (!released || released === "wait") continue;
      spawn = released;
    } else {
      spawn = pickRespawn(
        enemies,
        Math.random,
        spawnAvoid(room),
        spawnClearOfBoss(room, now),
      );
      const client = clients.get(id);
      if (!client) continue;
      combat.respawned(id, now);
      resetOnRecord(client, spawn, now);
    }
    noteSpawn(room, id, spawn.pos, now);
    sendToRoom(room, {
      type: "respawn",
      id,
      spawn,
      protectedUntil: now + SPAWN_PROTECTION_MS,
    });
  }
}

/** A human's server-side plane starts over at `spawn` (respawn, W2 return). */
function resetOnRecord(client: Client, spawn: SpawnState, now: number): void {
  client.pose = poseFromSpawn(spawn);
  client.poseTime = now;
  client.rejectStreak = 0;
  client.lastPoseAt = now;
  client.boost = createBoost(now); // fresh plane, full gauge, no tail
  client.course.reset(); // a respawn is never part of a run (S3)
}

/**
 * W2: move a client's away state toward what its tab asked for. Going away
 * waits until the plane has gone AWAY_COMBAT_LOCK_MS without damage — until
 * then it stays in snapshots, hittable, so hiding never dodges a burst that
 * is already landing. Coming back waits out AWAY_MIN_MS, then a living plane
 * re-enters with a fresh spawn and protection: its local flight state froze
 * with the tab. (A dead one just keeps its kill-cam respawn.)
 */
function settleAway(client: Client, now: number): void {
  if (client.wantsAway && !client.away) {
    if (combat.damagedWithin(client.id, now, AWAY_COMBAT_LOCK_MS)) return;
    client.away = true;
    client.awayAt = now;
    storm.forget(client.id);
    client.course.reset(); // out of the world: no run survives it (S3)
    // Only the player needs to know: to everyone else it just drops out of
    // snapshots. The client holds its poses for the return respawn on this.
    if (client.ws.readyState === client.ws.OPEN) {
      const started: ServerMsg = { type: "awayStarted" };
      client.ws.send(JSON.stringify(started));
    }
  } else if (
    !client.wantsAway &&
    client.away &&
    now - client.awayAt >= AWAY_MIN_MS
  ) {
    client.away = false;
    if (!combat.isAlive(client.id)) return;
    const spawn = pickRespawn(
      livingEnemies(client.room, client.id),
      Math.random,
      spawnAvoid(client.room),
      spawnClearOfBoss(client.room, now),
    );
    combat.returned(client.id, now);
    resetOnRecord(client, spawn, now);
    noteSpawn(client.room, client.id, spawn.pos, now);
    sendToRoom(client.room, {
      type: "respawn",
      id: client.id,
      spawn,
      protectedUntil: now + SPAWN_PROTECTION_MS,
    });
  }
}

/** One bot sim step for a room: build the coherent contact list, advance the
 * pilots, settle crashes, land the rounds that met their targets, and route
 * trigger pulls through Combat (accepted ones fly as rounds) — reusing
 * the same broadcasts human fire produces. */
function tickRoomBots(room: Room, now: number): void {
  const bots = botsFor(room);
  // W1: the enemies hunt humans — the humans in the air are their only
  // contacts (never each other, never their own carrier's weak points).
  const contacts = humanContacts(waveHumans(room, now, false));
  // B3: a hurt bot breaks off and comes back after regen — its own HP, now
  // that it is not on its own contact list.
  for (const member of room.members.values()) {
    if (member.isBot) bots.setHp(member.id, combat.hpOf(member.id));
  }
  // B3: the timed hazards every client has already been told about — X1
  // missiles from their launch, S4 flak from its firing — for the bots to
  // fly around.
  bots.setHazardDiscs(
    "missile",
    missilesFor(room).director.missiles().map(missileHazard),
  );
  bots.setHazardDiscs("flak", roomBoss(room).shellsInFlight().map(flakHazard));

  const { shots, cues, hits, crashes } = bots.tick(now, contacts);

  // D4: a falling wreck is solid for bots too (they do not probe for it).
  const wrecks = wrecksByRoom.get(room.id);
  const struck: { id: string; shooterId: string | null }[] = [];
  if (wrecks && wrecks.count > 0) {
    for (const member of room.members.values()) {
      if (!member.isBot || !combat.isAlive(member.id)) continue;
      const c = bots.contactOf(member.id);
      const r = c && wrecks.touching(member.id, c.pos, PLAYER_RADIUS, now);
      if (r) struck.push({ id: member.id, shooterId: r.shooterId });
    }
  }
  const deaths = [
    // D3: crushed by collapse debris is a collapse kill, not a crash.
    ...crashes.map((id) => ({
      id,
      death: crashDeath(room, id, bots.lastPosOf(id), now, now),
    })),
    ...struck.map(({ id, shooterId }) => {
      const death = combat.wreckKill(id, shooterId, now);
      if (death) bots.setDead(id);
      return { id, death };
    }),
  ];

  for (const { id, death } of deaths) {
    if (!death) continue;
    deathBlast(room, id, death.killerId);
    sendDeath(room, death, now);
  }

  // Rounds that landed this tick first (they were swept before anyone
  // moved), then this tick's fresh trigger pulls go into the air.
  for (const round of hits) {
    routeBotHit(room, bots, landBotRound(combat, round, now), round.shot, now);
  }

  for (const shot of shots) {
    if (!combat.isAlive(shot.botId)) continue;
    if (!applyBotFire(combat, shot, now)) continue;
    bots.launch(shot, now);
    const rc = breakable(room);
    if (rc) applyShotDamage(rc, shot.origin, shot.dir, shot.botId);
    // Same cosmetic path as human fire: everyone renders the tracer.
    sendToRoom(room, { type: "fired", id: shot.botId });
    offerCityEvent(room, "gunfire", shot.botId, now);
  }

  tickBombs(room, bots, cues, now);
}

/** W3: the room's manned AA nests' roof decks (bomb-run targets). */
function mannedNests(room: Room): Vec3[] {
  const aa = aaByRoom.get(room.id);
  if (!aa) return [];
  const rc = roomCity(room);
  const state = rc.props.slot.state;
  const world = { buildings: rc.buildings, props: state, gaps: state.gapMask };
  const out: Vec3[] = [];
  for (const n of aa.nests) {
    if (aa.manned(n, world)) {
      out.push({ x: n.x, y: bombSurfaceY(rc.index, n.x, n.z), z: n.z });
    }
  }
  return out;
}

/**
 * W2 the enemy planes' bombs for one room tick — only while the room's city
 * may break (breakable) and the war is on: the director ends the runs the
 * brain dropped and orders at most one new one, then this tick's cued
 * releases are decided. A bomb that falls is an X1 strike already in the
 * room's pipeline; it is announced as `missile` with its dropper and rack.
 */
function tickBombs(
  room: Room,
  bots: RoomBots,
  cues: readonly BombReleaseCue[],
  now: number,
): void {
  const rc = breakable(room);
  if (!rc || !wavesOn(room)) return;
  const waves = wavesFor(room);
  const director = bombsFor(room);
  const humans: BombHuman[] = waveHumans(room, now).map((h) => ({
    id: h.id,
    pos: h.pos,
    vel: h.vel,
    prot: h.prot,
  }));
  const raid = roomBoss(room).activeRaid(now);
  const carrier = raid ? bossPoseAt(raid, now, blankPose()) : null;
  const world: BombWorld = {
    index: rc.index,
    buildings: rc.buildings,
    missiles: missilesFor(room).director,
    budget: budgetFor(room),
    carrier: carrier && { x: carrier.x, y: carrier.y, z: carrier.z },
    hold: rc.damage.hold,
    intensity: waves.intensity,
    wave: waves.state().wave,
    nests: mannedNests(room),
  };
  const enemies = [];
  for (const e of waves.enemies()) {
    const c = e.down ? null : bots.contactOf(e.id);
    if (!c) continue;
    enemies.push({
      id: e.id,
      pos: c.pos,
      vel: c.vel,
      quarry: bots.quarryOf(e.id),
      ready: bots.canBomb(e.id, now),
      onRun: bots.runOf(e.id) !== null,
      launchedAt: e.launchedAt,
    });
  }
  for (const order of director.tick(now, enemies, humans, world)) {
    if (!bots.startRun(order.enemyId, order.kind, order.target, now)) {
      director.refused(order.enemyId, now);
    }
  }
  for (const cue of cues) {
    if (!combat.isAlive(cue.botId)) continue;
    const drop = director.drop(
      now,
      { enemyId: cue.botId, pos: cue.pos, vel: cue.vel },
      humans,
      world,
    );
    if (typeof drop === "string") continue;
    sendToRoom(room, {
      type: "missile",
      m: encodeMissile(drop.strike),
      by: drop.enemyId,
      r: drop.rack,
    });
    if (drop.done) bots.endRun(drop.enemyId, now);
  }
}

/** Broadcast one settled bot hit: damage, the victim bot's evade, and a
 * kill's death + scores — the human hit path's messages, unchanged. */
function routeBotHit(
  room: Room,
  bots: RoomBots,
  hit: HitResult,
  shot: { botId: string; targetId: string },
  now: number,
): void {
  if (!hit.ok) return;
  sendToRoom(room, {
    type: "damage",
    targetId: shot.targetId,
    shooterId: shot.botId,
    hp: hit.hp,
  });
  if (room.members.get(shot.targetId)?.isBot) {
    bots.onDamaged(shot.targetId, now);
  }
  if (hit.death) {
    // D4: it falls as a wreck (or, over the cap, explodes in place).
    const wreck = shotDown(room, shot.targetId, shot.botId, now);
    if (room.members.get(shot.targetId)?.isBot) {
      bots.setDead(shot.targetId);
    }
    sendDeath(room, hit.death, now, wreck);
  }
}

/** The hidden death ceiling: feed every living member's on-record altitude
 * (humans from validated poses, bots from the sim) and settle expired graces
 * as server-declared storm deaths — kill bolt via the ordinary death event.
 * No warning precedes this, by design (discovery IS the feature). */
function enforceStormCeiling(room: Room, now: number): void {
  for (const member of room.members.values()) {
    const pose = memberPose(room, member.id);
    if (!pose) continue;
    if (storm.observe(member.id, pose.pos.y, now) !== "kill") continue;
    const death = combat.stormKill(member.id, now);
    if (!death) continue;
    storm.forget(member.id);
    if (member.isBot) botsFor(room).setDead(member.id);
    sendDeath(room, death, now);
  }
}

/** A member's on-record velocity: bots from the sim, humans from the pose. */
const velocityOf = (room: Room, id: string, pose: Pose): Vec3 =>
  room.members.get(id)?.isBot
    ? (botsFor(room).contactOf(id)?.vel ?? { x: 0, y: 0, z: 0 })
    : poseVelocity(pose);

/**
 * X1 missile strikes for one room tick: land what is due (chunks, the
 * `missile` city event, plane damage), then let the director launch — only
 * while a human is in the room, like all destruction (see breakable).
 */
function tickMissiles(room: Room, now: number): void {
  const rm = missilesFor(room);
  for (const m of rm.director.settle(now)) landMissile(room, rm, m, now);
  const rc = breakable(room);
  if (!rc) return;
  const planes: DirectorPlane[] = [];
  for (const member of room.members.values()) {
    const pose = memberPose(room, member.id);
    if (!pose) continue;
    planes.push({
      id: member.id,
      pos: pose.pos,
      vel: velocityOf(room, member.id, pose),
      human: !member.isBot,
      // A timed course run (S3) never draws fire: luck is not a lap time.
      eligible: !clients.get(member.id)?.course.running,
      prot: combat.isProtected(member.id, now),
    });
  }
  const launched = rm.director.tick(now, planes, {
    nearBuilding: rm.near,
    index: rm.index,
    buildings: rc.buildings,
    destroyedShare:
      rc.damage.destroyedCount / Math.max(1, rc.damage.chunkCount),
    budget: budgetFor(room),
  });
  if (launched) {
    sendToRoom(room, { type: "missile", m: encodeMissile(launched) });
  }
}

/**
 * S4/W1 the carrier for one room tick: the schedule (a carrier only comes
 * while a human is flying and the war is on), the turrets' shells at the
 * humans, the bursts due — flak damage through Combat like a missile's, a
 * kill falling as a D4 wreck — and the falling sections that hit: D2 chunk
 * damage (when breakable) credited to the top dealer for D3, and the
 * city's death reaction where each lands. Then the tick's HP change, once,
 * and the carrier's waves.
 */
function tickBoss(room: Room, now: number): void {
  const boss = roomBoss(room);
  const humans = waveHumans(room, now);
  // W1: its turrets shoot at the humans only — never its own planes.
  const planes: BossPlane[] = humans.map((h) => ({
    id: h.id,
    pos: h.pos,
    vel: h.vel,
    prot: h.prot,
  }));
  const result = boss.tick(
    now,
    // D6: no carrier in a quiet city (FL1: nor a calm lab; W1: nor with the
    // war off).
    carrierOn(room) && flyingHumanIn(room),
    planes,
    bossWorld(room),
  );
  if (result.started) {
    sendToRoom(room, { type: "boss", r: encodeRaid(result.started) });
  }
  if (result.flak.length > 0) {
    sendToRoom(room, { type: "flak", f: result.flak.map(encodeFlak) });
  }
  for (const { flak, victims } of result.bursts) {
    for (const victim of victims) {
      const hit = combat.environmentDamage(
        victim.id,
        victim.damage,
        now,
        "flak",
      );
      if (!hit) continue;
      const isBot = room.members.get(victim.id)?.isBot ?? false;
      sendToRoom(room, {
        type: "damage",
        targetId: victim.id,
        shooterId: BOSS_ID,
        hp: hit.hp,
        from: flak.to,
      });
      if (isBot) botsFor(room).onDamaged(victim.id, now);
      if (!hit.death) continue;
      // Shot down by flak: it falls as a wreck like any shot-down plane.
      const wreck = shotDown(room, victim.id, hit.death.killerId, now);
      if (isBot) botsFor(room).setDead(victim.id);
      sendDeath(room, hit.death, now, wreck);
    }
  }
  if (result.landed.length > 0) {
    const top = bossCredit(boss.damageLedger()).top;
    const by = top !== null && room.members.has(top) ? top : null;
    for (const { at, building } of result.landed) {
      const rc = breakable(room);
      if (rc) applyBossImpact(rc, at, by, building);
      const event = cityEvents.offer(room.id, "death", at, now);
      if (event) sendToRoom(room, { type: "cityEvent", event });
    }
  }
  if (boss.takeHpChanged() && boss.slot.raid) {
    sendToRoom(room, { type: "bossHp", id: boss.slot.raid.id, hp: boss.hp });
  }
  // W1: the carrier's waves — after it, so a launch sees this tick's carrier.
  wavesFor(room).tick(now, wavesOn(room), humans);
}

/**
 * One missile lands: D2 chunk damage, the city's blast reaction (fire,
 * blown windows, smoke — replayed to joiners), then every plane in the
 * blast radius by distance from its on-record pose EXTRAPOLATED to now.
 * A missile death is the plane's only blast: no deathBlast or death city
 * event on top of the missile's own.
 */
function landMissile(
  room: Room,
  rm: RoomMissiles,
  m: MissileStrike,
  now: number,
): void {
  const rc = breakable(room);
  if (rc) {
    const broke = applyMissileImpact(rc, m);
    // C2: what it broke catches fire.
    chaosFor(room)?.ignite(broke, now, rc);
  }
  const event = cityEvents.offer(room.id, "missile", m.to, now);
  if (event) sendToRoom(room, { type: "cityEvent", event });
  const planes: { id: string; pos: Vec3 }[] = [];
  for (const member of room.members.values()) {
    const pose = memberPose(room, member.id);
    if (!pose) continue;
    const age = poseAgeOf(member.id, now) / 1000;
    const v = velocityOf(room, member.id, pose);
    planes.push({
      id: member.id,
      pos: canonicalize({
        x: pose.pos.x + v.x * age,
        y: pose.pos.y + v.y * age,
        z: pose.pos.z + v.z * age,
      }),
    });
  }
  const cause =
    m.kind === "meteor" ? "meteor" : m.kind === "bomb" ? "bomb" : "missile";
  for (const victim of rm.director.blastVictims(m, planes, now)) {
    const isBot = room.members.get(victim.id)?.isBot ?? false;
    // W2: every bomb is an enemy plane's, and the enemies are immune to
    // their own side's bombs (no friendly-fire crashes in a wave).
    if (isBot && m.kind === "bomb") continue;
    const hit = combat.environmentDamage(victim.id, victim.damage, now, cause);
    if (!hit) continue;
    sendToRoom(room, {
      type: "damage",
      targetId: victim.id,
      shooterId: MISSILE_SHOOTER_ID,
      hp: hit.hp,
      from: m.to,
    });
    // C2: a meteor's or bomb's blast has already gone off — a bot's break
    // turn (meant to shake a shooter) only throws it into the towers. The
    // bot sim measured it: 0.26 → 0.19 crashes / bot-min with chaos on.
    if (isBot && cause === "missile") botsFor(room).onDamaged(victim.id, now);
    if (!hit.death) continue;
    rm.director.forget(victim.id);
    sendDeath(room, hit.death, now);
    if (isBot) botsFor(room).setDead(victim.id);
  }
}

/** D5: the living planes in the air as the destruction director sees them. */
function directorPlanes(room: Room, now: number): DestructionPlane[] {
  const planes: DestructionPlane[] = [];
  for (const member of room.members.values()) {
    const pose = memberPose(room, member.id);
    if (!pose) continue;
    planes.push({
      id: member.id,
      pos: pose.pos,
      vel: velocityOf(room, member.id, pose),
      human: !member.isBot,
      protected: combat.isProtected(member.id, now),
      ageMs: poseAgeOf(member.id, now),
    });
  }
  return planes;
}

/**
 * D5 destruction director for one room tick — only while a human is in the
 * room, like all destruction (see breakable). Broadcasts its warnings and
 * hands back what fired; the bots get the warned zones as no-fly zones.
 */
function tickDirector(room: Room, now: number): FiredEvent[] {
  const rc = breakable(room);
  const director = directorsByRoom.get(room.id) ?? (rc && directorFor(room));
  if (!director) return [];
  const result = rc
    ? director.tick(now, directorPlanes(room, now), {
        city: rc,
        cranes: moversFor(room.seed).cranes,
        budget: budgetFor(room),
      })
    : null;
  for (const e of result?.warned ?? []) {
    sendToRoom(room, { type: "directorWarn", e: encodeDirectorEvent(e) });
  }
  botsByRoom.get(room.id)?.setHazards(director.pending());
  return result?.fired ?? [];
}

/** D5: announce and apply the room's due rebuilds. */
function tickRebuilds(room: Room, now: number): void {
  const rc = breakable(room);
  if (!rc) return;
  const director = directorFor(room);
  // A1: its plane list only on the ticks it checks (1 in 20).
  if (!director.rebuildDue(now)) return;
  const wires = director.rebuild(now, directorPlanes(room, now), {
    city: rc,
    cranes: moversFor(room.seed).cranes,
  });
  for (const r of wires) {
    sendToRoom(room, { type: "rebuild", r });
    // C2: a rebuilt building's fires are out (the next `fires` batch).
    if (r.go && r.k === 0) chaosFor(room)?.rebuilt(r.b);
  }
}

/**
 * C2 chaos for one room tick — only while a human is in the room, like all
 * destruction (see breakable): meteors launched (as `missile`), quakes
 * warned, and the tick's fires batch. What quakes and fire break rides the tick's
 * `chunks` batch.
 */
function tickChaos(room: Room, now: number): void {
  const chaos = chaosFor(room);
  const rc = breakable(room);
  const budget = budgetFor(room);
  if (!chaos || !rc || !budget) return;
  const planes = chaosPlanes(room, now);
  const rm = missilesFor(room);
  const out = chaos.tick(now, planes, {
    city: rc,
    missiles: rm.director,
    budget,
    index: rm.index,
  });
  for (const m of out.meteors) {
    sendToRoom(room, { type: "missile", m: encodeMissile(m) });
  }
  for (const q of out.quakes) {
    sendToRoom(room, { type: "quake", q: encodeQuake(q) });
  }
  // D9: every chunk that catches fire is sooted until its building rebuilds.
  for (const id of out.firesOn) rc.props.soot.add(id);
  if (out.firesOn.length > 0 || out.firesOff.length > 0) {
    sendToRoom(room, {
      type: "fires",
      on: encodeChunkIds([...out.firesOn].sort((a, b) => a - b)),
      off: encodeChunkIds([...out.firesOff].sort((a, b) => a - b)),
    });
  }
}

/** The room's planes as the C2 and U6 directors see them this tick:
 * living, posed, extrapolated to `now`. */
function chaosPlanes(room: Room, now: number): ChaosPlane[] {
  const planes: ChaosPlane[] = [];
  for (const member of room.members.values()) {
    const pose = memberPose(room, member.id);
    if (!pose) continue;
    const age = poseAgeOf(member.id, now) / 1000;
    const v = velocityOf(room, member.id, pose);
    planes.push({
      id: member.id,
      pos: canonicalize({
        x: pose.pos.x + v.x * age,
        y: pose.pos.y + v.y * age,
        z: pose.pos.z + v.z * age,
      }),
      vel: v,
      human: !member.isBot,
      prot: combat.isProtected(member.id, now),
    });
  }
  return planes;
}

/** U6: the room's cave-ins this tick — only while its city is live (see
 * quiet), like all chaos: each new one goes out as one `caveIn`. */
function tickCaveIns(room: Room, now: number): void {
  const director = caveInsFor(room);
  if (!director || quiet(room)) return;
  const out = director.tick(now, chaosPlanes(room, now), budgetFor(room));
  for (const e of out) sendToRoom(room, { type: "caveIn", c: encodeCaveIn(e) });
}

/**
 * D5: a gas main blew: the city's blast reaction (`gas` city event — fire,
 * blown windows, smoke, responders, replayed to joiners), then every plane
 * near the fireball by its on-record pose EXTRAPOLATED to now (landMissile's
 * rule). Its own blast is the plane's only one: no deathBlast on top.
 */
function landGas(room: Room, e: DirectorEvent, now: number): void {
  const event = cityEvents.offer(room.id, "gas", e, now);
  if (event) sendToRoom(room, { type: "cityEvent", event });
  const director = directorFor(room);
  const planes: { id: string; pos: Vec3; fresh: boolean }[] = [];
  for (const p of directorPlanes(room, now)) {
    const age = p.ageMs / 1000;
    planes.push({
      id: p.id,
      pos: canonicalize({
        x: p.pos.x + p.vel.x * age,
        y: p.pos.y + p.vel.y * age,
        z: p.pos.z + p.vel.z * age,
      }),
      fresh: p.protected,
    });
  }
  for (const victim of gasVictims(e, planes)) {
    const hit = combat.environmentDamage(
      victim.id,
      victim.damage,
      now,
      "blast",
    );
    if (!hit) continue;
    const isBot = room.members.get(victim.id)?.isBot ?? false;
    sendToRoom(room, {
      type: "damage",
      targetId: victim.id,
      // The environment-blast id: clients point the damage at `from`.
      shooterId: MISSILE_SHOOTER_ID,
      hp: hit.hp,
      from: { x: e.x, y: e.y, z: e.z },
    });
    if (isBot) botsFor(room).onDamaged(victim.id, now);
    if (!hit.death) continue;
    director.forget(victim.id);
    sendDeath(room, hit.death, now);
    if (isBot) botsFor(room).setDead(victim.id);
  }
}

// --- HTTP: health + production statics ---
const statics = createStaticHandler();
const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (DEBUG_ROOMS && req.url === "/debug/rooms") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        rooms: rooms.rooms.map((r) => r.id),
        botsByRoom: [...botsByRoom.keys()],
        wavesByRoom: [...wavesByRoom.keys()],
        cityEvents: cityEvents.roomIds(),
        roomMoversById: [...roomMoversById.keys()],
        pendingKillByRoom: [...pendingKillByRoom.keys()],
        roomCityById: [...roomCityById.keys()],
        missilesByRoom: [...missilesByRoom.keys()],
        wrecksByRoom: [...wrecksByRoom.keys()],
        directorsByRoom: [...directorsByRoom.keys()],
        bossByRoom: [...bossByRoom.keys()],
        chaosByRoom: [...chaosByRoom.keys()],
        budgetsByRoom: [...budgetsByRoom.keys()],
        caveInsByRoom: [...caveInsByRoom.keys()],
        // A2: the soak's server samples — memory after a forced GC (when
        // run with --expose-gc) and each room's damage, which every
        // member's client must agree with.
        memory: memoryAfterGc(),
        damage: Object.fromEntries(
          [...roomCityById].map(([id, rc]) => [
            id,
            {
              destroyed: rc.damage.destroyedCount,
              fallen: rc.damage.fallenCount,
              collapses: rc.collapses.records.length,
            },
          ]),
        ),
      }),
    );
    return;
  }
  if (tickStats.enabled && req.url?.startsWith("/debug/tick")) {
    if (req.url.endsWith("?reset=1")) tickStats.reset();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(tickStats.report()));
    return;
  }
  if (statics?.(req, res)) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// --- WebSocket rooms ---
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on("connection", (ws) => {
  let client: Client | null = null;
  /** Minted on the join frame, before handleJoin's side effects. */
  let joinedId: string | null = null;
  // A socket that never says `join` is not a player: no liveness sweep sees
  // it, so without this it would hold its slot open forever.
  const joinDeadline = setTimeout(() => ws.terminate(), JOIN_DEADLINE);

  /** Route one validated envelope. A known type with bad fields is dropped
   * by its guard, exactly like an unknown type. */
  const dispatch = (msg: ClientEnvelope, now: number): void => {
    if (msg.type === "join" && !joinedId) {
      clearTimeout(joinDeadline);
      // FL1: a lab join never resumes — its token is not even looked up.
      const lab = msg.lab === true;
      const resumed = lab ? null : takeResume(msg.resume);
      joinedId = resumed?.id ?? mintPlayerId();
      client = handleJoin(
        ws,
        msg.name,
        joinedId,
        resumed && { record: resumed.record, token: msg.resume as string },
        lab,
      );
      // W4: a fresh join, a resume (maybe into another room) — either way
      // the room's enemies learn the pilot's Easy mode from the join.
      if (client) setEasy(client, msg.easy === true);
      return;
    }
    if (!client) return;
    if (client.prevToken !== null) {
      // The resumed session spoke, so its welcome (and new token) arrived:
      // the token it was resumed with is spent now.
      resumeIds.delete(client.prevToken);
      client.prevToken = null;
    }
    if (msg.type === "ping") {
      // W1 boot keepalive / W2 hidden-tab heartbeat: arriving already
      // refreshed lastMsgAt.
    } else if (msg.type === "away") {
      // A booting client isn't in the air to leave it; settleAway does the rest.
      if (typeof msg.on === "boolean" && !client.pending) {
        client.wantsAway = msg.on;
      }
    } else if (client.away) {
      // Away (W2): the plane is out of the world — its pose, shots, hit
      // claims, crashes and boost edges don't exist until it returns.
      if (msg.type === "setIntensity") {
        handleSetIntensity(client, msg.level, now);
      } else if (msg.type === "setEasy" && typeof msg.on === "boolean") {
        setEasy(client, msg.on);
      }
    } else if (msg.type === "pose") {
      if (!isPose(msg.pose)) return;
      if (client.pending) goLive(client, now);
      handlePose(client, msg.pose, msg.t, now);
    } else if (msg.type === "boost") {
      handleBoost(client, msg.on, now);
    } else if (msg.type === "fire") {
      // Not in the air yet: no shot, and no early end to a protection
      // window that hasn't started.
      if (!client.pending) handleFire(client, msg.seq, now);
    } else if (msg.type === "hit") {
      if (!client.pending) handleHitClaim(client, msg, now);
    } else if (msg.type === "bossHit") {
      if (!client.pending) handleBossHit(client, msg, now);
    } else if (msg.type === "crash") {
      handleCrash(client, msg.t, msg.wreck, now);
    } else if (msg.type === "setIntensity") {
      handleSetIntensity(client, msg.level, now);
    } else if (msg.type === "setEasy") {
      if (typeof msg.on === "boolean") setEasy(client, msg.on);
    } else if (msg.type === "lab") {
      // FL1: ignored outside a lab room (applyLab refuses); newest wins.
      client.room.applyLab({
        tuning: msg.tuning,
        chaos: msg.chaos,
        waves: msg.waves,
      });
    }
  };

  ws.on("message", (data) => {
    // Frames already parsed off a socket we just terminated still arrive.
    if (ws.readyState !== ws.OPEN) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.close(1003, "malformed message");
      return;
    }
    if (!isClientMsg(msg)) {
      ws.close(1003, "malformed message");
      return;
    }
    const now = Date.now();
    if (client) client.lastMsgAt = now;
    try {
      dispatch(msg, now);
    } catch (err) {
      // Never let one socket take the process (and every room) down: drop
      // just this connection; its close handler cleans the player up.
      console.error(
        `message handler failed for ${joinedId ?? "unjoined socket"}:`,
        err,
      );
      ws.terminate();
    }
  });

  ws.on("close", () => {
    clearTimeout(joinDeadline);
    // A resume that took this session over (W2) already left it, and the id
    // now belongs to the new socket: this late close must not evict it.
    const owner = joinedId === null ? undefined : clients.get(joinedId);
    if (joinedId && (!owner || owner.ws === ws)) handleLeave(joinedId);
    client = null;
    joinedId = null;
  });
  ws.on("error", () => ws.terminate());
});

// --- Combat + bot sim tick + snapshots at TICK_DOWN_HZ, one stringify per room ---
// Snapshots go out QUANTISED (ANGE-4KO2W2): common/src/net.ts turns each entry
// into a tuple of integers, which is what pays for the 20 Hz cadence.
function tick(): void {
  const time = Date.now();
  tickStats.begin();
  for (const client of clients.values()) settleAway(client, time);
  issueRespawns(combat.tick(time).respawnsDue, time);
  tickStats.lap("combat");
  for (const room of rooms.rooms) {
    tickRoomBots(room, time);
    tickStats.lap("bots");
    tickAa(room, time); // W3: the rooftop guns, after the planes moved
    tickStats.lap("aa");
    enforceStormCeiling(room, time);
    updateNewsHeli(room, time);
    // C2: the gone-share backstop — at GONE_HOLD_SHARE nothing breaks this
    // tick (strikes still land) until rebuilds catch up.
    const held = roomCityById.get(room.id);
    if (held && TUNINGS.hold) applyGoneHold(held);
    landWrecks(room, time); // D4: before the batch — its chunks ride along
    tickMissiles(room, time);
    tickStats.lap("wrecks+missiles");
    tickChaos(room, time); // C2: before the batch — quakes' and fires' chunks
    tickCaveIns(room, time); // U6
    tickStats.lap("chaos");
    tickBoss(room, time); // S4: before the batch — a landing's chunks ride it
    tickStats.lap("boss");
    // D5: the director fires what is due (a gas main's chunks join the
    // batch; a demolition's record goes out after it) and warns what is next.
    const fired = tickDirector(room, time);
    tickStats.lap("director");
    // D2: everything that broke this tick, as ONE batch — then (D3) every
    // collapse it set off, after it, so a client applies them in order.
    const rc = roomCityById.get(room.id);
    if (rc) {
      const { broke, collapses, props } = tickDestruction(
        rc,
        time,
        breakable(room) ? chaosPlanes(room, time) : [],
      );
      if (broke.length > 0) {
        sendToRoom(room, { type: "chunks", d: encodeChunkIds(broke) });
      }
      for (const f of fired) {
        if (f.collapse) sendToRoom(room, { type: "collapse", c: f.collapse });
      }
      for (const c of collapses) sendToRoom(room, { type: "collapse", c });
      // D9: the props' batch, after the chunks and collapses it rides on.
      const pm = propsMessage(props);
      if (pm) sendToRoom(room, { type: "props", ...pm });
      // Shot cranes are felled through the director's warning; fires light
      // where the props' blasts broke chunks (next tick's batch).
      for (const site of props.condemned) directorFor(room).condemnCrane(site);
      if (props.broke.length > 0) chaosFor(room)?.ignite(props.broke, time, rc);
    }
    // D5: rebuilds after the batch (nothing of theirs is pending now), then
    // the gas mains' blasts on the planes.
    tickRebuilds(room, time);
    for (const f of fired) {
      if (f.event.k === EVENT_GAS) landGas(room, f.event, time);
    }
    tickStats.lap("destruction");
    const snapshot: WireSnapshotMsg = {
      type: "snapshot",
      time,
      p: [],
    };
    // Dead planes are simply absent until their respawn is announced.
    for (const { id } of room.members.values()) {
      const pose = memberPose(room, id);
      if (!pose) continue;
      snapshot.p.push(
        encodeSnapshotEntry({
          id,
          pose,
          hp: combat.hpOf(id),
          prot: combat.isProtected(id, time),
          age: poseAgeOf(id, time),
        }),
      );
    }
    sendToRoom(room, snapshot);
    tickStats.lap("snapshot");
  }
  tickStats.end();
}

// Drift-compensating scheduler rather than setInterval: a tick that overruns
// pushes the NEXT one earlier, so the mean cadence really is TICK_DOWN_HZ.
// With a plain interval the bot sim's own cost stretched the observed gap well
// past nominal — and a faster tick you don't actually deliver is not a faster
// tick. BOT_DT assumes this cadence too, so the drift was slowing bots down.
const TICK_MS = 1000 / TICK_DOWN_HZ;
// A2: a throw anywhere in the tick must cost one tick, not the process.
const guardTick = createGuard("tick");
let nextTickAt = Date.now();
const scheduleTick = (): void => {
  nextTickAt += TICK_MS;
  // A long stall (debugger, GC pause) must not queue a burst of catch-up
  // ticks: skip straight to the next deadline in the future.
  const now = Date.now();
  if (nextTickAt < now) nextTickAt = now + TICK_MS;
  setTimeout(
    () => {
      guardTick(tick, Date.now());
      scheduleTick();
    },
    Math.max(0, nextTickAt - now),
  );
};
scheduleTick();

// S3: generate (and log) the city's stunt courses before the first join.
courseSetFor(CITY_SEED);

// --- Liveness: joined clients stream at TICK_UP_HZ; prolonged silence = gone ---
// A pending client (W1) is booting and may legitimately be silent for
// seconds, so it gets a deadline counted from its join instead — fixed, so
// no keepalive can hold its seat forever.
// An away client (W2) heartbeats from a hidden tab: it is held to the away
// window counted from going away (never extended by pings) and to a looser
// silence bound, since a phone may freeze the page outright.
setInterval(() => {
  const now = Date.now();
  for (const client of clients.values()) {
    const gone = client.pending
      ? now - client.joinedAt > BOOT_TIMEOUT
      : client.away
        ? now - client.awayAt > AWAY_TIMEOUT ||
          now - client.lastMsgAt > AWAY_SILENCE
        : now - client.lastMsgAt > LIVENESS;
    if (gone) client.ws.terminate();
  }
  // W2: dropped sessions expire, and tokens pointing at nothing go with them.
  for (const [id, record] of resumeRecords) {
    if (record.expiresAt <= now) resumeRecords.delete(id);
  }
  for (const [token, id] of resumeIds) {
    if (!clients.has(id) && !resumeRecords.has(id)) resumeIds.delete(token);
  }
}, 2000);

server.listen(PORT, () => {
  // The bound address, not PORT: with PORT=0 the OS picks one, and tests read
  // the real number back off this line.
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : PORT;
  console.log(
    `angels-bandits server listening on :${bound} (statics: ${statics ? "client/dist" : "dev — use vite"})`,
  );
});
