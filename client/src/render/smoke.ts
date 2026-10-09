// Wounded-plane smoke: any plane strictly below SMOKE_HP_FRAC of MAX_HP
// (snapshot HP — every client sees the same wound) trails dark puffs.
//
// Trail seam rule (same pattern the plane-visibility ticket specifies):
// puffs are stored as OFFSETS from the newest anchor sample and re-based
// through wrapDelta on every update — never world-space history — so a
// seam-crossing plane drags a 10 m trail, not a 2 km streak. The pure
// model (smokeActive, SmokeTrail) is the tested seam; SmokeTrails is the
// thin THREE half: ONE shared Points for every plane's smoke (1 draw call).
//
// S7 reuses the same model for the kill-streak trail: a SECOND SmokeTrails
// built `tinted` carries a per-puff colour attribute, so every streaking
// plane's smoke — whatever its tier colour — is still one draw.

import { MAX_HP, SMOKE_HP_FRAC } from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaInto } from "@angels-bandits/common/world";
import * as THREE from "three";
import { RENDER_ORDER } from "./render-order";
import { nearestImageInto, uploadPrefix } from "./wrapPlacement";

/** Min ms between puffs per plane (~14 Hz at a steady wound). */
export const SMOKE_EMIT_MS = 70;
/** Puff lifetime, ms. */
export const SMOKE_LIFE_MS = 1500;
/** Upward drift baked into a puff as it ages, m/s. */
const SMOKE_RISE = 3;
const scratchImage = { x: 0, y: 0, z: 0 };
/** Point budget: trails × puffs a full-rate trail can hold (1500/70 ≈ 22).
 * Planes, plus X1's missiles in the air (render/missiles.ts MISSILE_POOL). */
const MAX_PLANES = 12 + 6;
const MAX_PUFFS = 24;
/** Puff sprite size ramp over life, meters (grows as it disperses). */
const SIZE_MIN = 2.4;
const SIZE_MAX = 7;
/** Smoky gray-purple: darker than every emissive, a touch lighter than the
 * night sky, so the trail reads against sky glow AND over city lights. */
const SMOKE_COLOR = 0x332e3a;
const SMOKE_OPACITY = 0.55;
/** S7 streak smoke: airshow colours per tier — bright enough to read at
 * range, but plain (non-emissive) smoke, so tracers stay the brightest. */
export const STREAK_SMOKE_COLORS: Readonly<Record<3 | 5 | 10, number>> = {
  3: 0xffa424,
  5: 0xff3c9c,
  10: 0x36e2ff,
};
const STREAK_OPACITY = 0.7;

/** Does a plane at this HP trail wounded smoke? Dead planes never smoke. */
export function smokeActive(hp: number): boolean {
  return hp > 0 && hp < MAX_HP * SMOKE_HP_FRAC;
}

interface Puff {
  /** Offset from the CURRENT anchor (re-based every update). */
  offset: Vec3;
  bornAt: number;
}

/**
 * Pure trail-point model for one plane. Per frame it allocates nothing (S8:
 * it re-based every puff into a new object and filtered into a new array a
 * frame — ~5 KB a streaking plane): puffs are re-based in place, aged out by
 * compaction, and a dead puff's object is reused by the next one.
 */
export class SmokeTrail {
  private readonly list: Puff[] = [];
  /** Dead puffs, reused before a new one is built. */
  private readonly spare: Puff[] = [];
  private readonly anchorPos: Vec3 = { x: 0, y: 0, z: 0 };
  private anchored = false;
  private readonly shift: Vec3 = { x: 0, y: 0, z: 0 };
  private lastEmitAt = Number.NEGATIVE_INFINITY;

  get anchor(): Vec3 | null {
    return this.anchored ? this.anchorPos : null;
  }

  /**
   * Advance the trail one frame: re-base every stored offset onto the new
   * anchor (torus-aware), age out dead puffs, and — while `emitting` and the
   * cadence allows — drop a fresh puff at the anchor.
   */
  update(
    anchor: Vec3,
    now: number,
    emitting: boolean,
    emitMs = SMOKE_EMIT_MS,
  ): void {
    const list = this.list;
    if (this.anchored) {
      // Old puff position = oldAnchor + offset; new offset re-bases it onto
      // the new anchor by the shortest torus path between the two anchors.
      const shift = wrapDeltaInto(anchor, this.anchorPos, this.shift);
      for (let i = 0; i < list.length; i++) {
        const o = (list[i] as Puff).offset;
        o.x += shift.x;
        o.y += shift.y;
        o.z += shift.z;
      }
    }
    this.anchorPos.x = anchor.x;
    this.anchorPos.y = anchor.y;
    this.anchorPos.z = anchor.z;
    this.anchored = true;
    // Age out in place, oldest first stays oldest first.
    let kept = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i] as Puff;
      if (now - p.bornAt <= SMOKE_LIFE_MS) list[kept++] = p;
      else this.spare.push(p);
    }
    list.length = kept;
    if (emitting && now - this.lastEmitAt >= emitMs) {
      this.lastEmitAt = now;
      const p = this.spare.pop() ?? { offset: { x: 0, y: 0, z: 0 }, bornAt: 0 };
      p.offset.x = 0;
      p.offset.y = 0;
      p.offset.z = 0;
      p.bornAt = now;
      list.push(p);
    }
  }

  /** Puffs held (live as of the last update; `puffAge01` re-checks). */
  get size(): number {
    return this.list.length;
  }

  /** Puff `i`'s offset from the current anchor (live object: read only). */
  puffOffset(i: number): Vec3 {
    return (this.list[i] as Puff).offset;
  }

  /** Puff `i`'s age at `now`, 0..1 — or −1 once it has outlived its life. */
  puffAge01(i: number, now: number): number {
    const age = now - (this.list[i] as Puff).bornAt;
    return age > SMOKE_LIFE_MS ? -1 : Math.max(0, age) / SMOKE_LIFE_MS;
  }

  /** Live puffs: offsets from the current anchor plus 0..1 age. Allocates —
   * tests and QA; the renderer walks `size` / `puffAge01` instead. */
  puffs(now: number): { offset: Vec3; age01: number }[] {
    return this.list
      .filter((p) => now - p.bornAt <= SMOKE_LIFE_MS)
      .map((p) => ({
        offset: p.offset,
        age01: Math.max(0, now - p.bornAt) / SMOKE_LIFE_MS,
      }));
  }
}

/** THREE half: every plane's smoke in one Points (per-point size patch). */
export class SmokeTrails {
  readonly points: THREE.Points;
  private readonly trails = new Map<string, SmokeTrail>();
  private readonly positions: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;
  /** Tinted mode only: per-puff colour, and each trail's tint. */
  private readonly colors: THREE.BufferAttribute | null;
  private readonly tints = new Map<string, number>();
  private readonly scratchColor = new THREE.Color();
  /** What update() re-uploads each frame (built once — no per-frame array). */
  private readonly uploads: readonly (THREE.BufferAttribute | null)[];
  /** Emission cadence, ms; Infinity = emission off (quality share 0). */
  private emitMs = SMOKE_EMIT_MS;
  private lastPuffCount = 0;

  /** `tinted` (S7): white material + a per-puff colour from each trail's
   * tint — the streak smoke. Untinted is the wounded-plane smoke. */
  constructor({ tinted = false }: { tinted?: boolean } = {}) {
    const budget = MAX_PLANES * MAX_PUFFS;
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(budget * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(budget), 1);
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("aSize", this.sizes);
    this.colors = tinted
      ? new THREE.BufferAttribute(new Float32Array(budget * 3), 3)
      : null;
    if (this.colors) geometry.setAttribute("color", this.colors);
    this.uploads = [this.positions, this.sizes, this.colors];
    geometry.setDrawRange(0, 0);
    // Soft round puff sprite — a bare PointsMaterial renders hard squares.
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
      g.addColorStop(0, "rgba(255,255,255,0.9)");
      g.addColorStop(0.6, "rgba(255,255,255,0.4)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }
    const material = new THREE.PointsMaterial({
      color: tinted ? 0xffffff : SMOKE_COLOR,
      vertexColors: tinted,
      map: new THREE.CanvasTexture(canvas),
      size: 1, // per-point aSize carries the real size
      transparent: true,
      opacity: tinted ? STREAK_OPACITY : SMOKE_OPACITY,
      depthWrite: false,
    });
    // Per-point size: multiply gl_PointSize by the aSize attribute. Distinct
    // cache key — onBeforeCompile patches silently collide without one (V3).
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "attribute float aSize;\n#include <common>",
        )
        .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
    };
    material.customProgramCacheKey = () => "smoke-asize";
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = RENDER_ORDER.smoke;
  }

  /** Per-frame per-plane: advance/emit that plane's trail (torus anchor).
   * `tint` colours its new puffs in tinted mode (ignored otherwise). */
  sync(
    id: string,
    anchor: Vec3,
    now: number,
    emitting: boolean,
    tint = 0xffffff,
  ): void {
    const emit = emitting && Number.isFinite(this.emitMs);
    let trail = this.trails.get(id);
    if (!trail) {
      if (!emit) return; // nothing to age, nothing to start
      trail = new SmokeTrail();
      this.trails.set(id, trail);
    }
    if (emit && this.colors) this.tints.set(id, tint);
    trail.update(anchor, now, emit, this.emitMs);
  }

  /** Respawn/leave: drop the trail so the teleport can't smear it. */
  clear(id: string): void {
    this.trails.delete(id);
    this.tints.delete(id);
  }

  /** Quality share of the emission rate (1 = full, 0 = none): fewer puffs,
   * same lifetime — the trail thins, it never shortens. */
  setShare(share: number): void {
    this.emitMs = share > 0 ? SMOKE_EMIT_MS / share : Number.POSITIVE_INFINITY;
  }

  /** Re-project every live puff around the viewer. Call once per frame.
   * Allocation-free: one pre-bound callback walks the trails (no Map
   * iterator or entry arrays), and puffs are read in place. */
  update(viewer: Vec3, now: number): void {
    this.walk.viewer = viewer;
    this.walk.now = now;
    this.walk.i = 0;
    this.trails.forEach(this.placeTrail);
    const i = this.walk.i;
    this.lastPuffCount = i;
    this.points.geometry.setDrawRange(0, i);
    uploadPrefix(this.uploads, i);
  }

  /** update()'s state for placeTrail. */
  private readonly walk: { viewer: Vec3; now: number; i: number } = {
    viewer: scratchImage,
    now: 0,
    i: 0,
  };

  private readonly placeTrail = (trail: SmokeTrail, id: string): void => {
    const { viewer, now } = this.walk;
    const budget = MAX_PLANES * MAX_PUFFS;
    const anchor = trail.anchor;
    let live = 0;
    if (anchor) {
      for (let k = 0; k < trail.size; k++)
        if (trail.puffAge01(k, now) >= 0) live++;
    }
    if (live === 0) {
      this.trails.delete(id); // fully faded (death clouds age out here)
      this.tints.delete(id);
      return;
    }
    if (!anchor) return;
    const base = nearestImageInto(scratchImage, viewer, anchor);
    // One tint per trail (a tier change recolours the whole streak).
    if (this.colors) this.scratchColor.setHex(this.tints.get(id) ?? 0xffffff);
    let i = this.walk.i;
    for (let k = 0; k < trail.size; k++) {
      if (i >= budget) break;
      const age01 = trail.puffAge01(k, now);
      if (age01 < 0) continue;
      const o = trail.puffOffset(k);
      const rise = age01 * (SMOKE_LIFE_MS / 1000) * SMOKE_RISE;
      this.positions.setXYZ(i, base.x + o.x, base.y + o.y + rise, base.z + o.z);
      // Grow while dispersing; collapse over the last 15% of life so the
      // constant-opacity material still reads as a fade-out.
      const size =
        age01 > 0.85
          ? SIZE_MAX * (1 - (age01 - 0.85) / 0.15)
          : SIZE_MIN + (SIZE_MAX - SIZE_MIN) * (age01 / 0.85);
      this.sizes.setX(i, size);
      if (this.colors) {
        const c = this.scratchColor;
        this.colors.setXYZ(i, c.r, c.g, c.b);
      }
      i++;
    }
    this.walk.i = i;
  };

  /** QA: live puff count last frame (perf reporting). */
  get puffCount(): number {
    return this.lastPuffCount;
  }
}
