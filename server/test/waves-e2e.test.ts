// W1 Carrier War end to end, against a real server process and one human
// client over a real socket: a fresh room holds no bots; the carrier comes
// for the pilot; every enemy plane is launched off it — its `bossLaunch`
// first, then its `respawn` exactly at that launch's release pose — and the
// enemies close on the human within 15 s of leaving the carrier, shooting
// at it and never at each other.
//
// AB_BOSS_FAST=1 is the QA carrier (2–3 s after the pilot starts flying,
// small HP); everything else is the production game. The pilot holds still
// at its spawn (streaming, so it is in the air) and re-anchors on its own
// respawn if it is shot down.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type BossLaunch,
  type BossRaid,
  decodeLaunch,
  decodeRaid,
  launchSpawnAt,
} from "@angels-bandits/common/boss";
import { decodeSnapshotEntry } from "@angels-bandits/common/net";
import type {
  Pose,
  ServerMsg,
  WelcomeMsg,
} from "@angels-bandits/common/protocol";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
/** "Closing on the human": an enemy this near it, m (3-D, torus-aware) —
 * well inside its detection range, where it is fighting, not patrolling. */
const CLOSE_M = 300;
/** …within this long of leaving the carrier, ms. */
const CLOSE_WITHIN_MS = 15_000;

let child: ChildProcess;
let url: string;

beforeAll(async () => {
  // node itself (tsx as a loader), not `npx tsx`: kill() in afterAll must
  // reach the server, or it outlives the test and keeps flying its enemies.
  child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: { ...process.env, PORT: "0", AB_BOSS_FAST: "1" },
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

interface Run {
  welcome: WelcomeMsg;
  raid: BossRaid | null;
  launches: Map<string, { l: BossLaunch; at: number }>;
  releases: Map<string, { pos: Vec3; yaw: number; at: number }>;
  /** Closest each enemy came to the human within CLOSE_WITHIN_MS of its
   * release, m. */
  closest: Map<string, number>;
  /** Damage messages between two enemy planes (must stay empty). */
  botOnBot: string[];
  /** Damage the enemies did to the human. */
  hitsOnHuman: number;
}

function fly(ms: number): Promise<Run> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const run: Partial<Run> = {
      raid: null,
      launches: new Map(),
      releases: new Map(),
      closest: new Map(),
      botOnBot: [],
      hitsOnHuman: 0,
    };
    const bots = new Set<string>();
    let self: Pose | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name: "Ace" })));
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      const now = performance.now();
      if (msg.type === "welcome") {
        run.welcome = msg;
        self = { pos: msg.spawn.pos, quat: IDENTITY, speed: msg.spawn.speed };
        // In the air: stream the held pose at TICK_UP_HZ.
        timer = setInterval(() => {
          if (self) ws.send(JSON.stringify({ type: "pose", pose: self }));
        }, 50);
        setTimeout(() => {
          clearInterval(timer);
          ws.close();
          resolve(run as Run);
        }, ms);
      } else if (msg.type === "boss") {
        run.raid ??= decodeRaid(msg.r);
      } else if (msg.type === "playerJoined") {
        if (msg.player.isBot) bots.add(msg.player.id);
      } else if (msg.type === "bossLaunch") {
        const l = decodeLaunch(msg.l);
        if (l) run.launches?.set(msg.bot, { l, at: now });
      } else if (msg.type === "respawn") {
        if (msg.id === run.welcome?.id) {
          // Shot down and back: hold the new spawn.
          self = {
            pos: msg.spawn.pos,
            quat: IDENTITY,
            speed: msg.spawn.speed,
          };
        } else if (!run.releases?.has(msg.id)) {
          run.releases?.set(msg.id, { ...msg.spawn, at: now });
        }
      } else if (msg.type === "damage") {
        const shooterBot = bots.has(msg.shooterId);
        if (shooterBot && bots.has(msg.targetId)) {
          run.botOnBot?.push(`${msg.shooterId}→${msg.targetId}`);
        }
        if (shooterBot && msg.targetId === run.welcome?.id) {
          run.hitsOnHuman = (run.hitsOnHuman ?? 0) + 1;
        }
      } else if (msg.type === "snapshot" && self) {
        for (const w of msg.p) {
          const e = decodeSnapshotEntry(w);
          const rel = run.releases?.get(e.id);
          if (!rel || now - rel.at > CLOSE_WITHIN_MS) continue;
          const d = wrapDistance(e.pose.pos, self.pos);
          const best = run.closest?.get(e.id) ?? Number.POSITIVE_INFINITY;
          run.closest?.set(e.id, Math.min(best, d));
        }
      }
    });
  });
}

describe("W1 carrier waves, end to end with one human", () => {
  let run: Run;
  beforeAll(async () => {
    run = await fly(28_000);
  }, 60_000);

  it("a fresh room holds no bots: enemies exist only as carrier launches", () => {
    expect(run.welcome.roster.some((r) => r.isBot)).toBe(false);
    expect(run.raid).not.toBeNull();
    expect(run.launches.size).toBeGreaterThanOrEqual(3);
    // Every enemy that flew was launched first.
    for (const id of run.releases.keys())
      expect(run.launches.has(id)).toBe(true);
  });

  it("every enemy leaves the carrier at its launch's release pose", () => {
    const raid = run.raid as BossRaid;
    expect(run.releases.size).toBeGreaterThanOrEqual(3);
    for (const [id, rel] of run.releases) {
      const launch = run.launches.get(id);
      if (!launch) throw new Error(`${id} flew without a launch`);
      const want = launchSpawnAt(raid, launch.l);
      expect(wrapDistance(rel.pos, want.pos)).toBeLessThan(1e-6);
      expect(rel.yaw).toBeCloseTo(want.yaw, 9);
      // Released no earlier than its rig's sequence (± a tick).
      expect(rel.at - launch.at).toBeGreaterThan(1500);
    }
  });

  it(`enemies close on the human within ${CLOSE_WITHIN_MS / 1000} s of leaving the carrier, and only ever shoot at it`, () => {
    const closest = [...run.closest.values()];
    console.log(
      `W1 e2e: ${run.launches.size} launched, ${run.releases.size} released; closest approach within 15 s (m): ${closest.map((d) => Math.round(d)).join(", ")}; ${run.hitsOnHuman} hits on the human`,
    );
    expect(closest.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...closest)).toBeLessThanOrEqual(CLOSE_M);
    expect(run.botOnBot).toEqual([]);
  });
});
