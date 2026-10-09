// D3 collapse dust: a billowing cloud that fills the canyon for
// COLLAPSE_DUST_MS after a collapse. Two layers, the smoke and fog idioms:
//
//   1. Puffs (dressing): big soft sprites rolling out from where the debris
//      comes down, rising and spreading, then thinning out. ONE Points for
//      every cloud (one draw); each puff is a pure function of (collapse,
//      puff index, server time) — no state, so a late joiner's cloud is the
//      same cloud. The puff count scales with the quality tier; the sprite
//      size scales up to cover the same air.
//   2. Haze (the sight-blocking part): `dustHaze` says how deep the CAMERA is
//      in a cloud, and storm.ts's atmosphere() — the single fog writer —
//      thickens the haze and pulls the fog in by it. That is identical on
//      every tier (quality.ts visibility parity): a Mobile player never sees
//      further through the dust than a High one.

import type { Collapse } from "@angels-bandits/common/city/collapse";
import {
  COLLAPSE_DUST_MS,
  COLLAPSE_LEAD_MS,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { RENDER_ORDER } from "./render-order";
import { pushUpdateRange } from "./update-range";

/** Puffs per cloud at full quality. */
export const DUST_PUFFS = 40;
/** Clouds drawn at once (the newest win). */
const MAX_CLOUDS = 6;
/** Puff sprite size ramp, m (before the tier's coverage scale). */
const PUFF_SIZE_MIN = 14;
const PUFF_SIZE_MAX = 46;
/** Concrete dust: a warm grey a touch lighter than the night haze. */
const DUST_COLOR = 0x6a625a;
const DUST_OPACITY = 0.5;

/** One puff: where it is and how it looks. */
export interface DustPuff {
  x: number;
  y: number;
  z: number;
  /** Sprite size, m. */
  size: number;
  /** 0..1 opacity factor. */
  alpha: number;
}

/** Fade envelope of a cloud `age` ms after it starts: quick swell, long
 * hang, thin out over the last 40 %. */
function envelope(age: number): number {
  if (age < 0 || age >= COLLAPSE_DUST_MS) return 0;
  const swell = Math.min(1, age / 1200);
  const tail = Math.min(1, (COLLAPSE_DUST_MS - age) / (0.4 * COLLAPSE_DUST_MS));
  return swell * tail;
}

interface Cloud {
  x: number;
  z: number;
  r: number;
  h: number;
}
/** Each collapse's cloud, worked out once (D6: it is pure in the collapse,
 * and was recomputed per puff per frame — an object and a hypot each). */
const clouds = new WeakMap<Collapse, Cloud>();

/** Where a collapse's cloud sits (centre-relative x/z) and how far it
 * reaches: the middle of where its debris comes to rest. */
function cloudOf(c: Collapse): Cloud {
  let cloud = clouds.get(c);
  if (cloud) return cloud;
  const b = c.restBounds;
  const all = c.bounds;
  cloud = {
    x: (b.x0 + b.x1) / 2,
    z: (b.z0 + b.z1) / 2,
    r: Math.max(20, Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2),
    h: Math.min(90, Math.max(25, 0.35 * all.y1)),
  };
  clouds.set(c, cloud);
  return cloud;
}

/** Small integer hash → [0, 1) (puff seeds from the collapse id and the
 * puff index, never a position). */
function hash01(a: number, b: number, salt: number): number {
  let h =
    Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + salt, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Puff `k` of `c`'s cloud at server time `tMs`, centre-relative (add the
 * collapse's x/z), into `out`. False while the puff is not alive.
 */
export function dustPuff(
  c: Collapse,
  k: number,
  tMs: number,
  out: DustPuff,
): boolean {
  return puffOf(c, cloudOf(c), k, tMs, out);
}

/** dustPuff with `c`'s cloud already worked out (D6: once per cloud per
 * frame, not once per puff — the same numbers). */
function puffOf(
  c: Collapse,
  cloud: Cloud,
  k: number,
  tMs: number,
  out: DustPuff,
): boolean {
  const birth = COLLAPSE_LEAD_MS * 0.5 + hash01(c.id, k, 1) * 2500;
  const age = tMs - c.t0 - birth;
  const env = envelope(age);
  if (env <= 0) return false;
  const s = age / 1000;
  const angle = hash01(c.id, k, 2) * Math.PI * 2;
  // Rolls outward fast, then hangs: the canyon fills, it doesn't drift off.
  const reach = cloud.r * (0.3 + 0.9 * hash01(c.id, k, 3));
  const spread = reach + 45 * (1 - Math.exp(-s / 4));
  out.x = cloud.x + Math.cos(angle) * spread;
  out.z = cloud.z + Math.sin(angle) * spread;
  out.y = 4 + cloud.h * hash01(c.id, k, 4) * (1 - Math.exp(-s / 3)) + 0.6 * s;
  out.size =
    PUFF_SIZE_MIN +
    (PUFF_SIZE_MAX - PUFF_SIZE_MIN) *
      Math.min(1, s / 8) *
      (0.7 + 0.3 * hash01(c.id, k, 5));
  out.alpha = env;
  return true;
}

/**
 * How deep a camera at `cam` is in any collapse's dust at server time
 * `tMs`, 0..1 — the sight-blocking haze's input (storm.ts atmosphere()).
 * Full inside the cloud's core below its top, easing to 0 at its rim.
 */
export function dustHaze(
  list: readonly Collapse[],
  cam: Vec3,
  tMs: number,
): number {
  let best = 0;
  for (let e = 0; e < list.length; e++) {
    const c = list[e] as Collapse;
    const age = tMs - c.t0 - COLLAPSE_LEAD_MS;
    const env = envelope(age);
    if (env <= 0) continue;
    const cloud = cloudOf(c);
    const r = cloud.r + 45 * (1 - Math.exp(-age / 4000));
    const dx = wrapDeltaAxis(c.x + cloud.x, cam.x);
    const dz = wrapDeltaAxis(c.z + cloud.z, cam.z);
    // D6: the cheap reject first — most clouds are nowhere near the camera.
    if (dx * dx + dz * dz >= r * r) continue;
    const d = Math.hypot(dx, dz);
    if (d >= r) continue;
    const top = cloud.h + 10;
    if (cam.y >= top + 25) continue;
    const radial = d <= 0.6 * r ? 1 : 1 - (d - 0.6 * r) / (0.4 * r);
    const vertical = cam.y <= top ? 1 : 1 - (cam.y - top) / 25;
    best = Math.max(best, env * radial * vertical);
  }
  return best;
}

/** Upload items [0, n) of `a` this frame. */
function markRange(a: THREE.BufferAttribute, n: number): void {
  a.clearUpdateRanges();
  pushUpdateRange(a, 0, n * a.itemSize);
  a.needsUpdate = true;
}

/** THREE half: every cloud's puffs in one Points (per-point size + alpha). */
export class DustClouds {
  readonly points: THREE.Points;
  private readonly positions: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;
  private readonly alphas: THREE.BufferAttribute;
  private readonly puff: DustPuff = { x: 0, y: 0, z: 0, size: 0, alpha: 0 };
  private share = 1;

  constructor() {
    const budget = MAX_CLOUDS * DUST_PUFFS;
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(budget * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(budget), 1);
    this.alphas = new THREE.BufferAttribute(new Float32Array(budget), 1);
    for (const a of [this.positions, this.sizes, this.alphas]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("aSize", this.sizes);
    geometry.setAttribute("aAlpha", this.alphas);
    geometry.setDrawRange(0, 0);
    // A soft, lumpy puff (the smoke sprite, broader).
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
      g.addColorStop(0, "rgba(255,255,255,0.85)");
      g.addColorStop(0.5, "rgba(255,255,255,0.5)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }
    const material = new THREE.PointsMaterial({
      color: DUST_COLOR,
      map: new THREE.CanvasTexture(canvas),
      size: 1,
      transparent: true,
      opacity: DUST_OPACITY,
      depthWrite: false,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "attribute float aSize;\nattribute float aAlpha;\nvarying float vAlpha;\n#include <common>",
        )
        .replace(
          "gl_PointSize = size;",
          "gl_PointSize = size * aSize;\n\tvAlpha = aAlpha;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "varying float vAlpha;\n#include <common>",
        )
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\n\tdiffuseColor.a *= vAlpha;",
        );
    };
    material.customProgramCacheKey = () => "dust-asize-aalpha";
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = RENDER_ORDER.smoke;
  }

  /** Quality: fewer puffs on cheaper tiers, each bigger to cover the same
   * air (the haze, not the puffs, is what blocks sight). */
  setQuality(tier: QualityTier): void {
    this.share = QUALITY_PROFILES[tier].collapseDust;
  }

  /** Re-project every live puff around the viewer. Call once per frame. */
  update(
    list: readonly Collapse[],
    viewer: Vec3,
    serverMs: number | null,
  ): void {
    let i = 0;
    if (serverMs !== null) {
      const per = Math.max(1, Math.round(DUST_PUFFS * this.share));
      const grow = Math.sqrt(DUST_PUFFS / per);
      let clouds = 0;
      for (let e = list.length - 1; e >= 0 && clouds < MAX_CLOUDS; e--) {
        const c = list[e] as Collapse;
        const age = serverMs - c.t0;
        if (age < 0 || age > COLLAPSE_DUST_MS + 4000) continue;
        clouds++;
        const ox = viewer.x + wrapDeltaAxis(viewer.x, c.x);
        const oz = viewer.z + wrapDeltaAxis(viewer.z, c.z);
        const cloud = cloudOf(c);
        for (let k = 0; k < per; k++) {
          if (!puffOf(c, cloud, k, serverMs, this.puff)) continue;
          this.positions.setXYZ(
            i,
            ox + this.puff.x,
            this.puff.y,
            oz + this.puff.z,
          );
          this.sizes.setX(i, this.puff.size * grow);
          this.alphas.setX(i, this.puff.alpha);
          i++;
        }
      }
    }
    this.points.geometry.setDrawRange(0, i);
    if (i > 0) {
      // D6: three calls, not a loop over a fresh array every frame.
      markRange(this.positions, i);
      markRange(this.sizes, i);
      markRange(this.alphas, i);
    }
  }

  /** QA: puffs drawn last frame. */
  get puffCount(): number {
    return this.points.geometry.drawRange.count;
  }
}
