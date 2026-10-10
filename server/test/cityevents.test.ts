// L1 reactive city — the server's per-room event log, the near-building
// probe, the bots' last-known position, and the wire path end to end: a
// crash produces a positioned `cityEvent` right after its `death`, and a
// late joiner's welcome replays it.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateCity } from "@angels-bandits/common/city";
import { SMOKE_LIFE_MS } from "@angels-bandits/common/cityevents";
import { CITY_SEED, RESPAWN_SPEED } from "@angels-bandits/common/constants";
import type {
  RosterEntry,
  ServerMsg,
  SpawnState,
  WelcomeMsg,
} from "@angels-bandits/common/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RoomBots } from "../src/bots";
import { CityEventLog, nearBuildingProbe } from "../src/cityevents";

/** Spawn `n` bots, each where `pick` says (W1 removed RoomBots.syncTo's
 * backfill: the room spawns its enemies one carrier launch at a time). */
const spawnBots = (
  bots: RoomBots,
  n: number,
  pick: () => SpawnState,
): { spawned: RosterEntry[] } => ({
  spawned: Array.from({ length: n }, () => bots.spawn(pick())),
});

const city = generateCity(CITY_SEED);
const always = () => true;

describe("CityEventLog", () => {
  it("broadcasts accepted events and coalesces a burst", () => {
    const log = new CityEventLog(always);
    const p = { x: 500, y: 60, z: 500 };
    expect(log.offer("room-1", "gunfire", p, 1000)).not.toBeNull();
    expect(log.offer("room-1", "gunfire", p, 1100)).toBeNull();
    expect(log.offer("room-1", "death", p, 1200)).toMatchObject({
      kind: "death",
      x: 500,
      z: 500,
      t: 1200,
    });
    expect(log.recent("room-1", 1300)).toHaveLength(2);
  });

  it("keeps rooms isolated, and prunes each room's log on its own", () => {
    const log = new CityEventLog(always);
    const p = { x: 900, y: 60, z: 900 };
    log.offer("room-1", "death", p, 0);
    log.offer("room-2", "death", p, 30_000);
    // Same place, same time window — but another room: not coalesced.
    expect(log.offer("room-2", "gunfire", p, 30_100)).toBeNull(); // room-2's own death
    expect(log.offer("room-3", "gunfire", p, 30_100)).not.toBeNull();
    expect(log.recent("room-1", SMOKE_LIFE_MS - 1)).toHaveLength(1);
    expect(log.recent("room-1", SMOKE_LIFE_MS)).toHaveLength(0);
    expect(log.recent("room-2", SMOKE_LIFE_MS)).toHaveLength(1);
    log.forget("room-2");
    expect(log.recent("room-2", SMOKE_LIFE_MS)).toHaveLength(0);
  });

  it("replays copies — a caller cannot edit the log", () => {
    const log = new CityEventLog(always);
    log.offer("r", "death", { x: 1, y: 1, z: 1 }, 0);
    const [first] = log.recent("r", 1);
    if (first) first.x = 999;
    expect(log.recent("r", 1)[0]?.x).toBe(1);
  });
});

describe("nearBuildingProbe", () => {
  const near = nearBuildingProbe(city);

  it("counts gunfire low between buildings, not high above the rooftops", () => {
    const b = city.find((x) => !x.holes);
    expect(b).toBeDefined();
    if (!b) return;
    // Just off the facade, halfway up.
    expect(near({ x: b.x + b.width / 2 + 20, y: b.height / 2, z: b.z })).toBe(
      true,
    );
    expect(near({ x: b.x, y: b.height + 300, z: b.z })).toBe(false);
  });
});

describe("RoomBots.lastPosOf", () => {
  it("still knows where a bot is after it was marked dead (its death site)", () => {
    const bots = new RoomBots("room-1", 7, []);
    const { spawned } = spawnBots(bots, 1, () => ({
      pos: { x: 640, y: 300, z: 410 },
      yaw: 0,
      speed: RESPAWN_SPEED,
    }));
    const id = spawned[0]?.id ?? "";
    bots.setDead(id);
    expect(bots.poseOf(id)).toBeNull();
    expect(bots.lastPosOf(id)).toMatchObject({ x: 640, z: 410 });
    expect(bots.lastPosOf("nobody")).toBeNull();
  });
});

// --- The wire path, against a real server process -------------------------

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
let child: ChildProcess;
let url: string;

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
    const ws = new WebSocket(url);
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("city events over the wire", () => {
  it("a crash sends `death` then a positioned `cityEvent` at the crash site; a late joiner's welcome replays it", async () => {
    const pilot = await connect("Crash");
    expect(Array.isArray(pilot.welcome.cityEvents)).toBe(true);
    await wait(200);
    pilot.ws.send(JSON.stringify({ type: "crash" }));
    await wait(600);
    const mine = pilot.seen.findIndex(
      (m) => m.type === "death" && m.victimId === pilot.welcome.id,
    );
    expect(mine).toBeGreaterThanOrEqual(0);
    const next = pilot.seen.slice(mine + 1).find((m) => m.type === "cityEvent");
    expect(next?.type).toBe("cityEvent");
    if (next?.type !== "cityEvent") return;
    // The crash site is the pilot's on-record pose: its spawn.
    const spawn = pilot.welcome.spawn.pos;
    expect(next.event.kind).toBe("death");
    expect(next.event.x).toBeCloseTo(spawn.x, 6);
    expect(next.event.y).toBeCloseTo(spawn.y, 6);
    expect(next.event.z).toBeCloseTo(spawn.z, 6);
    expect(Number.isFinite(next.event.t)).toBe(true);

    const late = await connect("Late");
    expect(late.welcome.roomId).toBe(pilot.welcome.roomId);
    expect(late.welcome.cityEvents).toContainEqual(next.event);
    pilot.ws.close();
    late.ws.close();
  }, 20000);
});
