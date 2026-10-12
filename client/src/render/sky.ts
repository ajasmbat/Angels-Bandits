// Dusk sky, fog, lights, and the ground plane. The fog color matches the
// clear color exactly, so geometry dissolves into "city haze" well before the
// torus's half-world limit (FOG_DISTANCE = 800 < WORLD_SIZE/2 = 1000).
//
// The ground is a camera-following plane — equivalent to chunk-shifting for an
// infinite-looking floor. Its paint (S1, "wet neon" direction) is a shader
// patch anchored to canonical WORLD coordinates via a per-frame origin
// uniform: asphalt, lane markings, crosswalk zebras, and sidewalks are all
// computed from the street contract's constants, so the paint can never
// disagree with lamp/traffic geometry. Mod arithmetic on canonical coords
// tiles across the seam by construction — no wrap special-cases.

import { CITY_GRID } from "@angels-bandits/common/city";
import {
  FORECOURT_GATE_HALF,
  FORECOURT_LAWN_INNER,
  FORECOURT_LAWN_OUTER,
  GROUND_FORECOURT,
  GROUND_PARK,
  GROUND_RIVER,
  GROUND_SITE,
  PARK_LAMP_COUNT,
  PARK_LAMP_PHASE,
  PARK_LAMP_RADIUS,
  PARK_LAWN_HALF,
  PARK_PATH_HALF,
  PARK_POND_RADIUS,
  PARK_POND_RIM,
  PARK_RING_RADIUS,
  blockGroundKind,
} from "@angels-bandits/common/city/nature";
import {
  CROSSWALK_DEPTH,
  CURB_LINE,
  LANE_CENTERS,
  ROADWAY_HALF,
} from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  FOG_DISTANCE,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";
import * as THREE from "three";
import { AB_AA_GLSL } from "./aa-glsl";
import { luminance } from "./emissive";
import {
  FIRELIGHT_GROUND_GLSL,
  INFERNO_PARS_GLSL,
  bindInfernoUniforms,
} from "./inferno-shading";
import { applyPointFloor } from "./point-floor";
import type { QualityTier } from "./quality";
import {
  REFLECTION_PARS_GLSL,
  REFL_PUDDLE_CAM_Y,
  REFL_PUDDLE_LOD,
  bindReflectionUniforms,
} from "./reflections";
import { RENDER_ORDER } from "./render-order";
import { BRIDGE_GONE_UNIFORM, RIVER_GROUND_PARS } from "./river";
import { SIGN_PALETTE } from "./signage";
import {
  CLOUD_A,
  CLOUD_B,
  CLOUD_BODY,
  CLOUD_CITY_GLOW,
  CLOUD_CORE,
  CLOUD_FLASH_PEAK,
  CLOUD_HIGH,
  CLOUD_TIER,
  CloudOffset,
  type CloudUniforms,
  RIM_PEAK,
  RIM_PEAK_HALO,
  STORM_FLASH_COLOR,
  cloudGlsl,
  createCloudUniforms,
} from "./sky-clouds";
import {
  SKY_FOG_AIR,
  SKY_FOG_ELEVATION,
  SKY_FOG_STOP,
  SKY_FOG_STOPS,
  SKY_GLOW_RAMP,
  SKY_STOPS,
} from "./sky-fog";
import type { SkyState } from "./skycycle";
import {
  STREET_PAINT_PARS,
  STREET_PAINT_UNIFORM,
  STREET_ROAD_BASE_GLSL,
  STREET_ROAD_MARK_GLSL,
  STREET_WALK_GLSL,
} from "./street-paint";
import { LAMP_STATIONS_MINUS, LAMP_STATIONS_PLUS } from "./streetlights";
import { TUNNEL_GROUND_PARS } from "./tunnels";
import {
  GROUND_WET_EMISSIVE_GLSL,
  GROUND_WET_GLSL,
  GROUND_WET_ROUGHNESS_GLSL,
  WEATHER_PARS_GLSL,
  WEATHER_UNIFORM,
} from "./weather";

/**
 * L1 "Stormlit" palette (was VO1's "Neon Blue Hour"). A storm night over a
 * sodium-lit city: dark steel-blue shadows and air, a cool silver moon key,
 * and warm amber light from the streets below. The horizon is still the
 * brightest part of the sky — a steel-blue-grey haze rather than VO1's
 * glowing lilac — so distant towers dissolve into lit air and silhouettes
 * separate by depth, while windows and lamps carry all the warmth.
 */
export const DUSK = {
  sky: 0x232c3c, // steel-blue horizon haze — clear color AND fog color, always identical
  ambient: 0x3c4a64, // cool steel skylight floor so nothing is ever pure black
  moon: 0xbccbe8, // cool silver moonlight key: the light that gives faces their form
  glow: 0xff9a50, // warm sodium city glow from the far side
  hemiSky: 0x46587c, // hemisphere: steel-blue sky above...
  hemiGround: 0x8c5a30, // ...warm sodium street bounce from below
} as const;

/**
 * Moonlight direction (towards the moon, world space). Low enough — ~24°
 * up — that a chase camera flying toward it actually sees the disc, high
 * enough that it lights roofs as well as facades. The disc on the dome and
 * the directional key share this vector, so the light always comes from
 * where the moon is drawn.
 */
export const MOON_DIR = new THREE.Vector3(0.52, 0.42, -0.74).normalize();

/** Light intensities (three's physical units: irradiance multipliers). */
export const LIGHT_RIG = {
  ambient: 0.7,
  moon: 2.1,
  glow: 1.0,
  // L1: the skylight keeps ~30 % of the dust's light against the moon key
  // (D10's dust darkens with the sky — collapse-d10.test.ts).
  hemi: 1.45,
} as const;

/** Tone-mapping exposure — the whole-image lift (ACES filmic). L1 eased it
 * (1.18 → 1.10) for deeper blacks; the grade's lift does the rest. */
export const EXPOSURE = 1.1;

/** Where the linear fog starts, m. VO1 pushed it out from 60 m: with a
 * luminous fog colour, a fog that starts at 60 m flattens the mid-distance
 * into one wash. L1 pushed it to 200 m and shaped the curve (fog.ts
 * FOG_SHAPE) so the skyline reads at 600 m. The far end (FOG_DISTANCE) is
 * the torus contract and does not move. */
export const FOG_NEAR = 200;

const GROUND_SIZE = 2 * FOG_DISTANCE + 200; // fully covers the fog radius
/**
 * O6: the ground's grid, per side. Two triangles 1.8 km across interpolate
 * vWorldXZ too coarsely (and the near plane clips them hard): the street
 * paint's world mapping wobbled by a fraction of a pixel every time the
 * plane re-centred under a moving camera, and paint edges swam. ~28 m
 * cells keep it exact to well under a pixel; still one draw.
 */
const GROUND_SEGMENTS = 64;

/** Direction toward the warm rim light (the old dusk sun), world space. The
 * L12 sky cycle swings it to the opposite quarter for pre-dawn. */
export const GLOW_DIR = new THREE.Vector3(-0.6, 0.18, 0.78).normalize();

/** The four lights setupSky adds — handles for the L12 sky cycle. */
export interface SkyRig {
  ambient: THREE.AmbientLight;
  moon: THREE.DirectionalLight;
  glow: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
}

export function setupSky(scene: THREE.Scene): SkyRig {
  scene.background = new THREE.Color(DUSK.sky);
  scene.fog = new THREE.Fog(DUSK.sky, FOG_NEAR, FOG_DISTANCE);

  // VO1 rig: a cool moon key gives every face a lit side and a shadow side,
  // a warm low glow from the opposite quarter rims the dark side, and the
  // hemisphere supplies sky-blue from above and street-glow from below — the
  // canyon reads as lit by its own city. Still no shadow maps and no point
  // lights: these four are uniform-cost per fragment.
  const ambient = new THREE.AmbientLight(DUSK.ambient, LIGHT_RIG.ambient);
  scene.add(ambient);
  const moon = new THREE.DirectionalLight(DUSK.moon, LIGHT_RIG.moon);
  moon.position.copy(MOON_DIR); // direction only
  scene.add(moon);
  const glow = new THREE.DirectionalLight(DUSK.glow, LIGHT_RIG.glow);
  glow.position.copy(GLOW_DIR); // the old dusk sun, now a rim
  scene.add(glow);
  const hemi = new THREE.HemisphereLight(
    DUSK.hemiSky,
    DUSK.hemiGround,
    LIGHT_RIG.hemi,
  );
  scene.add(hemi);
  return { ambient, moon, glow, hemi };
}

// The fog band (SKY_FOG_STOP and friends) lives in sky-fog.ts since H1: the
// fog chunks read it too (above the stop, fog fades toward this dome's
// gradient), and fog.ts must not import this module.
export { SKY_FOG_ELEVATION, SKY_FOG_STOP, SKY_GLOW_RAMP, SKY_STOPS };
/** L1 night gradient (sRGB): a near-black navy zenith, storm navy, then
 * steel blue lifting toward the band — then DUSK.sky. (VO1's ran deep blue
 * into violet light pollution.) */
export const SKY_GRADIENT_NIGHT = [
  0x03050b, 0x070b16, 0x0c1322, 0x141c2d, 0x1b2435,
] as const;

/** Moon disc angular radius, radians (~2.6° — big and cinematic, the way a
 * long lens shows it; the real 0.26° would be a sub-pixel dot at FOV 70). */
export const MOON_RADIUS = 0.045;
/** Peak linear luminance of the disc: over the 0.72 bloom threshold so it
 * carries a halo (L1 lifted it from 0.95 for the reference's bright full
 * moon), still well under the tracer rung (1.5). */
export const MOON_PEAK = 1.15;

/** Disc angular radius as a gnomonic (tangent-plane) distance. */
const MOON_TAN = Math.tan(MOON_RADIUS);

const vec3Literal = (v: readonly number[]): string =>
  `vec3(${v.map((c) => c.toFixed(5)).join(", ")})`;

/**
 * The sky, drawn entirely by the dome's own fragment shader — no texture,
 * no extra mesh, so no extra draw call. The dome is centred on the camera,
 * so its local vertex position IS the view direction.
 *
 * Gradient (L12 sky cycle): the stops are uniforms, mixed piecewise-linearly
 * in sRGB and decoded to linear exactly as the old 1×256 canvas texture was;
 * from SKY_FOG_STOP down it is the horizon uniform, which the cycle feeds
 * from the SAME colour it hands the fog. A dusk glow (west) and a dawn glow
 * (east) are added above the stop only.
 *
 * L1 storm sky (sky-clouds.ts): two parallax cloud layers — dark masses
 * with silver rims on the side facing the moon, brightest beside it, and a
 * thin high deck — a noise-edged gap where the moon breaks through, and
 * lightning that lights the clouds from inside. All of it fades in from
 * zero above the fog stop, and none of it runs below.
 *
 * The air (L1): storm.atmosphere() folds the rain dim, the in-cloud soup,
 * the flash stain and the D3 dust into one affine map the fog colour goes
 * through (SkyAir); everything above the stop goes through the same map,
 * and the band below the stop IS this frame's fog colour (uFogColor). At
 * the stop the gradient equals the fog base, so the sky meets the fog
 * exactly at every moment — mid-flash and inside dust included. The
 * flash's extra brightening ramps in from zero over SKY_GLOW_RAMP.
 *
 * Moon: the disc lives in the tangent plane at uMoonDir (gnomonic
 * projection, the same mapping a camera-facing quad would give). The dome
 * draws first and the city paints over it, so towers occlude the moon
 * exactly as they occlude the sky.
 */
function skyPatch(material: THREE.MeshBasicMaterial, u: SkyUniforms): void {
  const peak = new THREE.Color(DUSK.moon);
  const lum = 0.2126 * peak.r + 0.7152 * peak.g + 0.0722 * peak.b;
  // The moon's hue at unit luminance (the rims are lit by it).
  const moonHue = peak.clone().multiplyScalar(1 / lum);
  peak.multiplyScalar(MOON_PEAK / lum);
  const flash = new THREE.Color(STORM_FLASH_COLOR);
  flash.multiplyScalar(1 / luminance(flash));
  const n = SKY_STOPS.length;
  // Chained mixes: each is 0 before its interval and 1 after it, so the
  // chain IS the piecewise-linear gradient.
  const chain = SKY_STOPS.slice(1)
    .map(
      (f, i) =>
        `  c = mix(c, uSkyStops[${i + 1}], clamp((f - ${SKY_STOPS[i]?.toFixed(5)}) / ${(f - (SKY_STOPS[i] as number)).toFixed(5)}, 0.0, 1.0));`,
    )
    .join("\n");
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSkyDir;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvSkyDir = position;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
varying vec3 vSkyDir;
uniform vec3 uSkyStops[${n}];
uniform vec3 uMoonDir;
uniform vec3 uMoonEast;
uniform vec3 uMoonNorth;
uniform float uMoonVis;
uniform vec3 uDuskGlow;
uniform vec3 uDawnGlow;
uniform vec2 uDuskDir;
uniform vec3 uFogColor;
uniform float uAirScale;
uniform vec3 uAirAdd;
uniform float uAirGain;
uniform float uFlash;
uniform vec3 uFlashDir;
${cloudGlsl(SKY_FOG_ELEVATION)}
float mHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float mNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mHash(i), mHash(i + vec2(1.0, 0.0)), u.x),
             mix(mHash(i + vec2(0.0, 1.0)), mHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 abSrgbDecode(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}`,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */ `#include <map_fragment>
{
  vec3 sd = normalize(vSkyDir);
  float f = acos(clamp(sd.y, -1.0, 1.0)) / PI;
  vec3 c = uSkyStops[0];
${chain}
  vec3 sky = abSrgbDecode(c);
  // Nothing additive below the fog stop: ramp in from exactly zero above it.
  float el = asin(clamp(sd.y, -1.0, 1.0));
  float above = smoothstep(${SKY_FOG_ELEVATION.toFixed(5)}, ${(SKY_FOG_ELEVATION + SKY_GLOW_RAMP).toFixed(5)}, el);
  float facing = dot(sd, uMoonDir);
  float cover = 0.0;
  float lightning = 0.0;
  if (above > 0.0) {
    // Dusk / dawn glow: hugs the band just above the stop, in one quarter.
    vec2 hz = sd.xz / max(length(sd.xz), 1e-4);
    float band = above * (1.0 - smoothstep(${(SKY_FOG_ELEVATION + SKY_GLOW_RAMP).toFixed(5)}, ${(SKY_FOG_ELEVATION + 0.5).toFixed(5)}, el));
    float side = dot(hz, uDuskDir);
    sky += uDuskGlow * band * pow(max(side, 0.0), 3.0);
    sky += uDawnGlow * band * pow(max(-side, 0.0), 3.0);
  }
  vec3 moonCol = ${vec3Literal(peak.toArray())};
  float moonHalo = 0.0;
  if (facing > 0.0) {
    // Disc-radius units on the tangent plane at the moon.
    // O7: a denormal facing sent q to Inf and fract(Inf) is NaN (×0 is
    // still NaN). Nothing of the moon reaches 89.9° from it.
    vec2 q = vec2(dot(sd, uMoonEast), dot(sd, uMoonNorth))
             / (max(facing, 1e-3) * ${MOON_TAN.toFixed(6)});
    float r = length(q);
    // Disc: soft limb darkening + maria (low-frequency dark patches).
    // The disc itself never reaches the fog band (MOON_EL_LOW); only the
    // wide halo could, so only the halo takes the ramp.
    float disc = (1.0 - smoothstep(0.96, 1.0, r)) * uMoonVis;
    float maria = mNoise(q * 2.3 + 3.1) * 0.6 + mNoise(q * 5.1) * 0.4;
    float limb = 0.78 + 0.22 * sqrt(max(0.0, 1.0 - r * r));
    vec3 discCol = moonCol * limb * (1.0 - 0.28 * smoothstep(0.45, 0.75, maria));
    // Halo, added over the sky: a tight corona and a wide moonlit haze
    // (L1: wider and brighter, the reference's glow through wet air).
    float d = max(r - 1.0, 0.0);
    float halo = (0.26 * exp(-d * 2.2) + 0.09 * exp(-d * 0.42)) * uMoonVis * above;
    sky = sky * (1.0 - disc) + discCol * disc + moonCol * halo * (1.0 - disc);
    moonHalo = halo;
  }
  // L1 clouds — skipped wholesale in the fog band and on ?clouds=0.
  if (above > 0.0 && uCloudOn > 0.5 && sd.y > 0.02) {
    float fade = abCloudFade(sd.y);
    if (fade > 0.0) {
      vec2 hz = sd.xz / sd.y;
      vec2 pA = uCloudOffA + hz * ${CLOUD_A.height.toFixed(1)};
      vec3 fa = abCloudFieldA(pA, ${CLOUD_A.height.toFixed(1)} / sd.y, uCloudDetail);
      float gap = abCloudGap(sd, fa.x);
      float rawA = abCloudDensityA(fa.x);
      float dA = rawA * gap * fade;
      float dB = abCloudDensityB(abCloudFieldB(uCloudOffB + hz * ${CLOUD_B.height.toFixed(1)}))
        * fade * mix(1.0, gap, 0.6);
      // Moonlight: rims on the side facing the moon. Step a little along
      // the plane toward where the moon's ray meets it; where the coarse
      // field falls that way, this is a moon-facing edge.
      vec2 pMoon = uCloudOffA + uMoonDir.xz / max(uMoonDir.y, 0.05) * ${CLOUD_A.height.toFixed(1)};
      vec2 toMoon = pMoon - pA;
      toMoon /= max(length(toMoon), 1.0);
      float here = uCloudRim > 1.5 ? fa.z : fa.y;
      float there = abCloudCoarseA(pA + toMoon * 140.0, uCloudRim);
      float lit = clamp((here - there) * 7.0 + 0.12, 0.0, 1.0) * (1.0 - 0.65 * rawA);
      float m = max(facing, 0.0);
      float near = pow(m, 12.0); // within ~30° of the moon
      float halo2 = pow(m, 200.0); // inside the halo
      float rimLum = mix(0.08, ${RIM_PEAK.toFixed(3)}, near)
        + ${(RIM_PEAK_HALO - RIM_PEAK).toFixed(3)} * halo2;
      vec3 rim = ${vec3Literal(moonHue.toArray())} * rimLum * lit * uMoonVis;
      float low = 1.0 - smoothstep(${SKY_FOG_ELEVATION.toFixed(5)}, ${(SKY_FOG_ELEVATION + 0.35).toFixed(5)}, el);
      // Thick cores darker than the thin edges.
      // The masses round the moon are moonlit through (the reference's
      // grey-white clouds about the gap).
      vec3 bodyA = mix(${glslColor(CLOUD_BODY)}, ${glslColor(CLOUD_CORE)}, smoothstep(0.55, 1.0, rawA) * smoothstep(0.62, 0.85, fa.x))
        + ${vec3Literal(moonHue.toArray())} * (0.1 * near * uMoonVis)
        + ${glslColor(CLOUD_CITY_GLOW)} * low + rim;
      vec3 bodyB = ${glslColor(CLOUD_HIGH)}
        + ${vec3Literal(moonHue.toArray())} * (0.02 + 0.2 * near) * uMoonVis;
      sky = mix(sky, bodyB, dB);
      sky = mix(sky, bodyA, dA);
      cover = clamp(dA + dB * (1.0 - dA), 0.0, 1.0);
      // The moon's glow still bleeds through thin cloud.
      sky += moonCol * moonHalo * cover * 0.35;
      // Lightning lights the cloud mass around the strike from inside.
      // (Its own, gentler elevation fade: the lit deck melts into the
      // horizon haze instead of ending on a line.)
      lightning = uFlash * pow(max(dot(sd, uFlashDir), 0.0), 5.0)
        * (0.25 + 0.75 * cover)
        * smoothstep(${SKY_FOG_ELEVATION.toFixed(5)}, ${(SKY_FOG_ELEVATION + 0.45).toFixed(5)}, el);
    }
  }
  // The air (see above): the same affine map as the fog, the flash gain
  // ramped in from the stop, and below the stop exactly the fog colour.
  vec3 air = (sky * uAirScale + uAirAdd) * (1.0 + (uAirGain - 1.0) * above);
  air += ${vec3Literal(flash.toArray())} * (${CLOUD_FLASH_PEAK.toFixed(3)} * lightning);
  diffuseColor.rgb = mix(uFogColor, air, above);
}`,
      );
  };
  // Unique key: three caches programs on onBeforeCompile.toString().
  material.customProgramCacheKey = () => "l1-storm-sky-dome";
}

/** The dome's uniforms — written by SkyDome once per frame. */
interface SkyUniforms extends CloudUniforms {
  uSkyStops: { value: THREE.Vector3[] };
  uMoonDir: { value: THREE.Vector3 };
  uMoonEast: { value: THREE.Vector3 };
  uMoonNorth: { value: THREE.Vector3 };
  uMoonVis: { value: number };
  uDuskGlow: { value: THREE.Vector3 };
  uDawnGlow: { value: THREE.Vector3 };
  uDuskDir: { value: THREE.Vector2 };
  /** L1: this frame's fog colour (linear) — the band below the stop. */
  uFogColor: { value: THREE.Color };
  /** L1: the air's affine map (storm.ts SkyAir) and flash gain. */
  uAirScale: { value: number };
  uAirAdd: { value: THREE.Color };
  uAirGain: { value: number };
  /** L1: in-cloud lightning level 0..1 and the unit direction to it. */
  uFlash: { value: number };
  uFlashDir: { value: THREE.Vector3 };
}

/** Linear → sRGB transfer (the gradient uniforms are sRGB, like the old
 * canvas). Exact IEC 61966-2-1. */
const encodeSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

/** Stars on the dome: count, and the elevation band they occupy. */
export const STAR_COUNT = 900;
/** Lowest star elevation, rad: where the gradient stops being fog-coloured.
 * A star below it could outline a fully fogged landmark against the sky —
 * a torus-wrap tell (see SKY_FOG_STOP). */
const STAR_ELEVATION_MIN = (0.5 - SKY_FOG_STOP) * Math.PI;
/** Brightest star, as a multiplier on white: sub-bloom (luminance < 0.72). */
export const STAR_PEAK = 0.62;

/** A star's true size, drawing-buffer pixels (no attenuation). */
const STAR_SIZE_PX = 1.6;
/** Stars are drawn at least this big (applyPointFloor pays the alpha). */
const STAR_FLOOR_PX = 2.5;
/** The star dot's profile, 1 − r⁴ inside the point's disc: flat-topped, so
 * a small point's samples read near full, and 0 at the rim, so a sample
 * crossing it fades instead of switching. */
const starDot = (r: number): number => (r < 1 ? 1 - r ** 4 : 0);
/** Mean of starDot over the point's square: (1/4)·2π∫(1 − r⁴) r dr = π/6. */
const STAR_DOT_MEAN = Math.PI / 6;

/** starDot as a small white-with-alpha texture (no canvas: tests run in
 * node). Linear filtering between its texels keeps the profile smooth. */
function starDotTexture(): THREE.DataTexture {
  const n = 16;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = ((x + 0.5) / n) * 2 - 1;
      const dy = ((y + 0.5) / n) * 2 - 1;
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(255 * starDot(Math.hypot(dx, dy)));
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A seeded star field, as a child of the dome so it follows the camera and
 * hides with it. NOT additive over emissives — stars are drawn first (the
 * dome's render order) and the city paints over them, as it should. Sizes
 * are in pixels with no attenuation: a star is a point, not a sprite.
 */
function starField(seed: number, clouds: CloudUniforms): THREE.Points {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const radius = FOG_DISTANCE + 40;
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const az = rand() * Math.PI * 2;
    // Uniform on the cap above STAR_ELEVATION_MIN.
    const sinMin = Math.sin(STAR_ELEVATION_MIN);
    const el = Math.asin(sinMin + rand() * (1 - sinMin));
    positions[i * 3] = Math.cos(el) * Math.cos(az) * radius;
    positions[i * 3 + 1] = Math.sin(el) * radius;
    positions[i * 3 + 2] = Math.cos(el) * Math.sin(az) * radius;
    // Mostly faint, a few bright; fade into the haze near the horizon; a
    // little colour temperature spread so it is not a field of one white.
    const mag = rand() ** 2.2;
    const horizon = Math.min(1, (el - STAR_ELEVATION_MIN) / 0.35);
    const k = STAR_PEAK * (0.25 + 0.75 * mag) * horizon;
    const warm = rand();
    colors[i * 3] = k * (0.85 + 0.15 * warm);
    colors[i * 3 + 1] = k * (0.88 + 0.08 * warm);
    colors[i * 3 + 2] = k * (1.0 - 0.12 * warm);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: STAR_SIZE_PX,
    sizeAttenuation: false,
    // O5: a soft round dot instead of a hard square, drawn at the floor
    // (applyPointFloor): a 1.6 px square covers one pixel, then two, as
    // the view turns — every star twinkled with the camera. The dot's
    // samples slide smoothly instead. `color` pays back the profile's
    // mean, so a star keeps its old total light (and its centre pixel
    // stays dimmer than the old square: still sub-bloom).
    map: starDotTexture(),
    color: new THREE.Color().setScalar(1 / STAR_DOT_MEAN),
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    fog: false,
  });
  material.customProgramCacheKey = () => "ab-stars-l1";
  material.onBeforeCompile = (shader) => {
    applyPointFloor(shader, STAR_FLOOR_PX);
    patchCloudCover(shader, clouds);
  };
  const points = new THREE.Points(geometry, material);
  points.renderOrder = RENDER_ORDER.sky;
  points.frustumCulled = false;
  return points;
}

/**
 * L1: fade a dome-riding point (a star, an airliner light) by the cloud
 * coverage in its direction, so it only shows in the gaps. Coverage per
 * VERTEX —
 * one coverage evaluation per point, the same function and the same
 * uniform objects the dome paints with. The point's local position is its
 * direction from the eye (it rides the camera-centred dome).
 */
export function patchCloudCover(
  shader: THREE.WebGLProgramParametersWithUniforms,
  clouds: CloudUniforms,
): void {
  Object.assign(shader.uniforms, clouds);
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>\nvarying float vCloudVis;\n${cloudGlsl(SKY_FOG_ELEVATION)}`,
    )
    .replace(
      "#include <color_vertex>",
      "#include <color_vertex>\n\tvCloudVis = 1.0 - abCloudCover(normalize(position));",
    );
  // ALPHA, not colour: a star is normal-blended, so a blackened one would
  // still paint a dark dot over the cloud in front of it.
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying float vCloudVis;")
    .replace(
      "#include <color_fragment>",
      "#include <color_fragment>\n\tdiffuseColor.a *= vCloudVis;",
    );
}

/** Camera-following gradient dome, just inside the far plane, above the fog. */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly stars: THREE.Points;
  /** Public for L4: the river's moon column shares uMoonDir / uMoonVis. */
  readonly uniforms: SkyUniforms;
  /** L1: the cloud uniforms the stars and airliners share by reference. */
  readonly clouds: CloudUniforms;
  private readonly cloudOffset = new CloudOffset();
  private readonly flashDir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(cloudsOn = true) {
    const material = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    // Starts on the night key (the L12 cycle overwrites it every frame).
    const stops = [...SKY_GRADIENT_NIGHT, DUSK.sky].map((hex) => {
      const v = new THREE.Vector3();
      return v
        .set((hex >> 16) & 255, (hex >> 8) & 255, hex & 255)
        .divideScalar(255);
    });
    stops.forEach((v, i) => v.toArray(SKY_FOG_STOPS, i * 3));
    const dusk = new THREE.Vector2(GLOW_DIR.x, GLOW_DIR.z).normalize();
    this.clouds = createCloudUniforms();
    this.clouds.uCloudOn.value = cloudsOn ? 1 : 0;
    this.uniforms = {
      ...this.clouds,
      uSkyStops: { value: stops },
      uMoonDir: { value: MOON_DIR.clone() },
      uMoonEast: { value: new THREE.Vector3() },
      uMoonNorth: { value: new THREE.Vector3() },
      uMoonVis: { value: 1 },
      uDuskGlow: { value: new THREE.Vector3() },
      uDawnGlow: { value: new THREE.Vector3() },
      uDuskDir: { value: dusk },
      uFogColor: { value: new THREE.Color(DUSK.sky) },
      uAirScale: { value: 1 },
      uAirAdd: { value: new THREE.Color(0, 0, 0) },
      uAirGain: { value: 1 },
      uFlash: { value: 0 },
      uFlashDir: { value: new THREE.Vector3(0, 1, 0) },
    };
    this.setMoon(MOON_DIR);
    skyPatch(material, this.uniforms);
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(FOG_DISTANCE + 60, 24, 16),
      material,
    );
    this.mesh.renderOrder = RENDER_ORDER.sky; // always the backdrop
    // Stars ride the dome: same centre, hidden with it inside the cloud deck.
    this.stars = starField(0x57a2f1e1, this.clouds);
    this.mesh.add(this.stars);
  }

  /** Point the moon (and its tangent frame) along `dir` (unit, never
   * vertical — the cycle's arc tops out far below the zenith). */
  private setMoon(dir: { x: number; y: number; z: number }): void {
    const u = this.uniforms;
    u.uMoonDir.value.set(dir.x, dir.y, dir.z);
    u.uMoonEast.value.set(0, 1, 0).cross(u.uMoonDir.value).normalize();
    u.uMoonNorth.value.copy(u.uMoonDir.value).cross(u.uMoonEast.value);
    this.clouds.uCloudMoon.value.copy(u.uMoonDir.value);
  }

  /** L12 sky cycle: write this frame's gradient, glows, moon and stars. */
  setCycle(s: SkyState): void {
    const u = this.uniforms;
    const stops = [s.zenith, s.sky14, s.sky25, s.sky32, s.sky37, s.horizon];
    for (let i = 0; i < stops.length; i++) {
      const c = stops[i] as readonly number[];
      const v = u.uSkyStops.value[i] as THREE.Vector3;
      v.set(
        encodeSrgb(c[0] as number),
        encodeSrgb(c[1] as number),
        encodeSrgb(c[2] as number),
      );
      // H1: every fogged material fades toward this same gradient above
      // the stop (sky-fog.ts).
      v.toArray(SKY_FOG_STOPS, i * 3);
    }
    u.uDuskGlow.value.fromArray(s.duskGlow);
    u.uDawnGlow.value.fromArray(s.dawnGlow);
    u.uMoonVis.value = s.moonVis;
    this.setMoon({ x: s.moonDir[0], y: s.moonDir[1], z: s.moonDir[2] });
    (this.stars.material as THREE.PointsMaterial).opacity = s.stars;
  }

  /**
   * Keep the dome centred on the viewer and advance the clouds: the
   * unwrapped camera offset (sky-clouds.ts CloudOffset — `dtSec` is the
   * sim's clamped step) plus each layer's wind on the synced clock.
   */
  update(cameraPos: Vec3, dtSec = 0, timeMs: number | null = null): void {
    this.mesh.position.set(cameraPos.x, cameraPos.y, cameraPos.z);
    this.cloudOffset.advance(cameraPos, dtSec);
    this.cloudOffset.layer(CLOUD_A.wind, timeMs, this.clouds.uCloudOffA.value);
    this.cloudOffset.layer(CLOUD_B.wind, timeMs, this.clouds.uCloudOffB.value);
  }

  /**
   * Storm hook (L1, replaces ST2's multiplicative tint): this frame's air
   * from storm.atmosphere() — the fog colour for the band below the stop,
   * the affine colour map and flash gain for everything above it.
   */
  setAir(air: {
    scale: number;
    add: THREE.Color;
    gain: number;
    fog: THREE.Color;
  }): void {
    const u = this.uniforms;
    u.uAirScale.value = air.scale;
    u.uAirAdd.value.copy(air.add);
    u.uAirGain.value = air.gain;
    u.uFogColor.value.copy(air.fog);
    // H1: the fog chunks' copy of the map (sky-fog.ts), switched on by the
    // first write.
    SKY_FOG_AIR[0] = air.add.r;
    SKY_FOG_AIR[1] = air.add.g;
    SKY_FOG_AIR[2] = air.add.b;
    SKY_FOG_AIR[3] = air.scale;
    SKY_FOG_AIR[4] = air.gain;
    SKY_FOG_AIR[5] = 1;
  }

  /**
   * L1: lightning inside the clouds — `level` (the flash envelope, 0..1)
   * and the torus step from the eye to the strike (wrapDelta: the image of
   * the strike nearest the viewer), lit at the cloud masses' height.
   */
  setFlash(level: number, toStrike: Readonly<Vec3>): void {
    const u = this.uniforms;
    u.uFlash.value = level;
    if (level <= 0) return;
    const d = this.flashDir;
    d.x = toStrike.x;
    d.y = CLOUD_A.height;
    d.z = toStrike.z;
    u.uFlashDir.value.set(d.x, d.y, d.z).normalize();
  }

  /** M3 tiers: fine cloud octaves and the rim's second octave (uniforms —
   * never a recompile). Coverage is identical on every tier. */
  setQuality(tier: QualityTier): void {
    this.clouds.uCloudDetail.value = CLOUD_TIER[tier].detail;
    this.clouds.uCloudRim.value = CLOUD_TIER[tier].rim;
  }
}

// --- S1 painted ground ------------------------------------------------------

/** Linear-space GLSL literal for an sRGB hex (THREE.Color converts). */
const glslColor = (hex: number): string => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};
const glslNum = (v: number): string => v.toFixed(4);
const glslVec3Of = (vs: readonly number[]): string =>
  `vec3(${vs.map((v) => v.toFixed(2)).join(", ")})`;

// Wet-neon palette (approved concept 4): cool damp asphalt, crisp cool-white
// markings, warm lamp-reflection streaks. Colors are albedo; markings also get
// a low emissive lift (sub-bloom — only the ladder's rungs may bloom).
const GROUND_COLORS = {
  asphalt: glslColor(0x1a1c28),
  interior: glslColor(0x0d0d14),
  sidewalk: glslColor(0x262838),
  seam: glslColor(0x1e1f2d),
  curb: glslColor(0x363a4a),
  marking: glslColor(0xcfd8e8),
  edge: glslColor(0x9ca4b6),
  zebra: glslColor(0xd4dcea),
  lampWarm: glslColor(0xffb35c), // the existing streetlight color family
  // N1 nature — night albedos, lifted just enough to read under the moon.
  lawn: glslColor(0x1f3a22),
  hedge: glslColor(0x12241a),
  path: glslColor(0x34333a),
  rim: glslColor(0x46454f),
  water: glslColor(0x05080f),
  paving: glslColor(0x2a2b36),
  slabJoint: glslColor(0x1c1d26),
  earth: glslColor(0x2a1f16),
  gravel: glslColor(0x3b3732),
  moon: glslColor(DUSK.moon),
} as const;
// N1 nature emissives, all far under the 0.72 bloom threshold — and the
// GROUND_LUMA_CAP below clamps whatever they stack to anyway, so a park can
// never become a ladder rung. Park-lamp HEADS bloom (the LAMP rung, in
// render/nature.ts); their pools here do not.
/** Park-lamp pool peak gain on the warm lamp colour (~0.18 luminance). */
const PARK_POOL_GLOW = "0.35";
/** Pond rim's warm uplight gain (~0.24 luminance). */
const POND_RIM_GLOW = "0.45";
/** Faked moon glint on the pond: gain and highlight tightness. */
const POND_GLINT = "0.6";
const POND_GLINT_POWER = "300.0";
/** Pond roughness close up (the real moonlight's specular helps the glint). */
const POND_ROUGHNESS = "0.22";
/** Marking emissive lift: ~0.45 peak luminance — under the 0.72 bloom threshold. */
const MARKING_GLOW = "0.65";
/** Peak of a lamp-reflection streak (~0.27 luminance — sub-bloom, warm). */
const STREAK_GLOW = "0.5";
/** Damp roadway roughness; sidewalks/interiors stay matte at the base 1.0. */
const ROADWAY_ROUGHNESS = "0.55";
// VO5 wet streets. There is no envMap, so a smooth surface alone reads
// DARKER, not shinier: the "reflection" is faked as emissive — a sky-tinted
// Fresnel sheen and neon sign spill smeared along the curbs — and the low
// puddle roughness only buys the moon a specular glint.
/** Puddle roughness FLOOR: lower makes moon-glint fireflies at altitude. */
const PUDDLE_ROUGHNESS = "0.32";
/** Puddles fade back to the damp base over this view distance, m (aliasing). */
const PUDDLE_FADE = { near: "70.0", far: "260.0" } as const;
/** Puddle albedo darkening (wet asphalt is darker than damp). */
const PUDDLE_DARKEN = "0.62";
/** Sky reflected at grazing angles: the horizon colour, lifted. */
const SHEEN_COLOR = glslColor(0x5a6c8c); // L1: steel, not lilac
/** Peak sheen gain at full Fresnel on a puddle. */
const SHEEN_GAIN = "0.9";
/** Neon spill smear peak luminance (before Fresnel/wetness; sub-bloom). */
const NEON_LUM = 0.5;
/** Ground luminance cap on the WHOLE lit result (diffuse + specular +
 * emissive): 0.55 + the lamp glow pool's ~0.17 additive peak stays under the
 * 0.72 bloom threshold however markings, streaks, smears, sheen and a moon
 * glint stack — the ground is never a ladder rung. */
const GROUND_LUMA_CAP = "0.55";
/** Street segments per world along one axis (hash period — wrap-safe). */
const SEGMENTS = WORLD_SIZE / BLOCK_PITCH;
/** The signs' own palette, normalised to equal luminance, as a GLSL array. */
const NEON_PALETTE = `vec3[${SIGN_PALETTE.length}](${SIGN_PALETTE.map((c) => {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const k = NEON_LUM / l;
  return `vec3(${(c.r * k).toFixed(4)}, ${(c.g * k).toFixed(4)}, ${(c.b * k).toFixed(4)})`;
}).join(", ")})`;
/** Sidewalk paint band beyond the curb, meters (building faces sit further out). */
const SIDEWALK_BAND = 8;

/**
 * Every block's ground kind (common/src/city/nature.ts) as a GLSL const
 * table, indexed bx * CITY_GRID + bz. Seed-free by construction — the
 * hand-placed block lists alone decide it — so it bakes into the shader.
 */
const BLOCK_KIND_TABLE = `int[${CITY_GRID * CITY_GRID}](${Array.from(
  { length: CITY_GRID * CITY_GRID },
  (_, i) => blockGroundKind(Math.floor(i / CITY_GRID), i % CITY_GRID),
).join(", ")})`;

/** Park / forecourt layout anchors — from the nature seam's exports, never
 * retyped, so the paint sits under the lamps and around the trees. */
const N = {
  lawnHalf: glslNum(PARK_LAWN_HALF),
  pond: glslNum(PARK_POND_RADIUS),
  rimOut: glslNum(PARK_POND_RADIUS + PARK_POND_RIM),
  ring: glslNum(PARK_RING_RADIUS),
  path: glslNum(PARK_PATH_HALF),
  lampR: glslNum(PARK_LAMP_RADIUS),
  lampPhase: glslNum(PARK_LAMP_PHASE),
  lampStep: glslNum((2 * Math.PI) / PARK_LAMP_COUNT),
  gate: glslNum(FORECOURT_GATE_HALF),
  lawnIn: glslNum(FORECOURT_LAWN_INNER),
  lawnOut: glslNum(FORECOURT_LAWN_OUTER),
  world: glslNum(WORLD_SIZE),
  grid: `${CITY_GRID}`,
  park: `${GROUND_PARK}`,
  forecourt: `${GROUND_FORECOURT}`,
  site: `${GROUND_SITE}`,
  river: `${GROUND_RIVER}`,
  moonDir: `vec3(${MOON_DIR.x.toFixed(4)}, ${MOON_DIR.y.toFixed(4)}, ${MOON_DIR.z.toFixed(4)})`,
} as const;

// Geometry anchors — every street offset comes from the contract imports.
const G = {
  pitch: glslNum(BLOCK_PITCH),
  road: glslNum(ROADWAY_HALF),
  curb: glslNum(CURB_LINE),
  xwalkOut: glslNum(ROADWAY_HALF + CROSSWALK_DEPTH),
  lane: glslNum(LANE_CENTERS[1]),
  edgeIn: glslNum(CURB_LINE - 0.8), // lane-edge line: 0.35 m wide, inset off the curb
  edgeOut: glslNum(CURB_LINE - 0.45),
  walkOut: glslNum(CURB_LINE + SIDEWALK_BAND),
  streakCross: glslNum(CURB_LINE - 2), // reflection streak center on the roadway
  neonCross: glslNum(CURB_LINE - 1.6), // neon spill smear center, curb side
  segments: glslNum(SEGMENTS),
  stationsPlus: glslVec3Of(LAMP_STATIONS_PLUS),
  stationsMinus: glslVec3Of(LAMP_STATIONS_MINUS),
} as const;

const GROUND_VERTEX_PARS = /* glsl */ `
uniform vec2 uGroundOrigin;
varying vec2 vWorldXZ;
`;

const GROUND_VERTEX_MAIN = /* glsl */ `
// Canonical world XZ: plane local coords + the canonicalized camera origin
// (the plane is rotated -90° about X, so local +y maps to world -z).
vWorldXZ = uGroundOrigin + vec2(position.x, -position.y);
`;

const GROUND_FRAGMENT_PARS = /* glsl */ `
varying vec2 vWorldXZ;
${AB_AA_GLSL}float abHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float abNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(abHash(i), abHash(i + vec2(1.0, 0.0)), u.x),
             mix(abHash(i + vec2(0.0, 1.0)), abHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Signed offset to the nearest street centerline along one axis (wrap-safe:
// BLOCK_PITCH divides WORLD_SIZE, so plain mod tiles across the seam).
float abLineDist(float v) {
  float m = mod(v, ${G.pitch});
  return m > ${G.pitch} * 0.5 ? m - ${G.pitch} : m;
}
// Distance to the nearest lamp station along a street (stations per side).
float abStationDist(float v, vec3 stations) {
  vec3 m = abs(vec3(mod(v, ${G.pitch})) - stations);
  vec3 w = min(m, ${G.pitch} - m);
  return min(w.x, min(w.y, w.z));
}
// Elongated soft falloff: a lamp's glow smeared along the wet roadway.
float abStreak(float dAlong, float dCross) {
  float a = 1.0 - smoothstep(0.0, 14.0, dAlong);
  float c = 1.0 - smoothstep(0.0, 2.2, abs(dCross));
  return a * a * c;
}
const vec3 AB_NEON[${SIGN_PALETTE.length}] = ${NEON_PALETTE};
// Neon spill reflected along one curb of one street segment: up to two smears
// at hashed stations, each a hashed sign colour. The hash keys on the street
// line and segment index taken mod the world's segment count, so the same
// smear is drawn on both sides of the torus seam.
vec3 abNeonSpill(float line, float along, float side, float dCross) {
  float seg = mod(floor(along / ${G.pitch}), ${G.segments});
  float ln = mod(line, ${G.segments});
  vec2 key = vec2(ln * ${G.segments} + seg, side);
  float local = mod(along, ${G.pitch});
  float c = 1.0 - smoothstep(0.0, 2.4, abs(dCross));
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    vec2 kk = key + vec2(0.0, 7.0 * float(k + 1));
    float present = step(abHash(kk + 3.1), 0.8);
    float station = 30.0 + 140.0 * abHash(kk);
    float a = 1.0 - smoothstep(0.0, 16.0 + 12.0 * abHash(kk + 1.7), abs(local - station));
    int hue = int(floor(abHash(kk + 5.3) * ${SIGN_PALETTE.length}.0));
    acc += AB_NEON[hue] * present * a * a;
  }
  return acc * c;
}
// --- N1 nature ground ---
const int AB_BLOCK_KIND[${CITY_GRID * CITY_GRID}] = ${BLOCK_KIND_TABLE};
// Ground kind of the block under world XZ (wrap-safe: mod the world first).
int abBlockKind(vec2 w) {
  vec2 c = mod(w, ${N.world});
  ivec2 b = clamp(ivec2(floor(c / ${G.pitch})), ivec2(0), ivec2(${N.grid} - 1));
  return AB_BLOCK_KIND[b.x * ${N.grid} + b.y];
}
// A night park, l = metres from the block centre. Returns albedo; adds the
// lamp pools and the lit pond rim to em; marks open water in water.
vec3 abParkPaint(vec2 l, float n, float aa, inout vec3 em, inout float water) {
  float r = length(l);
  // Mown lawn: 8 m stripes (the back half of each period) and a soft mottle.
  float stripe = mix(0.5, abLine(abPeriodic(l.x, 6.0, 8.0), 2.0, aa), abDetail(8.0, aa));
  vec3 c = ${GROUND_COLORS.lawn} * (1.0 + (n - 0.5) * 0.45) * (0.92 + 0.16 * stripe);
  // A low hedge line where the lawn meets the pavement.
  if (max(abs(l.x), abs(l.y)) > ${N.lawnHalf} - 1.2) c = ${GROUND_COLORS.hedge};
  float onPath = max(
    max(step(abs(l.x), ${N.path}), step(abs(l.y), ${N.path})),
    step(abs(r - ${N.ring}), ${N.path}));
  if (onPath > 0.5) c = ${GROUND_COLORS.path} * (1.0 + (abNoise(l * 2.3) - 0.5) * 0.35);
  // Warm pool under the nearest park lamp.
  // O7: + 1e-6 here and below — atan(0, 0) is NaN on some GPUs, at the
  // one pixel on the centre.
  float k = floor((atan(l.y, l.x + 1e-6) - ${N.lampPhase}) / ${N.lampStep} + 0.5);
  float a = ${N.lampPhase} + k * ${N.lampStep};
  float pool = 1.0 - smoothstep(0.0, 9.0, length(l - vec2(cos(a), sin(a)) * ${N.lampR}));
  em += ${GROUND_COLORS.lampWarm} * pool * pool * ${PARK_POOL_GLOW};
  if (r < ${N.pond}) {
    c = ${GROUND_COLORS.water};
    water = 1.0;
  } else if (r < ${N.rimOut}) {
    c = ${GROUND_COLORS.rim};
    em += ${GROUND_COLORS.lampWarm} * ${POND_RIM_GLOW};
  }
  return c;
}
// Neon from the surrounding streetwall, reflected in a pond: hashed sign
// colours in angular sectors, strongest toward the rim.
vec3 abPondNeon(vec2 l, vec2 w) {
  float r = length(l);
  float sector = floor((atan(l.y, l.x + 1e-6) + 3.14159) / 0.5236);
  vec2 key = floor(w / ${G.pitch}) + vec2(sector * 1.37, 3.0);
  float present = step(abHash(key + 9.1), 0.6);
  int hue = int(floor(abHash(key) * ${SIGN_PALETTE.length}.0));
  float band = smoothstep(${N.pond} * 0.45, ${N.pond}, r);
  // Streaks run radially — a reflection smears toward the viewer — broken
  // only softly along the radius.
  float ripple = smoothstep(0.4, 0.85, abNoise(vec2(atan(l.y, l.x + 1e-6) * 14.0, r * 0.3)));
  return AB_NEON[hue] * present * band * ripple * 0.4;
}
// A landmark forecourt: granite slabs, lawn panels each side of the entrance.
vec3 abForecourtPaint(vec2 l, float n, float aa) {
  vec2 a = abs(l);
  float off = max(a.x, a.y);
  float along = min(a.x, a.y);
  vec3 c = ${GROUND_COLORS.paving} * (1.0 + (n - 0.5) * 0.25);
  // Slab joints: 0.12 m lines every 6 m, resolving to their 2 % share.
  float jd = abDetail(6.0, aa);
  float jx = mix(0.02, abLine(abPeriodic(l.x, 0.06, 6.0), 0.06, aa), jd);
  float jy = mix(0.02, abLine(abPeriodic(l.y, 0.06, 6.0), 0.06, aa), jd);
  c = mix(c, ${GROUND_COLORS.slabJoint}, max(jx, jy));
  if (off > ${N.lawnIn} && off < ${N.lawnOut} && along > ${N.gate} && along < ${N.lawnOut}) {
    c = ${GROUND_COLORS.lawn} * (1.0 + (n - 0.5) * 0.4);
  }
  return c;
}
// A construction site: churned earth with gravel patches.
vec3 abSitePaint(vec2 w, float n) {
  vec3 c = mix(${GROUND_COLORS.earth}, ${GROUND_COLORS.gravel},
    smoothstep(0.45, 0.62, abNoise(w * 0.18)));
  return c * (1.0 + (abNoise(w * 3.1) - 0.5) * 0.4) * (1.0 + (n - 0.5) * 0.2);
}
// --- L11 river (render/river.ts owns this paint) ---
${RIVER_GROUND_PARS}
// --- U4 tunnels (render/tunnels.ts owns the portal cuts) ---
${TUNNEL_GROUND_PARS}
${STREET_PAINT_PARS}`;

const GROUND_FRAGMENT_MAIN = /* glsl */ `
// O1: ground meters per pixel, taken HERE at the top level — every marking
// below sits inside a branch, where derivatives are undefined — and before
// the river discard, after which they are undefined too.
vec2 abPx = fwidth(vWorldXZ);
float abAA = max(abPx.x, abPx.y);
// L11: the open river channel is a hole in the ground (the water and the
// embankment walls are render/river.ts meshes). Bridge decks stay painted.
if (abRiverOpen(vWorldXZ)) discard;
// U4: so is every plaza portal's open cut (its ramp and walls are
// render/tunnels.ts meshes).
if (abPortalOpen(vWorldXZ)) discard;
float abDx = abLineDist(vWorldXZ.x);
float abDz = abLineDist(vWorldXZ.y);
float abAdx = abs(abDx);
float abAdz = abs(abDz);
float abRoadX = 1.0 - step(${G.road}, abAdx); // north–south street band
float abRoadZ = 1.0 - step(${G.road}, abAdz); // east–west street band
float abRoad = max(abRoadX, abRoadZ);
float abNoiseV = abNoise(vWorldXZ * 0.5); // ~2 m value noise
vec3 abPaint;
vec3 abEmissive = vec3(0.0);
vec3 abNeon = vec3(0.0); // Fresnel-weighted at the emissive splice
float abPud = 0.0; // puddle mask, roadway only
float abWet = 0.0; // 0 dry .. 1 standing water
float abWater = 0.0; // N1 park pond
if (abRoad > 0.5) {
  abPaint = ${GROUND_COLORS.asphalt} * (1.0 + (abNoiseV - 0.5) * 0.5);
  abPud = smoothstep(0.5, 0.68, abNoise(vWorldXZ * 0.085 + 13.0));
  abWet = 0.45 + 0.55 * abPud;
  // Wear mask: markings survive where it passes (light wear on the wet look).
  // Value noise at 0.77/m: its gradient is ~1.2 per metre, and ~93 % of it
  // lies above the threshold — what the mask resolves to once sub-pixel.
  float abWear = mix(0.93, abEdge(0.18, abNoise(vWorldXZ * 0.77 + 40.0), abAA * 1.2), abDetail(1.3, abAA));
  // G1 (street-paint.ts): the street frame, tyre tracks, patches, stains,
  // manholes and drains — under the markings below.
${STREET_ROAD_BASE_GLSL}  if (abRoadX * abRoadZ < 0.5) { // outside the intersection core
    float abAlong = abRoadX > 0.5 ? vWorldXZ.y : vWorldXZ.x;
    float abCross = abRoadX > 0.5 ? abDx : abDz;
    float abAcr = abs(abCross);
    float abOther = abRoadX > 0.5 ? abAdz : abAdx;
    if (abOther <= ${G.xwalkOut}) {
      // Crosswalk zebra on this approach: stripes repeat across the roadway.
      // Stripes 0.95 m wide every 1.7 m, resolving to their 56 % duty cycle.
      float abS = abPeriodic(abRoadX > 0.5 ? vWorldXZ.x : vWorldXZ.y, 0.475, 1.7);
      float abStripe = mix(0.56, abLine(abS, 0.475, abAA), abDetail(1.7, abAA));
      float abZebra = abStripe * (1.0 - abEdge(${G.road} - 0.6, abAcr, abAA)) * abWear;
      abPaint = mix(abPaint, ${GROUND_COLORS.zebra}, abZebra * 0.9);
      abEmissive += ${GROUND_COLORS.zebra} * abZebra * ${MARKING_GLOW};
    } else {
      // Dashed center line (3 m on / 3 m off) + solid lane-edge lines.
      float abDashOn = mix(0.5, abLine(abPeriodic(abAlong, 1.5, 6.0), 1.5, abAA), abDetail(6.0, abAA));
      float abDash = abLine(abAcr, 0.18, abAA) * abDashOn * abWear;
      // G1: a parking side trades the lane-edge line for its parking line.
      float abEdgeLine = abLine(abs(abAcr - (${G.edgeIn} + ${G.edgeOut}) * 0.5), (${G.edgeOut} - ${G.edgeIn}) * 0.5, abAA) * abWear * (1.0 - abGPark);
      abPaint = mix(abPaint, ${GROUND_COLORS.marking}, abDash * 0.95);
      abPaint = mix(abPaint, ${GROUND_COLORS.edge}, abEdgeLine * 0.85);
      abEmissive += (${GROUND_COLORS.marking} * abDash + ${GROUND_COLORS.edge} * abEdgeLine * 0.6) * ${MARKING_GLOW};
    }
    // G1 (street-paint.ts): stop bars, arrows, words, bike lanes, parking.
${STREET_ROAD_MARK_GLSL}
    // Wet sheen: lamp glow smeared into a warm streak under each lamp.
    float abStr =
      abStreak(abStationDist(abAlong, ${G.stationsPlus}), abCross - ${G.streakCross}) +
      abStreak(abStationDist(abAlong, ${G.stationsMinus}), abCross + ${G.streakCross});
    abEmissive += ${GROUND_COLORS.lampWarm} * abStr * ${STREAK_GLOW};
    // Neon sign spill along both curbs (side = which curb).
    float abStreetLine = floor((abRoadX > 0.5 ? vWorldXZ.x : vWorldXZ.y) / ${G.pitch} + 0.5);
    float abSide = step(0.0, abCross);
    abNeon = abNeonSpill(abStreetLine, abAlong, abSide, abAcr - ${G.neonCross});
  }
  // Standing water darkens everything under it, paint included.
  abPaint *= mix(1.0, ${PUDDLE_DARKEN}, abPud);
} else {
  float abWalkX = 1.0 - step(${G.walkOut}, abAdx);
  float abWalkZ = 1.0 - step(${G.walkOut}, abAdz);
  if (max(abWalkX, abWalkZ) > 0.5) {
    // Sidewalk concrete with expansion joints every 5 m and a curb stone.
    abPaint = ${GROUND_COLORS.sidewalk} * (1.0 + (abNoiseV - 0.5) * 0.3);
    // Joints: 0.15 m lines every 5 m, resolving to their 3 % share.
    float abJd = abDetail(5.0, abAA);
    float abJoint = max(
      abWalkX * mix(0.03, abLine(abPeriodic(vWorldXZ.y, 0.075, 5.0), 0.075, abAA), abJd),
      abWalkZ * mix(0.03, abLine(abPeriodic(vWorldXZ.x, 0.075, 5.0), 0.075, abAA), abJd));
    abPaint = mix(abPaint, ${GROUND_COLORS.seam}, abJoint);
    float abCurb = max(
      abWalkX * (1.0 - abEdge(${G.curb} + 0.5, abAdx, abAA)),
      abWalkZ * (1.0 - abEdge(${G.curb} + 0.5, abAdz, abAA)));
    abPaint = mix(abPaint, ${GROUND_COLORS.curb}, abCurb);
    // G1 (street-paint.ts): coloured curbs, ramps, flags, tree grates.
${STREET_WALK_GLSL}  } else {
    abPaint = ${GROUND_COLORS.interior}; // block interiors: darkest
    // N1: parks, landmark forecourts and construction sites paint their own.
    int abKind = abBlockKind(vWorldXZ);
    vec2 abLocal = mod(vWorldXZ, ${G.pitch}) - ${G.pitch} * 0.5;
    if (abKind == ${N.park}) {
      abPaint = abParkPaint(abLocal, abNoiseV, abAA, abEmissive, abWater);
      if (abWater > 0.5) {
        // Open water: the wet look's sky sheen at full wetness, plus the
        // streetwall's neon smeared across the surface.
        abWet = 1.0;
        abNeon = abPondNeon(abLocal, vWorldXZ);
      }
    } else if (abKind == ${N.forecourt}) {
      abPaint = abForecourtPaint(abLocal, abNoiseV, abAA);
    } else if (abKind == ${N.site}) {
      abPaint = abSitePaint(vWorldXZ, abNoiseV);
    } else if (abKind == ${N.river}) {
      abPaint = abPromenadePaint(vWorldXZ, abNoiseV, ${GROUND_COLORS.paving}, ${GROUND_COLORS.slabJoint}, abEmissive);
    }
  }
}
diffuseColor.rgb = abPaint;
`;

/** The ground patch sources, for tests that assert on the shader without a
 * GPU (the AA contract: every marking filtered, derivatives at top level). */
export const GROUND_SHADER_SOURCE = {
  fragmentPars: GROUND_FRAGMENT_PARS,
  fragmentMain: GROUND_FRAGMENT_MAIN,
} as const;

export class GroundPlane {
  readonly mesh: THREE.Mesh;
  private readonly origin: THREE.Vector2;

  constructor() {
    this.origin = new THREE.Vector2();
    const material = new THREE.MeshStandardMaterial({ roughness: 1 });
    // Three keys its program cache on onBeforeCompile.toString(); an explicit
    // key keeps this patch from colliding with the other patched materials.
    material.customProgramCacheKey = () => "ab-ground-paint-g1-s6-refl";
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uGroundOrigin = { value: this.origin };
      // L4: the shared weather uniform (render/weather.ts), by reference.
      shader.uniforms.uWeather = WEATHER_UNIFORM;
      // G1: the quality tier's street-paint switch, shared by reference.
      shader.uniforms.uStreetPaint = STREET_PAINT_UNIFORM;
      // D9: a fallen bridge span's deck is open water, not road.
      shader.uniforms.uBridgeGone = BRIDGE_GONE_UNIFORM;
      // S6: the reflection probe, by reference (puddles and ponds).
      bindReflectionUniforms(shader.uniforms);
      // L7: the fire lights on the street, by reference.
      bindInfernoUniforms(shader.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\n${GROUND_VERTEX_PARS}`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${GROUND_VERTEX_MAIN}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\n${GROUND_FRAGMENT_PARS}${WEATHER_PARS_GLSL}${REFLECTION_PARS_GLSL}${INFERNO_PARS_GLSL}`,
        )
        .replace(
          "vec4 diffuseColor = vec4( diffuse, opacity );",
          `vec4 diffuseColor = vec4( diffuse, opacity );\n${GROUND_FRAGMENT_MAIN}${GROUND_WET_GLSL}`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          // Damp roadway; puddles smoother up close, fading back with
          // distance so a moon glint never sparkles from altitude.
          `#include <roughnessmap_fragment>
float abNear = 1.0 - smoothstep(${PUDDLE_FADE.near}, ${PUDDLE_FADE.far}, length(vViewPosition));
roughnessFactor = mix(roughnessFactor, mix(${ROADWAY_ROUGHNESS}, ${PUDDLE_ROUGHNESS}, abPud * abNear), abRoad);
roughnessFactor = mix(roughnessFactor, mix(${ROADWAY_ROUGHNESS}, ${POND_ROUGHNESS}, abNear), abWater);`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          // Faked reflections: Schlick Fresnel (water F0 0.02) on the view
          // angle, so the sheen and the neon spill grow toward grazing — the
          // way a wet street lights up toward the horizon.
          `#include <emissivemap_fragment>
float abFres = 0.02 + 0.98 * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 5.0);
// S6: puddles and ponds mirror the reflection probe (reflections.ts) where
// a camera-centred probe agrees with the street — the reflected ray well
// above the horizon, the camera low enough that the puddle is not just sky —
// and hand back to the faked sheen everywhere else.
float abRfK = 0.0;
vec3 abRfD = vec3(0.0, 1.0, 0.0);
if (uReflOn > 0.5) {
  abRfK = max(abPud, abWater) * abNear
    * (1.0 - smoothstep(${glslNum(REFL_PUDDLE_CAM_Y.near)}, ${glslNum(REFL_PUDDLE_CAM_Y.far)}, cameraPosition.y));
  if (abRfK > 0.0) {
    abRfD = inverseTransformDirection(reflect(normalize(-vViewPosition), normal), viewMatrix);
    abRfK *= abReflElev(abRfD);
  }
}
if (abRfK > 0.0) {
  totalEmissiveRadiance += abRefl(abRfD, ${glslNum(REFL_PUDDLE_LOD)}) * (abFres * abRfK);
}
totalEmissiveRadiance += abEmissive
  + ${SHEEN_COLOR} * (${SHEEN_GAIN} * abFres * abWet * (1.0 - abRfK))
  + abNeon * (0.5 + 0.5 * abWet) * (0.55 + 0.45 * abFres);
if (abWater > 0.5) {
  // Faked moon reflection: the view ray mirrored off a gently rippled pond,
  // against the moon's direction. Ripples and glint calm down with distance
  // (abNear) so the pond never sparkles from altitude.
  vec2 abRip = vec2(abNoise(vWorldXZ * 0.9), abNoise(vWorldXZ * 0.9 + 17.0)) - 0.5;
  vec3 abN = normalize(normal + vec3(abRip.x, 0.0, abRip.y) * 0.08 * abNear);
  vec3 abRefl = reflect(normalize(-vViewPosition), abN);
  vec3 abMoonV = normalize((viewMatrix * vec4(${N.moonDir}, 0.0)).xyz);
  float abGlint = pow(max(dot(abRefl, abMoonV), 0.0), ${POND_GLINT_POWER});
  totalEmissiveRadiance += ${GROUND_COLORS.moon} * abGlint * ${POND_GLINT} * mix(0.35, 1.0, abNear);
}
${FIRELIGHT_GROUND_GLSL}`,
        )
        // L4 weather (render/weather.ts): wet roughness after the VO5 lines,
        // rain ripples once the emissive is final.
        .replace(
          "#include <metalnessmap_fragment>",
          `${GROUND_WET_ROUGHNESS_GLSL}\n#include <metalnessmap_fragment>`,
        )
        .replace(
          "#include <lights_physical_fragment>",
          `#include <lights_physical_fragment>\n${GROUND_WET_EMISSIVE_GLSL}`,
        )
        // G1: per-FRAGMENT fog distance. O1's radial fog takes
        // length(mvPosition) per VERTEX, and this plane is two 1.8 km
        // triangles: interpolated from corners ~1.3 km out, every ground
        // pixel read as far fog and the whole street paint was fogged flat.
        // vViewPosition is affine, so its per-fragment length is exact.
        .replace(
          "#include <fog_fragment>",
          `#ifdef USE_FOG\nfloat abGroundFogDepth = length(vViewPosition);\n#endif\n${THREE.ShaderChunk.fog_fragment.replaceAll("vFogDepth", "abGroundFogDepth")}`,
        )
        .replace(
          "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
          `vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
outgoingLight *= min(1.0, ${GROUND_LUMA_CAP} / max(luminance(outgoingLight), 1e-4));`,
        );
    };
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(
        GROUND_SIZE,
        GROUND_SIZE,
        GROUND_SEGMENTS,
        GROUND_SEGMENTS,
      ),
      material,
    );
    this.mesh.rotation.x = -Math.PI / 2;
  }

  /** Follow the camera; keep the paint glued to canonical world coords. */
  update(cameraPos: Vec3): void {
    this.mesh.position.set(cameraPos.x, 0, cameraPos.z);
    const canonical = canonicalize(cameraPos);
    this.origin.set(canonical.x, canonical.z);
  }
}
