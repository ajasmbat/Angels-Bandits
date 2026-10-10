// A1 city life — the renderer half of citylife.ts. EVERY new figure (riders,
// crossers, groups, joggers, dogs, carts, waiters, performers and their
// audiences, balcony and terrace people, hailers) is ONE InstancedMesh: one
// draw call.
//
// GEOMETRY BUDGET. One fixed figure of six boxes (~144 vertices): body, head,
// a pointing arm, and three generic prop boxes the vertex shader sizes and
// places per kind — a bicycle is a frame box over a wheel strip, a cart is a
// body, an umbrella and its pole, a dog is a body, head and legs. Parts a
// kind does not use collapse to a point (degenerate, no raster cost). The
// quality tier thins instance COUNTS, never the program (O3 rule 1).
//
// TWO POPULATIONS in one buffer:
//  - static figures (stations, balconies, terraces) are baked per block in
//    anchor-relative coordinates at construction and copied into the front of
//    the buffer only when the camera changes block (the facade-detail idiom);
//    the shader thins and fades them, so they cost no per-frame CPU;
//  - moving figures are written after them every frame from the pure poses,
//    allocation-free, thinned on the CPU with the same golden-ratio keep test
//    the L1 crowd uses.
//
// Non-collidable: nothing here reaches collision.ts, the server or a bot
// probe (people are the plan's accepted exception).

import {
  type Building,
  CITY_GRID,
  type LocalBox,
} from "@angels-bandits/common/city";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import { inBridgeGap } from "@angels-bandits/common/city/river";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  type Crosser,
  type FigurePose,
  LifeKind,
  type PickupTaxi,
  type RiderFleet,
  type RingFigure,
  type StaticFigure,
  type TaxiPose,
  blockCrossers,
  blockRingLife,
  blockStations,
  crosserPoseInto,
  hailerPoseInto,
  highFigures,
  newFigurePose,
  newTaxiPose,
  offCentre,
  pickupTaxis,
  riderFleet,
  riderPoseInto,
  ringFigurePoseInto,
  taxiPoseInto,
} from "./citylife";
import {
  LOOK_GLSL_APPLY,
  LOOK_GLSL_PARS,
  LOOK_RADIUS,
  type Look,
  POINT_SHARE,
  WATCH_SHARE,
  lookAt,
  lookPasses,
  watchHold,
  whoHash,
} from "./lookup";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import type { NearPass } from "./reactions";
import { loopPhase } from "./rooftop-life";
import { signalOffset } from "./signals";
import { type StandingLayer, StandingMask } from "./standing-watch";
import {
  BLOCK_WINDOW_RADIUS,
  MICRO_GATE_FULL,
  MICRO_GATE_OFF,
  blockOf,
  blockWindow,
  microKeep,
} from "./streetlife";
import { uploadPrefix } from "./wrapPlacement";

const P = BLOCK_PITCH;
const PHI = 0.618_033_988_749_894_9;

// --- Palettes (linear, packed once) -----------------------------------------

/** Night coats — the L1 crowd's palette plus a few brighter accents. */
const COATS = [
  0x7b828f, 0xa08d76, 0x5d7290, 0xb07a5e, 0x8b8b96, 0xc4ab86, 0x4f7264,
  0x9a8fa6, 0xb5524a, 0x3f5f8f,
];
/** Riders' jackets: darker, with hi-vis and courier colours. */
const JACKETS = [0x2b2f36, 0x4a4f58, 0xd8c21a, 0x2c6e8f, 0x8f3a2c, 0x3a3a3a];
/** Dogs. */
const FURS = [0x2a2420, 0x8a6a48, 0xd9cbb2, 0x5c4a3a, 0x1b1b1b];
/** Cart umbrellas: the bright bit of a dark street. */
const UMBRELLAS = [0xc8102e, 0xffcd00, 0x0067b1, 0x009a44, 0xff6a13];

const packLinear = (hexes: readonly number[]): Float32Array => {
  const c = new THREE.Color();
  const out = new Float32Array(hexes.length * 3);
  hexes.forEach((hex, i) => {
    c.setHex(hex);
    out.set([c.r, c.g, c.b], i * 3);
  });
  return out;
};
const COAT_LIN = packLinear(COATS);
const JACKET_LIN = packLinear(JACKETS);
const FUR_LIN = packLinear(FURS);
const UMBRELLA_LIN = packLinear(UMBRELLAS);

function paletteFor(kind: number): Float32Array {
  if (kind === LifeKind.DOG) return FUR_LIN;
  if (kind === LifeKind.CART) return UMBRELLA_LIN;
  if (
    kind === LifeKind.BIKE ||
    kind === LifeKind.SCOOTER ||
    kind === LifeKind.DELIVERY
  ) {
    return JACKET_LIN;
  }
  return COAT_LIN;
}

/** Writes a tone (0..1) of `kind`'s palette into `out` at `o`. */
function writeTone(kind: number, tone: number, out: Float32Array, o: number) {
  const pal = paletteFor(kind);
  const n = pal.length / 3;
  const i = Math.min(n - 1, Math.floor(tone * n)) * 3;
  out[o] = pal[i] as number;
  out[o + 1] = pal[i + 1] as number;
  out[o + 2] = pal[i + 2] as number;
}

// --- Flags (aLife.w) -----------------------------------------------------------

const FLAG_HIGH = 1;
const FLAG_NO_LOOK = 2;

// --- Geometry ------------------------------------------------------------------

/** Body box, meters (the L1 pedestrian's). */
const BODY = { width: 0.46, height: 1.42, depth: 0.28 } as const;
const HEAD = 0.22;
const ARM = { width: 0.09, length: 0.62 } as const;

/** Six boxes, one per part, tagged by `aPart`. Props are unit boxes. */
function figureGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, part: number) => {
    const n = g.getAttribute("position").count;
    g.setAttribute(
      "aPart",
      new THREE.BufferAttribute(new Float32Array(n).fill(part), 1),
    );
    parts.push(g);
  };
  const body = new THREE.BoxGeometry(BODY.width, BODY.height, BODY.depth);
  body.translate(0, BODY.height / 2, 0);
  add(body, 0);
  const head = new THREE.BoxGeometry(HEAD, HEAD, HEAD);
  head.translate(0, BODY.height + HEAD / 2, 0);
  add(head, 1);
  // The arm hangs from its shoulder pivot at the origin.
  const arm = new THREE.BoxGeometry(ARM.width, ARM.length, ARM.width);
  arm.translate(0, -ARM.length / 2, 0);
  add(arm, 2);
  for (let p = 3; p <= 5; p++) add(new THREE.BoxGeometry(1, 1, 1), p);
  const merged = mergeGeometries(parts) ?? new THREE.BufferGeometry();
  for (const g of parts) g.dispose();
  return merged;
}

/** Per-kind prop boxes: [size, offset] for parts A, B, C (size 0 = unused).
 * Indexed by LifeKind; local +Z is forward. */
const PROPS: readonly (readonly [
  readonly [number, number, number],
  readonly [number, number, number],
])[][] = [
  // WALKER
  [
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
  ],
  // BIKE: frame over a strip of wheels.
  [
    [
      [0.07, 0.42, 1.0],
      [0, 0.68, 0],
    ],
    [
      [0.05, 0.66, 1.66],
      [0, 0.33, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
  ],
  // SCOOTER: deck, stem, handlebar.
  [
    [
      [0.16, 0.06, 0.85],
      [0, 0.12, 0],
    ],
    [
      [0.05, 1.0, 0.05],
      [0, 0.62, 0.38],
    ],
    [
      [0.5, 0.05, 0.05],
      [0, 1.1, 0.38],
    ],
  ],
  // DELIVERY: a bike with a courier box on the rider's back.
  [
    [
      [0.07, 0.42, 1.0],
      [0, 0.68, 0],
    ],
    [
      [0.05, 0.66, 1.66],
      [0, 0.33, 0],
    ],
    [
      [0.44, 0.42, 0.4],
      [0, 1.2, -0.3],
    ],
  ],
  // DOG: body, head, legs.
  [
    [
      [0.22, 0.26, 0.62],
      [0, 0.42, 0],
    ],
    [
      [0.17, 0.19, 0.22],
      [0, 0.62, 0.36],
    ],
    [
      [0.18, 0.29, 0.48],
      [0, 0.145, 0],
    ],
  ],
  // CART: body, umbrella, pole.
  [
    [
      [1.7, 0.9, 0.85],
      [0, 0.6, 0],
    ],
    [
      [2.1, 0.07, 2.1],
      [0, 2.3, 0],
    ],
    [
      [0.05, 1.75, 0.05],
      [0, 1.4, 0],
    ],
  ],
  // PERFORMER: a guitar held across the chest.
  [
    [
      [0.42, 0.18, 0.08],
      [0.02, 0.98, 0.2],
    ],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
  ],
];

const v3 = (v: readonly number[]): string =>
  `vec3(${v.map((x) => x.toFixed(3)).join(", ")})`;
const propTable = (part: number, field: 0 | 1): string =>
  `const vec3 AB_P${part}${field === 0 ? "S" : "O"}[${PROPS.length}] = vec3[](${PROPS.map(
    (k) => v3((k[part] as readonly (readonly number[])[])[field] as number[]),
  ).join(", ")});`;

/** Animation cycles per LOOP_MS (integers: the loop fold never jumps). */
const STRUM_CYCLES = 360; // 3 Hz
const SWAY_CYCLES = 14; // ~0.12 Hz idle weight shift
const BEAT_CYCLES = 240; // 2 Hz performer bob

const VERTEX_PARS = /* glsl */ `
attribute float aPart;
attribute vec4 aLife;
attribute float aArm;
uniform float uLoop;
uniform float uKeepStreet;
uniform float uDensityHigh;
uniform float uFar;
varying vec4 vAbTint;
varying vec3 vAbGlow;
varying vec3 vAbWorld;
${LOOK_GLSL_PARS}
${LOOK_GLSL_APPLY}
${propTable(0, 0)}
${propTable(0, 1)}
${propTable(1, 0)}
${propTable(1, 1)}
${propTable(2, 0)}
${propTable(2, 1)}
`;

/** The per-vertex pose parameters (computed once, in beginnormal). */
const BEGIN_NORMAL = /* glsl */ `
int abK = int(aLife.x + 0.5);
float abPartId = aPart;
float abFlags = aLife.w;
bool abHigh = mod(abFlags, 2.0) > 0.5;
bool abCanLook = (abK == ${LifeKind.WALKER} || abK == ${LifeKind.PERFORMER}) && abFlags < 1.5;
float abWho = aLife.z;
vec3 abInst = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
// Plane reaction: watchers turn and lean back, pointers raise an arm.
vec4 abL = vec4(0.0, 1.0, 0.0, 0.0);
if (abCanLook && abWho < ${WATCH_SHARE.toFixed(3)} && uAbPassCount > 0.5) abL = abLook(abInst);
float abLookW = abL.w;
// Idle life: a slow weight shift for anyone standing about.
float abSway = 0.0;
if (abCanLook) abSway = 0.12 * sin(6.28318 * (uLoop * ${SWAY_CYCLES}.0 + abWho * 7.0));
// Body shaping per kind.
float abVis = 1.0;
float abSquash = 1.0;
float abLift = 0.0;
float abLean = 0.0;
vec3 abSize = vec3(1.0);
vec3 abOff = vec3(0.0);
float abArmRaise = 0.0;
vec4 abTint = vec4(0.0);
vec3 abGlow = vec3(0.0);
if (abK == ${LifeKind.BIKE} || abK == ${LifeKind.DELIVERY}) { abSquash = 0.68; abLift = 0.5; abLean = -0.3; }
if (abK == ${LifeKind.SCOOTER}) abLift = 0.14;
if (abK == ${LifeKind.PERFORMER}) abLift = 0.04 * abs(sin(3.14159 * (uLoop * ${BEAT_CYCLES}.0 + abWho)));
if (abPartId < 1.5) {
  if (abK == ${LifeKind.DOG} || abK == ${LifeKind.CART}) abVis = 0.0;
  if (abPartId > 0.5) abTint = vec4(0.66, 0.5, 0.4, 0.9);
} else if (abPartId < 2.5) {
  // The arm: performers strum, vendors serve, hailers wave, watchers point.
  abArmRaise = aArm;
  if (abK == ${LifeKind.PERFORMER}) abArmRaise += 0.07 * sin(6.28318 * (uLoop * ${STRUM_CYCLES}.0 + abWho));
  if (abWho < ${POINT_SHARE.toFixed(3)}) abArmRaise = max(abArmRaise, abLookW);
  if (abArmRaise < 0.02 || !(abK == ${LifeKind.WALKER} || abK == ${LifeKind.PERFORMER})) abVis = 0.0;
} else {
  int abP = int(abPartId + 0.5) - 3;
  if (abP == 0) { abSize = AB_P0S[abK]; abOff = AB_P0O[abK]; }
  else if (abP == 1) { abSize = AB_P1S[abK]; abOff = AB_P1O[abK]; }
  else { abSize = AB_P2S[abK]; abOff = AB_P2O[abK]; }
  if (abSize.x <= 0.0) abVis = 0.0;
  // Prop colours: frames dark, carts steel under a coloured umbrella, a
  // courier box bright, a guitar wood. Dogs and umbrellas keep instanceColor.
  if (abK == ${LifeKind.BIKE} || abK == ${LifeKind.DELIVERY}) abTint = vec4(0.06, 0.065, 0.075, 1.0);
  if (abK == ${LifeKind.SCOOTER}) abTint = vec4(0.22, 0.24, 0.27, 1.0);
  if (abK == ${LifeKind.DELIVERY} && abP == 2) abTint = abWho < 0.5 ? vec4(0.85, 0.3, 0.03, 1.0) : vec4(0.03, 0.55, 0.45, 1.0);
  if (abK == ${LifeKind.CART} && abP == 0) { abTint = vec4(0.5, 0.52, 0.55, 1.0); abGlow = vec3(1.0, 0.72, 0.4) * 0.16; }
  if (abK == ${LifeKind.CART} && abP == 2) abTint = vec4(0.12, 0.12, 0.13, 1.0);
  if (abK == ${LifeKind.PERFORMER}) abTint = vec4(0.42, 0.24, 0.1, 1.0);
}
// Thinning and fades (static figures; moving ones are thinned on the CPU and
// carry keep 0). Up a building the altitude gate is RELATIVE to the figure.
float abRel = cameraPosition.y - abInst.y;
float abKeep = abHigh
  ? uDensityHigh * clamp((${MICRO_GATE_OFF.toFixed(1)} - abRel) / ${(MICRO_GATE_OFF - MICRO_GATE_FULL).toFixed(1)}, 0.0, 1.0)
  : uKeepStreet;
if (aLife.y >= abKeep) abVis = 0.0;
abVis *= 1.0 - smoothstep(uFar * 0.8, uFar, distance(abInst, cameraPosition));
vAbTint = abTint;
vAbGlow = abGlow;
${xform("objectNormal", false)}
`;

/** The same pose applied to a vector (positions translate, normals not). */
function xform(v: string, point: boolean): string {
  return /* glsl */ `
if (abPartId < 1.5) {
  ${point ? `${v}.y *= abSquash;` : ""}
  ${v} = abTilt(${v}, abLean);
  ${point ? `${v}.y += abLift;` : ""}
} else if (abPartId < 2.5) {
  // Raise about the shoulder: down (−Y) swings forward and up.
  float abTh = -2.5 * clamp(abArmRaise, 0.0, 1.0);
  ${v} = abTilt(${v}, abTh);
  ${point ? `${v} += vec3(0.21, 1.31 + abLift, 0.03);` : ""}
} else {
  ${point ? `${v} = ${v} * abSize + abOff;` : ""}
}
if (abPartId < 2.5) ${v} = abApplyLook(abYaw(${v}, abSway * (1.0 - abLookW)), abLookW, abL.xyz);
${point ? `${v} *= abVis;` : ""}
`;
}

const BEGIN_VERTEX = /* glsl */ `
${xform("transformed", true)}
vAbWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec4 vAbTint;
varying vec3 vAbGlow;
varying vec3 vAbWorld;
`;

const FRAGMENT_COLOR = /* glsl */ `
diffuseColor.rgb = mix(diffuseColor.rgb, vAbTint.rgb, vAbTint.a);
`;

/** The L1 pedestrians' faked lamp pool + dim self-lit floor (pedestrians.ts),
 * street level only: a balcony is not under a streetlamp. */
const FRAGMENT_EMISSIVE = /* glsl */ `
float abPdx = abs(vAbWorld.x - floor(vAbWorld.x / 200.0 + 0.5) * 200.0);
float abPdz = abs(vAbWorld.z - floor(vAbWorld.z / 200.0 + 0.5) * 200.0);
float abRoad = min(abPdx, abPdz);
float abAlong = (abPdx < abPdz) ? vAbWorld.z : vAbWorld.x;
float abPool =
  exp(-pow(abs(abRoad - 15.0) / 5.5, 2.0)) *
  exp(-pow(abs(fract(abAlong / 25.0) - 0.5) * 25.0 / 7.0, 2.0)) *
  (1.0 - smoothstep(3.0, 6.0, vAbWorld.y));
totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.86, 0.62) * abPool * 3.4;
totalEmissiveRadiance += diffuseColor.rgb * 0.5 + vAbGlow;
`;

export const CITY_LIFE_CACHE_KEY = "ab-a1-city-life";

function createMaterial(
  uniforms: Record<string, THREE.IUniform>,
): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  material.customProgramCacheKey = () => CITY_LIFE_CACHE_KEY;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    lookPasses.attach(shader);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>\n${BEGIN_NORMAL}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${BEGIN_VERTEX}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\n${FRAGMENT_COLOR}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${FRAGMENT_EMISSIVE}`,
      );
  };
  return material;
}

// --- Static blocks -------------------------------------------------------------

/** Each building's figures up it (balconies, terrace), per seed — laid out
 * once, shared by the renderer and its D8 standing layer. */
const highCache = new WeakMap<
  Building,
  { seed: number; list: StaticFigure[] }
>();
function highFiguresOf(b: Building, seed: number): StaticFigure[] {
  const hit = highCache.get(b);
  if (hit && hit.seed === seed) return hit.list;
  const list = highFigures(b, seed);
  highCache.set(b, { seed, list });
  return list;
}

/** A standing figure's box, m (feet at y, ~1.8 m tall, 0.6 m across). */
const FIGURE_HALF = 0.3;
const FIGURE_TALL = 1.8;

/**
 * D8: the figures up each building (highFigures, in its order) as boxes in
 * the building's frame — a balcony or terrace that fell takes its people
 * with it.
 */
export function citylifeStandingLayer(
  buildings: readonly Building[],
  seed: number,
): StandingLayer {
  const cache = new Map<number, readonly LocalBox[]>();
  return {
    boxes(index: number): readonly LocalBox[] {
      let boxes = cache.get(index);
      if (!boxes) {
        const b = buildings[index] as Building;
        boxes = highFiguresOf(b, seed).map((f) => {
          const x = wrapDeltaAxis(b.x, f.x);
          const z = wrapDeltaAxis(b.z, f.z);
          return {
            x0: x - FIGURE_HALF,
            x1: x + FIGURE_HALF,
            y0: f.y,
            y1: f.y + FIGURE_TALL * f.height,
            z0: z - FIGURE_HALF,
            z1: z + FIGURE_HALF,
          };
        });
        cache.set(index, boxes);
      }
      return boxes;
    },
  };
}

/** One block's static figures, packed anchor-relative (high ones first). */
interface StaticBlock {
  ax: number;
  az: number;
  /** Figures up a building (drawn whatever the street gate says). */
  high: number;
  /** D8: per high figure, its building's index and its index among that
   * building's highFigures (the standing mask's item). */
  owner: Int32Array;
  ownerK: Int32Array;
  /** All figures (high + street). */
  count: number;
  matrices: Float32Array;
  colors: Float32Array;
  life: Float32Array;
  arms: Float32Array;
  performers: { x: number; z: number }[];
}

/** Column-major yaw + scale + translation, the pedestrians.ts layout. */
function writeMatrix(
  m: Float32Array,
  o: number,
  yaw: number,
  scale: number,
  height: number,
  x: number,
  y: number,
  z: number,
): void {
  const cy = Math.cos(yaw) * scale;
  const sy = Math.sin(yaw) * scale;
  m[o] = cy;
  m[o + 1] = 0;
  m[o + 2] = -sy;
  m[o + 3] = 0;
  m[o + 4] = 0;
  m[o + 5] = height * scale;
  m[o + 6] = 0;
  m[o + 7] = 0;
  m[o + 8] = sy;
  m[o + 9] = 0;
  m[o + 10] = cy;
  m[o + 11] = 0;
  m[o + 12] = x;
  m[o + 13] = y;
  m[o + 14] = z;
  m[o + 15] = 1;
}

function packStatic(
  bx: number,
  bz: number,
  figures: readonly StaticFigure[],
  performers: { x: number; z: number }[],
  owner: Int32Array,
  ownerK: Int32Array,
): StaticBlock {
  const ax = (bx + 0.5) * P;
  const az = (bz + 0.5) * P;
  const sorted = [
    ...figures.filter((f) => f.high === 1),
    ...figures.filter((f) => f.high === 0),
  ];
  const n = sorted.length;
  const matrices = new Float32Array(n * 16);
  const colors = new Float32Array(n * 3);
  const life = new Float32Array(n * 4);
  const arms = new Float32Array(n);
  sorted.forEach((f, i) => {
    writeMatrix(
      matrices,
      i * 16,
      f.yaw,
      1,
      f.height,
      wrapDeltaAxis(ax, f.x),
      f.y,
      wrapDeltaAxis(az, f.z),
    );
    writeTone(f.kind, f.tone, colors, i * 3);
    life[i * 4] = f.kind;
    life[i * 4 + 1] = (i * PHI) % 1;
    life[i * 4 + 2] = f.phase;
    life[i * 4 + 3] = f.high === 1 ? FLAG_HIGH : 0;
    arms[i] = f.arm;
  });
  return {
    ax,
    az,
    high: figures.filter((f) => f.high === 1).length,
    owner,
    ownerK,
    count: n,
    matrices,
    colors,
    life,
    arms,
    performers,
  };
}

/** Moving-figure capacity per block window, worst case over the city. */
function windowMax(perBlock: (bx: number, bz: number) => number): number {
  const counts = new Map<number, number>();
  for (let bx = 0; bx < CITY_GRID; bx++) {
    for (let bz = 0; bz < CITY_GRID; bz++) {
      counts.set(bx * CITY_GRID + bz, perBlock(bx, bz));
    }
  }
  let best = 0;
  for (let bx = 0; bx < CITY_GRID; bx++) {
    for (let bz = 0; bz < CITY_GRID; bz++) {
      let sum = 0;
      for (const w of blockWindow({
        x: (bx + 0.5) * P,
        y: 0,
        z: (bz + 0.5) * P,
      })) {
        sum += counts.get(w.bx * CITY_GRID + w.bz) ?? 0;
      }
      best = Math.max(best, sum);
    }
  }
  return best;
}

// --- The renderer --------------------------------------------------------------

export class CityLife {
  readonly mesh: THREE.InstancedMesh;
  readonly riders: RiderFleet;
  readonly taxis: PickupTaxi[];
  private readonly statics = new Map<number, StaticBlock>();
  private readonly ring = new Map<number, RingFigure[]>();
  private readonly crossers = new Map<number, Crosser[]>();
  private readonly crossOffset = new Map<number, number>();
  private readonly life: THREE.InstancedBufferAttribute;
  private readonly arms: THREE.InstancedBufferAttribute;
  private readonly uniforms = {
    uLoop: { value: 0 },
    uKeepStreet: { value: 0 },
    uDensityHigh: { value: 1 },
    uFar: { value: BLOCK_WINDOW_RADIUS * P },
  };
  private readonly pose: FigurePose = newFigurePose();
  private readonly look: Look = { weight: 0, age: -1 };
  /** Pickup-taxi poses this frame (Traffic draws them). */
  readonly taxiPoses: TaxiPose[];
  private staticKey = -1;
  /** The streamed block window, recomputed only when the camera's block (or
   * the tier's radius) changes — the frame path allocates nothing. */
  private window: { bx: number; bz: number }[] = [];
  private windowKey = -1;
  private attrs: THREE.BufferAttribute[] = [];
  private staticStreet = false;
  private staticCount = 0;
  private drawn = 0;
  private density = 1;
  private radius = BLOCK_WINDOW_RADIUS;
  private readonly capacity: number;
  /** D8: high figures on what fell are hidden (copyStatics reads it). */
  private readonly standing: StandingMask;
  private readonly blockOfBuilding: Int32Array;

  constructor(buildings: readonly Building[], seed: number) {
    this.riders = riderFleet(seed);
    this.taxis = pickupTaxis(seed);
    this.taxiPoses = this.taxis.map(() => newTaxiPose());

    // Static figures: stations + people up the buildings, per block.
    const byBlock = new Map<number, StaticFigure[]>();
    const owners = new Map<number, number[]>();
    this.blockOfBuilding = new Int32Array(buildings.length);
    buildings.forEach((b, i) => {
      const { bx, bz } = blockOf({ x: b.x, y: 0, z: b.z });
      const key = bx * CITY_GRID + bz;
      this.blockOfBuilding[i] = key;
      const list = byBlock.get(key) ?? [];
      const own = owners.get(key) ?? [];
      const high = highFiguresOf(b, seed);
      high.forEach((f, k) => {
        list.push(f);
        own.push(i, k);
      });
      byBlock.set(key, list);
      owners.set(key, own);
    });
    this.standing = new StandingMask(
      buildings,
      citylifeStandingLayer(buildings, seed),
      this.restream,
    );
    for (let bx = 0; bx < CITY_GRID; bx++) {
      for (let bz = 0; bz < CITY_GRID; bz++) {
        const key = bx * CITY_GRID + bz;
        const st = blockStations(bx, bz, seed);
        const all = [...(byBlock.get(key) ?? []), ...st.figures];
        const own = owners.get(key) ?? [];
        const owner = new Int32Array(own.length / 2);
        const ownerK = new Int32Array(own.length / 2);
        for (let j = 0; j < owner.length; j++) {
          owner[j] = own[j * 2] as number;
          ownerK[j] = own[j * 2 + 1] as number;
        }
        this.statics.set(
          key,
          packStatic(bx, bz, all, st.performers, owner, ownerK),
        );
        this.ring.set(key, blockRingLife(bx, bz, seed));
        this.crossers.set(key, blockCrossers(bx, bz, seed));
        this.crossOffset.set(key, signalOffset(bx, bz, seed));
      }
    }
    const key = (bx: number, bz: number) => bx * CITY_GRID + bz;
    const hailers = this.taxis.reduce((n, t) => n + t.plan.pickups.length, 0);
    this.capacity =
      windowMax((bx, bz) => this.statics.get(key(bx, bz))?.count ?? 0) +
      windowMax(
        (bx, bz) =>
          (this.ring.get(key(bx, bz))?.length ?? 0) +
          (this.crossers.get(key(bx, bz))?.length ?? 0),
      ) +
      this.riders.riders.length +
      hailers;

    const geometry = figureGeometry();
    this.life = new THREE.InstancedBufferAttribute(
      new Float32Array(this.capacity * 4),
      4,
    );
    this.life.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aLife", this.life);
    this.arms = new THREE.InstancedBufferAttribute(
      new Float32Array(this.capacity),
      1,
    );
    this.arms.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aArm", this.arms);
    this.mesh = new THREE.InstancedMesh(
      geometry,
      createMaterial(this.uniforms),
      this.capacity,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // instances move relative to the camera
    this.mesh.count = 0;
    this.mesh.visible = false; // until the first server clock estimate
    // Force three to allocate instanceColor (see pedestrians.ts).
    const c = new THREE.Color(0x7b828f);
    for (let i = 0; i < this.capacity; i++) this.mesh.setColorAt(i, c);
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.attrs = [
      this.mesh.instanceMatrix,
      this.mesh.instanceColor as THREE.InstancedBufferAttribute,
      this.life,
      this.arms,
    ];
  }

  /** D8: building `b`'s figures changed standing — re-copy the statics if
   * its block is in the streamed window. */
  private readonly restream = (b: number): void => {
    const key = this.blockOfBuilding[b] as number;
    for (const { bx, bz } of this.window) {
      if (bx * CITY_GRID + bz === key) {
        this.staticKey = -1;
        return;
      }
    }
  };

  /** Re-derive the block window if the camera changed block (or radius);
   * returns the camera block's key. */
  private refreshWindow(cam: Vec3): number {
    const bx = Math.floor(wrapCoord(cam.x) / P);
    const bz = Math.floor(wrapCoord(cam.z) / P);
    const key = (bx * CITY_GRID + bz) * 8 + this.radius;
    if (key !== this.windowKey) {
      this.windowKey = key;
      this.window = blockWindow(cam, this.radius);
    }
    return key;
  }

  /** O3/M3 tier: share of the new life kept and the window radius. */
  setQuality(tier: QualityTier): void {
    const q = QUALITY_PROFILES[tier];
    this.density = q.cityLife;
    this.radius = Math.min(BLOCK_WINDOW_RADIUS, q.microRadius);
    // Far fade inside the streamed window (its near edge is r·200 m out).
    // The fade ends exactly where the window's nearest edge can be (r blocks
    // from a camera on its own block's edge), so nothing pops as it streams.
    this.uniforms.uFar.value = this.radius * P;
    this.uniforms.uDensityHigh.value = this.density;
    this.staticKey = -1; // re-stream with the new radius
  }

  /** Instances drawn last frame. */
  get count(): number {
    return this.drawn;
  }

  /** Figures in the static part of the buffer (QA). */
  get staticDrawn(): number {
    return this.staticCount;
  }

  /**
   * Place everything for server time `serverTimeMs`. `gate` is the L1 micro
   * gate (street level); `passes` are the reactor's near passes (watchers
   * freeze while they look). `on` false (?micro=0) hides the mesh outright.
   */
  update(
    cameraPos: Vec3,
    serverTimeMs: number | null,
    gate: number,
    passes: readonly NearPass[],
    on = true,
  ): void {
    if (serverTimeMs === null || !on) {
      this.mesh.visible = false;
      this.mesh.count = 0;
      this.drawn = 0;
      this.staticKey = -1;
      return;
    }
    const t = serverTimeMs / 1000;
    this.standing.update(); // D8: may ask for a re-copy of the statics
    this.uniforms.uLoop.value = loopPhase(serverTimeMs);
    const keep = gate * this.density;
    this.uniforms.uKeepStreet.value = keep;
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const colors = (this.mesh.instanceColor as THREE.InstancedBufferAttribute)
      .array as Float32Array;
    const life = this.life.array as Float32Array;
    const arms = this.arms.array as Float32Array;

    // Statics: re-copied only when the camera block (or the street gate's
    // on/off, or the tier) changes.
    const key = this.refreshWindow(cameraPos);
    const street = keep > 0;
    let full = false;
    if (key !== this.staticKey || street !== this.staticStreet) {
      this.staticKey = key;
      this.staticStreet = street;
      this.staticCount = this.copyStatics(
        cameraPos,
        street,
        m,
        colors,
        life,
        arms,
      );
      full = true;
    }
    let n = this.staticCount;

    if (keep > 0) {
      n = this.writeRing(
        cameraPos,
        t,
        serverTimeMs,
        keep,
        passes,
        n,
        m,
        colors,
        life,
        arms,
      );
      n = this.writeCrossers(cameraPos, t, keep, n, m, colors, life, arms);
      n = this.writeRiders(cameraPos, t, keep, n, m, colors, life, arms);
      n = this.writeHailers(cameraPos, t, n, m, colors, life, arms);
    }
    this.drawn = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    const attrs = this.attrs;
    if (full) {
      uploadPrefix(attrs, n);
    } else {
      // Only the moving tail changed.
      for (const a of attrs) {
        a.clearUpdateRanges();
        if (n > this.staticCount) {
          a.addUpdateRange(
            this.staticCount * a.itemSize,
            (n - this.staticCount) * a.itemSize,
          );
          a.needsUpdate = true;
        }
      }
    }
  }

  /** QA: drawn instances within `r` m of `pos` (render space), read back
   * out of the instance buffers — the rendered truth, not a re-derivation. */
  sampleNear(
    pos: Vec3,
    r: number,
    limit = 40,
  ): { x: number; y: number; z: number; kind: number; flags: number }[] {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const life = this.life.array as Float32Array;
    const out: {
      x: number;
      y: number;
      z: number;
      kind: number;
      flags: number;
    }[] = [];
    for (let i = 0; i < this.drawn && out.length < limit; i++) {
      const x = m[i * 16 + 12] as number;
      const y = m[i * 16 + 13] as number;
      const z = m[i * 16 + 14] as number;
      if (Math.hypot(x - pos.x, y - pos.y, z - pos.z) > r) continue;
      out.push({
        x,
        y,
        z,
        kind: life[i * 4] as number,
        flags: life[i * 4 + 3] as number,
      });
    }
    return out;
  }

  /** The pickup taxis' poses for Traffic (call once a frame, any order). */
  updateTaxis(serverTimeMs: number | null): void {
    if (serverTimeMs === null) return;
    const t = serverTimeMs / 1000;
    this.taxis.forEach((taxi, i) => {
      taxiPoseInto(taxi, t, this.taxiPoses[i] as TaxiPose);
    });
  }

  /** The performer nearest `pos` within the streamed window (busker audio). */
  nearestPerformer(pos: Vec3, out: Vec3): number {
    let best = Number.POSITIVE_INFINITY;
    // The camera's 3×3 (inside the cached window, which is never smaller).
    for (const { bx, bz } of this.window) {
      if (
        Math.abs(wrapDeltaAxis(pos.x, (bx + 0.5) * P)) > 1.5 * P ||
        Math.abs(wrapDeltaAxis(pos.z, (bz + 0.5) * P)) > 1.5 * P
      ) {
        continue;
      }
      const s = this.statics.get(bx * CITY_GRID + bz);
      if (!s) continue;
      for (const p of s.performers) {
        const dx = wrapDeltaAxis(pos.x, p.x);
        const dz = wrapDeltaAxis(pos.z, p.z);
        const d = Math.hypot(dx, dz, pos.y);
        if (d < best) {
          best = d;
          out.x = pos.x + dx;
          out.y = 1.5;
          out.z = pos.z + dz;
        }
      }
    }
    return best;
  }

  private copyStatics(
    cam: Vec3,
    street: boolean,
    m: Float32Array,
    colors: Float32Array,
    life: Float32Array,
    arms: Float32Array,
  ): number {
    let n = 0;
    for (const { bx, bz } of this.window) {
      const s = this.statics.get(bx * CITY_GRID + bz);
      if (!s) continue;
      const count = street ? s.count : s.high;
      if (count === 0) continue;
      // The block anchor's torus image nearest the camera; every figure is
      // stored relative to it (≤ ~140 m away), so one shift places them all.
      const ix = cam.x + wrapDeltaAxis(cam.x, s.ax);
      const iz = cam.z + wrapDeltaAxis(cam.z, s.az);
      m.set(s.matrices.subarray(0, count * 16), n * 16);
      for (let i = 0; i < count; i++) {
        const o = (n + i) * 16;
        m[o + 12] = (m[o + 12] as number) + ix;
        m[o + 14] = (m[o + 14] as number) + iz;
        // D8: someone on a balcony or terrace that fell is gone with it
        // (a zero basis: the instance draws nothing).
        if (
          i < s.high &&
          this.standing.isHidden(s.owner[i] as number, s.ownerK[i] as number)
        ) {
          m.fill(0, o, o + 11);
        }
      }
      colors.set(s.colors.subarray(0, count * 3), n * 3);
      life.set(s.life.subarray(0, count * 4), n * 4);
      arms.set(s.arms.subarray(0, count), n);
      n += count;
    }
    return n;
  }

  /** D9: the room's fallen bridge spans (river.ts gaps), set per frame. */
  gaps = 0;

  private put(
    n: number,
    p: FigurePose,
    kind: number,
    tone: number,
    height: number,
    who: number,
    flags: number,
    cam: Vec3,
    m: Float32Array,
    colors: Float32Array,
    life: Float32Array,
    arms: Float32Array,
  ): number {
    if (n >= this.capacity) return n;
    // D9: nobody walks on the open water a fallen bridge span left.
    if (this.gaps !== 0 && inBridgeGap(p.x, p.z, this.gaps)) return n;
    writeMatrix(
      m,
      n * 16,
      p.yaw,
      p.scale,
      height,
      cam.x + wrapDeltaAxis(cam.x, p.x),
      p.y + p.bob,
      cam.z + wrapDeltaAxis(cam.z, p.z),
    );
    writeTone(kind, tone, colors, n * 3);
    const o = n * 4;
    life[o] = kind;
    life[o + 1] = 0;
    life[o + 2] = who;
    life[o + 3] = flags;
    arms[n] = p.arm;
    return n + 1;
  }

  private writeRing(
    cam: Vec3,
    t: number,
    timeMs: number,
    keep: number,
    passes: readonly NearPass[],
    n0: number,
    m: Float32Array,
    colors: Float32Array,
    life: Float32Array,
    arms: Float32Array,
  ): number {
    let n = n0;
    for (const { bx, bz } of this.window) {
      const specs = this.ring.get(bx * CITY_GRID + bz);
      if (!specs) continue;
      const watchable =
        passes.length > 0 && blockNearAny(bx, bz, passes, timeMs);
      for (let i = 0; i < specs.length; i++) {
        if (!microKeep(i, keep)) continue;
        const f = specs[i] as RingFigure;
        const who = whoHash(f.base + i);
        let shift = 0;
        if (watchable && f.speed > 0 && who < WATCH_SHARE) {
          // A watcher stands still while it looks (its leash-mate too: the
          // dog shares the owner's base, so the same hash freezes both).
          ringFigurePoseInto(f, t, this.pose);
          lookAt(passes, this.pose.x, 0, this.pose.z, timeMs, this.look);
          if (this.look.age >= 0) {
            shift = -f.dir * watchHold(this.look.age, f.speed);
          }
        }
        ringFigurePoseInto(f, t, this.pose, shift);
        if (shift !== 0) this.pose.bob = 0;
        n = this.put(
          n,
          this.pose,
          f.kind,
          f.tone,
          f.height,
          f.kind === LifeKind.DOG ? 1 : who,
          0,
          cam,
          m,
          colors,
          life,
          arms,
        );
      }
    }
    return n;
  }

  private writeCrossers(
    cam: Vec3,
    t: number,
    keep: number,
    n0: number,
    m: Float32Array,
    colors: Float32Array,
    life: Float32Array,
    arms: Float32Array,
  ): number {
    let n = n0;
    for (const { bx, bz } of this.window) {
      const key = bx * CITY_GRID + bz;
      const list = this.crossers.get(key);
      if (!list) continue;
      const offset = this.crossOffset.get(key) ?? 0;
      for (let i = 0; i < list.length; i++) {
        if (!microKeep(i, keep)) continue;
        const c = list[i] as Crosser;
        crosserPoseInto(c, t, offset, this.pose);
        // Nobody stops to gawp in the middle of the road.
        const inRoad =
          offCentre(this.pose.x) < 15 || offCentre(this.pose.z) < 15;
        n = this.put(
          n,
          this.pose,
          LifeKind.WALKER,
          c.tone,
          c.height,
          (c.tone * 3.7) % 1,
          inRoad ? FLAG_NO_LOOK : 0,
          cam,
          m,
          colors,
          life,
          arms,
        );
      }
    }
    return n;
  }

  private writeRiders(
    cam: Vec3,
    t: number,
    keep: number,
    n0: number,
    m: Float32Array,
    colors: Float32Array,
    life: Float32Array,
    arms: Float32Array,
  ): number {
    let n = n0;
    const reach = (this.radius + 0.5) * P;
    const { riders } = this.riders;
    for (let i = 0; i < riders.length; i++) {
      if (!microKeep(i, keep)) continue;
      const r = riders[i];
      if (!r) continue;
      riderPoseInto(this.riders, r, t, this.pose);
      if (
        Math.abs(wrapDeltaAxis(cam.x, this.pose.x)) > reach ||
        Math.abs(wrapDeltaAxis(cam.z, this.pose.z)) > reach
      ) {
        continue;
      }
      n = this.put(
        n,
        this.pose,
        r.kind,
        r.tone,
        1,
        r.tone,
        FLAG_NO_LOOK,
        cam,
        m,
        colors,
        life,
        arms,
      );
    }
    return n;
  }

  private writeHailers(
    cam: Vec3,
    t: number,
    n0: number,
    m: Float32Array,
    colors: Float32Array,
    life: Float32Array,
    arms: Float32Array,
  ): number {
    let n = n0;
    const reach = (this.radius + 0.5) * P;
    for (const taxi of this.taxis) {
      for (let i = 0; i < taxi.plan.pickups.length; i++) {
        if (!hailerPoseInto(taxi, i, t, this.pose)) continue;
        if (
          Math.abs(wrapDeltaAxis(cam.x, this.pose.x)) > reach ||
          Math.abs(wrapDeltaAxis(cam.z, this.pose.z)) > reach
        ) {
          continue;
        }
        n = this.put(
          n,
          this.pose,
          LifeKind.WALKER,
          (taxi.tone + i * 0.31) % 1,
          1,
          0.99,
          FLAG_NO_LOOK,
          cam,
          m,
          colors,
          life,
          arms,
        );
      }
    }
    return n;
  }
}

/** Can a pass still driving a reaction reach block (bx, bz)? */
function blockNearAny(
  bx: number,
  bz: number,
  passes: readonly NearPass[],
  timeMs: number,
): boolean {
  const cx = (bx + 0.5) * P;
  const cz = (bz + 0.5) * P;
  const reach = P / 2 + LOOK_RADIUS;
  for (let i = passes.length - 1; i >= 0; i--) {
    const p = passes[i] as NearPass;
    if (timeMs - p.t > 12_000) break;
    if (
      Math.abs(wrapDeltaAxis(cx, p.x)) <= reach &&
      Math.abs(wrapDeltaAxis(cz, p.z)) <= reach
    ) {
      return true;
    }
  }
  return false;
}
