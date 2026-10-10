// W3 rooftop AA nests, THREE half (named apart from aa-glsl.ts, which is
// anti-aliasing). Every nest of the room's prop layout (common/src/aa.ts
// aaNestsOf) in FOUR draws for the whole city:
//
//  - BASES: one InstancedMesh of every nest's static half — the light
//    nest's sandbag ring, ammo crates and pedestal, the heavy flak's
//    concrete emplacement and shell crates, and the RUIN heap a downed nest
//    leaves (≤ 1.5 m: clutter, non-solid — its collider left `b.roof` with
//    the prop, common/src/city/props.ts). Which parts an instance shows is
//    a per-vertex variant bitmask tested against a per-instance variant.
//  - GUNS: one InstancedMesh of every manned gun — twin or quad machine
//    guns, or the heavy flak piece — yawed by the instance matrix, the
//    barrels (and the searchlight head on them) pitched in the vertex
//    shader, the crew of one or two bobbing as they work the gun.
//  - BEAMS: one additive cone per manned nest — its searchlight, thrown
//    along the gun, strength following the night (sub-bloom, like L2's).
//  - ROUNDS: one InstancedMesh of AA tracer streaks (and heavy shells) on
//    the EMISSIVE_AA_TRACER rung, a notch under the pilots' own tracers.
//
// Flak bursts, muzzle smoke and a downed nest's fire go through the D1
// particle pool (no draw of their own). Every instance is placed at its
// torus image nearest the viewer each frame and dropped past the fog.
//
// The guns swing exactly like the server's (slewGun, the same rate caps):
// toward their newest burst while it streams, else toward the nearest
// enemy plane in reach, else a slow idle sweep. Nothing here decides a hit.

import {
  AA_HEAVY,
  AA_LIGHT,
  type AaBurst,
  type AaNest,
  type GunAim,
  aaGun,
  aaManned,
  aimOf,
  slewGun,
} from "@angels-bandits/common/aa";
import { type Building, standingTopAt } from "@angels-bandits/common/city";
import type { PropSlot } from "@angels-bandits/common/city/props";
import {
  EMISSIVE_AA_TRACER,
  FOG_DISTANCE,
} from "@angels-bandits/common/constants";
import {
  type Vec3,
  wrapDeltaAxis,
  wrapDeltaInto,
  wrapDistance,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { Impacts } from "./impacts";

/** Nests past this from the viewer are not drawn (inside the fog), m. */
export const AA_DRAW_M = FOG_DISTANCE - 40;
/** Rounds a light burst streams, and the pool of streaks drawn. */
const ROUNDS_PER_BURST = 7;
const ROUND_POOL = 192;
/** A round flies on past its aim point by this share of its flight. */
const OVERSHOOT = 0.35;
/** Streak length (light round, heavy shell), m. */
const STREAK_LIGHT = 9;
const STREAK_HEAVY = 6;
/** A gun keeps tracking its burst point this long after it fired, ms. */
const HOLD_MS = 1600;
/** A downed nest burns this long (tapering), ms, and its fire and smoke
 * per second at full share. */
const BURN_MS = 45_000;
const BURN_FIRE = 8;
const BURN_SMOKE = 4;
/** A flak burst's puff (whole counts at full share). */
const PUFF_FIRE = 5;
const PUFF_SMOKE = 8;
/** Searchlight throw and its far radius, m. */
const BEAM_LENGTH = 140;
const BEAM_RADIUS = 9;

// Variant bits: which instance variant a part belongs to.
const V_TWIN = 1;
const V_QUAD = 2;
const V_HEAVY = 4;
const V_RUIN_LIGHT = 8;
const V_RUIN_HEAVY = 16;
const V_LIGHT = V_TWIN | V_QUAD;
const V_RUIN = V_RUIN_LIGHT | V_RUIN_HEAVY;
/** Instance variant index (the bit tested): twin, quad, heavy, ruins. */
const S_TWIN = 0;
const S_QUAD = 1;
const S_HEAVY = 2;
const S_RUIN_LIGHT = 3;
const S_RUIN_HEAVY = 4;

/** Vertex motion: none, pitched with the barrels, a crewman's bob. */
const M_FIXED = 0;
const M_PITCH = 1;
const M_BOB = 2;

// Tones (sRGB hex; THREE.Color converts).
const SANDBAG = [0x8f7d5a, 0x7f6f50, 0x9a8862];
const CONCRETE = 0x77756e;
const CRATE = 0x4b5638;
const STEEL = 0x30343a;
const GUNMETAL = 0x22252a;
const UNIFORM = 0x55603f;
const SKIN = 0xb88a6a;
const HELMET = 0x3f4a32;
const CHAR = 0x2a2622;
const ASH = 0x3d3934;
const LAMP = 0xfff2c8;

const AA_TRACER_COLOR = new THREE.Color(0xff7040);
const AA_TRACER_BOOST = emissiveBoost(AA_TRACER_COLOR, EMISSIVE_AA_TRACER);

/** One piece of a nest mesh, built into the merged geometry. */
interface Piece {
  geo: THREE.BufferGeometry;
  hex: number;
  variants: number;
  motion: number;
}

/** A box `w × h × d` whose BASE centre is (x, y, z), yawed by `yaw`. */
function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  yaw = 0,
  tilt = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  if (tilt) g.rotateX(tilt);
  if (yaw) g.rotateY(yaw);
  g.translate(x, y, z);
  return g;
}

/** A cylinder of radius `r`, length `len` along −Z from (x, y, z). */
function barrel(
  r: number,
  len: number,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, 6);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z - len / 2);
  return g;
}

/** A vertical cylinder, base centre at (x, y, z). */
function drum(
  r: number,
  h: number,
  x: number,
  y: number,
  z: number,
  seg = 8,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, seg);
  g.translate(x, y + h / 2, z);
  return g;
}

/** Merge pieces into one non-indexed geometry with colour, variant and
 * motion attributes. */
function mergePieces(pieces: readonly Piece[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const vari: number[] = [];
  const mot: number[] = [];
  const c = new THREE.Color();
  for (const p of pieces) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    g.computeVertexNormals();
    const ga = g.getAttribute("position") as THREE.BufferAttribute;
    const gn = g.getAttribute("normal") as THREE.BufferAttribute;
    c.setHex(p.hex);
    for (let i = 0; i < ga.count; i++) {
      pos.push(ga.getX(i), ga.getY(i), ga.getZ(i));
      nor.push(gn.getX(i), gn.getY(i), gn.getZ(i));
      col.push(c.r, c.g, c.b);
      vari.push(p.variants);
      mot.push(p.motion);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute("aVariants", new THREE.Float32BufferAttribute(vari, 1));
  out.setAttribute("aMotion", new THREE.Float32BufferAttribute(mot, 1));
  return out;
}

/** The static half of every nest, deck at y = 0, centred on the nest. */
function basePieces(): Piece[] {
  const out: Piece[] = [];
  const add = (geo: THREE.BufferGeometry, hex: number, variants: number) =>
    out.push({ geo, hex, variants, motion: M_FIXED });
  // Light nest: two staggered courses of sandbags round a 2.1 m ring, a
  // gap at the back for the crew, ammo crates, the pedestal.
  const BAGS = 12;
  for (let course = 0; course < 3; course++) {
    for (let i = 0; i < BAGS; i++) {
      if (i === BAGS / 2) continue; // the way in
      const a = ((i + (course % 2) * 0.5) / BAGS) * Math.PI * 2;
      const r = 2.05 - course * 0.05;
      add(
        box(
          1.15,
          0.36,
          0.62,
          Math.sin(a) * r,
          course * 0.36,
          Math.cos(a) * r,
          a,
        ),
        SANDBAG[(i + course) % SANDBAG.length] as number,
        V_LIGHT,
      );
    }
  }
  add(box(0.7, 0.42, 0.45, 1.0, 0, 0.9, 0.4), CRATE, V_LIGHT);
  add(box(0.7, 0.42, 0.45, 1.05, 0.42, 0.85, 0.2), CRATE, V_LIGHT);
  add(box(0.6, 0.38, 0.4, -1.1, 0, 0.8, -0.3), CRATE, V_LIGHT);
  add(drum(0.3, 1.3, 0, 0, 0), STEEL, V_LIGHT);
  // Heavy flak: a concrete emplacement round a 2.7 m ring, shell crates,
  // a thick pedestal.
  const SEGS = 14;
  for (let i = 0; i < SEGS; i++) {
    if (i === SEGS / 2) continue;
    const a = (i / SEGS) * Math.PI * 2;
    add(
      box(1.3, 1.25, 0.8, Math.sin(a) * 2.75, 0, Math.cos(a) * 2.75, a),
      CONCRETE,
      V_HEAVY,
    );
  }
  for (let i = 0; i < 4; i++) {
    add(
      box(0.9, 0.5, 0.5, -1.4 + i * 0.25, i % 2 === 0 ? 0 : 0.5, 1.7, 0.1),
      CRATE,
      V_HEAVY,
    );
  }
  add(drum(0.55, 1.6, 0, 0, 0, 10), STEEL, V_HEAVY);
  // The ruin: scattered, scorched bags, a slumped gun, ash — ≤ 1.5 m.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.3;
    const r = 1.6 + (i % 3) * 0.35;
    add(
      box(
        1.0,
        0.34,
        0.6,
        Math.sin(a) * r,
        (i % 2) * 0.2,
        Math.cos(a) * r,
        a + i,
        (i % 3) * 0.3,
      ),
      i % 2 ? CHAR : ASH,
      V_RUIN,
    );
  }
  add(box(2.2, 0.5, 1.6, 0.2, 0, -0.1, 0.5), CHAR, V_RUIN);
  add(box(0.24, 0.24, 2.4, 0.3, 0.5, 0.2, 0.9, 0.35), GUNMETAL, V_RUIN);
  add(box(0.5, 0.9, 0.5, -0.4, 0, 0.3, 0.2, 0.3), STEEL, V_RUIN);
  // A heavy ruin keeps stumps of its emplacement wall.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    add(
      box(
        1.2,
        0.6 + (i % 3) * 0.25,
        0.8,
        Math.sin(a) * 2.75,
        0,
        Math.cos(a) * 2.75,
        a,
      ),
      CHAR,
      V_RUIN_HEAVY,
    );
  }
  return out;
}

/** The turning half, pivot at the origin, muzzle toward −Z. */
function gunPieces(): Piece[] {
  const out: Piece[] = [];
  const add = (
    geo: THREE.BufferGeometry,
    hex: number,
    variants: number,
    motion = M_FIXED,
  ) => out.push({ geo, hex, variants, motion });
  // Light: cradle, seat, shield; twin barrels (+ two more on a quad).
  add(box(0.8, 0.45, 0.8, 0, -0.35, 0), STEEL, V_LIGHT);
  add(box(0.5, 0.08, 0.4, 0, -0.45, 0.75), STEEL, V_LIGHT);
  add(box(1.3, 0.7, 0.06, 0, -0.15, -0.45), GUNMETAL, V_LIGHT, M_PITCH);
  add(box(0.5, 0.32, 1.0, 0, -0.1, 0.05), GUNMETAL, V_LIGHT, M_PITCH);
  for (const x of [-0.17, 0.17]) {
    add(barrel(0.055, 1.9, x, 0.08, -0.4), GUNMETAL, V_LIGHT, M_PITCH);
  }
  for (const x of [-0.36, 0.36]) {
    add(barrel(0.055, 1.7, x, -0.06, -0.4), GUNMETAL, V_QUAD, M_PITCH);
    add(box(0.16, 0.3, 0.35, x, -0.2, 0.1), CRATE, V_QUAD, M_PITCH);
  }
  // The searchlight on the cradle's flank, aimed with the guns.
  add(drum(0.2, 0.32, 0.62, -0.05, 0.05, 8), STEEL, V_LIGHT, M_PITCH);
  add(
    box(0.3, 0.3, 0.04, 0.62, -0.04, -0.12),
    LAMP,
    V_LIGHT | V_HEAVY,
    M_PITCH,
  );
  // The gunner: seated behind the cradle.
  add(box(0.42, 0.55, 0.3, 0, -0.42, 0.78), UNIFORM, V_LIGHT, M_BOB);
  add(box(0.22, 0.22, 0.22, 0, 0.12, 0.78), SKIN, V_LIGHT, M_BOB);
  add(box(0.3, 0.1, 0.3, 0, 0.3, 0.78), HELMET, V_LIGHT, M_BOB);
  // Heavy: carriage, breech, long barrel with its muzzle brake, a shield;
  // a layer and a loader.
  add(box(1.6, 0.5, 1.6, 0, -0.6, 0.1), STEEL, V_HEAVY);
  add(box(2.0, 1.1, 0.08, 0, -0.5, -0.7), GUNMETAL, V_HEAVY, M_PITCH);
  add(box(0.7, 0.6, 1.4, 0, -0.3, 0.25), GUNMETAL, V_HEAVY, M_PITCH);
  add(barrel(0.12, 3.6, 0, 0, -0.4), GUNMETAL, V_HEAVY, M_PITCH);
  add(barrel(0.19, 0.35, 0, 0, -3.8), STEEL, V_HEAVY, M_PITCH);
  add(drum(0.22, 0.34, 0.75, -0.05, 0.05, 8), STEEL, V_HEAVY, M_PITCH);
  for (const [x, z] of [
    [-0.85, 0.9],
    [0.8, 1.1],
  ] as const) {
    add(box(0.42, 0.75, 0.3, x, -1.15, z), UNIFORM, V_HEAVY, M_BOB);
    add(box(0.22, 0.22, 0.22, x, -0.38, z), SKIN, V_HEAVY, M_BOB);
    add(box(0.3, 0.1, 0.3, x, -0.18, z), HELMET, V_HEAVY, M_BOB);
  }
  return out;
}

/** Inject the variant test (and the guns' pitch and bob) into a Lambert
 * material. */
function nestMaterial(
  key: string,
  time: { value: number },
  turning: boolean,
): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
  });
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uAaTime = time;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute float aVariants;
attribute float aMotion;
attribute float aState;
attribute float aPitch;
attribute float aSeed;
uniform float uAaTime;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
{
  float shown = mod(floor(aVariants / exp2(aState)), 2.0);
  ${
    turning
      ? `if (aMotion > 0.5 && aMotion < 1.5) {
    float c = cos(aPitch);
    float s = sin(aPitch);
    transformed = vec3(transformed.x,
      transformed.y * c - transformed.z * s,
      transformed.y * s + transformed.z * c);
  } else if (aMotion > 1.5) {
    transformed.y += 0.04 * sin(uAaTime * 7.0 + aSeed * 40.0 + transformed.x * 3.0);
  }`
      : ""
  }
  transformed *= shown;
}`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
${
  turning
    ? `if (aMotion > 0.5 && aMotion < 1.5) {
  float cn = cos(aPitch);
  float sn = sin(aPitch);
  objectNormal = vec3(objectNormal.x,
    objectNormal.y * cn - objectNormal.z * sn,
    objectNormal.y * sn + objectNormal.z * cn);
}`
    : ""
}`,
      );
  };
  return m;
}

/** One live round: from `from` toward `to`, born at `born` (render ms),
 * `fl` ms to its aim point. */
interface Round {
  from: Vec3;
  to: Vec3;
  born: number;
  fl: number;
  heavy: boolean;
}

interface NestView {
  nest: AaNest;
  aim: GunAim;
  /** Newest burst: its aim point and when it was fired (render ms). */
  burstTo: Vec3 | null;
  burstAt: number;
  /** Fire carried frame to frame (typed: no boxed double per frame). */
  acc: Float64Array;
}

/** What the renderer reports (QA, perf). */
export interface AaNestStats {
  count: number;
  heavy: number;
  manned: number;
  destroyed: number;
  /** Rounds and shells in the air this frame. */
  firing: number;
  /** Draw calls the nests cost this frame. */
  drawCalls: number;
  /** Nests drawn this frame (inside the fog). */
  drawn: number;
}

export class AaNestRenderer {
  readonly group = new THREE.Group();
  private readonly bases: THREE.InstancedMesh;
  private readonly guns: THREE.InstancedMesh;
  private readonly beams: THREE.InstancedMesh;
  private readonly rounds: THREE.InstancedMesh;
  private readonly baseState: THREE.InstancedBufferAttribute;
  private readonly gunState: THREE.InstancedBufferAttribute;
  private readonly gunPitch: THREE.InstancedBufferAttribute;
  private readonly beamMaterial: THREE.ShaderMaterial;
  private readonly time = { value: 0 };
  private readonly nightU = { value: 1 };
  private readonly views: NestView[];
  private readonly byId = new Map<number, NestView>();
  private live: Round[] = [];
  private pendingBursts: { b: AaBurst; heavy: boolean }[] = [];
  private share = 1;
  private lastNow = Number.NaN;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly want: GunAim = { yaw: 0, pitch: 0 };
  private readonly d: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private night = 1;
  stats: AaNestStats;

  constructor(
    nests: readonly AaNest[],
    private readonly slot: PropSlot,
    private readonly buildings: readonly Building[],
    private readonly impacts: Impacts,
    /** A heavy shell burst at `at` (main: the crack). */
    private readonly onFlak: (at: Vec3) => void = () => {},
  ) {
    const n = Math.max(1, nests.length);
    this.views = nests.map((nest) => {
      const v: NestView = {
        nest,
        aim: { yaw: nest.yaw0, pitch: 0.3 },
        burstTo: null,
        burstAt: Number.NEGATIVE_INFINITY,
        acc: new Float64Array(2),
      };
      this.byId.set(nest.id, v);
      return v;
    });

    const seeds = new Float32Array(n);
    nests.forEach((nest, i) => {
      seeds[i] = nest.seed;
    });

    const baseGeo = mergePieces(basePieces());
    this.baseState = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.baseState.setUsage(THREE.DynamicDrawUsage);
    baseGeo.setAttribute("aState", this.baseState);
    baseGeo.setAttribute(
      "aPitch",
      new THREE.InstancedBufferAttribute(new Float32Array(n), 1),
    );
    baseGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    this.bases = new THREE.InstancedMesh(
      baseGeo,
      nestMaterial("w3-aa-bases", this.time, false),
      n,
    );

    const gunGeo = mergePieces(gunPieces());
    this.gunState = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.gunState.setUsage(THREE.DynamicDrawUsage);
    this.gunPitch = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.gunPitch.setUsage(THREE.DynamicDrawUsage);
    gunGeo.setAttribute("aState", this.gunState);
    gunGeo.setAttribute("aPitch", this.gunPitch);
    gunGeo.setAttribute(
      "aSeed",
      new THREE.InstancedBufferAttribute(seeds.slice(), 1),
    );
    this.guns = new THREE.InstancedMesh(
      gunGeo,
      nestMaterial("w3-aa-guns", this.time, true),
      n,
    );

    // The searchlight: an open cone along −Z from its apex, sub-bloom,
    // edges fading (searchlights.ts's look, smaller).
    const cone = new THREE.CylinderGeometry(
      BEAM_RADIUS,
      0.25,
      BEAM_LENGTH,
      12,
      1,
      true,
    );
    cone.translate(0, BEAM_LENGTH / 2, 0);
    cone.rotateX(-Math.PI / 2);
    this.beamMaterial = new THREE.ShaderMaterial({
      uniforms: { uNight: this.nightU },
      vertexShader: `
varying float vAlong;
varying vec3 vN;
varying vec3 vView;
void main() {
  vAlong = clamp(-position.z / ${BEAM_LENGTH.toFixed(1)}, 0.0, 1.0);
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `
uniform float uNight;
varying float vAlong;
varying vec3 vN;
varying vec3 vView;
void main() {
  float edge = pow(abs(dot(normalize(vN), normalize(vView))), 1.5);
  float a = (1.0 - vAlong) * (1.0 - vAlong) * edge * 0.22 * uNight;
  gl_FragColor = vec4(vec3(1.0, 0.95, 0.8) * a, a);
}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.beams = new THREE.InstancedMesh(cone, this.beamMaterial, n);

    // Tracer streaks: a thin cylinder along Y, oriented per round.
    const streak = new THREE.CylinderGeometry(0.16, 0.16, 1, 5);
    const roundMaterial = new THREE.MeshBasicMaterial({
      color: AA_TRACER_COLOR,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    roundMaterial.color.multiplyScalar(AA_TRACER_BOOST);
    this.rounds = new THREE.InstancedMesh(streak, roundMaterial, ROUND_POOL);

    for (const mesh of [this.bases, this.guns, this.beams, this.rounds]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.rounds.count = 0;
    this.stats = {
      count: nests.length,
      heavy: nests.filter((x) => x.heavy).length,
      manned: 0,
      destroyed: 0,
      firing: 0,
      drawCalls: 0,
      drawn: 0,
    };
  }

  /** Quality row (chaosFx): share of the fire and smoke. */
  setShare(share: number): void {
    this.share = Math.max(0, Math.min(1, share));
  }

  /** The night's strength for the searchlights, 0..1 (sky cycle). */
  setNight(night: number): void {
    this.night = Math.max(0, Math.min(1, night));
  }

  /** Bursts off the wire (or a QA stage); drawn on the render clock. */
  add(bursts: readonly AaBurst[]): void {
    for (const b of bursts) {
      const v = this.byId.get(b.n);
      if (!v) continue;
      this.pendingBursts.push({ b, heavy: v.nest.heavy });
    }
  }

  /** Drop every burst (a room change, a QA reset). */
  clear(): void {
    this.pendingBursts = [];
    this.live = [];
  }

  /**
   * Per frame. `viewer`: the camera (canonical); `renderMs`: the render
   * clock (server ms, null before the first snapshot); `now`: wall ms;
   * `enemies`: the enemy planes' drawn positions (canonical).
   */
  update(
    viewer: Vec3,
    renderMs: number | null,
    now: number,
    enemies: readonly Vec3[],
  ): void {
    const dt = Number.isFinite(this.lastNow)
      ? Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000))
      : 0;
    this.lastNow = now;
    this.time.value = now / 1000;
    this.nightU.value = this.night;
    const t = renderMs ?? Number.NEGATIVE_INFINITY;
    this.startRounds(t);

    const state = this.slot.state;
    let manned = 0;
    let destroyed = 0;
    let drawn = 0;
    const baseState = this.baseState.array as Float32Array;
    const gunState = this.gunState.array as Float32Array;
    const gunPitch = this.gunPitch.array as Float32Array;
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i] as NestView;
      const nest = v.nest;
      const up = aaManned(nest, this.buildings, state);
      const down = state.isDown(nest.id);
      if (up) manned++;
      if (down) destroyed++;
      // A nest whose deck went (D8) is gone entirely: no ruin floats.
      const shown = up || (down && this.deckStands(nest));
      const dx = wrapDeltaAxis(viewer.x, nest.x);
      const dz = wrapDeltaAxis(viewer.z, nest.z);
      const near = dx * dx + dz * dz <= AA_DRAW_M * AA_DRAW_M;
      if (!shown || !near) {
        this.hide(i);
        continue;
      }
      drawn++;
      const px = viewer.x + dx;
      const pz = viewer.z + dz;
      const deck = nest.y - (nest.heavy ? 2.2 : 1.7);
      baseState[i] = up
        ? nest.heavy
          ? S_HEAVY
          : nest.seed < 0.5
            ? S_TWIN
            : S_QUAD
        : nest.heavy
          ? S_RUIN_HEAVY
          : S_RUIN_LIGHT;
      this.m.makeRotationY(nest.yaw0);
      this.m.setPosition(px, deck, pz);
      this.bases.setMatrixAt(i, this.m);
      if (!up) {
        this.zero(this.guns, i);
        this.zero(this.beams, i);
        if (down) this.burn(v, state.downAt(nest.id), t, now, dt);
        continue;
      }
      gunState[i] = baseState[i] as number;
      this.track(v, t, enemies, dt);
      gunPitch[i] = v.aim.pitch;
      this.e.set(0, v.aim.yaw, 0);
      this.q.setFromEuler(this.e);
      this.p.set(px, nest.y, pz);
      this.s.set(1, 1, 1);
      this.m.compose(this.p, this.q, this.s);
      this.guns.setMatrixAt(i, this.m);
      // The beam leaves the lamp on the gun's flank along the aim.
      this.e.set(v.aim.pitch, v.aim.yaw, 0);
      this.q.setFromEuler(this.e);
      this.p.set(
        px + Math.cos(v.aim.yaw) * (nest.heavy ? 0.75 : 0.62),
        nest.y,
        pz - Math.sin(v.aim.yaw) * (nest.heavy ? 0.75 : 0.62),
      );
      this.s.setScalar(this.night > 0.05 ? 1 : 0);
      this.m.compose(this.p, this.q, this.s);
      this.beams.setMatrixAt(i, this.m);
    }
    this.bases.instanceMatrix.needsUpdate = true;
    this.guns.instanceMatrix.needsUpdate = true;
    this.beams.instanceMatrix.needsUpdate = true;
    this.baseState.needsUpdate = true;
    this.gunState.needsUpdate = true;
    this.gunPitch.needsUpdate = true;
    const any = drawn > 0;
    this.bases.visible = any;
    this.guns.visible = any && manned > 0;
    this.beams.visible = any && manned > 0 && this.night > 0.05;

    const firing = this.placeRounds(viewer, t, now);
    this.stats = {
      count: this.views.length,
      heavy: this.stats.heavy,
      manned,
      destroyed,
      firing,
      drawn,
      drawCalls:
        (this.bases.visible ? 1 : 0) +
        (this.guns.visible ? 1 : 0) +
        (this.beams.visible ? 1 : 0) +
        (this.rounds.visible ? 1 : 0),
    };
  }

  /** Does the deck under nest `n` still stand (its ruin has somewhere to
   * lie)? A felled top takes the ruin with it — nothing floats (D8). */
  private deckStands(n: AaNest): boolean {
    const b = this.buildings[n.b];
    if (!b) return false;
    if (!b.damage) return true;
    const deck = n.y - (n.heavy ? 2.2 : 1.7);
    const top = standingTopAt(
      b,
      wrapDeltaAxis(b.x, n.x),
      wrapDeltaAxis(b.z, n.z),
    );
    return top >= deck - 0.5;
  }

  private hide(i: number): void {
    this.zero(this.bases, i);
    this.zero(this.guns, i);
    this.zero(this.beams, i);
  }

  private zero(mesh: THREE.InstancedMesh, i: number): void {
    this.m.makeScale(0, 0, 0);
    mesh.setMatrixAt(i, this.m);
  }

  /** Swing nest `v`'s gun (the server's rate caps): its newest burst while
   * it streams, else the nearest enemy in reach, else an idle sweep. */
  private track(
    v: NestView,
    t: number,
    enemies: readonly Vec3[],
    dt: number,
  ): void {
    const gun = aaGun(v.nest);
    const pivot = this.at;
    pivot.x = v.nest.x;
    pivot.y = v.nest.y;
    pivot.z = v.nest.z;
    let aimed = false;
    if (v.burstTo && t - v.burstAt < HOLD_MS) {
      wrapDeltaInto(pivot, v.burstTo, this.d);
      aimOf(this.d, this.want);
      aimed = true;
    } else {
      let best = gun.range;
      for (const e of enemies) {
        const dist = wrapDistance(pivot, e);
        if (dist >= best || dist < gun.minRange) continue;
        best = dist;
        wrapDeltaInto(pivot, e, this.d);
        aimOf(this.d, this.want);
        aimed = true;
      }
    }
    if (!aimed) {
      const k = v.nest.seed * 40;
      this.want.yaw = v.nest.yaw0 + Math.sin(this.time.value * 0.13 + k) * 1.1;
      this.want.pitch = 0.35 + 0.15 * Math.sin(this.time.value * 0.21 + k);
    }
    slewGun(v.aim, this.want, aimed ? dt : dt * 0.3, gun);
  }

  /** Move due bursts into the air as rounds. */
  private startRounds(t: number): void {
    if (this.pendingBursts.length === 0) return;
    const kept: { b: AaBurst; heavy: boolean }[] = [];
    for (const pb of this.pendingBursts) {
      const b = pb.b;
      if (b.t0 > t) {
        kept.push(pb);
        continue;
      }
      const v = this.byId.get(b.n);
      if (!v) continue;
      const gun = pb.heavy ? AA_HEAVY : AA_LIGHT;
      // Long past (a stall, a late join): nothing left to draw.
      if (t - b.t0 > b.fl * (1 + OVERSHOOT) + gun.burstMs) continue;
      v.burstTo = b.to;
      v.burstAt = b.t0;
      const from: Vec3 = { x: v.nest.x, y: v.nest.y, z: v.nest.z };
      if (pb.heavy) {
        this.live.push({ from, to: b.to, born: b.t0, fl: b.fl, heavy: true });
        continue;
      }
      for (let k = 0; k < ROUNDS_PER_BURST; k++) {
        this.live.push({
          from,
          to: b.to,
          born: b.t0 + (k * gun.burstMs) / ROUNDS_PER_BURST,
          fl: b.fl,
          heavy: false,
        });
      }
    }
    this.pendingBursts = kept;
  }

  /** Place every round in the air; heavy shells burst at their fuse. */
  private placeRounds(viewer: Vec3, t: number, now: number): number {
    let n = 0;
    const kept: Round[] = [];
    for (const r of this.live) {
      const u = (t - r.born) / r.fl;
      if (r.heavy && u >= 1) {
        this.puff(r.to, now);
        continue;
      }
      if (u > 1 + OVERSHOOT) continue;
      kept.push(r);
      if (u < 0 || n >= ROUND_POOL) continue;
      wrapDeltaInto(r.from, r.to, this.d);
      const len = Math.hypot(this.d.x, this.d.y, this.d.z) || 1;
      const ox = viewer.x + wrapDeltaAxis(viewer.x, r.from.x);
      const oz = viewer.z + wrapDeltaAxis(viewer.z, r.from.z);
      this.p.set(ox + this.d.x * u, r.from.y + this.d.y * u, oz + this.d.z * u);
      this.dir.set(this.d.x / len, this.d.y / len, this.d.z / len);
      this.q.setFromUnitVectors(UP, this.dir);
      const w = r.heavy ? 2.2 : 1;
      this.s.set(w, r.heavy ? STREAK_HEAVY : STREAK_LIGHT, w);
      this.m.compose(this.p, this.q, this.s);
      this.rounds.setMatrixAt(n++, this.m);
    }
    this.live = kept;
    this.rounds.count = n;
    this.rounds.visible = n > 0;
    if (n > 0) this.rounds.instanceMatrix.needsUpdate = true;
    return n;
  }

  /** A heavy shell's burst: a dark puff with a flash of fire. */
  private puff(at: Vec3, now: number): void {
    const s = this.share;
    this.impacts.wreckFire(
      at,
      Math.max(1, Math.round(PUFF_FIRE * s)),
      Math.max(1, Math.round(PUFF_SMOKE * s)),
      3.5,
      now,
    );
    this.onFlak(at);
  }

  /** A downed nest burns, tapering over BURN_MS from its fall. */
  private burn(
    v: NestView,
    downAt: number,
    t: number,
    now: number,
    dt: number,
  ): void {
    const age = Number.isFinite(downAt) && Number.isFinite(t) ? t - downAt : 0;
    const left = 1 - age / BURN_MS;
    if (left <= 0 || this.share <= 0) return;
    const acc = v.acc;
    acc[0] = (acc[0] as number) + BURN_FIRE * this.share * left * dt;
    acc[1] = (acc[1] as number) + BURN_SMOKE * this.share * dt;
    const f = Math.floor(acc[0] as number);
    const s = Math.floor(acc[1] as number);
    if (f <= 0 && s <= 0) return;
    acc[0] = (acc[0] as number) - f;
    acc[1] = (acc[1] as number) - s;
    this.at.x = v.nest.x;
    this.at.y = v.nest.y - 0.8;
    this.at.z = v.nest.z;
    this.impacts.wreckFire(this.at, f, s, 1.8, now);
  }
}

const UP = new THREE.Vector3(0, 1, 0);
