// DL1 Destruction Lab, client side. Deterministic replay: the lab clock
// scrubs, slows and steps, and whatever it lands on, the debris (piece
// poses → instance matrices) and the dust (puff buffers) drawn there are
// bit for bit what the live view drew at that instant, whichever way the
// scrub came — on lab-tuned debris and on the defaults. And the gate: only
// a welcome that says Destruction Lab makes this client a lab client (its
// collapse field builds stamped wires, its look leaves the defaults).

import {
  type Building,
  generateCity,
  makeBuilding,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  PANCAKE,
  TOPPLE,
  blankPose,
  buildCollapse,
  collapseWire,
  demolitionPlan,
  piecePose,
} from "@angels-bandits/common/city/collapse";
import { CITY_SEED } from "@angels-bandits/common/constants";
import {
  DEFAULT_DESTRUCTION_TUNING,
  sanitizeDestructionTuning,
} from "@angels-bandits/common/destruction-tuning";
import type { WelcomeMsg } from "@angels-bandits/common/protocol";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_STEP_MS, LabClock } from "../src/lab/lab-clock";
import { GameSocket } from "../src/net/socket";
import { pieceMatrix } from "../src/render/debris";
import { destructLook, setDestructLook } from "../src/render/destruct-look";

const SEED_CITY = generateCity(CITY_SEED);
const city = (): Building[] =>
  SEED_CITY.map((b) => makeBuilding({ ...b, damage: undefined }));
const TALL = SEED_CITY.map((b, i) => [b, i] as const)
  .filter(([b]) => !b.holes && b.height > 150)
  .map(([, i]) => i);

/** A felled tower's debris at t0 = 10 000 (lab-tuned or not). */
function felled(style: number, tuned: boolean): Collapse {
  const c = city();
  const i = TALL[0] as number;
  const plan = demolitionPlan(c[i] as Building, i, style as 0 | 1, 1);
  if (!plan) throw new Error("no plan");
  const t = tuned
    ? sanitizeDestructionTuning({ gravity: 15, slabStorey: 6, toppleK: 2 })
    : DEFAULT_DESTRUCTION_TUNING;
  const out = buildCollapse(c, collapseWire(plan, i, 3, 10_000), t);
  if (!out) throw new Error("no collapse");
  return out;
}

/** Every piece's instance matrix at `t` (what the debris mesh draws). */
function matrices(c: Collapse, t: number): Float64Array {
  const pose = blankPose();
  const m = new THREE.Matrix4();
  const out = new Float64Array(c.n * 16);
  for (let i = 0; i < c.n; i++) {
    pieceMatrix(piecePose(c, i, t, pose), 0, 0, m);
    out.set(m.elements, i * 16);
  }
  return out;
}

describe("DL1 the lab clock", () => {
  it("follows the live clock until paused, slowed or scrubbed", () => {
    const k = new LabClock();
    expect(k.frame(1000, 0.016)).toBe(1000);
    expect(k.frame(1016, 0.016)).toBe(1016);
    k.togglePause();
    expect(k.frame(1100, 0.016)).toBe(1016);
    expect(k.isLive).toBe(false);
    k.togglePause();
    // Playing again at full speed: it runs on and catches the live clock.
    expect(k.frame(1200, 0.05)).toBe(1066);
    expect(k.frame(1210, 1)).toBe(1210);
    expect(k.isLive).toBe(true);
  });

  it("slow motion runs at its speed, never ahead of live", () => {
    const k = new LabClock();
    k.frame(5000, 0.016);
    k.setSpeed(0.25);
    expect(k.frame(6000, 1)).toBe(5250);
    k.setSpeed(0.01);
    expect(k.speed).toBe(0.1);
    k.goLive();
    expect(k.frame(7000, 0.016)).toBe(7000);
  });

  it("scrubs and frame-steps, holding still and never past live", () => {
    const k = new LabClock();
    k.frame(20_000, 0.016);
    k.scrub(12_345, 20_000);
    expect(k.frame(20_100, 0.5)).toBe(12_345);
    k.step(1, 20_100);
    expect(k.viewMs).toBe(12_345 + FRAME_STEP_MS);
    k.step(-3, 20_100);
    expect(k.viewMs).toBeCloseTo(12_345 - 2 * FRAME_STEP_MS, 9);
    k.scrub(99_999, 20_100);
    expect(k.viewMs).toBe(20_100);
  });
});

describe("DL1 deterministic replay: scrubbing to t draws what live drew at t", () => {
  for (const [name, style, tuned] of [
    ["lab-tuned topple", TOPPLE, true],
    ["default pancake", PANCAKE, false],
  ] as const) {
    it(`${name}: debris matrices and dust buffers`, async () => {
      const c = felled(style, tuned);
      // A DustClouds without a 2D canvas (the bench's shim: the sprite
      // stays blank; nothing measured reads it).
      vi.stubGlobal("document", {
        createElement: () => ({ width: 0, height: 0, getContext: () => null }),
      });
      const { DustClouds } = await import("../src/render/dust");
      const viewer = { x: c.x + 260, y: 60, z: c.z + 120 };
      const times = [9_000, 10_500, 12_000, 14_200, 17_800, 23_000, 40_000];
      // Live: the clock simply follows.
      const live = new DustClouds();
      const liveClock = new LabClock();
      const recorded = new Map<number, { m: Float64Array; d: Float32Array }>();
      for (const t of times) {
        const view = liveClock.frame(t, 0.016) as number;
        live.update([c], viewer, view);
        const n = live.puffCount;
        const pos = live.points.geometry.getAttribute("position")
          .array as Float32Array;
        const alpha = live.points.geometry.getAttribute("aAlpha")
          .array as Float32Array;
        const d = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          d.set(pos.subarray(i * 3, i * 3 + 3), i * 4);
          d[i * 4 + 3] = alpha[i] as number;
        }
        recorded.set(t, { m: matrices(c, view), d });
      }
      // Not vacuous: the cloud is up and pieces moved between the frames.
      expect(
        Math.max(...[...recorded.values()].map((r) => r.d.length)),
      ).toBeGreaterThan(200);
      expect(recorded.get(12_000)?.m).not.toEqual(recorded.get(9_000)?.m);
      // Scrubbed, out of order, on a clock that went further first.
      const scrubbed = new DustClouds();
      const k = new LabClock();
      k.frame(60_000, 0.016);
      for (const t of [...times].reverse()) {
        k.scrub(t, 60_000);
        const view = k.frame(60_000, 0.016) as number;
        expect(view).toBe(t);
        scrubbed.update([c], viewer, view);
        const rec = recorded.get(t);
        expect(matrices(c, view)).toEqual(rec?.m);
        const n = scrubbed.puffCount;
        const pos = scrubbed.points.geometry.getAttribute("position")
          .array as Float32Array;
        const alpha = scrubbed.points.geometry.getAttribute("aAlpha")
          .array as Float32Array;
        const d = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          d.set(pos.subarray(i * 3, i * 3 + 3), i * 4);
          d[i * 4 + 3] = alpha[i] as number;
        }
        expect(d).toEqual(rec?.d);
      }
      vi.unstubAllGlobals();
    });
  }
});

type Listener = (ev: { data?: string }) => void;

class FakeSocket {
  static last: FakeSocket | null = null;
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data?: unknown) {
    const ev = data === undefined ? {} : { data: JSON.stringify(data) };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close() {}
}

const welcome = (extra: Partial<WelcomeMsg>): WelcomeMsg =>
  ({
    type: "welcome",
    id: "me",
    roomId: "room-1",
    seed: 42,
    spawn: { pos: { x: 0, y: 300, z: 0 }, yaw: 0, speed: 60 },
    roster: [],
    scores: [],
    intensity: 1,
    waves: [0, 0, 0, 0, 0, 0],
    cityEvents: [],
    resumeToken: "tok",
    destroyed: [],
    collapses: [],
    courses: [],
    ...extra,
  }) as unknown as WelcomeMsg;

describe("DL1 lab-only on the client", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", {
      hostname: "localhost",
      host: "localhost",
      protocol: "http:",
    });
    vi.stubGlobal("document", { hidden: false, addEventListener() {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const join = async (
    lab: boolean,
    destruct: boolean,
    reply: Partial<WelcomeMsg>,
  ) => {
    const joining = GameSocket.connect("Ace", undefined, lab, destruct);
    const ws = FakeSocket.last as FakeSocket;
    ws.emit("open");
    ws.emit("message", welcome(reply));
    return { socket: await joining, sent: ws.sent };
  };

  it("a Destruction Lab join says so; only its welcome makes a lab field", async () => {
    const a = await join(true, true, { lab: true, destruct: true });
    expect(a.sent[0]).toEqual({
      type: "join",
      name: "Ace",
      lab: true,
      destruct: true,
    });
    expect(a.socket.destruct).toBe(true);
    expect(a.socket.collapses.lab).toBe(true);
  });

  it("a normal or Flight Lab welcome never does — whatever was asked", async () => {
    for (const reply of [
      {},
      { lab: true as const },
      { destruct: true as const },
    ]) {
      const s = await join(true, true, reply);
      expect(s.socket.destruct).toBe(false);
      expect(s.socket.collapses.lab).toBe(false);
    }
    const normal = await join(false, false, {});
    expect(normal.sent[0]?.destruct).toBeUndefined();
    expect(normal.socket.collapses.lab).toBe(false);
  });

  it("the renderers' look is the defaults until the lab sets it", () => {
    expect({ ...destructLook }).toEqual({ ...DEFAULT_DESTRUCTION_TUNING });
    setDestructLook(sanitizeDestructionTuning({ dustOpacity: 0.3 }));
    expect(destructLook.dustOpacity).toBe(0.3);
    setDestructLook(DEFAULT_DESTRUCTION_TUNING);
    expect({ ...destructLook }).toEqual({ ...DEFAULT_DESTRUCTION_TUNING });
  });
});
