// The Angels & Bandits server: one Node process serving /healthz, the built
// client statics (production), and the ws presence rooms. HUMAN movement stays
// client-authoritative (PLAN.md authority split) — pose claims are clamped via
// validatePose and relayed in snapshots. The one flight sim this process DOES
// run is the backfill bots (B1): RoomBots advances them with the shared
// stepFlight inside the same TICK_DOWN_HZ snapshot tick.

import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  type Boost,
  boostLevel,
  boostSpeedCap,
  createBoost,
  startBoost,
  stopBoost,
} from "@angels-bandits/common/boost";
import {
  encodeChunkIds,
  generateCity,
  mulberry32,
} from "@angels-bandits/common/city";
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
  JOIN_DEADLINE_MS,
  LIVENESS_TIMEOUT_MS,
  NAME_MAX_LENGTH,
  PLAYER_RADIUS,
  POSE_AGE_MAX_MS,
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
import { type Vec3, canonicalize } from "@angels-bandits/common/world";
import type { WreckParams, WreckWorld } from "@angels-bandits/common/wreck";
import { type WebSocket, WebSocketServer } from "ws";
import {
  type BotContact,
  RoomBots,
  applyBotFire,
  landBotRound,
  poseVelocity,
} from "./bots";
import { CityEventLog, nearBuildingProbe } from "./cityevents";
import { Combat, type Death, type HitResult, type SpeedCapFn } from "./combat";
import {
  CourseBook,
  CourseTracker,
  type FinishedRun,
  type SweepWorld,
} from "./courses";
import {
  type RoomCity,
  applyDeathBlast,
  applyShotDamage,
  createRoomCity,
  noseOf as wireNose,
} from "./destruction";
import {
  type ClientEnvelope,
  isClientMsg,
  isPose,
  isResumeToken,
  isVec3,
} from "./guards";
import { type RespawnEnemy, pickBotRespawn, pickRespawn } from "./respawn";
import { type Room, RoomManager } from "./room";
import { createStaticHandler } from "./statics";
import { StormCeiling } from "./storm";
import {
  DEFAULT_TUNING,
  type DirectorPlane,
  FAST_TUNING,
  MissileDirector,
  applyMissileImpact,
} from "./strikes";
import { poseFromSpawn, validatePose } from "./validate";
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

/** X1: AB_MISSILE_FAST=1 (tests and QA only) makes strikes come quickly. */
const MISSILE_TUNING =
  process.env.AB_MISSILE_FAST === "1" ? FAST_TUNING : DEFAULT_TUNING;

/** Test-only introspection of the per-room maps (`GET /debug/rooms`). */
const DEBUG_ROOMS = process.env.AB_DEBUG_ROOMS === "1";

/** After this many consecutive snap-rejects, accept the claim as a re-sync —
 * a client-side respawn (crash death) legitimately teleports across the map. */
const RESYNC_AFTER_REJECTS = 10;

interface Client {
  id: string;
  name: string;
  ws: WebSocket;
  room: Room;
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
 * Created lazily, dropped with the room's bots.
 */
const roomMoversById = new Map<string, MoverField>();
const roomMovers = (room: Room): MoverField => {
  let field = roomMoversById.get(room.id);
  if (!field) {
    field = withNewsHeli(moversFor(room.seed), room.seed);
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
    );
    roomCityById.set(room.id, rc);
  }
  return rc;
};

/**
 * Destruction applies only while the room has a human member (pending and
 * away ones count). The standing bot arena never empties, nothing
 * regenerates until D5, and nobody would see it — so an empty room stays
 * whole, and handleLeave clears it when its last human goes.
 */
const breakable = (room: Room): RoomCity | null =>
  room.humanCount > 0 ? roomCity(room) : null;

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

/** A plane died: blast the city at its last on-record position (alive or
 * dead — lastPosOf covers both). Call after the death is decided. */
function deathBlast(room: Room, victimId: string): void {
  const rc = breakable(room);
  const pos = rc && lastPosOf(room, victimId);
  if (rc && pos) applyDeathBlast(rc, pos);
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
    movers: moversFor(room.seed),
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
  if (!wreck) deathBlast(room, victimId);
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
  for (const { params } of wrecks.settle(now)) {
    const pos = impactPos(params);
    const rc = breakable(room);
    if (rc) applyWreckImpact(rc, pos);
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

/** Per-room bot pilots. Created lazily; seeded from the room's number so
 * bot behavior is deterministic per room. */
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

/** Sync a room's bot population to the backfill target: spawn/despawn bots,
 * mirror them into the roster + Combat, and announce like any player. */
function syncRoomBots(room: Room): void {
  const bots = botsFor(room);
  const now = Date.now();
  const { spawned, despawned } = bots.syncTo(rooms.desiredBots(room), () =>
    pickBotRespawn(livingEnemies(room, ""), (pos, yaw) =>
      bots.spawnClear(pos, yaw, now),
    ),
  );
  for (const entry of spawned) {
    rooms.addBot(room, entry.id, entry.name);
    combat.addPlayer(entry.id, now);
    const at = bots.lastPosOf(entry.id);
    if (at) missilesFor(room).director.noteSpawn(entry.id, at, now);
    sendToRoom(room, { type: "playerJoined", player: entry });
  }
  for (const id of despawned) {
    combat.removePlayer(id);
    medals.forget(id);
    storm.forget(id);
    rooms.leave(id);
    sendToRoom(room, { type: "playerLeft", id });
  }
  // A wound-down room (no humans, no bots) is gone — drop its pilots too.
  disposeRoom(room);
}

/**
 * Free everything kept per room id once `room` is gone from the manager.
 * Liveness is the only test — never botTarget: a room still listed keeps its
 * state, and a dead id is never reused (room ids only count up), so the lazy
 * getters can't resurrect it either — only listed rooms are ever ticked.
 */
function disposeRoom(room: Room): void {
  if (rooms.rooms.includes(room)) return;
  botsByRoom.delete(room.id);
  cityEvents.forget(room.id);
  roomMoversById.delete(room.id);
  pendingKillByRoom.delete(room.id);
  roomCityById.delete(room.id);
  missilesByRoom.delete(room.id);
  wrecksByRoom.delete(room.id);
}

const sanitizeName = (raw: unknown): string => {
  if (typeof raw !== "string") return "Pilot";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const name = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (name || "Pilot").slice(0, NAME_MAX_LENGTH);
};

function sendToRoom(room: Room, msg: ServerMsg, exceptId?: string): void {
  const data = JSON.stringify(msg);
  for (const { id } of room.members.values()) {
    if (id === exceptId) continue;
    const member = clients.get(id);
    if (member && member.ws.readyState === member.ws.OPEN) {
      member.ws.send(data);
    }
  }
}

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
): Client {
  const name = resumed ? resumed.record.name : sanitizeName(rawName);
  const room = rooms.join(id, name, resumed?.record.roomId);
  const now = Date.now();
  combat.addPlayer(id, now);
  // After addPlayer, which starts every tally at 0/0.
  if (resumed) {
    combat.restoreScore(id, resumed.record.kills, resumed.record.deaths);
    medals.restore(id, resumed.record.streak, resumed.record.best);
  }
  // Joiners get the same near-the-fight placement as respawns.
  const spawn = pickRespawn(livingEnemies(room, id));
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
    course: new CourseTracker(
      courseSetFor(room.seed).courses,
      courseSetFor(room.seed).world,
    ),
  };
  clients.set(id, client);
  resumeIds.set(client.resumeToken, id);

  const welcome: ServerMsg = {
    type: "welcome",
    id,
    roomId: room.id,
    seed: room.seed,
    spawn,
    roster: room.roster(),
    scores: room.roster().map(({ id: rid }) => scoreEntryOf(rid)),
    botTarget: room.botTarget,
    cityEvents: cityEvents.recent(room.id, now),
    newsHeli: roomMovers(room).news,
    resumeToken: client.resumeToken,
    destroyed: encodeChunkIds(roomCity(room).damage.destroyedIds()),
    courses: courseSetFor(room.seed).book.standings(),
    missiles: missilesFor(room).director.missiles().map(encodeMissile),
    wrecks: wrecksByRoom.get(room.id)?.active() ?? [],
  };
  ws.send(JSON.stringify(welcome));
  sendToRoom(room, { type: "playerJoined", player: { id, name } }, id);
  // Everyone else's board seeded this row at 0/0 from playerJoined.
  if (resumed) broadcastScores(room);
  // The human takes a seat: one bot yields (idle first) after the welcome so
  // the joiner sees a consistent roster then a normal playerLeft.
  syncRoomBots(room);
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
  const cap = speedCapOf(client, now)(client.lastPoseAt);
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
  if (client.rejectStreak >= RESYNC_AFTER_REJECTS) {
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
  combat.protectFrom(client.id, now);
  missilesFor(client.room).director.noteSpawn(client.id, client.pose.pos, now);
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
  if (client) {
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
  if (room) {
    sendToRoom(room, { type: "playerLeft", id });
    // D2: the last human out takes the damage with them (see breakable).
    if (room.humanCount === 0) roomCityById.get(room.id)?.damage.reset([]);
    // Refill the vacated seat (or wind the bots down if the room is done);
    // a room the last member just left is already gone — free its state.
    if (rooms.rooms.includes(room)) syncRoomBots(room);
    else disposeRoom(room);
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
  const verdict = combat.fire(client.id, seq, now);
  // Others render the muzzle flash/tracer; the shooter already did (favor
  // the shooter — a rejected shot just doesn't exist to anyone else).
  if (verdict.ok) {
    sendToRoom(client.room, { type: "fired", id: client.id }, client.id);
    offerCityEvent(client.room, "gunfire", client.id, now);
    // D2: the round flies from the shooter's on-record pose along its nose.
    const rc = breakable(client.room);
    if (rc) applyShotDamage(rc, client.pose.pos, wireNose(client.pose.quat));
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
 * A claim on the room's shared bot count (ANGE-6STDNN). The Room seam owns
 * the governance — clamp, whole-number check, per-player rate limit — so a
 * refusal is simply silence here: nothing is broadcast, and the claimant's
 * slider snaps back to the last value the server confirmed.
 */
function handleSetBots(client: Client, count: unknown, now: number): void {
  const accepted = client.room.setBotTarget(client.id, count, now);
  if (accepted === null) return;
  sendToRoom(client.room, {
    type: "botsConfig",
    count: accepted,
    byName: client.name,
  });
  // Bots spawn/despawn through the same path a join or a leave uses.
  syncRoomBots(client.room);
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
  });
  // D4: a wreck's city event comes when it lands, where it lands. X1: a
  // missile death's blast IS the missile's own event — never a second one.
  if (!wreck && death.cause !== "missile") {
    offerCityEvent(room, "death", death.victimId, now);
  }
  creditMedals(room, death, now);
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
 * geometry agrees, else it is an ordinary crash. */
function handleCrash(client: Client, wreckId: unknown, now: number): void {
  const credit = roomWrecks(client.room).creditFor(
    client.id,
    wreckId,
    client.pose.pos,
    now,
  );
  const death = credit
    ? combat.wreckKill(client.id, credit.shooterId, now)
    : combat.crash(client.id, now);
  if (!death) return;
  deathBlast(client.room, client.id);
  sendDeath(client.room, death, now);
}

/** Kill-cams that just ended: place each player (human or bot) near, not
 * in front of, living enemies, reset their on-record pose, and announce the respawn. */
function issueRespawns(due: string[], now: number): void {
  for (const id of due) {
    const room = rooms.roomOf(id);
    if (!room) continue;
    const enemies = livingEnemies(room, id);
    let spawn: SpawnState;
    if (room.members.get(id)?.isBot) {
      // Bots respawn down in a street (B1); humans keep the high spawn.
      const bots = botsFor(room);
      spawn = pickBotRespawn(enemies, (pos, yaw) =>
        bots.spawnClear(pos, yaw, now),
      );
      combat.respawned(id, now);
      bots.respawn(id, spawn);
    } else {
      spawn = pickRespawn(enemies);
      const client = clients.get(id);
      if (!client) continue;
      combat.respawned(id, now);
      resetOnRecord(client, spawn, now);
    }
    missilesFor(room).director.noteSpawn(id, spawn.pos, now);
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
    const spawn = pickRespawn(livingEnemies(client.room, client.id));
    combat.returned(client.id, now);
    resetOnRecord(client, spawn, now);
    missilesFor(client.room).director.noteSpawn(client.id, spawn.pos, now);
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
  const contacts: BotContact[] = [];
  for (const member of room.members.values()) {
    const pose = memberPose(room, member.id);
    if (!pose) continue;
    contacts.push({
      id: member.id,
      pos: pose.pos,
      vel: member.isBot
        ? (bots.contactOf(member.id)?.vel ?? { x: 0, y: 0, z: 0 })
        : poseVelocity(pose),
      prot: combat.isProtected(member.id, now),
    });
  }

  const { shots, hits, crashes } = bots.tick(now, contacts);

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
    ...crashes.map((id) => ({ id, death: combat.crash(id, now) })),
    ...struck.map(({ id, shooterId }) => {
      const death = combat.wreckKill(id, shooterId, now);
      if (death) bots.setDead(id);
      return { id, death };
    }),
  ];

  for (const { id, death } of deaths) {
    if (!death) continue;
    deathBlast(room, id);
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
    if (rc) applyShotDamage(rc, shot.origin, shot.dir);
    // Same cosmetic path as human fire: everyone renders the tracer.
    sendToRoom(room, { type: "fired", id: shot.botId });
    offerCityEvent(room, "gunfire", shot.botId, now);
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
    });
  }
  const launched = rm.director.tick(now, planes, {
    nearBuilding: rm.near,
    index: rm.index,
    buildings: rc.buildings,
    destroyedShare:
      rc.damage.destroyedCount / Math.max(1, rc.damage.chunkCount),
  });
  if (launched) {
    sendToRoom(room, { type: "missile", m: encodeMissile(launched) });
  }
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
  if (rc) applyMissileImpact(rc, m);
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
  for (const victim of rm.director.blastVictims(m, planes, now)) {
    const hit = combat.environmentDamage(victim.id, victim.damage, now);
    if (!hit) continue;
    const isBot = room.members.get(victim.id)?.isBot ?? false;
    sendToRoom(room, {
      type: "damage",
      targetId: victim.id,
      shooterId: MISSILE_SHOOTER_ID,
      hp: hit.hp,
      from: m.to,
    });
    if (isBot) botsFor(room).onDamaged(victim.id, now);
    if (!hit.death) continue;
    rm.director.forget(victim.id);
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
        cityEvents: cityEvents.roomIds(),
        roomMoversById: [...roomMoversById.keys()],
        pendingKillByRoom: [...pendingKillByRoom.keys()],
        roomCityById: [...roomCityById.keys()],
        missilesByRoom: [...missilesByRoom.keys()],
        wrecksByRoom: [...wrecksByRoom.keys()],
      }),
    );
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
      const resumed = takeResume(msg.resume);
      joinedId = resumed?.id ?? randomUUID();
      client = handleJoin(
        ws,
        msg.name,
        joinedId,
        resumed && { record: resumed.record, token: msg.resume as string },
      );
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
      if (msg.type === "setBots") handleSetBots(client, msg.count, now);
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
    } else if (msg.type === "crash") {
      handleCrash(client, msg.wreck, now);
    } else if (msg.type === "setBots") {
      handleSetBots(client, msg.count, now);
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
  for (const client of clients.values()) settleAway(client, time);
  issueRespawns(combat.tick(time).respawnsDue, time);
  for (const room of rooms.rooms) {
    tickRoomBots(room, time);
    enforceStormCeiling(room, time);
    updateNewsHeli(room, time);
    landWrecks(room, time); // D4: before the batch — its chunks ride along
    tickMissiles(room, time);
    // D2: everything that broke this tick, as ONE batch.
    const broke = roomCityById.get(room.id)?.damage.takeDestroyed();
    if (broke && broke.length > 0) {
      sendToRoom(room, { type: "chunks", d: encodeChunkIds(broke) });
    }
    const snapshot: WireSnapshotMsg = {
      type: "snapshot",
      time,
      // Dead planes are simply absent until their respawn is announced.
      p: [...room.members.values()].flatMap(({ id }) => {
        const pose = memberPose(room, id);
        return pose
          ? [
              encodeSnapshotEntry({
                id,
                pose,
                hp: combat.hpOf(id),
                prot: combat.isProtected(id, time),
                age: poseAgeOf(id, time),
              }),
            ]
          : [];
      }),
    };
    sendToRoom(room, snapshot);
  }
}

// Drift-compensating scheduler rather than setInterval: a tick that overruns
// pushes the NEXT one earlier, so the mean cadence really is TICK_DOWN_HZ.
// With a plain interval the bot sim's own cost stretched the observed gap well
// past nominal — and a faster tick you don't actually deliver is not a faster
// tick. BOT_DT assumes this cadence too, so the drift was slowing bots down.
const TICK_MS = 1000 / TICK_DOWN_HZ;
let nextTickAt = Date.now();
const scheduleTick = (): void => {
  nextTickAt += TICK_MS;
  // A long stall (debugger, GC pause) must not queue a burst of catch-up
  // ticks: skip straight to the next deadline in the future.
  const now = Date.now();
  if (nextTickAt < now) nextTickAt = now + TICK_MS;
  setTimeout(
    () => {
      tick();
      scheduleTick();
    },
    Math.max(0, nextTickAt - now),
  );
};
scheduleTick();

// S3: generate (and log) the city's stunt courses before the first join.
courseSetFor(CITY_SEED);

// The standing arena: bots fly the first room even before anyone joins, so
// the first joiner drops into a live dogfight instead of an empty sky.
syncRoomBots(rooms.ensureRoom());

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
        : now - client.lastMsgAt > LIVENESS_TIMEOUT_MS;
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
