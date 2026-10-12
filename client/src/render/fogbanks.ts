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
//
// Stormlit L5 (low mist):
//  - The banks sit lower (35–80 m) and PART AROUND THE TOWERS: each puff's
//    alpha is scaled on the CPU by its clearance from the standing building
//    boxes around it (buildingClearance — smoothstep(r, r + soft, distance),
//    so a sprite that could reach a box is already gone: no hard line where
//    a facade cuts a quad, and no pop, since the distance is continuous).
//    There is no depth texture to soft-fade against; this is the analytic
//    equivalent, and steam.ts uses the same helper.
//  - CANYON MIST: strands of small puffs on the street centre lines at
//    12–40 m (canyonMistLayout), drifting ALONG their street with the
//    along-street share of the shared air — channelled by the canyon. A
//    puff is never wider than the facade-to-facade gap (the street contract:
//    facades stand at LOT_LINE), so it needs no clearance test. Straight
//    through the crossings.
//  - Layered: the sprites flatten into sheets seen side-on and stay round
//    seen from above, and are lit from below — the sodium street light, an
//    orange underglow strongest on their lower half.
//  - Same draw, same shader, same render order. Fog banks and mist can hide
//    a plane, so they are identical on every quality tier.

import {
  type Building,
  CITY_GRID,
  mulberry32,
  standingProfile,
} from "@angels-bandits/common/city";
import { LOT_LINE } from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  FOG_DISTANCE,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
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
/** Bank centre altitude, m — between the towers, under most roofs (L5:
 * 25–115 → 35–80, the low mist band). */
export const BANK_ALT_MIN = 35;
export const BANK_ALT_MAX = 80;
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
/** L5: a bank puff fades out over this much clearance beyond its radius, m. */
export const BANK_PART_SOFT = 12;
/** L5 vertical squash of a sheet seen side-on (1 = round): banks, mist. */
const BANK_FLAT = 0.6;
const MIST_FLAT = 0.5;
/** L5 underglow: extra lamp light on a puff's lower half (banks, mist). */
const BANK_UNDER = 0.6;
const MIST_UNDER = 1.4;

// --- L5 canyon mist ---------------------------------------------------------

/** Strands in the world, and puffs per strand. */
export const MIST_STRANDS = 48;
export const PUFFS_PER_STRAND = 6;
/** Strand centre altitude band, m. */
export const MIST_ALT_MIN = 12;
export const MIST_ALT_MAX = 40;
/** Puff diameter band, m — capped so a puff never reaches a facade. */
export const MIST_SIZE_MIN = 14;
export const MIST_SIZE_MAX = 26;
/** Most a puff sits off its street's centre line, m. */
export const MIST_CROSS_MAX = 2;
/** Puff spacing along a strand, m. */
const MIST_STEP = 13;
/** Strands on one street keep this far apart (wrap-aware), m. */
const MIST_STRAND_GAP = 170;
/** Per-puff alpha: a strand seen end-on stacks 6 of them, 1 − 0.9⁶ ≈ 0.47
 * — about one S5 bank's BANK_OPACITY_MAX. */
export const MIST_ALPHA = 0.1;
/** L5: how much brighter than the bare night haze a lit layer reads — the
 * street light it hangs in (canyon mist) or over (banks). The brightest
 * result stays ≈ 0.25 luminance: far under the 0.72 bloom threshold. */
const MIST_GAIN = 3;
const BANK_GAIN = 1.6;
// The contract the no-test claim rests on: a puff's whole sprite stays
// inside the canyon, facades at LOT_LINE.
if (MIST_SIZE_MAX / 2 + MIST_CROSS_MAX + 4 > LOT_LINE) {
  throw new Error("fogbanks: canyon mist puffs would reach the facades");
}

/** One canyon-mist puff, relative to its strand. */
export interface MistPuff {
  /** Along the street from the strand's centre, and across it, m. */
  along: number;
  cross: number;
  /** Altitude offset from the strand's, m. */
  oy: number;
  size: number;
}

/** A strand of mist lying along one street. */
export interface MistStrand {
  /** 0: a north–south street (x = line·PITCH, runs along z); 1: east–west. */
  axis: 0 | 1;
  /** The street's centre line, m (a BLOCK_PITCH multiple). */
  line: number;
  /** Along-street centre at drift zero, m in [0, WORLD_SIZE). */
  s: number;
  y: number;
  tint: readonly [number, number, number];
  lit: number;
  cycle: number;
  phase: number;
  puffs: MistPuff[];
}

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
      // L5: low puffs are smaller — a low bank is a sheet, not a dome.
      const size = Math.min(
        radius * (PUFF_SIZE_MIN + (PUFF_SIZE_MAX - PUFF_SIZE_MIN) * rand()),
        Math.max(20, 2 * (y + oy - 2)),
      );
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
 * L5: the world's canyon-mist strands. Pure: seeded from the world seed
 * alone (its own salt); strands on one street never closer than
 * MIST_STRAND_GAP (on the torus), so they drift along it in step forever.
 */
export function canyonMistLayout(seed: number): MistStrand[] {
  const rand = mulberry32((seed ^ 0x3a17c0de) >>> 0);
  const strands: MistStrand[] = [];
  for (let tries = 0; strands.length < MIST_STRANDS && tries < 4000; tries++) {
    const axis = rand() < 0.5 ? 0 : 1;
    const line = Math.floor(rand() * CITY_GRID) * BLOCK_PITCH;
    const s = rand() * WORLD_SIZE;
    if (
      strands.some(
        (o) =>
          o.axis === axis &&
          o.line === line &&
          Math.abs(wrapDeltaAxis(o.s, s)) < MIST_STRAND_GAP,
      )
    ) {
      continue;
    }
    const y = MIST_ALT_MIN + (MIST_ALT_MAX - MIST_ALT_MIN) * rand();
    const pick = rand();
    const sign = SIGN_PALETTE[Math.floor(rand() * SIGN_PALETTE.length)];
    // Mostly sodium: the street lamps are right under it.
    const tint: readonly [number, number, number] =
      pick < 0.85 || !sign ? SODIUM : [sign.r, sign.g, sign.b];
    const lit = 0.6 + 0.35 * rand();
    const cycle = CYCLE_MIN_S + (CYCLE_MAX_S - CYCLE_MIN_S) * rand();
    const phase = rand();
    const puffs: MistPuff[] = [];
    for (let j = 0; j < PUFFS_PER_STRAND; j++) {
      const size = MIST_SIZE_MIN + (MIST_SIZE_MAX - MIST_SIZE_MIN) * rand();
      const along =
        (j - (PUFFS_PER_STRAND - 1) / 2) * MIST_STEP + (rand() - 0.5) * 6;
      const cross = (rand() * 2 - 1) * MIST_CROSS_MAX;
      // Clear of the street even side-on and tilted: never below 0.75 r.
      const oy = Math.max((rand() * 2 - 1) * 4, 0.375 * size + 1 - y);
      puffs.push({ along, cross, oy, size });
    }
    strands.push({ axis, line, s, y, tint, lit, cycle, phase, puffs });
  }
  return strands;
}

/**
 * L5: how much of a puff at canonical (x, y, z) with visible radius `r`
 * survives the buildings around it, 0..1 — smoothstep(r, r + soft, d) over
 * the 3×3 blocks around it, d the distance to each STANDING building box
 * (footprint × its standing top, standingProfile — cached per damage
 * version, so a felled tower stops parting the mist). Zero means some box is
 * within the sprite's radius: it is never drawn where a facade could cut it.
 * `count` (optional) adds the boxes tested, for the perf budget.
 */
export function buildingClearance(
  byBlock: ReadonlyMap<number, readonly Building[]>,
  x: number,
  y: number,
  z: number,
  r: number,
  soft: number,
  count?: { tests: number },
): number {
  const bx0 = Math.floor(x / BLOCK_PITCH);
  const bz0 = Math.floor(z / BLOCK_PITCH);
  let k = 1;
  for (let i = -1; i <= 1; i++) {
    const bx = (((bx0 + i) % CITY_GRID) + CITY_GRID) % CITY_GRID;
    for (let j = -1; j <= 1; j++) {
      const bz = (((bz0 + j) % CITY_GRID) + CITY_GRID) % CITY_GRID;
      const list = byBlock.get(bx * 1000 + bz);
      if (!list) continue;
      k = Math.min(k, clearanceAgainst(list, x, y, z, r, soft, count));
      if (k <= 0) return 0;
    }
  }
  return k;
}

/** buildingClearance over an explicit list of buildings (steam.ts keeps
 * each vent's neighbours, so a puff tests a handful of boxes). */
export function clearanceAgainst(
  list: readonly Building[],
  x: number,
  y: number,
  z: number,
  r: number,
  soft: number,
  count?: { tests: number },
): number {
  const reach = r + soft;
  let k = 1;
  for (let n = 0; n < list.length; n++) {
    const b = list[n] as Building;
    if (count) count.tests++;
    const ex = Math.abs(wrapDeltaAxis(b.x, x)) - b.width / 2;
    if (ex > reach) continue;
    const ez = Math.abs(wrapDeltaAxis(b.z, z)) - b.depth / 2;
    if (ez > reach) continue;
    const ey = y - standingProfile(b).top;
    if (ey > reach) continue;
    const d = Math.hypot(Math.max(ex, 0), Math.max(ez, 0), Math.max(ey, 0));
    const t = Math.min(1, Math.max(0, (d - r) / soft));
    k = Math.min(k, t * t * (3 - 2 * t));
    if (k <= 0) return 0;
  }
  return k;
}

/**
 * A bank's density at world time `serverMs`, 0..1: it forms, holds, thins
 * and is gone for a while each cycle. Wetter air (`haze`, 0..1) holds more
 * of it, never past 1. Pure; continuous in time. (L5: a mist strand's too.)
 */
export function bankDensity(
  bank: Pick<FogBank, "cycle" | "phase">,
  serverMs: number,
  haze = 0,
): number {
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
attribute vec2 aShape; // L5: side-on squash (1 = round) and underglow
uniform vec3 uPlanes[${MAX_FADE_PLANES}];
uniform int uPlaneCount;
varying vec2 vUv;
varying vec4 vTint;
varying float vUnder;
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
  // L5 layering: a sheet seen side-on (squashed in the vertical), a round
  // blob seen from above (|view dir y| → 1).
  float up = abs(normalize(centre - cameraPosition).y);
  float squash = mix(aShape.x, 1.0, up);
  vec4 mvPosition = mvCentre + vec4(position.x * size, position.y * size * squash, 0.0, 0.0);
  // The underglow reads on a sheet's lower edge, not on a blob from above.
  vUnder = aShape.y * (1.0 - up);
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
varying float vUnder;
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
  // L5: lit from below — the lower half takes more of the lamp colour.
  // L5: lit from below — sodium light pooled on the lower half.
  float abLow = vUnder * smoothstep(0.15, -0.45, vUv.y);
  gl_FragColor = vec4(abBase * (vTint.rgb + abLow * vec3(2.4, 1.3, 0.5)), vTint.a * shape);
  #include <fog_fragment>
}
`;

/** How much brighter than the bare haze the lit underside reads. */
const LIGHT_GAIN = 2.6;

/** L5 QA: how much of the mist survives the parting, per layer (the share
 * of in-range puffs at ≥ half their alpha), and the clearance work. */
export interface MistStats {
  bankPuffs: number;
  bankKept: number;
  mistPuffs: number;
  mistKept: number;
  /** Building boxes tested by the clearance fade this frame. */
  boxTests: number;
}

/** Every drawn puff as ONE instanced quad mesh — one draw call. */
export class FogBanks {
  readonly mesh: THREE.Mesh;
  private readonly banks: FogBank[];
  private readonly strands: MistStrand[];
  private readonly puffAttr: THREE.InstancedBufferAttribute;
  private readonly tintAttr: THREE.InstancedBufferAttribute;
  private readonly shapeAttr: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.InstancedBufferGeometry;
  /** Every per-instance attribute, for uploadPrefix (one array, reused). */
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
  private readonly tests = { tests: 0 };
  private readonly statsOut: MistStats = {
    bankPuffs: 0,
    bankKept: 0,
    mistPuffs: 0,
    mistKept: 0,
    boxTests: 0,
  };

  /** `byBlock` (L5): the city's buildings bucketed by block (main.ts's
   * buildingsByBlock) — what the banks part around. Without it they don't. */
  constructor(
    seed: number,
    private readonly byBlock: ReadonlyMap<
      number,
      readonly Building[]
    > = new Map(),
  ) {
    this.banks = fogBankLayout(seed);
    this.strands = canyonMistLayout(seed);
    const capacity =
      this.banks.length * PUFFS_PER_BANK +
      this.strands.length * PUFFS_PER_STRAND;
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
    this.shapeAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 2),
      2,
    );
    this.puffAttr.setUsage(THREE.DynamicDrawUsage);
    this.tintAttr.setUsage(THREE.DynamicDrawUsage);
    this.shapeAttr.setUsage(THREE.DynamicDrawUsage);
    this.uploads = [this.puffAttr, this.tintAttr, this.shapeAttr];
    geometry.setAttribute("aPuff", this.puffAttr);
    geometry.setAttribute("aTint", this.tintAttr);
    geometry.setAttribute("aShape", this.shapeAttr);
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

  /** Write instance `k`: render-space centre, size, light, alpha, shape. */
  private put(
    k: number,
    p: Vec3,
    size: number,
    tint: readonly [number, number, number],
    lit: number,
    alpha: number,
    flat: number,
    under: number,
    gain: number,
  ): void {
    const puffs = this.puffAttr.array as Float32Array;
    const tints = this.tintAttr.array as Float32Array;
    const shapes = this.shapeAttr.array as Float32Array;
    puffs[k * 4] = p.x;
    puffs[k * 4 + 1] = p.y;
    puffs[k * 4 + 2] = p.z;
    puffs[k * 4 + 3] = size;
    const g = LIGHT_GAIN * gain;
    tints[k * 4] = g * (1 - lit + lit * tint[0] * 1.6);
    tints[k * 4 + 1] = g * (1 - lit + lit * tint[1] * 1.6);
    tints[k * 4 + 2] = g * (1 - lit + lit * tint[2] * 1.6);
    tints[k * 4 + 3] = alpha;
    shapes[k * 2] = flat;
    shapes[k * 2 + 1] = under;
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
    const st = this.statsOut;
    st.bankPuffs = 0;
    st.bankKept = 0;
    st.mistPuffs = 0;
    st.mistKept = 0;
    this.tests.tests = 0;
    if (serverMs === null) {
      this.mesh.visible = false;
      this.drawn = 0;
      st.boxTests = 0;
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
        // L5: part around the towers (0 = a box within the sprite).
        const part = buildingClearance(
          this.byBlock,
          canon.x,
          canon.y,
          canon.z,
          puff.size / 2,
          BANK_PART_SOFT,
          this.tests,
        );
        st.bankPuffs++;
        if (part >= 0.5) st.bankKept++;
        if (part <= 0.001) continue;
        const p = nearestImageInto(this.img, cameraPos, this.canon);
        // Lit from below: the lower the puff, the more lamp colour.
        const low = Math.min(1, Math.max(0, (140 - p.y) / 120));
        this.put(
          k++,
          p,
          puff.size,
          bank.tint,
          bank.lit * low,
          PUFF_ALPHA * density * part,
          BANK_FLAT,
          BANK_UNDER * low,
          1 + (BANK_GAIN - 1) * low,
        );
      }
    }
    // L5 canyon mist: along the street, with the along-street air.
    for (let m = 0; m < this.strands.length; m++) {
      const strand = this.strands[m] as MistStrand;
      const density = bankDensity(strand, serverMs, haze);
      if (density <= 0.001) continue;
      const along = strand.s + (strand.axis === 0 ? dzAir : dxAir);
      for (let q = 0; q < strand.puffs.length; q++) {
        const puff = strand.puffs[q] as MistPuff;
        const u = along + puff.along;
        const v = strand.line + puff.cross;
        const x = strand.axis === 0 ? v : u;
        const z = strand.axis === 0 ? u : v;
        canon.x = ((x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
        canon.y = strand.y + puff.oy;
        canon.z = ((z % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
        const ex = wrapDeltaAxis(cameraPos.x, canon.x);
        const ez = wrapDeltaAxis(cameraPos.z, canon.z);
        if (ex * ex + ez * ez > reach * reach) continue;
        st.mistPuffs++;
        st.mistKept++; // inside the canyon by construction: nothing parts it
        const p = nearestImageInto(this.img, cameraPos, this.canon);
        this.put(
          k++,
          p,
          puff.size,
          strand.tint,
          strand.lit,
          MIST_ALPHA * density,
          MIST_FLAT,
          MIST_UNDER,
          MIST_GAIN,
        );
      }
    }
    st.boxTests = this.tests.tests;
    this.drawn = k;
    this.geometry.instanceCount = k;
    uploadPrefix(this.uploads, k);
  }

  /** L5 QA: the parting's survival per layer and the box tests (perf). */
  get stats(): Readonly<MistStats> {
    return this.statsOut;
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
