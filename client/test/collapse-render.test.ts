// D3 on the client: the debris the city renderer draws is exactly the box
// the crash check collides with — falling, squashing and landed — the rest
// state is solid before the clock exists, and the socket rebuilds a room's
// collapses the same way live and from a late welcome.

import {
  type Building,
  CUT_RUBBLE,
  CityDamage,
  chunkId,
  encodeChunkIds,
  solids,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  CollapseField,
  type CollapseWire,
  blankPose,
  collapseChunks,
  collapseWire,
  collidePiece,
  piecePose,
  planCollapses,
} from "@angels-bandits/common/city/collapse";
import { CITY_SEED } from "@angels-bandits/common/constants";
import type { ServerMsg, WelcomeMsg } from "@angels-bandits/common/protocol";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { touchesSolid } from "../src/game/collision";
import { GameSocket } from "../src/net/socket";
import { CityRenderer } from "../src/render/city";

const city = new CityRenderer(CITY_SEED);
const buildings = city.cityBuildings as Building[];
const damage = new CityDamage();
const field = new CollapseField();
city.attachDamage(damage);
city.attachCollapses(field);

/** A plain tower whose street tier is at least 2 × 2 chunks. */
const target = buildings.findIndex((b) => {
  const g = tierGrids(b)[0];
  return !b.holes && !!g && g.nx >= 2 && g.nz >= 2 && b.height >= 80;
});
const tower = buildings[target] as Building;

/** The server's path: break the base band (all but `keep`), plan, record. */
function collapseTower(keep: number[], id: number, t: number): CollapseWire {
  const g = tierGrids(tower)[0];
  if (!g) throw new Error("no grid");
  for (let c = 0; c < g.nx * g.nz; c++) {
    if (!keep.includes(c)) damage.destroyChunk(chunkId(target, 0, c));
  }
  const plan = planCollapses(tower, target)[0];
  if (!plan) throw new Error("no plan");
  return collapseWire(plan, target, id, t);
}

/** Unit-box points (the city box stands on y ∈ [0, 1]) just inside and
 * just outside each face, plus the centre. */
const INSIDE: [number, number, number][] = [
  [0, 0.5, 0],
  [0.47, 0.5, 0],
  [-0.47, 0.5, 0],
  [0, 0.03, 0],
  [0, 0.97, 0],
  [0, 0.5, 0.47],
  [0, 0.5, -0.47],
  [0.45, 0.05, -0.45],
];
const OUTSIDE: [number, number, number][] = [
  [0.53, 0.5, 0],
  [-0.53, 0.5, 0],
  [0, -0.03, 0],
  [0, 1.03, 0],
  [0, 0.5, 0.53],
  [0, 0.5, -0.53],
];

describe("D3 debris in the city renderer", () => {
  it("draws every piece exactly where it collides — falling, squashing and landed", () => {
    expect(target).toBeGreaterThanOrEqual(0);
    const g = tierGrids(tower)[0];
    const wire = collapseTower(
      [Math.floor((g?.nz ?? 2) / 2) * (g?.nx ?? 2)],
      1,
      0,
    );
    damage.collapse(collapseChunks(wire));
    const c = field.add(wire) as Collapse;
    expect(c).not.toBeNull();
    expect(c.style).toBe(1); // a topple: rotations are exercised
    const eye = { x: tower.x, y: 60, z: tower.z };
    const pose = blankPose();
    // Standing (lead beat), mid-swing, ballistic, squashing, at rest.
    const land = c.t0 + ((c.start[0] as number) + (c.land[0] as number)) * 1000;
    const times = [
      c.t0 + 300,
      c.t0 + 600 + c.tBreak * 500,
      c.t0 + 600 + c.tBreak * 1000 + 300,
      land + 150,
      Number.POSITIVE_INFINITY,
    ];
    city.updateDebris(eye, c.t0); // the first frame lays its slots out
    const { mesh, start } = city.debrisSlots(c.id);
    if (!mesh) throw new Error("no debris mesh");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(mesh.count).toBeGreaterThanOrEqual(start + c.n);
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    for (const t of times) {
      city.updateDebris(eye, Number.isFinite(t) ? t : null);
      for (let i = 0; i < c.n; i++) {
        mesh.getMatrixAt(start + i, m);
        for (const p of INSIDE) {
          v.set(...p).applyMatrix4(m);
          expect(collidePiece(c, i, v, 0.01, t), `piece ${i} @ ${t} in`).toBe(
            true,
          );
        }
        for (const p of OUTSIDE) {
          v.set(...p).applyMatrix4(m);
          expect(
            collidePiece(c, i, v, 0.01, t),
            `piece ${i} @ ${t} out ${p}`,
          ).toBe(false);
        }
      }
    }
    // Landed pieces paint as rubble.
    const subOff = mesh.geometry.getAttribute("aSubOff");
    expect(piecePose(c, 0, Number.POSITIVE_INFINITY, pose).rest).toBe(true);
    expect(subOff.getW(start)).toBe(CUT_RUBBLE);
  });

  it("rubble is solid before the clock exists (drawn at rest, collides at rest)", () => {
    const c = field.list[0] as Collapse;
    const p = piecePose(c, 0, Number.POSITIVE_INFINITY, blankPose());
    const at = { x: c.x + p.x, y: p.y, z: c.z + p.z };
    const movers = { cranes: [], aircraft: [], collapses: field };
    expect(touchesSolid(at, 1, [], undefined, movers, null)).toBe(true);
    expect(touchesSolid(at, 1, [], undefined, movers, c.t0 + c.endMs + 1)).toBe(
      true,
    );
    // Without the collapse field it is open air (no city boxes passed).
    expect(
      touchesSolid(at, 1, [], undefined, { cranes: [], aircraft: [] }, null),
    ).toBe(at.y < 1);
  });

  it("a room reset clears the debris mesh", () => {
    field.reset([]);
    damage.reset([]);
    city.updateDebris({ x: tower.x, y: 60, z: tower.z }, 0);
    const { mesh, start } = city.debrisSlots(1);
    expect(start).toBe(-1);
    expect(mesh?.count).toBe(0);
  });
});

// --- The socket keeps collapses while the game boots -----------------------

type Listener = (ev: { data?: string }) => void;

/** Just enough of a browser WebSocket for GameSocket. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  private readonly listeners = new Map<string, Listener[]>();
  constructor() {
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: Listener, opts?: { once?: boolean }) {
    const wrapped: Listener = opts?.once
      ? (ev) => {
          this.off(type, wrapped);
          fn(ev);
        }
      : fn;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }
  private off(type: string, fn: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  emit(type: string, ev: { data?: string } = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  send() {}
  close() {}
}

async function join(
  destroyed: number[],
  collapses: CollapseWire[],
): Promise<{ socket: GameSocket; ws: FakeSocket }> {
  const connecting = GameSocket.connect("pilot");
  const ws = FakeSocket.last as FakeSocket;
  ws.emit("open");
  const welcome = {
    type: "welcome",
    id: "me",
    roomId: "room-1",
    seed: CITY_SEED,
    spawn: { pos: { x: 0, y: 300, z: 0 }, yaw: 0, speed: 60 },
    roster: [],
    scores: [],
    intensity: 1,
    waves: [0, 0, 0, 0, 0, 0],
    cityEvents: [],
    resumeToken: "t",
    destroyed: encodeChunkIds(destroyed),
    collapses,
    courses: [],
  } as unknown as WelcomeMsg;
  ws.emit("message", { data: JSON.stringify(welcome) });
  return { socket: await connecting, ws };
}

describe("D3 GameSocket keeps the room's collapses", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a live client and a late joiner end up with the same broken city", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", {
      hostname: "localhost",
      host: "localhost",
      protocol: "http:",
    });
    vi.stubGlobal("document", { hidden: false, addEventListener() {} });

    // The server's side of one collapse.
    damage.reset([]);
    field.reset([]);
    const wire = collapseTower([], 9, 1234);
    const broke = damage.destroyedIds();

    // Live: joined before, then `chunks` + `collapse` while still booting.
    const live = await join([], []);
    const seen: CollapseWire[] = [];
    const chunks: ServerMsg = { type: "chunks", d: encodeChunkIds(broke) };
    live.ws.emit("message", { data: JSON.stringify(chunks) });
    const collapse: ServerMsg = { type: "collapse", c: wire };
    live.ws.emit("message", { data: JSON.stringify(collapse) });
    live.socket.events.onCollapse = (c) => seen.push(c);
    // Late: everything from the welcome.
    const late = await join(broke, [wire]);

    for (const s of [live.socket, late.socket]) {
      expect(s.collapses.records).toEqual([wire]);
      expect(s.cityDamage.destroyedIds()).toEqual(broke);
      expect(s.cityDamage.fallenCount).toBe(collapseChunks(wire).length);
    }
    // Bound to their own cities (as main.ts does once the city is built),
    // both draw and collide with the same buildings and debris.
    const cities = [live, late].map(({ socket }) => {
      const r = new CityRenderer(CITY_SEED);
      r.attachDamage(socket.cityDamage);
      r.attachCollapses(socket.collapses);
      return r;
    });
    const [a, b] = cities as [CityRenderer, CityRenderer];
    a.cityBuildings.forEach((bld, i) => {
      expect(solids(b.cityBuildings[i] as Building)).toEqual(solids(bld));
    });
    const ca = live.socket.collapses.list[0];
    const cb = late.socket.collapses.list[0];
    if (!ca || !cb) throw new Error("no debris");
    const p = blankPose();
    const q = blankPose();
    for (let t = 0; t < ca.endMs + 500; t += 211) {
      for (let i = 0; i < ca.n; i++) {
        expect(piecePose(cb, i, ca.t0 + t, q)).toEqual(
          piecePose(ca, i, ca.t0 + t, p),
        );
      }
    }
    expect(seen).toEqual([]); // nothing was listening yet; nothing lost
  });
});
