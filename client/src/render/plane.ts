// The plane mesh: the procedural Stearman-style biplane (biplane.ts), shared
// by the local plane and every remote so the two never drift apart visually.
// The model's nose points +Z while game-forward is −Z (yaw 0 faces −Z), so it
// flies inside a half-turned parent; its ~9 m wingspan already matches the
// game's plane size, so scale stays 1:1.
//
// F3: the model sits in a zoom-aware THREE.LOD, and `animatePlane` drives the
// per-frame life — hinged surfaces, prop blur, scarf flutter, battle damage.
// DT1: three levels (full airframe within PLANE_LOD_NEAR, a simplified mid
// level, a low-poly impostor beyond PLANE_LOD_FAR), and a second airframe:
// enemies fly the carrier's fighter-bomber (fighter.ts, buildEnemyMesh) on
// the same rig contract.

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
  CLASSIC_LIVERY,
  type Livery,
  PROP_RADIUS,
  SCARF_ROOT,
  SCARF_SEGMENTS,
  createBiplane,
  hinged,
  sharedGeometry,
} from "./biplane";
import {
  BOMBS_FULL,
  FIGHTER_PROP_RADIUS,
  FIGHTER_PROP_Z,
  fighterGeometry,
} from "./fighter";
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
  /** P4: write the result here instead of a new object (remotes.update,
   * per plane per frame). NEUTRAL_CONTROLS is still returned as itself. */
  out?: ControlDeflection,
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
  const x = d.x * sign * k;
  const y = d.y * sign * k;
  const z = d.z * sign * k;
  if (!out) return ratesToControls(x, y, z);
  // ratesToControls, written in place.
  out.elevator = clamp1(x / PITCH_RATE);
  out.rudder = clamp1(-y / TURN_RATE);
  out.aileron = clamp1(z / ROLL_RATE_FULL);
  return out;
}

// --- LOD ---

/** DT1: beyond this (un-zoomed) camera distance a plane draws its mid
 * level, m, and beyond PLANE_LOD_FAR its impostor. */
export const PLANE_LOD_NEAR = 150;
export const PLANE_LOD_FAR = 450;
/** Switch-back band, fraction of the distance (no flicker at the boundary:
 * 15 m at the near switch, 45 m at the far one). */
const PLANE_LOD_HYSTERESIS = 0.1;
const DEG = Math.PI / 180;
const lodCamera = { matrixWorld: new THREE.Matrix4(), zoom: 1 };

/**
 * THREE.LOD measuring distance in un-zoomed terms: aim zoom narrows the FOV
 * (not camera.zoom), and a bandit magnified 2.5× must keep its full airframe
 * — so the measured distance shrinks by the FOV's magnification.
 */
class PlaneLOD extends THREE.LOD {
  /** QA only (`__ab.planeShowcase`'s `lod`): hold this level whatever the
   * distance — the LOD sheet shows all three side by side. */
  forced: number | null = null;

  override update(camera: THREE.Camera): void {
    if (this.forced !== null) {
      const levels = this.levels;
      for (let i = 0; i < levels.length; i++) {
        (levels[i] as { object: THREE.Object3D }).object.visible =
          i === this.forced;
      }
      // three keeps the level it reports in a private field.
      (this as unknown as { _currentLevel: number })._currentLevel =
        this.forced;
      return;
    }
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

/** Which airframe a plane flies: the player biplane or the enemy fighter. */
export type PlaneKind = "biplane" | "fighter";

/** The moving bits of a plane (biplane.ts / buildEnemyMesh). */
export interface PlaneParts {
  /** Deflection children (rotation.x) of the hinge pivots. */
  aileronL: THREE.Object3D;
  aileronR: THREE.Object3D;
  elevator: THREE.Object3D;
  /** Rudder deflection (rotation.y). */
  rudder: THREE.Object3D;
  blur: THREE.Mesh;
  blurMaterial: THREE.MeshStandardMaterial;
  /** The pilot's scarf (the biplane's; the fighter's pilot wears a mask). */
  scarf: THREE.Mesh | null;
}

export interface PlaneRig {
  kind: PlaneKind;
  parts: PlaneParts;
  lod: THREE.LOD;
  damage: { value: number };
  /** Smoothed deflections, [−1, 1]. */
  smooth: ControlDeflection;
  /** Scarf flutter phase, radians. */
  phase: number;
  /** P4 (fleet.ts): the LOD's two levels, the spinning prop and the
   * livery — what the plane fleet reads to draw this plane instanced. */
  near: THREE.Group;
  mid: THREE.Group;
  far: THREE.Group;
  prop: THREE.Object3D;
  livery: Livery;
  /** DT1 / W2 seam: the bombs still on the racks, bit i = rack i
   * (fighter.ts FIGHTER_BOMB_RACKS). Biplanes carry none. */
  bombs: number;
  /** Whether `animatePlane` rewrites the scarf strip on the CPU. Off once
   * the fleet draws the plane: its vertex shader flutters the scarf from
   * `phase` (fleet.ts), so the strip is never seen. */
  cpuScarf: boolean;
}

/** The rig buildPlaneMesh hung on a plane group (null: not a plane). */
export const planeRig = (plane: THREE.Object3D): PlaneRig | null =>
  (plane.userData.rig as PlaneRig | undefined) ?? null;

export const DAMAGE_CACHE_SUFFIX = "-dmg";

/** Build a plane; the own plane takes the default classic livery. */
export function buildPlaneMesh(livery: Livery = CLASSIC_LIVERY): THREE.Group {
  const { near, mid, far, parts } = createBiplane(livery);
  return assemble("biplane", near, mid, far, parts, livery, 0);
}

/** The enemy's stand-in livery (the fighter's paint is baked; this only
 * fills the rig contract). */
const FIGHTER_LIVERY: Livery = { primary: 0x4c564d, secondary: 0x1f5d5a };

/**
 * DT1: an enemy — the carrier's fighter-bomber (fighter.ts). The fleet
 * draws it from the shared geometry with its full paintwork; these
 * per-plane meshes are the `?fleet=0` rollback (same airframe, LODs,
 * hinges and damage; plain vertex-colour paint, no decals or weathering,
 * the bombs shown while any is loaded).
 */
export function buildEnemyMesh(): THREE.Group {
  const s = fighterGeometry();
  const b = sharedGeometry();
  const paint = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.35,
  });
  paint.userData.damage = true;
  const glass = new THREE.MeshStandardMaterial({
    color: 0xbfd9e8,
    roughness: 0.05,
    metalness: 0.1,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const blurMaterial = new THREE.MeshStandardMaterial({
    color: 0x9a9da0,
    map: b.blurTexture,
    roughness: 0.6,
    metalness: 0.3,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  const near = new THREE.Group();
  near.add(new THREE.Mesh(s.statics, paint), new THREE.Mesh(s.glass, glass));
  const ailL = hinged(s.aileronL, paint, s.pivots.aileronL);
  const ailR = hinged(s.aileronR, paint, s.pivots.aileronR);
  const elev = hinged(s.elevator, paint, s.pivots.elevator);
  const rud = hinged(s.rudder, paint, s.pivots.rudder);
  near.add(ailL.holder, ailR.holder, elev.holder, rud.holder);
  const prop = new THREE.Group();
  prop.name = "propeller";
  prop.add(new THREE.Mesh(s.blades, paint));
  prop.position.z = FIGHTER_PROP_Z;
  near.add(prop);
  const bombs = new THREE.Mesh(s.bombs, paint);
  bombs.name = "bombs";
  near.add(bombs);
  // The biplane's blur disc, scaled to this prop (the fleet draws both in
  // one instanced draw by their matrices).
  const blur = new THREE.Mesh(b.blurDisc, blurMaterial);
  blur.scale.setScalar(FIGHTER_PROP_RADIUS / PROP_RADIUS);
  blur.position.z = FIGHTER_PROP_Z + 0.03;
  blur.visible = false;
  near.add(blur);
  const mid = new THREE.Group();
  mid.add(new THREE.Mesh(s.mid, paint), new THREE.Mesh(s.midGlass, glass));
  const far = new THREE.Group();
  far.add(new THREE.Mesh(s.far, paint));
  return assemble(
    "fighter",
    near,
    mid,
    far,
    {
      aileronL: ailL.deflect,
      aileronR: ailR.deflect,
      elevator: elev.deflect,
      rudder: rud.deflect,
      blur,
      blurMaterial,
      scarf: null,
    },
    FIGHTER_LIVERY,
    BOMBS_FULL,
  );
}

/** The LOD, hero light, damage and rig every airframe shares. */
function assemble(
  kind: PlaneKind,
  near: THREE.Group,
  mid: THREE.Group,
  far: THREE.Group,
  parts: PlaneParts,
  livery: Livery,
  bombs: number,
): THREE.Group {
  const g = new THREE.Group();
  const lod = new PlaneLOD();
  lod.addLevel(near, 0);
  lod.addLevel(mid, PLANE_LOD_NEAR, PLANE_LOD_HYSTERESIS);
  lod.addLevel(far, PLANE_LOD_FAR, PLANE_LOD_HYSTERESIS);
  lod.rotation.y = Math.PI; // model +Z nose → game −Z forward
  // Per-plane hero light (key/fill/rim/env + exhaust ring), body capped
  // below bloom — night readability on own plane and remotes alike.
  applyHeroLight(near);
  applyHeroLight(mid);
  applyHeroLight(far);
  const damage = { value: 0 };
  applyDamage(lod, damage);
  g.add(lod);
  const prop = near.getObjectByName("propeller");
  if (!prop) throw new Error(`buildPlaneMesh: the ${kind} has no propeller`);
  const rig: PlaneRig = {
    kind,
    parts,
    lod,
    damage,
    smooth: { ...NEUTRAL_CONTROLS },
    phase: 0,
    near,
    mid,
    far,
    prop,
    livery,
    cpuScarf: parts.scarf !== null,
    bombs,
  };
  g.userData.rig = rig;
  return g;
}

/** QA only: hold `plane` at LOD `level` (0 near, 1 mid, 2 far; null: by
 * distance again). */
export function forcePlaneLod(
  plane: THREE.Object3D,
  level: number | null,
): void {
  const lod = planeRig(plane)?.lod;
  if (lod instanceof PlaneLOD) lod.forced = level;
}

/** DT1 / W2: set which bombs are still on `plane`'s racks (bit i = rack i;
 * a biplane ignores it). */
export function setPlaneBombs(plane: THREE.Object3D, mask: number): void {
  const rig = planeRig(plane);
  if (!rig || rig.kind !== "fighter") return;
  rig.bombs = mask;
  const bombs = rig.near.getObjectByName("bombs");
  if (bombs) bombs.visible = mask !== 0;
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
  if (rig.cpuScarf && parts.scarf && rig.lod.getCurrentLevel() === 0) {
    flutterScarf(parts.scarf, rig.phase);
  }
}

export const SCARF_LENGTH = 0.85;
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

/** DT1: battle damage (1 − hp / MAX_HP) past which skin panels go missing —
 * after the wounded smoke (smoke.ts SMOKE_HP_FRAC) and the engine fire. */
export const MISSING_PANELS_FROM = 0.86;
const f = (n: number): string => n.toFixed(4);

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
  // DT1 missing panels — after the smoke and the fire stages: whole skin
  // panels gone. A fabric bay opens to its ribs (cut through, as the holes);
  // a hull panel shows the dark frame behind. Floored rest cells, so the
  // same panels go on every LOD level and every client.
  float abGone = clamp((uAbDamage - ${f(MISSING_PANELS_FROM)}) * 3.2, 0.0, 0.45);
  vec3 abPanel = floor((vAbHole > 0.75 ? vec3(vAbRest.x, 0.0, vAbRest.z) : vAbRest) / 0.62);
  if (vAbHole > 0.25 && abHash3(abPanel + 11.3) < abGone) {
    if (vAbHole > 0.75) {
      if (abs(fract(vAbRest.x / 0.42 + 0.5) - 0.5) * 0.42 > 0.03) discard;
    } else {
      float abFrame = abs(fract(vAbRest.z / 0.5 + 0.5) - 0.5) * 0.5;
      diffuseColor.rgb = mix(vec3(0.012, 0.011, 0.01), vec3(0.09, 0.085, 0.08), step(abFrame, 0.03));
    }
  }
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
