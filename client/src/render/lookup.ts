// A1 plane reactions: crowds look up (and some point) at a plane that passes
// close, and pigeons flutter off a ledge. One shared GLSL chunk, fed by a
// uniform array of the passes nearest the camera, so every figure mesh (the
// L1 pedestrians, the A1 city life, the pigeons) reacts the same way without
// any per-figure CPU state.
//
// DETERMINISM. Passes come from CityReactor's near-pass list, recorded from
// server snapshots on server-time buckets (reactions.ts) — two clients that
// saw the same snapshots hold the same passes, so the same people look up.
// A late joiner simply never saw the old passes, exactly like L1's scatter.
//
// The CPU half (`lookAt`, `watchShift`) mirrors the shader's maths for the
// walkers whose POSITION must freeze while they look (their pose is a pure
// function of time, so a watcher stops by shifting back along their ring,
// then catches up) — and is what the tests exercise.

import { WORLD_SIZE } from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import type { NearPass } from "./reactions";

/** A figure looks at a pass within this 3D distance, meters. */
export const LOOK_RADIUS = 95;
/** Seconds a watcher stands looking after the pass. */
export const LOOK_HOLD_S = 4;
/** Fade out after the hold, seconds. */
export const LOOK_FADE_S = 1.2;
/** A watcher catches up at this extra share of its walking speed. */
export const CATCH_UP = 0.6;
/** Share of figures that stop and look (the rest keep going / scatter). */
export const WATCH_SHARE = 0.6;
/** Share of figures that also point (a subset of the watchers). */
export const POINT_SHARE = 0.28;
/** Pigeons on a ledge burst off from a pass within this distance, meters. */
export const FLUTTER_RADIUS = 42;
/** Seconds until a spooked pigeon is back on its ledge. */
export const FLUTTER_SETTLE_S = 12;
/** Passes the shaders hold (uniform array length). */
export const MAX_LOOK_PASSES = 12;
/** Only passes this close to the camera can matter to anything drawn. */
const LOOK_CULL = 520;
/** Passes older than this drive nothing, seconds. */
export const LOOK_LIFE_S = Math.max(
  LOOK_HOLD_S + LOOK_HOLD_S / CATCH_UP,
  FLUTTER_SETTLE_S,
);

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The look envelope at `age` seconds after a pass (the shader's mirror). */
export const lookEnvelope = (age: number): number =>
  age < 0
    ? 0
    : smooth(0, 0.4, age) *
      (1 - smooth(LOOK_HOLD_S, LOOK_HOLD_S + LOOK_FADE_S, age));

/** A figure's reaction to the passes around it. */
export interface Look {
  /** 0..1 how much it is looking. */
  weight: number;
  /** Seconds since the pass it watches (−1 when none). */
  age: number;
}

/**
 * Which pass (if any) a figure at canonical (x, y, z) reacts to at server
 * time `timeMs`, and how strongly: the strongest envelope × proximity over
 * every pass within LOOK_RADIUS. Pure, allocation-free with `out`.
 */
export function lookAt(
  passes: readonly NearPass[],
  x: number,
  y: number,
  z: number,
  timeMs: number,
  out: Look,
): Look {
  out.weight = 0;
  out.age = -1;
  for (let i = passes.length - 1; i >= 0; i--) {
    const p = passes[i] as NearPass;
    const age = (timeMs - p.t) / 1000;
    if (age < 0) continue;
    if (age > LOOK_LIFE_S) break; // oldest-first list: nothing older matters
    const dx = wrapDeltaAxis(x, p.x);
    if (Math.abs(dx) >= LOOK_RADIUS) continue;
    const dz = wrapDeltaAxis(z, p.z);
    if (Math.abs(dz) >= LOOK_RADIUS) continue;
    const dy = p.y - y;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= LOOK_RADIUS) continue;
    const near = 1 - smooth(LOOK_RADIUS * 0.6, LOOK_RADIUS, d);
    // The freeze follows the most recent qualifying pass's age.
    if (out.age < 0) out.age = age;
    const w = near * lookEnvelope(age);
    if (w > out.weight) out.weight = w;
  }
  return out;
}

/**
 * How far back along its path (meters, as a positive number to SUBTRACT in
 * the direction of travel) a watcher walking at `speed` m/s is held `age`
 * seconds after a pass: it stops for LOOK_HOLD_S, then walks CATCH_UP faster
 * until it is back on its schedule. Continuous, zero outside the reaction.
 */
export function watchHold(age: number, speed: number): number {
  if (age <= 0) return 0;
  const held = Math.min(age, LOOK_HOLD_S);
  const caught = Math.min(
    LOOK_HOLD_S,
    CATCH_UP * Math.max(0, age - LOOK_HOLD_S),
  );
  return speed * (held - caught);
}

/** Deterministic per-figure 0..1 (watchers are `< WATCH_SHARE`). */
export const whoHash = (v: number): number => {
  const s = Math.sin(v * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};

// --- GLSL -------------------------------------------------------------------

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/** Uniform declarations + helpers, for a vertex shader's `#include <common>`. */
export const LOOK_GLSL_PARS = /* glsl */ `
uniform vec4 uAbPasses[${MAX_LOOK_PASSES}];
uniform float uAbPassCount;
float abSmooth01(float a, float b, float x) { return smoothstep(a, b, x); }
// Strongest look at a world (render-space) position: xyz of .xyz is the
// direction to that pass, .w the weight 0..1.
vec4 abLook(vec3 at) {
  vec4 best = vec4(0.0, 1.0, 0.0, 0.0);
  for (int i = 0; i < ${MAX_LOOK_PASSES}; i++) {
    if (float(i) >= uAbPassCount) break;
    vec4 p = uAbPasses[i];
    vec3 d = p.xyz - at;
    float dist = length(d);
    float env = smoothstep(0.0, 0.4, p.w) *
      (1.0 - smoothstep(${f(LOOK_HOLD_S)}, ${f(LOOK_HOLD_S + LOOK_FADE_S)}, p.w));
    float w = env * (1.0 - smoothstep(${f(LOOK_RADIUS * 0.6)}, ${f(LOOK_RADIUS)}, dist));
    if (w > best.w) best = vec4(d, w);
  }
  return best;
}
// Pigeon flutter: the strongest recent pass within FLUTTER_RADIUS. Returns
// the away direction (xz), seconds since the pass (z) and 1/0 found (w).
vec4 abFlutter(vec3 at) {
  vec4 best = vec4(0.0, 0.0, 99.0, 0.0);
  for (int i = 0; i < ${MAX_LOOK_PASSES}; i++) {
    if (float(i) >= uAbPassCount) break;
    vec4 p = uAbPasses[i];
    vec3 d = at - p.xyz;
    if (length(d) < ${f(FLUTTER_RADIUS)} && p.w < ${f(FLUTTER_SETTLE_S)} && p.w < best.z) {
      vec2 away = length(d.xz) > 0.01 ? normalize(d.xz) : vec2(1.0, 0.0);
      best = vec4(away, p.w, 1.0);
    }
  }
  return best;
}
// Rotate a local vector about +Y by a (figure convention: +Z forward,
// yaw = atan(x, z)), and about +X by b (positive tips the top backward).
vec3 abYaw(vec3 v, float a) {
  float c = cos(a); float s = sin(a);
  return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}
vec3 abTilt(vec3 v, float b) {
  float c = cos(b); float s = sin(b);
  return vec3(v.x, v.y * c + v.z * s, -v.y * s + v.z * c);
}
float abWrapAngle(float a) { return a - 6.28318530718 * floor((a + 3.14159265359) / 6.28318530718); }
`;

/**
 * Applies a whole-figure look to a local vertex (`v`) of an instanced figure
 * whose instance matrix is yaw + scale + translation (pedestrians.ts and
 * citylife-render.ts both build exactly that). `w` is the look weight, `dir`
 * the world direction to the plane. Leans back up to 0.24 rad about the feet.
 * Declares nothing; expects `instanceMatrix`.
 */
export const LOOK_GLSL_APPLY = /* glsl */ `
vec3 abApplyLook(vec3 v, float w, vec3 dir) {
  if (w <= 0.001) return v;
  float own = atan(instanceMatrix[2].x, instanceMatrix[2].z);
  float want = atan(dir.x, dir.z);
  float turn = abWrapAngle(want - own) * w;
  return abYaw(abTilt(v, 0.24 * w), turn);
}
`;

/**
 * The per-frame uniform feed: the MAX_LOOK_PASSES passes nearest the
 * camera that are still young enough to drive a reaction, at their torus
 * image nearest the camera, with their age in seconds. One instance is shared
 * by every material (the uniform objects are the same references).
 */
export class LookPasses {
  readonly uniforms = {
    uAbPasses: {
      value: Array.from(
        { length: MAX_LOOK_PASSES },
        () => new THREE.Vector4(0, -1e4, 0, 99),
      ),
    },
    uAbPassCount: { value: 0 },
  };
  private readonly dist = new Float32Array(MAX_LOOK_PASSES);

  update(
    camera: Vec3,
    passes: readonly NearPass[],
    timeMs: number | null,
  ): void {
    const slots = this.uniforms.uAbPasses.value;
    let n = 0;
    if (timeMs !== null) {
      for (let i = passes.length - 1; i >= 0; i--) {
        const p = passes[i] as NearPass;
        const age = (timeMs - p.t) / 1000;
        if (age < 0) continue;
        if (age > LOOK_LIFE_S) break;
        const dx = wrapDeltaAxis(camera.x, p.x);
        const dz = wrapDeltaAxis(camera.z, p.z);
        const dy = p.y - camera.y;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > LOOK_CULL) continue;
        // Keep the nearest MAX_LOOK_PASSES: insert in distance order.
        const full = n === MAX_LOOK_PASSES;
        if (full && d >= (this.dist[MAX_LOOK_PASSES - 1] as number)) continue;
        // The slot to fill: the next free one, or the farthest (dropped).
        let k = full ? MAX_LOOK_PASSES - 1 : n;
        while (k > 0 && (this.dist[k - 1] as number) > d) {
          this.dist[k] = this.dist[k - 1] as number;
          (slots[k] as THREE.Vector4).copy(slots[k - 1] as THREE.Vector4);
          k--;
        }
        this.dist[k] = d;
        (slots[k] as THREE.Vector4).set(camera.x + dx, p.y, camera.z + dz, age);
        if (n < MAX_LOOK_PASSES) n++;
      }
    }
    this.uniforms.uAbPassCount.value = n;
  }

  /** Wire the shared uniforms into a material's shader (onBeforeCompile). */
  attach(shader: { uniforms: Record<string, THREE.IUniform> }): void {
    shader.uniforms.uAbPasses = this.uniforms.uAbPasses;
    shader.uniforms.uAbPassCount = this.uniforms.uAbPassCount;
  }
}

/** The shared instance every material reads. */
export const lookPasses = new LookPasses();

/** World size as a GLSL literal (torus image of a pivot). */
export const W_GLSL = WORLD_SIZE.toFixed(1);
