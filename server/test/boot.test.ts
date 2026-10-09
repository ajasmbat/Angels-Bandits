// W1 server side, against a dedicated server process with a short
// BOOT_TIMEOUT_MS: a joined player is PENDING until its first pose — absent
// from everyone's snapshots while its client boots — and one that never
// poses is dropped at the boot deadline counted from its join, however many
// keepalive pings it sends. A control that posed once and then only pings
// survives the same window, so the deadline (not liveness) is what fired.
// Its own process — not hardening.test.ts's — because a short boot timeout
// would also drop that file's peers, which never pose.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  WelcomeMsg,
  WireSnapshotMsg,
} from "@angels-bandits/common/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const BOOT_TIMEOUT = 1000;
/** The liveness sweep runs every 2000 ms (server/src/index.ts). */
const SWEEP_MS = 2000;

let child: ChildProcess;
let port: string;

beforeAll(async () => {
  child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: { ...process.env, PORT: "0", BOOT_TIMEOUT_MS: String(BOOT_TIMEOUT) },
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
  joinedAt: number;
  /** Player ids in every snapshot received, latest last. */
  snapshots: string[][];
}

function connect(name: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const snapshots: string[][] = [];
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name })));
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as
        | WelcomeMsg
        | WireSnapshotMsg
        | { type: string };
      if (msg.type === "snapshot") {
        snapshots.push((msg as WireSnapshotMsg).p.map((e) => e[0]));
      }
      if (msg.type === "welcome") {
        resolve({
          ws,
          welcome: msg as WelcomeMsg,
          joinedAt: Date.now(),
          snapshots,
        });
      }
    });
  });
}

const send = (p: Peer, msg: object) => p.ws.send(JSON.stringify(msg));
const pose = (p: Peer) =>
  send(p, {
    type: "pose",
    pose: {
      pos: p.welcome.spawn.pos,
      quat: { x: 0, y: 0, z: 0, w: 1 },
      speed: p.welcome.spawn.speed,
    },
  });
const closedAt = (ws: WebSocket): Promise<number> =>
  ws.readyState === WebSocket.CLOSED
    ? Promise.resolve(Date.now())
    : new Promise((r) => ws.once("close", () => r(Date.now())));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("W1 boot deadline", () => {
  it("a joiner that only pings is dropped at BOOT_TIMEOUT from its join; one that posed is not", async () => {
    const pinger = await connect("Pinger");
    const control = await connect("Control");
    pose(control); // live: the boot deadline no longer applies
    const keepalive = setInterval(() => {
      for (const p of [pinger, control]) {
        if (p.ws.readyState === WebSocket.OPEN) send(p, { type: "ping" });
      }
    }, 200);
    try {
      const after = (await closedAt(pinger.ws)) - pinger.joinedAt;
      expect(after).toBeGreaterThanOrEqual(BOOT_TIMEOUT - 50);
      expect(after).toBeLessThan(BOOT_TIMEOUT + SWEEP_MS + 1000);
      // The control has now lived through the same window, on pings alone.
      await wait(
        Math.max(0, pinger.joinedAt + BOOT_TIMEOUT + SWEEP_MS - Date.now()),
      );
      expect(control.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      clearInterval(keepalive);
      control.ws.close();
      await closedAt(control.ws);
    }
  }, 15000);
});

describe("W1 pending players", () => {
  it("a booting joiner is absent from snapshots until its first pose", async () => {
    const watcher = await connect("Watcher");
    const stream = setInterval(() => pose(watcher), 50);
    const booting = await connect("Booting");
    try {
      expect(booting.welcome.roomId).toBe(watcher.welcome.roomId);
      const id = booting.welcome.id;
      // Pending (well inside its boot deadline): never in a snapshot.
      await wait(400);
      const seenPending = watcher.snapshots.length;
      expect(seenPending).toBeGreaterThan(2);
      expect(watcher.snapshots.some((s) => s.includes(id))).toBe(false);
      // The watcher itself is in the air.
      expect(watcher.snapshots.at(-1)).toContain(watcher.welcome.id);
      // First pose: live, and in the snapshots from then on.
      pose(booting);
      const live = setInterval(() => pose(booting), 50);
      await wait(400);
      clearInterval(live);
      expect(
        watcher.snapshots.slice(seenPending).some((s) => s.includes(id)),
      ).toBe(true);
    } finally {
      clearInterval(stream);
      for (const p of [watcher, booting]) p.ws.close();
      await Promise.all([closedAt(watcher.ws), closedAt(booting.ws)]);
    }
  }, 15000);
});
