// DS1 the debris physics, in Node against Rapier's WASM: where the columns
// fail decides how the tower comes down (pancake vs lean), it really comes
// down, settled pieces freeze, the moving-body budget is never passed, and
// the plane collides with exactly the bodies the page draws — the frame the
// worker transfers, ingested on the page, poses the same boxes the host's
// bots collide with.

import {
  type Building,
  chunkId,
  makeBuilding,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  type CollapseWire,
  PANCAKE,
  TOPPLE,
  blankPose,
  collideCollapses,
  piecePose,
  setPoseClock,
} from "@angels-bandits/common/city/collapse";
import { cellIndex } from "@angels-bandits/common/city/destruction";
import {
  PIECE_FROZEN,
  PhysRegistry,
  heapHeight,
  pieceMoving,
} from "@angels-bandits/common/city/physpose";
import { FACE_POS_X } from "@angels-bandits/common/city/structure";
import { PLAYER_RADIUS } from "@angels-bandits/common/constants";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DebrisPhysics,
  PHYS_LOD_M,
  initDebrisPhysics,
} from "../src/debris-physics";
import {
  type RoomCity,
  createRoomCity,
  setRoomPhysics,
  tickDestruction,
} from "../src/destruction";
import type { PhysicsFrame } from "../src/physics-port";

/** A plain 3 × 3-bay, 10-band, 120 m tower and a neighbour across a 12 m
 * street on its +x side. */
function block(): Building[] {
  return [
    makeBuilding({
      x: 500,
      z: 500,
      width: 60,
      depth: 60,
      height: 120,
      tiers: [{ width: 60, depth: 60, height: 120 }],
    }),
    makeBuilding({
      x: 572,
      z: 500,
      width: 60,
      depth: 60,
      height: 80,
      tiers: [{ width: 60, depth: 60, height: 80 }],
    }),
  ];
}

const T0 = 1_000_000;
const TICK = 50;

interface Run {
  city: RoomCity;
  physics: DebrisPhysics;
  wires: CollapseWire[];
  frames: PhysicsFrame[];
  t: number;
  /** The most moving bodies seen after any tick. */
  peak: number;
  /** The tower's first collapse, tick by tick: when, its top and its
   * pieces' mean x (from the building's centre). */
  track: { t: number; top: number; cx: number }[];
}

/** Shoot out band 3 of the tower where `gone(ix, iz)`, then run the room
 * (its physics on) for `seconds`. */
function run(
  gone: (ix: number, iz: number) => boolean,
  seconds: number,
  budget = 400,
): Run {
  const city = createRoomCity(block());
  const physics = new DebrisPhysics(city, { x: 500, z: 500, budget });
  setRoomPhysics(city, physics);
  const b = city.buildings[0] as Building;
  const g = tierGrids(b)[0];
  if (!g) throw new Error("no grid");
  for (let ix = 0; ix < 3; ix++) {
    for (let iz = 0; iz < 3; iz++) {
      if (gone(ix, iz))
        city.damage.destroyChunk(chunkId(0, 0, cellIndex(g, ix, 3, iz)));
    }
  }
  const out: Run = {
    city,
    physics,
    wires: [],
    frames: [],
    t: T0,
    peak: 0,
    track: [],
  };
  for (let k = 0; k < (seconds * 1000) / TICK; k++) {
    out.t += TICK;
    const r = tickDestruction(city, out.t);
    out.wires.push(...r.collapses);
    const f = physics.takeFrame();
    if (f)
      out.frames.push({
        ...f,
        data: f.data.slice(),
        heaps: f.heaps?.slice() ?? null,
      });
    out.peak = Math.max(out.peak, physics.active);
    const first = towerCollapses(out)[0];
    if (first?.phys) out.track.push({ t: out.t, ...extent(first, out.t) });
  }
  return out;
}

/** The tower's collapses (the ones physics took). */
const towerCollapses = (r: Run): Collapse[] =>
  r.city.collapses.list.filter((c) => c.building === 0);

/** Highest point and plan centroid of a collapse's pieces at `t`. */
function extent(c: Collapse, t: number): { top: number; cx: number } {
  const p = blankPose();
  let top = Number.NEGATIVE_INFINITY;
  let cx = 0;
  for (let i = 0; i < c.n; i++) {
    piecePose(c, i, t, p);
    // A rotated box's highest corner: its centre plus each local axis's
    // vertical share of its half extent.
    const xy = 2 * (p.qx * p.qy + p.qw * p.qz);
    const yy = 1 - 2 * (p.qx * p.qx + p.qz * p.qz);
    const zy = 2 * (p.qy * p.qz - p.qw * p.qx);
    const reach =
      Math.abs(xy) * p.hx + Math.abs(yy) * p.hy + Math.abs(zy) * p.hz;
    top = Math.max(top, p.y + reach);
    cx += p.x;
  }
  return { top, cx: cx / c.n };
}

beforeAll(async () => {
  await initDebrisPhysics();
});

describe("DS1 where the columns fail decides how it comes down", () => {
  it("a floor shot out evenly pancakes: floor after floor, down to a low pile", () => {
    const r = run(() => true, 45);
    expect(r.wires.length).toBeGreaterThan(0);
    expect(r.wires[0]?.s).toBe(PANCAKE);
    const cs = towerCollapses(r);
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) {
      expect(c.phys).not.toBeNull();
      // The whole 120 m tower is down to a pile.
      expect(extent(c, r.t).top).toBeLessThan(30);
    }
    // It went floor by floor: the top was still high well after it began,
    // and came down over seconds, not in one drop.
    const first = cs[0] as Collapse;
    const at = (ms: number) =>
      r.track.find((k) => k.t >= first.t0 + ms)?.top ?? Number.NaN;
    expect(at(3000)).toBeGreaterThan(60);
    const low = r.track.find((k) => k.top < 30);
    expect(low).toBeDefined();
    expect((low?.t ?? 0) - first.t0).toBeGreaterThan(4000);
  });

  it("columns gone on one side lean it over that side, and it comes down", () => {
    const r = run((ix) => ix >= 1, 45);
    expect(r.wires[0]?.s).toBe(TOPPLE);
    expect(r.wires[0]?.d).toBe(FACE_POS_X);
    const c = towerCollapses(r)[0] as Collapse;
    expect(c.phys).not.toBeNull();
    const before = r.track[0];
    if (!before) throw new Error("no poses");
    const after = extent(c, r.t);
    // Over toward +x, and down.
    expect(after.cx).toBeGreaterThan(before.cx + 5);
    expect(after.top).toBeLessThan(before.top * 0.6);
    // On the way it struck the neighbour: chain impacts from contacts.
    const neighbour = r.city.buildings[1] as Building;
    expect(neighbour.damage?.count ?? 0).toBeGreaterThan(0);
  });
});

describe("DS1 settling, budgets and LOD", () => {
  it("settled pieces freeze into rubble and stay put, with a flyable heap", () => {
    const r = run(() => true, 50);
    for (const c of towerCollapses(r)) {
      const phys = c.phys;
      if (!phys) throw new Error("not physical");
      expect(phys.settled).toBe(true);
      for (let i = 0; i < c.n; i++) {
        expect(phys.state(i, r.t)).toBe(PIECE_FROZEN);
      }
      const heap = phys.heap;
      if (!heap) throw new Error("no heap");
      expect(heap.top).toBeGreaterThan(0);
      expect(heap.top).toBeLessThanOrEqual(6);
      // Zero at its rim, so it meets the street.
      expect(heapHeight(heap, heap.x0, heap.z0)).toBe(0);
    }
    // Nothing moves once settled.
    const c = towerCollapses(r)[0] as Collapse;
    const a = blankPose();
    const b = blankPose();
    piecePose(c, 3, r.t, a);
    r.physics.step(r.t + 5000);
    piecePose(c, 3, r.t + 5000, b);
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
    expect(r.physics.active).toBe(0);
  });

  it("never has more moving bodies than its budget", () => {
    for (const budget of [400, 80, 24]) {
      const r = run(() => true, 25, budget);
      expect(r.peak).toBeLessThanOrEqual(budget);
      expect(r.physics.peakActive).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps a collapse far from the camera analytic", () => {
    const city = createRoomCity(block());
    const physics = new DebrisPhysics(city, {
      x: 500 + PHYS_LOD_M + 200,
      z: 500,
      budget: 400,
    });
    setRoomPhysics(city, physics);
    const g = tierGrids(city.buildings[0] as Building)[0];
    if (!g) throw new Error("no grid");
    for (let c = 0; c < 9; c++) {
      city.damage.destroyChunk(chunkId(0, 0, 3 * g.nx * g.nz + c));
    }
    tickDestruction(city, T0);
    const cs = towerCollapses({ city } as Run);
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) expect(c.phys).toBeNull();
  });

  it("multiplayer (no physics) keeps the closed-form collapses", () => {
    const city = createRoomCity(block());
    const g = tierGrids(city.buildings[0] as Building)[0];
    if (!g) throw new Error("no grid");
    for (let c = 0; c < 9; c++) {
      city.damage.destroyChunk(chunkId(0, 0, 3 * g.nx * g.nz + c));
    }
    const r = tickDestruction(city, T0);
    expect(r.collapses.length).toBeGreaterThan(0);
    for (const c of city.collapses.list) expect(c.phys).toBeNull();
  });
});

describe("DS1 draw == collide with the physics", () => {
  it("the plane hits the falling bodies the page draws, from the same frames", () => {
    const r = run((ix) => ix >= 1, 6);
    const host = towerCollapses(r)[0] as Collapse;
    // The page: its own field (built from the same wires) and registry,
    // fed the frames exactly as the worker transferred them.
    const page = createRoomCity(block());
    const registry = new PhysRegistry();
    page.collapses.attachPhysics(registry);
    page.collapses.reset(r.city.collapses.records);
    for (const f of r.frames) registry.ingest(f.t, f.epoch, f.data, f.heaps);
    const drawn = page.collapses.list.find((c) => c.id === host.id);
    if (!drawn?.phys) throw new Error("the page has no poses");
    // Mid-fall, at a render clock between two frames.
    const t = (r.frames.at(-20)?.t ?? 0) + 23;
    const p = blankPose();
    const q = blankPose();
    let moving = 0;
    setPoseClock(t);
    for (let i = 0; i < drawn.n; i++) {
      piecePose(drawn, i, t, p);
      piecePose(host, i, t, q);
      // The page draws what the host's bots collide with.
      expect(p.x).toBe(q.x);
      expect(p.y).toBe(q.y);
      expect(p.qw).toBe(q.qw);
      if (!pieceMoving(drawn.phys.state(i, t))) continue;
      moving++;
      // A sphere where the piece is drawn hits it — falling debris…
      const at = { x: drawn.x + p.x, y: p.y, z: drawn.z + p.z };
      const hit = collideCollapses(at, PLAYER_RADIUS, [drawn], t);
      expect(hit?.falling).toBe(true);
    }
    expect(moving).toBeGreaterThan(0);
    // …and one well clear of every piece does not.
    const clear = { x: drawn.x, y: drawn.phys.bounds.y1 + 60, z: drawn.z };
    expect(collideCollapses(clear, PLAYER_RADIUS, [drawn], t)).toBeNull();
  });
});
