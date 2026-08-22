// The Angels & Bandits server: one Node process serving /healthz, the built
// client statics (production), and the ws presence rooms. HUMAN movement stays
// client-authoritative (PLAN.md authority split) — pose claims are clamped via
// validatePose and relayed in snapshots. The one flight sim this process DOES
// run is the backfill bots (B1): RoomBots advances them with the shared
// stepFlight inside the same 15 Hz snapshot tick.

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { generateCity } from "@angels-bandits/common/city";
import {
  CITY_SEED,
  LIVENESS_TIMEOUT_MS,
  NAME_MAX_LENGTH,
  SPAWN_PROTECTION_MS,
  TICK_DOWN_HZ,
} from "@angels-bandits/common/constants";
import type {
  ClientMsg,
  Pose,
  ServerMsg,
  SnapshotMsg,
  SpawnState,
} from "@angels-bandits/common/protocol";
import type { Vec3 } from "@angels-bandits/common/world";
import { type WebSocket, WebSocketServer } from "ws";
import { type BotContact, RoomBots, applyBotFire, poseVelocity } from "./bots";
import { Combat } from "./combat";
import { pickRespawn } from "./respawn";
import { type Room, RoomManager } from "./room";
import { createStaticHandler } from "./statics";
import { StormCeiling } from "./storm";
import { poseFromSpawn, validatePose } from "./validate";

const PORT = Number(process.env.PORT ?? 8080);

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
  lastMsgAt: number;
  lastPoseAt: number;
  rejectStreak: number;
}

const rooms = new RoomManager();
const clients = new Map<string, Client>();
/** Server-authoritative combat state (HP/kills/respawns). Keyed by the same
 * globally-unique player ids as `clients`; hit claims are gated to one room.
 * Bots are registered here too — identical rules, no special cases. */
const combat = new Combat();
/** The hidden death ceiling (ST1): continuous-time-above-600 m bookkeeping.
 * Nothing about it is ever sent to clients — only the resulting death. */
const storm = new StormCeiling();

/** The seeded city, generated once — bot collision probes fly against the
 * exact Building[] every client renders and collides with. */
const city = generateCity(CITY_SEED);

/** Per-room bot pilots. Created lazily; seeded from the room's number so
 * bot behavior is deterministic per room. */
const botsByRoom = new Map<string, RoomBots>();
const botsFor = (room: Room): RoomBots => {
  let bots = botsByRoom.get(room.id);
  if (!bots) {
    const n = Number(room.id.split("-")[1] ?? 0);
    bots = new RoomBots(room.id, CITY_SEED ^ (n * 0x9e3779b9), city);
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
  return clients.get(id)?.pose ?? null;
};

/** On-record positions of living roommates other than `exceptId` — the
 * enemies a farthest-from-enemies spawn keeps away from. */
const livingEnemyPositions = (room: Room, exceptId: string): Vec3[] => {
  const positions: Vec3[] = [];
  for (const { id } of room.members.values()) {
    if (id === exceptId) continue;
    const pose = memberPose(room, id);
    if (pose) positions.push(pose.pos);
  }
  return positions;
};

/** Sync a room's bot population to the backfill target: spawn/despawn bots,
 * mirror them into the roster + Combat, and announce like any player. */
function syncRoomBots(room: Room): void {
  const bots = botsFor(room);
  const now = Date.now();
  const { spawned, despawned } = bots.syncTo(rooms.desiredBots(room), () =>
    pickRespawn(livingEnemyPositions(room, "")),
  );
  for (const entry of spawned) {
    rooms.addBot(room, entry.id, entry.name);
    combat.addPlayer(entry.id, now);
    sendToRoom(room, { type: "playerJoined", player: entry });
  }
  for (const id of despawned) {
    combat.removePlayer(id);
    storm.forget(id);
    rooms.leave(id);
    sendToRoom(room, { type: "playerLeft", id });
  }
  // A wound-down room (no humans, no bots) is gone — drop its pilots too.
  if (!rooms.rooms.includes(room)) botsByRoom.delete(room.id);
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

function handleJoin(ws: WebSocket, rawName: unknown): Client {
  const id = randomUUID();
  const name = sanitizeName(rawName);
  const room = rooms.join(id, name);
  const now = Date.now();
  combat.addPlayer(id, now);
  // Joiners get the same farthest-from-enemies placement as respawns.
  const spawn = pickRespawn(livingEnemyPositions(room, id));
  const client: Client = {
    id,
    name,
    ws,
    room,
    pose: poseFromSpawn(spawn),
    lastMsgAt: now,
    lastPoseAt: now,
    rejectStreak: 0,
  };
  clients.set(id, client);

  const welcome: ServerMsg = {
    type: "welcome",
    id,
    roomId: room.id,
    seed: room.seed,
    spawn,
    roster: room.roster(),
    scores: room.roster().map(({ id: rid }) => combat.scoreOf(rid)),
    botTarget: room.botTarget,
  };
  ws.send(JSON.stringify(welcome));
  sendToRoom(room, { type: "playerJoined", player: { id, name } }, id);
  // The human takes a seat: one bot yields (idle first) after the welcome so
  // the joiner sees a consistent roster then a normal playerLeft.
  syncRoomBots(room);
  return client;
}

function handlePose(client: Client, pose: Pose, now: number): void {
  // A dead plane has no pose: the client freezes for the kill-cam and the
  // respawn will reset the on-record pose server-side.
  if (!combat.isAlive(client.id)) return;
  // dt from wall time between claims, bounded: a hidden tab that resumes may
  // legally have moved far; a spammed socket must not shrink the bound to 0.
  const dt = Math.min(Math.max((now - client.lastPoseAt) / 1000, 0.02), 1);
  client.lastPoseAt = now;
  const verdict = validatePose(client.pose, pose, dt);
  if (verdict.ok) {
    client.pose = verdict.pose;
    client.rejectStreak = 0;
    return;
  }
  client.rejectStreak++;
  if (client.rejectStreak >= RESYNC_AFTER_REJECTS) {
    // Persistent disagreement = a real discontinuity (client respawn), not
    // jitter. Re-sync to the claim rather than freezing the plane forever.
    const resync = validatePose(pose, pose, dt);
    if (resync.ok) {
      client.pose = resync.pose;
      client.rejectStreak = 0;
    }
  }
}

function handleLeave(client: Client): void {
  clients.delete(client.id);
  combat.removePlayer(client.id);
  storm.forget(client.id);
  const room = rooms.leave(client.id);
  if (room) {
    sendToRoom(room, { type: "playerLeft", id: client.id });
    // Refill the vacated seat (or wind the bots down if the room is done).
    if (rooms.rooms.includes(room)) syncRoomBots(room);
  }
}

/** Room-scoped scoreboard broadcast (after any death changes the tallies). */
function broadcastScores(room: Room): void {
  sendToRoom(room, {
    type: "score",
    scores: room.roster().map(({ id }) => combat.scoreOf(id)),
  });
}

function handleFire(client: Client, seq: unknown, now: number): void {
  if (typeof seq !== "number" || !Number.isFinite(seq)) return;
  const verdict = combat.fire(client.id, seq, now);
  // Others render the muzzle flash/tracer; the shooter already did (favor
  // the shooter — a rejected shot just doesn't exist to anyone else).
  if (verdict.ok) {
    sendToRoom(client.room, { type: "fired", id: client.id }, client.id);
  }
}

function handleHitClaim(
  client: Client,
  msg: { targetId?: unknown; bulletOrigin?: unknown; seq?: unknown },
  now: number,
): void {
  const { targetId, bulletOrigin, seq } = msg;
  if (typeof targetId !== "string" || typeof seq !== "number") return;
  const origin = bulletOrigin as Vec3 | undefined;
  if (
    !origin ||
    !Number.isFinite(origin.x) ||
    !Number.isFinite(origin.y) ||
    !Number.isFinite(origin.z)
  ) {
    return;
  }
  // Bots are valid targets too: their on-record pose comes from the sim.
  const targetPose = memberPose(client.room, targetId);
  if (!targetPose) return;

  const verdict = combat.hit(
    client.id,
    targetId,
    seq,
    origin,
    client.pose.pos,
    targetPose.pos,
    now,
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
    if (client.room.members.get(targetId)?.isBot) {
      botsFor(client.room).setDead(targetId);
    }
    sendToRoom(client.room, {
      type: "death",
      victimId: verdict.death.victimId,
      killerId: verdict.death.killerId,
      cause: verdict.death.cause,
    });
    broadcastScores(client.room);
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

function handleCrash(client: Client, now: number): void {
  const death = combat.crash(client.id, now);
  if (!death) return;
  sendToRoom(client.room, {
    type: "death",
    victimId: death.victimId,
    killerId: death.killerId,
    cause: death.cause,
  });
  broadcastScores(client.room);
}

/** Kill-cams that just ended: place each player (human or bot) far from
 * living enemies, reset their on-record pose, and announce the respawn. */
function issueRespawns(due: string[], now: number): void {
  for (const id of due) {
    const room = rooms.roomOf(id);
    if (!room) continue;
    const spawn: SpawnState = pickRespawn(livingEnemyPositions(room, id));
    if (room.members.get(id)?.isBot) {
      combat.respawned(id, now);
      botsFor(room).respawn(id, spawn);
    } else {
      const client = clients.get(id);
      if (!client) continue;
      combat.respawned(id, now);
      client.pose = poseFromSpawn(spawn);
      client.rejectStreak = 0;
      client.lastPoseAt = now;
    }
    sendToRoom(room, {
      type: "respawn",
      id,
      spawn,
      protectedUntil: now + SPAWN_PROTECTION_MS,
    });
  }
}

/** One bot sim step for a room: build the coherent contact list, advance the
 * pilots, settle crashes, and route trigger pulls through Combat — reusing
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

  const { shots, crashes } = bots.tick(now, contacts);

  for (const id of crashes) {
    const death = combat.crash(id, now);
    if (!death) continue;
    sendToRoom(room, {
      type: "death",
      victimId: death.victimId,
      killerId: death.killerId,
      cause: death.cause,
    });
    broadcastScores(room);
  }

  for (const shot of shots) {
    if (!combat.isAlive(shot.botId)) continue;
    const targetPose = memberPose(room, shot.targetId);
    const { accepted, hit } = applyBotFire(
      combat,
      shot,
      targetPose?.pos ?? null,
      now,
    );
    if (!accepted) continue;
    // Same cosmetic path as human fire: everyone renders the tracer.
    sendToRoom(room, { type: "fired", id: shot.botId });
    if (!hit?.ok) continue;
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
      if (room.members.get(shot.targetId)?.isBot) {
        bots.setDead(shot.targetId);
      }
      sendToRoom(room, {
        type: "death",
        victimId: hit.death.victimId,
        killerId: hit.death.killerId,
        cause: hit.death.cause,
      });
      broadcastScores(room);
    }
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
    sendToRoom(room, {
      type: "death",
      victimId: death.victimId,
      killerId: death.killerId,
      cause: death.cause,
    });
    broadcastScores(room);
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
  if (statics?.(req, res)) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// --- WebSocket rooms ---
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on("connection", (ws) => {
  let client: Client | null = null;

  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString()) as ClientMsg;
    } catch {
      ws.close(1003, "malformed message");
      return;
    }
    const now = Date.now();
    if (client) client.lastMsgAt = now;
    if (msg.type === "join" && !client) {
      client = handleJoin(ws, msg.name);
    } else if (msg.type === "pose" && client && msg.pose) {
      handlePose(client, msg.pose, now);
    } else if (msg.type === "fire" && client) {
      handleFire(client, msg.seq, now);
    } else if (msg.type === "hit" && client) {
      handleHitClaim(client, msg, now);
    } else if (msg.type === "crash" && client) {
      handleCrash(client, now);
    } else if (msg.type === "setBots" && client) {
      handleSetBots(client, msg.count, now);
    }
  });

  ws.on("close", () => {
    if (client) handleLeave(client);
    client = null;
  });
  ws.on("error", () => ws.terminate());
});

// --- Combat + bot sim tick + snapshots at TICK_DOWN_HZ, one stringify per room ---
setInterval(() => {
  const time = Date.now();
  issueRespawns(combat.tick(time).respawnsDue, time);
  for (const room of rooms.rooms) {
    tickRoomBots(room, time);
    enforceStormCeiling(room, time);
    const snapshot: SnapshotMsg = {
      type: "snapshot",
      time,
      // Dead planes are simply absent until their respawn is announced.
      players: [...room.members.values()].flatMap(({ id }) => {
        const pose = memberPose(room, id);
        return pose
          ? [
              {
                id,
                pose,
                hp: combat.hpOf(id),
                prot: combat.isProtected(id, time),
              },
            ]
          : [];
      }),
    };
    sendToRoom(room, snapshot);
  }
}, 1000 / TICK_DOWN_HZ);

// The standing arena: bots fly the first room even before anyone joins, so
// the first joiner drops into a live dogfight instead of an empty sky.
syncRoomBots(rooms.ensureRoom());

// --- Liveness: joined clients stream at TICK_UP_HZ; prolonged silence = gone ---
setInterval(() => {
  const now = Date.now();
  for (const client of clients.values()) {
    if (now - client.lastMsgAt > LIVENESS_TIMEOUT_MS) client.ws.terminate();
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
