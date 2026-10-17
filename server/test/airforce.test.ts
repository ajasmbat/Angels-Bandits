// E1 Air force, end to end against a real server process with a staged
// air force (AB_AIRFORCE=240: thirty squadrons in the air at once, off no
// rig) and the carrier war's own waves on (AB_BOSS_FAST):
//
//  - interest management: each client's snapshot carries only what is
//    within half the world of IT — two pilots apart get different rows —
//    the squadrons as rows, the enemies near it at full rate and the ones
//    past the near tier at 5 Hz;
//  - every plane a row stands for is a roster member (ids counted up from
//    slot 0's), and a LATE JOINER's welcome names the whole air force and
//    its first snapshots carry it;
//  - a client's wire stays far under the 250 KB/s budget.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  IM_FAR_M,
  IM_MID_EVERY,
  IM_NEAR_M,
} from "@angels-bandits/common/interest";
import { decodeSnapshotEntry } from "@angels-bandits/common/net";
import type {
  Pose,
  ServerMsg,
  WelcomeMsg,
  WireSnapshotMsg,
} from "@angels-bandits/common/protocol";
import {
  FORM_REACH,
  SQUAD_SIZE,
  decodeSquadRow,
  squadMemberId,
} from "@angels-bandits/common/squadron";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const STAGED = 240;

let child: ChildProcess;
let url: string;

interface Peer {
  ws: WebSocket;
  welcome: WelcomeMsg;
  snapshots: { at: number; msg: WireSnapshotMsg; bytes: number }[];
  /** Every enemy the roster named (welcome + playerJoined − playerLeft). */
  roster: Set<string>;
  at: Pose;
  stop: () => void;
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Join and hold the spawn pose (streaming at TICK_UP_HZ: in the air). */
function join(name: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const peer: Partial<Peer> = { ws, snapshots: [], roster: new Set() };
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name })));
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.type === "snapshot") {
        peer.snapshots?.push({
          at: performance.now(),
          msg,
          bytes: data.length,
        });
      } else if (msg.type === "playerJoined" && msg.player.isBot) {
        peer.roster?.add(msg.player.id);
      } else if (msg.type === "playerLeft") {
        peer.roster?.delete(msg.id);
      } else if (msg.type === "welcome") {
        peer.welcome = msg;
        for (const r of msg.roster) if (r.isBot) peer.roster?.add(r.id);
        const at: Pose = { ...msg.spawn, quat: { ...IDENTITY } };
        peer.at = at;
        const timer = setInterval(
          () => ws.send(JSON.stringify({ type: "pose", pose: at })),
          50,
        );
        peer.stop = () => {
          clearInterval(timer);
          ws.close();
        };
        resolve(peer as Peer);
      }
    });
  });
}

/** Every plane a snapshot carries: its own entries and its rows' planes. */
function planesOf(msg: WireSnapshotMsg): { id: string; pos: Vec3 }[] {
  const out = msg.p.map((w) => {
    const e = decodeSnapshotEntry(w);
    return { id: e.id, pos: e.pose.pos };
  });
  for (const row of msg.s ?? []) {
    const r = decodeSquadRow(row);
    for (let k = 0; k < SQUAD_SIZE; k++) {
      if (r.mask & (1 << k))
        out.push({ id: squadMemberId(r.id0, k), pos: r.anchor.pos });
    }
  }
  return out;
}

beforeAll(async () => {
  child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: {
      ...process.env,
      PORT: "0",
      AB_BOSS_FAST: "1",
      AB_AIRFORCE: String(STAGED),
      LIVENESS_TIMEOUT_MS: "60000",
    },
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

describe("E1 air force over the wire", () => {
  let a: Peer;
  let b: Peer;
  let late: Peer;
  beforeAll(async () => {
    a = await join("Alpha");
    b = await join("Bravo");
    // The staged air force goes up as soon as someone flies (8 squadrons a
    // tick); then let it fly and both pilots' snapshots pile up.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const last = a.snapshots.at(-1)?.msg;
      if (last && (last.s?.length ?? 0) > 0 && a.roster.size >= STAGED) break;
      await wait(100);
    }
    await wait(1500);
    a.snapshots.length = 0;
    b.snapshots.length = 0;
    late = await join("Latecomer");
    await wait(3000);
  }, 60_000);

  afterAll(() => {
    a?.stop();
    b?.stop();
    late?.stop();
  });

  it("sends the squadrons as rows, every plane of them a roster member", () => {
    const rows = a.snapshots.flatMap((s) => s.msg.s ?? []);
    expect(rows.length).toBeGreaterThan(20);
    for (const s of a.snapshots) {
      for (const p of planesOf(s.msg)) {
        if (p.id.startsWith("bot:")) expect(a.roster.has(p.id)).toBe(true);
      }
    }
    expect(a.roster.size).toBeGreaterThanOrEqual(STAGED);
  });

  it("gives each pilot only what is within half the world of it, and two pilots apart different rows", () => {
    for (const peer of [a, b]) {
      for (const s of peer.snapshots) {
        for (const row of s.msg.s ?? []) {
          const r = decodeSquadRow(row);
          expect(
            wrapDistance(r.anchor.pos, peer.at.pos) - FORM_REACH,
          ).toBeLessThanOrEqual(IM_FAR_M + 1);
        }
        for (const w of s.msg.p) {
          const e = decodeSnapshotEntry(w);
          if (!e.id.startsWith("bot:")) continue;
          expect(wrapDistance(e.pose.pos, peer.at.pos)).toBeLessThanOrEqual(
            IM_FAR_M + 1,
          );
        }
      }
    }
    if (wrapDistance(a.at.pos, b.at.pos) > 300) {
      const idsOf = (peer: Peer) =>
        new Set(
          peer.snapshots.flatMap((s) => (s.msg.s ?? []).map((r) => r[0])),
        );
      const sa = idsOf(a);
      const sb = idsOf(b);
      const same = [...sa].filter((id) => sb.has(id)).length;
      expect(same).toBeLessThan(Math.max(sa.size, sb.size));
    }
  });

  it("sends a near squadron every tick and a mid one at 5 Hz", () => {
    const seen = new Map<string, { n: number; near: number; mid: number }>();
    for (const s of a.snapshots) {
      for (const row of s.msg.s ?? []) {
        const r = decodeSquadRow(row);
        const d = wrapDistance(r.anchor.pos, a.at.pos) - FORM_REACH;
        const x = seen.get(r.id0) ?? { n: 0, near: 0, mid: 0 };
        x.n++;
        if (d <= IM_NEAR_M - 50) x.near++;
        else if (d > IM_NEAR_M + 50) x.mid++;
        seen.set(r.id0, x);
      }
    }
    const ticks = a.snapshots.length;
    expect(ticks).toBeGreaterThan(40);
    const near = [...seen.values()].filter((x) => x.near === x.n && x.n > 0);
    const mid = [...seen.values()].filter((x) => x.mid === x.n && x.n > 0);
    expect(near.length).toBeGreaterThan(0);
    // A squadron that stayed near rode (almost) every snapshot…
    expect(Math.max(...near.map((x) => x.n))).toBeGreaterThan(ticks * 0.9);
    // …one that stayed mid about one in IM_MID_EVERY.
    if (mid.length > 0) {
      for (const x of mid) {
        expect(x.n).toBeLessThanOrEqual(Math.ceil(ticks / IM_MID_EVERY) + 1);
      }
    }
  });

  it("names the whole air force to a late joiner, whose first snapshots carry it", () => {
    expect(
      late.welcome.roster.filter((r) => r.isBot).length,
    ).toBeGreaterThanOrEqual(STAGED);
    expect(late.welcome.proto).toBe(2);
    const first = late.snapshots.slice(0, IM_MID_EVERY + 2);
    expect(first.some((s) => (s.msg.s?.length ?? 0) > 0)).toBe(true);
    for (const s of late.snapshots) {
      for (const p of planesOf(s.msg)) {
        if (p.id.startsWith("bot:")) expect(late.roster.has(p.id)).toBe(true);
      }
    }
  });

  it("keeps each pilot's snapshots far under 250 KB/s", () => {
    for (const peer of [a, b]) {
      const s = peer.snapshots;
      const secs = ((s.at(-1)?.at ?? 0) - (s[0]?.at ?? 0)) / 1000;
      const bytes = s.reduce((n, x) => n + x.bytes, 0);
      expect(secs).toBeGreaterThan(2);
      expect(bytes / secs).toBeLessThan(250_000);
    }
  });
});
