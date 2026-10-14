// DL1: the collapse hot path stays (near) allocation-free — D2's check
// (common/test/destruction.test.ts) applied to what runs every frame while
// towers come down: posing every piece on the frame's clock (the debris
// mesh's and the crash check's seam), the collision probe against the
// falling debris, and the dust cloud's whole update — on lab-tuned debris
// and on the defaults. Before DL1 the dust alone allocated ~78 KB a frame
// (a closure per puff per frame); tools/destruction-bench.ts has the
// per-entry figures, this is the committed guard.

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
  collideCollapses,
  demolitionPlan,
  posePieceNow,
  setPoseClock,
} from "@angels-bandits/common/city/collapse";
import { CITY_SEED, PLAYER_RADIUS } from "@angels-bandits/common/constants";
import {
  DEFAULT_DESTRUCTION_TUNING,
  sanitizeDestructionTuning,
} from "@angels-bandits/common/destruction-tuning";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SEED_CITY = generateCity(CITY_SEED);
const T0 = 50_000;

function collapses(): Collapse[] {
  const city = SEED_CITY.map((b) => makeBuilding({ ...b, damage: undefined }));
  const tall = city
    .map((b, i) => [b, i] as const)
    .filter(([b]) => !b.holes && b.height > 120)
    .slice(0, 4)
    .map(([, i]) => i);
  const lab = sanitizeDestructionTuning({ gravity: 14, slabStorey: 3 });
  const out: Collapse[] = [];
  tall.forEach((i, k) => {
    const style = k % 2 === 0 ? TOPPLE : PANCAKE;
    const plan = demolitionPlan(city[i] as Building, i, style, 1);
    if (!plan) return;
    const c = buildCollapse(
      city,
      collapseWire(plan, i, k + 1, T0 + k * 400),
      k < 2 ? lab : DEFAULT_DESTRUCTION_TUNING,
    );
    if (c) out.push(c);
  });
  return out;
}

describe("DL1 the collapse hot path stays allocation-free", () => {
  beforeAll(() => {
    vi.stubGlobal("document", {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  it("posing, the collision probe and the dust update, frame after frame", async () => {
    const { DustClouds } = await import("../src/render/dust");
    const list = collapses();
    expect(list.length).toBe(4);
    const dust = new DustClouds();
    const pose = blankPose();
    const viewer = { x: 0, y: 40, z: 0 };
    const probe = { x: 0, y: 0, z: 0 };
    const first = list[0] as Collapse;
    let sink = 0;
    const frame = (f: number) => {
      // Round and round the collapses' busiest 20 s (falling debris,
      // the surge, the curtain, the plumes).
      const t = T0 + 1500 + (f % 1200) * (1000 / 60);
      viewer.x = first.x + 240 + 30 * Math.sin(f / 50);
      viewer.z = first.z + 90;
      setPoseClock(t);
      for (let e = 0; e < list.length; e++) {
        const c = list[e] as Collapse;
        for (let i = 0; i < c.n; i++) sink += posePieceNow(c, i, pose).y;
      }
      for (let k = 0; k < 8; k++) {
        probe.x = first.x + 30 * Math.cos(k + f / 20);
        probe.y = 10 + k * 15;
        probe.z = first.z + 30 * Math.sin(k + f / 20);
        if (collideCollapses(probe, PLAYER_RADIUS, list, t, true)) sink++;
      }
      dust.update(list, viewer, t);
    };
    // Warm: the clouds and caches built, the code optimised.
    for (let f = 0; f < 900; f++) frame(f);
    const FRAMES = 3000;
    const before = process.memoryUsage().heapUsed;
    for (let f = 900; f < 900 + FRAMES; f++) frame(f);
    const grown = process.memoryUsage().heapUsed - before;
    expect(sink).not.toBe(0);
    expect(dust.puffCount).toBeGreaterThan(0);
    // The old dust (~78 KB a frame) would read ~230 MB here; what is left
    // is three's update-range list and its attribute setters (~0.5 KB a
    // frame in the bench). The bound (1 KB a frame) leaves room for V8/GC
    // noise between machines while catching any per-puff allocation.
    expect(grown).toBeLessThan(FRAMES * 1024);
  });
});
