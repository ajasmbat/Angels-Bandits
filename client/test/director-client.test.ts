// D5 on the client: the socket applies a rebuild ON ARRIVAL, in message
// order — so a `chunks` batch the server sent after the rebuild leaves its
// hole here too (no client-clock race) — holds the director's warnings from
// the welcome and live, and a damaged building's scaffolding and rebuild
// crane (cosmetic, never solid) stay where no plane can be without hitting
// something solid first.

import {
  CityDamage,
  chunkId,
  encodeChunkIds,
  generateCity,
  makeBuilding,
  standingProfile,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  PANCAKE,
  TOPPLE,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import { CITY_SEED } from "@angels-bandits/common/constants";
import {
  type DirectorEvent,
  EVENT_GAS,
  encodeDirectorEvent,
} from "@angels-bandits/common/director";
import type { ServerMsg, WelcomeMsg } from "@angels-bandits/common/protocol";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameSocket } from "../src/net/socket";
import {
  CRANE_ABOVE_ROOF,
  type DressBox,
  SCAFFOLD_OUT,
  STRIP_MS,
  ScaffoldRenderer,
  scaffoldBoxes,
} from "../src/render/scaffold";

const city = generateCity(CITY_SEED);
const tower = city.findIndex((b) => {
  const g = tierGrids(b)[0];
  return !b.holes && !!g && g.nx >= 2 && g.nz >= 2 && b.height >= 80;
});

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
          this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter((f) => f !== wrapped),
          );
          fn(ev);
        }
      : fn;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }
  emit(type: string, ev: { data?: string } = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  send() {}
  close() {}
}

async function join(
  destroyed: number[],
  director: DirectorEvent[] = [],
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
    botTarget: 0,
    cityEvents: [],
    resumeToken: "t",
    destroyed: encodeChunkIds(destroyed),
    collapses: [],
    courses: [],
    director: director.map(encodeDirectorEvent),
  } as unknown as WelcomeMsg;
  ws.emit("message", { data: JSON.stringify(welcome) });
  return { socket: await connecting, ws };
}

const send = (ws: FakeSocket, msg: ServerMsg) =>
  ws.emit("message", { data: JSON.stringify(msg) });

describe("D5 GameSocket", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("applies a rebuild on arrival, so a later chunks batch leaves its hole", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", {
      hostname: "localhost",
      host: "localhost",
      protocol: "http:",
    });
    vi.stubGlobal("document", { hidden: false, addEventListener() {} });

    const a = chunkId(tower, 0, 0);
    const b = chunkId(tower, 0, 1);
    const { socket, ws } = await join([a]);
    const buildings = city.map((x) =>
      makeBuilding({ ...x, damage: undefined }),
    );
    socket.cityDamage.bind(buildings);
    socket.collapses.bind(buildings);
    const seen: { go: boolean; restored: readonly number[] }[] = [];
    socket.events.onRebuild = (r, restored) =>
      seen.push({ go: r.go, restored });

    // The announce is cosmetic: nothing changes.
    send(ws, { type: "rebuild", r: { k: 0, b: tower, at: 5000, go: false } });
    expect(socket.cityDamage.isDestroyed(a)).toBe(true);
    // The apply: whole again, at once, whatever the render clock says.
    send(ws, { type: "rebuild", r: { k: 0, b: tower, at: 5000, go: true } });
    expect(socket.cityDamage.isDestroyed(a)).toBe(false);
    expect(buildings[tower]?.damage).toBeUndefined();
    // The server broke another chunk right after: it stays broken here.
    send(ws, { type: "chunks", d: encodeChunkIds([b]) });
    expect(socket.cityDamage.destroyedIds()).toEqual([b]);
    expect(seen).toEqual([
      { go: false, restored: [] },
      { go: true, restored: [a] },
    ]);
  });

  it("holds the director's warnings from the welcome and live", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", {
      hostname: "localhost",
      host: "localhost",
      protocol: "http:",
    });
    vi.stubGlobal("document", { hidden: false, addEventListener() {} });
    const e: DirectorEvent = {
      id: 4,
      k: EVENT_GAS,
      b: -1,
      x: 400,
      y: 0,
      z: 815.5,
      s: 0,
      d: 0,
      w: 1000,
      at: 4500,
      zone: { x0: -46, x1: 46, z0: -46, z1: 46, top: 81 },
    };
    const { socket, ws } = await join([], [e]);
    expect(socket.director.get(4)).toEqual(e);
    const warned: DirectorEvent[] = [];
    socket.events.onDirectorWarn = (x) => warned.push(x);
    const next = { ...e, id: 5, w: 9000, at: 12_500 };
    send(ws, { type: "directorWarn", e: encodeDirectorEvent(next) });
    expect(warned).toEqual([next]);
    expect([...socket.director.keys()]).toEqual([4, 5]);
  });
});

describe("D5 scaffolding and the rebuild crane", () => {
  it("hug the facades (≤ SCAFFOLD_OUT), keep off hole mouths, and keep the crane inside the footprint", () => {
    const out: DressBox[] = [];
    let holed = 0;
    for (const b of city) {
      const g = tierGrids(b)[0];
      if (!g) continue;
      const hw = g.width / 2;
      const hd = g.depth / 2;
      scaffoldBoxes(b, out);
      expect(out.length).toBeGreaterThan(0);
      for (const box of out) {
        const x0 = box.x - box.w / 2;
        const x1 = box.x + box.w / 2;
        const z0 = box.z - box.d / 2;
        const z1 = box.z + box.d / 2;
        if (box.part === 2) {
          // The crane: inside the footprint, under roof + CRANE_ABOVE_ROOF.
          expect(x0).toBeGreaterThanOrEqual(-hw - 1e-6);
          expect(x1).toBeLessThanOrEqual(hw + 1e-6);
          expect(z0).toBeGreaterThanOrEqual(-hd - 1e-6);
          expect(z1).toBeLessThanOrEqual(hd + 1e-6);
          expect(box.y + box.h / 2).toBeLessThanOrEqual(
            b.height + CRANE_ABOVE_ROOF + 1e-6,
          );
          continue;
        }
        // Scaffolding: outside the facade, within SCAFFOLD_OUT of it.
        const outside =
          x1 <= -hw + 1e-6 ||
          x0 >= hw - 1e-6 ||
          z1 <= -hd + 1e-6 ||
          z0 >= hd - 1e-6;
        expect(outside).toBe(true);
        expect(x0).toBeGreaterThanOrEqual(-hw - SCAFFOLD_OUT - 1e-6);
        expect(x1).toBeLessThanOrEqual(hw + SCAFFOLD_OUT + 1e-6);
        expect(z0).toBeGreaterThanOrEqual(-hd - SCAFFOLD_OUT - 1e-6);
        expect(z1).toBeLessThanOrEqual(hd + SCAFFOLD_OUT + 1e-6);
        expect(box.y - box.h / 2).toBeGreaterThanOrEqual(-1e-6);
        expect(box.y + box.h / 2).toBeLessThanOrEqual(g.height + 1e-6);
        // Never on a face a hole opens on below the scaffold's top.
        for (const h of b.holes ?? []) {
          if (h.y0 >= box.y + box.h / 2) continue;
          const xFace = x1 <= -hw + 1e-6 || x0 >= hw - 1e-6;
          expect(xFace).toBe(h.axis !== "x");
          holed++;
        }
      }
    }
    expect(holed).toBeGreaterThan(0);
  });
});

describe("D8 scaffolding follows what stands", () => {
  const top = (box: DressBox) => box.y + box.h / 2;

  it("wraps only a felled tower's stump, and its crane stands sized to it", () => {
    for (const style of [TOPPLE, PANCAKE]) {
      const fresh = generateCity(CITY_SEED);
      const damage = new CityDamage();
      damage.bind(fresh);
      const b = fresh[tower] as (typeof fresh)[number];
      const plan = demolitionPlan(b, tower, style, 1);
      expect(plan).not.toBeNull();
      damage.collapse((plan as NonNullable<typeof plan>).chunks);
      const stump = Math.max(0, ...standingProfile(b).stump);
      const out = scaffoldBoxes(b, []);
      const crane = out.filter((x) => x.part === 2);
      expect(crane.length).toBeGreaterThan(0);
      for (const box of out) {
        expect(box.y - box.h / 2).toBeGreaterThanOrEqual(-1e-6);
        if (box.part === 2) {
          expect(top(box)).toBeLessThanOrEqual(stump + CRANE_ABOVE_ROOF + 1e-6);
        } else {
          expect(top(box)).toBeLessThanOrEqual(stump + 1e-6);
        }
      }
      // The generated tower's cage and mast are gone.
      expect(Math.max(...out.map(top))).toBeLessThan(b.height * 0.6);
      if (style === PANCAKE) {
        expect(out.every((x) => x.part === 2)).toBe(true);
      }
    }
  });

  it("lands a rebuilt tower inside its scaffold, then strips it top-down", () => {
    const fresh = generateCity(CITY_SEED);
    const damage = new CityDamage();
    damage.bind(fresh);
    const b = fresh[tower] as (typeof fresh)[number];
    const plan = demolitionPlan(b, tower, TOPPLE, 1);
    damage.collapse((plan as NonNullable<typeof plan>).chunks);
    const r = new ScaffoldRenderer(fresh, "high");
    const cam = { x: b.x + 120, y: 60, z: b.z };
    r.update(cam, damage.version, 0);
    const dressed = r.mesh.count;
    expect(dressed).toBeGreaterThan(0);
    const highest = (): number => {
      let hi = 0;
      const m = new THREE.Matrix4();
      for (let i = 0; i < r.mesh.count; i++) {
        r.mesh.getMatrixAt(i, m);
        const e = m.elements;
        hi = Math.max(hi, (e[13] as number) + (e[5] as number) / 2);
      }
      return hi;
    };
    const before = highest();
    damage.restoreBuilding(tower);
    r.rebuilt(tower, 1000);
    let last = Number.POSITIVE_INFINITY;
    for (const t of [1000, 1800, 2600, 3400]) {
      r.update(cam, damage.version, t);
      const hi = highest();
      expect(hi).toBeLessThanOrEqual(last + 1e-6);
      last = hi;
    }
    // At the restore it stands around the whole tower, not the stump.
    r.update(cam, damage.version, 1000);
    expect(highest()).toBeGreaterThan(before);
    r.update(cam, damage.version, 1000 + STRIP_MS + 1);
    expect(r.mesh.count).toBe(0);
  });
});
