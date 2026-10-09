// The plane mesh: the procedural Stearman-style biplane (biplane.ts), shared
// by the local plane and every remote so the two never drift apart visually.
// The model's nose points +Z while game-forward is −Z (yaw 0 faces −Z), so it
// flies inside a half-turned parent; its ~9 m wingspan already matches the
// game's plane size, so scale stays 1:1.
//
// F3: the model sits in a zoom-aware THREE.LOD (full airframe up close, a
// 2-draw impostor beyond PLANE_LOD_DISTANCE), and `animatePlane` drives the
// per-frame life — hinged surfaces, prop blur, scarf flutter, battle damage.

import {
  BANK_ANGLE,
  BANK_FREQ,
  MAX_HP,
  PITCH_RATE,
  ROLL_RATE,
  TURN_RATE,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  handlingRates,
} from "@angels-bandits/common/flight";
import * as THREE from "three";
import { BASE_FOV } from "../game/zoom";
import {
  type BiplaneParts,
  CLASSIC_LIVERY,
  type Livery,
  SCARF_ROOT,
  SCARF_SEGMENTS,
  createBiplane,
} from "./biplane";
import { applyHeroLight, planeHash } from "./planelights";
import type { QuatLike } from "./trails";

/**
 * Remote pilots' liveries (VO4): primaries kept clear of the own plane's
 * classic red, the spawn-shimmer cyan (0x9fd8e8) and the pale whites that
 * read as it, the storm-reveal violet (0xe07bff) and the nav red/green — so
 * an opponent never reads as you, as a shimmer, or as a light.
 */
export const LIVERIES: readonly Livery[] = [
  { primary: 0x1f5fd6, secondary: 0x123a85 }, // cobalt
  { primary: 0xe0a316, secondary: 0x86560b }, // amber
  { primary: 0x0f9aa0, secondary: 0x085357 }, // teal
  { primary: 0xf06a12, secondary: 0x8a3b0a }, // orange
  { primary: 0xd61f8c, secondary: 0x7a1150 }, // magenta
  { primary: 0x4b5d78, secondary: 0x262f3d }, // slate
  { primary: 0x8e2bd0, secondary: 0x4c1470 }, // purple
  { primary: 0x7a8a1e, secondary: 0x434c10 }, // olive
];

/**
 * A remote pilot's livery: a stable hash of the plane id, so every client
 * paints the same pilot the same colour and it never shuffles mid-fight.
 * Two pilots can share an entry — name tags carry identity.
 */
export function liveryFor(planeId: string): Livery {
  return LIVERIES[planeHash(planeId) % LIVERIES.length] ?? CLASSIC_LIVERY;
}

// --- Control surfaces: pure deflection math ---

/** Normalized surface commands in [−1, 1]. aileron +1 rolls left (left wing
 * down), elevator +1 pitches the nose up, rudder +1 yaws right. */
export interface ControlDeflection {
  aileron: number;
  elevator: number;
  rudder: number;
}

export const NEUTRAL_CONTROLS: ControlDeflection = {
  aileron: 0,
  elevator: 0,
  rudder: 0,
};

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/** Full aileron, rad/s: the bank spring's peak roll rate on a full-bank
 * change (a critically damped step peaks at ω·Δ/e). */
const ROLL_RATE_FULL = (BANK_ANGLE * BANK_FREQ) / Math.E;

/**
 * Body-frame angular rates (rad/s; x = pitch up, y = yaw left, z = roll left,
 * game axes) → surface commands, each normalized by the flight model's full
 * rate so a full-deflection turn reads 1. The one normalizer both the own
 * plane and the remotes go through, so they deflect alike.
 */
export function ratesToControls(
  x: number,
  y: number,
  z: number,
): ControlDeflection {
  return {
    elevator: clamp1(x / PITCH_RATE),
    rudder: clamp1(-y / TURN_RATE),
    aileron: clamp1(z / ROLL_RATE_FULL),
  };
}

/**
 * Own plane: the body rates stepFlight is commanding this frame, from the
 * shaped input, the current attitude and the boost-sharpened handling rates
 * (the same frame decomposition a remote's quaternion delta yields, so the
 * own plane and a remote doing the same turn show the same surfaces).
 */
export function inputControls(
  input: FlightInput,
  state: Pick<FlightState, "pitch" | "roll" | "rollRate" | "speed">,
): ControlDeflection {
  const rates = handlingRates(state.speed, input.boost === true);
  const turn = clamp1(input.turn);
  const pitchRate = clamp1(input.pitch) * rates.pitchRate;
  const yawRate = -turn * rates.turnRate; // world-up axis
  // The bank spring's own rate (F6) — stepFlight already moved it — plus
  // the real A/D roll (F7).
  const rollRate = (state.rollRate ?? 0) + clamp1(input.roll) * ROLL_RATE;
  const sp = Math.sin(state.pitch);
  const cp = Math.cos(state.pitch);
  const sr = Math.sin(state.roll);
  const cr = Math.cos(state.roll);
  return ratesToControls(
    pitchRate * cr + yawRate * cp * sr,
    -pitchRate * sr + yawRate * cp * cr,
    rollRate - yawRate * sp,
  );
}

const qPrev = new THREE.Quaternion();
const qCurr = new THREE.Quaternion();

/**
 * Remote plane: body rates from the frame-to-frame orientation delta
 * conj(prev)·curr (the rotation expressed in the body frame), like
 * trails.ts `turnHardness` — streamed quats only, no protocol change.
 */
export function poseControls(
  prev: QuatLike,
  curr: QuatLike,
  dtS: number,
): ControlDeflection {
  if (dtS <= 0) return NEUTRAL_CONTROLS;
  qPrev.set(prev.x, prev.y, prev.z, prev.w).invert();
  qCurr.set(curr.x, curr.y, curr.z, curr.w);
  const d = qPrev.multiply(qCurr);
  // q and −q are the same attitude: take the short way round.
  const sign = d.w < 0 ? -1 : 1;
  const w = Math.min(1, d.w * sign);
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-6) return NEUTRAL_CONTROLS;
  const k = (2 * Math.acos(w)) / s / dtS;
  return ratesToControls(d.x * sign * k, d.y * sign * k, d.z * sign * k);
}

// --- LOD ---

/** Beyond this (un-zoomed) camera distance a plane draws its impostor, m. */
export const PLANE_LOD_DISTANCE = 300;
/** Switch-back band, fraction of the distance (no flicker at the boundary). */
const PLANE_LOD_HYSTERESIS = 0.05;
const DEG = Math.PI / 180;
const lodCamera = { matrixWorld: new THREE.Matrix4(), zoom: 1 };

/**
 * THREE.LOD measuring distance in un-zoomed terms: aim zoom narrows the FOV
 * (not camera.zoom), and a bandit magnified 2.5× must keep its full airframe
 * — so the measured distance shrinks by the FOV's magnification.
 */
class PlaneLOD extends THREE.LOD {
  override update(camera: THREE.Camera): void {
    let zoom = (camera as THREE.PerspectiveCamera).zoom ?? 1;
    if (camera instanceof THREE.PerspectiveCamera) {
      zoom *= Math.tan((BASE_FOV * DEG) / 2) / Math.tan((camera.fov * DEG) / 2);
    }
    lodCamera.matrixWorld.copy(camera.matrixWorld);
    lodCamera.zoom = zoom;
    super.update(lodCamera as unknown as THREE.Camera);
  }
}

// --- Assembly ---

interface PlaneRig {
  parts: BiplaneParts;
  lod: THREE.LOD;
  damage: { value: number };
  /** Smoothed deflections, [−1, 1]. */
  smooth: ControlDeflection;
  /** Scarf flutter phase, radians. */
  phase: number;
}

export const DAMAGE_CACHE_SUFFIX = "-dmg";

/** Build a plane; the own plane takes the default classic livery. */
export function buildPlaneMesh(livery: Livery = CLASSIC_LIVERY): THREE.Group {
  const g = new THREE.Group();
  const { near, far, parts } = createBiplane(livery);
  const lod = new PlaneLOD();
  lod.addLevel(near, 0);
  lod.addLevel(far, PLANE_LOD_DISTANCE, PLANE_LOD_HYSTERESIS);
  lod.rotation.y = Math.PI; // model +Z nose → game −Z forward
  // Per-plane hero light (key/fill/rim/env + exhaust ring), body capped
  // below bloom — night readability on own plane and remotes alike.
  applyHeroLight(near);
  applyHeroLight(far);
  const damage = { value: 0 };
  applyDamage(lod, damage);
  g.add(lod);
  const rig: PlaneRig = {
    parts,
    lod,
    damage,
    smooth: { ...NEUTRAL_CONTROLS },
    phase: 0,
  };
  g.userData.rig = rig;
  return g;
}

/** Advance the biplane's propeller by `radians` (child group "propeller"). */
export function spinPropeller(plane: THREE.Group, radians: number): void {
  let prop = plane.userData.propeller as THREE.Object3D | undefined;
  if (!prop) {
    prop = plane.getObjectByName("propeller");
    if (!prop) return;
    plane.userData.propeller = prop;
  }
  prop.rotation.z += radians;
}

/** Full surface deflections, radians. */
const AILERON_MAX = 0.35;
const ELEVATOR_MAX = 0.4;
const RUDDER_MAX = 0.45;
/** Deflection smoothing time constant, s (hides snapshot-rate steps). */
const SURFACE_TAU = 0.09;
/** Prop blur: invisible below START, full at FULL (m/s), peak opacity. */
export const PROP_BLUR_START = 25;
export const PROP_BLUR_FULL = 80;
const PROP_BLUR_MAX = 0.5;

/** Prop-blur disc opacity for an airspeed (smoothstep fade-in). */
export function propBlurOpacity(speed: number): number {
  const t = Math.max(
    0,
    Math.min(1, (speed - PROP_BLUR_START) / (PROP_BLUR_FULL - PROP_BLUR_START)),
  );
  return PROP_BLUR_MAX * t * t * (3 - 2 * t);
}

/**
 * Per-frame plane life: ease the hinged surfaces toward `controls`, fade the
 * prop blur in with `speed`, flutter the scarf (near level only) and set the
 * battle damage from `hp`.
 */
export function animatePlane(
  plane: THREE.Group,
  controls: ControlDeflection,
  speed: number,
  hp: number,
  dt: number,
): void {
  const rig = plane.userData.rig as PlaneRig | undefined;
  if (!rig) return;
  const { parts, smooth } = rig;
  const k = 1 - Math.exp(-dt / SURFACE_TAU);
  smooth.aileron += (controls.aileron - smooth.aileron) * k;
  smooth.elevator += (controls.elevator - smooth.elevator) * k;
  smooth.rudder += (controls.rudder - smooth.rudder) * k;
  // Model space (nose +Z; the pilot's left is model +X): a trailing edge
  // swings UP for +rotation.x and to model −X (the pilot's right) for
  // +rotation.y. Roll left = left aileron up, right aileron down.
  parts.aileronL.rotation.x = smooth.aileron * AILERON_MAX;
  parts.aileronR.rotation.x = -smooth.aileron * AILERON_MAX;
  parts.elevator.rotation.x = smooth.elevator * ELEVATOR_MAX;
  parts.rudder.rotation.y = smooth.rudder * RUDDER_MAX;

  const blur = propBlurOpacity(speed);
  parts.blurMaterial.opacity = blur;
  parts.blur.visible = blur > 0.01;

  rig.damage.value = Math.max(0, Math.min(1, 1 - hp / MAX_HP));

  // Flutter faster with airspeed; skip the CPU rewrite while far.
  rig.phase += dt * (12 + speed * 0.12);
  if (rig.lod.getCurrentLevel() === 0) flutterScarf(parts.scarf, rig.phase);
}

const SCARF_LENGTH = 0.85;
const scarfAlong = new THREE.Vector3();
const scarfAcross = new THREE.Vector3();
const scarfNormal = new THREE.Vector3();

/** Rewrite the scarf strip: a travelling wave that grows toward the tail. */
function flutterScarf(scarf: THREE.Mesh, phase: number): void {
  const geo = scarf.geometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i <= SCARF_SEGMENTS; i++) {
    const s = i / SCARF_SEGMENTS;
    const wave = phase - s * 7;
    const amp = s ** 1.3;
    const x = SCARF_ROOT.x + 0.12 * amp * Math.sin(wave);
    const y = SCARF_ROOT.y - 0.07 * s + 0.045 * amp * Math.sin(wave * 1.3 + 1);
    const z = SCARF_ROOT.z - s * SCARF_LENGTH;
    // Ribbon twist about its own length, half-width tapering to the tail.
    const twist = 0.7 * amp * Math.sin(wave + 0.8);
    const hw = 0.06 - 0.025 * s;
    scarfAcross.set(Math.cos(twist) * hw, Math.sin(twist) * hw, 0);
    pos.setXYZ(i * 2, x - scarfAcross.x, y - scarfAcross.y, z);
    pos.setXYZ(i * 2 + 1, x + scarfAcross.x, y + scarfAcross.y, z);
    scarfAlong.set(0, 0, -1);
    scarfNormal.crossVectors(scarfAcross, scarfAlong).normalize();
    nrm.setXYZ(i * 2, scarfNormal.x, scarfNormal.y, scarfNormal.z);
    nrm.setXYZ(i * 2 + 1, scarfNormal.x, scarfNormal.y, scarfNormal.z);
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
}

// --- Battle damage: scorch + holes by HP, chained onto the hero patch ---

const DAMAGE_VERTEX_DECL = `#include <common>
attribute float aHole;
attribute vec3 aRest;
varying vec3 vAbRest;
varying float vAbHole;`;
const DAMAGE_VERTEX_BODY = `#include <begin_vertex>
vAbRest = aRest;
vAbHole = aHole;`;
const DAMAGE_FRAGMENT_DECL = `#include <common>
uniform float uAbDamage;
varying vec3 vAbRest;
varying float vAbHole;
float abHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float abHash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float abNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(abHash3(i), abHash3(i + vec3(1, 0, 0)), f.x),
        mix(abHash3(i + vec3(0, 1, 0)), abHash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(abHash3(i + vec3(0, 0, 1)), abHash3(i + vec3(1, 0, 1)), f.x),
        mix(abHash3(i + vec3(0, 1, 1)), abHash3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}`;
/** After <color_fragment>: scorch darkens the albedo (so the hero light sees
 * it), wing/tail fabric holes are cut through (x,z cells → top and bottom
 * skins line up), fuselage holes read as dark punctures with burnt rims. */
const DAMAGE_FRAGMENT_BODY = `#include <color_fragment>
if (uAbDamage > 0.0) {
  const float abCellSize = 0.32;
  vec3 abCellP = vAbHole > 0.75
    ? vec3(vAbRest.x, 0.0, vAbRest.z) / abCellSize
    : vAbRest / abCellSize;
  vec3 abCell = floor(abCellP);
  vec3 abCenter = vec3(abHash3(abCell + 7.1), abHash3(abCell + 3.3), abHash3(abCell + 5.9));
  if (vAbHole > 0.75) abCenter.y = 0.0;
  vec3 abF = fract(abCellP);
  if (vAbHole > 0.75) abF.y = 0.0;
  float abD = length(abF - (0.25 + 0.5 * abCenter)) * abCellSize;
  float abHoleR = 0.035 + 0.045 * abHash3(abCell + 1.7);
  float abOpen = step(abHash3(abCell), uAbDamage * 0.55 - 0.08) * step(0.25, vAbHole);
  if (vAbHole > 0.75 && abOpen > 0.5 && abD < abHoleR) discard;
  float abPuncture = abOpen * (1.0 - smoothstep(abHoleR * 0.7, abHoleR, abD));
  float abRim = abOpen * (1.0 - smoothstep(abHoleR, abHoleR * 2.8, abD));
  float abN = abNoise(vAbRest * 1.6) * 0.65 + abNoise(vAbRest * 4.7) * 0.35;
  float abEdge = 1.0 - uAbDamage * 0.7;
  float abScorch = smoothstep(abEdge, abEdge + 0.12, abN) * min(1.0, uAbDamage * 3.0);
  float abSoot = clamp(max(abScorch * 0.85, abRim * 0.9) + abPuncture, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.026, 0.024), abSoot);
}`;

/** Patch the damage terms into an (already hero-patched) program. */
export function patchDamage(shader: {
  vertexShader: string;
  fragmentShader: string;
}): void {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", DAMAGE_VERTEX_DECL)
    .replace("#include <begin_vertex>", DAMAGE_VERTEX_BODY);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", DAMAGE_FRAGMENT_DECL)
    .replace("#include <color_fragment>", DAMAGE_FRAGMENT_BODY);
}

/**
 * Chain the damage patch onto every `userData.damage` material under a plane
 * (livery fabric, trim, rudder). Run AFTER applyHeroLight: it wraps the hero
 * onBeforeCompile and extends its cache key. Each material binds the plane's
 * own uniform object (onBeforeCompile runs per material; the GL program is
 * shared by key), so planes scorch independently.
 */
function applyDamage(root: THREE.Object3D, damage: { value: number }): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const material = child.material as THREE.MeshStandardMaterial;
    if (material.userData.damage !== true || material.userData.damagePatched)
      return;
    material.userData.damagePatched = true;
    const hero = material.onBeforeCompile;
    const heroKey = material.customProgramCacheKey();
    material.customProgramCacheKey = () => heroKey + DAMAGE_CACHE_SUFFIX;
    material.onBeforeCompile = (shader, renderer) => {
      hero.call(material, shader, renderer);
      shader.uniforms.uAbDamage = damage;
      patchDamage(shader);
    };
  });
}

/** Free a plane group's per-plane resources (remote plane teardown). The
 * airframe geometry and its textures are shared by every plane and stay. */
export function disposePlaneMesh(group: THREE.Group): void {
  const materials = new Set<THREE.MeshStandardMaterial>();
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      if (!child.geometry.userData.shared) child.geometry.dispose();
      materials.add(child.material as THREE.MeshStandardMaterial);
    }
  });
  for (const material of materials) {
    if (material.map && !material.map.userData.shared) material.map.dispose();
    material.dispose();
  }
}
