// L1 pedestrians: instanced sidewalk crowds walking the block rings, density
// following the signage district gradient. Client-only, non-collidable, and
// altitude-gated — nothing here reaches collision.ts, the C1 block index, the
// server, or any bot probe; there is no code path from this module into a
// collision query.
//
// Pose is a pure function of (seed, block, index, server time), the traffic.ts
// idiom: no per-frame integration, nothing to drift, and two tabs with synced
// clocks show the same person on the same paving slab.
//
// STATIC LAYOUT IS PRECOMPUTED ONCE. Every pedestrian's (d, dir, speed, base,
// tone, height) is drawn at construction and cached per block, so the frame
// path replays no PRNG at all. carPose() replays draws 0..i per car, which at
// 130 walkers per block would be ~8.5 k draws per block per frame.
//
// Animation is bob + heading only — no limbs. At 50 m a 1.8 m figure is 32 px
// and at 100 m it is 16 px, where a swinging leg is sub-pixel; the bob is
// keyed to DISTANCE WALKED rather than time, so it reads as footfalls.

import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { blockHeat } from "./signage";
import {
  BLOCK_WINDOW_RADIUS,
  PED_BAND_MAX,
  PED_BAND_MIN,
  type RingPoint,
  TAG_PED,
  blockStream,
  blockWindow,
  microKeep,
  ringPerimeter,
  ringPointInto,
} from "./streetlife";
import { nearestImage } from "./wrapPlacement";

/** Pedestrians on the coldest block (heat 0). */
export const PED_MIN = 30;
/** Pedestrians on a peak landmark/plaza block (heat 1). */
export const PED_MAX = 130;
/**
 * Exponent applied to the district heat before mixing MIN → MAX.
 *
 * blockHeat is quantised: over the 100 blocks it takes exactly four values —
 * 2 blocks at 0, 41 at 1/3, 50 at 2/3, 7 at 1. Mixing linearly would put 98 of
 * 100 blocks within 1.55× of each other, so the gradient would pass a
 * two-corner-blocks test while a player saw a flat city. Squaring gives
 * 30 / 41 / 74 / 130 — a 1.8× median-core-to-median-outskirt ratio.
 */
export const PED_HEAT_GAMMA = 2;

/** Walk speed band, m/s. */
const SPEED_MIN = 1.05;
const SPEED_MAX = 1.55;
/** Fraction of the crowd standing still (a doorway, a phone, a conversation). */
const STAND_FRACTION = 0.12;
/** Meters of walking per bob cycle — a stride. */
const STRIDE = 0.85;
/** Bob amplitude, meters. */
const BOB = 0.045;
/** Body height multiplier band (a crowd is not one height). */
const HEIGHT_MIN = 0.92;
const HEIGHT_SPAN = 0.2;

/** Muted night coats with a few warm accents — Concept 5's palette. */
const COAT_COLORS = [
  0x7b828f, 0xa08d76, 0x5d7290, 0xb07a5e, 0x8b8b96, 0xc4ab86, 0x4f7264,
  0x9a8fa6,
];

/** How many pedestrians block (bx, bz) carries — the district gradient. */
export function pedestrianCount(bx: number, bz: number): number {
  const heat = blockHeat(bx, bz);
  return Math.round(PED_MIN + (PED_MAX - PED_MIN) * heat ** PED_HEAT_GAMMA);
}

/** One pedestrian's static, time-independent layout. Drawn once, cached. */
export interface PedestrianSpec {
  bx: number;
  bz: number;
  /** Lateral offset from the street centerline, inside the pedestrian band. */
  d: number;
  /** Ring perimeter at `d`, meters (cached: the frame path must not divide). */
  perimeter: number;
  /** Station along the ring at t = 0, meters. */
  base: number;
  /** Direction of travel around the ring. */
  dir: 1 | -1;
  /** Meters per second; 0 for a stander. */
  speed: number;
  /** Index into COAT_COLORS. */
  tone: number;
  /** Height multiplier on the 1.8 m base figure. */
  height: number;
  /** Fixed facing for a stander, radians. */
  idleYaw: number;
}

/**
 * Every pedestrian on block (bx, bz), deterministic from (seed, block). Each
 * one draws its six values unconditionally and in a fixed order, so adding a
 * knob later shifts the whole crowd rather than silently corrupting one.
 */
export function blockPedestrians(
  bx: number,
  bz: number,
  seed: number,
): PedestrianSpec[] {
  const rand = blockStream(seed, bx, bz, TAG_PED);
  const n = pedestrianCount(bx, bz);
  const out: PedestrianSpec[] = [];
  for (let i = 0; i < n; i++) {
    const d = PED_BAND_MIN + rand() * (PED_BAND_MAX - PED_BAND_MIN);
    const perimeter = ringPerimeter(d);
    const base = rand() * perimeter;
    const dir: 1 | -1 = rand() < 0.5 ? -1 : 1;
    const speedRoll = rand();
    const speed =
      speedRoll < STAND_FRACTION
        ? 0
        : SPEED_MIN +
          ((speedRoll - STAND_FRACTION) / (1 - STAND_FRACTION)) *
            (SPEED_MAX - SPEED_MIN);
    const tone = Math.floor(rand() * COAT_COLORS.length);
    const height = HEIGHT_MIN + rand() * HEIGHT_SPAN;
    out.push({
      bx,
      bz,
      d,
      perimeter,
      base,
      dir,
      speed,
      tone,
      height,
      idleYaw: (base / perimeter) * Math.PI * 2,
    });
  }
  return out;
}

/** A pedestrian's rendered state at one instant. */
export interface PedestrianPose {
  /** Canonical ground position. */
  pos: Vec3;
  /** Facing, radians — forward is −Z at yaw 0 (the plane convention). */
  yaw: number;
  /** Vertical bob above the pavement, meters. */
  bob: number;
}

const ringScratch: RingPoint = { x: 0, z: 0, dx: 0, dz: 0 };

/**
 * Where `spec` is at server time `timeSeconds`, written into `out` (the
 * renderer's scratch — the hot loop allocates nothing but the nearestImage
 * result, exactly as streetlights.ts already does 1200×/frame).
 */
export function pedestrianPoseInto(
  spec: PedestrianSpec,
  timeSeconds: number,
  out: PedestrianPose,
): PedestrianPose {
  const walked = spec.base + spec.dir * spec.speed * timeSeconds;
  ringPointInto(spec.bx, spec.bz, spec.d, walked, ringScratch);
  out.pos.x = ringScratch.x;
  out.pos.y = 0;
  out.pos.z = ringScratch.z;
  if (spec.speed > 0) {
    // Heading follows the ring tangent, flipped when walking against `s` —
    // which is what turning a corner looks like at 90° four times a loop.
    const hx = ringScratch.dx * spec.dir;
    const hz = ringScratch.dz * spec.dir;
    out.yaw = Math.atan2(hx, hz);
    out.bob = Math.abs(Math.sin((Math.PI * walked) / STRIDE)) * BOB;
  } else {
    out.yaw = spec.idleYaw;
    out.bob = 0;
  }
  return out;
}

/** Allocating form — for tests. */
export const pedestrianPose = (
  spec: PedestrianSpec,
  timeSeconds: number,
): PedestrianPose =>
  pedestrianPoseInto(spec, timeSeconds, {
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    bob: 0,
  });

// --- Renderer -------------------------------------------------------------

/** Body box, meters: wider across the shoulders than deep, so it turns. */
const BODY = { width: 0.46, height: 1.42, depth: 0.28 } as const;
const HEAD = 0.22;
/** Head color — one skin-ish tone, mixed in by the shader via aHead. */
const HEAD_COLOR = "vec3(0.66, 0.5, 0.4)";
/**
 * A dim self-lit floor so a dark coat on dark asphalt still reads. The scene
 * has no point lights and no shadow maps, and ACES + fog eat the rest. Peak
 * luminance lands around 0.06 — far under the 0.72 bloom threshold, so this
 * neither blooms nor touches the emissive ladder.
 */
const PED_FILL = 0.5;
/** How hard the faked lamp pool lights a figure standing under a lamp. */
const PED_LAMP = 3.4;

const VERTEX_PARS = /* glsl */ `
attribute float aHead;
varying float vHead;
varying vec2 vWorldXZ;
`;

const VERTEX_MAIN = /* glsl */ `
vHead = aHead;
vWorldXZ = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;
`;

const FRAGMENT_PARS = /* glsl */ `
varying float vHead;
varying vec2 vWorldXZ;
`;

/**
 * The same faked lamp pool streetlights.ts paints on the ground, evaluated on
 * the figure so a walker brightens as they pass under a lamp. Derived from
 * the street cross-section in world space — the ground shader's trick.
 */
const FRAGMENT_MAIN = /* glsl */ `
diffuseColor.rgb = mix(diffuseColor.rgb, ${HEAD_COLOR}, vHead * 0.9);
float pdx = abs(vWorldXZ.x - floor(vWorldXZ.x / 200.0 + 0.5) * 200.0);
float pdz = abs(vWorldXZ.y - floor(vWorldXZ.y / 200.0 + 0.5) * 200.0);
float pRoad = min(pdx, pdz);
float pAlong = (pdx < pdz) ? vWorldXZ.y : vWorldXZ.x;
float pPool =
  exp(-pow(abs(pRoad - 15.0) / 5.5, 2.0)) *
  exp(-pow(abs(fract(pAlong / 25.0) - 0.5) * 25.0 / 7.0, 2.0));
totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.86, 0.62) * pPool * ${PED_LAMP.toFixed(2)};
totalEmissiveRadiance += diffuseColor.rgb * ${PED_FILL.toFixed(2)};
`;

/**
 * Body + head as ONE merged geometry — deliberately not a capsule.
 * CapsuleGeometry is a lathe: rotationally symmetric about Y, so per-instance
 * yaw would be literally unrenderable (the corner turn invisible) while still
 * paying a quaternion and a full compose on ~900 instances a frame. Two boxes
 * are ~24 triangles against the capsule's ~60, and the silhouette turns.
 *
 * `mergeGeometries` defaults to useGroups = false on purpose: `true` yields
 * groups → a material array → two draw calls and a blown budget.
 */
function pedestrianGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(BODY.width, BODY.height, BODY.depth);
  body.translate(0, BODY.height / 2, 0);
  const head = new THREE.BoxGeometry(HEAD, HEAD, HEAD);
  head.translate(0, BODY.height + HEAD / 2, 0);
  const bodyVerts = body.getAttribute("position").count;
  const parts = [body, head];
  const merged = mergeGeometries(parts) ?? new THREE.BufferGeometry();
  for (const part of parts) part.dispose();
  // aHead marks the head vertices so one material can tint two body parts.
  const count = merged.getAttribute("position").count;
  const head01 = new Float32Array(count);
  for (let i = bodyVerts; i < count; i++) head01[i] = 1;
  merged.setAttribute("aHead", new THREE.BufferAttribute(head01, 1));
  return merged;
}

function createPedestrianMaterial(): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  material.customProgramCacheKey = () => "ab-pedestrian";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${VERTEX_MAIN}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${FRAGMENT_MAIN}`,
      );
  };
  return material;
}

/** Every drawn pedestrian in ONE InstancedMesh — one draw call. */
export class Pedestrians {
  readonly mesh: THREE.InstancedMesh;
  private readonly seed: number;
  /** Static layout per block, computed once: the frame path replays no PRNG. */
  private readonly byBlock = new Map<number, PedestrianSpec[]>();
  private readonly pose: PedestrianPose = {
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    bob: 0,
  };
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly vec = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private drawn = 0;

  constructor(seed: number) {
    this.seed = seed;
    const capacity = (2 * BLOCK_WINDOW_RADIUS + 1) ** 2 * PED_MAX;
    this.mesh = new THREE.InstancedMesh(
      pedestrianGeometry(),
      createPedestrianMaterial(),
      capacity,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // instances move relative to the camera
    this.mesh.count = 0;
    this.mesh.visible = false; // until the first server clock estimate
    // Fill every slot once so three ALLOCATES instanceColor (it only defines
    // instancingColor when instanceColor !== null). The values are throwaway:
    // slot i is a different person every frame, so the real colours are
    // written in update() — a constructor-only colouring would make every
    // coat change shade as the camera moved one meter.
    for (let i = 0; i < capacity; i++) {
      this.color.setHex(COAT_COLORS[i % COAT_COLORS.length] ?? 0x7b828f);
      this.mesh.setColorAt(i, this.color);
    }
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** The cached static layout for a block, computed on first sight. */
  private specsFor(bx: number, bz: number): PedestrianSpec[] {
    const key = bx * 1000 + bz;
    let specs = this.byBlock.get(key);
    if (!specs) {
      specs = blockPedestrians(bx, bz, this.seed);
      this.byBlock.set(key, specs);
    }
    return specs;
  }

  /**
   * Place the crowd for server time `serverTimeMs`. Pedestrians MOVE, so a
   * null clock hides them outright (the Traffic policy) rather than showing a
   * city two tabs would disagree about.
   */
  update(cameraPos: Vec3, serverTimeMs: number | null, gate: number): void {
    if (serverTimeMs === null || gate <= 0) {
      this.mesh.visible = false;
      this.mesh.count = 0;
      this.drawn = 0;
      return;
    }
    this.mesh.visible = true;
    const t = serverTimeMs / 1000;
    let n = 0;
    for (const { bx, bz } of blockWindow(cameraPos)) {
      const specs = this.specsFor(bx, bz);
      for (let i = 0; i < specs.length; i++) {
        if (!microKeep(i, gate)) continue;
        const spec = specs[i] as PedestrianSpec;
        pedestrianPoseInto(spec, t, this.pose);
        const p = nearestImage(cameraPos, this.pose.pos);
        this.quat.setFromAxisAngle(Pedestrians.UP, this.pose.yaw);
        this.vec.set(p.x, this.pose.bob, p.z);
        this.scale.set(1, spec.height, 1);
        this.matrix.compose(this.vec, this.quat, this.scale);
        this.mesh.setMatrixAt(n, this.matrix);
        this.color.setHex(COAT_COLORS[spec.tone] ?? 0x7b828f);
        this.mesh.setColorAt(n, this.color);
        n++;
      }
    }
    this.drawn = n;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Instances drawn last frame (perf + the altitude-gate acceptance check). */
  get count(): number {
    return this.drawn;
  }

  /** QA: canonical poses on one FIXED block at a pinned server time. Block
   * order in the window is camera-relative, so slot order legitimately
   * differs between tabs while the city does not — pin the block instead. */
  sample(
    bx: number,
    bz: number,
    serverTimeMs: number,
    limit = 8,
  ): PedestrianPose[] {
    const t = serverTimeMs / 1000;
    return this.specsFor(bx, bz)
      .slice(0, limit)
      .map((spec) => pedestrianPose(spec, t));
  }

  /**
   * The rendered truth for instance `i`, read back out of the instance matrix
   * (the streetlights.imageOf idiom) — NOT a re-derivation of the pure
   * function. Without this a two-tab check compares two evaluations of the
   * same maths and cannot fail even if both renderers drew the wrong torus
   * image of every pedestrian.
   */
  imageOf(i: number): { x: number; y: number; z: number } | null {
    if (i < 0 || i >= this.drawn) return null;
    this.mesh.getMatrixAt(i, this.matrix);
    const e = this.matrix.elements;
    return { x: e[12] as number, y: e[13] as number, z: e[14] as number };
  }
}
