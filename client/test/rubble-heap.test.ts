// G9: a pancaked tower lies as a HEAP, not a cake of storeys — its plates
// tilted at a spread of angles on a mound no steeper than the angle of
// repose — and the heap the renderer draws is exactly the one the crash
// check collides with, at every height it rises through.

import {
  type Building,
  generateCity,
  makeBuilding,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  PANCAKE,
  ROLE_SLAB,
  buildCollapse,
  collapseWire,
  collideCollapses,
  demolitionPlan,
  heapShareAt,
} from "@angels-bandits/common/city/collapse";
import {
  type RubbleHeap,
  heapHeight,
  sphereHitsHeap,
} from "@angels-bandits/common/city/physpose";
import { REPOSE_MAX_DEG } from "@angels-bandits/common/city/repose";
import { CITY_SEED } from "@angels-bandits/common/constants";
import type * as THREE from "three";
import { describe, expect, it } from "vitest";
import { RubbleHeaps, heapGeometry } from "../src/render/rubble-heap";

const city = generateCity(CITY_SEED).map((b) =>
  makeBuilding({ ...b, damage: undefined }),
);
/** The planner's ruin-detail tower (a 293 m pancake), felled. */
const TOWER = 159;

function pancake(id: number, t0: number): Collapse {
  const plan = demolitionPlan(city[TOWER] as Building, TOWER, PANCAKE, 0);
  if (!plan) throw new Error("no plan");
  const c = buildCollapse(city, collapseWire(plan, TOWER, id, t0));
  if (!c) throw new Error("no debris");
  return c;
}

const DEG = 180 / Math.PI;

/** The drawn mesh's height at (x, z) (centre-relative): the triangle of
 * the geometry's index buffer that holds the point, interpolated — what a
 * ray straight down would meet. NaN where no drawn triangle is. */
function drawnHeight(geo: THREE.BufferGeometry, x: number, z: number): number {
  const pos = geo.getAttribute("position");
  const index = geo.getIndex();
  if (!index) throw new Error("no index");
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    const ax = pos.getX(a);
    const az = pos.getZ(a);
    const bx = pos.getX(b);
    const bz = pos.getZ(b);
    const cx = pos.getX(c);
    const cz = pos.getZ(c);
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const w = 1 - u - v;
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
    return u * pos.getY(a) + v * pos.getY(b) + w * pos.getY(c);
  }
  return Number.NaN;
}

describe("G9 a pancake lies as a heap", () => {
  const c = pancake(41, 10_000);

  it("its plates lie at a spread of angles, not flat — on a mound no steeper than the angle of repose", () => {
    const tilts: number[] = [];
    for (let i = 0; i < c.n; i++) {
      if (c.role[i] === ROLE_SLAB) tilts.push(Math.abs(c.rphi[i] as number));
    }
    expect(tilts.length).toBeGreaterThan(1000);
    const share = (lo: number, hi: number) =>
      tilts.filter((t) => t * DEG >= lo && t * DEG < hi).length / tilts.length;
    // Not all horizontal: most lie tilted, every band from flat-ish to the
    // pile's own slope and past it is filled, and the spread is wide.
    expect(share(0, 3)).toBeLessThan(0.25);
    for (const [lo, hi] of [
      [3, 10],
      [10, 20],
      [20, 30],
      [30, 50],
    ] as const) {
      expect(share(lo, hi), `${lo}–${hi}°`).toBeGreaterThan(0.03);
    }
    const mean = tilts.reduce((s, t) => s + t, 0) / tilts.length;
    const sd = Math.sqrt(
      tilts.reduce((s, t) => s + (t - mean) ** 2, 0) / tilts.length,
    );
    expect(mean * DEG).toBeGreaterThan(8);
    expect(sd * DEG).toBeGreaterThan(5);
    // A heap, not a stack: wider at its base than the lot, its crest lower
    // than the stack it slumped from was, its flanks at the angle of repose.
    const heap = c.heap as RubbleHeap;
    expect(heap).not.toBeNull();
    const b = city[TOWER] as Building;
    expect(heap.nx * heap.cell).toBeGreaterThan(b.width + 20);
    expect(heap.top).toBeGreaterThan(5);
    let steepest = 0;
    const row = heap.nx + 1;
    // The mound's slope, over the cells away from its knocks: the run of
    // its flanks averaged over three cells.
    for (let j = 0; j <= heap.nz; j++) {
      for (let k = 0; k + 3 <= heap.nx; k++) {
        const d =
          Math.abs(
            (heap.h[j * row + k + 3] as number) -
              (heap.h[j * row + k] as number),
          ) /
          (3 * heap.cell);
        steepest = Math.max(steepest, d);
      }
    }
    expect(Math.atan(steepest) * DEG).toBeLessThan(REPOSE_MAX_DEG + 12);
    // The plates lie ON it, not in a stack over it: none higher than the
    // crest by more than its own size.
    for (let i = 0; i < c.n; i++) {
      if (c.role[i] !== ROLE_SLAB) continue;
      expect((c.ry[i] as number) - (c.ay[i] as number)).toBeLessThan(
        heap.top + 1,
      );
    }
  });

  it("draws the heap the plane collides with, at every height it rises through", () => {
    const heap = c.heap as RubbleHeap;
    const geo = heapGeometry(heap, [0.1, 0.1, 0.1], 7);
    // The mesh's vertices are the collided heights, and between them the
    // drawn triangles are the collided surface.
    const pos = geo.getAttribute("position");
    for (let k = 0; k < pos.count; k++) {
      expect(pos.getY(k)).toBe(heap.h[k]);
    }
    let rng = 12345;
    const next = () => {
      rng = (Math.imul(rng, 1103515245) + 12345) >>> 0;
      return rng / 4294967296;
    };
    let checked = 0;
    for (let s = 0; s < 400; s++) {
      const x = heap.x0 + (0.02 + 0.96 * next()) * heap.nx * heap.cell;
      const z = heap.z0 + (0.02 + 0.96 * next()) * heap.nz * heap.cell;
      const drawn = drawnHeight(geo, x, z);
      const h = heapHeight(heap, x, z);
      if (Number.isNaN(drawn)) {
        // An undrawn square is flat street: nothing there to hit.
        expect(h).toBeLessThanOrEqual(1e-6);
        continue;
      }
      expect(drawn).toBeCloseTo(h, 4);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);

    // The renderer scales it by the share the collision reads, on the same
    // clock — rising from nothing to all of it.
    const heaps = new RubbleHeaps(city);
    const eye = { x: c.x + 60, y: 20, z: c.z };
    const mesh = () =>
      heaps.group.children.find((o) => o.name !== "heap-dressing") as
        | THREE.Mesh
        | undefined;
    const times = [
      c.t0,
      c.t0 + c.heapFrom + 1,
      c.t0 + (c.heapFrom + c.endMs) / 2,
      c.t0 + c.endMs - 50,
      c.t0 + c.endMs + 1000,
    ];
    let peak = { x: 0, z: 0, h: -1 };
    for (let s = 0; s < 400; s++) {
      const x = heap.x0 + next() * heap.nx * heap.cell;
      const z = heap.z0 + next() * heap.nz * heap.cell;
      const h = heapHeight(heap, x, z);
      if (h > peak.h) peak = { x, z, h };
    }
    const shares: number[] = [];
    for (const t of times) {
      heaps.update([c], eye, t);
      const k = heapShareAt(c, t);
      shares.push(k);
      const m = mesh();
      if (k <= 0) {
        expect(m?.visible ?? false).toBe(false);
        continue;
      }
      expect(m?.visible).toBe(true);
      expect(m?.scale.y).toBe(k);
      // Just above the drawn surface misses it, just under hits it.
      const top = peak.h * k;
      expect(sphereHitsHeap(heap, peak.x, top + 2.05, peak.z, 2, k)).toBe(
        false,
      );
      expect(sphereHitsHeap(heap, peak.x, top + 1.9, peak.z, 2, k)).toBe(true);
      // And the field's own crash check sees it there.
      const at = { x: c.x + peak.x, y: top + 1.5, z: c.z + peak.z };
      expect(collideCollapses(at, 2, [c], t)).not.toBeNull();
    }
    expect(shares[0]).toBe(0);
    expect(shares.at(-1)).toBe(1);
    for (let k = 1; k < shares.length; k++) {
      expect(shares[k] as number).toBeGreaterThanOrEqual(
        shares[k - 1] as number,
      );
    }
  });
});
