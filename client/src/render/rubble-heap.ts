// DS1 rubble heaps. When a physics collapse has settled, the host raises a
// heap of fine rubble over its lot (server/src/debris-physics.ts raiseHeap:
// the pieces' coverage blurred into an irregular mound, never over 6 m) and
// sends it once; the big pieces lie half-buried in it. This draws each one.
//
// Draw == collide: the mesh is exactly the surface heapHeight() collides
// with (common/src/city/physpose.ts) — the same Float32 heights, the same
// two triangles per square split on the same diagonal — so the plane hits
// the heap it sees, and flies over it the same way.
//
// The look is baked into vertex colours (no texture to stretch): the
// building's own rubble (brick-red masonry, grey concrete and glass dust),
// darkened where the mound is steep or low, and broken up by a hash per
// vertex. Unlit like the cave-ins, fogged like everything else. One mesh
// per heap, built once, placed at the torus image nearest the camera; only
// heaps inside HEAP_DRAW_M are drawn.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import {
  type Collapse,
  KIND_BUILDING,
} from "@angels-bandits/common/city/collapse";
import type {
  PhysPoses,
  RubbleHeap,
} from "@angels-bandits/common/city/physpose";
import {
  MAT_GLASS,
  MAT_MASONRY,
  buildingFrame,
} from "@angels-bandits/common/city/structure";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { imageIndex } from "./wrapPlacement";

/** Heaps further than this are not drawn, m (they are in the fog). */
const HEAP_DRAW_M = 900;

/** Linear base colours of the fine rubble, by the building's facade. */
const RUBBLE_TINT: Readonly<Record<number, readonly [number, number, number]>> =
  {
    [MAT_MASONRY]: [0.15, 0.085, 0.06],
    [MAT_GLASS]: [0.1, 0.105, 0.11],
  };
const CONCRETE: readonly [number, number, number] = [0.12, 0.11, 0.1];

/** The heap's triangles as a geometry in its building's frame. */
export function heapGeometry(
  heap: RubbleHeap,
  tint: readonly [number, number, number],
  seed: number,
): THREE.BufferGeometry {
  const row = heap.nx + 1;
  const verts = row * (heap.nz + 1);
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const rand = mulberry32(seed >>> 0);
  for (let j = 0; j <= heap.nz; j++) {
    for (let i = 0; i <= heap.nx; i++) {
      const k = j * row + i;
      const h = heap.h[k] as number;
      pos[k * 3] = heap.x0 + i * heap.cell;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = heap.z0 + j * heap.cell;
      // Slope from the neighbours: steep faces and the low rim darker.
      const hx =
        (heap.h[j * row + Math.min(heap.nx, i + 1)] as number) -
        (heap.h[j * row + Math.max(0, i - 1)] as number);
      const hz =
        (heap.h[Math.min(heap.nz, j + 1) * row + i] as number) -
        (heap.h[Math.max(0, j - 1) * row + i] as number);
      const slope = Math.min(1, Math.hypot(hx, hz) / (4 * heap.cell));
      const lift = Math.min(1, h / 3);
      const shade =
        (0.55 + 0.35 * lift) * (1 - 0.35 * slope) * (0.8 + 0.4 * rand());
      col[k * 3] = (tint[0] as number) * shade;
      col[k * 3 + 1] = (tint[1] as number) * shade;
      col[k * 3 + 2] = (tint[2] as number) * shade;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < heap.nz; j++) {
    for (let i = 0; i < heap.nx; i++) {
      const a = j * row + i; // (0, 0)
      const b = a + 1; // (1, 0)
      const c = a + row + 1; // (1, 1)
      const d = a + row; // (0, 1)
      if (
        (heap.h[a] as number) <= 0 &&
        (heap.h[b] as number) <= 0 &&
        (heap.h[c] as number) <= 0 &&
        (heap.h[d] as number) <= 0
      ) {
        continue;
      }
      // heapHeight's split: (00, 10, 11) and (00, 11, 01), facing up.
      index.push(a, c, b, a, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  return geo;
}

interface Drawn {
  phys: PhysPoses;
  mesh: THREE.Mesh;
  x: number;
  z: number;
}

export class RubbleHeaps {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    fog: true,
  });
  private readonly drawn = new Map<number, Drawn>();
  private readonly seen = new Set<number>();

  constructor(private readonly buildings: readonly Building[]) {
    this.group.name = "rubble-heaps";
  }

  /** Heaps drawn now (perf reporting). */
  get count(): number {
    let n = 0;
    for (const d of this.drawn.values()) if (d.mesh.visible) n++;
    return n;
  }

  /** Per frame: a mesh for every settled heap, at the image nearest
   * `camera`; dropped with their collapse. */
  update(collapses: readonly Collapse[], camera: Vec3): void {
    const seen = this.seen;
    seen.clear();
    for (let k = 0; k < collapses.length; k++) {
      const c = collapses[k] as Collapse;
      const phys = c.phys;
      if (c.kind !== KIND_BUILDING || !phys?.heap) continue;
      seen.add(c.id);
      let d = this.drawn.get(c.id);
      if (d && d.phys !== phys) {
        this.drop(c.id, d);
        d = undefined;
      }
      if (!d) {
        const b = this.buildings[c.building];
        const tint = (b && RUBBLE_TINT[buildingFrame(b).material]) ?? CONCRETE;
        const mesh = new THREE.Mesh(
          heapGeometry(phys.heap, tint, c.id * 7919 + c.building),
          this.material,
        );
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        d = { phys, mesh, x: c.x, z: c.z };
        this.drawn.set(c.id, d);
      }
      const ox = d.x + imageIndex(camera.x, d.x) * WORLD_SIZE;
      const oz = d.z + imageIndex(camera.z, d.z) * WORLD_SIZE;
      const far = Math.hypot(ox - camera.x, oz - camera.z) > HEAP_DRAW_M;
      d.mesh.visible = !far;
      if (!far && (d.mesh.position.x !== ox || d.mesh.position.z !== oz)) {
        d.mesh.position.set(ox, 0, oz);
        d.mesh.updateMatrix();
      }
    }
    for (const [id, d] of this.drawn) if (!seen.has(id)) this.drop(id, d);
  }

  private drop(id: number, d: Drawn): void {
    this.group.remove(d.mesh);
    d.mesh.geometry.dispose();
    this.drawn.delete(id);
  }
}
