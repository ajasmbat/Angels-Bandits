// D4 end to end, against a real server process: player A shoots player B
// down over a tower. Both clients get the SAME wreck in the death message
// (one shared fall), a late joiner's welcome replays it while it falls, and
// when it lands the server's blast breaks the tower's roof — the same chunk
// batch for both clients, after the death, and the city's death event at
// the impact point.
//
// Deterministic by construction: bots are set to 0 first, both planes are
// re-synced onto scripted poses (RESYNC_AFTER_REJECTS), B hangs still (speed
// 0, so its wreck falls straight onto the roof under it) and B fires once to
// drop its spawn protection.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type Building,
  chunkBuilding,
  decodeChunkIds,
  generateCity,
} from "@angels-bandits/common/city";
import { buildCityIndex, collideCity } from "@angels-bandits/common/collision";
import {
  CITY_SEED,
  FIRE_INTERVAL_MS,
  PLAYER_RADIUS,
} from "@angels-bandits/common/constants";
import type {
  DeathMsg,
  Pose,
  ServerMsg,
  WelcomeMsg,
} from "@angels-bandits/common/protocol";
import { wrapDistance } from "@angels-bandits/common/world";
import { wreckPosAt } from "@angels-bandits/common/wreck";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
let child: ChildProcess;
let url: string;

interface Peer {
  ws: WebSocket;
  welcome: WelcomeMsg;
  seen: ServerMsg[];
}

function connect(name: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const peer: Partial<Peer> = { ws, seen: [] };
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name })));
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.type === "snapshot") return;
      peer.seen?.push(msg);
      if (msg.type === "welcome") {
        peer.welcome = msg;
        resolve(peer as Peer);
      }
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(25);
  return cond();
};

beforeAll(async () => {
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

describe("D4 wrecks over the wire", () => {
  it("both clients see the same fall, and the same impact damage after it", async () => {
    const city = generateCity(CITY_SEED);
    const index = buildCityIndex(city);
    const LEVEL = { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }; // nose +x
    const STILL = { x: 0, y: 0, z: 0, w: 1 };
    // A plain tower with open air 40 m over its roof and 60 m west of that.
    const target = city.findIndex((b) => {
      if (b.holes || b.roof || b.tiers.length !== 1 || b.height < 60) {
        return false;
      }
      const y = b.height + 40;
      return [
        { x: b.x, y, z: b.z },
        { x: b.x - 60, y, z: b.z },
      ].every((p) => collideCity(p, PLAYER_RADIUS + 8, city, index) === null);
    });
    expect(target).toBeGreaterThanOrEqual(0);
    const tower = city[target] as Building;
    const y = tower.height + 40;
    const poseB: Pose = {
      pos: { x: tower.x, y, z: tower.z },
      quat: STILL,
      speed: 0,
    };
    const poseA: Pose = {
      pos: { x: tower.x - 60, y, z: tower.z },
      quat: LEVEL,
      speed: 0,
    };

    const a = await connect("Shooter");
    a.ws.send(JSON.stringify({ type: "setBots", count: 0 }));
    const b = await connect("Victim");
    expect(b.welcome.roomId).toBe(a.welcome.roomId);
    await until(() => a.seen.some((m) => m.type === "botsConfig"), 3000);
    const pose = () => {
      a.ws.send(JSON.stringify({ type: "pose", pose: poseA }));
      b.ws.send(JSON.stringify({ type: "pose", pose: poseB }));
    };
    for (let i = 0; i < 14; i++) {
      pose();
      await wait(60);
    }
    // B fires once: firing forfeits its spawn protection.
    b.ws.send(JSON.stringify({ type: "fire", seq: 1 }));
    await wait(60);

    const deathOf = (peer: Peer) =>
      peer.seen.find(
        (m): m is DeathMsg => m.type === "death" && m.victimId === b.welcome.id,
      );
    let seq = 1;
    const firing = setInterval(() => {
      pose();
      a.ws.send(JSON.stringify({ type: "fire", seq }));
      a.ws.send(
        JSON.stringify({
          type: "hit",
          targetId: b.welcome.id,
          bulletOrigin: poseA.pos,
          seq,
          delay: 100,
        }),
      );
      seq++;
    }, FIRE_INTERVAL_MS + 15);
    const died = await until(() => !!deathOf(a) && !!deathOf(b), 10000);
    clearInterval(firing);
    expect(died).toBe(true);

    // One shared fall: the same wreck, byte for byte, on both clients.
    const da = deathOf(a) as DeathMsg;
    const db = deathOf(b) as DeathMsg;
    expect(da.cause).toBe("shot");
    expect(da.killerId).toBe(a.welcome.id);
    expect(da.wreck).toBeDefined();
    expect(db.wreck).toEqual(da.wreck);
    const wreck = da.wreck;
    if (!wreck) throw new Error("no wreck");
    expect(wreck.hit).toBe("city");
    expect(wrapDistance(wreck.p, poseB.pos)).toBeLessThan(1e-6);
    const impact = wreckPosAt(wreck, wreck.t + wreck.end, { x: 0, y: 0, z: 0 });
    expect(impact.y).toBeGreaterThan(tower.height - 1);

    // A late joiner while it falls gets it in the welcome.
    const c = await connect("Latecomer");
    expect(c.welcome.wrecks?.map((w) => w.id)).toContain(wreck.id);

    // It lands: the tower's roof breaks, in a batch AFTER the death, the
    // same for both clients — and the city reacts at the impact point.
    const towerChunks = (peer: Peer) => {
      const at = peer.seen.indexOf(deathOf(peer) as DeathMsg);
      return peer.seen
        .slice(at)
        .flatMap((m) => (m.type === "chunks" ? decodeChunkIds(m.d) : []))
        .filter((id) => chunkBuilding(id) === target)
        .sort((x, y2) => x - y2);
    };
    const landed = await until(
      () => towerChunks(a).length > 0 && towerChunks(b).length > 0,
      wreck.end + 3000,
    );
    expect(landed).toBe(true);
    await wait(300);
    expect(towerChunks(b)).toEqual(towerChunks(a));
    // Nothing on the tower broke before the wreck hit it.
    const before = (peer: Peer) =>
      peer.seen
        .slice(0, peer.seen.indexOf(deathOf(peer) as DeathMsg))
        .flatMap((m) => (m.type === "chunks" ? decodeChunkIds(m.d) : []))
        .filter((id) => chunkBuilding(id) === target);
    expect(before(a)).toEqual([]);
    for (const peer of [a, b]) {
      const event = peer.seen.find(
        (m) =>
          m.type === "cityEvent" &&
          m.event.kind === "death" &&
          m.event.t === wreck.t + wreck.end,
      );
      expect(event).toBeDefined();
    }

    for (const peer of [a, b, c]) peer.ws.close();
  }, 30000);
});
