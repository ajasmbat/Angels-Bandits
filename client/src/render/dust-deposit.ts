// DS2 settled dust: once a collapse's cloud has rolled down the avenues and
// thinned out, its dust lies on everything round the lot — the streets, the
// sidewalks, the parked cars and the traffic driving through — pale grey,
// thickest at the lot and thinning out as far as the surge rolled.
//
// The cosmetic layer: a pure function of (the collapse, its age on the
// render clock). DEPOSITS emitters (the newest building collapses near the
// viewer) are uploaded as uniforms; `abDeposit(xz)` (GLSL) is how much dust
// lies at a point. ONE draw: a ground layer, one quad per emitter covering
// the lot and its reach, faded by abDeposit and a noise; the car and prop
// materials read the same function and dust their upward faces (no draw).

import type { Building } from "@angels-bandits/common/city";
import {
  type Collapse,
  KIND_BUILDING,
} from "@angels-bandits/common/city/collapse";
import { COLLAPSE_DUST_MS } from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { destructLook } from "./destruct-look";
import { surgeAlong } from "./surge";

/** Emitters at once (the newest collapses in range). */
export const DEPOSITS = 6;
/** Deposits further than this are not drawn, m. */
const DEPOSIT_RANGE_M = 900;
/** The dust settles between these shares of the cloud's life, lies for
 * DEPOSIT_HOLD_MS, then weathers away over DEPOSIT_FADE_MS. */
const SETTLE_FROM = 0.3;
const SETTLE_TO = 0.85;
export const DEPOSIT_HOLD_MS = 300_000;
const DEPOSIT_FADE_MS = 60_000;
/** The deepest the dust gets (alpha on the ground, share of a car's
 * colour), and its colour (linear: a pale concrete grey, lit by the
 * scene). */
const DEPOSIT_MAX = 0.82;
export const DEPOSIT_RGB = [0.36, 0.34, 0.31] as const;
const DEPOSIT_GLSL_RGB = `vec3(${DEPOSIT_RGB.map((v) => v.toFixed(2)).join(", ")})`;

/** (x, z at the image nearest the viewer, amount 0..1, reach m) and (half
 * width, half depth, seed, 0) per emitter. Shared by reference. */
export const DEPOSIT_A: THREE.Vector4[] = [];
export const DEPOSIT_B: THREE.Vector4[] = [];
for (let i = 0; i < DEPOSITS; i++) {
  DEPOSIT_A.push(new THREE.Vector4(0, 0, 0, 1));
  DEPOSIT_B.push(new THREE.Vector4(1, 1, 0, 0));
}

/** `abDeposit(xz)`: how much dust lies at a world point (its image near
 * the viewer), 0..1. */
export const DEPOSIT_PARS_GLSL = /* glsl */ `
uniform vec4 uDepA[${DEPOSITS}];
uniform vec4 uDepB[${DEPOSITS}];
float abDeposit(vec2 p) {
  float best = 0.0;
  for (int i = 0; i < ${DEPOSITS}; i++) {
    vec4 a = uDepA[i];
    if (a.z <= 0.0) continue;
    vec2 q = abs(p - a.xy) - uDepB[i].xy;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    // Thick on the lot and its first few metres, thinning out to the reach.
    best = max(best, a.z * (1.0 - smoothstep(0.0, a.w, d)) * (0.55 + 0.45 * (1.0 - smoothstep(0.0, 0.3 * a.w, d))));
  }
  return best;
}
`;

/** The deposit's uniforms on a shader (by reference). */
export function bindDepositUniforms(
  uniforms: Record<string, THREE.IUniform>,
): void {
  uniforms.uDepA = { value: DEPOSIT_A };
  uniforms.uDepB = { value: DEPOSIT_B };
}

/** A material's vertex stage: the world point and how far its face looks
 * up (after begin_vertex; objectNormal in scope). */
export const DEPOSIT_VERTEX_PARS_GLSL = /* glsl */ `
varying vec3 vDepW;
varying float vDepUp;
`;
export const DEPOSIT_VERTEX_GLSL = /* glsl */ `
#ifdef USE_INSTANCING
vDepW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
vDepUp = max(0.0, normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal).y);
#else
vDepW = (modelMatrix * vec4(transformed, 1.0)).xyz;
vDepUp = max(0.0, normalize(mat3(modelMatrix) * objectNormal).y);
#endif
`;
/** …and its fragment stage (after color_fragment): dust over its colour,
 * thickest on what faces up. */
export const DEPOSIT_FRAGMENT_PARS_GLSL = /* glsl */ `
varying vec3 vDepW;
varying float vDepUp;
${DEPOSIT_PARS_GLSL}`;
export const DEPOSIT_FRAGMENT_GLSL = /* glsl */ `
diffuseColor.rgb = mix(diffuseColor.rgb, ${DEPOSIT_GLSL_RGB},
  abDeposit(vDepW.xz) * (0.25 + 0.6 * vDepUp) * ${DEPOSIT_MAX.toFixed(2)});
`;

/** Patch a car / prop material's shader with the dust (an onBeforeCompile
 * helper: the material's own patches run first). */
export function patchDeposit(
  shader: THREE.WebGLProgramParametersWithUniforms,
): void {
  bindDepositUniforms(shader.uniforms);
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>\n${DEPOSIT_VERTEX_PARS_GLSL}`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>\n${DEPOSIT_VERTEX_GLSL}`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>\n${DEPOSIT_FRAGMENT_PARS_GLSL}`,
    )
    .replace(
      "#include <color_fragment>",
      `#include <color_fragment>\n${DEPOSIT_FRAGMENT_GLSL}`,
    );
}

const GROUND_VERTEX = /* glsl */ `
vec4 gdA = uDepA[gl_InstanceID];
vec4 gdB = uDepB[gl_InstanceID];
// The quad covers the lot and the reach (none when the emitter is off).
vec2 gdHalf = (gdB.xy + gdA.w) * step(0.0001, gdA.z);
transformed = vec3(gdA.x + position.x * gdHalf.x, 0.07, gdA.y + position.z * gdHalf.y);
vGdW = transformed.xz;
vGdSeed = gdB.z;
`;

const GROUND_FRAGMENT = /* glsl */ `
float gdN = 0.6 * abDepNoise(vGdW / 3.1 + vGdSeed * 17.0) + 0.4 * abDepNoise(vGdW / 0.9 + 5.0);
diffuseColor.a *= abDeposit(vGdW) * (0.55 + 0.65 * gdN) * ${DEPOSIT_MAX.toFixed(2)};
`;

/** The ground layer's material: lit like the street, fogged, see-through,
 * drawn over the road without fighting it. */
function groundMaterial(): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    color: new THREE.Color().setRGB(...DEPOSIT_RGB, THREE.LinearSRGBColorSpace),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  material.onBeforeCompile = (shader) => {
    bindDepositUniforms(shader.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\nuniform vec4 uDepA[${DEPOSITS}];\nuniform vec4 uDepB[${DEPOSITS}];\nvarying vec2 vGdW;\nvarying float vGdSeed;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${GROUND_VERTEX}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nvarying vec2 vGdW;\nvarying float vGdSeed;\n${DEPOSIT_PARS_GLSL}
float abDepHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float abDepNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(abDepHash(i), abDepHash(i + vec2(1.0, 0.0)), f.x),
    mix(abDepHash(i + vec2(0.0, 1.0)), abDepHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\n${GROUND_FRAGMENT}`,
      );
  };
  material.customProgramCacheKey = () => "ab-ds2-dust-deposit";
  return material;
}

/** The settled dust: the emitters' uniforms, and the ground layer (one
 * draw). */
export class DustDeposit {
  readonly mesh: THREE.Mesh;

  constructor(private readonly buildings: readonly Building[]) {
    const geometry = new THREE.InstancedBufferGeometry();
    // A unit quad in xz ([-1, 1]², facing up); the shader places it.
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        3,
      ),
    );
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(
        new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        3,
      ),
    );
    geometry.setIndex([0, 2, 1, 0, 3, 2]);
    geometry.instanceCount = DEPOSITS;
    this.mesh = new THREE.Mesh(geometry, groundMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.name = "dust-deposit";
    this.mesh.visible = false;
  }

  /** Pick this frame's emitters. Allocation-free. */
  update(
    list: readonly Collapse[],
    viewer: Vec3,
    serverMs: number | null,
  ): void {
    let n = 0;
    const settle = destructLook.dustSettle;
    if (serverMs !== null && settle > 0) {
      const life = COLLAPSE_DUST_MS * destructLook.dustLife;
      for (let k = list.length - 1; k >= 0 && n < DEPOSITS; k--) {
        const c = list[k] as Collapse;
        if (c.kind !== KIND_BUILDING) continue;
        const age = serverMs - c.t0;
        const rise = (age / life - SETTLE_FROM) / (SETTLE_TO - SETTLE_FROM);
        if (rise <= 0) continue;
        const fade =
          1 - (age - life * SETTLE_TO - DEPOSIT_HOLD_MS) / DEPOSIT_FADE_MS;
        const amount = Math.min(1, rise, fade) * Math.min(1, settle);
        if (amount <= 0) continue;
        const dx = wrapDeltaAxis(viewer.x, c.x);
        const dz = wrapDeltaAxis(viewer.z, c.z);
        if (dx * dx + dz * dz > DEPOSIT_RANGE_M * DEPOSIT_RANGE_M) continue;
        const b = this.buildings[c.building];
        if (!b) continue;
        const reach =
          (0.9 * surgeAlong(b.height) + 12) *
          Math.max(0.6, Math.min(settle, 2));
        (DEPOSIT_A[n] as THREE.Vector4).set(
          viewer.x + dx,
          viewer.z + dz,
          amount,
          reach,
        );
        (DEPOSIT_B[n] as THREE.Vector4).set(
          b.width / 2,
          b.depth / 2,
          (c.id * 0.6180339) % 1,
          0,
        );
        n++;
      }
    }
    for (let i = n; i < DEPOSITS; i++) (DEPOSIT_A[i] as THREE.Vector4).z = 0;
    this.mesh.visible = n > 0;
  }
}
