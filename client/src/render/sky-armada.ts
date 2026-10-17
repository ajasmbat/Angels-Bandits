// SKY1 Infinite sky: the whole sky at war — hundreds of airships in
// parallax layers, dogfights and flak everywhere, and a painted horizon of
// more of them — around the real fleet and the real enemy planes, at the
// cost of four draws and a handful of uniforms a frame.
//
// The Infinite War's three layers (real → cosmetic → painted). This file
// draws the last two:
//
//   ARMADA     the cosmetic airships: BOSS_PROFILE lathed low-poly, fins,
//              gondola and engine cars, one instanced draw (opaque).
//   PLANES     the dogfights' planes: a low-poly silhouette, one instanced
//              draw (opaque).
//   FX         every light on them and every flash between them, one
//              instanced draw of screen-space quads (premultiplied alpha:
//              additive lights, dark smoke): running lights, beacons,
//              engine glow, the burning ships' fire glow and smoke columns,
//              tracer streaks, muzzle sparkle, the shot-down planes' fire
//              and smoke trails, flak flashes and their puffs.
//   HORIZON    the painted layer: a ring far out in the shell, where the
//              fragment shader paints endless faint airship silhouettes and
//              flak flashes along the horizon, so the sky never ends.
//
// WHERE AND WHEN: common/src/skyarmada.ts. Every slot's pose is a pure
// function of (seed, the synced clock folded into its loop, the camera's
// unwrapped offset) evaluated HERE, in the vertex shaders, by slot index
// (gl_InstanceID); that file is the CPU mirror the tests pin, line for
// line. No instance buffer is ever written: update() sets uniforms only.
//
// THE SHELL. All four draw in L2's far shell (far-skyline.ts abFarShell):
// at the exact screen position, at a compressed depth just inside the fog
// limit — so every real thing nearer than 800 m occludes them, the far
// city occludes them in true depth order, and nothing cosmetic can ever be
// flown into. They are only ever visible beyond SKY_INNER (900 m, past the
// camera's far plane): as the camera closes on one, it dissolves into the
// haze, as L2's far towers do.
//
// ATMOSPHERIC PERSPECTIVE. Opaque hulls fade toward the sky-matched glow
// fog (fog.ts abGlowFog ∘ sky-fog.ts abSkyFog — the colour the fog chunk
// and the dome reach along that ray, so a hull high above the fog stop
// cannot show as a pale cut-out); lights and flashes fade by attenuation,
// never by a lerp (the sky-meets-fog contract, rule 3). Inside the cloud
// deck, in dust and above the deck nothing draws (hidden with the dome).
//
// Not solid, never on the wire: draw == collide holds because none of
// this is anywhere a plane can reach.

import { BOSS_PROFILE } from "@angels-bandits/common/boss";
import {
  CLOUD_BASE,
  EMISSIVE_EXHAUST,
  EMISSIVE_FIRE,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_STROBE,
  FOG_DISTANCE,
} from "@angels-bandits/common/constants";
import {
  FLAK_BELOW,
  FLAK_SIDE,
  FLAK_SLOTS,
  FLAK_TURNS,
  GROUP_ALT,
  GROUP_BOB,
  GROUP_BURST_SHARE,
  GROUP_BURST_TURNS,
  GROUP_CYCLE_S,
  GROUP_EMERGE_FADE_S,
  GROUP_EMERGE_RISE,
  GROUP_EMERGE_S,
  GROUP_FALL_G,
  GROUP_HIT_S,
  GROUP_HIT_SPAN_S,
  GROUP_KILL_SHARE,
  GROUP_LAG,
  GROUP_R,
  GROUP_SIZE_MAX,
  GROUP_SLOTS,
  GROUP_TURNS,
  PLANE_FADE_IN,
  PLANE_RADIUS_MAX,
  PLANE_STEP,
  PLANE_WINDOW,
  SHIP_BURN_HOLD_S,
  SHIP_BURN_SHARE,
  SHIP_CYCLE_S,
  SHIP_DRIFT,
  SHIP_EMERGE_FADE_S,
  SHIP_EMERGE_RISE,
  SHIP_EMERGE_S,
  SHIP_FADE_IN,
  SHIP_FALL_G,
  SHIP_HALF_LEN,
  SHIP_IGNITE_S,
  SHIP_IGNITE_SPAN_S,
  SHIP_LAYERS,
  SHIP_RADIUS_MAX,
  SHIP_SCALE_MIN,
  SHIP_SCALE_SPAN,
  SHIP_SLOTS,
  SHIP_STEP,
  SHIP_WINDOW,
  SKY_HAZE,
  SKY_LOOP_S,
  SKY_OUTER_FADE,
  SKY_VIS,
  skyLoopTime,
  skySeed,
} from "@angels-bandits/common/skyarmada";
import * as THREE from "three";
import { FAR_ORIGIN, FAR_SHELL_GLSL } from "./far-skyline";
import { AB_FOG_GLSL } from "./fog";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { RENDER_ORDER } from "./render-order";
import { AB_SKY_FOG_GLSL } from "./sky-fog";

/** Draws in the layer: armada, planes, FX, horizon. */
export const SKY_ARMADA_DRAWS = 4;
/** FX quads per ship / per plane / per flak slot (the FX decode below). */
const SHIP_FX = 7;
const PLANE_FX = 6;
const FLAK_FX = 2;
/** Cosmetic planes are drawn this much larger than life: a 10 m plane is
 * a few pixels at 2 km, and the dogfights must read as planes. */
const PLANE_SCALE = 1.8;

/** A tier's share → (ships, dogfight groups, flak slots, ship radius m,
 * plane radius m). */
export function skyArmadaCounts(share: number): {
  ships: number;
  groups: number;
  flak: number;
  shipOuter: number;
  planeOuter: number;
} {
  const s = Math.min(1, Math.max(0, share));
  return {
    ships: Math.round(SHIP_SLOTS * s),
    groups: Math.round(GROUP_SLOTS * s),
    // Flak slot f bursts round ship slot 4f + 1: never past the ships drawn.
    flak: Math.min(
      Math.round(FLAK_SLOTS * s),
      Math.floor((SHIP_SLOTS * s) / 4),
    ),
    shipOuter: SHIP_RADIUS_MAX * (0.5 + 0.5 * s),
    planeOuter: PLANE_RADIUS_MAX * (0.55 + 0.45 * s),
  };
}

// --- GLSL ---------------------------------------------------------------------

const g = (n: number): string => {
  const s = n.toFixed(5);
  return s.includes(".") ? s : `${s}.0`;
};
const u = (n: number): string => `${Math.round(n)}u`;
/** Linear rgb at unit luminance × `peak` (the emissive ladder), GLSL. */
function lit(hex: number, peak: number): string {
  const c = new THREE.Color(hex);
  const k = peak / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
  return `vec3(${g(c.r * k)}, ${g(c.g * k)}, ${g(c.b * k)})`;
}
/** Linear rgb, GLSL. */
function linear(hex: number): string {
  const c = new THREE.Color(hex);
  return `vec3(${g(c.r)}, ${g(c.g)}, ${g(c.b)})`;
}
const band = (i: number): string => {
  const b = SHIP_LAYERS[i] as readonly [number, number];
  return `vec2(${g(b[0])}, ${g(b[1])})`;
};
const drift = (i: number): string => {
  const d = SHIP_DRIFT[i] as readonly number[];
  return `vec4(${d.map(g).join(", ")})`;
};

/** E1: bearing sectors round the camera the dogfights thin by, the most a
 * sector loses, and the real enemies in a sector that take it all. */
export const THIN_SECTORS = 8;
const THIN_MAX = 0.35;
const THIN_FULL = 40;

/**
 * The pose library, shared by every draw — common/src/skyarmada.ts in
 * GLSL, step for step (shipPoseInto, planePoseInto, flakPoseInto, skyVis).
 * E1's thinning (uSkyThin) is the one term with no CPU mirror: it only
 * fades whole groups out.
 */
const SKY_GLSL = /* glsl */ `
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
${AB_FOG_GLSL}
${AB_SKY_FOG_GLSL}
${FAR_SHELL_GLSL}
uniform float uSkyT;      // the synced clock in its loop, s
uniform vec2 uSkyOrigin;  // the unwrapped camera offset (L2's FAR_ORIGIN)
uniform float uSkySeed;   // skySeed(seed), 16 bits
uniform vec2 uSkyOuter;   // the tier's ship / plane radius, m
uniform vec3 uSkyCounts;  // the tier's ships, groups, flak slots
uniform vec3 uSkyMoon;    // the dome's moon direction
uniform float uSkyPx;     // metres per drawing-buffer pixel per metre
uniform vec2 uSkyViewport; // drawing-buffer size, px
uniform float uSkyThin[${THIN_SECTORS}]; // E1: each bearing's thinning share
const float AB_TAU = 6.28318530718;
uint abSkyHash(uint x, uint y) {
  uvec2 q = uvec2(x, y) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  n ^= n >> 15u;
  n *= 2246822519u;
  n ^= n >> 13u;
  return n;
}
float abU16(uint h, uint s) { return float((h >> s) & 0xffffu) / 65535.0; }
float abU8(uint h, uint s) { return float((h >> s) & 0xffu) / 255.0; }
float abWrapRel(float p, float o, float w) { return mod(p - o + 0.5 * w, w) - 0.5 * w; }
// skyVis × the weather (none in the deck or dust, thinner in rain — L2's
// abFarVis) × the fog's own reach.
float abSkyVis(float d, float outer, vec2 fadeIn) {
  float v = smoothstep(fadeIn.x, fadeIn.y, d);
  v *= ${g(SKY_VIS)} * exp(-(d - ${g(FOG_DISTANCE)}) / ${g(SKY_HAZE)});
  v *= 1.0 - smoothstep(outer - ${g(SKY_OUTER_FADE)}, outer, d);
  v *= (1.0 - clamp(abWeather.y, 0.0, 1.0)) / (1.0 + 0.9 * max(abWeather.x, 0.0));
  return v * smoothstep(${g(0.9 * FOG_DISTANCE)}, ${g(FOG_DISTANCE)}, fogFar);
}
// The fog colour along a ray: the sky-matched one, with the city glow.
vec3 abSkyFogC(vec3 dir) {
  return abGlowFog(abSkyFog(fogColor, dir.y), dir.y);
}
struct AbShip { vec3 p; float yaw; float pitch; float scale; float burn; float fade; };
// shipPoseInto: p.xz camera-relative, p.y the altitude.
AbShip abShipPose(uint i) {
  AbShip s;
  uint h0 = abSkyHash(i, uint(uSkySeed));
  uint h1 = abSkyHash(h0, 0x51a7u);
  uint h2 = abSkyHash(h1, 0x2b3du);
  uint l = h1 & 3u;
  uint layer = l == 3u ? 1u : l;
  vec2 bnd = layer == 0u ? ${band(0)} : (layer == 1u ? ${band(1)} : ${band(2)});
  vec4 dr = layer == 0u ? ${drift(0)} : (layer == 1u ? ${drift(1)} : ${drift(2)});
  float alt = bnd.x + abU8(h1, 8u) * (bnd.y - bnd.x);
  vec2 k = ((h1 >> 4u) & 1u) == 1u ? dr.zw : dr.xy;
  float sgn = ((h1 >> 5u) & 7u) == 0u ? -1.0 : 1.0;
  vec2 v = sgn * k * ${g(SHIP_STEP)};
  s.p.x = abWrapRel(abU16(h0, 0u) * ${g(SHIP_WINDOW)} + v.x * uSkyT, uSkyOrigin.x, ${g(SHIP_WINDOW)});
  s.p.z = abWrapRel(abU16(h0, 16u) * ${g(SHIP_WINDOW)} + v.y * uSkyT, uSkyOrigin.y, ${g(SHIP_WINDOW)});
  s.scale = ${g(SHIP_SCALE_MIN)} + ${g(SHIP_SCALE_SPAN)} * abU8(h1, 16u);
  s.yaw = atan(v.y, v.x);
  s.p.y = alt;
  s.pitch = 0.0;
  s.burn = 0.0;
  s.fade = 1.0;
  float ct = uSkyT + abU8(h2, 0u) * ${g(SHIP_CYCLE_S)};
  float c = floor(ct / ${g(SHIP_CYCLE_S)});
  float tau = ct - c * ${g(SHIP_CYCLE_S)};
  uint hb = abSkyHash(h2, uint(mod(c, ${g(SKY_LOOP_S / SHIP_CYCLE_S)})));
  if (abU8(hb, 0u) < ${g(SHIP_BURN_SHARE)}) {
    float s0 = tau - (${g(SHIP_IGNITE_S)} + abU8(hb, 8u) * ${g(SHIP_IGNITE_SPAN_S)});
    if (s0 > 0.0) {
      s.burn = min(1.0, s0 / 3.0);
      float fall = max(0.0, s0 - ${g(SHIP_BURN_HOLD_S)});
      s.p.y -= 0.5 * ${g(SHIP_FALL_G)} * fall * fall;
      s.pitch = -min(0.02 * fall, 0.5);
    }
  }
  uint hp = abSkyHash(h2, uint(mod(c - 1.0, ${g(SKY_LOOP_S / SHIP_CYCLE_S)})));
  if (abU8(hp, 0u) < ${g(SHIP_BURN_SHARE)}) {
    s.p.y += ${g(SHIP_EMERGE_RISE)} * (1.0 - smoothstep(0.0, ${g(SHIP_EMERGE_S)}, tau));
    s.fade = smoothstep(0.0, ${g(SHIP_EMERGE_FADE_S)}, tau);
  }
  return s;
}
// shipVis (the camera at cameraPosition.y), × the weather.
float abShipVis(AbShip s) {
  vec3 rel = vec3(s.p.x, s.p.y - cameraPosition.y, s.p.z);
  float dn = max(length(rel) - ${g(SHIP_HALF_LEN)} * s.scale, 0.0);
  if (s.p.y + 30.0 * s.scale < 0.0) return 0.0;
  return abSkyVis(dn, uSkyOuter.x, vec2(${g(SHIP_FADE_IN[0])}, ${g(SHIP_FADE_IN[1])})) * s.fade;
}
// The ship's frame: +X the nose (pitched), +Y up, +Z starboard.
vec3 abShipLocal(AbShip s, vec3 lp) {
  vec3 q = lp * s.scale;
  float cp = cos(s.pitch);
  float sp = sin(s.pitch);
  q = vec3(q.x * cp - q.y * sp, q.x * sp + q.y * cp, q.z);
  float cy = cos(s.yaw);
  float sy = sin(s.yaw);
  return vec3(q.x * cy - q.z * sy, q.y, q.x * sy + q.z * cy);
}
struct AbPlane { vec3 p; vec3 dir; float bank; float present; float burn; float hitAge; float fade; float firing; };
// planePoseInto: p.xz camera-relative, p.y the altitude.
AbPlane abPlanePose(uint gi, uint m) {
  AbPlane P;
  uint h0 = abSkyHash(gi, uint(uSkySeed) ^ 0xd06fu);
  uint h1 = abSkyHash(h0, 0x6f1du);
  uint h2 = abSkyHash(h1, 0x3c5au);
  uint size = 2u + ((h1 >> 6u) & 3u) % 3u;
  P.present = m < size ? 1.0 : 0.0;
  float fm = float(m);
  float kx = float(h1 & 7u) - 3.0;
  float kz = float((h1 >> 3u) & 7u) - 3.0;
  float cx = abU16(h0, 0u) * ${g(PLANE_WINDOW)} + kx * ${g(PLANE_STEP)} * uSkyT;
  float cz = abU16(h0, 16u) * ${g(PLANE_WINDOW)} + kz * ${g(PLANE_STEP)} * uSkyT;
  float alt = ${g(GROUP_ALT[0])} + abU8(h1, 8u) * ${g(GROUP_ALT[1] - GROUP_ALT[0])};
  uint kind = (h1 >> 20u) & 1u;
  float r = ${g(GROUP_R[0])} + abU8(h1, 24u) * ${g(GROUP_R[1] - GROUP_R[0])} + (m >= 2u ? 12.0 : 0.0);
  float turns = ${g(GROUP_TURNS[0])} + float(h2 & 127u);
  float dir = ((h2 >> 7u) & 1u) == 1u ? 1.0 : -1.0;
  float w = dir * AB_TAU * turns / ${g(SKY_LOOP_S)};
  float bob = ${g(GROUP_BOB[0])} + abU8(h2, 16u) * ${g(GROUP_BOB[1] - GROUP_BOB[0])};
  float cyc = fract(turns * uSkyT / ${g(SKY_LOOP_S)} + abU8(h2, 8u));
  float th = dir * AB_TAU * cyc - fm * ${g(GROUP_LAG)} * dir;
  float sn = sin(th);
  float cs = cos(th);
  vec2 cp;
  vec2 cv;
  vec2 ca;
  if (kind == 0u) {
    cp = r * vec2(cs, sn);
    cv = r * vec2(-sn, cs);
    ca = r * vec2(-cs, -sn);
  } else {
    cp = r * vec2(sn, sn * cs);
    cv = r * vec2(cs, cs * cs - sn * sn);
    ca = r * vec2(-sn, -4.0 * sn * cs);
  }
  float x = cx + cp.x;
  float z = cz + cp.y;
  float y = alt + bob * sin(th + fm);
  vec3 vel = vec3(cv.x * w, bob * cos(th + fm) * w, cv.y * w);
  vec2 acc = ca * w * w;
  float vh = max(length(vel.xz), 1.0);
  P.bank = atan((vel.x * acc.y - vel.z * acc.x) / vh / 9.8);
  P.burn = 0.0;
  P.hitAge = -1.0;
  P.fade = 1.0;
  float ct = uSkyT + abU8(h2, 24u) * ${g(GROUP_CYCLE_S)};
  float c = floor(ct / ${g(GROUP_CYCLE_S)});
  float tau = ct - c * ${g(GROUP_CYCLE_S)};
  uint hb = abSkyHash(h2 ^ 0x6b11u, uint(mod(c, ${g(SKY_LOOP_S / GROUP_CYCLE_S)})));
  bool kill = abU8(hb, 0u) < ${g(GROUP_KILL_SHARE)};
  float hit = kill ? ${g(GROUP_HIT_S)} + abU8(hb, 8u) * ${g(GROUP_HIT_SPAN_S)} : 1e9;
  P.firing = (m > 0u && m < size && tau < hit + 1.0
    && fract(${g(GROUP_BURST_TURNS)} * uSkyT / ${g(SKY_LOOP_S)} + fm * 0.37 + abU8(h0, 8u)) < ${g(GROUP_BURST_SHARE)}) ? 1.0 : 0.0;
  if (m == 0u && kill && tau > hit) {
    float s = tau - hit;
    float glide = 3.0 * (1.0 - exp(-s / 3.0));
    float spr = 22.0 * min(1.0, s / 2.0);
    x += vel.x * glide + spr * cos(2.2 * s);
    z += vel.z * glide + spr * sin(2.2 * s);
    y -= 0.5 * ${g(GROUP_FALL_G)} * s * s;
    vel.xz *= exp(-s / 3.0);
    vel.y = -${g(GROUP_FALL_G)} * s - 5.0;
    P.bank = 2.2 * s;
    P.burn = min(1.0, s / 0.6);
    P.hitAge = s;
  }
  uint hp = abSkyHash(h2 ^ 0x6b11u, uint(mod(c - 1.0, ${g(SKY_LOOP_S / GROUP_CYCLE_S)})));
  if (m == 0u && abU8(hp, 0u) < ${g(GROUP_KILL_SHARE)}) {
    y += ${g(GROUP_EMERGE_RISE)} * (1.0 - smoothstep(0.0, ${g(GROUP_EMERGE_S)}, tau));
    P.fade = smoothstep(0.0, ${g(GROUP_EMERGE_FADE_S)}, tau);
  }
  P.p = vec3(abWrapRel(x, uSkyOrigin.x, ${g(PLANE_WINDOW)}), y, abWrapRel(z, uSkyOrigin.y, ${g(PLANE_WINDOW)}));
  P.dir = vel / max(length(vel), 1e-3);
  // E1: thinner where the real air force is dense — the group's bearing
  // picks its sector's share (uSkyThin), and a group whose own hash is under
  // it fades out over a small band (never pops) as the share moves.
  vec2 gc = vec2(abWrapRel(cx, uSkyOrigin.x, ${g(PLANE_WINDOW)}), abWrapRel(cz, uSkyOrigin.y, ${g(PLANE_WINDOW)}));
  int sec = int(floor((atan(gc.x, gc.y) + ${g(Math.PI)}) * ${g(THIN_SECTORS / (2 * Math.PI))})) % ${THIN_SECTORS};
  float hv = abU16(abSkyHash(gi, 0x7e1au), 0u);
  P.fade *= smoothstep(uSkyThin[sec], uSkyThin[sec] + 0.08, hv);
  return P;
}
float abPlaneVis(AbPlane P) {
  if (P.present < 0.5 || P.p.y < 0.0) return 0.0;
  float d = length(vec3(P.p.x, P.p.y - cameraPosition.y, P.p.z));
  return abSkyVis(d, uSkyOuter.y, vec2(${g(PLANE_FADE_IN[0])}, ${g(PLANE_FADE_IN[1])})) * P.fade;
}
// The plane's frame: x the nose, y up (banked), z the right wing.
mat3 abPlaneFrame(AbPlane P) {
  vec3 f = P.dir;
  vec3 r = cross(f, vec3(0.0, 1.0, 0.0));
  r = dot(r, r) > 1e-4 ? normalize(r) : vec3(0.0, 0.0, 1.0);
  vec3 up = cross(r, f);
  float cb = cos(P.bank);
  float sb = sin(P.bank);
  vec3 r2 = r * cb - up * sb;
  vec3 up2 = up * cb + r * sb;
  return mat3(f, up2, r2);
}
// flakPoseInto: xyz the burst (x/z camera-relative), w its age, s.
vec4 abFlakPose(uint f) {
  uint h = abSkyHash(f, uint(uSkySeed) ^ 0xf1a4u);
  float turns = ${g(FLAK_TURNS[0])} + float(h & 511u);
  float cyc = turns * uSkyT / ${g(SKY_LOOP_S)} + abU8(h, 9u);
  float c = floor(cyc);
  float age = (cyc - c) * ${g(SKY_LOOP_S)} / turns;
  uint hc = abSkyHash(h, uint(mod(c, turns)));
  AbShip s = abShipPose((f * 4u + 1u) % ${u(SHIP_SLOTS)});
  float a = abU8(hc, 0u) * AB_TAU;
  float side = ${g(FLAK_SIDE[0])} + abU8(hc, 8u) * ${g(FLAK_SIDE[1] - FLAK_SIDE[0])};
  float y = min(s.p.y, ${g(CLOUD_BASE - 40)}) - (${g(FLAK_BELOW[0])} + abU8(hc, 16u) * ${g(FLAK_BELOW[1] - FLAK_BELOW[0])});
  return vec4(s.p.x + side * cos(a), y, s.p.z + side * sin(a), age);
}
`;

/** The vertex shaders' half: where a camera-relative point is drawn — the
 * shell. */
const SKY_VERTEX_GLSL = /* glsl */ `
${SKY_GLSL}
vec4 abSkyClip(vec3 rel) {
  return projectionMatrix * viewMatrix * vec4(cameraPosition + abFarShell(rel), 1.0);
}
`;

// --- 1. The armada ------------------------------------------------------------

const HULL_DARK = 0x2a2c30;
const HULL_MOON = 0xbccbe8; // sky.ts DUSK.moon (as L2)
const FIRE_COLOR = 0xff6a20;

const ARMADA_VERTEX = /* glsl */ `
${SKY_VERTEX_GLSL}
attribute float aPart; // 0 envelope, 1 fins, 2 cars
varying vec3 vRel;
varying vec3 vNormal;
varying vec3 vLocal;
flat varying vec4 vInfo; // vis, burn, seed, part
void main() {
  uint i = uint(gl_InstanceID);
  AbShip s = abShipPose(i);
  float vis = float(gl_InstanceID) < uSkyCounts.x ? abShipVis(s) : 0.0;
  if (vis <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // behind the far plane: culled
    return;
  }
  vec3 rel = vec3(s.p.x, s.p.y - cameraPosition.y, s.p.z) + abShipLocal(s, position);
  vRel = rel;
  vNormal = abShipLocal(AbShip(vec3(0.0), s.yaw, s.pitch, 1.0, 0.0, 1.0), normal);
  vLocal = position;
  vInfo = vec4(vis, s.burn, float(abSkyHash(i, 77u) & 0xffffu) / 65535.0, aPart);
  gl_Position = abSkyClip(rel);
}
`;

const ARMADA_FRAGMENT = /* glsl */ `
${SKY_GLSL}
varying vec3 vRel;
varying vec3 vNormal;
varying vec3 vLocal;
flat varying vec4 vInfo;
void main() {
  float d = length(vRel);
  vec3 dir = vRel / max(d, 1.0);
  vec3 fogC = abSkyFogC(dir);
  vec3 n = normalize(vNormal);
  float seed = vInfo.z;
  // Doped fabric, a shade per ship; darker cars and fins.
  vec3 col = ${linear(HULL_DARK)} * (0.75 + 0.5 * seed) * (vInfo.w > 0.5 ? 0.6 : 1.0);
  // Moonlight on the faces turned to it, the burning city's glow from
  // below (its colour is the fog's own glow, so it reads as the same air).
  float moon = max(dot(n, uSkyMoon), 0.0);
  float under = max(-n.y, 0.0);
  col *= 0.25 + 0.6 * moon * ${linear(HULL_MOON)} + abCityGlow.rgb * (6.0 + 10.0 * under);
  vec3 em = vec3(0.0);
  // Burning: the aft envelope glows through, flickering.
  float burn = vInfo.y;
  if (burn > 0.0) {
    float aft = smoothstep(40.0, -60.0, vLocal.x);
    float fl = 0.7 + 0.3 * sin(uSkyT * 9.0 + seed * 40.0 + vLocal.x * 0.15);
    em += ${lit(FIRE_COLOR, 0.65)} * burn * aft * fl;
  }
  gl_FragColor = vec4(mix(fogC, col + em, vInfo.x), 1.0);
}
`;

/** Push a two-sided quad (fins). */
function quad2(
  pos: number[],
  nor: number[],
  part: number[],
  idx: number[],
  q: readonly (readonly [number, number, number])[],
  n: readonly [number, number, number],
  p: number,
): void {
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (const v of q) {
      pos.push(v[0], v[1], v[2]);
      nor.push(n[0] * side, n[1] * side, n[2] * side);
      part.push(p);
    }
    if (side > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}

/** Push an axis-aligned box (centre, half sizes), outward faces. */
function box(
  pos: number[],
  nor: number[],
  part: number[],
  idx: number[],
  c: readonly [number, number, number],
  h: readonly [number, number, number],
  p: number,
): void {
  const faces: [number[], number[][]][] = [
    [
      [1, 0, 0],
      [
        [1, -1, -1],
        [1, 1, -1],
        [1, 1, 1],
        [1, -1, 1],
      ],
    ],
    [
      [-1, 0, 0],
      [
        [-1, -1, 1],
        [-1, 1, 1],
        [-1, 1, -1],
        [-1, -1, -1],
      ],
    ],
    [
      [0, 1, 0],
      [
        [-1, 1, -1],
        [-1, 1, 1],
        [1, 1, 1],
        [1, 1, -1],
      ],
    ],
    [
      [0, -1, 0],
      [
        [-1, -1, 1],
        [-1, -1, -1],
        [1, -1, -1],
        [1, -1, 1],
      ],
    ],
    [
      [0, 0, 1],
      [
        [-1, -1, 1],
        [1, -1, 1],
        [1, 1, 1],
        [-1, 1, 1],
      ],
    ],
    [
      [0, 0, -1],
      [
        [1, -1, -1],
        [-1, -1, -1],
        [-1, 1, -1],
        [1, 1, -1],
      ],
    ],
  ];
  for (const [n, q] of faces) {
    const base = pos.length / 3;
    for (const v of q) {
      pos.push(
        c[0] + (v[0] as number) * h[0],
        c[1] + (v[1] as number) * h[1],
        c[2] + (v[2] as number) * h[2],
      );
      nor.push(n[0] as number, n[1] as number, n[2] as number);
      part.push(p);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** Radius of BOSS_PROFILE at x (linear between stations). */
function profileAt(x: number): number {
  for (let i = 1; i < BOSS_PROFILE.length; i++) {
    const a = BOSS_PROFILE[i - 1] as readonly [number, number];
    const b = BOSS_PROFILE[i] as readonly [number, number];
    if (x <= b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  return 0;
}

/** The cosmetic hull: BOSS_PROFILE lathed at a far LOD (every other
 * station, 10 sides), the cruciform tail, the control car and two engine
 * cars. Hull frame, m: +X the nose, +Y up, +Z starboard. */
export function armadaGeometry(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];
  const stations = BOSS_PROFILE.filter(
    (_, i) => i % 2 === 0 || i === BOSS_PROFILE.length - 1,
  );
  const sides = 10;
  const row = sides + 1;
  stations.forEach(([x, r], i) => {
    const prev = stations[i - 1] ?? stations[i];
    const next = stations[i + 1] ?? stations[i];
    const slope =
      prev && next && next[0] !== prev[0]
        ? (next[1] - prev[1]) / (next[0] - prev[0])
        : 0;
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const ny = Math.cos(a);
      const nz = Math.sin(a);
      pos.push(x, r * ny, r * nz);
      const len = Math.hypot(slope, 1);
      nor.push(-slope / len, ny / len, nz / len);
      part.push(0);
    }
  });
  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * row + j;
      idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  // The cruciform tail: four fins from the ogive out, sweeping aft.
  const x0 = -122;
  const x1 = -86;
  const r0 = profileAt(x0);
  const r1 = profileAt(x1);
  const span = 17;
  for (const [ay, az] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const at = (x: number, r: number): [number, number, number] => [
      x,
      r * ay,
      r * az,
    ];
    const q = [
      at(x0, r0),
      at(x1, r1),
      at(x1 - 8, r1 + span * 0.7),
      at(x0, r0 + span),
    ] as const;
    // The fin's plane contains the hull axis and (ay, az): its normal is
    // the other radial direction.
    quad2(pos, nor, part, idx, q, [0, az, -ay], 1);
  }
  // The control car, forward under the envelope; two engine cars aft.
  box(pos, nor, part, idx, [78, -21.5, 0], [12, 3.5, 3.5], 2);
  for (const z of [-17, 17]) {
    box(pos, nor, part, idx, [-30, -14, z], [7, 2.6, 2.6], 2);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  geo.setIndex(idx);
  return geo;
}

// --- 2. The dogfights' planes -------------------------------------------------

const PLANE_VERTEX = /* glsl */ `
${SKY_VERTEX_GLSL}
varying vec3 vRel;
varying vec3 vNormal;
flat varying vec2 vInfo; // vis, burn
void main() {
  uint id = uint(gl_InstanceID);
  uint gi = id / ${u(GROUP_SIZE_MAX)};
  AbPlane P = abPlanePose(gi, id - gi * ${u(GROUP_SIZE_MAX)});
  float vis = float(gi) < uSkyCounts.y ? abPlaneVis(P) : 0.0;
  if (vis <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  mat3 fr = abPlaneFrame(P);
  vec3 rel = vec3(P.p.x, P.p.y - cameraPosition.y, P.p.z) + fr * (position * ${g(PLANE_SCALE)});
  vRel = rel;
  vNormal = fr * normal;
  vInfo = vec2(vis, P.burn);
  gl_Position = abSkyClip(rel);
}
`;

const PLANE_FRAGMENT = /* glsl */ `
${SKY_GLSL}
varying vec3 vRel;
varying vec3 vNormal;
flat varying vec2 vInfo;
void main() {
  float d = length(vRel);
  vec3 dir = vRel / max(d, 1.0);
  vec3 fogC = abSkyFogC(dir);
  vec3 n = normalize(vNormal);
  vec3 col = ${linear(0x23262b)} * (0.3 + 0.6 * max(dot(n, uSkyMoon), 0.0) + abCityGlow.rgb * 12.0);
  col += ${lit(FIRE_COLOR, 0.5)} * vInfo.y;
  gl_FragColor = vec4(mix(fogC, col, vInfo.x), 1.0);
}
`;

/** A ~1.5k-triangle airframe is a few pixels out here: fuselage, wing,
 * tailplane and fin as boxes (x the nose, y up, z the right wing), m. */
export function planeGeometry(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];
  box(pos, nor, part, idx, [0, 0, 0], [4.3, 0.6, 0.55], 0);
  box(pos, nor, part, idx, [1, 0.1, 0], [0.9, 0.08, 5.5], 0);
  box(pos, nor, part, idx, [-3.9, 0.2, 0], [0.5, 0.06, 2], 0);
  box(pos, nor, part, idx, [-3.9, 1, 0], [0.55, 0.9, 0.06], 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

// --- 3. FX --------------------------------------------------------------------

/** Lights on the emissive ladder (peak linear luminance), before the far
 * haze attenuates them — cosmetic tracers sit under the real ones. */
const NAV_RED = lit(0xff2418, EMISSIVE_NAVLIGHT);
const NAV_GREEN = lit(0x30ff60, EMISSIVE_NAVLIGHT);
const NAV_WHITE = lit(0xffffff, EMISSIVE_NAVLIGHT * 0.8);
const BEACON = lit(0xff3020, EMISSIVE_STROBE);
const ENGINE = lit(0xffa050, EMISSIVE_EXHAUST);
const FIRE = lit(FIRE_COLOR, EMISSIVE_FIRE);
const TRACER = lit(0xffc860, EMISSIVE_FIRE);
const MUZZLE = lit(0xfff0c0, EMISSIVE_STROBE);
const FLAK = lit(0xffe0b0, EMISSIVE_FIRE);
const SMOKE = linear(0x101113);
const SMOKE_FIRELIT = lit(0xff7030, 0.35);

const FX_VERTEX = /* glsl */ `
${SKY_VERTEX_GLSL}
varying vec2 vUv;
flat varying vec4 vColA; // premultiplied rgb, alpha (0: additive)
flat varying vec4 vColB; // the streak's far end
flat varying float vShape; // 0 glow, 1 streak, 2 smoke streak, 3 puff
void main() {
  int id = gl_InstanceID;
  int ns = int(uSkyCounts.x) * ${SHIP_FX};
  int np = int(uSkyCounts.y) * ${GROUP_SIZE_MAX * PLANE_FX};
  int nf = int(uSkyCounts.z) * ${FLAK_FX};
  vec3 A = vec3(0.0);
  vec3 B = vec3(0.0);
  float sizeM = 0.0;  // the quad's world width, m
  float minPx = 2.0;  // its floor, px (the energy is kept: alpha pays)
  vec4 colA = vec4(0.0);
  vec4 colB = vec4(0.0);
  float shape = 0.0;
  float vis = 0.0;
  float camY = cameraPosition.y;
  if (id < ns) {
    int i = id / ${SHIP_FX};
    int k = id - i * ${SHIP_FX};
    AbShip s = abShipPose(uint(i));
    vis = abShipVis(s);
    vec3 c = vec3(s.p.x, s.p.y - camY, s.p.z);
    float ph = float(abSkyHash(uint(i), 91u) & 0xffffu) / 65535.0;
    if (k == 0) { // port, red
      A = c + abShipLocal(s, vec3(10.0, 0.0, -21.5));
      sizeM = 7.0;
      colA.rgb = ${NAV_RED};
    } else if (k == 1) { // starboard, green
      A = c + abShipLocal(s, vec3(10.0, 0.0, 21.5));
      sizeM = 7.0;
      colA.rgb = ${NAV_GREEN};
    } else if (k == 2) { // the tail light
      A = c + abShipLocal(s, vec3(-127.0, 0.0, 0.0));
      sizeM = 6.0;
      colA.rgb = ${NAV_WHITE};
    } else if (k == 3) { // the beacon on the spine, a slow blink
      A = c + abShipLocal(s, vec3(20.0, 21.5, 0.0));
      sizeM = 8.0;
      float bl = fract(uSkyT * ${g(2400 / SKY_LOOP_S)} + ph);
      colA.rgb = ${BEACON} * (bl < 0.12 ? 1.0 : 0.0);
    } else if (k == 4) { // the engine cars' glow
      A = c + abShipLocal(s, vec3(-38.0, -14.0, 0.0));
      sizeM = 22.0;
      colA.rgb = ${ENGINE} * (0.8 + 0.2 * sin(uSkyT * 13.0 + ph * 30.0));
    } else if (k == 5) { // fire glow on the haze
      A = c + abShipLocal(s, vec3(-25.0, 0.0, 0.0));
      float fl = 0.75 + 0.25 * sin(uSkyT * 7.0 + ph * 50.0) * sin(uSkyT * 3.1 + ph * 20.0);
      sizeM = 170.0 * s.scale * (0.6 + 0.4 * s.burn) * fl;
      minPx = 3.0;
      colA.rgb = ${FIRE} * s.burn * 0.8;
    } else { // the smoke column, rising and trailing aft
      A = c + abShipLocal(s, vec3(-30.0, 8.0, 0.0));
      vec3 back = vec3(-cos(s.yaw), 0.0, -sin(s.yaw));
      B = A + vec3(0.0, 300.0, 0.0) * s.burn + back * 90.0;
      sizeM = 60.0 * s.scale + 30.0;
      minPx = 3.0;
      shape = 2.0;
      colA = vec4(${SMOKE_FIRELIT} * 0.6, 0.85) * s.burn;
      colB = vec4(${SMOKE} * 0.15, 0.0) * s.burn;
    }
    // Lights carry through the haze a little better than a hull.
    vis = min(1.0, vis * (shape > 1.5 ? 1.0 : 1.3));
  } else if (id < ns + np) {
    int j = id - ns;
    int k = j / ${GROUP_SIZE_MAX * PLANE_FX};
    int r = j - k * ${GROUP_SIZE_MAX * PLANE_FX};
    int m = r / ${PLANE_FX};
    int e = r - m * ${PLANE_FX};
    AbPlane P = abPlanePose(uint(k), uint(m));
    vis = min(1.0, 1.3 * abPlaneVis(P));
    vec3 c = vec3(P.p.x, P.p.y - camY, P.p.z);
    if (e == 0) { // the exhaust / nav light
      A = c - P.dir * 3.0;
      sizeM = 3.5;
      colA.rgb = m == 0 ? ${NAV_RED} * 0.7 : ${ENGINE} * 0.7;
    } else if (e <= 2) { // two tracer streaks toward the hunted one
      if (P.firing > 0.5) {
        AbPlane L = abPlanePose(uint(k), 0u);
        vec3 tc = vec3(L.p.x, L.p.y - camY, L.p.z);
        vec3 to = tc - c;
        to -= ${g(PLANE_WINDOW)} * floor(to / ${g(PLANE_WINDOW)} + 0.5);
        float u = fract(uSkyT * 3.0 + float(m) * 0.31 + (e == 2 ? 0.5 : 0.0));
        vec3 dv = normalize(to);
        A = c + P.dir * 6.0 + to * (0.85 * u);
        B = A + dv * 30.0;
        sizeM = 1.4;
        minPx = 1.5;
        shape = 1.0;
        colA.rgb = ${TRACER} * (1.0 - 0.6 * u);
      }
    } else if (e == 3) { // muzzle sparkle
      if (P.firing > 0.5) {
        A = c + P.dir * 5.0 * ${g(PLANE_SCALE)};
        float fl = step(0.45, fract(uSkyT * 23.0 + float(m) * 0.29));
        sizeM = 7.0;
        colA.rgb = ${MUZZLE} * fl;
      }
    } else if (e == 4) { // shot down: the burst, then the fire
      if (P.hitAge >= 0.0) {
        A = c;
        float burst = exp(-P.hitAge * 4.0);
        sizeM = 12.0 + 60.0 * burst;
        minPx = 2.5;
        colA.rgb = ${FIRE} * (0.6 + 1.2 * burst) * (0.8 + 0.2 * sin(uSkyT * 21.0 + float(k)));
      }
    } else { // ... and its smoke, trailing up the fall
      if (P.hitAge >= 0.0) {
        A = c;
        B = c - P.dir * min(P.hitAge * 45.0, 180.0);
        sizeM = 9.0;
        minPx = 2.0;
        shape = 2.0;
        colA = vec4(${SMOKE_FIRELIT} * 0.7, 0.8);
        colB = vec4(${SMOKE} * 0.2, 0.0);
      }
    }
  } else if (id < ns + np + nf) {
    int j = id - ns - np;
    int f = j / ${FLAK_FX};
    int e = j - f * ${FLAK_FX};
    vec4 fp = abFlakPose(uint(f));
    A = vec3(fp.x, fp.y - camY, fp.z);
    float d0 = length(A);
    vis = abSkyVis(d0, uSkyOuter.x, vec2(${g(SHIP_FADE_IN[0])}, ${g(SHIP_FADE_IN[1])}));
    float age = fp.w;
    if (e == 0) { // the flash
      float k = clamp(1.0 - age / 0.3, 0.0, 1.0);
      sizeM = 14.0 + 70.0 * age;
      minPx = 2.5;
      colA.rgb = ${FLAK} * k * k * 1.6;
      vis = min(1.0, 1.3 * vis);
    } else { // the puff it leaves
      float k = smoothstep(0.03, 0.25, age) * (1.0 - smoothstep(1.0, 3.5, age));
      sizeM = 16.0 + 10.0 * age;
      shape = 3.0;
      colA = vec4(${SMOKE} * 0.6, 0.75) * k;
    }
  }
  float intensity = max(max(colA.r, colA.g), max(colA.b, colA.a)) + max(colB.a, 0.0);
  if (vis <= 0.0 || intensity <= 0.0 || sizeM <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  if (shape < 0.5 || shape > 2.5) B = A;
  vec4 ca = abSkyClip(A);
  vec4 cb = abSkyClip(B);
  if (ca.w <= 0.0 || cb.w <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec2 hv = 0.5 * uSkyViewport;
  vec2 sa = ca.xy / ca.w * hv;
  vec2 sb = cb.xy / cb.w * hv;
  // True width in px, and the floor: never under minPx, alpha pays (the
  // O5 point floor: the area ratio, then a linear fade below 1 px).
  float px = sizeM / max(length(A) * uSkyPx, 1e-4);
  float drawPx = max(px, minPx);
  float fk = max(px, 1.0) / drawPx;
  float floorA = px >= minPx ? 1.0 : (shape > 0.5 && shape < 2.5 ? fk : fk * fk) * min(px, 1.0);
  vec2 ax = sb - sa;
  float len = length(ax);
  vec2 dir = len > 0.5 ? ax / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float t = position.x * 0.5 + 0.5;
  vec2 sp = mix(sa, sb, t) + dir * position.x * drawPx * 0.5 + nrm * position.y * drawPx * 0.5;
  float z = mix(ca.z / ca.w, cb.z / cb.w, t);
  gl_Position = vec4(sp / hv, z, 1.0);
  vUv = vec2(len > 0.5 ? t : position.x, position.y);
  float a = vis * floorA;
  vColA = colA * a;
  vColB = colB * a;
  vShape = shape;
}
`;

const FX_FRAGMENT = /* glsl */ `
varying vec2 vUv;
flat varying vec4 vColA;
flat varying vec4 vColB;
flat varying float vShape;
void main() {
  vec4 c;
  if (vShape < 0.5) {
    float r2 = dot(vUv, vUv);
    if (r2 > 1.0) discard;
    float k = exp(-r2 * 3.5) - 0.03;
    c = vColA * max(k, 0.0);
  } else if (vShape < 1.5) {
    float k = exp(-vUv.y * vUv.y * 3.0);
    c = vColA * k;
  } else if (vShape < 2.5) {
    // Smoke: fire-lit at its root, dark and thinning up the column.
    float across = max(1.0 - vUv.y * vUv.y, 0.0);
    float t = clamp(vUv.x, 0.0, 1.0);
    c = mix(vColA, vColB, pow(t, 0.6)) * across * (1.0 - t * t);
  } else {
    float r2 = dot(vUv, vUv);
    if (r2 > 1.0) discard;
    c = vColA * (1.0 - r2) * (1.0 - r2);
  }
  gl_FragColor = c;
}
`;

function fxGeometry(): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
      3,
    ),
  );
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

// --- 4. The painted horizon ---------------------------------------------------

/** The painted layers: true distance (m), cruise altitude (m), cells round
 * the horizon, drift (whole turns per loop), peak alpha. */
const HORIZON_LAYERS = [
  [7000, 560, 150, 2, 0.34],
  [9500, 585, 210, 1, 0.26],
  [13000, 600, 300, -1, 0.19],
] as const;
/** The ring's true radius, m: past every layer (the shell keeps it inside
 * the fog limit, behind the far city). */
const HORIZON_R = 20000;

const HORIZON_VERTEX = /* glsl */ `
${SKY_VERTEX_GLSL}
varying vec3 vRel;
void main() {
  // position: (cos, h, sin) of the ring, h a slope (rise / run).
  vec3 rel = vec3(position.x, position.y, position.z) * ${g(HORIZON_R)};
  vRel = rel;
  gl_Position = abSkyClip(rel);
}
`;

const HORIZON_FRAGMENT = /* glsl */ `
${SKY_GLSL}
varying vec3 vRel;
// One painted layer: its silhouettes (alpha) and its lights and flak (rgb,
// additive), at azimuth phi and elevation el (rad) of this pixel's ray.
vec4 abPaint(float phi, float el, float dist, float alt, float cells, float turns, float peak, float salt, float fw) {
  float rot = turns * AB_TAU * uSkyT / ${g(SKY_LOOP_S)};
  float a = (phi + rot) / AB_TAU * cells;
  float ci = floor(a);
  uint h = abSkyHash(uint(mod(ci, cells)), uint(uSkySeed) ^ uint(salt));
  float present = abU8(h, 0u) < 0.62 ? 1.0 : 0.0;
  // The ship: a cigar of 120–260 m, its centre within the cell.
  float len = (120.0 + 140.0 * abU8(h, 8u)) / dist;          // rad
  float cx = (ci + 0.25 + 0.5 * abU8(h, 16u)) / cells * AB_TAU - rot;
  float dphi = phi - cx;
  dphi -= AB_TAU * floor(dphi / AB_TAU + 0.5);
  float ce = atan(alt - 40.0 + 80.0 * abU8(h, 24u) - cameraPosition.y, dist);
  float uu = dphi / (0.5 * len);
  float vv = (el - ce) / (0.5 * len * 0.18);
  float body = sqrt(max(1.0 - uu * uu, 0.0));
  float edge = abs(vv) - body;
  float px = max(fw / (0.5 * len * 0.18), 1e-4);
  float sil = present * (1.0 - smoothstep(-px, px, edge));
  // A running light at each end, a warm car under the middle: soft dots
  // never under ~1.5 px.
  float r = max(fw * 1.5, 0.25 * len * 0.18);
  float dn = length(vec2(dphi - 0.47 * len, el - ce));
  float dt = length(vec2(dphi + 0.47 * len, el - ce));
  float dc = length(vec2(dphi, el - ce + 0.6 * len * 0.18));
  float sz = fw / r;
  // Only some ships show their lights this far out (a blackout fleet), and
  // dimly: the horizon must read as haze with sparks, not a light string.
  float lights = abU8(h, 12u) < 0.35 ? 0.3 : 0.0;
  vec3 em = present * lights * (${NAV_RED} * exp(-dn * dn / (r * r)) + ${NAV_WHITE} * exp(-dt * dt / (r * r))
    + ${ENGINE} * 0.6 * exp(-dc * dc / (r * r))) * min(sz * sz * 2.0, 1.0);
  // Flak under the layer: a cell's burst each few seconds.
  float bt = uSkyT * ${g(1200 / SKY_LOOP_S)} + abU8(h, 4u);
  float bc = floor(bt);
  uint hf = abSkyHash(h, uint(mod(bc, 1200.0)));
  float age = (bt - bc) * 3.0;
  float on = abU8(hf, 0u) < 0.45 ? exp(-age * 7.0) : 0.0;
  vec2 fpos = vec2(cx + (abU8(hf, 8u) - 0.5) * 2.0 / cells * AB_TAU * 0.5, ce - (0.4 + abU8(hf, 16u)) * len * 0.3);
  vec2 fd = vec2(phi - fpos.x - AB_TAU * floor((phi - fpos.x) / AB_TAU + 0.5), el - fpos.y);
  float fr = max(fw * 2.0, (18.0 + 50.0 * (1.0 - exp(-age * 6.0))) / dist);
  em += ${FLAK} * on * exp(-dot(fd, fd) / (fr * fr)) * min(fw * fw * 4.0 / (fr * fr), 1.0) * 3.0;
  return vec4(em * peak, sil * peak);
}
void main() {
  vec3 dir = normalize(vRel);
  float phi = atan(dir.z, dir.x);
  float el = asin(clamp(dir.y, -1.0, 1.0));
  // The pixel's angular size (rad), from the elevation's screen derivative.
  float fw = max(fwidth(el), 1e-5);
  vec4 acc = vec4(0.0);
${HORIZON_LAYERS.map(
  ([d, alt, cells, turns, peak], i) =>
    `  acc += abPaint(phi, el, ${g(d)}, ${g(alt)}, ${g(cells)}, ${g(turns)}, ${g(peak)}, ${g(0x7a11 + i * 977)}, fw) * (1.0 - acc.a);`,
).join("\n")}
  // The far haze: the weather and the fog's reach, as everything here.
  float w = (1.0 - clamp(abWeather.y, 0.0, 1.0)) / (1.0 + 0.9 * max(abWeather.x, 0.0))
    * smoothstep(${g(0.9 * FOG_DISTANCE)}, ${g(FOG_DISTANCE)}, fogFar);
  // Silhouettes darker than the air behind them, lit from below by the
  // burning city.
  vec3 fogC = abSkyFogC(dir);
  vec3 sil = fogC * 0.45 + abCityGlow.rgb * 2.0;
  float a = acc.a * w;
  gl_FragColor = vec4(sil * a + acc.rgb * w, a);
}
`;

function horizonGeometry(): THREE.BufferGeometry {
  const seg = 96;
  const lo = -0.03; // just under the horizon (the carpet covers below)
  const hi = 0.2; // ~11° up
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= seg; j++) {
    const a = (j / seg) * Math.PI * 2;
    pos.push(Math.cos(a), lo, Math.sin(a), Math.cos(a), hi, Math.sin(a));
  }
  for (let j = 0; j < seg; j++) {
    const b = j * 2;
    // Seen from inside (the camera at the centre).
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

// --- The layer ----------------------------------------------------------------

/** The cosmetic sky: four draws, uniforms only per frame. */
export class SkyArmada {
  readonly armada: THREE.Mesh;
  readonly planes: THREE.Mesh;
  readonly fx: THREE.Mesh;
  readonly horizon: THREE.Mesh;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly armadaGeo = armadaGeometry();
  private readonly planeGeo = planeGeometry();
  private readonly fxGeo = fxGeometry();
  /** `?armada=0` (the perf A/B) keeps all four hidden. */
  private readonly enabled: boolean;
  /** The tier's counts — QA read-back. */
  counts = skyArmadaCounts(1);

  /** `moonDir`: the dome's moon direction uniform, shared by reference. */
  constructor(seed: number, moonDir: { value: THREE.Vector3 }, enabled = true) {
    this.enabled = enabled;
    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uSkyT: { value: 0 },
      uSkyOrigin: FAR_ORIGIN,
      uSkySeed: { value: skySeed(seed) },
      uSkyOuter: { value: new THREE.Vector2() },
      uSkyCounts: { value: new THREE.Vector3() },
      uSkyMoon: moonDir,
      uSkyPx: { value: 0.001 },
      uSkyViewport: { value: new THREE.Vector2(1, 1) },
      uSkyThin: { value: this.thin },
    };
    const opaque = (
      vertexShader: string,
      fragmentShader: string,
      key: string,
    ) => {
      const m = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader,
        fragmentShader,
        // Feeds fogColor/fogNear/fogFar live; the shaders fog themselves.
        fog: true,
        side: THREE.FrontSide,
      });
      m.customProgramCacheKey = () => key;
      return m;
    };
    const blended = (
      vertexShader: string,
      fragmentShader: string,
      key: string,
    ) => {
      const m = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader,
        fragmentShader,
        fog: true,
        transparent: true,
        depthWrite: false,
        // Premultiplied: rgb added, alpha darkens what is behind (smoke).
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        side: THREE.DoubleSide,
      });
      m.customProgramCacheKey = () => key;
      return m;
    };
    this.armada = new THREE.Mesh(
      this.armadaGeo,
      opaque(ARMADA_VERTEX, ARMADA_FRAGMENT, "sky1-armada"),
    );
    this.planes = new THREE.Mesh(
      this.planeGeo,
      opaque(PLANE_VERTEX, PLANE_FRAGMENT, "sky1-planes"),
    );
    this.fx = new THREE.Mesh(
      this.fxGeo,
      blended(FX_VERTEX, FX_FRAGMENT, "sky1-fx"),
    );
    this.horizon = new THREE.Mesh(
      horizonGeometry(),
      blended(HORIZON_VERTEX, HORIZON_FRAGMENT, "sky1-horizon"),
    );
    for (const m of [this.armada, this.planes]) {
      m.frustumCulled = false;
      // Opaque, with the far skyline (after the city: early-z culls what
      // it hides; the shell's depth orders them against the far towers).
      m.renderOrder = RENDER_ORDER.farSkyline;
    }
    this.horizon.frustumCulled = false;
    this.horizon.renderOrder = RENDER_ORDER.skyHorizon;
    this.fx.frustumCulled = false;
    this.fx.renderOrder = RENDER_ORDER.skyFx;
    this.setQuality("high");
  }

  /** The four draws, for the scene and the QA hooks. */
  get objects(): THREE.Mesh[] {
    return [this.armada, this.planes, this.fx, this.horizon];
  }

  /**
   * Once a frame: the folded clock, the pixel scale, visibility. Nothing
   * else — every pose is the vertex shader's. `serverMs` null (no synced
   * clock yet): hidden. `shown`: the dome's visibility (none inside the
   * cloud deck or above it). FAR_ORIGIN is the far skyline's to write.
   */
  update(
    camera: THREE.PerspectiveCamera,
    serverMs: number | null,
    viewportW: number,
    viewportH: number,
    shown: boolean,
  ): void {
    const on = this.enabled && shown && serverMs !== null;
    this.armada.visible = on && this.counts.ships > 0;
    this.planes.visible = on && this.counts.groups > 0;
    this.fx.visible = on;
    this.horizon.visible = on;
    if (!on || serverMs === null) return;
    const u = this.uniforms;
    (u.uSkyT as THREE.IUniform).value = skyLoopTime(serverMs);
    (u.uSkyPx as THREE.IUniform).value =
      2 / (camera.projectionMatrix.elements[5] * Math.max(viewportH, 1));
    (u.uSkyViewport?.value as THREE.Vector2).set(
      Math.max(viewportW, 1),
      Math.max(viewportH, 1),
    );
  }

  /**
   * E1: thin the cosmetic dogfights where the real air force is dense.
   * `enemies[k]`: real enemy planes in bearing sector k round the camera
   * (remotes.ts enemySectors); a sector with THIN_FULL or more loses
   * THIN_MAX of its groups, fewer proportionally — so the real and the
   * painted sky together still read as one endless war, not a pile-up.
   */
  setThin(enemies: ArrayLike<number>): void {
    for (let k = 0; k < THIN_SECTORS; k++) {
      this.thin[k] = THIN_MAX * Math.min(1, (enemies[k] ?? 0) / THIN_FULL);
    }
  }

  /** E1: each bearing sector's thinning share (uSkyThin, by reference). */
  private readonly thin = new Float32Array(THIN_SECTORS);

  /** O3: the tier's share — instance counts and uniforms (rule 1: never a
   * compile). Dressing only, past the fog limit, never solid. */
  setQuality(tier: QualityTier): void {
    const c = skyArmadaCounts(QUALITY_PROFILES[tier].skyArmada);
    this.counts = c;
    (this.uniforms.uSkyCounts?.value as THREE.Vector3).set(
      c.ships,
      c.groups,
      c.flak,
    );
    (this.uniforms.uSkyOuter?.value as THREE.Vector2).set(
      c.shipOuter,
      c.planeOuter,
    );
    this.armadaGeo.instanceCount = c.ships;
    this.planeGeo.instanceCount = c.groups * GROUP_SIZE_MAX;
    this.fxGeo.instanceCount =
      c.ships * SHIP_FX +
      c.groups * GROUP_SIZE_MAX * PLANE_FX +
      c.flak * FLAK_FX;
  }
}
