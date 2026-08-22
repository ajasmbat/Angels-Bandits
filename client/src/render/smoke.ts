// Wounded-plane smoke: any plane strictly below SMOKE_HP_FRAC of MAX_HP
// (snapshot HP — every client sees the same wound) trails dark puffs.
//
// Trail seam rule (same pattern the plane-visibility ticket specifies):
// puffs are stored as OFFSETS from the newest anchor sample and re-based
// through wrapDelta on every update — never world-space history — so a
// seam-crossing plane drags a 10 m trail, not a 2 km streak. The pure
// model (smokeActive, SmokeTrail) is the tested seam; SmokeTrails is the
// thin THREE half: ONE shared Points for every plane's smoke (1 draw call).

import { MAX_HP, SMOKE_HP_FRAC } from "@angels-bandits/common/constants";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import * as THREE from "three";
import { nearestImage } from "./wrapPlacement";

/** Min ms between puffs per plane (~14 Hz at a steady wound). */
export const SMOKE_EMIT_MS = 70;
/** Puff lifetime, ms. */
export const SMOKE_LIFE_MS = 1500;
/** Upward drift baked into a puff as it ages, m/s. */
const SMOKE_RISE = 3;
/** Point budget: planes × puffs a full-rate trail can hold (1500/70 ≈ 22). */
const MAX_PLANES = 12;
const MAX_PUFFS = 24;
/** Puff sprite size ramp over life, meters (grows as it disperses). */
const SIZE_MIN = 2.2;
const SIZE_MAX = 7;
const SMOKE_COLOR = 0x241f2c; // dark oil smoke — reads as silhouette at night
const SMOKE_OPACITY = 0.62;

/** Does a plane at this HP trail wounded smoke? Dead planes never smoke. */
export function smokeActive(hp: number): boolean {
  return hp > 0 && hp < MAX_HP * SMOKE_HP_FRAC;
}

interface Puff {
  /** Offset from the CURRENT anchor (re-based every update). */
  offset: Vec3;
  bornAt: number;
}

/** Pure trail-point model for one plane. */
export class SmokeTrail {
  private list: Puff[] = [];
  private anchorPos: Vec3 | null = null;
  private lastEmitAt = Number.NEGATIVE_INFINITY;

  get anchor(): Vec3 | null {
    return this.anchorPos;
  }

  /**
   * Advance the trail one frame: re-base every stored offset onto the new
   * anchor (torus-aware), age out dead puffs, and — while `emitting` and the
   * cadence allows — drop a fresh puff at the anchor.
   */
  update(anchor: Vec3, now: number, emitting: boolean): void {
    if (this.anchorPos) {
      // Old puff position = oldAnchor + offset; new offset re-bases it onto
      // the new anchor by the shortest torus path between the two anchors.
      const shift = wrapDelta(anchor, this.anchorPos);
      for (const p of this.list) {
        p.offset = {
          x: p.offset.x + shift.x,
          y: p.offset.y + shift.y,
          z: p.offset.z + shift.z,
        };
      }
    }
    this.anchorPos = { ...anchor };
    this.list = this.list.filter((p) => now - p.bornAt <= SMOKE_LIFE_MS);
    if (emitting && now - this.lastEmitAt >= SMOKE_EMIT_MS) {
      this.lastEmitAt = now;
      this.list.push({ offset: { x: 0, y: 0, z: 0 }, bornAt: now });
    }
  }

  /** Live puffs: offsets from the current anchor plus 0..1 age. */
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
  private lastPuffCount = 0;

  constructor() {
    const budget = MAX_PLANES * MAX_PUFFS;
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(budget * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(budget), 1);
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("aSize", this.sizes);
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
      color: SMOKE_COLOR,
      map: new THREE.CanvasTexture(canvas),
      size: 1, // per-point aSize carries the real size
      transparent: true,
      opacity: SMOKE_OPACITY,
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
  }

  /** Per-frame per-plane: advance/emit that plane's trail (torus anchor). */
  sync(id: string, anchor: Vec3, now: number, emitting: boolean): void {
    let trail = this.trails.get(id);
    if (!trail) {
      if (!emitting) return; // nothing to age, nothing to start
      trail = new SmokeTrail();
      this.trails.set(id, trail);
    }
    trail.update(anchor, now, emitting);
  }

  /** Respawn/leave: drop the trail so the teleport can't smear it. */
  clear(id: string): void {
    this.trails.delete(id);
  }

  /** Re-project every live puff around the viewer. Call once per frame. */
  update(viewer: Vec3, now: number): void {
    let i = 0;
    const budget = MAX_PLANES * MAX_PUFFS;
    for (const [id, trail] of this.trails) {
      const anchor = trail.anchor;
      const puffs = anchor ? trail.puffs(now) : [];
      if (puffs.length === 0) {
        this.trails.delete(id); // fully faded (death clouds age out here)
        continue;
      }
      if (!anchor) continue;
      const base = nearestImage(viewer, anchor);
      for (const p of puffs) {
        if (i >= budget) break;
        const rise = p.age01 * (SMOKE_LIFE_MS / 1000) * SMOKE_RISE;
        this.positions.setXYZ(
          i,
          base.x + p.offset.x,
          base.y + p.offset.y + rise,
          base.z + p.offset.z,
        );
        // Grow while dispersing; collapse over the last 15% of life so the
        // constant-opacity material still reads as a fade-out.
        const size =
          p.age01 > 0.85
            ? SIZE_MAX * (1 - (p.age01 - 0.85) / 0.15)
            : SIZE_MIN + (SIZE_MAX - SIZE_MIN) * (p.age01 / 0.85);
        this.sizes.setX(i, size);
        i++;
      }
    }
    this.lastPuffCount = i;
    this.points.geometry.setDrawRange(0, i);
    this.positions.needsUpdate = true;
    this.sizes.needsUpdate = true;
  }

  /** QA: live puff count last frame (perf reporting). */
  get puffCount(): number {
    return this.lastPuffCount;
  }
}
