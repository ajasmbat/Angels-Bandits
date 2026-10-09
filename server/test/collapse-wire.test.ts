// D3 end to end, against a real server process — the two-client QA:
// client A shoots out a floor band of a tower, the server collapses it and
// both A and B receive the same collapse; B (whose own client builds the
// same debris from the event) flies into a falling chunk, its crash check
// fires, and the server declares a collapse kill credited to A — seen by
// both. A late joiner's welcome replays the same collapse.
//
// Deterministic like the D2 wire test: bots off, A placed by repeating one
// pose until the server re-syncs, B placed in the debris's path the same way.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type Building,
  CityDamage,
  decodeChunkIds,
  generateCity,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  CollapseField,
  type CollapseWire,
  blankPose,
  collapseChunks,
  piecePose,
} from "@angels-bandits/common/city/collapse";
import { collideMovers } from "@angels-bandits/common/city/movers";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
let child: ChildProcess;
let url: string;

interface Peer {
  ws: WebSocket;
  welcome: WelcomeMsg;
  seen: ServerMsg[];
  collapses: CollapseWire[];
  deaths: DeathMsg[];
  destroyed: Set<number>;
}

function connect(name: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const peer: Partial<Peer> = {
      ws,
      seen: [],
      collapses: [],
      deaths: [],
      destroyed: new Set(),
    };
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name })));
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.type === "snapshot") return;
      peer.seen?.push(msg);
      if (msg.type === "chunks") {
        for (const id of decodeChunkIds(msg.d)) peer.destroyed?.add(id);
      }
      if (msg.type === "collapse") peer.collapses?.push(msg.c);
      if (msg.type === "death") peer.deaths?.push(msg);
      if (msg.type === "welcome") {
        peer.welcome = msg;
        for (const id of decodeChunkIds(msg.destroyed)) {
          peer.destroyed?.add(id);
        }
        peer.collapses?.push(...msg.collapses);
        resolve(peer as Peer);
      }
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(20);
  return cond();
};

/** What a client builds from what it was told: its own city, broken and
 * collapsed exactly as the messages say (the GameSocket's replay). */
function clientDebris(peer: Peer): CollapseField {
  const city = generateCity(CITY_SEED);
  const damage = new CityDamage();
  const field = new CollapseField();
  damage.bind(city);
  field.bind(city);
  damage.apply([...peer.destroyed]);
  for (const c of peer.collapses) {
    damage.collapse(collapseChunks(c));
    field.add(c);
  }
  return field;
}

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

describe("D3 collapses over the wire", () => {
  it("A shoots out a tower's floor band; A and B see the same collapse, and B dies flying into its falling debris, credited to A", async () => {
    const city = generateCity(CITY_SEED);
    // A street-facing tower one chunk deep (its band is a single row along
    // x), its −x face on the lot line so A has clear air to shoot from.
    const target = city.findIndex((b) => {
      const g = tierGrids(b)[0];
      return (
        !b.holes &&
        !!g &&
        g.nz === 1 &&
        g.ny >= 3 &&
        b.height >= 40 &&
        Math.abs(((((b.x - b.width / 2) % 200) + 200) % 200) - 20) < 1e-6
      );
    });
    expect(target).toBeGreaterThanOrEqual(0);
    const tower = city[target] as Building;
    const grid = tierGrids(tower)[0];
    if (!grid) throw new Error("no grid");
    // Nose along +x (yaw −90°), mid-way up band 1, through the row.
    const aim: Pose = {
      pos: { x: tower.x - tower.width / 2 - 25, y: grid.ch * 1.5, z: tower.z },
      quat: { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
      speed: 60,
    };

    const a = await connect("Shooter");
    a.ws.send(JSON.stringify({ type: "setBots", count: 0 }));
    const b = await connect("Witness");
    expect(b.welcome.roomId).toBe(a.welcome.roomId);
    await until(() => a.seen.some((m) => m.type === "botsConfig"), 3000);
    for (let i = 0; i < 12; i++) {
      a.ws.send(JSON.stringify({ type: "pose", pose: aim }));
      await wait(40);
    }
    // Sustained fire until the band gives way.
    let seq = 1;
    const firing = setInterval(() => {
      a.ws.send(JSON.stringify({ type: "pose", pose: aim }));
      a.ws.send(JSON.stringify({ type: "fire", seq: seq++ }));
    }, FIRE_INTERVAL_MS + 15);
    const fell = await until(
      () => a.collapses.length > 0 && b.collapses.length > 0,
      15000,
    );
    clearInterval(firing);
    expect(fell).toBe(true);

    // Both clients got the same event, about the tower A shot.
    const wire = b.collapses[0] as CollapseWire;
    expect(a.collapses[0]).toEqual(wire);
    expect(wire.b).toBe(target);
    // ...and each builds identical debris from it.
    const fa = clientDebris(a);
    const fb = clientDebris(b);
    const ca = fa.list[0] as Collapse;
    const cb = fb.list[0] as Collapse;
    expect(ca).toBeDefined();
    const p = blankPose();
    const q = blankPose();
    for (let t = 0; t <= ca.endMs; t += 173) {
      for (let i = 0; i < ca.n; i++) {
        expect(piecePose(cb, i, ca.t0 + t, q)).toEqual(
          piecePose(ca, i, ca.t0 + t, p),
        );
      }
    }

    // B flies into the highest falling chunk mid-fall: place B on its path
    // (re-sync), then hold there until the chunk arrives.
    let top = 0;
    for (let i = 1; i < cb.n; i++) {
      if ((cb.oy[i] as number) > (cb.oy[top] as number)) top = i;
    }
    const fallStart = cb.t0 + (cb.start[top] as number) * 1000;
    const fallEnd = fallStart + (cb.land[top] as number) * 1000;
    const tHit = Math.max(Date.now() + 900, (fallStart + fallEnd) / 2);
    expect(tHit).toBeLessThan(fallEnd);
    piecePose(cb, top, tHit, p);
    const meet: Pose = {
      pos: { x: cb.x + p.x, y: p.y, z: cb.z + p.z },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      speed: 60,
    };
    // B's own crash check (collideMovers is what detectCrash runs) fires
    // there at that moment — and not before the chunk arrives.
    const movers = { cranes: [], aircraft: [], collapses: fb };
    expect(collideMovers(meet.pos, PLAYER_RADIUS, movers, tHit)?.kind).toBe(
      "debris",
    );
    expect(
      collideMovers(meet.pos, PLAYER_RADIUS, movers, cb.t0 - 1000),
    ).toBeNull();
    while (Date.now() < tHit) {
      b.ws.send(JSON.stringify({ type: "pose", pose: meet, t: Date.now() }));
      await wait(25);
    }
    b.ws.send(JSON.stringify({ type: "crash", t: tHit }));

    // Dead on both: a collapse kill, A credited.
    const want = {
      type: "death",
      victimId: b.welcome.id,
      killerId: a.welcome.id,
      cause: "collapse",
    };
    expect(
      await until(
        () =>
          a.deaths.some((d) => d.victimId === b.welcome.id) &&
          b.deaths.some((d) => d.victimId === b.welcome.id),
        3000,
      ),
    ).toBe(true);
    expect(a.deaths.find((d) => d.victimId === b.welcome.id)).toEqual(want);
    expect(b.deaths.find((d) => d.victimId === b.welcome.id)).toEqual(want);

    // A late joiner's welcome replays the same collapse.
    const c = await connect("Latecomer");
    expect(c.welcome.roomId).toBe(a.welcome.roomId);
    expect(c.welcome.collapses).toEqual(b.collapses);
    for (const peer of [a, b, c]) peer.ws.close();
  }, 60000);
});
