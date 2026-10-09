// S5 fog banks: low clouds of haze sliding between the towers on the shared
// air, lit from below by the neon and the sodium lamps. Client-only and
// cosmetic (never solid, never fed to collision).
//
// The pure seam:
//  - fogBankLayout(seed): FOG_BANK_COUNT banks, seeded from the world seed
//    alone (a salted mulberry32 stream), spaced so no two banks overlap
//    (wrap-aware), each a cluster of PUFFS_PER_BANK soft puffs.
//  - Every bank rides airDrift() — the same air the litter hops on and the
//    trees sway in — so the whole layout moves rigidly and its spacing holds
//    forever. Each bank also thickens and dissolves on its own multi-minute
//    cycle (bankDensity), so the sky is never the same twice.
//
// The renderer is ONE draw: an instanced, camera-facing quad per puff (GL
// points would hit the driver's point-size cap up close and pop at the
// screen edge). Blended, not additive, and fogged like any surface, so a
// far bank dissolves into the haze it is made of.
//
// Readability contract (planes and tracers):
//  - A puff's alpha is capped so a whole bank is at most BANK_OPACITY_MAX
//    along any ray (1 − (1 − a)^PUFFS ≤ 0.45).
//  - Puffs fade out within FADE_CLEAR (+ their radius) of the camera and of
//    every plane, so a bank never sits between the chase camera and its own
//    plane, nor on top of an enemy.
//  - Render order below 0: tracers, planes and tags always paint over.
//  - A puff is never drawn wider than FILL_CLAMP × its view distance (≈ 25 %
//    of the screen height): bounded overdraw.
//
// Shimmer: everything moves on the latched world clock, slowly — the air at
// a few m/s, the churn at a hundredth of a radian per second — so a frozen
// camera sees a soft gradient creep, never a flicker.

import { mulberry32 } from "@angels-bandits/common/city";
import { FOG_DISTANCE, WORLD_SIZE } from "@angels-bandits/common/constants";
import { airDrift } from "@angels-bandits/common/wind";
import type { Vec3 } from "@angels-bandits/common/world";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { RENDER_ORDER } from "./render-order";
import { SIGN_PALETTE } from "./signage";
import { nearestImageInto, uploadPrefix } from "./wrapPlacement";

/** Banks in the world (the torus is 4 km²; ~half are inside the fog). */
export const FOG_BANK_COUNT = 40;
/** Puffs per bank. */
export const PUFFS_PER_BANK = 5;
/** Most a whole bank may obscure along any ray. */
export const BANK_OPACITY_MAX = 0.45;
/** Per-puff alpha cap: PUFFS_PER_BANK of them stack to BANK_OPACITY_MAX. */
export const PUFF_ALPHA = 1 - (1 - BANK_OPACITY_MAX) ** (1 / PUFFS_PER_BANK);
/** Bank radius (horizontal), m. */
export const BANK_RADIUS_MIN = 45;
export const BANK_RADIUS_MAX = 85;
/** Bank centre altitude, m — between the towers, under most roofs. */
export const BANK_ALT_MIN = 25;
export const BANK_ALT_MAX = 115;
/** Banks' centres keep at least this × the sum of their radii apart. */
export const BANK_SPACING = 1.1;
/** A bank's puffs sit inside this share of its radius (vertically ×0.45). */
const PUFF_SPREAD = 0.55;
/** A puff's centre sits at least this × its diameter above the street. */
export const GROUND_CLEAR = 0.4;
/** Puff diameter as a share of the bank radius. */
const PUFF_SIZE_MIN = 1.0;
const PUFF_SIZE_MAX = 1.4;
/** Fraction of the air speed a bank moves at (low air is slowed by the city). */
export const BANK_DRIFT = 0.8;
/** Churn: puffs orbit their bank's centre, rad/s. */
const CHURN_RATE = 0.012;
/** Density cycle per bank, s. */
const CYCLE_MIN_S = 240;
const CYCLE_MAX_S = 420;
/** Clear distance from the camera and every plane, m (plus the puff radius). */
export const FADE_CLEAR = 25;
/** Widest a puff is drawn, as a share of its view distance. */
export const FILL_CLAMP = 0.35;
/** Most planes a frame fades the banks around. */
export const MAX_FADE_PLANES = 12;

/** One puff, relative to its bank. */
export interface FogPuff {
  /** Offset from the bank centre, m. */
  ox: number;
  oy: number;
  oz: number;
  /** Diameter, m. */
  size: number;
}

export interface FogBank {
  /** Canonical centre at drift zero, m. */
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Lamp tint (linear rgb) lighting the bank from below, and how much. */
  tint: readonly [number, number, number];
  lit: number;
  /** Density cycle, s, and its phase in [0, 1). */
  cycle: number;
  phase: number;
  puffs: FogPuff[];
}

/** Sodium street-lamp amber (linear). */
const SODIUM: readonly [number, number, number] = [1.0, 0.55, 0.22];

/** Wrap-aware horizontal distance between two canonical points. */
const wrapDist = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(wrapDeltaAxis(ax, bx), wrapDeltaAxis(az, bz));

/**
 * The world's fog banks. Pure: a seed always lays out the same banks, and
 * no two overlap (centres ≥ BANK_SPACING × (r_i + r_j) apart, on the torus).
 */
export function fogBankLayout(seed: number): FogBank[] {
  const rand = mulberry32((seed ^ 0x5f0cb4a1) >>> 0);
  const banks: FogBank[] = [];
  for (let tries = 0; banks.length < FOG_BANK_COUNT && tries < 4000; tries++) {
    const x = rand() * WORLD_SIZE;
    const z = rand() * WORLD_SIZE;
    const radius =
      BANK_RADIUS_MIN + (BANK_RADIUS_MAX - BANK_RADIUS_MIN) * rand();
    if (
      banks.some(
        (b) => wrapDist(b.x, b.z, x, z) < BANK_SPACING * (b.radius + radius),
      )
    ) {
      continue;
    }
    const y = BANK_ALT_MIN + (BANK_ALT_MAX - BANK_ALT_MIN) * rand();
    // Mostly sodium-lit; a third take a sign's colour.
    const pick = rand();
    const sign = SIGN_PALETTE[Math.floor(rand() * SIGN_PALETTE.length)];
    const tint: readonly [number, number, number] =
      pick < 0.66 || !sign ? SODIUM : [sign.r, sign.g, sign.b];
    const lit = 0.35 + 0.45 * rand();
    const cycle = CYCLE_MIN_S + (CYCLE_MAX_S - CYCLE_MIN_S) * rand();
    const phase = rand();
    const puffs: FogPuff[] = [];
    for (let j = 0; j < PUFFS_PER_BANK; j++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * radius * PUFF_SPREAD;
      const oy = (rand() * 2 - 1) * radius * PUFF_SPREAD * 0.45;
      const size =
        radius * (PUFF_SIZE_MIN + (PUFF_SIZE_MAX - PUFF_SIZE_MIN) * rand());
      puffs.push({
        ox: Math.cos(a) * r,
        // Never so low that the street clips the quad: a hard line along the
        // ground where the soft puff should be.
        oy: Math.max(oy, GROUND_CLEAR * size - y),
        oz: Math.sin(a) * r,
        size,
      });
    }
    banks.push({ x, y, z, radius, tint, lit, cycle, phase, puffs });
  }
  return banks;
}

const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * A bank's density at world time `serverMs`, 0..1: it forms, holds, thins
 * and is gone for a while each cycle. Wetter air (`haze`, 0..1) holds more
 * of it, never past 1. Pure; continuous in time.
 */
export function bankDensity(bank: FogBank, serverMs: number, haze = 0): number {
  let u = (serverMs / 1000 / bank.cycle + bank.phase) % 1;
  if (u < 0) u += 1;
  const wave = 0.5 - 0.5 * Math.cos(Math.PI * 2 * u);
  const d = smooth01((wave - 0.15) / 0.55);
  return Math.min(1, d * (0.75 + 0.25 * Math.min(1, Math.max(0, haze))));
}

/** A puff's canonical centre at `serverMs` (air drift + churn), into `out`.
 * `drift` is airDrift(serverMs) — computed once a frame by the caller. */
export function puffCentreInto(
  bank: FogBank,
  puff: FogPuff,
  serverMs: number,
  drift: { x: number; z: number },
  out: Vec3,
): Vec3 {
  const a = ((serverMs / 1000) * CHURN_RATE) % (Math.PI * 2);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = bank.x + drift.x * BANK_DRIFT + c * puff.ox - s * puff.oz;
  const z = bank.z + drift.z * BANK_DRIFT + s * puff.ox + c * puff.oz;
  out.x = ((x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
  out.y = bank.y + puff.oy;
  out.z = ((z % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
  return out;
}

// --- Renderer -------------------------------------------------------------

const VERTEX = /* glsl */ `
attribute vec4 aPuff;  // render-space centre (xyz) and diameter (w)
attribute vec4 aTint;  // light multiplier (rgb) and alpha (a)
uniform vec3 uPlanes[${MAX_FADE_PLANES}];
uniform int uPlaneCount;
varying vec2 vUv;
varying vec4 vTint;
#include <fog_pars_vertex>
float abClear(vec3 p, vec3 q, float r) {
  return smoothstep(r, r + ${FADE_CLEAR.toFixed(1)}, distance(p, q));
}
void main() {
  vec3 centre = aPuff.xyz;
  float radius = 0.5 * aPuff.w;
  vec4 mvCentre = viewMatrix * vec4(centre, 1.0);
  float dist = length(mvCentre.xyz);
  // Bounded overdraw: never wider than FILL_CLAMP × the view distance.
  float size = min(aPuff.w, ${FILL_CLAMP.toFixed(2)} * dist);
  vec4 mvPosition = mvCentre + vec4(position.xy * size, 0.0, 0.0);
  // Never between the camera and a plane, never on top of one.
  float clear = abClear(centre, cameraPosition, radius);
  for (int i = 0; i < ${MAX_FADE_PLANES}; i++) {
    if (i >= uPlaneCount) break;
    clear *= abClear(centre, uPlanes[i], radius);
  }
  vTint = vec4(aTint.rgb, aTint.a * clear);
  vUv = position.xy;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec4 vTint;
#include <fog_pars_fragment>
void main() {
  // A soft round puff: a Gaussian core that reaches exactly 0 at the rim.
  float r2 = dot(vUv, vUv) * 4.0;
  float shape = exp(-r2 * 1.1) * (1.0 - smoothstep(0.45, 1.0, r2));
  if (vTint.a * shape < 0.002) discard;
  #ifdef USE_FOG
    // The haze it is made of (fog.ts's haze colour), lit from below.
    vec3 abBase = mix(fogColor, abHazeParams.rgb, abHazeParams.a);
  #else
    vec3 abBase = vec3(0.06, 0.05, 0.08);
  #endif
  gl_FragColor = vec4(abBase * vTint.rgb, vTint.a * shape);
  #include <fog_fragment>
}
`;

/** How much brighter than the bare haze the lit underside reads. */
const LIGHT_GAIN = 2.6;

/** Every drawn puff as ONE instanced quad mesh — one draw call. */
export class FogBanks {
  readonly mesh: THREE.Mesh;
  private readonly banks: FogBank[];
  private readonly puffAttr: THREE.InstancedBufferAttribute;
  private readonly tintAttr: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.InstancedBufferGeometry;
  /** Both per-instance attributes, for uploadPrefix (one array, reused). */
  private readonly uploads: THREE.BufferAttribute[];
  private readonly planesU: THREE.Vector3[] = Array.from(
    { length: MAX_FADE_PLANES },
    () => new THREE.Vector3(),
  );
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly drift = { x: 0, z: 0 };
  private readonly canon: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly img: Vec3 = { x: 0, y: 0, z: 0 };
  private drawn = 0;

  constructor(seed: number) {
    this.banks = fogBankLayout(seed);
    const capacity = this.banks.length * PUFFS_PER_BANK;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute("position", quad.getAttribute("position"));
    this.puffAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    );
    this.tintAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    );
    this.puffAttr.setUsage(THREE.DynamicDrawUsage);
    this.tintAttr.setUsage(THREE.DynamicDrawUsage);
    this.uploads = [this.puffAttr, this.tintAttr];
    geometry.setAttribute("aPuff", this.puffAttr);
    geometry.setAttribute("aTint", this.tintAttr);
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uPlanes: { value: null }, uPlaneCount: { value: 0 } },
    ]);
    // After the merge (which would clone them): the live vectors.
    (this.uniforms.uPlanes as THREE.IUniform).value = this.planesU;
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        fog: true,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.fogBanks;
    this.mesh.visible = false;
  }

  /**
   * Place every puff in range. `serverMs` is the latched world clock (null
   * before sync: hidden — a bank in the wrong place would differ between
   * clients); `planes` the planes on screen, render-space or canonical (the
   * fade is measured to their nearest image); `haze` the weather's.
   */
  update(
    cameraPos: Vec3,
    serverMs: number | null,
    planes: readonly Vec3[],
    haze: number,
  ): void {
    if (serverMs === null) {
      this.mesh.visible = false;
      this.drawn = 0;
      return;
    }
    this.mesh.visible = true;
    airDrift(serverMs, this.drift);
    const n = Math.min(planes.length, MAX_FADE_PLANES);
    for (let i = 0; i < n; i++) {
      const p = nearestImageInto(this.img, cameraPos, planes[i] as Vec3);
      (this.planesU[i] as THREE.Vector3).set(p.x, p.y, p.z);
    }
    (this.uniforms.uPlaneCount as THREE.IUniform).value = n;
    const reach = FOG_DISTANCE + BANK_RADIUS_MAX;
    const puffs = this.puffAttr.array as Float32Array;
    const tints = this.tintAttr.array as Float32Array;
    // S8: puffCentreInto's churn, once a frame rather than once a puff (the
    // same arithmetic, so the same centres), and a squared range test — a
    // double handed to a call per puff, and Math.hypot's result, were boxed.
    const a = ((serverMs / 1000) * CHURN_RATE) % (Math.PI * 2);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const dxAir = this.drift.x * BANK_DRIFT;
    const dzAir = this.drift.z * BANK_DRIFT;
    const canon = this.canon;
    let k = 0;
    for (let b = 0; b < this.banks.length; b++) {
      const bank = this.banks[b] as FogBank;
      const density = bankDensity(bank, serverMs, haze);
      if (density <= 0.001) continue;
      for (let q = 0; q < bank.puffs.length; q++) {
        const puff = bank.puffs[q] as FogPuff;
        const x = bank.x + dxAir + c * puff.ox - s * puff.oz;
        const z = bank.z + dzAir + s * puff.ox + c * puff.oz;
        canon.x = ((x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
        canon.y = bank.y + puff.oy;
        canon.z = ((z % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
        const ex = wrapDeltaAxis(cameraPos.x, canon.x);
        const ez = wrapDeltaAxis(cameraPos.z, canon.z);
        if (ex * ex + ez * ez > reach * reach) continue;
        const p = nearestImageInto(this.img, cameraPos, this.canon);
        puffs[k * 4] = p.x;
        puffs[k * 4 + 1] = p.y;
        puffs[k * 4 + 2] = p.z;
        puffs[k * 4 + 3] = puff.size;
        // Lit from below: the lower the puff, the more lamp colour.
        const low = Math.min(1, Math.max(0, (140 - p.y) / 120));
        const lit = bank.lit * low;
        tints[k * 4] = LIGHT_GAIN * (1 - lit + lit * bank.tint[0] * 1.6);
        tints[k * 4 + 1] = LIGHT_GAIN * (1 - lit + lit * bank.tint[1] * 1.6);
        tints[k * 4 + 2] = LIGHT_GAIN * (1 - lit + lit * bank.tint[2] * 1.6);
        tints[k * 4 + 3] = PUFF_ALPHA * density;
        k++;
      }
    }
    this.drawn = k;
    this.geometry.instanceCount = k;
    uploadPrefix(this.uploads, k);
  }

  /** Puffs drawn last frame (QA, perf). */
  get count(): number {
    return this.drawn;
  }

  /** The layout (QA). */
  get layout(): readonly FogBank[] {
    return this.banks;
  }
}
