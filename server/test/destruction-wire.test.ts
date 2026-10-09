// D2 end to end, against a real server process: player A shoots a facade,
// the server breaks the chunk and broadcasts it, player B — already in the
// room — receives exactly the set the server holds, a late joiner's welcome
// replays the same set, and both clients' cities collide with the same
// broken geometry (the chunk A shot away is open air for each of them).
//
// Deterministic by construction: the room's bots are set to 0 first (they
// would otherwise shoot the city too), A is placed in front of the facade by
// repeating one pose until the server re-syncs to it (RESYNC_AFTER_REJECTS),
// and the chunk A's rounds will hit is predicted with the same shared ray.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type Building,
  CityDamage,
  chunkBox,
  chunkBuilding,
  decodeChunkIds,
  generateCity,
  raycastChunk,
  solids,
  tierGrids,
} from "@angels-bandits/common/city";
import { collideCity } from "@angels-bandits/common/collision";
import {
  BULLET_RANGE,
  CITY_SEED,
  FIRE_INTERVAL_MS,
} from "@angels-bandits/common/constants";
import type {
  Pose,
  ServerMsg,
  WelcomeMsg,
} from "@angels-bandits/common/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
let child: ChildProcess;
let url: string;

interface Peer {
  ws: WebSocket;
  welcome: WelcomeMsg;
  seen: ServerMsg[];
  /** Every chunk this client was told about: its welcome set, then batches. */
  destroyed: Set<number>;
  /** `chunks` messages received. */
  batches: number;
}

function connect(name: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const peer: Partial<Peer> = {
      ws,
      seen: [],
      destroyed: new Set(),
      batches: 0,
    };
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name })));
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.type === "snapshot") return;
      peer.seen?.push(msg);
      if (msg.type === "chunks") {
        peer.batches = (peer.batches ?? 0) + 1;
        for (const id of decodeChunkIds(msg.d)) peer.destroyed?.add(id);
      }
      if (msg.type === "welcome") {
        peer.welcome = msg;
        for (const id of decodeChunkIds(msg.destroyed)) {
          peer.destroyed?.add(id);
        }
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

describe("D2 destruction over the wire", () => {
  it("B sees A's destruction, a late joiner replays it, and both collide with the same city", async () => {
    const city = generateCity(CITY_SEED);
    // A plain street-facing tower: its −x face on the lot line of a block.
    const target = city.findIndex(
      (b) =>
        !b.holes &&
        b.height >= 30 &&
        Math.abs(((((b.x - b.width / 2) % 200) + 200) % 200) - 20) < 1e-6,
    );
    const tower = city[target] as Building;
    expect(tower).toBeDefined();
    // Nose along +x: yaw −90° about y (the plane flies its local −z), at
    // the middle of a facade bay and a floor band — never on a cell edge,
    // where the predicted cell would be a coin toss.
    const grid = tierGrids(tower)[0];
    if (!grid) throw new Error("no grid");
    const pose: Pose = {
      pos: {
        x: tower.x - tower.width / 2 - 25,
        y: grid.ch * 1.5,
        z: tower.z + grid.cd / 2 - tower.depth / 2 + grid.cd,
      },
      quat: { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
      speed: 60,
    };
    const hit = raycastChunk(
      city,
      pose.pos,
      { x: 1, y: 0, z: 0 },
      BULLET_RANGE,
    );
    expect(hit?.building).toBe(target);
    const shotAway = hit?.chunk as number;
    expect(shotAway).toBeGreaterThanOrEqual(0);

    const a = await connect("Shooter");
    a.ws.send(JSON.stringify({ type: "setBots", count: 0 }));
    const b = await connect("Witness");
    expect(b.welcome.roomId).toBe(a.welcome.roomId);
    await until(() => a.seen.some((m) => m.type === "botsConfig"), 3000);

    // Re-sync A in front of the facade: the first pose is a teleport, so it
    // is rejected until the server's re-sync threshold accepts it.
    for (let i = 0; i < 14; i++) {
      a.ws.send(JSON.stringify({ type: "pose", pose }));
      await wait(60);
    }
    // Sustained fire until the chunk breaks (9 rounds at ~10/s).
    let seq = 1;
    const firing = setInterval(() => {
      a.ws.send(JSON.stringify({ type: "pose", pose }));
      a.ws.send(JSON.stringify({ type: "fire", seq: seq++ }));
    }, FIRE_INTERVAL_MS + 15);
    const broke = await until(() => b.destroyed.has(shotAway), 10000);
    clearInterval(firing);
    expect(broke).toBe(true);
    expect(a.destroyed.has(shotAway)).toBe(true);
    // Batched: one message per tick at most, never one per chunk per player.
    expect(b.batches).toBeGreaterThan(0);
    expect(b.batches).toBeLessThanOrEqual(b.destroyed.size);

    // Let anything in flight land, then a late joiner replays the set.
    await wait(300);
    const c = await connect("Latecomer");
    expect(c.welcome.roomId).toBe(a.welcome.roomId);
    expect([...c.destroyed].sort((x, y) => x - y)).toEqual(
      [...b.destroyed].sort((x, y) => x - y),
    );

    // Both clients' cities: the shot-away chunk is open air for each.
    const cityOf = (peer: Peer) => {
      const own = generateCity(CITY_SEED);
      const dmg = new CityDamage();
      dmg.reset([...peer.destroyed]);
      dmg.bind(own);
      return own;
    };
    const cityB = cityOf(b);
    const cityC = cityOf(c);
    const box = chunkBox(cityB, shotAway);
    if (!box) throw new Error("no chunk box");
    const owner = city[chunkBuilding(shotAway)] as Building;
    const centre = {
      x: owner.x + (box.x0 + box.x1) / 2,
      y: (box.y0 + box.y1) / 2,
      z: owner.z + (box.z0 + box.z1) / 2,
    };
    expect(collideCity(centre, 1, city)).toBe(owner);
    expect(collideCity(centre, 1, cityB)).toBeNull();
    expect(collideCity(centre, 1, cityC)).toBeNull();
    cityB.forEach((building, i) => {
      expect(solids(cityC[i] as Building)).toEqual(solids(building));
    });

    for (const p of [a, b, c]) p.ws.close();
  }, 40000);
});
