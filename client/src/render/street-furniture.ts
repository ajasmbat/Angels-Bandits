// G1 street furniture + parked cars: ONE instanced unit-box rig for every
// bench, bin, hydrant, newspaper box, bus shelter (with its lit ad panel),
// bike rack and bike, bollard, planter, phone booth, food cart, parked car
// and double-parked delivery van — a single draw call. Layout is the pure
// seam in street-detail.ts; this file is the thin adapter.
//
// Cheap on purpose (O4: no first-sight freezes, no per-frame garbage):
//  - each block's boxes are composed into canonical instance matrices ONCE,
//    the first time the block enters the window, and cached;
//  - a frame only re-packs the instance buffer when the camera's block
//    window (or a block's torus image) changes — a block is 200 m, so that
//    is a re-pack every few seconds of flight, never a per-frame upload;
//  - thinning (the L1 altitude gate × the quality share) is a UNIFORM: every
//    object carries a golden-ratio rank and the vertex shader collapses the
//    ones above the keep share, so a fade costs nothing on the CPU.
//
// Food-cart steam rides the existing L1 Steam cloud (cartSteamVents → the
// Steam extra-vents hook), so G1 adds exactly one draw call.
//
// Non-collidable (the accepted street-level exception, ≤ 3 m).

import type { Building, HoleSpan } from "@angels-bandits/common/city";
import type { TrainLine } from "@angels-bandits/common/city/train";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { LifeKind, blockStations } from "./citylife";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { type SteamVent, steamVentsForBlock } from "./steam";
import {
  type DetailBox,
  ITEM_MAX_HEIGHT,
  type StreetDetailContext,
  blockParking,
  cartVents,
  itemBoxes,
  streetFurnitureFor,
  vehicleBoxes,
} from "./street-detail";
import { STREET_PAINT_UNIFORM } from "./street-paint";
import {
  BLOCK_WINDOW_RADIUS,
  type BlockIndex,
  blockWindowInto,
} from "./streetlife";

/** Parked cars stay at full density up to this camera altitude, m, and are
 * gone above PARKED_GATE_OFF — a 4 m car is a 2 px speck from there. They
 * read from much higher than benches, so they get their own, later gate. */
export const PARKED_GATE_FULL = 220;
export const PARKED_GATE_OFF = 320;

export const parkedGate = (cameraY: number): number =>
  Math.min(
    1,
    Math.max(
      0,
      (PARKED_GATE_OFF - cameraY) / (PARKED_GATE_OFF - PARKED_GATE_FULL),
    ),
  );

/**
 * The live city's vetoes for the layout seam: every hole's corridor, every
 * train line's ground-reaching boxes (pillars, station stairs and posts),
 * each block's gutter vents, and A1's street stations (citylife.ts). Shared
 * by the renderer and the tests, so both veto exactly the same.
 */
export function buildStreetDetailContext(
  seed: number,
  buildingsByBlock: Map<number, Building[]>,
  holes: readonly HoleSpan[],
  trains: readonly TrainLine[],
  /** D9: the destructible street props' footprints (city/props.ts) — G1's
   * cars and furniture give way to them, so nothing overlaps. */
  extraKeepOut: readonly { x: number; z: number; hx: number; hz: number }[] = [],
): StreetDetailContext {
  const keepOut: { x: number; z: number; hx: number; hz: number }[] = [
    ...extraKeepOut,
  ];
  for (const line of trains) {
    line.viaduct.forEach((b, i) => {
      if (b.y - b.hy > ITEM_MAX_HEIGHT + 1) return; // deck: far overhead
      keepOut.push({
        x: b.x,
        z: b.z,
        hx: line.extents[2 * i] ?? b.hx,
        hz: line.extents[2 * i + 1] ?? b.hz,
      });
    });
  }
  const vents = new Map<number, { x: number; z: number }[]>();
  const stations = new Map<
    number,
    { carts: { x: number; z: number }[]; crowds: { x: number; z: number }[] }
  >();
  return {
    holes,
    keepOut,
    stationsFor: (bx, bz) => {
      const key = bx * 1000 + bz;
      let st = stations.get(key);
      if (!st) {
        const s = blockStations(bx, bz, seed);
        st = {
          carts: s.figures
            .filter((f) => f.kind === LifeKind.CART)
            .map((f) => ({ x: f.x, z: f.z })),
          crowds: [...s.busStops, ...s.performers].map((p) => ({
            x: p.x,
            z: p.z,
          })),
        };
        stations.set(key, st);
      }
      return st;
    },
    ventsFor: (bx, bz) => {
      const key = bx * 1000 + bz;
      let v = vents.get(key);
      if (!v) {
        v = steamVentsForBlock(bx, bz, buildingsByBlock.get(key) ?? [], seed)
          .filter((s) => !s.roof)
          .map((s) => ({ x: s.x, z: s.z }));
        vents.set(key, v);
      }
      return v;
    },
  };
}

/** A food cart's steam: small, close, quick — scaled-down L1 puffs. */
const CART_STEAM = { y: 1.35, rise: 3.2, spread: 0.35, scale: 0.28 } as const;

/** One block's cached boxes, canonical. */
interface BlockBoxes {
  /** Instance matrices (16 floats each), translation in canonical coords. */
  matrices: Float32Array;
  colors: Float32Array;
  emit: Float32Array;
  rank: Float32Array;
  count: number;
  items: number;
  parked: number;
  carts: SteamVent[];
  /** Block centre, canonical. */
  cx: number;
  cz: number;
}

const GLSL_VERTEX_PARS = /* glsl */ `
attribute vec3 aEmit;
attribute float aRank;
uniform vec2 uKeep;
varying vec3 vEmit;
varying float vBoxY;
`;
const GLSL_VERTEX_MAIN = /* glsl */ `
// Thinning by rank (street-detail.ts): furniture ranks are in [0, 1), parked
// vehicles carry rank + 2. Anything above its keep share collapses to a
// point — degenerate triangles, never rasterised.
float abKeep = aRank >= 2.0 ? uKeep.y : uKeep.x;
if (fract(aRank) >= abKeep) transformed = vec3(0.0);
vEmit = aEmit;
vBoxY = position.y + 0.5;
`;
const GLSL_FRAGMENT_PARS = /* glsl */ `
varying vec3 vEmit;
varying float vBoxY;
`;
const GLSL_FRAGMENT_EMISSIVE = /* glsl */ `
// Lit panels: a soft top-to-bottom falloff, every factor <= 1, so the peak
// stays at the sub-bloom luminance street-detail.ts normalised it to.
totalEmissiveRadiance += vEmit * (0.78 + 0.22 * vBoxY);
`;

function createFurnitureMaterial(
  keep: THREE.Vector2,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, // tones live in instanceColor (setColorAt multiplies)
    roughness: 0.78,
    metalness: 0.12,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uKeep = { value: keep };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${GLSL_VERTEX_PARS}`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${GLSL_VERTEX_MAIN}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GLSL_FRAGMENT_PARS}`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${GLSL_FRAGMENT_EMISSIVE}`,
      );
  };
  // V3 trap: a unique key, or this patch silently reuses another program.
  material.customProgramCacheKey = () => "ab-g1-street-furniture";
  return material;
}

export class StreetFurniture {
  readonly mesh: THREE.InstancedMesh;
  private readonly seed: number;
  private readonly ctx: StreetDetailContext;
  private readonly cache = new Map<number, BlockBoxes>();
  private readonly capacity: number;
  private readonly emit: THREE.InstancedBufferAttribute;
  private readonly rank: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private readonly keep = new THREE.Vector2(1, 1);
  /** The packed window: block keys and their image shifts, for change tests. */
  private packedKeys: number[] = [];
  private packedShift: number[] = [];
  private radius = BLOCK_WINDOW_RADIUS;
  private share = 1;
  private enabled = true;
  /** The tier's fine-paint switch (the A/B switch can override it off). */
  private paintTier = true;
  private stats = { blocks: 0, items: 0, parked: 0, boxes: 0 };

  constructor(seed: number, ctx: StreetDetailContext) {
    this.seed = seed;
    this.ctx = ctx;
    // Size for the worst (2R+1)² window of real blocks: lay out every block
    // once now (pure and cached — the window reuses these), then take the
    // sum of the largest window's worth.
    const counts: number[] = [];
    for (let bx = 0; bx < WORLD_SIZE / BLOCK_PITCH; bx++) {
      for (let bz = 0; bz < WORLD_SIZE / BLOCK_PITCH; bz++) {
        counts.push(this.block(bx, bz).count);
      }
    }
    counts.sort((a, b) => b - a);
    const window = (2 * BLOCK_WINDOW_RADIUS + 1) ** 2;
    this.capacity = counts.slice(0, window).reduce((t, c) => t + c, 0);

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.emit = new THREE.InstancedBufferAttribute(
      new Float32Array(this.capacity * 3),
      3,
    );
    this.rank = new THREE.InstancedBufferAttribute(
      new Float32Array(this.capacity),
      1,
    );
    geometry.setAttribute("aEmit", this.emit);
    geometry.setAttribute("aRank", this.rank);
    this.mesh = new THREE.InstancedMesh(
      geometry,
      createFurnitureMaterial(this.keep),
      this.capacity,
    );
    this.colors = new THREE.InstancedBufferAttribute(
      new Float32Array(this.capacity * 3),
      3,
    );
    this.mesh.instanceColor = this.colors;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // instances span the whole window
    this.mesh.visible = false;
  }

  /** One block's boxes, composed once (canonical) and cached. */
  private block(bx: number, bz: number): BlockBoxes {
    const key = bx * 1000 + bz;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const items = streetFurnitureFor(this.seed, bx, bz, this.ctx);
    const parked = blockParking(this.seed, bx, bz, this.ctx);
    const boxes: DetailBox[] = [];
    for (const it of items) for (const b of itemBoxes(it)) boxes.push(b);
    for (const p of parked) for (const b of vehicleBoxes(p)) boxes.push(b);
    const n = boxes.length;
    const out: BlockBoxes = {
      matrices: new Float32Array(n * 16),
      colors: new Float32Array(n * 3),
      emit: new Float32Array(n * 3),
      rank: new Float32Array(n),
      count: n,
      items: items.length,
      parked: parked.length,
      carts: cartVents(bx, bz, this.ctx).map((c, i) => ({
        x: c.x,
        z: c.z,
        y: CART_STEAM.y,
        rise: CART_STEAM.rise,
        spread: CART_STEAM.spread,
        // Seeded by position (stable on every client), never by Math.random.
        phase: (Math.abs(c.x * 0.137 + c.z * 0.311) + i * 0.37) % 1,
        roof: false,
        scale: CART_STEAM.scale,
      })),
      cx: bx * BLOCK_PITCH + BLOCK_PITCH / 2,
      cz: bz * BLOCK_PITCH + BLOCK_PITCH / 2,
    };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qRoll = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    const Y = new THREE.Vector3(0, 1, 0);
    const Z = new THREE.Vector3(0, 0, 1);
    boxes.forEach((b, i) => {
      q.setFromAxisAngle(Y, b.yaw);
      if (b.roll !== 0) q.multiply(qRoll.setFromAxisAngle(Z, b.roll));
      m.compose(pos.set(b.x, b.y, b.z), q, scale.set(b.sx, b.sy, b.sz));
      m.toArray(out.matrices, i * 16);
      color.setHex(b.color).toArray(out.colors, i * 3);
      if (b.emit) out.emit.set(b.emit, i * 3);
      out.rank[i] = b.rank;
    });
    this.cache.set(key, out);
    return out;
  }

  /** Food-cart steam vents on a block — the Steam extra-vents hook. */
  cartSteamVents = (bx: number, bz: number): readonly SteamVent[] =>
    this.block(bx, bz).carts;

  /** O5: the block window, reused every frame (blockWindowInto). */
  private readonly windowScratch: BlockIndex[] = [];

  /**
   * Show the window around the camera. `gate` is the L1 micro gate (or 0 to
   * hide the furniture); parked cars take their own, later gate.
   */
  update(cameraPos: Vec3, gate: number): void {
    const keepF = this.enabled ? gate * this.share : 0;
    const keepC = this.enabled ? parkedGate(cameraPos.y) * this.share : 0;
    if (keepF <= 0 && keepC <= 0) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.keep.set(keepF, keepC);

    // Re-pack only when the window or a block's torus image changes.
    const win = blockWindowInto(cameraPos, this.radius, this.windowScratch);
    let changed = win.length !== this.packedKeys.length;
    for (let i = 0; i < win.length && !changed; i++) {
      const w = win[i] as { bx: number; bz: number };
      const blk = this.block(w.bx, w.bz);
      if (this.packedKeys[i] !== w.bx * 1000 + w.bz) changed = true;
      else if (this.packedShift[2 * i] !== shiftOf(cameraPos.x, blk.cx))
        changed = true;
      else if (this.packedShift[2 * i + 1] !== shiftOf(cameraPos.z, blk.cz))
        changed = true;
    }
    if (changed) this.pack(cameraPos, win);
  }

  private pack(
    cameraPos: Vec3,
    win: readonly { bx: number; bz: number }[],
  ): void {
    const mat = this.mesh.instanceMatrix.array as Float32Array;
    let n = 0;
    let items = 0;
    let parked = 0;
    this.packedKeys = [];
    this.packedShift = [];
    for (const w of win) {
      const blk = this.block(w.bx, w.bz);
      const sx = shiftOf(cameraPos.x, blk.cx);
      const sz = shiftOf(cameraPos.z, blk.cz);
      this.packedKeys.push(w.bx * 1000 + w.bz);
      this.packedShift.push(sx, sz);
      if (n + blk.count > this.capacity) break; // sized for the worst window
      mat.set(blk.matrices, n * 16);
      for (let i = 0; i < blk.count; i++) {
        mat[(n + i) * 16 + 12] = (mat[(n + i) * 16 + 12] as number) + sx;
        mat[(n + i) * 16 + 14] = (mat[(n + i) * 16 + 14] as number) + sz;
      }
      (this.colors.array as Float32Array).set(blk.colors, n * 3);
      (this.emit.array as Float32Array).set(blk.emit, n * 3);
      (this.rank.array as Float32Array).set(blk.rank, n);
      n += blk.count;
      items += blk.items;
      parked += blk.parked;
    }
    this.mesh.count = n;
    for (const attr of [
      this.mesh.instanceMatrix,
      this.colors,
      this.emit,
      this.rank,
    ]) {
      attr.clearUpdateRanges();
      if (n > 0) {
        attr.addUpdateRange(0, n * attr.itemSize);
        attr.needsUpdate = true;
      }
    }
    this.stats = { blocks: win.length, items, parked, boxes: n };
  }

  /** O3/M3: the tier's share of objects, its block radius and the fine
   * ground paint. Counts and uniforms only — nothing recompiles. */
  setQuality(tier: QualityTier): void {
    const p = QUALITY_PROFILES[tier];
    this.share = p.streetDetail;
    const r = Math.min(BLOCK_WINDOW_RADIUS, p.microRadius);
    if (r !== this.radius) {
      this.radius = r;
      this.packedKeys = []; // force a re-pack at the new radius
    }
    STREET_PAINT_UNIFORM.value = this.enabled && p.streetPaint ? 1 : 0;
    this.paintTier = p.streetPaint;
  }

  /** `?street=0` / __ab: the perf A/B control — objects AND paint off. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    STREET_PAINT_UNIFORM.value = on && this.paintTier ? 1 : 0;
    if (!on) this.mesh.visible = false;
  }

  /** QA read-back: what the last pack drew and the live keep shares. */
  get counts(): {
    blocks: number;
    items: number;
    parked: number;
    boxes: number;
    keepFurniture: number;
    keepParked: number;
    visible: boolean;
    paint: number;
  } {
    return {
      ...this.stats,
      keepFurniture: this.keep.x,
      keepParked: this.keep.y,
      visible: this.mesh.visible,
      paint: STREET_PAINT_UNIFORM.value,
    };
  }

  /** The canonical layout of one block (determinism QA across tabs). */
  sample(bx: number, bz: number) {
    return {
      items: streetFurnitureFor(this.seed, bx, bz, this.ctx).length,
      parked: blockParking(this.seed, bx, bz, this.ctx).length,
      boxes: this.block(bx, bz).count,
      first: Array.from(this.block(bx, bz).matrices.slice(12, 15)),
    };
  }
}

/** The WORLD_SIZE multiple that puts canonical `c` nearest the viewer `v`. */
const shiftOf = (v: number, c: number): number =>
  Math.round((v - c) / WORLD_SIZE) * WORLD_SIZE;
