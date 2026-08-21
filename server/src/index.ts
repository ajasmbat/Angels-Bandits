// The Angels & Bandits server: one Node process serving /healthz, the built
// client statics (production), and the ws presence rooms. Movement stays
// client-authoritative (PLAN.md authority split) — this process never runs the
// flight sim; it clamps pose claims via validatePose and relays snapshots.

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
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
import { Combat } from "./combat";
import { pickRespawn } from "./respawn";
import { type Room, RoomManager } from "./room";
import { createStaticHandler } from "./statics";
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
 * globally-unique player ids as `clients`; hit claims are gated to one room. */
const combat = new Combat();

/** On-record positions of living roommates other than `exceptId` — the
 * enemies a farthest-from-enemies spawn keeps away from. */
const livingEnemyPositions = (room: Room, exceptId: string): Vec3[] => {
  const positions: Vec3[] = [];
  for (const { id } of room.members.values()) {
    if (id === exceptId || !combat.isAlive(id)) continue;
    const member = clients.get(id);
    if (member) positions.push(member.pose.pos);
  }
  return positions;
};

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
  };
  ws.send(JSON.stringify(welcome));
  sendToRoom(room, { type: "playerJoined", player: { id, name } }, id);
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
  const room = rooms.leave(client.id);
  if (room) sendToRoom(room, { type: "playerLeft", id: client.id });
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
  const target = clients.get(targetId);
  if (!target || !client.room.members.has(targetId)) return;

  const verdict = combat.hit(
    client.id,
    targetId,
    seq,
    origin,
    client.pose.pos,
    target.pose.pos,
    now,
  );
  if (!verdict.ok) return;

  sendToRoom(client.room, {
    type: "damage",
    targetId,
    shooterId: client.id,
    hp: verdict.hp,
  });
  if (verdict.death) {
    sendToRoom(client.room, {
      type: "death",
      victimId: verdict.death.victimId,
      killerId: verdict.death.killerId,
      cause: verdict.death.cause,
    });
    broadcastScores(client.room);
  }
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

/** Kill-cams that just ended: place each player far from living enemies,
 * reset their on-record pose, and announce the respawn to the room. */
function issueRespawns(due: string[], now: number): void {
  for (const id of due) {
    const client = clients.get(id);
    if (!client) continue;
    const spawn: SpawnState = pickRespawn(
      livingEnemyPositions(client.room, id),
    );
    combat.respawned(id, now);
    client.pose = poseFromSpawn(spawn);
    client.rejectStreak = 0;
    client.lastPoseAt = now;
    sendToRoom(client.room, {
      type: "respawn",
      id,
      spawn,
      protectedUntil: now + SPAWN_PROTECTION_MS,
    });
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
    }
  });

  ws.on("close", () => {
    if (client) handleLeave(client);
    client = null;
  });
  ws.on("error", () => ws.terminate());
});

// --- Combat tick + snapshots down at TICK_DOWN_HZ, one stringify per room ---
setInterval(() => {
  const time = Date.now();
  issueRespawns(combat.tick(time).respawnsDue, time);
  for (const room of rooms.rooms) {
    const snapshot: SnapshotMsg = {
      type: "snapshot",
      time,
      // Dead planes are simply absent until their respawn is announced.
      players: [...room.members.values()].flatMap(({ id }) => {
        const member = clients.get(id);
        return member && combat.isAlive(id)
          ? [
              {
                id,
                pose: member.pose,
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

// --- Liveness: joined clients stream at TICK_UP_HZ; prolonged silence = gone ---
setInterval(() => {
  const now = Date.now();
  for (const client of clients.values()) {
    if (now - client.lastMsgAt > LIVENESS_TIMEOUT_MS) client.ws.terminate();
  }
}, 2000);

server.listen(PORT, () => {
  console.log(
    `angels-bandits server listening on :${PORT} (statics: ${statics ? "client/dist" : "dev — use vite"})`,
  );
});
