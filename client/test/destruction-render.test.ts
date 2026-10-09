// D2 on the client: the city renderer draws a damaged building from exactly
// its live solids() (draw == collide), never lets a torus image flip bring
// the intact copy back, and restores a building the destroyed set no longer
// names; the socket keeps every `chunks` batch, including those that arrive
// before the game has attached a single handler (boot).

import {
  type Building,
  CityDamage,
  chunksOf,
  encodeChunkIds,
  solids,
} from "@angels-bandits/common/city";
import { CITY_SEED, WORLD_SIZE } from "@angels-bandits/common/constants";
import type { ServerMsg, WelcomeMsg } from "@angels-bandits/common/protocol";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameSocket } from "../src/net/socket";
import { CityRenderer } from "../src/render/city";

const city = new CityRenderer(CITY_SEED);
const buildings = city.cityBuildings as Building[];
const damage = new CityDamage();
city.attachDamage(damage);

/** A plain tower to break: no holes, one tier, a few chunks wide. */
const target = buildings.findIndex(
  (b) => !b.holes && b.tiers.length === 1 && b.width >= 40 && b.height >= 40,
);
const tower = buildings[target] as Building;

const matrixAt = (mesh: THREE.InstancedMesh, i: number) => {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  m.decompose(pos, new THREE.Quaternion(), scale);
  return { pos, scale };
};

describe("D2 damaged buildings in the city renderer", () => {
  it("draws a damaged building's live solids() 1:1 and hides its intact copy", () => {
    const ids = chunksOf(tower, target).slice(0, 5);
    for (const id of ids) damage.destroyChunk(id);
    const eye = { x: tower.x, y: 50, z: tower.z };
    city.update(eye);
    const boxes = solids(tower);
    const { mesh, start, used } = city.damagedSlots(target);
    expect(used).toBe(boxes.length);
    const subOff = mesh.geometry.getAttribute("aSubOff");
    boxes.forEach((s, k) => {
      const { pos, scale } = matrixAt(mesh, start + k);
      expect(scale.x).toBeCloseTo(s.width, 4);
      expect(scale.y).toBeCloseTo(s.height, 4);
      expect(scale.z).toBeCloseTo(s.depth, 4);
      expect(pos.x).toBeCloseTo(tower.x + s.dx, 3);
      expect(pos.y).toBeCloseTo(s.baseY, 4);
      expect(pos.z).toBeCloseTo(tower.z + s.dz, 3);
      expect(subOff.getW(start + k)).toBe(s.cut);
    });
    expect(mesh.count).toBeGreaterThanOrEqual(start + used);
    expect(city.baseHidden(target)).toBe(true);
  });

  it("keeps the intact copy hidden across a torus image flip", () => {
    // The camera crosses the building's half-world line: every instance of
    // it re-places at the other image.
    const far = { x: tower.x + WORLD_SIZE / 2 + 30, y: 50, z: tower.z };
    city.update(far);
    const i = (city as unknown as { first: Int32Array }).first[
      target
    ] as number;
    expect(matrixAt(city.mesh, i).scale.length()).toBe(0);
    // ...and the damaged copy moved to the new image.
    const { mesh, start } = city.damagedSlots(target);
    const s = solids(tower)[0];
    expect(matrixAt(mesh, start).pos.x).toBeCloseTo(
      tower.x + WORLD_SIZE + (s?.dx ?? 0),
      2,
    );
  });

  it("restores a building the destroyed set no longer names", () => {
    damage.reset([]);
    city.update({ x: tower.x, y: 50, z: tower.z });
    expect(city.baseHidden(target)).toBe(false);
    expect(city.damagedSlots(target).used).toBe(0);
    const i = (city as unknown as { first: Int32Array }).first[
      target
    ] as number;
    const { scale } = matrixAt(city.mesh, i);
    expect(scale.y).toBeCloseTo(tower.tiers[0]?.height ?? 0, 4);
  });

  it("grows the damaged mesh without losing a building", () => {
    // Break a chunk in 300 buildings: far past the initial capacity.
    for (let b = 0; b < 300; b++) {
      const id = chunksOf(buildings[b] as Building, b)[0];
      if (id !== undefined) damage.destroyChunk(id);
    }
    city.update({ x: 1000, y: 50, z: 1000 });
    for (let b = 0; b < 300; b++) {
      const { mesh, start, used } = city.damagedSlots(b);
      expect(used).toBe(solids(buildings[b] as Building).length);
      expect(start + used).toBeLessThanOrEqual(mesh.count);
    }
    damage.reset([]);
    city.update({ x: 1000, y: 50, z: 1000 });
  });
});

// --- The socket keeps chunks while the game boots -------------------------

type Listener = (ev: { data?: string }) => void;

/** Just enough of a browser WebSocket for GameSocket. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  private readonly listeners = new Map<string, Listener[]>();
  sent: string[] = [];
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
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
}

describe("D2 GameSocket keeps the destroyed set", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("applies chunks that arrive before any handler is attached", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", {
      hostname: "localhost",
      host: "localhost",
      protocol: "http:",
    });
    vi.stubGlobal("document", { hidden: false, addEventListener() {} });
    const [a, b, c] = chunksOf(buildings[2] as Building, 2);
    const connecting = GameSocket.connect("pilot");
    const ws = FakeSocket.last as FakeSocket;
    ws.emit("open");
    const welcome: WelcomeMsg = {
      type: "welcome",
      id: "me",
      roomId: "room-1",
      seed: CITY_SEED,
      spawn: { pos: { x: 0, y: 300, z: 0 }, yaw: 0, speed: 60 },
      roster: [],
      scores: [],
      botTarget: 0,
      cityEvents: [],
      resumeToken: "t",
      destroyed: encodeChunkIds([a as number]),
    };
    ws.emit("message", { data: JSON.stringify(welcome) });
    const socket = await connecting;
    // Booting: nothing in socket.events yet, and a batch arrives.
    const batch: ServerMsg = {
      type: "chunks",
      d: encodeChunkIds([b as number, c as number]),
    };
    ws.emit("message", { data: JSON.stringify(batch) });
    expect(socket.cityDamage.destroyedIds()).toEqual(
      [a, b, c].sort((x, y) => (x as number) - (y as number)),
    );
  });
});
