// D3 collapse dust: a billowing cloud that fills the canyon for
// COLLAPSE_DUST_MS after a collapse. Two layers, the smoke and fog idioms:
//
//   1. Puffs (dressing): big soft sprites. ONE Points for every cloud (one
//      draw); each puff is a pure function of (collapse, puff index, server
//      time) — no state, so a late joiner's cloud is the same cloud. The
//      puff count scales with the quality tier; the sprite size scales up to
//      cover the same air. D10 gave the cloud three parts:
//        - the SURGE: a pyroclastic, ground-hugging wall of dust that pours
//          out of the lot when the mass hits the ground, runs out to the
//          street and then rolls along it for most of a block each way,
//          growing, slowly lifting and lingering;
//        - the COLUMN: the D3 cloud rising over the ruin;
//        - SQUIBS: dust jetting out of the facade just under each storey as
//          the crush front reaches it (collapse.ts floor events), short and
//          sharp — the look of a real progressive collapse.
//      Puffs fade as the camera comes into them (no hard sprite plane in the
//      face) and sit high enough that the ground clips only their soft rim.
//      The scene has no depth texture to fade against, so this stands in
//      for true soft particles.
//   2. Haze (the sight-blocking part): `dustHaze` says how deep the CAMERA is
//      in a cloud — its core or (D10) the surge corridors down the streets —
//      and storm.ts's atmosphere(), the single fog writer, thickens the haze
//      and pulls the fog in by it. That is identical on every tier
//      (quality.ts visibility parity): a Mobile player never sees further
//      through the dust than a High one.

import {
  BEAT_BREAK,
  BEAT_CRUSH,
  BEAT_GIVE,
  BEAT_LAND,
  type Collapse,
  PANCAKE,
  collapseFloorEvents,
} from "@angels-bandits/common/city/collapse";
import {
  BLOCK_PITCH,
  COLLAPSE_DUST_MS,
  COLLAPSE_LEAD_MS,
  STREET_WIDTH,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { RENDER_ORDER } from "./render-order";
import { pushUpdateRange } from "./update-range";

/** Puffs per cloud at full quality. */
export const DUST_PUFFS = 72;
/** Clouds drawn at once (the newest win). */
const MAX_CLOUDS = 6;
/** Puff sprite size ramp, m (before the tier's coverage scale). */
const PUFF_SIZE_MIN = 14;
const PUFF_SIZE_MAX = 46;
/** Concrete dust: a warm grey a touch lighter than the night haze. */
const DUST_COLOR = 0x6a625a;
const DUST_OPACITY = 0.5;

/** D10 puff kinds, and their shares of a cloud's puffs. */
export const PUFF_SURGE = 0;
export const PUFF_COLUMN = 1;
export const PUFF_SQUIB = 2;
const SURGE_SHARE = 0.5;
const COLUMN_SHARE = 0.3;
/** The surge: e-folding time of its run, s; how far along the street it
 * rolls past where it meets it, m (most of a block each way); how high it
 * hugs the ground, m; and how fast it lifts once it has slowed, m/s. */
const SURGE_TAU_S = 2.4;
export const SURGE_ALONG_M = 0.8 * BLOCK_PITCH;
export const SURGE_TOP_M = 14;
const SURGE_LIFT = 0.45;
/** A squib: how far it jets, m, its e-folding time, s, and its life, ms. */
const SQUIB_REACH_M = 22;
const SQUIB_TAU_S = 0.5;
export const SQUIB_LIFE_MS = 3500;

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

/** A squib's envelope `age` ms after its floor event: a sharp puff. */
function squibEnvelope(age: number): number {
  if (age < 0 || age >= SQUIB_LIFE_MS) return 0;
  return Math.min(1, age / 120) * (1 - age / SQUIB_LIFE_MS);
}

interface Cloud {
  x: number;
  z: number;
  r: number;
  h: number;
  /** D10: the standing footprint of what fell (centre-relative). */
  fx0: number;
  fx1: number;
  fz0: number;
  fz1: number;
  /** When the mass first hits the ground, ms after t0 (the surge starts). */
  surgeAt: number;
  /** The floor events squibs fire on (crushed storeys, a pancake's failure;
   * a topple's break-ups). */
  squibs: { t: number; x: number; y: number; z: number }[];
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
  let fx0 = Number.POSITIVE_INFINITY;
  let fx1 = Number.NEGATIVE_INFINITY;
  let fz0 = Number.POSITIVE_INFINITY;
  let fz1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < c.n; i++) {
    fx0 = Math.min(fx0, (c.ox[i] as number) - (c.hx[i] as number));
    fx1 = Math.max(fx1, (c.ox[i] as number) + (c.hx[i] as number));
    fz0 = Math.min(fz0, (c.oz[i] as number) - (c.hz[i] as number));
    fz1 = Math.max(fz1, (c.oz[i] as number) + (c.hz[i] as number));
  }
  const events = collapseFloorEvents(c);
  let surgeAt = c.endMs * 0.5;
  for (const e of events) {
    if (e.kind === BEAT_LAND) {
      surgeAt = e.t;
      break;
    }
  }
  const squibs: Cloud["squibs"] = [];
  for (const e of events) {
    const fire =
      c.style === PANCAKE
        ? e.kind === BEAT_CRUSH || e.kind === BEAT_GIVE
        : e.kind === BEAT_BREAK;
    if (fire) squibs.push({ t: e.t, x: e.x, y: e.y, z: e.z });
  }
  cloud = {
    x: (b.x0 + b.x1) / 2,
    z: (b.z0 + b.z1) / 2,
    r: Math.max(20, Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2),
    h: Math.min(90, Math.max(25, 0.35 * all.y1)),
    fx0,
    fx1,
    fz0,
    fz1,
    surgeAt,
    squibs,
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

/** D10: puff `k`'s kind in collapse `id`'s cloud (PUFF_*). */
export function puffKind(id: number, k: number): number {
  const u = hash01(id, k, 9);
  return u < SURGE_SHARE
    ? PUFF_SURGE
    : u < SURGE_SHARE + COLUMN_SHARE
      ? PUFF_COLUMN
      : PUFF_SQUIB;
}

/** The street line (a BLOCK_PITCH multiple) a run from world coordinate
 * `from` meets going `sign` (±1) — never behind it. */
function streetAhead(from: number, sign: number): number {
  return sign > 0
    ? Math.ceil(from / BLOCK_PITCH) * BLOCK_PITCH
    : Math.floor(from / BLOCK_PITCH) * BLOCK_PITCH;
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
  const kind = puffKind(c.id, k);
  if (kind === PUFF_SQUIB && cloud.squibs.length > 0) {
    return squibOf(c, cloud, k, tMs, out);
  }
  if (kind === PUFF_SURGE) return surgeOf(c, cloud, k, tMs, out);
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

/** D10: a surge puff — out of the lot to the street on one side, then
 * along the street one way, hugging the ground, then lifting. */
function surgeOf(
  c: Collapse,
  cloud: Cloud,
  k: number,
  tMs: number,
  out: DustPuff,
): boolean {
  const birth = cloud.surgeAt + hash01(c.id, k, 1) * 2500;
  const age = tMs - c.t0 - birth;
  const env = envelope(age);
  if (env <= 0) return false;
  const s = age / 1000;
  const side = Math.floor(hash01(c.id, k, 2) * 4); // −x, +x, −z, +z
  const alongX = side < 2;
  const sign = side % 2 === 0 ? -1 : 1;
  const across = hash01(c.id, k, 3);
  // Out of the lot: from the footprint's face, at a point along it…
  const face = alongX
    ? sign > 0
      ? cloud.fx1
      : cloud.fx0
    : sign > 0
      ? cloud.fz1
      : cloud.fz0;
  const startAcross = alongX
    ? cloud.fz0 + (cloud.fz1 - cloud.fz0) * across
    : cloud.fx0 + (cloud.fx1 - cloud.fx0) * across;
  // …to the street line beyond it (world coordinates for the grid).
  const worldFace = (alongX ? c.x : c.z) + face;
  const street = streetAhead(worldFace, sign) - (alongX ? c.x : c.z);
  const out1 = Math.abs(street - face);
  // …then along the street, one way, most of a block.
  const turn = hash01(c.id, k, 4) < 0.5 ? -1 : 1;
  const along = SURGE_ALONG_M * (0.35 + 0.65 * hash01(c.id, k, 5));
  const run = (out1 + along) * (1 - Math.exp(-s / SURGE_TAU_S));
  const lane = (hash01(c.id, k, 6) * 2 - 1) * (STREET_WIDTH / 2 - 3);
  let u: number; // along the fall-out axis, centre-relative
  let v: number; // across it
  if (run <= out1) {
    u = face + sign * run;
    v = startAcross;
  } else {
    // In the street: spread across the roadway, rolling along it.
    u = street + lane;
    v = startAcross + turn * (run - out1);
  }
  out.x = alongX ? u : v;
  out.z = alongX ? v : u;
  const grow = Math.min(1, s / 6);
  out.size =
    (PUFF_SIZE_MIN * 0.8 + (PUFF_SIZE_MAX - PUFF_SIZE_MIN * 0.8) * grow) *
    (0.6 + 0.4 * hash01(c.id, k, 7));
  // Ground-hugging; slowly lifting once it has slowed. Never so low that
  // the ground cuts more than the sprite's soft rim.
  const lift = SURGE_LIFT * Math.max(0, s - 3);
  out.y = Math.max(
    0.35 * out.size,
    2 + (SURGE_TOP_M - 2) * hash01(c.id, k, 8) + lift,
  );
  out.alpha = env * 0.9;
  return true;
}

/** D10: a squib — dust jetting out of the facade just under a storey as
 * the crush front reaches it. */
function squibOf(
  c: Collapse,
  cloud: Cloud,
  k: number,
  tMs: number,
  out: DustPuff,
): boolean {
  const e = cloud.squibs[
    Math.floor(hash01(c.id, k, 1) * cloud.squibs.length)
  ] as Cloud["squibs"][number];
  const age = tMs - c.t0 - e.t - hash01(c.id, k, 2) * 150;
  const env = squibEnvelope(age);
  if (env <= 0) return false;
  const s = age / 1000;
  const side = Math.floor(hash01(c.id, k, 3) * 4);
  const alongX = side < 2;
  const sign = side % 2 === 0 ? -1 : 1;
  const across = hash01(c.id, k, 4);
  const jet =
    SQUIB_REACH_M *
    (0.6 + 0.4 * hash01(c.id, k, 5)) *
    (1 - Math.exp(-s / SQUIB_TAU_S));
  if (c.style === PANCAKE) {
    const face = alongX
      ? sign > 0
        ? cloud.fx1
        : cloud.fx0
      : sign > 0
        ? cloud.fz1
        : cloud.fz0;
    const at = alongX
      ? cloud.fz0 + (cloud.fz1 - cloud.fz0) * across
      : cloud.fx0 + (cloud.fx1 - cloud.fx0) * across;
    out.x = alongX ? face + sign * jet : at;
    out.z = alongX ? at : face + sign * jet;
    // Out of the windows of the storey under the one that just gave way.
    out.y = Math.max(2, e.y - 1 - 3 * hash01(c.id, k, 6)) - 0.8 * s;
  } else {
    // A break-up in the air: a burst round where the section came apart.
    const a = hash01(c.id, k, 6) * Math.PI * 2;
    out.x = e.x + Math.cos(a) * jet * 0.6;
    out.z = e.z + Math.sin(a) * jet * 0.6;
    out.y = Math.max(2, e.y + (hash01(c.id, k, 7) - 0.5) * 8 - 1.5 * s);
  }
  out.size = 5 + 11 * Math.min(1, s / 1.6);
  out.alpha = env;
  return true;
}

/**
 * How deep a camera at `cam` is in any collapse's dust at server time
 * `tMs`, 0..1 — the sight-blocking haze's input (storm.ts atmosphere()).
 * Full inside the cloud's core below its top, easing to 0 at its rim; D10:
 * and down the streets the surge has rolled along so far, below its top.
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
    const dx = wrapDeltaAxis(c.x + cloud.x, cam.x);
    const dz = wrapDeltaAxis(c.z + cloud.z, cam.z);
    best = Math.max(best, surgeHaze(c, cloud, cam, tMs));
    const r = cloud.r + 45 * (1 - Math.exp(-age / 4000));
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

/** D10: the surge's share of the haze — inside a street the surge has
 * reached (out of the lot, then along the street as far as its farthest
 * puffs), under its top. */
function surgeHaze(c: Collapse, cloud: Cloud, cam: Vec3, tMs: number): number {
  const age = tMs - c.t0 - cloud.surgeAt;
  const env = envelope(age);
  if (env <= 0) return 0;
  const top = SURGE_TOP_M + 10 + SURGE_LIFT * Math.max(0, age / 1000 - 3);
  if (cam.y > top + 15) return 0;
  const vertical = cam.y <= top ? 1 : 1 - (cam.y - top) / 15;
  const x = wrapDeltaAxis(c.x, cam.x);
  const z = wrapDeltaAxis(c.z, cam.z);
  const reach = 1 - Math.exp(-age / 1000 / SURGE_TAU_S);
  let best = 0;
  for (let side = 0; side < 4; side++) {
    const alongX = side < 2;
    const sign = side % 2 === 0 ? -1 : 1;
    const face = alongX
      ? sign > 0
        ? cloud.fx1
        : cloud.fx0
      : sign > 0
        ? cloud.fz1
        : cloud.fz0;
    const street =
      streetAhead((alongX ? c.x : c.z) + face, sign) - (alongX ? c.x : c.z);
    const out1 = Math.abs(street - face);
    const run = (out1 + SURGE_ALONG_M) * reach;
    const u = alongX ? x : z; // the fall-out axis
    const v = alongX ? z : x;
    const lo = alongX ? cloud.fz0 : cloud.fx0;
    const hi = alongX ? cloud.fz1 : cloud.fx1;
    // The run out of the lot to the street…
    const outward = (u - face) * sign;
    const inLot =
      outward >= 0 && outward <= Math.min(run, out1) && v >= lo && v <= hi;
    // …and the street itself, as far as the surge has rolled.
    const inStreet =
      run > out1 &&
      Math.abs(u - street) <= STREET_WIDTH / 2 &&
      v >= lo - (run - out1) &&
      v <= hi + (run - out1);
    if (inLot || inStreet) best = Math.max(best, 0.85);
  }
  return best * env * vertical;
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
          const px = ox + this.puff.x;
          const pz = oz + this.puff.z;
          const size = this.puff.size * grow;
          // D10: fade a puff the camera is coming into — no hard sprite
          // plane across the view (the stand-in for a depth fade).
          const ddx = px - viewer.x;
          const ddy = this.puff.y - viewer.y;
          const ddz = pz - viewer.z;
          const near = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) / size;
          const fade = Math.min(1, Math.max(0, (near - 0.25) / 0.6));
          if (fade <= 0) continue;
          this.positions.setXYZ(i, px, this.puff.y, pz);
          this.sizes.setX(i, size);
          this.alphas.setX(i, this.puff.alpha * fade);
          i++;
        }
      }
    }
    this.points.geometry.setDrawRange(0, i);
    // P4: three still issues a (counted) draw for an empty range.
    this.points.visible = i > 0;
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
