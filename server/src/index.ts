// The Angels & Bandits server: one Node process serving /healthz, the built
// client statics (production), and the ws presence rooms. Movement stays
// client-authoritative (PLAN.md authority split) — this process never runs the
// flight sim; it clamps pose claims via validatePose and relays snapshots.

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  LIVENESS_TIMEOUT_MS,
  MAX_HP,
  NAME_MAX_LENGTH,
  RESPAWN_ALTITUDE,
  RESPAWN_SPEED,
  TICK_DOWN_HZ,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import type {
  ClientMsg,
  Pose,
  ServerMsg,
  SnapshotMsg,
  SpawnState,
} from "@angels-bandits/common/protocol";
import { type WebSocket, WebSocketServer } from "ws";
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

const randomSpawn = (): SpawnState => ({
  pos: {
    x: Math.random() * WORLD_SIZE,
    y: RESPAWN_ALTITUDE,
    z: Math.random() * WORLD_SIZE,
  },
  yaw: Math.random() * Math.PI * 2,
  speed: RESPAWN_SPEED,
});

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
  const spawn = randomSpawn();
  const now = Date.now();
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
    scores: [],
  };
  ws.send(JSON.stringify(welcome));
  sendToRoom(room, { type: "playerJoined", player: { id, name } }, id);
  return client;
}

function handlePose(client: Client, pose: Pose, now: number): void {
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
  const room = rooms.leave(client.id);
  if (room) sendToRoom(room, { type: "playerLeft", id: client.id });
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
    }
  });

  ws.on("close", () => {
    if (client) handleLeave(client);
    client = null;
  });
  ws.on("error", () => ws.terminate());
});

// --- Snapshots down at TICK_DOWN_HZ, one stringify per room ---
setInterval(() => {
  const time = Date.now();
  for (const room of rooms.rooms) {
    const snapshot: SnapshotMsg = {
      type: "snapshot",
      time,
      players: [...room.members.values()].flatMap(({ id }) => {
        const member = clients.get(id);
        return member
          ? [{ id, pose: member.pose, hp: MAX_HP, prot: false }]
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
