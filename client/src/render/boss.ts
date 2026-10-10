// S4 sky boss, THREE half — S9: the dieselpunk war-zeppelin carrier. Its
// hull, its flak and its fall, drawn from the room's boss slot
// (common/src/boss.ts) on the synced RENDER clock — the clock the crash
// check and the movers use, so the hull you see is the hull you hit.
//
// Draw == collide: the solid geometry (boss-hull.ts) is lathed and built
// from the shared part table collideBoss tests; every rigid body — the three
// sections, the props, rudders and elevators, the turret heads and guns, the
// bay doors, the trapeze, the catapult carriage, the deck crew, the
// searchlights and the two planes on the launch rigs — is a bone of ONE
// skeleton, posed here each frame from pure functions of the clock. So the
// whole carrier, intact or in three falling sections, is ONE skinned draw
// (two geometries for the distance LOD, one shown), its additive glow —
// searchlight beams, exhaust heat, muzzle flashes, catapult steam and
// sparks — a second on the same skeleton, the running lights a Points draw
// and the flak shell heads another: four draws, as S4's boxes were. Flak
// bursts, gas venting, the fire spreading along a dying hull and the
// falling sections' fire and smoke ride the D1 particle pool (fixed ring, no
// new draw), scaled by the tier's `bossFx` share. Nothing is allocated per
// frame.
//
// Visibility parity (quality.ts rule 2): the hull and everything on it, the
// lights and the shells — solid things and the flak's telegraph — are the
// same on every tier. Only the particle dressing scales.
//
// The skin shader paints the LZ 129's structure onto the lathed polygon:
// 36 longitudinal girders at the polygon's corners, main and intermediate
// ring frames, doped panels with seams and weathering, exhaust soot aft of
// the engine cars, scorch, the lit promenade windows along the belly and the
// carrier's FICTIONAL faction crest — a winged cog — and name. No real
// historical insignia. Every line is antialiased against its own
// derivative and fades out before it can alias; the only hashed inputs are
// floored cells of continuous hull coordinates (concepts/traps/
// interpolated-hash-inputs.md).

import {
  BOSS_PARTS,
  BOSS_PIECES,
  BOSS_TURRETS,
  BOSS_WEAK_POINTS,
  type BossFlak,
  type BossLaunch,
  type BossPart,
  type BossPiece,
  type BossRaid,
  type BossSlot,
  LAUNCH_BELLY,
  type LaunchLocal,
  type LaunchRig,
  blankPose,
  bossPoseAt,
  bossPresent,
  flakPosAt,
  launchDoneAt,
  launchLocalAt,
  launchReleaseAt,
  launchRigAt,
  piecePoseAt,
} from "@angels-bandits/common/boss";
import type { MoverBox } from "@angels-bandits/common/city/movers";
import {
  EMISSIVE_BEACON,
  EMISSIVE_EXHAUST,
  EMISSIVE_HAZARD,
  EMISSIVE_LAMP,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_STROBE,
  EMISSIVE_WINDOW,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { biplaneSources } from "./biplane";
import {
  BONE_CARRIAGE,
  BONE_COUNT,
  BONE_CREW,
  BONE_DOOR_P,
  BONE_DOOR_S,
  BONE_ELEV_P,
  BONE_ELEV_S,
  BONE_GUN,
  BONE_LAMP,
  BONE_PLANE_BELLY,
  BONE_PLANE_DECK,
  BONE_PROP,
  BONE_RUDDER_D,
  BONE_RUDDER_V,
  BONE_TRAPEZE,
  BONE_TURRET,
  type BoneRest,
  CREW,
  CREW_X0,
  CREW_X1,
  KEEL_BOTTOM,
  LAMPS,
  type PlaneGeo,
  boneRests,
  buildBossGlow,
  buildBossHull,
  crewRestX,
} from "./boss-hull";
import { emissiveBoost } from "./emissive";
import type { Impacts } from "./impacts";
import { nearestImageInto } from "./wrapPlacement";

/** The weak points' glow (hazard rung — under tracers, over windows), the
 * white of a fresh hit, and a spent one's char. */
export const WEAK_COLOR = new THREE.Color(0xff5a1f);
const WEAK_BOOST = emissiveBoost(WEAK_COLOR, EMISSIVE_HAZARD);
const HIT_FLASH_MS = 110;
const SPENT = new THREE.Color(0x120c09);
/** Flak shell heads: hot red-orange on the beacon rung (tracers stay the
 * brightest thing in a fight). */
export const SHELL_COLOR = new THREE.Color(0xff6a3a);
const SHELL_BOOST = emissiveBoost(SHELL_COLOR, EMISSIVE_BEACON);
const SHELL_SIZE_PX = 6;
/** Most shells drawn at once (6 turrets × a ~2 s flight / 1.8 s cadence). */
export const SHELL_POOL = 24;
/** Lit windows (the control car, the promenade): warm, on the window rung. */
export const WINDOW_COLOR = new THREE.Color(0xffb866);
const WINDOW_BOOST = emissiveBoost(WINDOW_COLOR, EMISSIVE_WINDOW);
/** Engine heat and the catapult's sparks: the exhaust rung. */
export const HEAT_COLOR = new THREE.Color(0xff7a2a);
const HEAT_BOOST = emissiveBoost(HEAT_COLOR, EMISSIVE_EXHAUST);
/** Searchlight lenses and muzzle flashes: the lamp rung. */
export const LAMP_COLOR = new THREE.Color(0xfff0d0);
const LAMP_BOOST = emissiveBoost(LAMP_COLOR, EMISSIVE_LAMP);
/** A searchlight beam's peak (at the lens), a fraction of the lamp rung:
 * additive haze, well under the bloom threshold. */
const BEAM_PEAK = 0.13;
/** Running lights: port red, starboard green, white tail and crown, and the
 * belly's red anti-collision strobe. */
const PORT = new THREE.Color(0xff2a20);
const STARBOARD = new THREE.Color(0x2aff5a);
const WHITE = new THREE.Color(0xffffff);
const NAV_SIZE_PX = 5;
const STROBE_PERIOD_MS = 1300;
const STROBE_ON_MS = 90;
/** Particle emission at full share, per second: a falling section's trail,
 * and the fire where it lands (tapering over BURN_MS). */
const TRAIL_FIRE = 70;
const TRAIL_SMOKE = 26;
const BURN_FIRE = 34;
const BURN_SMOKE = 14;
const BURN_MS = 14_000;
/** A flak burst's puff: flames and dark smoke, whole counts at full share. */
const BURST_FIRE = 7;
const BURST_SMOKE = 6;
/** S9: a spent weak point vents (smoke only), and each one spent lights two
 * more fires along the hull, per second at full share. */
const VENT_SMOKE = 9;
const HULL_FIRE = 10;
const HULL_SMOKE = 4;
/** Full detail within this of the hull's centre, the light hull beyond, m. */
export const BOSS_LOD_M = 400;
const PARKED_Y = -9999;

/** A running light: where on the hull (hull frame), and its look. */
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
/** On the solid faces, never inside or beyond (a light is not solid). */
const NAV_LIGHTS: readonly NavLight[] = [
  nav(130.1, 0, 0, WHITE, EMISSIVE_NAVLIGHT),
  nav(-128.1, 0, 0, WHITE, EMISSIVE_NAVLIGHT),
  nav(-110, P(5).y + P(5).hy + 0.1, 0, WHITE, EMISSIVE_NAVLIGHT),
  nav(-110, 0, P(7).z + P(7).hz + 0.1, STARBOARD, EMISSIVE_NAVLIGHT),
  nav(-110, 0, P(8).z - P(8).hz - 0.1, PORT, EMISSIVE_NAVLIGHT),
  nav(P(10).x + 6.6, P(10).y, P(10).z + 0.2, STARBOARD, EMISSIVE_NAVLIGHT),
  nav(P(11).x + 6.6, P(11).y, P(11).z - 0.2, PORT, EMISSIVE_NAVLIGHT),
  nav(P(12).x + 6.6, P(12).y, P(12).z + 0.2, STARBOARD, EMISSIVE_NAVLIGHT),
  nav(P(13).x + 6.6, P(13).y, P(13).z - 0.2, PORT, EMISSIVE_NAVLIGHT),
  nav(P(4).x, P(4).y - P(4).hy - 0.1, 0, PORT, EMISSIVE_STROBE, true),
  nav(-20, 19.9, 0, PORT, EMISSIVE_STROBE, true),
  nav(P(9).x - P(9).hx + 1, KEEL_BOTTOM - 0.1, 0, WHITE, EMISSIVE_STROBE, true),
];
/** Where on the hull the fire spreads to as weak points die: two points by
 * each weak point, on the envelope's skin (hull frame). */
const FIRE_POINTS: readonly Vec3[] = BOSS_WEAK_POINTS.flatMap((i) => {
  const p = P(i);
  const side = p.z === 0 ? 0 : Math.sign(p.z);
  const r = 18;
  return [
    { x: p.x - 9, y: side === 0 ? r : 6, z: side * r },
    { x: p.x + 7, y: side === 0 ? r - 2 : 2, z: side * (r + 1) },
  ];
});

/** The three cut planes' joints (hull x) the break-up blows out at. */
const JOINTS: readonly number[] = [52, -56];

/** An angle wrapped into (−π, π]. */
const wrapAngle = (a: number): number =>
  a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

const scratchImage: Vec3 = { x: 0, y: 0, z: 0 };
const UP = new THREE.Vector3(0, 1, 0);
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();

/**
 * The instance matrix of one yaw-only box, placed at its torus image nearest
 * the viewer: a unit cube scaled to the box's full extents and turned by its
 * yaw about +Y (MoverBox's Three.js convention). Pure.
 */
export function boxMatrixInto(
  box: MoverBox,
  viewer: Vec3,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  nearestImageInto(scratchImage, viewer, box);
  scratchPos.set(scratchImage.x, scratchImage.y, scratchImage.z);
  scratchQuat.setFromAxisAngle(UP, box.yaw);
  scratchScale.set(box.hx * 2, box.hy * 2, box.hz * 2);
  return out.compose(scratchPos, scratchQuat, scratchScale);
}

/**
 * A hull frame at `pose` (centre, yaw) placed at the torus image nearest
 * the viewer, offset along its own X by `ax` (a section's anchor): world =
 * this × hull-frame point. Pure.
 */
export function hullMatrixInto(
  x: number,
  y: number,
  z: number,
  yaw: number,
  ax: number,
  viewer: Vec3,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  scratchHull.x = x;
  scratchHull.y = y;
  scratchHull.z = z;
  nearestImageInto(scratchImage, viewer, scratchHull);
  out.makeRotationY(yaw);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Rotation then translation, the section's anchor taken out first.
  out.setPosition(
    scratchImage.x - ax * c,
    scratchImage.y,
    scratchImage.z + ax * s,
  );
  return out;
}
const scratchHull: Vec3 = { x: 0, y: 0, z: 0 };

/** A landed section still burning where it hit. */
interface Burn {
  at: Vec3;
  since: number;
  fireAcc: number;
  smokeAcc: number;
}

/** What the renderer tells main about the carrier's launches (audio). */
export interface BossCues {
  /** A launch's sequence began at `at`: the bay klaxon, or the steam. */
  launchStart?: (l: BossLaunch, at: Vec3) => void;
  /** It let go: the hook's clunk, or the catapult's slam and hiss. */
  launchRelease?: (l: BossLaunch, at: Vec3) => void;
  /** The hull broke apart at the joints (the down instant). */
  breakUp?: (joints: readonly Vec3[]) => void;
}

// --- The faction crest ---------------------------------------------------------

/** The carrier's crest and name, drawn once into a 1024 × 512 canvas: the
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

const HULL_VERT_HEAD = /* glsl */ `
attribute float aMat;
attribute float aWeak;
uniform float uTime;
varying vec3 vRest;
flat varying float vMat;
flat varying float vWeak;
varying vec2 vUv2;
`;
const HULL_VERT_BODY = /* glsl */ `
#include <begin_vertex>
vRest = position;
vMat = aMat;
vWeak = aWeak;
vUv2 = uv;
if (aMat > 6.5 && aMat < 7.5) {
  // A pennant streams and ripples, more toward its tail.
  float t = uv.x;
  transformed.z += sin(uTime * 5.3 - t * 7.0) * 0.55 * t;
  transformed.y += sin(uTime * 3.1 - t * 5.0) * 0.18 * t;
}
`;

const HULL_FRAG_HEAD = /* glsl */ `
uniform float uTime;
uniform vec3 uWeakCol[7];
uniform vec3 uWeakPos[7];
uniform float uWeakSpent[7];
uniform float uBurn;
uniform vec3 uWindow;
uniform vec3 uEmber;
uniform sampler2D uCrest;
uniform float uHasCrest;
varying vec3 vRest;
flat varying float vMat;
flat varying float vWeak;
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
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.17, 0.19), max(girder * 0.75, max(ring * 0.8, minor * 0.6)));
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
    float fwx = max(fwidth(wx), 1e-4);
    float inX = smoothstep(0.18 - fwx, 0.18 + fwx, fract(wx)) * (1.0 - smoothstep(0.82 - fwx, 0.82 + fwx, fract(wx)));
    float arc = (at - 2.3) * 20.5;
    float fa = max(fwidth(arc), 1e-4);
    float inY = 1.0 - smoothstep(0.6 - fa, 0.6 + fa, abs(arc));
    float lit = step(0.18, bHash(vec2(floor(wx), sign(th))));
    float w = inX * inY;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05), w);
    bEmis += uWindow * w * lit * (0.75 + 0.25 * bHash(vec2(floor(wx), 7.0 + sign(th))));
  }
  // The crest (x 63.5–76.5) and the name plate (x 0–40) on both flanks,
  // painted on the curve: u along the hull (reading forward to starboard,
  // aft to port), v up the flank.
  if (uHasCrest > 0.5) {
    float s = sign(vRest.z);
    float arc = (at - 1.5708) * 21.0;
    vec4 tc = vec4(0.0);
    if (vRest.x > 63.5 && vRest.x < 76.5 && abs(arc) < 6.5) {
      float u = (vRest.x - 63.5) / 13.0;
      tc = texture2D(uCrest, vec2(0.5 * (s > 0.0 ? u : 1.0 - u), 0.5 - arc / 13.0));
    } else if (vRest.x > 0.0 && vRest.x < 40.0 && abs(arc - 4.5) < 3.0) {
      float u = vRest.x / 40.0;
      tc = texture2D(uCrest, vec2(0.5 + 0.5 * (s > 0.0 ? u : 1.0 - u), 0.5 - (arc - 4.5) / 6.4));
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, tc.rgb, tc.a);
  }
  // Doped fabric over duralumin: mostly diffuse (a metallic skin mirrors
  // the warm city glow and reads bronze, not silver).
  bRough = 0.68;
  bMetal = 0.12;
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
  int k = int(vWeak + 0.5);
  float spent = uWeakSpent[k];
  float lat = max(bLine(vRest.x / 1.2, 0.08), bLine(th * (16.0 / 6.2831853), 0.06));
  diffuseColor.rgb = mix(vec3(0.09, 0.08, 0.08), vec3(0.03), spent);
  vec3 glow = uWeakCol[k] * (0.72 + 0.28 * (1.0 - lat));
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
// Fire spreads with the damage: scorch and embers round every spent weak
// point, growing as more of them go.
if (vMat < 1.5) {
  float scorch = 0.0;
  for (int k = 0; k < 7; k++) {
    float d = length(vRest - uWeakPos[k]);
    scorch = max(scorch, uWeakSpent[k] * (1.0 - smoothstep(4.0, 7.0 + 7.0 * uBurn, d - 3.0 * bNoise(vRest.xy * 0.3))));
  }
  diffuseColor.rgb *= 1.0 - 0.7 * scorch;
  // Embers: sparse glowing flecks in the char, breathing slowly.
  float ember = smoothstep(0.78, 0.92, bNoise(vRest.xz * 1.7 + vec2(uTime * 0.35, 0.0))) * smoothstep(0.4, 0.9, scorch);
  bEmis += uEmber * 0.35 * ember;
}
`;

const GLOW_VERT_HEAD = /* glsl */ `
attribute float aKind;
attribute float aIdx;
attribute float aAlong;
flat varying float vKind;
flat varying float vIdx;
varying float vAlong;
`;
const GLOW_VERT_BODY = /* glsl */ `
#include <begin_vertex>
vKind = aKind;
vIdx = aIdx;
vAlong = aAlong;
`;
const GLOW_FRAG_HEAD = /* glsl */ `
uniform float uTime;
uniform float uBeam;
uniform float uLens;
uniform float uHeat;
uniform float uFlash[6];
uniform float uSteam;
uniform float uSpark;
flat varying float vKind;
flat varying float vIdx;
varying float vAlong;
`;
const GLOW_FRAG_BODY = /* glsl */ `
#include <color_fragment>
float a = clamp(vAlong, 0.0, 1.0);
float k = 0.0;
if (vKind < 0.5) {
  k = uBeam * pow(1.0 - a, 1.7);
} else if (vKind < 1.5) {
  k = uHeat * (0.5 + 0.5 * sin(uTime * 9.0 + a * 14.0 + vIdx)) * (1.0 - a) * smoothstep(0.0, 0.1, a);
} else if (vKind < 2.5) {
  int t = int(vIdx + 0.5);
  k = uFlash[t];
} else if (vKind < 3.5) {
  k = uSteam * (1.0 - a) * (0.6 + 0.4 * sin(uTime * 13.0 + a * 9.0));
} else if (vKind < 4.5) {
  k = uSpark * (0.5 + 0.5 * sin(uTime * 37.0 + a * 21.0)) * (1.0 - a);
} else {
  k = uLens;
}
diffuseColor.rgb *= k;
`;

// --- The renderer -------------------------------------------------------------------

export class BossRenderer {
  readonly group = new THREE.Group();
  private readonly hull: THREE.SkinnedMesh;
  private readonly hullLite: THREE.SkinnedMesh;
  private readonly glow: THREE.SkinnedMesh;
  private readonly skeleton: THREE.Skeleton;
  private readonly bones: THREE.Bone[] = [];
  private readonly rests: BoneRest[];
  private readonly lights: THREE.Points;
  private readonly lightPos: THREE.BufferAttribute;
  private readonly lightCol: THREE.BufferAttribute;
  private readonly shells: THREE.Points;
  private readonly shellPos: THREE.BufferAttribute;
  private readonly hullU: {
    uTime: { value: number };
    uWeakCol: { value: THREE.Color[] };
    uWeakPos: { value: THREE.Vector3[] };
    uWeakSpent: { value: number[] };
    uBurn: { value: number };
    uWindow: { value: THREE.Color };
    uEmber: { value: THREE.Color };
    uCrest: { value: THREE.Texture | null };
    uHasCrest: { value: number };
  };
  private readonly glowU: {
    uTime: { value: number };
    uBeam: { value: number };
    uLens: { value: number };
    uHeat: { value: number };
    uFlash: { value: number[] };
    uSteam: { value: number };
    uSpark: { value: number };
  };
  private share = 1;
  private readonly pose = blankPose();
  private readonly pose2 = blankPose();
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  /** Section matrices (world = section × hull-frame point). */
  private readonly section = [
    new THREE.Matrix4(),
    new THREE.Matrix4(),
    new THREE.Matrix4(),
  ];
  private readonly m = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);
  /** Last HP seen per weak point, and when each last took a hit. */
  private readonly lastHp = BOSS_WEAK_POINTS.map(() => Number.NaN);
  private shellCount = 0;
  private readonly flashUntil = BOSS_WEAK_POINTS.map(() => 0);
  /** Per falling section: emission carry, and whether it has landed. */
  private readonly trail = [0, 0, 0, 0, 0, 0];
  private landedFor = -1;
  private brokeFor = -1;
  private readonly landed = [false, false, false];
  private readonly burns: Burn[] = [];
  private lastFrameMs = Number.NaN;
  /** Turret aim (traverse, elevation, rad), smoothed, and its last shell. */
  private readonly aimYaw = BOSS_TURRETS.map(() => 0);
  private readonly aimEl = BOSS_TURRETS.map(() => 0.2);
  private readonly lastShot = BOSS_TURRETS.map(() => Number.NEGATIVE_INFINITY);
  private readonly aimTo: (Vec3 | null)[] = BOSS_TURRETS.map(() => null);
  /** Damage dressing carries: vents and hull fires, per emitter. */
  private readonly ventAcc = BOSS_WEAK_POINTS.map(() => 0);
  private readonly fireAcc = FIRE_POINTS.map(() => [0, 0]);
  /** Launches already cued at their start / their release. */
  private readonly cuedStart = new Set<number>();
  private readonly cuedRelease = new Set<number>();
  private readonly local: LaunchLocal = { x: 0, y: 0, z: 0, pitch: 0 };
  private readonly rig: LaunchRig = {
    doors: 0,
    drop: 0,
    carriage: 0,
    steam: 0,
    onRig: false,
  };
  /** The plane's top (the hook) over its centre, m. */
  private planeTop = 1.6;
  private cues: BossCues = {};
  private lod: "full" | "lite" = "full";

  constructor(
    private readonly impacts: Impacts,
    /** A falling section hit the city at `at` (main: blast, sound, shake). */
    private readonly onLand: (at: Vec3) => void,
    /** A flak shell burst at `at` (main: crack, near-miss radio). */
    private readonly onBurst: (at: Vec3, f: BossFlak) => void,
  ) {
    const plane = this.planeGeometry();
    this.rests = boneRests();
    for (let b = 0; b < BONE_COUNT; b++) {
      const bone = new THREE.Bone();
      bone.matrixAutoUpdate = false;
      bone.matrixWorldAutoUpdate = false;
      this.bones.push(bone);
    }
    const ident = this.bones.map(() => new THREE.Matrix4());
    this.skeleton = new THREE.Skeleton(this.bones, ident);

    const crest = drawCrest();
    this.hullU = {
      uTime: { value: 0 },
      uWeakCol: { value: BOSS_WEAK_POINTS.map(() => new THREE.Color()) },
      uWeakPos: {
        value: BOSS_WEAK_POINTS.map((i) => {
          const p = P(i);
          return new THREE.Vector3(p.x, p.y, p.z);
        }),
      },
      uWeakSpent: { value: BOSS_WEAK_POINTS.map(() => 0) },
      uBurn: { value: 0 },
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
    };
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.6,
      metalness: 0.4,
    });
    hullMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.hullU);
      shader.vertexShader =
        HULL_VERT_HEAD +
        shader.vertexShader.replace("#include <begin_vertex>", HULL_VERT_BODY);
      shader.fragmentShader = (HULL_FRAG_HEAD + shader.fragmentShader)
        .replace("#include <color_fragment>", HULL_FRAG_SURFACE)
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\nroughnessFactor = bRough;",
        )
        .replace(
          "#include <metalnessmap_fragment>",
          "#include <metalnessmap_fragment>\nmetalnessFactor = bMetal;",
        )
        .replace(
          "#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\ntotalEmissiveRadiance += bEmis;",
        );
    };
    hullMat.customProgramCacheKey = () => "s9-boss-hull";
    const full = buildBossHull("full", plane);
    const lite = buildBossHull("lite", plane);
    this.hull = new THREE.SkinnedMesh(full.geometry, hullMat);
    this.hullLite = new THREE.SkinnedMesh(lite.geometry, hullMat);

    this.glowU = {
      uTime: { value: 0 },
      uBeam: { value: 0 },
      uLens: { value: 0 },
      uHeat: { value: 0 },
      uFlash: { value: BOSS_TURRETS.map(() => 0) },
      uSteam: { value: 0 },
      uSpark: { value: 0 },
    };
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    glowMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.glowU);
      shader.vertexShader =
        GLOW_VERT_HEAD +
        shader.vertexShader.replace("#include <begin_vertex>", GLOW_VERT_BODY);
      shader.fragmentShader = (GLOW_FRAG_HEAD + shader.fragmentShader).replace(
        "#include <color_fragment>",
        GLOW_FRAG_BODY,
      );
    };
    glowMat.customProgramCacheKey = () => "s9-boss-glow";
    this.glow = new THREE.SkinnedMesh(buildBossGlow(), glowMat);
    for (const mesh of [this.hull, this.hullLite, this.glow]) {
      // Posed on the torus image nearest the camera, and split apart when
      // it breaks up: a bound from the rest pose means nothing.
      mesh.frustumCulled = false;
      mesh.bindMode = THREE.DetachedBindMode;
      mesh.bind(this.skeleton, new THREE.Matrix4());
    }
    this.hullLite.visible = false;

    const lightGeo = new THREE.BufferGeometry();
    this.lightPos = new THREE.BufferAttribute(
      new Float32Array(NAV_LIGHTS.length * 3),
      3,
    );
    this.lightCol = new THREE.BufferAttribute(
      new Float32Array(NAV_LIGHTS.length * 3),
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

    this.group.add(
      this.hull,
      this.hullLite,
      this.glow,
      this.lights,
      this.shells,
    );
    // Hidden until a raid: the boot pre-warm shows (and so compiles) it.
    this.group.visible = false;
  }

  /** The launch planes: the bots' own airframe (biplane.ts), merged with its
   * colours baked, turned nose +X. Null without a DOM. */
  private planeGeometry(): PlaneGeo | null {
    if (typeof document === "undefined") return null;
    return planeGeoFromBiplane((top) => {
      this.planeTop = top;
    });
  }

  /** Share of the full particle dressing this tier keeps (quality bossFx). */
  setQuality(share: number): void {
    this.share = share;
  }

  /** S9: the launch / break-up audio cues (main). */
  setCues(cues: BossCues): void {
    this.cues = cues;
  }

  /**
   * Per frame. `renderMs` is the render clock (null: no clock yet — nothing
   * drawn, nothing solid). `flak` is the socket's shells in the air; each is
   * removed once it has burst.
   */
  update(
    slot: BossSlot,
    hp: readonly number[],
    flak: Map<number, BossFlak>,
    viewer: Vec3,
    renderMs: number | null,
    now: number,
  ): void {
    const dt = Number.isNaN(this.lastFrameMs)
      ? 0
      : Math.min(0.1, (now - this.lastFrameMs) / 1000);
    this.lastFrameMs = now;
    this.updateBurns(now, dt);
    this.hullU.uTime.value = (now % 600_000) / 1000;
    this.glowU.uTime.value = this.hullU.uTime.value;
    if (renderMs === null || !slot.raid) {
      this.group.visible = false;
      return;
    }
    const raid = slot.raid;
    this.updateFlak(raid, flak, viewer, renderMs, now);
    if (bossPresent(slot, renderMs)) {
      this.group.visible = true;
      bossPoseAt(raid, renderMs, this.pose);
      this.drawIntact(raid, slot, hp, viewer, renderMs, now, dt);
      return;
    }
    const down = slot.down;
    if (down && down.id === raid.id && renderMs >= down.t) {
      if (this.landedFor !== down.id) {
        this.landedFor = down.id;
        this.landed.fill(false);
        this.trail.fill(0);
      }
      this.drawFalling(down.id, down.t, down.pieces, viewer, renderMs, now, dt);
      return;
    }
    // Between raids (or on its way out past the haze): the shells may still
    // be in the air, but the hull is not.
    this.hull.visible = false;
    this.hullLite.visible = false;
    this.glow.visible = false;
    this.lights.visible = false;
    this.group.visible = flak.size > 0;
  }

  // --- Posing --------------------------------------------------------------------

  /** Bone b = its section × (pivot · local · pivot⁻¹), local in `this.m2`. */
  private setBone(b: number, local: THREE.Matrix4 | null): void {
    const r = this.rests[b] as BoneRest;
    const out = (this.bones[b] as THREE.Bone).matrixWorld;
    out.copy(this.section[r.section] as THREE.Matrix4);
    if (local === null) return;
    out.multiply(this.m.makeTranslation(r.x, r.y, r.z));
    out.multiply(local);
    out.multiply(this.m.makeTranslation(-r.x, -r.y, -r.z));
  }

  private hideBone(b: number): void {
    (this.bones[b] as THREE.Bone).matrixWorld.copy(this.zero);
  }

  private pickLod(viewer: Vec3, x: number, z: number, y: number): void {
    const dx = wrapDeltaAxis(x, viewer.x);
    const dz = wrapDeltaAxis(z, viewer.z);
    const d = Math.hypot(dx, viewer.y - y, dz);
    // Hysteresis: never flips on the boundary.
    if (this.lod === "full" && d > BOSS_LOD_M + 30) this.lod = "lite";
    else if (this.lod === "lite" && d < BOSS_LOD_M - 30) this.lod = "full";
    this.hull.visible = this.lod === "full";
    this.hullLite.visible = this.lod === "lite";
    this.glow.visible = true;
  }

  private drawIntact(
    raid: BossRaid,
    slot: BossSlot,
    hp: readonly number[],
    viewer: Vec3,
    renderMs: number,
    now: number,
    dt: number,
  ): void {
    const pose = this.pose;
    this.pickLod(viewer, pose.x, pose.z, pose.y);
    for (let k = 0; k < 3; k++) {
      hullMatrixInto(
        pose.x,
        pose.y,
        pose.z,
        pose.yaw,
        0,
        viewer,
        this.section[k] as THREE.Matrix4,
      );
      this.setBone(k, null);
    }
    // Props: a steady pusher spin, alternate cars counter-rotating.
    for (let e = 0; e < 4; e++) {
      const spin = ((now / 1000) * 9 * (e % 2 ? -1 : 1)) % (Math.PI * 2);
      this.setBone(BONE_PROP + e, this.m2.makeRotationX(spin));
    }
    // Rudders follow the turn (yaw rate over ±1 s); elevators hunt trim.
    bossPoseAt(raid, renderMs + 1000, this.pose2);
    const ahead = this.pose2.yaw;
    bossPoseAt(raid, renderMs - 1000, this.pose2);
    const rate = wrapAngle(ahead - this.pose2.yaw) / 2;
    const rudder = Math.max(-0.16, Math.min(0.16, -rate * 3.5));
    this.setBone(BONE_RUDDER_D, this.m2.makeRotationY(rudder));
    this.setBone(BONE_RUDDER_V, this.m2.makeRotationY(rudder));
    const trim = 0.05 * Math.sin(now / 2300);
    this.setBone(BONE_ELEV_S, this.m2.makeRotationZ(trim));
    this.setBone(BONE_ELEV_P, this.m2.makeRotationZ(trim));
    this.poseTurrets(renderMs, now, dt, true);
    this.poseCrew(now);
    this.poseLamps(now, true);
    this.poseLaunches(raid, slot.launches ?? [], renderMs);

    // Weak points: a slow, shared throb (alive, and targets), white on a
    // hit, char once spent.
    const throb = 0.78 + 0.22 * Math.sin(now / 260);
    let spent = 0;
    for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
      const left = hp[k] ?? 0;
      if (left < (this.lastHp[k] as number)) {
        this.flashUntil[k] = now + HIT_FLASH_MS;
      }
      const col = this.hullU.uWeakCol.value[k] as THREE.Color;
      if (left <= 0) {
        col.copy(SPENT);
        spent++;
      } else if (now < (this.flashUntil[k] as number)) {
        col.copy(WHITE).multiplyScalar(WEAK_BOOST);
      } else col.copy(WEAK_COLOR).multiplyScalar(WEAK_BOOST * throb);
      this.hullU.uWeakSpent.value[k] = left <= 0 ? 1 : 0;
      this.lastHp[k] = left;
    }
    this.hullU.uBurn.value = spent / BOSS_WEAK_POINTS.length;
    this.glowU.uBeam.value = BEAM_PEAK * LAMP_BOOST;
    this.glowU.uLens.value = LAMP_BOOST;
    this.glowU.uHeat.value = HEAT_BOOST * 0.35;
    this.damageFx(now, dt);
    this.placeLights(viewer, now);
  }

  /** Turret k: traverse and elevate toward its newest shell's burst point
   * (smoothed — a turret slews, it does not snap), a muzzle flash for 90 ms
   * after each shot; idle, a slow scan. */
  private poseTurrets(
    renderMs: number,
    now: number,
    dt: number,
    live: boolean,
  ): void {
    const pose = this.pose;
    const c = Math.cos(pose.yaw);
    const s = Math.sin(pose.yaw);
    for (let k = 0; k < BOSS_TURRETS.length; k++) {
      const t = BOSS_TURRETS[k] as { part: number; up: 1 | -1 };
      const p = P(t.part);
      let yaw = 0.6 * Math.sin(now / 4100 + k * 1.7);
      let el = 0.25;
      const to = this.aimTo[k];
      if (live && to) {
        // Hull-frame direction from the mount to the burst point.
        const wx = pose.x + p.x * c + p.z * s;
        const wz = pose.z - p.x * s + p.z * c;
        const dx = wrapDeltaAxis(wx, to.x);
        const dz = wrapDeltaAxis(wz, to.z);
        const dy = to.y - (pose.y + p.y);
        const lx = c * dx - s * dz;
        const lz = s * dx + c * dz;
        yaw = Math.atan2(-lz, lx);
        el = Math.max(
          0,
          Math.min(0.7, Math.atan2(dy * t.up, Math.hypot(lx, lz))),
        );
      }
      const blend = 1 - Math.exp(-dt * 4);
      this.aimYaw[k] =
        (this.aimYaw[k] as number) +
        wrapAngle(yaw - (this.aimYaw[k] as number)) * blend;
      this.aimEl[k] =
        (this.aimEl[k] as number) + (el - (this.aimEl[k] as number)) * blend;
      const ay = this.aimYaw[k] as number;
      this.setBone(BONE_TURRET + k, this.m2.makeRotationY(ay));
      this.m2
        .makeRotationY(ay)
        .multiply(this.m.makeRotationZ(t.up * (this.aimEl[k] as number)));
      // setBone reuses this.m: hand it a copy.
      const local = this.localScratch.copy(this.m2);
      this.setBone(BONE_GUN + k, local);
      const since = renderMs - (this.lastShot[k] as number);
      this.glowU.uFlash.value[k] =
        live && since >= 0 && since < 90 ? LAMP_BOOST * (1 - since / 90) : 0;
    }
  }
  private readonly localScratch = new THREE.Matrix4();

  /** The deck crew pace their lanes (pure in the frame clock). */
  private poseCrew(now: number): void {
    const span = CREW_X1 - CREW_X0;
    for (let c = 0; c < CREW; c++) {
      const ph = ((now / 1000) * 1.1 + c * 13) % (2 * span);
      const out = ph < span;
      const x = CREW_X0 + (out ? ph : 2 * span - ph);
      const bob = Math.abs(Math.sin((now / 1000) * 5.5 + c)) * 0.05;
      this.m2.makeTranslation(x - crewRestX(c), bob, 0);
      if (!out) this.m2.multiply(this.m.makeRotationY(Math.PI));
      this.localScratch.copy(this.m2);
      this.setBone(BONE_CREW + c, this.localScratch);
    }
  }

  /** Searchlights sweep the city below (pure in the frame clock). */
  private poseLamps(now: number, on: boolean): void {
    for (let k = 0; k < LAMPS; k++) {
      const az =
        0.75 * Math.sin(now / 3100 + k * 2.1) + (k === 2 ? Math.PI : 0);
      const tilt = 0.55 + 0.25 * Math.sin(now / 2300 + k);
      this.m2.makeRotationY(az).multiply(this.m.makeRotationZ(tilt));
      this.localScratch.copy(this.m2);
      this.setBone(BONE_LAMP + k, this.localScratch);
    }
    if (!on) this.glowU.uBeam.value = 0;
  }

  /**
   * The carrier's launches on the render clock: the newest launch on each
   * station drives the bay doors and trapeze or the catapult carriage, and
   * its plane rides the rig until it lets go (at the release the bot itself
   * appears there — launchSpawnAt is this same pose). Cues fire once each.
   */
  private poseLaunches(
    raid: BossRaid,
    launches: readonly BossLaunch[],
    renderMs: number,
  ): void {
    let belly: BossLaunch | null = null;
    let deck: BossLaunch | null = null;
    for (const l of launches) {
      if (l.raid !== raid.id || l.t0 > renderMs) continue;
      if (renderMs >= launchDoneAt(l)) continue;
      if (l.kind === LAUNCH_BELLY) belly = l;
      else deck = l;
      this.cue(l, renderMs);
    }
    // Belly: doors slide outboard, the trapeze lowers the plane.
    const bay = belly ? launchRigAt(belly, renderMs, this.rig) : null;
    const open = bay ? bay.doors : 0;
    this.setBone(BONE_DOOR_S, this.m2.makeTranslation(0, 0, open * 2.55));
    this.setBone(BONE_DOOR_P, this.m2.makeTranslation(0, 0, -open * 2.55));
    if (belly && bay && bay.onRig) {
      launchLocalAt(belly, renderMs, this.local);
      const arm = Math.max(0.05, KEEL_BOTTOM - (this.local.y + this.planeTop));
      this.setBone(BONE_TRAPEZE, this.m2.makeScale(1, arm, 1));
      this.posePlane(BONE_PLANE_BELLY);
    } else {
      const drop = bay ? bay.drop : 0;
      this.setBone(BONE_TRAPEZE, this.m2.makeScale(1, Math.max(0.05, drop), 1));
      this.hideBone(BONE_PLANE_BELLY);
    }
    // Deck: steam, the carriage's run, sparks along the rail.
    const cat = deck ? launchRigAt(deck, renderMs, this.rig) : null;
    const rest = (this.rests[BONE_CARRIAGE] as BoneRest).x;
    this.setBone(
      BONE_CARRIAGE,
      this.m2.makeTranslation((cat ? cat.carriage : rest) - rest, 0, 0),
    );
    this.glowU.uSteam.value = cat ? cat.steam * 0.5 : 0;
    if (deck && cat && cat.onRig) {
      launchLocalAt(deck, renderMs, this.local);
      const running = renderMs - deck.t0 > 600;
      this.glowU.uSpark.value = running ? HEAT_BOOST * 0.8 : 0;
      this.posePlane(BONE_PLANE_DECK);
    } else {
      this.glowU.uSpark.value = 0;
      this.hideBone(BONE_PLANE_DECK);
    }
  }

  /** A rig plane at `this.local` (hull frame), relative to its rest. */
  private posePlane(b: number): void {
    const r = this.rests[b] as BoneRest;
    this.m2
      .makeTranslation(
        this.local.x - r.x,
        this.local.y - r.y,
        this.local.z - r.z,
      )
      .multiply(this.m.makeRotationZ(this.local.pitch));
    this.localScratch.copy(this.m2);
    this.setBone(b, this.localScratch);
  }

  private cue(l: BossLaunch, renderMs: number): void {
    const startCue = !this.cuedStart.has(l.id);
    const releaseCue =
      !this.cuedRelease.has(l.id) && renderMs >= launchReleaseAt(l);
    if (!startCue && !releaseCue) return;
    launchLocalAt(l, renderMs, this.local);
    this.hullPointInto(this.local.x, this.local.y, this.local.z, this.at);
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

  /** A hull-frame point of the intact hull at `this.pose`, canonical. */
  private hullPointInto(lx: number, ly: number, lz: number, out: Vec3): Vec3 {
    const c = Math.cos(this.pose.yaw);
    const s = Math.sin(this.pose.yaw);
    out.x = this.pose.x + lx * c + lz * s;
    out.y = this.pose.y + ly;
    out.z = this.pose.z - lx * s + lz * c;
    return out;
  }

  /** Gas venting from spent weak points and the fire spreading along the
   * hull with each one lost: the D1 pool, at the tier's share. */
  private damageFx(now: number, dt: number): void {
    if (dt <= 0) return;
    let spent = 0;
    for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
      if (!((this.hullU.uWeakSpent.value[k] as number) > 0)) continue;
      spent++;
      const p = P(BOSS_WEAK_POINTS[k] as number);
      const acc = (this.ventAcc[k] as number) + VENT_SMOKE * this.share * dt;
      const n = Math.floor(acc);
      this.ventAcc[k] = acc - n;
      if (n > 0) {
        this.hullPointInto(p.x, p.y + 1, p.z, this.at);
        this.impacts.wreckFire(this.at, 0, n, 3, now);
      }
    }
    const lit = Math.min(FIRE_POINTS.length, spent * 2);
    for (let i = 0; i < lit; i++) {
      const f = FIRE_POINTS[i] as Vec3;
      const acc = this.fireAcc[i] as number[];
      acc[0] = (acc[0] as number) + HULL_FIRE * this.share * dt;
      acc[1] = (acc[1] as number) + HULL_SMOKE * this.share * dt;
      const nf = Math.floor(acc[0] as number);
      const ns = Math.floor(acc[1] as number);
      acc[0] = (acc[0] as number) - nf;
      acc[1] = (acc[1] as number) - ns;
      if (nf > 0 || ns > 0) {
        this.hullPointInto(f.x, f.y, f.z, this.at);
        this.impacts.wreckFire(this.at, nf, ns, 5, now);
      }
    }
  }

  private drawFalling(
    id: number,
    t: number,
    pieces: readonly BossPiece[],
    viewer: Vec3,
    renderMs: number,
    now: number,
    dt: number,
  ): void {
    if (this.brokeFor !== id) {
      // The instant it breaks: the joints blow out.
      this.brokeFor = id;
      const p = pieces[1];
      if (p) {
        piecePoseAt(p, t, p.end, t, this.pose);
        const joints = JOINTS.map((x) => {
          const out = { x: 0, y: 0, z: 0 };
          this.hullPointInto(x + 2, 0, 0, out);
          return out;
        });
        this.cues.breakUp?.(joints);
      }
    }
    let falling = false;
    let nearest = Number.POSITIVE_INFINITY;
    for (const piece of pieces) {
      const sec = this.section[piece.k] as THREE.Matrix4;
      if (renderMs >= t + piece.end) {
        sec.copy(this.zero);
        if (!this.landed[piece.k]) {
          this.landed[piece.k] = true;
          const at = piece.at;
          this.burns.push({ at, since: now, fireAcc: 0, smokeAcc: 0 });
          this.onLand(at);
        }
        continue;
      }
      falling = true;
      piecePoseAt(piece, t, piece.end, renderMs, this.pose2);
      const ax = (BOSS_PIECES[piece.k] as { ax: number }).ax;
      hullMatrixInto(
        this.pose2.x,
        this.pose2.y,
        this.pose2.z,
        this.pose2.yaw,
        ax,
        viewer,
        sec,
      );
      const d = Math.hypot(
        wrapDeltaAxis(this.pose2.x, viewer.x),
        viewer.y - this.pose2.y,
        wrapDeltaAxis(this.pose2.z, viewer.z),
      );
      nearest = Math.min(nearest, d);
      // Fire and smoke pour off the broken section as it goes down.
      const fire = this.trail[piece.k * 2] as number;
      const smoke = this.trail[piece.k * 2 + 1] as number;
      const nf = fire + TRAIL_FIRE * this.share * dt;
      const ns = smoke + TRAIL_SMOKE * this.share * dt;
      this.at.x = this.pose2.x;
      this.at.y = this.pose2.y;
      this.at.z = this.pose2.z;
      this.impacts.wreckFire(this.at, Math.floor(nf), Math.floor(ns), 22, now);
      this.trail[piece.k * 2] = nf - Math.floor(nf);
      this.trail[piece.k * 2 + 1] = ns - Math.floor(ns);
    }
    for (let k = 0; k < 3; k++) this.setBone(k, null);
    // Everything on a section rides it, dead: props stopped, rigs stowed.
    for (let b = 3; b < BONE_COUNT; b++) this.setBone(b, null);
    this.hideBone(BONE_PLANE_BELLY);
    this.hideBone(BONE_PLANE_DECK);
    for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
      (this.hullU.uWeakCol.value[k] as THREE.Color).copy(SPENT);
      this.hullU.uWeakSpent.value[k] = 1;
    }
    this.hullU.uBurn.value = 1;
    this.glowU.uBeam.value = 0;
    this.glowU.uLens.value = 0;
    this.glowU.uHeat.value = 0;
    this.glowU.uSteam.value = 0;
    this.glowU.uSpark.value = 0;
    this.glowU.uFlash.value.fill(0);
    const near = nearest < BOSS_LOD_M;
    this.lod = near ? "full" : "lite";
    this.hull.visible = near;
    this.hullLite.visible = !near;
    this.glow.visible = false;
    this.lights.visible = false;
    this.group.visible = falling;
  }

  /** Running lights on the intact hull (strobes blink on the frame clock). */
  private placeLights(viewer: Vec3, now: number): void {
    const strobeOn = now % STROBE_PERIOD_MS < STROBE_ON_MS;
    for (let n = 0; n < NAV_LIGHTS.length; n++) {
      const l = NAV_LIGHTS[n] as NavLight;
      this.hullPointInto(l.x, l.y, l.z, this.at);
      nearestImageInto(scratchImage, viewer, this.at);
      this.lightPos.setXYZ(n, scratchImage.x, scratchImage.y, scratchImage.z);
      const on = !l.strobe || strobeOn;
      const k = on ? emissiveBoost(l.color, l.rung) : 0;
      this.lightCol.setXYZ(n, l.color.r * k, l.color.g * k, l.color.b * k);
    }
    this.lightPos.needsUpdate = true;
    this.lightCol.needsUpdate = true;
    this.lights.visible = true;
  }

  /** Shell heads in flight; each burst once, then dropped from `flak`.
   * S8: walked by one pre-bound callback — a `for…of` over the Map built an
   * iterator and an entry array per shell, every frame. S9: each turret's
   * newest shell is also what it aims at. */
  private updateFlak(
    raid: NonNullable<BossSlot["raid"]>,
    flak: Map<number, BossFlak>,
    viewer: Vec3,
    renderMs: number,
    now: number,
  ): void {
    const w = this.flakWalk;
    w.raid = raid;
    w.flak = flak;
    w.viewer = viewer;
    w.renderMs = renderMs;
    w.now = now;
    w.n = 0;
    flak.forEach(this.placeShell);
    const n = w.n;
    for (let i = n; i < SHELL_POOL; i++)
      this.shellPos.setXYZ(i, 0, PARKED_Y, 0);
    this.shellPos.needsUpdate = true;
    this.shells.visible = n > 0;
    this.shellCount = n;
  }

  /** updateFlak's frame, for placeShell. */
  private readonly flakWalk: {
    raid: BossRaid | null;
    flak: Map<number, BossFlak> | null;
    viewer: Vec3;
    renderMs: number;
    now: number;
    n: number;
  } = {
    raid: null,
    flak: null,
    viewer: scratchImage,
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
    if (w.renderMs < f.t0 || w.raid === null) return;
    if (f.t0 >= (this.lastShot[f.turret] as number)) {
      this.lastShot[f.turret] = f.t0;
      this.aimTo[f.turret] = f.to;
    }
    if (w.n >= SHELL_POOL) return;
    flakPosAt(w.raid, f, w.renderMs, this.at);
    nearestImageInto(scratchImage, w.viewer, this.at);
    this.shellPos.setXYZ(w.n++, scratchImage.x, scratchImage.y, scratchImage.z);
  };

  /** Landed sections keep burning, tapering to nothing over BURN_MS. */
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

  /** The hull's centre where it is drawn this frame, canonical (main: the
   * engine drone's source), or null when no intact hull is up. */
  dronePos(): Vec3 | null {
    return this.group.visible && this.lights.visible ? this.pose : null;
  }

  /** QA: what is drawn this frame — the hull's draw (and which LOD), the
   * weak points still glowing, the shells, the planes on the rigs. */
  get stats(): {
    armour: number;
    weak: number;
    shells: number;
    lod: "full" | "lite" | "none";
    rigPlanes: number;
  } {
    const shown =
      this.group.visible && (this.hull.visible || this.hullLite.visible);
    let rig = 0;
    for (const b of [BONE_PLANE_BELLY, BONE_PLANE_DECK]) {
      const e = (this.bones[b] as THREE.Bone).matrixWorld.elements;
      if (shown && e[0] !== 0) rig++;
    }
    return {
      armour: shown ? 1 : 0,
      weak: shown
        ? this.hullU.uWeakSpent.value.filter((v) => v === 0).length
        : 0,
      shells: this.shells.visible ? this.shellCount : 0,
      lod: shown ? this.lod : "none",
      rigPlanes: rig,
    };
  }
}

/** The bots' airframe for the launch rigs: biplane.ts's static groups and
 * blades, colours baked, nose turned from +Z to +X, origin at the plane's
 * centre with its wheels DECK_PLANE_H (1.6 m) under it. `top` gets the
 * hook's height over the centre. */
function planeGeoFromBiplane(top: (h: number) => void): PlaneGeo | null {
  // Lazy: biplane.ts builds its shared geometry on first use (needs a DOM).
  const parts: { geometry: THREE.BufferGeometry; color: number }[] = [];
  try {
    const src = biplaneSourcesLazy();
    if (!src) return null;
    const turn = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    const box = new THREE.Box3();
    const all: THREE.BufferGeometry[] = [];
    for (const key of src.groupKeys) {
      const g = src.shared.statics.get(key);
      const mat = src.materials[key] as THREE.MeshStandardMaterial | undefined;
      if (!g || !mat?.color) continue;
      const c = g.clone().applyMatrix4(turn);
      all.push(c);
      parts.push({ geometry: c, color: mat.color.getHex() });
    }
    const blades = src.shared.blades
      .clone()
      .applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, src.propZ))
      .applyMatrix4(turn);
    all.push(blades);
    parts.push({ geometry: blades, color: 0x222222 });
    for (const g of all) {
      g.computeBoundingBox();
      if (g.boundingBox) box.union(g.boundingBox);
    }
    const lift = -1.6 - box.min.y;
    for (const g of all) g.translate(0, lift, 0);
    top(box.max.y + lift);
  } catch {
    return null;
  }
  return { parts };
}

function biplaneSourcesLazy(): ReturnType<typeof biplaneSources> | null {
  return typeof document === "undefined" ? null : biplaneSources();
}
