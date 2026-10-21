// G9 the angle of repose: how a pile of broken floors slumps into a heap.
// Shared verbatim by the host and the page.
//
// A pancaked tower does not lie as a cake of storeys. Loose broken concrete
// stands no steeper than its angle of repose (30–40°, seeded per collapse),
// so the pile slumps into a mound — wider at its base than the lot, its
// flanks running out into the street — with the broken plates lying tilted
// on it. Both the closed form (city/collapse.ts: the rest geometry of a
// PANCAKE) and the physics (server/src/debris-physics.ts raiseHeap) raise
// their fine-rubble heap by the one rule here: a field of pile heights,
// dilated so that no point stands steeper than the slope over its
// neighbours (`reposeMound`). The result is a RubbleHeap (city/physpose.ts),
// drawn and collided as the same triangles.
//
// Not re-exported from city/index.ts; import "@angels-bandits/common/city/repose".

import { STREET_WIDTH } from "../constants";
import type { RubbleHeap } from "./physpose";

/** The angle of repose a collapse's rubble takes, deg (seeded per event). */
export const REPOSE_MIN_DEG = 30;
export const REPOSE_MAX_DEG = 40;
/** How far a heap vertex is knocked up or down, m (rubble, not a dune),
 * and its lumps: two octaves of value noise (their lattice, m) as a share
 * of the height there, at most LUMP_MAX_M. */
const KNOCK_M = 0.9;
const LUMP_COARSE_M = 14;
const LUMP_FINE_M = 6;
const LUMP_SHARE = 0.14;
const LUMP_MAX_M = 3;

/** tan(angle of repose) for event `id`: 30–40°, seeded. */
export function reposeSlope(id: number): number {
  const u = hash01(id, 0x6e9, 0x3a7);
  const deg = REPOSE_MIN_DEG + (REPOSE_MAX_DEG - REPOSE_MIN_DEG) * u;
  return Math.tan((deg * Math.PI) / 180);
}

/** A hash of three integers into [0, 1). */
export function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 0x9e3779b1);
  h = Math.imul(h ^ (b + 0x632be5ab), 0x85ebca6b);
  h = Math.imul(h ^ (c + 7), 0xc2b2ae35);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Value noise in [0, 1) at (x, z) on a `size`-metre lattice, seed `id`. */
function lump(id: number, x: number, z: number, size: number): number {
  const u = x / size;
  const v = z / size;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const su = fu * fu * (3 - 2 * fu);
  const sv = fv * fv * (3 - 2 * fv);
  const a = hash01(id, i, j);
  const b = hash01(id, i + 1, j);
  const c = hash01(id, i, j + 1);
  const d = hash01(id, i + 1, j + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

/**
 * An empty heap grid of `cell`-metre squares over the plan box
 * [x0, x1] × [z0, z1] (centre-relative), grown by `pad` on every side — the
 * flanks' run-out — and at most `maxCells` a side (the cell grows to fit).
 */
export function heapGrid(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  pad: number,
  cell: number,
  maxCells: number,
): RubbleHeap {
  const w = x1 - x0 + 2 * pad;
  const d = z1 - z0 + 2 * pad;
  const size = Math.max(cell, w / maxCells, d / maxCells);
  const nx = Math.max(2, Math.ceil(w / size));
  const nz = Math.max(2, Math.ceil(d / size));
  return {
    x0: (x0 + x1) / 2 - (nx * size) / 2,
    z0: (z0 + z1) / 2 - (nz * size) / 2,
    cell: size,
    nx,
    nz,
    h: new Float32Array((nx + 1) * (nz + 1)),
    top: 0,
  };
}

/**
 * Raise the pile under a box footprint [x0, x1] × [z0, z1] to `top` (m):
 * every vertex inside it stands at least that high. The pile heights are
 * what `reposeMound` slumps.
 */
export function pileBox(
  heap: RubbleHeap,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  top: number,
): void {
  const row = heap.nx + 1;
  const a0 = Math.max(0, Math.ceil((x0 - heap.x0) / heap.cell));
  const a1 = Math.min(heap.nx, Math.floor((x1 - heap.x0) / heap.cell));
  const b0 = Math.max(0, Math.ceil((z0 - heap.z0) / heap.cell));
  const b1 = Math.min(heap.nz, Math.floor((z1 - heap.z0) / heap.cell));
  for (let j = b0; j <= b1; j++) {
    for (let k = a0; k <= a1; k++) {
      const at = j * row + k;
      if ((heap.h[at] as number) < top) heap.h[at] = top;
    }
  }
}

/** How far a heap runs out past its pile, at most, m: a skirt over the
 * near side of its street — never across it, and the far side stays open
 * (the street-level views, and the planes down there). */
export const HEAP_RUN_MAX_M = 0.6 * STREET_WIDTH;

/** The run-out of a heap whose crest is `crest` (m) at `slope`, m. */
export const reposeRun = (crest: number, slope: number): number =>
  Math.min(HEAP_RUN_MAX_M, crest / slope);

/**
 * Slump the pile heights in `heap` to the angle of repose (`slope` =
 * tan θ): every vertex is raised to the height its neighbours' pile holds
 * up — h(p) = max over q of h(q) − slope·|p − q|, on the grid's 8-neighbour
 * chamfer (two passes, exact for it) — then each vertex is knocked up or
 * down a little by its own hash (seed `id`), clamped to `cap` and zero on
 * the rim. Sets `top`. First the pile is shouldered in from its edge
 * (no higher than slope × (HEAP_RUN_MAX_M + its distance inside the pile)),
 * so the slope out of it never runs further than HEAP_RUN_MAX_M while the
 * mound still rises over the lot to bury a tall pile.
 */
export function reposeMound(
  heap: RubbleHeap,
  slope: number,
  id: number,
  cap: number,
): void {
  const { nx, nz, h } = heap;
  const row = nx + 1;
  const s1 = slope * heap.cell;
  const s2 = s1 * Math.SQRT2;
  // The distance inside the pile, m (8-neighbour chamfer, two passes)…
  const inside = new Float32Array(h.length);
  const c1 = heap.cell;
  const c2 = c1 * Math.SQRT2;
  for (let j = 0; j <= nz; j++) {
    for (let k = 0; k <= nx; k++) {
      const at = j * row + k;
      if (!((h[at] as number) > 0)) continue;
      let d = Number.POSITIVE_INFINITY;
      if (k > 0) d = Math.min(d, (inside[at - 1] as number) + c1);
      if (j > 0) {
        d = Math.min(d, (inside[at - row] as number) + c1);
        if (k > 0) d = Math.min(d, (inside[at - row - 1] as number) + c2);
        if (k < nx) d = Math.min(d, (inside[at - row + 1] as number) + c2);
      }
      inside[at] = k > 0 && j > 0 ? d : c1;
    }
  }
  for (let j = nz; j >= 0; j--) {
    for (let k = nx; k >= 0; k--) {
      const at = j * row + k;
      if (!((h[at] as number) > 0)) continue;
      let d = inside[at] as number;
      if (k < nx) d = Math.min(d, (inside[at + 1] as number) + c1);
      if (j < nz) {
        d = Math.min(d, (inside[at + row] as number) + c1);
        if (k < nx) d = Math.min(d, (inside[at + row + 1] as number) + c2);
        if (k > 0) d = Math.min(d, (inside[at + row - 1] as number) + c2);
      }
      inside[at] = d;
      // …which shoulders the pile in from its edge.
      h[at] = Math.min(h[at] as number, slope * (HEAP_RUN_MAX_M + d));
    }
  }
  // Forward: from the row above and the vertex to the left.
  for (let j = 0; j <= nz; j++) {
    for (let k = 0; k <= nx; k++) {
      const at = j * row + k;
      let v = h[at] as number;
      if (k > 0) v = Math.max(v, (h[at - 1] as number) - s1);
      if (j > 0) {
        v = Math.max(v, (h[at - row] as number) - s1);
        if (k > 0) v = Math.max(v, (h[at - row - 1] as number) - s2);
        if (k < nx) v = Math.max(v, (h[at - row + 1] as number) - s2);
      }
      h[at] = v;
    }
  }
  // Backward: from the row below and the vertex to the right.
  for (let j = nz; j >= 0; j--) {
    for (let k = nx; k >= 0; k--) {
      const at = j * row + k;
      let v = h[at] as number;
      if (k < nx) v = Math.max(v, (h[at + 1] as number) - s1);
      if (j < nz) {
        v = Math.max(v, (h[at + row] as number) - s1);
        if (k < nx) v = Math.max(v, (h[at + row + 1] as number) - s2);
        if (k > 0) v = Math.max(v, (h[at + row - 1] as number) - s2);
      }
      h[at] = v;
    }
  }
  let top = 0;
  for (let j = 0; j <= nz; j++) {
    for (let k = 0; k <= nx; k++) {
      const at = j * row + k;
      const base = h[at] as number;
      let v = 0;
      if (j > 0 && k > 0 && j < nz && k < nx && base > 0) {
        // Lumps (where a plate or a block lies under the dust) on the
        // lattice of the plan, so a heap's shape is its own wherever it is
        // drawn; then a knock per vertex.
        const x = heap.x0 + k * heap.cell;
        const z = heap.z0 + j * heap.cell;
        const n =
          0.65 * lump(id + 11, x, z, LUMP_COARSE_M) +
          0.35 * lump(id + 23, x, z, LUMP_FINE_M) -
          0.5;
        const lumps = 2 * n * Math.min(LUMP_MAX_M, LUMP_SHARE * base);
        const knock = base > 0.3 ? KNOCK_M * (hash01(id, k, j) - 0.5) : 0;
        v = Math.min(cap, Math.max(0, base + lumps + knock));
      }
      h[at] = v;
      top = Math.max(top, v);
    }
  }
  heap.top = top;
}
