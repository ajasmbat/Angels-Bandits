// Z1 airship fleet, THREE half (S4's sky boss made a fleet; S9's
// dieselpunk war-zeppelin hull). Every real ship of the room's fleet, its
// flak and its crash, drawn from the room's fleet slot (common/src/boss.ts)
// on the synced RENDER clock — the clock the crash check and the movers
// use, so the hull you see is the hull you hit.
//
// Draw == collide: one base hull geometry (boss-hull.ts buildShipHull),
// lathed and built from the shared part table, and every ship is that
// geometry under its instance matrix: its pose (yaw, the crash's nose-down
// pitch) and its CLASS's scale — the very scale SHIP_PARTS applies to the
// part table collideBoss tests (shipMatrixInto). So the whole fleet is TWO
// instanced hull draws (the full geometry within FLEET_LOD_M of the
// camera, the light one beyond), one Points draw for every ship's running
// lights, lamp lenses and muzzle flashes, and one for the flak shell heads:
// four draws, however many ships fly (the old boss alone was four).
//
// What used to be bones is per instance now: the props spin and the launch
// rigs work in the vertex shader (aBone picks the part; aRigA / aRigB carry
// the bay doors, the trapeze, the catapult carriage and the plane on each
// rig, counter-scaled so a launching plane is plane-sized on any hull), and
// aState carries the ship's damage (the scorch spreading with lost HP), a
// hit's white flash, its seed (a flat per-instance value — never an
// interpolated hash input, concepts/traps/interpolated-hash-inputs.md) and
// whether it is falling. Flak bursts, smoking engines on a hurt ship, the
// fire pouring off a crashing one and the burn where it lands ride the D1
// particle pool (fixed ring, no new draw), scaled by the tier's `bossFx`
// share. Nothing is allocated per frame: poses come through a Float64Array
// (fleetPoseInto64) and everything lands straight in typed arrays.
//
// Visibility parity (quality.ts rule 2): every ship, its lights and the
// shells are the same on every tier — the fleet's size is never scaled.
// Only the particle dressing is.
//
// The skin shader paints the LZ 129's structure onto the lathed polygon:
// 36 longitudinal girders at the polygon's corners, main and intermediate
// ring frames, doped panels with seams and weathering, exhaust soot aft of
// the engine cars, scorch, the lit promenade windows along the belly and the
// FICTIONAL faction crest — a winged cog — and name. No real historical
// insignia. Every line is antialiased against its own derivative and fades
// out before it can alias; the only hashed inputs are floored cells of
// continuous hull coordinates and the flat per-ship seed.

import {
  BAY_STOW_Y,
  BOSS_PARTS,
  BOSS_WEAK_POINTS,
  type BossFlak,
  type BossLaunch,
  type BossPart,
  FLEET_LANES,
  type FleetShip,
  type FleetSlot,
  LAUNCH_BELLY,
  LAUNCH_RESET_MS,
  LAUNCH_SEQ_MS,
  type LaunchLocal,
  PATH_LINE,
  SHIP_CLASSES,
  type ShipClass,
  flakPosAt,
  fleetPoseInto64,
  lanePath,
  laneStreet,
  launchDoneAt,
  launchLocalAt,
  launchReleaseAt,
} from "@angels-bandits/common/boss";
import {
  EMISSIVE_BEACON,
  EMISSIVE_HAZARD,
  EMISSIVE_LAMP,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_STROBE,
  EMISSIVE_WINDOW,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import {
  BONE_CARRIAGE,
  BONE_PLANE_BELLY,
  BONE_PLANE_DECK,
  BONE_PROP,
  BONE_TRAPEZE,
  type BoneRest,
  KEEL_BOTTOM,
  LAMP_AT,
  LAMP_LENS_DROP,
  type PlaneGeo,
  boneRests,
  buildShipHull,
} from "./boss-hull";
import { emissiveBoost } from "./emissive";
import { fighterGeometry } from "./fighter";
import type { Impacts } from "./impacts";
import { CARRIER_BEAM_COLOR, type SpotBeam } from "./searchlights";
import { DUSK, MOON_DIR } from "./sky";

/** The weak points' glow (hazard rung — under tracers, over windows), the
 * white of a fresh hit. */
export const WEAK_COLOR = new THREE.Color(0xff5a1f);
const WEAK_BOOST = emissiveBoost(WEAK_COLOR, EMISSIVE_HAZARD);
const HIT_FLASH_MS = 110;
/** Flak shell heads: hot red-orange on the beacon rung (tracers stay the
 * brightest thing in a fight). */
export const SHELL_COLOR = new THREE.Color(0xff6a3a);
const SHELL_BOOST = emissiveBoost(SHELL_COLOR, EMISSIVE_BEACON);
const SHELL_SIZE_PX = 6;
/** Most shells drawn at once (the fleet's guns × a ~2 s flight / 1.8 s
 * cadence, with room to spare). */
export const SHELL_POOL = 48;
/** Lit windows (the control car, the promenade): warm, on the window rung. */
export const WINDOW_COLOR = new THREE.Color(0xffb866);
const WINDOW_BOOST = emissiveBoost(WINDOW_COLOR, EMISSIVE_WINDOW);
/** Searchlight lenses and muzzle flashes: the lamp rung. */
export const LAMP_COLOR = new THREE.Color(0xfff0d0);
const LAMP_BOOST = emissiveBoost(LAMP_COLOR, EMISSIVE_LAMP);
/** L6: a lamp's throw radius per metre of beam (~4.3° half-angle). The
 * beams are SpotBeams drawn by searchlights.ts; main.ts lands them on the
 * city (beam-landing.ts). */
export const CARRIER_BEAM_SPREAD = 0.075;
/** The searchlight budget (S9/L6's: the carrier's four lamps and its three
 * escorts). Z1: the ships nearest the camera carry them — two lamps each. */
export const BOSS_SPOTS = 7;
const SPOT_SHIPS = 3;
const SPOT_LAMPS = 2;
/** Lamps only light on ships this near the camera, m. */
const SPOT_RANGE_M = 700;
/** L6: each lamp's sweep centre (rad about +Y; 0 = ahead, +π/2 = to port):
 * the control car's pair ahead to starboard and to port. */
const LAMP_BEARING: readonly number[] = [-0.85, 0.85];
/** K1: down an avenue, the pair swings to either beam (rad off the bow)
 * and leans this far off the vertical — the cones land on the facades. */
const LAMP_STREET_BEARING = 1.35;
const LAMP_STREET_TILT = 1.12;
/** Running lights: port red, starboard green, white tail and crown, and the
 * belly's red anti-collision strobe. */
const PORT = new THREE.Color(0xff2a20);
const STARBOARD = new THREE.Color(0x2aff5a);
const WHITE = new THREE.Color(0xffffff);
/** L6: the engine cars' red lamps and the gondola's warm work lamps. */
const ENGINE_RED = new THREE.Color(0xff1e14);
const GONDOLA_WARM = new THREE.Color(0xffc98a);
const NAV_SIZE_PX = 5;
const STROBE_PERIOD_MS = 1300;
const STROBE_ON_MS = 90;
/** Particle emission at full share, per second: a crashing ship's trail,
 * and the fire where it lands (tapering over BURN_MS). */
const TRAIL_FIRE = 60;
const TRAIL_SMOKE = 24;
const BURN_FIRE = 34;
const BURN_SMOKE = 14;
const BURN_MS = 14_000;
/** A flak burst's puff: flames and dark smoke, whole counts at full share. */
const BURST_FIRE = 7;
const BURST_SMOKE = 6;
/** A hurt ship's engines smoke (under HURT_AT of its HP), per second at full
 * share, more as it nears zero. */
const HURT_AT = 0.6;
const HURT_SMOKE = 6;
/** Full detail within this of a ship's centre, the light hull beyond, m. */
export const FLEET_LOD_M = 420;
/** Ships drawn at once, at most (the fleet, its falling, QA's stagings). */
export const FLEET_DRAW_CAP = 48;
const PARKED_Y = -9999;
/** A muzzle flash lasts this long after a shell leaves, ms. */
const FLASH_MS = 90;

/** A running light: where on the base hull, and its look. */
interface NavLight {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  rung: number;
  strobe: boolean;
}
const nav = (
  x: number,
  y: number,
  z: number,
  color: THREE.Color,
  rung: number,
  strobe = false,
): NavLight => ({ x, y, z, color, rung, strobe });
const P = (i: number): BossPart => BOSS_PARTS[i] as BossPart;
/** On the solid faces, never inside or beyond (a light is not solid). The
 * first NAV_FAR of them are what a far ship shows. */
const NAV_LIGHTS: readonly NavLight[] = [
  nav(130.1, 0, 0, WHITE, EMISSIVE_NAVLIGHT),
  nav(-128.1, 0, 0, WHITE, EMISSIVE_NAVLIGHT),
  nav(-110, P(5).y + P(5).hy + 0.1, 0, WHITE, EMISSIVE_NAVLIGHT),
  nav(-110, 0, P(7).z + P(7).hz + 0.1, STARBOARD, EMISSIVE_NAVLIGHT),
  nav(-110, 0, P(8).z - P(8).hz - 0.1, PORT, EMISSIVE_NAVLIGHT),
  nav(P(4).x, P(4).y - P(4).hy - 0.1, 0, PORT, EMISSIVE_STROBE, true),
  nav(P(10).x + 6.6, P(10).y, P(10).z + 0.2, STARBOARD, EMISSIVE_NAVLIGHT),
  nav(P(11).x + 6.6, P(11).y, P(11).z - 0.2, PORT, EMISSIVE_NAVLIGHT),
  nav(P(12).x + 6.6, P(12).y, P(12).z + 0.2, STARBOARD, EMISSIVE_NAVLIGHT),
  nav(P(13).x + 6.6, P(13).y, P(13).z - 0.2, PORT, EMISSIVE_NAVLIGHT),
  nav(-20, 19.9, 0, PORT, EMISSIVE_STROBE, true),
  nav(P(9).x - P(9).hx + 1, KEEL_BOTTOM - 0.1, 0, WHITE, EMISSIVE_STROBE, true),
  // L6: the engine cars' red running lamps, steady on their bellies.
  ...[10, 11, 12, 13].map((i) =>
    nav(P(i).x - 1, P(i).y - 3.05, P(i).z, ENGINE_RED, EMISSIVE_BEACON),
  ),
  // L6: the lit gondola — warm work lamps under the control car and the
  // hangar keel, on the lamp rung.
  ...[-5, 0, 5].map((dx) =>
    nav(P(4).x + dx, P(4).y - P(4).hy - 0.1, 0, GONDOLA_WARM, EMISSIVE_LAMP),
  ),
  nav(P(9).x + 12, KEEL_BOTTOM - 0.1, 2.5, GONDOLA_WARM, EMISSIVE_LAMP),
  nav(P(9).x + 12, KEEL_BOTTOM - 0.1, -2.5, GONDOLA_WARM, EMISSIVE_LAMP),
];
const NAV_FAR = 6;
/** Each light's colour on its rung, once (r, g, b per light). */
const NAV_RGB: Float32Array = (() => {
  const out = new Float32Array(NAV_LIGHTS.length * 3);
  NAV_LIGHTS.forEach((l, i) => {
    const k = emissiveBoost(l.color, l.rung);
    out[i * 3] = l.color.r * k;
    out[i * 3 + 1] = l.color.g * k;
    out[i * 3 + 2] = l.color.b * k;
  });
  return out;
})();
const LAMP_RGB = LAMP_COLOR.clone().multiplyScalar(LAMP_BOOST);
/** Every point the lights draw holds at most: each ship's lights, two lens
 * glows per lamp ship, a flash per shell. */
const LIGHT_POOL =
  FLEET_DRAW_CAP * NAV_LIGHTS.length + SPOT_SHIPS * SPOT_LAMPS + SHELL_POOL;

/**
 * THE placement of a class `cls` ship posed [x, y, z, yaw, pitch] in `pose`
 * at `o`, on its torus image nearest the viewer, written column-major into
 * `out` at `oo`: world = this × base-hull point — T · Ry(yaw) · Rz(pitch) ·
 * S(sx, sr, sr), exactly common/src/boss.ts shipPointInto of the class's
 * scaled parts. Pure; nothing allocated.
 */
export function shipMatrixInto(
  pose: Float64Array,
  o: number,
  cls: number,
  viewer: Vec3,
  out: Float32Array,
  oo: number,
): void {
  const c = SHIP_CLASSES[cls] as ShipClass;
  const cy = Math.cos(pose[o + 3] as number);
  const sy = Math.sin(pose[o + 3] as number);
  const cp = Math.cos(pose[o + 4] as number);
  const sp = Math.sin(pose[o + 4] as number);
  const sx = c.sx;
  const sr = c.sr;
  out[oo] = cy * cp * sx;
  out[oo + 1] = sp * sx;
  out[oo + 2] = -sy * cp * sx;
  out[oo + 3] = 0;
  out[oo + 4] = -cy * sp * sr;
  out[oo + 5] = cp * sr;
  out[oo + 6] = sy * sp * sr;
  out[oo + 7] = 0;
  out[oo + 8] = sy * sr;
  out[oo + 9] = 0;
  out[oo + 10] = cy * sr;
  out[oo + 11] = 0;
  out[oo + 12] = viewer.x + wrapDeltaAxis(viewer.x, pose[o] as number);
  out[oo + 13] = pose[o + 1] as number;
  out[oo + 14] = viewer.z + wrapDeltaAxis(viewer.z, pose[o + 2] as number);
  out[oo + 15] = 1;
}

/** A landed crash still burning where it hit. */
interface Burn {
  at: Vec3;
  since: number;
  fireAcc: number;
  smokeAcc: number;
}

/** What the renderer tells main about the fleet (audio). */
export interface BossCues {
  /** A launch's sequence began at `at`: the bay klaxon, or the steam. */
  launchStart?: (l: BossLaunch, at: Vec3) => void;
  /** It let go: the hook's clunk, or the catapult's slam and hiss. */
  launchRelease?: (l: BossLaunch, at: Vec3) => void;
  /** A ship blew up and started to fall, its centre at `at`. */
  downed?: (at: Vec3) => void;
}

// --- The faction crest ---------------------------------------------------------

/** The fleet's crest and name, drawn once into a 1024 × 512 canvas: the
 * left half a winged cog on a teal roundel ringed in cream, the right half
 * the name plate. A FICTIONAL faction (the Eisenwolke Air Syndicate) —
 * dieselpunk, never a historical emblem. Null without a DOM (tests). */
function drawCrest(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = 1024;
  cv.height = 512;
  const g = cv.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, 1024, 512);
  // Roundel.
  const cx = 256;
  const cy = 256;
  g.fillStyle = "#e9dfc4";
  g.beginPath();
  g.arc(cx, cy, 236, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#1f5d5a";
  g.beginPath();
  g.arc(cx, cy, 214, 0, Math.PI * 2);
  g.fill();
  // Wings: three swept feathers a side, brass.
  g.fillStyle = "#c79a45";
  for (const s of [1, -1]) {
    for (let f = 0; f < 3; f++) {
      g.beginPath();
      const y0 = cy - 40 + f * 34;
      g.moveTo(cx + s * 60, y0);
      g.lineTo(cx + s * (200 - f * 26), y0 - 70 + f * 22);
      g.lineTo(cx + s * (190 - f * 26), y0 - 38 + f * 22);
      g.lineTo(cx + s * 60, y0 + 26);
      g.closePath();
      g.fill();
    }
  }
  // The cog: 12 teeth, a hub, and a propeller in its eye.
  g.fillStyle = "#c79a45";
  g.beginPath();
  for (let t = 0; t < 24; t++) {
    const a = (t / 24) * Math.PI * 2;
    const r = t % 2 === 0 ? 92 : 74;
    const a2 = ((t + 1) / 24) * Math.PI * 2;
    g.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    g.lineTo(cx + r * Math.cos(a2), cy + r * Math.sin(a2));
  }
  g.closePath();
  g.fill();
  g.fillStyle = "#1f5d5a";
  g.beginPath();
  g.arc(cx, cy, 46, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#e9dfc4";
  for (let b = 0; b < 3; b++) {
    g.save();
    g.translate(cx, cy);
    g.rotate((b / 3) * Math.PI * 2 + 0.3);
    g.beginPath();
    g.ellipse(0, -22, 8, 22, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // The name plate: a cream panel, the name stencilled in teal.
  g.fillStyle = "rgba(233,223,196,0.92)";
  g.fillRect(540, 196, 468, 120);
  g.fillStyle = "#173f3d";
  g.font = "bold 74px 'Courier New', monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("EISENWOLKE", 774, 240);
  g.font = "bold 36px 'Courier New', monospace";
  g.fillText("DZ 129-X  ·  AIR SYNDICATE", 774, 292);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  return tex;
}

// --- Shaders ----------------------------------------------------------------------

// --- Shaders ----------------------------------------------------------------------

/** The instance's rig and look (see the header): aState = (damage 0–1, hit
 * flash 0–1, seed 0–1, flags: 1 falling, 2 a plane on the belly rig, 4 on
 * the deck); aRigA = (belly plane y, its pitch, bay doors 0–1, trapeze
 * arm); aRigB = (carriage dx, deck plane x, deck plane y, its pitch) — all
 * in the BASE hull's frame, which the instance matrix then scales. */
const HULL_VERT_HEAD = /* glsl */ `
attribute float aMat;
attribute float aWeak;
attribute float aBone;
attribute vec4 aState;
attribute vec4 aRigA;
attribute vec4 aRigB;
uniform float uTime;
uniform vec3 uProp[4];
uniform vec3 uTrapeze;
uniform vec3 uRestBelly;
uniform vec3 uRestDeck;
varying vec3 vRest;
flat varying float vMat;
flat varying float vWeak;
flat varying float vDmg;
flat varying float vFlash;
flat varying float vSeed;
flat varying float vFall;
varying vec2 vUv2;

float abFlag(float f, float bit) { return mod(floor(f / bit + 0.01), 2.0); }
vec3 abRotX(vec3 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z);
}
vec3 abRotZ(vec3 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
}
// Where this vertex is drawn this frame in the base hull's frame, and its
// normal: the props spin, the rigs work, the rig planes ride them —
// counter-scaled, so after the instance's class scale they are plane-sized.
void abRig(inout vec3 p, inout vec3 n) {
  float b = aBone;
  if (b > ${BONE_PROP - 0.5} && b < ${BONE_PROP + 3.5}) {
    float e = floor(b - ${BONE_PROP.toFixed(1)} + 0.5);
    vec3 piv = e < 0.5 ? uProp[0] : e < 1.5 ? uProp[1] : e < 2.5 ? uProp[2] : uProp[3];
    float dir = mod(e, 2.0) > 0.5 ? -1.0 : 1.0;
    float a = (uTime * 9.0 + aState.z * 6.2831853) * dir;
    p = piv + abRotX(p - piv, a);
    n = abRotX(n, a);
  } else if (b > 22.5 && b < 23.5) {
    p.z -= aRigA.z * 2.55;
  } else if (b > 23.5 && b < 24.5) {
    p.z += aRigA.z * 2.55;
  } else if (b > ${BONE_TRAPEZE - 0.5} && b < ${BONE_TRAPEZE + 0.5}) {
    p.y = uTrapeze.y + (p.y - uTrapeze.y) * aRigA.w;
  } else if (b > ${BONE_CARRIAGE - 0.5} && b < ${BONE_CARRIAGE + 0.5}) {
    p.x += aRigB.x;
  } else if (b > ${BONE_PLANE_BELLY - 0.5} && b < ${BONE_PLANE_DECK + 0.5}) {
    bool belly = b < ${BONE_PLANE_BELLY + 0.5};
    vec3 rest = belly ? uRestBelly : uRestDeck;
    if (abFlag(aState.w, belly ? 2.0 : 4.0) < 0.5) {
      // No plane on this rig: collapsed to a point, no triangle drawn.
      p = rest;
    } else {
      vec3 sc = vec3(
        length(instanceMatrix[0].xyz),
        length(instanceMatrix[1].xyz),
        length(instanceMatrix[2].xyz)
      );
      vec3 at = belly ? vec3(rest.x, aRigA.x, 0.0) : vec3(aRigB.y, aRigB.z, 0.0);
      float pitch = belly ? aRigA.y : aRigB.w;
      p = at + abRotZ(p - rest, pitch) / sc;
      n = abRotZ(n, pitch) * sc;
    }
  }
}
`;
const HULL_NORMAL_BODY = /* glsl */ `
#include <beginnormal_vertex>
vec3 abP = position;
abRig(abP, objectNormal);
`;
const HULL_VERT_BODY = /* glsl */ `
#include <begin_vertex>
transformed = abP;
vRest = position;
vMat = aMat;
vWeak = aWeak;
vDmg = aState.x;
vFlash = aState.y;
vSeed = aState.z;
vFall = abFlag(aState.w, 1.0);
vUv2 = uv;
if (aMat > 6.5 && aMat < 7.5) {
  // A pennant streams and ripples, more toward its tail.
  float t = uv.x;
  transformed.z += sin(uTime * 5.3 + aState.z * 9.0 - t * 7.0) * 0.55 * t;
  transformed.y += sin(uTime * 3.1 - t * 5.0) * 0.18 * t;
}
`;

const HULL_FRAG_HEAD = /* glsl */ `
uniform float uTime;
uniform vec3 uWeakGlow;
uniform vec3 uWeakFlash;
uniform vec3 uWeakPos[7];
uniform vec3 uWindow;
uniform vec3 uEmber;
uniform sampler2D uCrest;
uniform float uHasCrest;
varying vec3 vRest;
flat varying float vMat;
flat varying float vWeak;
flat varying float vDmg;
flat varying float vFlash;
flat varying float vSeed;
flat varying float vFall;
varying vec2 vUv2;

float bHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float bNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bHash(i), bHash(i + vec2(1.0, 0.0)), f.x),
             mix(bHash(i + vec2(0.0, 1.0)), bHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// A line of half-width w (in the coordinate's own units) at the integers of
// q, antialiased by its derivative and faded out before it can alias.
float bLine(float q, float w) {
  float d = abs(fract(q + 0.5) - 0.5);
  // Never a zero-width smoothstep (undefined: NaN on some drivers — and a
  // NaN here would bloom into a black box).
  float fw = max(fwidth(q), 1e-4);
  return (1.0 - smoothstep(w - fw, w + fw, d)) * (1.0 - smoothstep(0.12, 0.3, fw));
}
`;

const HULL_FRAG_SURFACE = /* glsl */ `
#include <color_fragment>
vec3 bEmis = vec3(0.0);
float bRough = 0.62;
float bMetal = 0.35;
// The meridian angle; atan(0, 0) is undefined (the lathes' tips sit on
// the axis), so a point on the axis reads as the top.
float th = abs(vRest.y) + abs(vRest.z) < 1e-4 ? 0.0 : atan(vRest.z, vRest.y);
if (vMat < 0.5) {
  // --- The envelope: girders, ring frames, panels, weathering ---------------
  float gi = th * (36.0 / 6.2831853);
  float girder = bLine(gi, 0.035);
  float ring = bLine(vRest.x / 15.0, 0.012);
  float minor = bLine(vRest.x / 5.0, 0.02) * 0.5;
  vec2 cell = floor(vec2(gi, vRest.x / 5.0));
  float tone = 0.93 + 0.1 * bHash(cell);
  float weather = 0.86 + 0.14 * bNoise(vec2(vRest.x / 9.0, gi / 2.3));
  // Rain and oil streaks run down the lower flanks.
  float below = (1.0 - smoothstep(-0.4, 0.2, cos(th)));
  float streak = bNoise(vec2(vRest.x * 0.9, th * 3.0)) * below;
  diffuseColor.rgb *= tone * weather * (1.0 - 0.18 * streak);
  // Z1: each ship's dope is a little its own (a flat per-instance seed).
  diffuseColor.rgb *= mix(vec3(0.9, 0.95, 1.04), vec3(1.06, 1.0, 0.92), vSeed);
  // L6: on the dark skin the structure reads as SHEEN, not paint — the
  // girders and ring frames are a touch lighter and polished (lower
  // roughness below), so the moon picks them out as bands along the top.
  float rib = max(girder * 0.8, max(ring * 0.9, minor * 0.45));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35 + vec3(0.012, 0.014, 0.02), rib);
  // Exhaust soot aft of the engine cars, on the flank they hang from.
  for (int e = 0; e < 4; e++) {
    vec3 ep = uWeakPos[e];
    float side = step(0.0, ep.z * vRest.z);
    float aft = (1.0 - smoothstep(ep.x - 6.0, ep.x + 2.0, vRest.x)) * smoothstep(ep.x - 46.0, ep.x - 14.0, vRest.x);
    float band = 1.0 - smoothstep(2.0, 6.0, abs(vRest.y - (ep.y + 4.0)));
    float soot = side * aft * band * (0.55 + 0.45 * bNoise(vec2(vRest.x * 0.35, vRest.y * 1.7)));
    diffuseColor.rgb *= 1.0 - 0.6 * soot;
  }
  // Old scorch from earlier raids.
  float sc = (1.0 - smoothstep(1.5, 5.0, length(vec2(vRest.x + 70.0, (th - 2.0) * 18.0)) - 2.5 * bNoise(vRest.xy * 0.4)));
  sc += (1.0 - smoothstep(1.0, 4.0, length(vec2(vRest.x - 96.0, (th + 1.1) * 18.0)) - 2.0 * bNoise(vRest.yz * 0.5)));
  diffuseColor.rgb *= 1.0 - 0.55 * clamp(sc, 0.0, 1.0);
  // The promenade: a lit window band along both lower flanks.
  float at = abs(th);
  float wx = (vRest.x - 6.0) / 2.2;
  if (vRest.x > 6.0 && vRest.x < 48.0) {
    // (The promenade's band, unchanged by L6.)
    float fwx = max(fwidth(wx), 1e-4);
    float inX = smoothstep(0.18 - fwx, 0.18 + fwx, fract(wx)) * (1.0 - smoothstep(0.82 - fwx, 0.82 + fwx, fract(wx)));
    float arc = (at - 2.3) * 20.5;
    float fa = max(fwidth(arc), 1e-4);
    float inY = 1.0 - smoothstep(0.6 - fa, 0.6 + fa, abs(arc));
    float lit = step(0.18, bHash(vec2(floor(wx) + floor(vSeed * 64.0), sign(th))));
    float w = inX * inY;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05), w);
    bEmis += uWindow * w * lit * (0.75 + 0.25 * bHash(vec2(floor(wx), 7.0 + sign(th))));
  }
  // The crest (x 67–75) and the name plate (x 10–34) on both flanks,
  // painted on the curve: u along the hull (reading forward to starboard,
  // aft to port), v up the flank. L6: small — an insignia on a dark hull,
  // not a billboard.
  if (uHasCrest > 0.5) {
    float s = sign(vRest.z);
    float arc = (at - 1.5708) * 21.0;
    vec4 tc = vec4(0.0);
    if (vRest.x > 67.0 && vRest.x < 75.0 && abs(arc) < 4.0) {
      float u = (vRest.x - 67.0) / 8.0;
      tc = texture2D(uCrest, vec2(0.5 * (s > 0.0 ? u : 1.0 - u), 0.5 - arc / 8.0));
    } else if (vRest.x > 10.0 && vRest.x < 34.0 && abs(arc - 4.0) < 1.9) {
      float u = (vRest.x - 10.0) / 24.0;
      tc = texture2D(uCrest, vec2(0.5 + 0.5 * (s > 0.0 ? u : 1.0 - u), 0.5 - (arc - 4.0) / 3.8));
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, tc.rgb * 0.75, tc.a);
  }
  // L6: doped fabric, varnished — glossy enough for the moon to lay a
  // highlight along the top, the ribs glossier still (sheen bands). Not
  // metallic: there is no environment map, so a metal skin would read black
  // between highlights (and S9 found it mirrors the city glow as bronze).
  bRough = mix(0.4, 0.24, rib);
  bMetal = 0.08;
} else if (vMat < 1.5) {
  // --- Painted armour: plate seams and grime ---------------------------------
  float seam = max(bLine(vRest.x / 2.5, 0.02), bLine((vRest.y + vRest.z) / 2.0, 0.02));
  float grime = 0.85 + 0.15 * bNoise(vRest.xz * 0.6 + vRest.y);
  diffuseColor.rgb *= grime * (1.0 - 0.35 * seam);
  bRough = 0.58;
  bMetal = 0.6;
} else if (vMat < 2.5) {
  bRough = 0.42;
  bMetal = 0.75;
} else if (vMat < 3.5) {
  bRough = 0.32;
  bMetal = 0.92;
} else if (vMat < 4.5) {
  // --- Lit windows: mullions over a warm glow --------------------------------
  float pane = bLine(vUv2.x * 9.0, 0.06);
  diffuseColor.rgb = vec3(0.04);
  bEmis += uWindow * (1.0 - pane) * (0.8 + 0.2 * bHash(floor(vec2(vUv2.x * 9.0, 3.0))));
  bRough = 0.1;
} else if (vMat < 5.5) {
  // --- Weak points: the glowing radiators / gas lattice ----------------------
  float spent = vFall;
  float lat = max(bLine(vRest.x / 1.2, 0.08), bLine(th * (16.0 / 6.2831853), 0.06));
  diffuseColor.rgb = mix(vec3(0.09, 0.08, 0.08), vec3(0.03), spent);
  vec3 glow = mix(uWeakGlow, uWeakFlash, vFlash) * (0.72 + 0.28 * (1.0 - lat));
  // Broken open: char, and embers flickering through the cracks.
  float crack = smoothstep(0.55, 0.8, bNoise(vRest.xz * 1.3 + vRest.y));
  float flick = 0.6 + 0.4 * sin(uTime * 11.0 + vRest.x * 3.0);
  bEmis += mix(glow, uEmber * crack * flick, spent);
  bRough = 0.7;
  bMetal = 0.3;
} else if (vMat < 6.5) {
  // --- Decal: the crest on the fins -----------------------------------------
  vec4 tc = uHasCrest > 0.5 ? texture2D(uCrest, vUv2) : vec4(0.0);
  if (tc.a < 0.5) discard;
  diffuseColor.rgb = tc.rgb;
  bRough = 0.6;
  bMetal = 0.2;
} else if (vMat < 7.5) {
  bRough = 0.9;
  bMetal = 0.0;
} else if (vMat < 8.5) {
  bRough = 0.85;
  bMetal = 0.0;
} else if (vMat < 9.5) {
  // --- The hangar bay: dark, amber work lights in a row ---------------------
  float lamp = (1.0 - smoothstep(0.2, 0.5, length(vec2(fract(vRest.x / 3.0) - 0.5, vRest.z * 0.6))));
  bEmis += uWindow * 0.6 * lamp;
  bRough = 0.8;
  bMetal = 0.2;
} else {
  bRough = 0.5;
  bMetal = 0.4;
}
// Fire spreads with the damage: scorch and embers round every weak point,
// growing as the ship's HP goes (Z1: one HP pool, vDmg 0 → 1).
if (vMat < 1.5) {
  float scorch = 0.0;
  for (int k = 0; k < 7; k++) {
    float d = length(vRest - uWeakPos[k]);
    scorch = max(scorch, vDmg * (1.0 - smoothstep(4.0, 7.0 + 7.0 * vDmg, d - 3.0 * bNoise(vRest.xy * 0.3))));
  }
  diffuseColor.rgb *= 1.0 - 0.7 * scorch;
  // Embers: sparse glowing flecks in the char, breathing slowly.
  float ember = smoothstep(0.78, 0.92, bNoise(vRest.xz * 1.7 + vec2(uTime * 0.35, 0.0))) * smoothstep(0.4, 0.9, scorch);
  bEmis += uEmber * 0.35 * ember;
}
`;

/** L6: the lit hull (scene light only, before its own emission) is capped
 * under the 0.72 bloom threshold, as the planes' bodies are (planelights
 * HERO_BODY_CAP): a glossy moon highlight models the hull without ever
 * blooming or outshining its lamps. Emission (windows, weak points, embers)
 * rides on top, uncapped, on its own rungs. */
export const HULL_LIT_CAP = 0.66;
/** L6: the varnished envelope's sheen — there is no environment map, so
 * the gloss is given its light here: a moon glint (Blinn-Phong off
 * MOON_DIR, tighter where the roughness, ribs included, is lower) and a
 * cool fresnel rim brightest on the upper flanks. Peak linear luminances
 * at albedo-free F 1; capped with the rest of the lit hull below. Only the
 * envelope and the armour (vMat < 1.5) take it. */
const SHEEN_COLOR = new THREE.Color(DUSK.moon);
const SHEEN_SPEC_LUM = 0.34;
const SHEEN_RIM_LUM = 0.09;
const glF = (n: number): string => n.toFixed(5);
const sheenCol = (lum: number): string => {
  const c = SHEEN_COLOR.clone().multiplyScalar(emissiveBoost(SHEEN_COLOR, lum));
  return `vec3(${glF(c.r)}, ${glF(c.g)}, ${glF(c.b)})`;
};
const HULL_SHEEN = `vec3 bSheen = vec3(0.0);
if (vMat < 1.5) {
  vec3 sN = normalize(normal);
  vec3 sV = normalize(vViewPosition);
  vec3 sMoon = normalize((viewMatrix * vec4(${glF(MOON_DIR.x)}, ${glF(MOON_DIR.y)}, ${glF(MOON_DIR.z)}, 0.0)).xyz);
  vec3 sUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float sGloss = 1.0 - smoothstep(0.2, 0.7, roughnessFactor);
  float sSpec = pow(saturate(dot(sN, normalize(sMoon + sV))), mix(10.0, 48.0, sGloss));
  float sRim = pow(1.0 - saturate(dot(sN, sV)), 3.0) * (0.3 + 0.7 * saturate(dot(sN, sUp)));
  bSheen = ${sheenCol(SHEEN_SPEC_LUM)} * sSpec * (0.35 + 0.65 * sGloss)
    + ${sheenCol(SHEEN_RIM_LUM)} * sRim;
}`;
const HULL_OUTGOING =
  "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;";
const HULL_OUTGOING_CAPPED = `vec3 bLit = totalDiffuse + totalSpecular + bSheen;
bLit *= min(1.0, ${HULL_LIT_CAP.toFixed(2)} / max(luminance(bLit), 1e-4));
vec3 outgoingLight = bLit + totalEmissiveRadiance;`;

// --- The renderer -------------------------------------------------------------------

/** One instanced hull draw: the mesh and its per-instance attributes. */
interface HullDraw {
  mesh: THREE.InstancedMesh;
  matrix: Float32Array;
  state: THREE.InstancedBufferAttribute;
  rigA: THREE.InstancedBufferAttribute;
  rigB: THREE.InstancedBufferAttribute;
  count: number;
}

const smooth = (u: number): number => {
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  return c * c * (3 - 2 * c);
};

export class FleetRenderer {
  readonly group = new THREE.Group();
  private readonly near: HullDraw;
  private readonly far: HullDraw;
  private readonly lights: THREE.Points;
  private readonly lightPos: THREE.BufferAttribute;
  private readonly lightCol: THREE.BufferAttribute;
  private readonly shells: THREE.Points;
  private readonly shellPos: THREE.BufferAttribute;
  private readonly hullU: {
    uTime: { value: number };
    uWeakGlow: { value: THREE.Color };
    uWeakFlash: { value: THREE.Color };
    uWeakPos: { value: THREE.Vector3[] };
    uWindow: { value: THREE.Color };
    uEmber: { value: THREE.Color };
    uCrest: { value: THREE.Texture | null };
    uHasCrest: { value: number };
    uProp: { value: THREE.Vector3[] };
    uTrapeze: { value: THREE.Vector3 };
    uRestBelly: { value: THREE.Vector3 };
    uRestDeck: { value: THREE.Vector3 };
  };
  private share = 1;
  private readonly rests: BoneRest[];
  /** This frame's ship pose (fleetPoseInto64): [x, y, z, yaw, pitch, hx, hz]. */
  private readonly p64 = new Float64Array(7);
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly local: LaunchLocal = { x: 0, y: 0, z: 0, pitch: 0 };
  /** Per ship id: drawn at full detail (hysteresis), HP last seen, white
   * until, and the crash cued / landed. */
  private readonly lodNear = new Map<number, boolean>();
  private readonly lastHp = new Map<number, number>();
  private readonly flashUntil = new Map<number, number>();
  private readonly downCued = new Set<number>();
  private readonly landedFor = new Set<number>();
  /** Particle accumulators per ship id: [trail fire, trail smoke, hurt]. */
  private readonly acc = new Map<number, Float64Array>();
  private readonly burns: Burn[] = [];
  private lastFrameMs = Number.NaN;
  private shellCount = 0;
  private lightCount = 0;
  private falling = 0;
  private rigPlanes = 0;
  private readonly cuedStart = new Set<number>();
  private readonly cuedRelease = new Set<number>();
  private planeTop = 1.6;
  private cues: BossCues = {};
  /** The SPOT_SHIPS intact ships nearest the camera this frame (slot
   * indices, −1 none), and their distances. */
  private readonly spotIdx = new Int32Array(SPOT_SHIPS);
  private readonly spotDist = new Float64Array(SPOT_SHIPS);
  /** The nearest intact ship's centre (the drone's source), or none. */
  private readonly drone: Vec3 = { x: 0, y: 0, z: 0 };
  private hasDrone = false;

  constructor(
    private readonly impacts: Impacts,
    /** A crash hit the city at `at` (main: blast, sound, shake). */
    private readonly onLand: (at: Vec3) => void,
    /** A flak shell burst at `at` (main: crack, near-miss radio). */
    private readonly onBurst: (at: Vec3, f: BossFlak) => void,
  ) {
    const plane = this.planeGeometry();
    this.rests = boneRests();
    const rest = (b: number) => {
      const r = this.rests[b] as BoneRest;
      return new THREE.Vector3(r.x, r.y, r.z);
    };
    const crest = drawCrest();
    this.hullU = {
      uTime: { value: 0 },
      uWeakGlow: { value: WEAK_COLOR.clone().multiplyScalar(WEAK_BOOST) },
      uWeakFlash: { value: WHITE.clone().multiplyScalar(WEAK_BOOST) },
      uWeakPos: {
        value: BOSS_WEAK_POINTS.map((i) => {
          const p = P(i);
          return new THREE.Vector3(p.x, p.y, p.z);
        }),
      },
      uWindow: {
        value: WINDOW_COLOR.clone().multiplyScalar(WINDOW_BOOST),
      },
      uEmber: {
        value: new THREE.Color(0xff5a14).multiplyScalar(
          emissiveBoost(new THREE.Color(0xff5a14), EMISSIVE_HAZARD) * 0.8,
        ),
      },
      uCrest: { value: crest },
      uHasCrest: { value: crest ? 1 : 0 },
      uProp: { value: [0, 1, 2, 3].map((e) => rest(BONE_PROP + e)) },
      uTrapeze: { value: rest(BONE_TRAPEZE) },
      uRestBelly: { value: rest(BONE_PLANE_BELLY) },
      uRestDeck: { value: rest(BONE_PLANE_DECK) },
    };
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.6,
      metalness: 0.4,
    });
    hullMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.hullU);
      shader.vertexShader = (HULL_VERT_HEAD + shader.vertexShader)
        .replace("#include <beginnormal_vertex>", HULL_NORMAL_BODY)
        .replace("#include <begin_vertex>", HULL_VERT_BODY);
      shader.fragmentShader = (HULL_FRAG_HEAD + shader.fragmentShader)
        .replace("#include <color_fragment>", HULL_FRAG_SURFACE)
        .replace(
          "#include <roughnessmap_fragment>",
          // L6: specular antialiasing — the lathe is faceted round its axis,
          // so a glossy lobe would crawl from facet to facet in flight. The
          // screen-space spread of the normal raises the roughness where
          // one pixel spans a lot of curvature (far away, grazing).
          "#include <roughnessmap_fragment>\nroughnessFactor = max(bRough, min(0.7, length(fwidth(vNormal)) * 1.6));",
        )
        .replace(
          "#include <metalnessmap_fragment>",
          "#include <metalnessmap_fragment>\nmetalnessFactor = bMetal;",
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>\ntotalEmissiveRadiance += bEmis;\n${HULL_SHEEN}`,
        )
        .replace(HULL_OUTGOING, HULL_OUTGOING_CAPPED);
    };
    hullMat.customProgramCacheKey = () => "z1-fleet-hull";
    this.near = this.hullDraw(buildShipHull("full", plane).geometry, hullMat);
    this.far = this.hullDraw(buildShipHull("lite", plane).geometry, hullMat);

    const lightGeo = new THREE.BufferGeometry();
    this.lightPos = new THREE.BufferAttribute(
      new Float32Array(LIGHT_POOL * 3).fill(PARKED_Y),
      3,
    );
    this.lightCol = new THREE.BufferAttribute(
      new Float32Array(LIGHT_POOL * 3),
      3,
    );
    lightGeo.setAttribute("position", this.lightPos);
    lightGeo.setAttribute("color", this.lightCol);
    this.lights = new THREE.Points(
      lightGeo,
      new THREE.PointsMaterial({
        size: NAV_SIZE_PX,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.lights.frustumCulled = false;

    const shellGeo = new THREE.BufferGeometry();
    this.shellPos = new THREE.BufferAttribute(
      new Float32Array(SHELL_POOL * 3).fill(PARKED_Y),
      3,
    );
    shellGeo.setAttribute("position", this.shellPos);
    this.shells = new THREE.Points(
      shellGeo,
      new THREE.PointsMaterial({
        color: SHELL_COLOR.clone().multiplyScalar(SHELL_BOOST),
        size: SHELL_SIZE_PX,
        sizeAttenuation: false,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.shells.frustumCulled = false;

    this.group.add(this.near.mesh, this.far.mesh, this.lights, this.shells);
    // Hidden until a fleet: the boot pre-warm shows (and so compiles) it.
    this.group.visible = false;
  }

  private hullDraw(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
  ): HullDraw {
    const mesh = new THREE.InstancedMesh(geometry, material, FLEET_DRAW_CAP);
    const vec4 = () => {
      const a = new THREE.InstancedBufferAttribute(
        new Float32Array(FLEET_DRAW_CAP * 4),
        4,
      );
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const state = vec4();
    const rigA = vec4();
    const rigB = vec4();
    geometry.setAttribute("aState", state);
    geometry.setAttribute("aRigA", rigA);
    geometry.setAttribute("aRigB", rigB);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Instances span the torus image round the camera: a bound cached from
    // any one frame would cull ships it no longer covers.
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    return {
      mesh,
      matrix: mesh.instanceMatrix.array as Float32Array,
      state,
      rigA,
      rigB,
      count: 0,
    };
  }

  /** The launch planes: the enemies' own airframe (DT1, fighter.ts — its
   * mid level), colours baked, turned nose +X. Null without a DOM. */
  private planeGeometry(): PlaneGeo | null {
    if (typeof document === "undefined") return null;
    return planeGeoFromFighter((top) => {
      this.planeTop = top;
    });
  }

  /** Share of the full particle dressing this tier keeps (quality bossFx). */
  setQuality(share: number): void {
    this.share = share;
  }

  /** The launch / down audio cues (main). */
  setCues(cues: BossCues): void {
    this.cues = cues;
  }

  /**
   * Per frame. `renderMs` is the render clock (null: no clock yet — nothing
   * drawn, nothing solid). `hp` is each ship's HP by id; `flak` the shells
   * in the air, each removed once it has burst.
   */
  update(
    slot: FleetSlot,
    hp: ReadonlyMap<number, number>,
    flak: Map<number, BossFlak>,
    viewer: Vec3,
    renderMs: number | null,
    now: number,
  ): void {
    const dt = Number.isNaN(this.lastFrameMs)
      ? 0
      : Math.min(0.1, (now - this.lastFrameMs) / 1000);
    this.lastFrameMs = now;
    // L6: no beams unless an intact hull near the camera carries them.
    this.spotCount = 0;
    this.hasDrone = false;
    this.updateBurns(now, dt);
    this.hullU.uTime.value = (now % 600_000) / 1000;
    if (renderMs === null) {
      this.group.visible = false;
      return;
    }
    // The weak points' slow, shared throb.
    this.hullU.uWeakGlow.value
      .copy(WEAK_COLOR)
      .multiplyScalar(WEAK_BOOST * (0.78 + 0.22 * Math.sin(now / 260)));
    this.near.count = 0;
    this.far.count = 0;
    this.lightCount = 0;
    this.falling = 0;
    this.rigPlanes = 0;
    this.spotIdx.fill(-1);
    this.spotDist.fill(Number.POSITIVE_INFINITY);
    const ships = slot.ships;
    const strobeOn = now % STROBE_PERIOD_MS < STROBE_ON_MS;
    let droneD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i] as FleetShip;
      if (renderMs < s.t0) continue;
      const d = s.down;
      if (d !== null && renderMs >= d.t + d.end) {
        this.land(s, now);
        continue;
      }
      const cls = (FLEET_LANES[s.lane] as { cls: number }).cls;
      fleetPoseInto64(s, renderMs, this.p64, 0);
      const p = this.p64;
      const dx = wrapDeltaAxis(p[0] as number, viewer.x);
      const dy = viewer.y - (p[1] as number);
      const dz = wrapDeltaAxis(p[2] as number, viewer.z);
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Level of detail, with hysteresis: never flips on the boundary.
      let near = this.lodNear.get(s.id) ?? dist < FLEET_LOD_M;
      if (near && dist > FLEET_LOD_M + 30) near = false;
      else if (!near && dist < FLEET_LOD_M - 30) near = true;
      if (near !== this.lodNear.get(s.id)) this.lodNear.set(s.id, near);
      const draw = near ? this.near : this.far;
      if (draw.count >= FLEET_DRAW_CAP) continue;
      const k = draw.count++;
      shipMatrixInto(p, 0, cls, viewer, draw.matrix, k * 16);
      const falling = d !== null && renderMs >= d.t;
      // Damage, flash, seed, flags.
      const full = s.hp0;
      const left = falling ? 0 : (hp.get(s.id) ?? full);
      const last = this.lastHp.get(s.id);
      if (last !== undefined && left < last) {
        this.flashUntil.set(s.id, now + HIT_FLASH_MS);
      }
      if (last !== left) this.lastHp.set(s.id, left);
      const flash = now < (this.flashUntil.get(s.id) ?? 0) ? 1 : 0;
      const st = draw.state.array as Float32Array;
      st[k * 4] = falling ? 1 : 1 - left / full;
      st[k * 4 + 1] = flash;
      st[k * 4 + 2] = (((s.id * 0.618034) % 1) + 1) % 1;
      let flags = falling ? 1 : 0;
      if (!falling)
        flags += this.poseRigs(s, cls, slot.launches, renderMs, draw, k);
      else this.clearRigs(draw, k);
      st[k * 4 + 3] = flags;
      if (falling) {
        this.falling++;
        this.crashFx(s, now, dt);
      } else {
        this.hurtFx(s, cls, left / full, now, dt);
        this.placeNav(
          cls,
          viewer,
          near ? NAV_LIGHTS.length : NAV_FAR,
          strobeOn,
        );
        // The nearest intact ships carry the lamps (and the drone's voice).
        if (dist < droneD) {
          droneD = dist;
          this.drone.x = p[0] as number;
          this.drone.y = p[1] as number;
          this.drone.z = p[2] as number;
          this.hasDrone = true;
        }
        if (dist < SPOT_RANGE_M) this.rankSpot(i, dist);
      }
    }
    this.exportSpots(slot, viewer, renderMs, now);
    this.updateFlak(flak, viewer, renderMs, now);
    for (const draw of [this.near, this.far]) {
      draw.mesh.count = draw.count;
      draw.mesh.visible = draw.count > 0;
      if (draw.count > 0) {
        draw.mesh.instanceMatrix.needsUpdate = true;
        draw.state.needsUpdate = true;
        draw.rigA.needsUpdate = true;
        draw.rigB.needsUpdate = true;
      }
    }
    const pos = this.lightPos.array as Float32Array;
    for (let n = this.lightCount; n < LIGHT_POOL; n++) {
      if (pos[n * 3 + 1] === PARKED_Y) break;
      pos[n * 3 + 1] = PARKED_Y;
    }
    this.lightPos.needsUpdate = true;
    this.lightCol.needsUpdate = true;
    this.lights.visible = this.lightCount > 0;
    this.group.visible =
      this.near.count > 0 || this.far.count > 0 || this.shellCount > 0;
  }

  /** A crash that hit: its city blast and burn, once. */
  private land(s: FleetShip, now: number): void {
    if (this.landedFor.has(s.id)) return;
    this.landedFor.add(s.id);
    if (this.landedFor.size > 256) this.landedFor.clear();
    const at = (s.down as { at: Vec3 }).at;
    this.burns.push({ at, since: now, fireAcc: 0, smokeAcc: 0 });
    this.onLand(at);
  }

  /** The ship's launch rigs on the render clock (the newest launch on each
   * rig): the bay doors and the trapeze, the catapult carriage, and the
   * plane each one holds until it lets go — at the release the bot itself
   * appears there (launchSpawnAt is this same pose). Cues fire once each.
   * Returns the flags for the planes it shows. */
  private poseRigs(
    s: FleetShip,
    cls: number,
    launches: readonly BossLaunch[],
    renderMs: number,
    draw: HullDraw,
    k: number,
  ): number {
    const c = SHIP_CLASSES[cls] as ShipClass;
    const a = draw.rigA.array as Float32Array;
    const b = draw.rigB.array as Float32Array;
    const restCarriage = (this.rests[BONE_CARRIAGE] as BoneRest).x;
    const street = laneStreet(s.lane);
    let belly: BossLaunch | null = null;
    let deck: BossLaunch | null = null;
    for (let i = 0; i < launches.length; i++) {
      const l = launches[i] as BossLaunch;
      if (l.ship !== s.id || l.t0 > renderMs) continue;
      if (renderMs >= launchDoneAt(l)) continue;
      if (l.kind === LAUNCH_BELLY) belly = l;
      else deck = l;
      this.cue(l, cls, renderMs, street);
    }
    let flags = 0;
    // Belly: the doors slide outboard, the trapeze lowers the plane.
    a[k * 4] = (this.rests[BONE_PLANE_BELLY] as BoneRest).y;
    a[k * 4 + 1] = 0;
    a[k * 4 + 2] = 0;
    a[k * 4 + 3] = 0.05;
    if (belly) {
      const sec = (renderMs - belly.t0) / 1000;
      const rel = (LAUNCH_SEQ_MS[belly.kind] as number) / 1000;
      const after =
        sec >= rel ? smooth((sec - rel) / (LAUNCH_RESET_MS / 1000)) : 0;
      a[k * 4 + 2] =
        sec < rel ? smooth(sec / 0.6) : 1 - smooth((sec - rel - 0.2) / 0.7);
      launchLocalAt(
        belly,
        cls as 0 | 1 | 2,
        Math.min(renderMs, launchReleaseAt(belly)),
        this.local,
        street,
      );
      const y = this.local.y / c.sr;
      if (sec < rel) {
        a[k * 4] = y;
        a[k * 4 + 1] = this.local.pitch;
        a[k * 4 + 3] = Math.max(0.05, KEEL_BOTTOM - (y + this.planeTop / c.sr));
        flags += 2;
        this.rigPlanes++;
      } else {
        a[k * 4 + 3] = Math.max(0.05, (BAY_STOW_Y - y) * (1 - after));
      }
    }
    // Deck: the carriage's run along the rail.
    b[k * 4] = 0;
    b[k * 4 + 1] = (this.rests[BONE_PLANE_DECK] as BoneRest).x;
    b[k * 4 + 2] = (this.rests[BONE_PLANE_DECK] as BoneRest).y;
    b[k * 4 + 3] = 0;
    if (deck) {
      const sec = (renderMs - deck.t0) / 1000;
      const rel = (LAUNCH_SEQ_MS[deck.kind] as number) / 1000;
      launchLocalAt(
        deck,
        cls as 0 | 1 | 2,
        Math.min(renderMs, launchReleaseAt(deck)),
        this.local,
      );
      const x = this.local.x / c.sx;
      if (sec < rel) {
        b[k * 4] = x - restCarriage;
        b[k * 4 + 1] = x;
        b[k * 4 + 2] = this.local.y / c.sr;
        b[k * 4 + 3] = this.local.pitch;
        flags += 4;
        this.rigPlanes++;
      } else {
        const after = smooth((sec - rel) / (LAUNCH_RESET_MS / 1000));
        b[k * 4] = (x - restCarriage) * (1 - after);
      }
    }
    return flags;
  }

  private clearRigs(draw: HullDraw, k: number): void {
    const a = draw.rigA.array as Float32Array;
    const b = draw.rigB.array as Float32Array;
    a[k * 4] = (this.rests[BONE_PLANE_BELLY] as BoneRest).y;
    a[k * 4 + 1] = 0;
    a[k * 4 + 2] = 0;
    a[k * 4 + 3] = 0.05;
    b[k * 4] = 0;
    b[k * 4 + 1] = (this.rests[BONE_PLANE_DECK] as BoneRest).x;
    b[k * 4 + 2] = (this.rests[BONE_PLANE_DECK] as BoneRest).y;
    b[k * 4 + 3] = 0;
  }

  /** A launch's start and release cues, once each, at the plane's place. */
  private cue(
    l: BossLaunch,
    cls: number,
    renderMs: number,
    street: boolean,
  ): void {
    const startCue = !this.cuedStart.has(l.id);
    const releaseCue =
      !this.cuedRelease.has(l.id) && renderMs >= launchReleaseAt(l);
    if (!startCue && !releaseCue) return;
    launchLocalAt(l, cls as 0 | 1 | 2, renderMs, this.local, street);
    this.shipPoint(this.local.x, this.local.y, this.local.z, this.at);
    if (startCue) {
      this.cuedStart.add(l.id);
      if (this.cuedStart.size > 64) this.cuedStart.clear();
      this.cues.launchStart?.(l, this.at);
    }
    if (releaseCue) {
      this.cuedRelease.add(l.id);
      if (this.cuedRelease.size > 64) this.cuedRelease.clear();
      this.cues.launchRelease?.(l, this.at);
    }
  }

  /** A ship-frame point (scaled metres) of the ship posed in `p64`,
   * canonical. */
  private shipPoint(lx: number, ly: number, lz: number, out: Vec3): Vec3 {
    const p = this.p64;
    const cp = Math.cos(p[4] as number);
    const sp = Math.sin(p[4] as number);
    const ax = cp * lx - sp * ly;
    const ay = sp * lx + cp * ly;
    const c = Math.cos(p[3] as number);
    const s = Math.sin(p[3] as number);
    out.x = (p[0] as number) + c * ax + s * lz;
    out.y = (p[1] as number) + ay;
    out.z = (p[2] as number) - s * ax + c * lz;
    return out;
  }

  /** The first `count` running lights of a class `cls` ship posed in
   * `p64`, on the viewer's torus image, straight into the typed arrays. */
  private placeNav(
    cls: number,
    viewer: Vec3,
    count: number,
    strobeOn: boolean,
  ): void {
    const c = SHIP_CLASSES[cls] as ShipClass;
    const p = this.p64;
    const cy = Math.cos(p[3] as number);
    const sy = Math.sin(p[3] as number);
    const ox = viewer.x + wrapDeltaAxis(viewer.x, p[0] as number);
    const oy = p[1] as number;
    const oz = viewer.z + wrapDeltaAxis(viewer.z, p[2] as number);
    const pos = this.lightPos.array as Float32Array;
    const col = this.lightCol.array as Float32Array;
    for (let j = 0; j < count; j++) {
      const n = this.lightCount;
      if (n >= LIGHT_POOL) return;
      const l = NAV_LIGHTS[j] as NavLight;
      const lx = l.x * c.sx;
      const lz = l.z * c.sr;
      pos[n * 3] = ox + cy * lx + sy * lz;
      pos[n * 3 + 1] = oy + l.y * c.sr;
      pos[n * 3 + 2] = oz - sy * lx + cy * lz;
      const on = !l.strobe || strobeOn ? 1 : 0;
      col[n * 3] = (NAV_RGB[j * 3] as number) * on;
      col[n * 3 + 1] = (NAV_RGB[j * 3 + 1] as number) * on;
      col[n * 3 + 2] = (NAV_RGB[j * 3 + 2] as number) * on;
      this.lightCount = n + 1;
    }
  }

  /** One more point light (canonical `at`, on the viewer's image). */
  private point(at: Vec3, viewer: Vec3, r: number, g: number, b: number): void {
    const n = this.lightCount;
    if (n >= LIGHT_POOL) return;
    const pos = this.lightPos.array as Float32Array;
    const col = this.lightCol.array as Float32Array;
    pos[n * 3] = viewer.x + wrapDeltaAxis(viewer.x, at.x);
    pos[n * 3 + 1] = at.y;
    pos[n * 3 + 2] = viewer.z + wrapDeltaAxis(viewer.z, at.z);
    col[n * 3] = r;
    col[n * 3 + 1] = g;
    col[n * 3 + 2] = b;
    this.lightCount = n + 1;
  }

  /** Keep the SPOT_SHIPS nearest intact ships (insertion into a sorted
   * three). */
  private rankSpot(i: number, dist: number): void {
    for (let j = 0; j < SPOT_SHIPS; j++) {
      if (dist < (this.spotDist[j] as number)) {
        for (let m = SPOT_SHIPS - 1; m > j; m--) {
          this.spotDist[m] = this.spotDist[m - 1] as number;
          this.spotIdx[m] = this.spotIdx[m - 1] as number;
        }
        this.spotDist[j] = dist;
        this.spotIdx[j] = i;
        return;
      }
    }
  }

  /** L6/Z1: this frame's beams — two control-car lamps on each of the
   * ships nearest the camera, each scything slowly round its own bearing,
   * leaning 0.3–0.7 rad off the vertical, so the cones rake the roofs under
   * the hull. Into the pooled `spots` (rendered coordinates on the viewer's
   * torus image); lengths are main's to set (beam-landing.ts). The lenses
   * glow on the lights' draw. */
  private exportSpots(
    slot: FleetSlot,
    viewer: Vec3,
    renderMs: number,
    now: number,
  ): void {
    let n = 0;
    for (let j = 0; j < SPOT_SHIPS; j++) {
      const i = this.spotIdx[j] as number;
      if (i < 0) break;
      const s = slot.ships[i] as FleetShip;
      const cls = (FLEET_LANES[s.lane] as { cls: number }).cls;
      const c = SHIP_CLASSES[cls] as ShipClass;
      fleetPoseInto64(s, renderMs, this.p64, 0);
      const yaw = this.p64[3] as number;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      for (let k = 0; k < SPOT_LAMPS && n < BOSS_SPOTS; k++) {
        const l = LAMP_AT[k] as { x: number; y: number; z: number };
        this.shipPoint(
          l.x * c.sx,
          (l.y - LAMP_LENS_DROP) * c.sr,
          l.z * c.sr,
          this.at,
        );
        const ph = s.id * 1.7 + k * 2.1;
        // K1: down an avenue the lamps swing abeam and nearly level, so the
        // cones sweep the facades either side of the street; over the
        // rooftops they rake the roofs under the hull. T1: an orbit or a
        // berth sweeps its tower's facades the same way.
        const street = laneStreet(s.lane) || lanePath(s.lane) !== PATH_LINE;
        const az =
          (street ? LAMP_STREET_BEARING : (LAMP_BEARING[k] as number)) *
            (street ? (k === 0 ? -1 : 1) : 1) +
          0.5 * Math.sin(now / 3700 + ph);
        const tilt =
          (street ? LAMP_STREET_TILT : 0.5) +
          0.2 * Math.sin(now / 2900 + ph * 0.6);
        // Ship frame: down, tipped out by `tilt` toward bearing `az`.
        const hx = Math.sin(tilt) * Math.cos(az);
        const hy = -Math.cos(tilt);
        const hz = -Math.sin(tilt) * Math.sin(az);
        const spot = this.spots[n] as SpotBeam;
        spot.x = viewer.x + wrapDeltaAxis(viewer.x, this.at.x);
        spot.y = this.at.y;
        spot.z = viewer.z + wrapDeltaAxis(viewer.z, this.at.z);
        const ax = cy * hx + sy * hz;
        const az2 = -sy * hx + cy * hz;
        spot.ax = ax;
        spot.az = az2;
        const aim = spot.aim as Vec3;
        aim.x = ax;
        aim.y = hy;
        aim.z = az2;
        spot.tint = CARRIER_BEAM_COLOR;
        spot.head = false;
        // Numbers only, never undefined: a field that flips between the
        // two boxes every double stored in it (S8's allocation table).
        // Length 0 is "not landed yet" — beam-landing.ts sets the throw.
        spot.radius = 0;
        spot.length = 0;
        spot.reach = 1;
        this.spotSpread[n] = CARRIER_BEAM_SPREAD;
        this.point(this.at, viewer, LAMP_RGB.r, LAMP_RGB.g, LAMP_RGB.b);
        n++;
      }
    }
    this.spotCount = n;
  }

  /** L6: the fleet's beams this frame — `spots[0 .. spotCount)`, each with
   * a unit `aim`; beam-landing.ts sets its length, radius (from
   * `spotSpread`, radius per metre of throw) and reach. None when no intact
   * hull is near. */
  readonly spots: SpotBeam[] = Array.from({ length: BOSS_SPOTS }, (_, i) => ({
    x: 0,
    y: 0,
    z: 0,
    ax: 1,
    az: 0,
    phase: i,
    aim: { x: 0, y: -1, z: 0 },
    length: 0,
    radius: 0,
    reach: 1,
    tint: CARRIER_BEAM_COLOR,
    head: false,
  }));
  spotCount = 0;
  readonly spotSpread: number[] = Array.from({ length: BOSS_SPOTS }, () => 0);

  /** Per-ship particle accumulators (made once per ship id). */
  private accOf(id: number): Float64Array {
    let a = this.acc.get(id);
    if (!a) {
      a = new Float64Array(3);
      this.acc.set(id, a);
      if (this.acc.size > 128) {
        for (const key of this.acc.keys()) {
          if (key !== id) this.acc.delete(key);
          if (this.acc.size <= 64) break;
        }
      }
    }
    return a;
  }

  /** A hurt ship's engines smoke, harder as it nears zero. */
  private hurtFx(
    s: FleetShip,
    cls: number,
    frac: number,
    now: number,
    dt: number,
  ): void {
    if (dt <= 0 || frac >= HURT_AT) return;
    const a = this.accOf(s.id);
    const rate = HURT_SMOKE * (1 - frac / HURT_AT) * this.share;
    const acc = (a[2] as number) + rate * dt;
    const n = Math.floor(acc);
    a[2] = acc - n;
    if (n <= 0) return;
    const c = SHIP_CLASSES[cls] as ShipClass;
    const e = P(10 + (Math.floor(now / 700) % 4));
    this.shipPoint(e.x * c.sx, (e.y + 2) * c.sr, e.z * c.sr, this.at);
    this.impacts.wreckFire(this.at, frac < 0.25 ? 1 : 0, n, 3, now);
  }

  /** Fire and smoke pour off a crashing hull; the blast as it starts. */
  private crashFx(s: FleetShip, now: number, dt: number): void {
    const p = this.p64;
    this.at.x = p[0] as number;
    this.at.y = p[1] as number;
    this.at.z = p[2] as number;
    if (!this.downCued.has(s.id)) {
      this.downCued.add(s.id);
      if (this.downCued.size > 256) this.downCued.clear();
      this.cues.downed?.(this.at);
    }
    if (dt <= 0) return;
    const a = this.accOf(s.id);
    const nf = (a[0] as number) + TRAIL_FIRE * this.share * dt;
    const ns = (a[1] as number) + TRAIL_SMOKE * this.share * dt;
    this.impacts.wreckFire(this.at, Math.floor(nf), Math.floor(ns), 18, now);
    a[0] = nf - Math.floor(nf);
    a[1] = ns - Math.floor(ns);
  }

  /** Shell heads in flight, and a muzzle flash as each leaves; each burst
   * once, then dropped from `flak`. S8: walked by one pre-bound callback —
   * a `for…of` over the Map built an iterator and an entry array per shell,
   * every frame. */
  private updateFlak(
    flak: Map<number, BossFlak>,
    viewer: Vec3,
    renderMs: number,
    now: number,
  ): void {
    const w = this.flakWalk;
    w.flak = flak;
    w.viewer = viewer;
    w.renderMs = renderMs;
    w.now = now;
    w.n = 0;
    flak.forEach(this.placeShell);
    const n = w.n;
    const pos = this.shellPos.array as Float32Array;
    for (let i = n; i < SHELL_POOL; i++) pos[i * 3 + 1] = PARKED_Y;
    this.shellPos.needsUpdate = true;
    this.shells.visible = n > 0;
    this.shellCount = n;
  }

  /** updateFlak's frame, for placeShell. */
  private readonly flakWalk: {
    flak: Map<number, BossFlak> | null;
    viewer: Vec3;
    renderMs: number;
    now: number;
    n: number;
  } = {
    flak: null,
    viewer: { x: 0, y: 0, z: 0 },
    renderMs: 0,
    now: 0,
    n: 0,
  };

  private readonly placeShell = (f: BossFlak, id: number): void => {
    const w = this.flakWalk;
    if (w.renderMs >= f.t0 + f.fuse) {
      w.flak?.delete(id);
      const share = this.share;
      this.impacts.wreckFire(
        f.to,
        Math.max(1, Math.round(BURST_FIRE * share)),
        Math.max(1, Math.round(BURST_SMOKE * share)),
        4,
        w.now,
      );
      this.onBurst(f.to, f);
      return;
    }
    if (w.renderMs < f.t0) return;
    if (w.renderMs - f.t0 < FLASH_MS) {
      const k = 1 - (w.renderMs - f.t0) / FLASH_MS;
      this.point(
        f.from,
        w.viewer,
        LAMP_RGB.r * k,
        LAMP_RGB.g * k,
        LAMP_RGB.b * k,
      );
    }
    if (w.n >= SHELL_POOL) return;
    flakPosAt(f, w.renderMs, this.at);
    const pos = this.shellPos.array as Float32Array;
    pos[w.n * 3] = w.viewer.x + wrapDeltaAxis(w.viewer.x, this.at.x);
    pos[w.n * 3 + 1] = this.at.y;
    pos[w.n * 3 + 2] = w.viewer.z + wrapDeltaAxis(w.viewer.z, this.at.z);
    w.n++;
  };

  /** Landed crashes keep burning, tapering to nothing over BURN_MS. */
  private updateBurns(now: number, dt: number): void {
    for (let i = this.burns.length - 1; i >= 0; i--) {
      const b = this.burns[i] as Burn;
      const left = 1 - (now - b.since) / BURN_MS;
      if (left <= 0) {
        this.burns.splice(i, 1);
        continue;
      }
      b.fireAcc += BURN_FIRE * this.share * left * dt;
      b.smokeAcc += BURN_SMOKE * this.share * left * dt;
      const f = Math.floor(b.fireAcc);
      const s = Math.floor(b.smokeAcc);
      if (f > 0 || s > 0) this.impacts.wreckFire(b.at, f, s, 26, now);
      b.fireAcc -= f;
      b.smokeAcc -= s;
    }
  }

  /** The nearest intact ship's centre this frame, canonical (main: the
   * engine drone's source), or null when none is up. */
  dronePos(): Vec3 | null {
    return this.group.visible && this.hasDrone ? this.drone : null;
  }

  /** QA: what is drawn this frame — ships at each detail, the falling ones,
   * the shells, the lights, the planes on the rigs, and the draws in all
   * (≤ 4: two hull draws, the lights, the shells). */
  get stats(): {
    ships: number;
    near: number;
    far: number;
    falling: number;
    shells: number;
    lights: number;
    rigPlanes: number;
    draws: number;
    lod: "full" | "lite" | "none";
  } {
    const on = this.group.visible;
    const near = on ? this.near.count : 0;
    const far = on ? this.far.count : 0;
    const shells = on && this.shells.visible ? this.shellCount : 0;
    const lights = on && this.lights.visible ? this.lightCount : 0;
    return {
      ships: near + far,
      near,
      far,
      falling: on ? this.falling : 0,
      shells,
      lights,
      rigPlanes: on ? this.rigPlanes : 0,
      draws:
        (near > 0 ? 1 : 0) +
        (far > 0 ? 1 : 0) +
        (lights > 0 ? 1 : 0) +
        (shells > 0 ? 1 : 0),
      lod: near > 0 ? "full" : far > 0 ? "lite" : "none",
    };
  }
}

/** Every object the renderer can draw (the QA draw-budget test). */
export const FLEET_DRAWS = 4;

/** DT1: the enemies' airframe for the launch rigs: fighter.ts's mid level
 * (hinged parts and prop folded in at rest), nose turned from +Z to +X,
 * origin at the plane's centre with its wheels DECK_PLANE_H (1.6 m) under
 * it, split into one part per (quantised) baked colour — the hull's
 * accumulator takes one colour a part. `top` gets the hook's height over
 * the centre. */
function planeGeoFromFighter(top: (h: number) => void): PlaneGeo | null {
  const parts: { geometry: THREE.BufferGeometry; color: number }[] = [];
  try {
    const src = fighterGeometry()
      .mid.clone()
      .applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
    src.computeBoundingBox();
    const box = src.boundingBox ?? new THREE.Box3();
    const lift = -1.6 - box.min.y;
    src.translate(0, lift, 0);
    top(box.max.y + lift);
    const pos = src.getAttribute("position") as THREE.BufferAttribute;
    const nrm = src.getAttribute("normal") as THREE.BufferAttribute;
    const col = src.getAttribute("color") as THREE.BufferAttribute;
    const buckets = new Map<number, { p: number[]; n: number[] }>();
    const c = new THREE.Color();
    const q = (v: number) => Math.round(v * 24) / 24;
    for (let t = 0; t < pos.count; t += 3) {
      // A triangle takes its first vertex's colour, quantised (the camo's
      // soft demarcation would otherwise make a part per triangle).
      c.setRGB(q(col.getX(t)), q(col.getY(t)), q(col.getZ(t)));
      const hex = c.getHex();
      let b = buckets.get(hex);
      if (!b) {
        b = { p: [], n: [] };
        buckets.set(hex, b);
      }
      for (let v = t; v < t + 3; v++) {
        b.p.push(pos.getX(v), pos.getY(v), pos.getZ(v));
        b.n.push(nrm.getX(v), nrm.getY(v), nrm.getZ(v));
      }
    }
    src.dispose();
    for (const [hex, b] of buckets) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(b.p, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(b.n, 3));
      parts.push({ geometry: g, color: hex });
    }
  } catch {
    return null;
  }
  return { parts };
}
