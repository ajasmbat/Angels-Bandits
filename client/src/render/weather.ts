// L4 wet surfaces: the weather's look on the ground and the buildings, as
// GLSL splices plus ONE shared uniform. No new draw calls, no defines and no
// needsUpdate — the weather moves by uniform only, so a phase change never
// recompiles a program.
//
// `WEATHER_UNIFORM` is a single uniform object that the ground (sky.ts) and
// the buildings (buildings-material.ts) both put straight into their
// onBeforeCompile uniforms, so one write per frame drives both:
//   x = wetness 0..1 (lags the rain, dries slowly — common/src/weather.ts)
//   y = rain 0..1
//   z = ripple clock, s, wrapped to RIPPLE_WRAP_S on the CPU (raw epoch
//       seconds are ~1.8e9 — float32 would freeze the ripples)
//   w = unused (0)
//
// Wet reflections are faked like VO5's: darker albedo, lower roughness, and
// emissive sheen/ripples — never SSR. Every new term stays far under the 0.72
// bloom threshold (the ground additionally sits under its own luma cap).

import {
  CLEAR_WEATHER,
  type Weather,
  weatherAt,
} from "@angels-bandits/common/weather";
import * as THREE from "three";
import { SIGN_PALETTE } from "./signage";

export const WEATHER_UNIFORM = { value: new THREE.Vector4() };

/** Ripple clock wrap, s. Every ripple period (1, 1.5, 2 s) divides it, so
 * the wrap is seamless. */
export const RIPPLE_WRAP_S = 600;

/** The weather curves move over minutes — resample at most this often, ms
 * (keeps weatherAt's small allocations out of most frames). */
const RESAMPLE_MS = 250;

/** Cached sampler of the shared cycle: CLEAR_WEATHER until the synced clock
 * exists (never a local clock — every client must agree). */
export class WeatherClock {
  private lastMs = Number.NEGATIVE_INFINITY;
  private current: Weather = CLEAR_WEATHER;

  constructor(private readonly seed: number) {}

  at(syncedMs: number | null): Weather {
    if (syncedMs === null) return CLEAR_WEATHER;
    if (Math.abs(syncedMs - this.lastMs) >= RESAMPLE_MS) {
      this.current = weatherAt(this.seed, syncedMs);
      this.lastMs = syncedMs;
    }
    return this.current;
  }
}

/** Feed this frame's weather. `syncedMs` null (clock not synced yet) keeps the
 * ripple clock still — there is no rain before sync anyway. */
export function setWeatherUniform(wx: Weather, syncedMs: number | null): void {
  WEATHER_UNIFORM.value.set(
    wx.wetness,
    wx.rain,
    syncedMs === null ? 0 : (syncedMs / 1000) % RIPPLE_WRAP_S,
    0,
  );
}

/** Linear-space GLSL literal for an sRGB hex. */
const glslColor = (hex: number): string => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

/** Sky sheen on wet surfaces: the horizon violet the VO5 puddles reflect. */
const WET_SHEEN_COLOR = glslColor(0x6c62b0);
/** Ripple/splash gain on the sheen colour (~0.12 luminance peak per ring). */
const RIPPLE_GAIN = "0.55";
/** Ripples fade out over this view distance, m — sub-pixel rings sparkle. */
const RIPPLE_FADE = { near: "12.0", far: "55.0" } as const;

/** Uniform + ripple field, shared by both materials' fragment pars. */
export const WEATHER_PARS_GLSL = /* glsl */ `
uniform vec4 uWeather;
float abWxHash(vec2 p) { return fract(sin(dot(p, vec2(41.31, 289.17))) * 45758.5453); }
// One layer of raindrop rings: a hashed drop per cell (a fraction of cells
// active, more in harder rain), a ring expanding from it and a short splash
// dot at impact. Periods 1 / 1.5 / 2 s all divide the wrapped clock.
float abWxRippleLayer(vec2 p, float t, float cell, float rain) {
  vec2 wxId = floor(p / cell);
  vec2 wxF = p / cell - wxId;
  float wxH = abWxHash(wxId);
  float wxActive = step(abWxHash(wxId + 17.3), rain);
  float wxPeriod = 1.0 + floor(wxH * 3.0) * 0.5;
  float wxPh = fract(t / wxPeriod + wxH);
  vec2 wxC = 0.25 + 0.5 * vec2(abWxHash(wxId + 3.1), abWxHash(wxId + 7.7));
  float wxR = length(wxF - wxC);
  float wxRing = (1.0 - smoothstep(0.0, 0.035, abs(wxR - wxPh * 0.32))) * (1.0 - wxPh) * (1.0 - wxPh);
  float wxSplash = (1.0 - smoothstep(0.0, 0.07, wxR)) * (1.0 - smoothstep(0.0, 0.12, wxPh));
  return wxActive * (wxRing + wxSplash);
}
float abWxRipples(vec2 p, float t, float rain) {
  return abWxRippleLayer(p, t, 1.1, rain)
    + abWxRippleLayer(p + vec2(0.37, 0.71), t + 0.33, 0.8, rain);
}
`;

// --- Ground (sky.ts GroundPlane) --------------------------------------------
// Spliced right AFTER GROUND_FRAGMENT_MAIN, reading its locals (abRoad, abPud,
// abWet, abWater, abEmissive, abNeon) — a separate block, so the markings
// work in that shader is untouched.

/** Wet asphalt/concrete darkening at full wetness. */
const GROUND_WET_DARKEN = "0.72";
/** Extra darkening where a NEW (rain-grown) puddle stands. */
const GROUND_PUDDLE_DARKEN = "0.62";

export const GROUND_WET_GLSL = /* glsl */ `
// --- L4 weather: wet ground ---
if (uWeather.x > 0.0) {
  float abWxW = uWeather.x;
  // Puddles spread across the roadway as the streets soak.
  float abWxPud = abRoad * smoothstep(0.62 - 0.22 * abWxW, 0.72 - 0.12 * abWxW,
    abNoise(vWorldXZ * 0.085 + 13.0));
  float abWxNew = max(0.0, abWxPud - abPud);
  abPud = max(abPud, abWxPud);
  diffuseColor.rgb *= mix(1.0, ${GROUND_WET_DARKEN}, abWxW) * mix(1.0, ${GROUND_PUDDLE_DARKEN}, abWxNew);
  // Glossier everywhere: roadway toward standing water, sidewalks a sheen.
  abWet = mix(abWet, 1.0, abWxW * mix(0.5, 0.85, abRoad));
  // Stronger neon and lamp reflections on the soaked street.
  abNeon *= 1.0 + 0.9 * abWxW;
  abEmissive *= 1.0 + 0.5 * abWxW;
}
`;

/** Before metalnessmap_fragment: after the VO5 roughness lines. */
export const GROUND_WET_ROUGHNESS_GLSL = /* glsl */ `
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.6, uWeather.x);
`;

/** After lights_physical_fragment: the emissive is final by then. */
export const GROUND_WET_EMISSIVE_GLSL = /* glsl */ `
if (uWeather.y > 0.0) {
  float abWxFade = 1.0 - smoothstep(${RIPPLE_FADE.near}, ${RIPPLE_FADE.far}, length(vViewPosition));
  if (abWxFade > 0.0) {
    // Full rings in standing water; faint splashes on merely wet ground.
    float abWxSurf = mix(0.25 * uWeather.x, 1.0, max(abPud, abWater));
    totalEmissiveRadiance += ${WET_SHEEN_COLOR} * (${RIPPLE_GAIN} * abWxFade * abWxSurf
      * abWxRipples(vWorldXZ, uWeather.z, uWeather.y));
  }
}
`;

// --- Buildings (buildings-material.ts) --------------------------------------
// Read the window-grid/roof locals (`facade`, `roofUp`, `pane`, `lit`).

/** Facade / roof albedo darkening at full wetness. */
const FACADE_WET_DARKEN = "0.15";
const ROOF_WET_DARKEN = "0.3";
/** Fresnel sheen gain: WET_SHEEN_COLOR (~0.29 luminance) × 0.25 ≈ 0.07 peak
 * at full grazing — a slight sheen, the facade stays far sub-bloom. */
const FACADE_SHEEN_GAIN = "0.25";

/** After the facade/roof colour passes. */
export const BUILDING_WET_COLOR_GLSL = /* glsl */ `
// --- L4 weather: wet facades and roofs ---
diffuseColor.rgb *= 1.0 - uWeather.x * (${FACADE_WET_DARKEN} * facade + ${ROOF_WET_DARKEN} * roofUp);
`;

/** Before metalnessmap_fragment: a wet skin is smoother — the moon key
 * picks up a slight sheen. */
export const BUILDING_WET_ROUGHNESS_GLSL = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 0.45, uWeather.x * (0.6 * facade + 0.8 * roofUp));
`;

/** S5 wet roofs: peak luminance of a sign's reflection in a roof puddle
 * (before Fresnel and wetness) — sub-bloom, like the ground's neon smear. */
export const ROOF_REFLECTION_LUM = 0.24;
/** Reflection cells on the roof, m: one possible sign smear per cell. */
const ROOF_REFLECTION_CELL = 12;
/** Share of the cells that carry a reflection. */
const ROOF_REFLECTION_SHARE = 0.3;
/** The signs' palette at equal luminance ROOF_REFLECTION_LUM (GLSL array). */
const ROOF_REFLECTION_PALETTE = `vec3[${SIGN_PALETTE.length}](${SIGN_PALETTE.map(
  (c) => {
    const k =
      ROOF_REFLECTION_LUM / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
    return `vec3(${(c.r * k).toFixed(4)}, ${(c.g * k).toFixed(4)}, ${(c.b * k).toFixed(4)})`;
  },
).join(", ")})`;

/**
 * S5: rain-wet roofs pool into puddles, and the puddles hold the city's
 * signs — a smear of sign colour per roof cell, stretched toward the viewer
 * the way a reflection in standing water is. Faked like every other wet
 * reflection here (emissive, never SSR): world-anchored cells, so a frozen
 * camera sees a still image; Fresnel-weighted and scaled by wetness, so it
 * comes and goes with the weather. Uniform-only.
 */
const ROOF_REFLECTION_GLSL = /* glsl */ `
  // Fades out with distance before the 6 m puddles go sub-pixel (aliasing).
  float wxRoofFade = 1.0 - smoothstep(160.0, 420.0, length(vViewPosition));
  if (roofUp > 0.5 && wxRoofFade > 0.0) {
    vec2 wxRfRp = vBWorldPos.xz;
    // Puddles: value noise (~9 m blobs), spreading as the roof soaks.
    vec2 wxRfI = floor(wxRfRp * 0.11);
    vec2 wxRfF = fract(wxRfRp * 0.11);
    vec2 wxRfU = wxRfF * wxRfF * (3.0 - 2.0 * wxRfF);
    float wxRfN = mix(mix(abWxHash(wxRfI), abWxHash(wxRfI + vec2(1.0, 0.0)), wxRfU.x),
      mix(abWxHash(wxRfI + vec2(0.0, 1.0)), abWxHash(wxRfI + vec2(1.0, 1.0)), wxRfU.x), wxRfU.y);
    float wxRfPud = smoothstep(0.62 - 0.2 * uWeather.x, 0.72 - 0.1 * uWeather.x, wxRfN);
    if (wxRfPud > 0.0) {
      // One sign's smear per cell, stretched along the ground view ray.
      vec2 wxRfCell = floor(wxRfRp / ${ROOF_REFLECTION_CELL.toFixed(1)});
      float wxRfH = abWxHash(wxRfCell + 31.7);
      vec2 wxRfD = wxRfRp - (wxRfCell + 0.5) * ${ROOF_REFLECTION_CELL.toFixed(1)};
      vec2 wxRfV = vBWorldPos.xz - cameraPosition.xz;
      wxRfV = wxRfV / max(length(wxRfV), 1e-3);
      float wxRfAlong = dot(wxRfD, wxRfV);
      float wxRfAcross = wxRfD.x * wxRfV.y - wxRfD.y * wxRfV.x;
      float wxRfSmear = exp(-wxRfAcross * wxRfAcross * 0.35 - wxRfAlong * wxRfAlong * 0.04)
        * step(wxRfH, ${ROOF_REFLECTION_SHARE.toFixed(2)});
      int wxRfIdx = int(floor(abWxHash(wxRfCell + 5.3) * ${SIGN_PALETTE.length.toFixed(1)}));
      vec3 wxRfSign = ${ROOF_REFLECTION_PALETTE}[wxRfIdx];
      float wxRfGraze = 0.3 + 0.7 * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.0);
      totalEmissiveRadiance += wxRfSign * (wxRfSmear * wxRfPud * wxRfGraze * wxRoofFade * uWeather.x);
    }
  }
`;

/** After every other emissive term (it adds; lit panes keep their glow). */
export const BUILDING_WET_EMISSIVE_GLSL = /* glsl */ `
if (uWeather.x > 0.0) {
  float wxFres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 5.0);
  // S6: a GLASS pane under the reflection probe already mirrors at its own
  // Fresnel (buildings-material.ts) — the wet sheen skips it, never doubles.
  totalEmissiveRadiance += ${WET_SHEEN_COLOR} * (${FACADE_SHEEN_GAIN} * wxFres * uWeather.x
    * (facade * (1.0 - pane * lit) * (1.0 - uReflOn * step(vArch, 0.5) * pane) + roofUp));
  float wxFade = 1.0 - smoothstep(${RIPPLE_FADE.near}, ${RIPPLE_FADE.far}, length(vViewPosition));
  if (uWeather.y > 0.0 && roofUp > 0.5 && wxFade > 0.0) {
    totalEmissiveRadiance += ${WET_SHEEN_COLOR} * (${RIPPLE_GAIN} * wxFade * uWeather.x
      * abWxRipples(vBWorldPos.xz, uWeather.z, uWeather.y));
  }
${ROOF_REFLECTION_GLSL}}
`;
