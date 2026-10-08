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
  POSE_AGE_MAX_MS,
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
  // node itself (tsx as a loader), not `npx tsx`: kill() in afterAll must
  // reach the server, or it outlives the test and keeps flying its bots.
  child = spawn(process.execPath, ["--import", "tsx", entry], {
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

describe("pose timestamps (O2)", () => {
  /** Stream `pose` stamped by `stamp(now)` for `n` up-ticks; returns the
   * stamps actually sent, with the local send time of each. */
  const streamStamped = async (
    peer: Peer,
    pose: Pose,
    n: number,
    stamp: (now: number) => number | undefined,
  ): Promise<{ t: number | undefined; sentAt: number }[]> => {
    const sent: { t: number | undefined; sentAt: number }[] = [];
    for (let i = 0; i < n; i++) {
      const sentAt = Date.now();
      const t = stamp(sentAt);
      peer.ws.send(JSON.stringify({ type: "pose", pose, t }));
      sent.push({ t, sentAt });
      await wait(1000 / 30);
    }
    return sent;
  };

  /** The decoded self entries of every snapshot received since `from`, with
   * the pose time each one claims (snapshot time − age). */
  const selfTimes = (peer: Peer, from: number) =>
    peer.snapshots.slice(from).flatMap(({ msg }) => {
      const w = msg.p.find((e) => e[0] === peer.welcome.id);
      if (!w) return [];
      const d = decodeSnapshotEntry(w);
      return [
        {
          snapTime: msg.time,
          poseTime: msg.time - (d.age ?? 0),
          age: d.age ?? 0,
        },
      ];
    });

  const parked = (peer: Peer): Pose => ({
    pos: { ...peer.welcome.spawn.pos },
    quat: { ...IDENTITY },
    speed: peer.welcome.spawn.speed,
  });

  it("stamps each snapshot entry with the pose's own time, not the tick's", async () => {
    const peer = await connect("Stamped");
    const pose = parked(peer);
    await streamStamped(peer, pose, 4, (now) => now - 37); // settle on record
    const from = peer.snapshots.length;
    // Same machine, same Date.now(): these stamps are exact server times,
    // 37 ms before each send — well inside the trusted window.
    const sent = await streamStamped(peer, pose, 30, (now) => now - 37);
    await wait(SNAPSHOT_INTERVAL_MS * 2);
    const stamps = new Set(sent.map((s) => s.t));
    const seen = selfTimes(peer, from);
    expect(seen.length).toBeGreaterThan(10);
    for (const { poseTime, age } of seen) {
      expect(stamps.has(poseTime)).toBe(true); // exactly the pose's own t
      expect(age).toBeGreaterThanOrEqual(37); // never the tick's own time
    }
    peer.ws.close();
  }, 20000);

  it("clamps a backdated or future stamp into [arrival − POSE_AGE_MAX_MS, arrival]", async () => {
    const peer = await connect("Clamped");
    const pose = parked(peer);
    await streamStamped(peer, pose, 4, (now) => now);

    let from = peer.snapshots.length;
    const old = await streamStamped(peer, pose, 10, (now) => now - 5000);
    await wait(SNAPSHOT_INTERVAL_MS * 2);
    const firstSent = old[0]?.sentAt ?? 0;
    for (const { poseTime, snapTime } of selfTimes(peer, from)) {
      expect(poseTime).toBeGreaterThanOrEqual(firstSent - POSE_AGE_MAX_MS - 1);
      expect(poseTime).toBeLessThanOrEqual(snapTime);
    }

    from = peer.snapshots.length;
    const future = await streamStamped(peer, pose, 10, (now) => now + 5000);
    await wait(SNAPSHOT_INTERVAL_MS * 2);
    const firstFuture = future[0]?.sentAt ?? 0;
    const seen = selfTimes(peer, from).filter(
      (s) => s.snapTime > firstFuture + 60,
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const { poseTime, snapTime, age } of seen) {
      expect(age).toBeGreaterThanOrEqual(0); // never from the future
      expect(poseTime).toBeLessThanOrEqual(snapTime);
      expect(poseTime).toBeGreaterThanOrEqual(firstFuture);
    }

    // No stamp at all (a client before its first snapshot): arrival time.
    from = peer.snapshots.length;
    const bare = await streamStamped(peer, pose, 10, () => undefined);
    await wait(SNAPSHOT_INTERVAL_MS * 2);
    const firstBare = bare[0]?.sentAt ?? 0;
    for (const { poseTime, snapTime } of selfTimes(peer, from).filter(
      (s) => s.snapTime > firstBare + 60,
    )) {
      expect(poseTime).toBeGreaterThanOrEqual(firstBare);
      expect(poseTime).toBeLessThanOrEqual(snapTime);
    }
    peer.ws.close();
  }, 20000);

  it("leaves bot rows unaged — they keep the pre-O2 tuple length", async () => {
    const peer = await connect("BotRows");
    await wait(SNAPSHOT_INTERVAL_MS * 4);
    const bots = new Set(
      peer.welcome.roster.filter((r) => r.isBot).map((r) => r.id),
    );
    expect(bots.size).toBeGreaterThan(0);
    const rows = peer.snapshots.flatMap(({ msg }) =>
      msg.p.filter((e) => bots.has(e[0])),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(11);
      expect(decodeSnapshotEntry(row).age).toBe(0);
    }
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
    // Spawn protection has to lapse before a hit can land at all. Keep
    // streaming at the uplink rate meanwhile, as a real client does: since F4
    // raised protection to 5.5 s, a silent wait outlasts LIVENESS_TIMEOUT_MS
    // and the server drops both sockets before the shot.
    const protectionEnds = Date.now() + SPAWN_PROTECTION_MS;
    while (Date.now() < protectionEnds) {
      streamPose(shooter, at(1000, 1000));
      streamPose(target, at(1000 + BULLET_RANGE / 2, 1000));
      await wait(1000 / 20);
    }
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

describe("malformed messages (S1)", () => {
  /** Open a raw socket, send `payload` without joining, and resolve with the
   * close code the server answers with. */
  const sendUnjoined = (payload: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on("error", reject);
      ws.on("open", () => ws.send(payload));
      ws.on("close", (code) => resolve(code));
    });

  it("closes only the sender on a parsed non-message, and the server keeps serving", async () => {
    for (const payload of ["null", "[]", '"x"', "{}", "42", '{"type":7}']) {
      expect(await sendUnjoined(payload)).toBe(1003);
    }
    expect(child.exitCode).toBeNull();
    const fresh = await connect("AfterJunk");
    expect(fresh.welcome.type).toBe("welcome");
    fresh.ws.close();
  }, 20000);

  it("keeps the test-only /debug/rooms route off unless AB_DEBUG_ROOMS=1", async () => {
    const res = await fetch(`${url.replace("ws://", "http://")}/debug/rooms`);
    expect(res.status).toBe(404);
  });

  it("drops malformed poses and hits from a joined, alive client without crashing", async () => {
    const peer = await connect("Junk");
    const { pos, speed } = peer.welcome.spawn;
    const bad: unknown[] = [
      { type: "pose", pose: {} },
      { type: "pose", pose: 1 },
      { type: "pose", pose: null },
      { type: "pose", pose: { pos: null, quat: IDENTITY, speed } },
      { type: "pose", pose: { pos, speed } },
      { type: "pose", pose: { pos, quat: null, speed } },
      { type: "pose", pose: { pos: { x: "a", y: 1, z: 1 }, quat: IDENTITY } },
      { type: "hit" },
      { type: "hit", targetId: "x", seq: 1, bulletOrigin: null },
      { type: "boost", on: "yes" },
      { type: "fire", seq: "1" },
      { type: "setBots", count: null },
      { type: "join", name: { evil: true } },
    ];
    for (const msg of bad) peer.ws.send(JSON.stringify(msg));
    await wait(SNAPSHOT_INTERVAL_MS * 4);
    expect(child.exitCode).toBeNull();
    // A known type with bad fields is dropped, not punished: still connected.
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);

    const fresh = await connect("AfterBadPose");
    expect(fresh.welcome.type).toBe("welcome");
    peer.ws.close();
    fresh.ws.close();
  }, 20000);
});
