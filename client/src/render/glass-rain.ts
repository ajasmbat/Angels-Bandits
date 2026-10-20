// DS2 glass rain: a collapsing tower's curtain wall shattering into
// glittering shards that rain down its faces, flutter, and lie in the
// street catching the fires and the searchlights.
//
// The cosmetic layer (the Infinite War rule): every shard is a pure
// function of (its emitter's collapse, the shard's index, the collapse's
// age on the render clock), posed in the vertex shader — nothing on the
// wire, no per-shard CPU work, and a lab scrub redraws exactly what the
// live view drew. ONE draw for the whole city: one instanced triangle per
// shard, RAIN_EMITTERS emitters (the newest collapses near the viewer) of
// SHARDS_PER_EMITTER each, scaled by the tier's chaosFx share and the lab's
// glassShards knob. Each frame the CPU writes the emitters' uniforms only.
//
// A glass tower sheds the most; a masonry or office tower its windows'
// share. The glints stay under the bloom threshold (0.72): a shard catches
// the fire it fell out of and the sky's searchlights, it never blows out.

import type { Building } from "@angels-bandits/common/city";
import {
  type Collapse,
  KIND_BUILDING,
} from "@angels-bandits/common/city/collapse";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import { destructLook } from "./destruct-look";

/** Emitters drawn at once, and shards per emitter at full share. */
export const RAIN_EMITTERS = 4;
export const SHARDS_PER_EMITTER = 640;
/** Shards fly and lie this long after their collapse, s (they shrink away
 * over the last RAIN_FADE_S). */
export const RAIN_LIFE_S = 45;
const RAIN_FADE_S = 6;
/** Collapses further than this rain nothing, m (deep in the fog). */
export const RAIN_RANGE_M = 750;
/** The share of the shards a tower sheds, by its facade. */
export const GLASS_SHARE: Readonly<Record<number, number>> = {
  [FacadeArchetype.GLASS]: 1,
  [FacadeArchetype.OFFICE]: 0.55,
  [FacadeArchetype.MASONRY]: 0.3,
};
/** Linear: the shard's own dark glass, and its glints off the sky's
 * searchlights and off the fire — the sum clamped under the bloom
 * threshold. */
const SHARD_BASE = "vec3(0.022, 0.032, 0.038)";
const GLINT_SKY = "vec3(0.36, 0.44, 0.56)";
const GLINT_FIRE = "vec3(0.6, 0.27, 0.08)";
export const GLINT_MAX = 0.66;

const VERTEX_PARS = /* glsl */ `
uniform vec4 uEmA[${RAIN_EMITTERS}]; // x, z (nearest image), age s, glass share
uniform vec4 uEmB[${RAIN_EMITTERS}]; // half width, half depth, height, seed
varying vec3 vShN;
varying vec3 vShPos;
varying vec3 vShFire;
float shH(float k, float s) {
  return fract(sin(k * 12.9898 + s * 78.233) * 43758.5453);
}
vec3 shRot(vec3 v, vec3 ax, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(ax, v) * s + ax * dot(ax, v) * (1.0 - c);
}
`;

const VERTEX_MAIN = /* glsl */ `
int shE = gl_InstanceID % ${RAIN_EMITTERS};
float shK = float(gl_InstanceID / ${RAIN_EMITTERS});
vec4 shA = uEmA[shE];
vec4 shB = uEmB[shE];
float shS = shB.w;
float h0 = shH(shK, shS);
float h1 = shH(shK + 0.37, shS);
float h2 = shH(shK + 0.71, shS);
float h3 = shH(shK + 1.13, shS);
float h4 = shH(shK + 1.57, shS);
float h5 = shH(shK + 2.03, shS);
float h6 = shH(shK + 2.41, shS);
float h7 = shH(shK + 2.89, shS);
float h8 = shH(shK + 3.31, shS);
// Released as the floors fail: most in the first seconds, some late.
float shT = shA.z - (0.3 + 9.0 * h1 * h1);
vec3 shCentre = vec3(shA.x, 0.0, shA.y);
vShFire = shCentre + vec3(0.0, 0.5 * shB.z, 0.0);
transformed = vec3(shA.x, -40.0, shA.y);
vShN = vec3(0.0, 1.0, 0.0);
if (h0 < shA.w && shT > 0.0 && shT < ${RAIN_LIFE_S.toFixed(1)}) {
  // Off one of the four faces, anywhere along it, from 15 % of the height up.
  float shF = floor(h2 * 4.0);
  vec2 shNrm = shF < 1.0 ? vec2(1.0, 0.0) : shF < 2.0 ? vec2(-1.0, 0.0) : shF < 3.0 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
  vec2 shTan = vec2(-shNrm.y, shNrm.x);
  float shAlong = (h3 * 2.0 - 1.0) * (shF < 2.0 ? shB.y : shB.x);
  float shOut = shF < 2.0 ? shB.x : shB.y;
  vec3 p0 = shCentre + vec3(shNrm.x * shOut + shTan.x * shAlong, (0.15 + 0.85 * h4) * shB.z, shNrm.y * shOut + shTan.y * shAlong);
  // Blown out, then falling at a fluttering shard's terminal speed.
  float vOut = 1.5 + 5.5 * h5;
  float vTan = (h6 - 0.5) * 3.0;
  float vUp = 2.0 * h7;
  float vT = 6.0 + 8.0 * h8;
  float tau = vT / 9.81;
  float ground = 0.03 + 0.06 * h3;
  // When it lands (the drag-free tail of the fall), then frozen there.
  float tLand = max((p0.y + (vUp + vT) * tau - ground) / vT, 0.0);
  float t = min(shT, tLand);
  float shE1 = exp(-t / tau);
  float y = p0.y + (vUp + vT) * tau * (1.0 - shE1) - vT * t;
  float landed = step(tLand, shT);
  float hd = 1.6 * (1.0 - exp(-t / 1.6));
  float amp = (0.4 + 1.6 * h6) * (1.0 - shE1);
  float w = 2.0 + 3.0 * h5;
  vec3 pos = p0 + vec3((shNrm.x * vOut + shTan.x * vTan) * hd + amp * sin(w * t + 6.28 * h7),
    0.0, (shNrm.y * vOut + shTan.y * vTan) * hd + amp * cos(0.7 * w * t + 6.28 * h4));
  pos.y = mix(max(y, ground), ground, landed);
  // A thin triangle, tumbling while it falls, lying flat once it lands;
  // it shrinks away at the end of its life.
  float size = (0.18 + 0.45 * h2) * (1.0 - smoothstep(${(RAIN_LIFE_S - RAIN_FADE_S).toFixed(1)}, ${RAIN_LIFE_S.toFixed(1)}, shT));
  float a = float(gl_VertexID) * 2.094 + (shH(shK + float(gl_VertexID) * 0.19, shS) - 0.5) * 1.3;
  float r = size * (0.45 + 0.55 * shH(shK + float(gl_VertexID) * 0.53, shS));
  vec3 local = vec3(cos(a) * r, sin(a) * r, 0.0);
  vec3 shAx = normalize(vec3(h3 - 0.5, h4 - 0.5, h5 - 0.5) + vec3(1e-3));
  float spin = (4.0 + 10.0 * h7) * shT + 6.28 * h8;
  vec3 airP = shRot(local, shAx, spin);
  vec3 airN = shRot(vec3(0.0, 0.0, 1.0), shAx, spin);
  vec3 flatP = shRot(local.xzy, vec3(0.0, 1.0, 0.0), 6.28 * h1);
  transformed = pos + mix(airP, flatP, landed);
  vShN = normalize(mix(airN, vec3(0.0, 1.0, 0.0), landed));
}
vShPos = transformed;
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vShN;
varying vec3 vShPos;
varying vec3 vShFire;
`;

const FRAGMENT_LIGHT = /* glsl */ `
vec3 shN = normalize(vShN);
vec3 shV = normalize(cameraPosition - vShPos);
shN = dot(shN, shV) < 0.0 ? -shN : shN;
vec3 shR = reflect(-shV, shN);
float shSky = pow(max(dot(shR, normalize(vec3(0.15, 1.0, 0.1))), 0.0), 18.0);
float shFire = pow(max(dot(shR, normalize(vShFire - vShPos)), 0.0), 10.0);
vec3 outgoingLight = min(${SHARD_BASE} + ${GLINT_SKY} * shSky + ${GLINT_FIRE} * shFire, vec3(${GLINT_MAX.toFixed(2)}));
`;

/** The shard material: unlit (its glints are its light), fogged like
 * every fogged material, both sides. */
export function glassRainMaterial(
  emA: THREE.Vector4[],
  emB: THREE.Vector4[],
): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEmA = { value: emA };
    shader.uniforms.uEmB = { value: emB };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${VERTEX_MAIN}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        "vec3 outgoingLight = reflectedLight.indirectDiffuse;",
        FRAGMENT_LIGHT,
      );
  };
  material.customProgramCacheKey = () => "ab-ds2-glass-rain";
  return material;
}

/** The glass rain: one instanced triangle per shard, one draw. */
export class GlassRain {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly emA: THREE.Vector4[] = [];
  private readonly emB: THREE.Vector4[] = [];
  /** Per building: its glass share (−1: not looked up yet). */
  private readonly share: Float32Array;
  private quality = 1;

  constructor(private readonly buildings: readonly Building[]) {
    for (let i = 0; i < RAIN_EMITTERS; i++) {
      this.emA.push(new THREE.Vector4(0, 0, -1, 0));
      this.emB.push(new THREE.Vector4(1, 1, 1, 0));
    }
    this.share = new Float32Array(buildings.length).fill(-1);
    const geometry = new THREE.InstancedBufferGeometry();
    // Three vertices; the shader poses them (gl_VertexID, gl_InstanceID).
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(9), 3),
    );
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.mesh = new THREE.Mesh(geometry, glassRainMaterial(this.emA, this.emB));
    this.mesh.frustumCulled = false;
    this.mesh.name = "glass-rain";
    this.mesh.visible = false;
  }

  /** The tier's chaosFx share (quality.ts). */
  setQuality(share: number): void {
    this.quality = share;
  }

  /** The glass share of building `b` (cached). */
  private glassShare(b: number): number {
    let s = this.share[b] as number;
    if (s < 0) {
      const building = this.buildings[b];
      s = building ? (GLASS_SHARE[archetypeFor(building)] ?? 0) : 0;
      this.share[b] = s;
    }
    return s;
  }

  /** Pick this frame's emitters — the newest building collapses in range
   * and alive — and size the draw. Allocation-free. */
  update(
    list: readonly Collapse[],
    viewer: Vec3,
    serverMs: number | null,
  ): void {
    let n = 0;
    if (serverMs !== null) {
      for (let k = list.length - 1; k >= 0 && n < RAIN_EMITTERS; k--) {
        const c = list[k] as Collapse;
        if (c.kind !== KIND_BUILDING) continue;
        const age = (serverMs - c.t0) / 1000;
        if (age < 0 || age > RAIN_LIFE_S + 10) continue;
        const dx = wrapDeltaAxis(viewer.x, c.x);
        const dz = wrapDeltaAxis(viewer.z, c.z);
        if (dx * dx + dz * dz > RAIN_RANGE_M * RAIN_RANGE_M) continue;
        const share = this.glassShare(c.building);
        if (share <= 0) continue;
        const b = this.buildings[c.building] as Building;
        // The building's centre at the image nearest the viewer.
        (this.emA[n] as THREE.Vector4).set(
          viewer.x + dx,
          viewer.z + dz,
          age,
          share,
        );
        (this.emB[n] as THREE.Vector4).set(
          b.width / 2,
          b.depth / 2,
          b.height,
          (c.id * 0.6180339) % 1,
        );
        n++;
      }
    }
    for (let i = n; i < RAIN_EMITTERS; i++) {
      (this.emA[i] as THREE.Vector4).z = -1;
    }
    const per = Math.round(
      SHARDS_PER_EMITTER * this.quality * destructLook.glassShards,
    );
    this.geometry.instanceCount = n > 0 ? per * RAIN_EMITTERS : 0;
    this.mesh.visible = n > 0 && per > 0;
  }
}
