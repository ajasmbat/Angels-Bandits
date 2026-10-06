// Final grade (VO5 filmic grade): saturation, a mild contrast S-curve, a
// teal-shadow / amber-highlight split-tone, a lifted black floor and a soft
// vignette, on the display-referred image. One fullscreen pass AFTER the
// OutputPass, so it works in tonemapped sRGB where "10 % darker at the
// corners" means what it says — in linear HDR the same vignette would eat the
// emissive ladder's headroom unevenly across the frame. Bloom has already run
// by then, so nothing here moves which pixels cross the 0.72 threshold.
//
// Order matters: ACES already has a toe and shoulder, so the S-curve is mild
// and comes BEFORE the lift — the other way round it would re-crush the floor
// it is meant to raise. Saturation goes first so it doesn't amplify the tint.
// A ±0.5/255 dither keeps the teal floor + vignette from banding in the dark
// sky on an 8-bit canvas. Off with `?grade=0` so the perf harness can A/B the
// cost of the pass itself.

import type * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

/** Darkening at the very corner, 0..1 — the centre is untouched. */
export const VIGNETTE_STRENGTH = 0.22;
/** Where the falloff starts, as a fraction of the half-diagonal. */
export const VIGNETTE_START = 0.5;
/** Saturation multiplier: 1 is neutral. */
export const SATURATION = 1.06;
/** S-curve mix toward smoothstep(c): 0 is neutral, 1 a full smoothstep. */
export const CONTRAST = 0.14;
/** Black floor per channel (sRGB): pure black lands here, a cool teal-blue. */
export const LIFT: readonly [number, number, number] = [0.012, 0.022, 0.03];
/** Shadow tint, added at full weight on black and fading by (1-luma)². */
export const SHADOW_TINT: readonly [number, number, number] = [
  -0.026, 0.012, 0.032,
];
/** Highlight tint, added at full weight on white and fading by luma². */
export const HIGHLIGHT_TINT: readonly [number, number, number] = [
  0.042, 0.012, -0.048,
];

const vec3Of = (v: readonly number[]): string =>
  `vec3(${v.map((n) => n.toFixed(4)).join(", ")})`;

const GradeShader = {
  name: "AbGradeShader",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: VIGNETTE_STRENGTH },
    uStart: { value: VIGNETTE_START },
    uSaturation: { value: SATURATION },
    uContrast: { value: CONTRAST },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uVignette;
uniform float uStart;
uniform float uSaturation;
uniform float uContrast;
varying vec2 vUv;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 g = clamp(c.rgb, 0.0, 1.0);
  // Saturation about Rec. 709 luma.
  g = mix(vec3(dot(g, LUMA)), g, uSaturation);
  g = clamp(g, 0.0, 1.0);
  // Mild S-curve: blend toward smoothstep, pivoting at mid-grey.
  g = mix(g, g * g * (3.0 - 2.0 * g), uContrast);
  // Split-tone: teal in the shadows, amber in the highlights.
  float l = dot(g, LUMA);
  g += ${vec3Of(SHADOW_TINT)} * (1.0 - l) * (1.0 - l);
  g += ${vec3Of(HIGHLIGHT_TINT)} * l * l;
  g = clamp(g, 0.0, 1.0);
  // Lifted blacks: remap [0,1] onto [LIFT,1] per channel.
  vec3 lift = ${vec3Of(LIFT)};
  g = lift + g * (1.0 - lift);
  // Vignette: radial from the centre, normalised so the corner is 1.
  vec2 d = (vUv - 0.5) * 2.0;
  float r = length(d) / 1.41421356;
  float v = smoothstep(uStart, 1.0, r);
  g *= 1.0 - uVignette * v * v;
  // Dither: ±0.5/255 of screen-space noise against 8-bit banding.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  g += (n - 0.5) / 255.0;
  gl_FragColor = vec4(g, c.a);
}
`,
};

/** The grade pass, ready to add to the composer after the OutputPass. */
export function createGradePass(): ShaderPass {
  return new ShaderPass(GradeShader);
}
