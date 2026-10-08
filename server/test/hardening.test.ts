// S1 server hardening against a dedicated server process: sockets that never
// join are dropped at the join deadline, and a room that dies frees every
// per-room map it held (read back through the test-only /debug/rooms route).
// Its own process — not wire.test.ts's — because it kills the arena room.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServerMsg, WelcomeMsg } from "@angels-bandits/common/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** Short, so the test is fast; well under LIVENESS_TIMEOUT_MS too. */
const JOIN_DEADLINE = 500;

let child: ChildProcess;
let port: string;

beforeAll(async () => {
  child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: {
      ...process.env,
      PORT: "0",
      JOIN_DEADLINE_MS: String(JOIN_DEADLINE),
      AB_DEBUG_ROOMS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server never announced a port")),
      25000,
    );
    child.stdout?.on("data", (buf: Buffer) => {
      const found = /listening on :(\d+)/.exec(buf.toString())?.[1];
      if (!found) return;
      clearTimeout(timer);
      resolve(found);
    });
  });
}, 30000);

afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
});

interface Peer {
  ws: WebSocket;
  welcome: WelcomeMsg;
  seen: ServerMsg[];
}

function connect(name: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const seen: ServerMsg[] = [];
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name })));
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.type !== "snapshot") seen.push(msg);
      if (msg.type === "welcome") resolve({ ws, welcome: msg, seen });
    });
  });
}

const closed = (ws: WebSocket): Promise<void> =>
  ws.readyState === WebSocket.CLOSED
    ? Promise.resolve()
    : new Promise((r) => ws.once("close", () => r()));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RoomMaps {
  rooms: string[];
  botsByRoom: string[];
  cityEvents: string[];
  roomMoversById: string[];
  pendingKillByRoom: string[];
}
const roomMaps = async (): Promise<RoomMaps> =>
  (await (
    await fetch(`http://127.0.0.1:${port}/debug/rooms`)
  ).json()) as RoomMaps;

/** Every per-room map that holds `roomId`. */
const holding = (maps: RoomMaps, roomId: string): string[] =>
  (
    ["botsByRoom", "cityEvents", "roomMoversById", "pendingKillByRoom"] as const
  ).filter((k) => maps[k].includes(roomId));

describe("join deadline", () => {
  it("terminates a socket that never joins, and leaves a joined one alone", async () => {
    const peer = await connect("Joined");
    const silent = new WebSocket(`ws://127.0.0.1:${port}`);
    const openedAt = await new Promise<number>((resolve, reject) => {
      silent.on("error", reject);
      silent.on("open", () => resolve(Date.now()));
    });
    // The joined control keeps streaming like a real client, so only the
    // join deadline — never the liveness sweep — can explain a close.
    const pose = {
      pos: peer.welcome.spawn.pos,
      quat: { x: 0, y: 0, z: 0, w: 1 },
      speed: peer.welcome.spawn.speed,
    };
    const stream = setInterval(
      () => peer.ws.send(JSON.stringify({ type: "pose", pose })),
      50,
    );
    await closed(silent);
    const after = Date.now() - openedAt;
    expect(after).toBeGreaterThanOrEqual(JOIN_DEADLINE - 50);
    expect(after).toBeLessThan(JOIN_DEADLINE + 2000);
    await wait(300);
    clearInterval(stream);
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    peer.ws.close();
    await closed(peer.ws);
  }, 20000);
});

describe("room disposal", () => {
  it("frees every per-room map when the last human leaves a 0-bot room, and never touches a live arena", async () => {
    const a = await connect("Alone");
    const doomed = a.welcome.roomId;
    expect(a.welcome.roster.some((r) => r.isBot)).toBe(true);

    a.ws.send(JSON.stringify({ type: "setBots", count: 0 }));
    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      a.seen.filter((m) => m.type === "playerLeft").length <
        a.welcome.roster.filter((r) => r.isBot).length
    ) {
      await wait(50);
    }
    expect((await roomMaps()).botsByRoom).toContain(doomed);

    a.ws.close();
    await closed(a.ws);
    await wait(200);
    let maps = await roomMaps();
    expect(maps.rooms).not.toContain(doomed);
    expect(holding(maps, doomed)).toEqual([]);
    // …and nothing in the tick lazily re-creates it.
    await wait(500);
    expect(holding(await roomMaps(), doomed)).toEqual([]);

    // The next joiner starts a fresh standing room, which flies bots.
    const b = await connect("Next");
    const arena = b.welcome.roomId;
    expect(arena).not.toBe(doomed);
    // Its bots take their seats right after the welcome.
    await wait(300);
    expect(
      b.seen.some((m) => m.type === "playerJoined" && m.player.isBot),
    ).toBe(true);
    b.ws.close();
    await closed(b.ws);
    await wait(500);
    maps = await roomMaps();
    expect(maps.rooms).toContain(arena);
    expect(maps.botsByRoom).toContain(arena);
    expect(maps.roomMoversById).toContain(arena);
  }, 20000);
});
