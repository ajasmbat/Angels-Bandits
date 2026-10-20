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
//
// DS2 mixed debris: the heap is not one mound of one colour. Its vertex
// colours mix slab concrete, the facade's own finish in chunks, rusty
// rebar, and a dusting of pale concrete dust over the top; a share of its
// vertices glitter with glass (a view-dependent twinkle, under the bloom
// threshold). One more draw for every heap together dresses them with
// what sticks out of a real pile: bent rebar and broken slab edges, half
// buried (HeapDressing; cosmetic, never collided — the heap is what the
// plane hits).

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import {
  type Collapse,
  KIND_BUILDING,
} from "@angels-bandits/common/city/collapse";
import type {
  PhysPoses,
  RubbleHeap,
} from "@angels-bandits/common/city/physpose";
import { heapHeight } from "@angels-bandits/common/city/physpose";
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
    [MAT_MASONRY]: [0.11, 0.06, 0.042],
    [MAT_GLASS]: [0.075, 0.078, 0.082],
  };
const CONCRETE: readonly [number, number, number] = [0.085, 0.08, 0.072];
/** DS2: the heap's mix — slab concrete, rusty rebar and settled dust
 * (linear) — and the shares of vertices that are slab, rebar, and glass
 * glitter (a glass tower's pile glitters most). */
const SLAB: readonly [number, number, number] = [0.15, 0.145, 0.135];
const REBAR_RGB: readonly [number, number, number] = [0.05, 0.028, 0.018];
const HEAP_DUST: readonly [number, number, number] = [0.2, 0.19, 0.175];
const SLAB_SHARE = 0.3;
const REBAR_SHARE = 0.04;
const GLINT_SHARE = 0.05;
const GLINT_SHARE_GLASS = 0.14;
/** The glitter's colour (linear; its peak channel under the bloom
 * threshold, over the darkest of the heap's vertex colours). */
export const HEAP_GLINT_RGB = [0.4, 0.44, 0.5] as const;
const GLINT = `vec3(${HEAP_GLINT_RGB.join(", ")})`;

/** A hash of three integers into [0, 1). */
function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 0x9e3779b1);
  h = Math.imul(h ^ (b + 0x632be5ab), 0x85ebca6b);
  h = Math.imul(h ^ (c + 7), 0xc2b2ae35);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The heap's triangles as a geometry in its building's frame. */
export function heapGeometry(
  heap: RubbleHeap,
  tint: readonly [number, number, number],
  seed: number,
  glintShare = GLINT_SHARE,
): THREE.BufferGeometry {
  const row = heap.nx + 1;
  const verts = row * (heap.nz + 1);
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const glint = new Float32Array(verts);
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
      // Broken concrete and brick in clods: a coarse patch hash (2 × 2
      // cells) and a fine one per vertex, darker on the steep faces and
      // in the low rim, soot over all of it.
      const patch = hash01(seed, i >> 1, j >> 1);
      const fine = rand();
      const shade =
        (0.35 + 0.45 * lift) *
        (1 - 0.45 * slope) *
        (0.55 + 0.6 * patch) *
        (0.75 + 0.5 * fine);
      // DS2: what this spot is — a slab chunk (by 3 × 3 patch), a bar of
      // rebar, or the building's own finish — and dust settled over the
      // top of the pile.
      const what = rand();
      const slab =
        hash01(seed + 3, Math.floor(i / 3), Math.floor(j / 3)) < SLAB_SHARE;
      const base = what < REBAR_SHARE ? REBAR_RGB : slab ? SLAB : tint;
      const dust = 0.45 * lift * (1 - slope) * hash01(seed + 5, i >> 2, j >> 2);
      for (let ch = 0; ch < 3; ch++) {
        const v = (base[ch] as number) * shade;
        col[k * 3 + ch] =
          v + ((HEAP_DUST[ch] as number) * (0.5 + 0.5 * lift) - v) * dust;
      }
      glint[k] = h > 0.05 && rand() < glintShare ? 1 : 0;
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
  geo.setAttribute("aGlint", new THREE.BufferAttribute(glint, 1));
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
  private readonly material = heapMaterial();
  /** DS2: the rebar and slab edges sticking out of every heap (one draw). */
  readonly dressing = new HeapDressing();
  private readonly drawn = new Map<number, Drawn>();
  private readonly seen = new Set<number>();

  constructor(private readonly buildings: readonly Building[]) {
    this.group.name = "rubble-heaps";
    this.group.add(this.dressing.mesh);
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
    // DS2: what the dressing is laid for — the drawn heaps and images.
    let key = 0;
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
        const mat = b ? buildingFrame(b).material : -1;
        const tint = RUBBLE_TINT[mat] ?? CONCRETE;
        const mesh = new THREE.Mesh(
          heapGeometry(
            phys.heap,
            tint,
            c.id * 7919 + c.building,
            mat === MAT_GLASS ? GLINT_SHARE_GLASS : GLINT_SHARE,
          ),
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
      if (!far) key = (Math.imul(key, 31) + c.id * 7 + ox * 3 + oz * 5) | 0;
      if (!far && (d.mesh.position.x !== ox || d.mesh.position.z !== oz)) {
        d.mesh.position.set(ox, 0, oz);
        d.mesh.updateMatrix();
      }
    }
    for (const [id, d] of this.drawn) if (!seen.has(id)) this.drop(id, d);
    this.dressing.sync(this.drawn, key);
  }

  private drop(id: number, d: Drawn): void {
    this.group.remove(d.mesh);
    d.mesh.geometry.dispose();
    this.drawn.delete(id);
  }
}

/** DS2: the heap material — its vertex colours, unlit and fogged, plus
 * glass glitter: a glinting vertex's share of 25 cm cells catch the light,
 * which cells by where the eye is (they twinkle as it moves). */
function heapMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    fog: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float aGlint;\nvarying float vGlint;\nvarying vec3 vHeapW;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvGlint = aGlint;\nvHeapW = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vGlint;\nvarying vec3 vHeapW;",
      )
      .replace(
        "vec3 outgoingLight = reflectedLight.indirectDiffuse;",
        `vec3 outgoingLight = reflectedLight.indirectDiffuse;
{
  vec3 hgV = normalize(cameraPosition - vHeapW);
  vec2 hgCell = floor(vHeapW.xz * 4.0);
  vec2 hgLook = floor(hgV.xz * 7.0);
  float hgH = fract(sin(dot(hgCell + hgLook * 13.1, vec2(127.1, 311.7))) * 43758.5453);
  float hgFade = 1.0 - smoothstep(60.0, 160.0, length(cameraPosition - vHeapW));
  outgoingLight += ${GLINT} * step(0.9, hgH) * smoothstep(0.3, 0.9, vGlint) * hgFade;
}`,
      );
  };
  material.customProgramCacheKey = () => "ab-ds2-heap-glitter";
  return material;
}

/** DS2 heap dressing: bars of rebar and broken slab edges sticking out of
 * the heaps, half buried. Seeded per heap (pure in it); rewritten only when
 * the heaps drawn or their images change. */
const DRESS_MAX = 1600;
const DRESS_PER_HEAP = 140;
/** The share of a heap's dressing that is rebar (the rest slab edges). */
const DRESS_REBAR = 0.65;

export class HeapDressing {
  readonly mesh: THREE.InstancedMesh;
  private key = Number.NaN;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geometry, material, DRESS_MAX);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.name = "heap-dressing";
  }

  /** Re-dress when the drawn heaps (or their images: `key`) changed. */
  sync(drawn: ReadonlyMap<number, Drawn>, key: number): void {
    if (key === this.key) return;
    this.key = key;
    let n = 0;
    for (const [id, d] of drawn) {
      if (!d.mesh.visible) continue;
      const heap = d.phys.heap;
      if (!heap) continue;
      const rand = mulberry32((id * 2654435761) >>> 0);
      let placed = 0;
      for (
        let k = 0;
        k < DRESS_PER_HEAP * 3 && placed < DRESS_PER_HEAP && n < DRESS_MAX;
        k++
      ) {
        const lx = heap.x0 + rand() * heap.nx * heap.cell;
        const lz = heap.z0 + rand() * heap.nz * heap.cell;
        const h = heapHeight(heap, lx, lz);
        const rebar = rand() < DRESS_REBAR;
        const tilt = rand();
        const yaw = rand() * Math.PI * 2;
        const len = rebar ? 0.8 + 2.4 * rand() : 1.2 + 2.2 * rand();
        const tone = rand();
        if (h < 0.8) continue;
        if (rebar) {
          // A bar, leaning 20–75° off vertical, a third of it buried.
          this.e.set(0.35 + 0.95 * tilt, yaw, 0, "YXZ");
          this.s.set(0.06, len, 0.06);
          this.c.setRGB(
            0.05 + 0.04 * tone,
            0.03 + 0.015 * tone,
            0.02,
            THREE.LinearSRGBColorSpace,
          );
        } else {
          // A slab edge, tipped up out of the pile.
          this.e.set(0.25 + 0.6 * tilt, yaw, 0, "YXZ");
          this.s.set(0.8 + 1.4 * rand(), 0.22 + 0.15 * rand(), len);
          const g = 0.11 + 0.06 * tone;
          this.c.setRGB(g, g * 0.97, g * 0.92, THREE.LinearSRGBColorSpace);
        }
        this.q.setFromEuler(this.e);
        // Half buried: the centre at the surface, the box's middle third in it.
        this.p.set(
          d.mesh.position.x + lx,
          h + (rebar ? len * 0.15 : 0),
          d.mesh.position.z + lz,
        );
        this.m.compose(this.p, this.q, this.s);
        this.mesh.setMatrixAt(n, this.m);
        this.mesh.setColorAt(n, this.c);
        n++;
        placed++;
      }
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
