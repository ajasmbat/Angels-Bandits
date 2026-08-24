// The snapshot wire contract end to end (ANGE-4KO2W2), against a real server
// process: what actually leaves the socket is the QUANTISED tuple form, the
// client's decoder puts back the pose that was streamed up (inside the
// quantisation step), and the cadence really is TICK_DOWN_HZ — a faster tick
// the server does not deliver would be no win at all.
//
// The bandwidth claim in the PR is measured by tools/net-bench.mjs; what is
// asserted here is the contract that measurement rests on.
//
// The server binds PORT=0 and this reads the real port off its startup line,
// so a stale dev server on 8080 can neither collide with these runs nor
// silently answer them.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BOT_TARGET_DEFAULT,
  BULLET_DAMAGE,
  BULLET_RANGE,
  INTERP_FLOOR_MS,
  MAX_HP,
  SNAPSHOT_INTERVAL_MS,
  SPAWN_PROTECTION_MS,
} from "@angels-bandits/common/constants";
import {
  POS_QUANT_ERROR_M,
  decodeSnapshotEntry,
} from "@angels-bandits/common/net";
import type {
  DamageMsg,
  Pose,
  ServerMsg,
  WelcomeMsg,
  WireSnapshotMsg,
} from "@angels-bandits/common/protocol";
import { wrapDistance } from "@angels-bandits/common/world";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

let child: ChildProcess;
let url: string;

interface Peer {
  ws: WebSocket;
  welcome: WelcomeMsg;
  snapshots: { at: number; msg: WireSnapshotMsg }[];
  /** Raw bytes of every snapshot frame received — the wire, not an estimate. */
  snapshotBytes: number;
  /** Everything else the server said, in order. */
  seen: ServerMsg[];
}

function connect(name: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const snapshots: Peer["snapshots"] = [];
    const seen: ServerMsg[] = [];
    const peer: Partial<Peer> = { ws, snapshots, snapshotBytes: 0, seen };
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name })));
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.type !== "snapshot") seen.push(msg);
      if (msg.type === "snapshot") {
        snapshots.push({ at: performance.now(), msg });
        peer.snapshotBytes = (peer.snapshotBytes ?? 0) + data.length;
      }
      if (msg.type === "welcome") {
        peer.welcome = msg;
        resolve(peer as Peer);
      }
    });
  });
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const streamPose = (peer: Peer, pose: Pose): void => {
  peer.ws.send(JSON.stringify({ type: "pose", pose }));
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  child = spawn("npx", ["tsx", entry], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server never announced a port")),
      25000,
    );
    child.stdout?.on("data", (buf: Buffer) => {
      const port = /listening on :(\d+)/.exec(buf.toString())?.[1];
      if (!port) return;
      clearTimeout(timer);
      resolve(`ws://127.0.0.1:${port}`);
    });
  });
}, 30000);

afterAll(() => {
  child?.kill();
});

describe("quantised snapshots over the wire", () => {
  it("sends tuples, not objects, and round-trips the streamed pose within the quantisation step", async () => {
    const peer = await connect("Wire");
    // Start from the server-issued spawn and nudge it by a plausible amount:
    // an outright teleport would be snap-rejected by validatePose and never
    // reach a snapshot at all. The fractional metres are the point — they are
    // exactly what quantisation has to round.
    const pose: Pose = {
      pos: {
        x: peer.welcome.spawn.pos.x + 3.456789,
        y: peer.welcome.spawn.pos.y + 1.6543,
        z: peer.welcome.spawn.pos.z - 2.87654,
      },
      quat: { ...IDENTITY },
      speed: 71.234,
    };
    // Stream it for a few up-ticks so the server has accepted it on record.
    for (let i = 0; i < 6; i++) {
      streamPose(peer, pose);
      await wait(1000 / 20);
    }
    await wait(SNAPSHOT_INTERVAL_MS * 3);

    const last = peer.snapshots[peer.snapshots.length - 1];
    expect(last).toBeDefined();
    if (!last) return;
    // The wire shape: `p`, an array of arrays — no per-plane key names.
    expect(Array.isArray(last.msg.p)).toBe(true);
    expect(last.msg.p.length).toBeGreaterThan(0);
    const self = last.msg.p.find((w) => w[0] === peer.welcome.id);
    expect(self).toBeDefined();
    if (!self) return;
    expect(Array.isArray(self)).toBe(true);
    for (const field of self.slice(1)) {
      expect(Number.isInteger(field)).toBe(true);
    }

    const decoded = decodeSnapshotEntry(self);
    expect(decoded.id).toBe(peer.welcome.id);
    expect(wrapDistance(decoded.pose.pos, pose.pos)).toBeLessThanOrEqual(
      POS_QUANT_ERROR_M,
    );
    expect(decoded.pose.speed).toBeCloseTo(pose.speed, 1);
    expect(decoded.hp).toBe(100);
    peer.ws.close();
  }, 20000);

  it("delivers the cadence it promises — the tick does not drift under the bot sim", async () => {
    const peer = await connect("Cadence");
    // The standing room already flies BOT_TARGET_DEFAULT bots, so the tick is
    // doing real sim work while we time it.
    expect(peer.welcome.botTarget).toBe(BOT_TARGET_DEFAULT);
    peer.snapshots.length = 0;
    await wait(3000);
    const gaps = peer.snapshots
      .slice(1)
      .map((s, i) => s.at - (peer.snapshots[i]?.at ?? s.at));
    expect(gaps.length).toBeGreaterThan(40);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // Within 10% of nominal. A plain setInterval drifted well past this once
    // the bot sim had work to do, which is why the tick self-corrects now.
    expect(mean).toBeGreaterThan(SNAPSHOT_INTERVAL_MS * 0.9);
    expect(mean).toBeLessThan(SNAPSHOT_INTERVAL_MS * 1.1);
    peer.ws.close();
  }, 20000);

  it("costs far less per snapshot than the float-JSON shape it replaces", async () => {
    const peer = await connect("Bytes");
    peer.snapshots.length = 0;
    peer.snapshotBytes = 0;
    await wait(2000);
    expect(peer.snapshots.length).toBeGreaterThan(20);
    const perEntry =
      peer.snapshotBytes /
      peer.snapshots.reduce((n, s) => n + s.msg.p.length, 0);
    // The old shape spelled out pose/pos/quat/speed/hp/prot plus full float
    // text and ran ~240 bytes per plane; the tuple is comfortably under 100.
    expect(perEntry).toBeLessThan(100);
    peer.ws.close();
  }, 20000);
});

describe("hit claims at the new cadence", () => {
  it("a claim that declares its interpolation delay still lands a normal hit", async () => {
    const shooter = await connect("Shooter");
    const target = await connect("Target");

    // Park both planes next to each other. A single jump would be
    // snap-rejected as a teleport, so repeat the claim past
    // RESYNC_AFTER_REJECTS — the same re-sync path a crash respawn uses.
    const at = (x: number, z: number): Pose => ({
      pos: { x, y: 300, z },
      quat: { ...IDENTITY },
      speed: 65,
    });
    for (let i = 0; i < 16; i++) {
      streamPose(shooter, at(1000, 1000));
      streamPose(target, at(1000 + BULLET_RANGE / 2, 1000));
      await wait(1000 / 20);
    }
    // Spawn protection has to lapse before a hit can land at all.
    await wait(SPAWN_PROTECTION_MS);
    for (let i = 0; i < 4; i++) {
      streamPose(shooter, at(1000, 1000));
      streamPose(target, at(1000 + BULLET_RANGE / 2, 1000));
      await wait(1000 / 20);
    }

    target.seen.length = 0;
    shooter.ws.send(JSON.stringify({ type: "fire", seq: 1 }));
    await wait(30);
    shooter.ws.send(
      JSON.stringify({
        type: "hit",
        targetId: target.welcome.id,
        bulletOrigin: { x: 1000, y: 300, z: 1000 },
        seq: 1,
        // Exactly what GameSocket.sendHit now declares.
        delay: INTERP_FLOOR_MS,
      }),
    );
    await wait(SNAPSHOT_INTERVAL_MS * 6);

    const damage = target.seen.find(
      (m): m is DamageMsg =>
        m.type === "damage" && m.targetId === target.welcome.id,
    );
    expect(damage).toBeDefined();
    expect(damage?.shooterId).toBe(shooter.welcome.id);
    expect(damage?.hp).toBe(MAX_HP - BULLET_DAMAGE);

    // …and the damage shows up in the quantised snapshot stream too.
    const last = target.snapshots[target.snapshots.length - 1];
    const self = last?.msg.p.find((w) => w[0] === target.welcome.id);
    expect(self && decodeSnapshotEntry(self).hp).toBe(MAX_HP - BULLET_DAMAGE);

    shooter.ws.close();
    target.ws.close();
  }, 30000);
});
