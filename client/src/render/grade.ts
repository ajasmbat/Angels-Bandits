// Final grade (VO5 filmic grade, L1 "Stormlit" retune): saturation, a
// contrast S-curve, a steel-blue-shadow / amber-highlight split-tone, a
// violet-to-steel correction in the shadows, a deep (barely lifted) black
// floor, a vignette and a static film grain, on the display-referred image. Applied AFTER tone mapping and the
// sRGB encode (O4: inside the same final pass, render/post.ts), so it works
// in tonemapped sRGB where "10 % darker at the corners" means what it says — in linear HDR the same vignette would eat the
// emissive ladder's headroom unevenly across the frame. Bloom has already run
// by then, so nothing here moves which pixels cross the 0.72 threshold.
//
// Order matters: ACES already has a toe and shoulder, so the S-curve is mild
// and comes BEFORE the lift — the other way round it would re-crush the floor
// it is meant to raise. Saturation goes first so it doesn't amplify the tint.
// The grain (L1) replaces VO5's ±0.5/255 dither: it keeps that floor at
// black, so the dark sky still never bands on an 8-bit canvas, and grows to
// GRAIN in the mid-tones. It is STATIC (screen-space, no time input): the
// O5/O6 frozen-camera flicker metric scores any frame-to-frame change as
// shimmer, and an animated grain would be exactly that. Off with `?grade=0`
// so the perf harness can A/B its cost.

import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

/** Darkening at the very corner, 0..1 — the centre is untouched. */
export const VIGNETTE_STRENGTH = 0.3;
/** Where the falloff starts, as a fraction of the half-diagonal. */
export const VIGNETTE_START = 0.45;
/** Saturation multiplier: 1 is neutral. */
export const SATURATION = 1.08;
/** S-curve mix toward smoothstep(c): 0 is neutral, 1 a full smoothstep.
 * L1 deepened it (0.14 → 0.24) for the reference's deep blacks. */
export const CONTRAST = 0.24;
/** Black floor per channel (sRGB): pure black lands here, a deep steel blue
 * (L1: VO5's teal floor was ~3x higher and read as haze). */
export const LIFT: readonly [number, number, number] = [0.004, 0.006, 0.01];
/** Shadow tint, added at full weight on black and fading by (1-luma)²:
 * steel blue. */
export const SHADOW_TINT: readonly [number, number, number] = [
  -0.02, 0.004, 0.03,
];
/** Highlight tint, added at full weight on white and fading by luma²:
 * warm amber, the sodium lights. */
export const HIGHLIGHT_TINT: readonly [number, number, number] = [
  0.05, 0.016, -0.045,
];
/** L1: how much of a dark pixel's violet cast (red riding with blue above
 * green) is pulled out, 0..1, fading out by luma — lilac shadows go steel,
 * amber (blue below green) and bright neon are untouched. */
export const DEPURPLE = 0.6;
/** L1: static film grain amplitude at mid-grey (display-referred); it
 * falls to the old 0.5/255 dither at black and at white. */
export const GRAIN = 0.012;

const vec3Of = (v: readonly number[]): string =>
  `vec3(${v.map((n) => n.toFixed(4)).join(", ")})`;

/** The grade's uniforms, fresh per material (the sky cycle writes the
 * split-tone into the copy the shader actually reads). */
export function gradeUniforms(): Record<string, THREE.IUniform> {
  return {
    uVignette: { value: VIGNETTE_STRENGTH },
    uStart: { value: VIGNETTE_START },
    uSaturation: { value: SATURATION },
    uContrast: { value: CONTRAST },
    // L12 sky cycle: the split-tone shifts with the time of night.
    uShadowTint: { value: new THREE.Vector3(...SHADOW_TINT) },
    uHighlightTint: { value: new THREE.Vector3(...HIGHLIGHT_TINT) },
  };
}

/** Uniform declarations for GRADE_GLSL. */
export const GRADE_PARS_GLSL = /* glsl */ `
uniform float uVignette;
uniform float uStart;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
const vec3 GRADE_LUMA = vec3(0.2126, 0.7152, 0.0722);
`;

/**
 * The grade itself, on the display-referred (tonemapped, sRGB-encoded)
 * colour in `gl_FragColor`, with `vUv` the screen position. O4: spliced into
 * the final output pass (render/post.ts) instead of running as a pass of its
 * own — the same maths, one full-resolution read and write fewer.
 */
export const GRADE_GLSL = /* glsl */ `
{
  vec3 g = clamp(gl_FragColor.rgb, 0.0, 1.0);
  // Saturation about Rec. 709 luma.
  g = mix(vec3(dot(g, GRADE_LUMA)), g, uSaturation);
  g = clamp(g, 0.0, 1.0);
  // Mild S-curve: blend toward smoothstep, pivoting at mid-grey.
  g = mix(g, g * g * (3.0 - 2.0 * g), uContrast);
  // L1: violet → steel in the dark: the share of red that rides with blue
  // above green (lilac, magenta) comes out, weighted toward the shadows.
  float l = dot(g, GRADE_LUMA);
  float violet = max(min(g.r, g.b) - g.g, 0.0);
  g.r -= ${DEPURPLE.toFixed(3)} * violet * (1.0 - l) * (1.0 - l);
  // Split-tone: steel blue in the shadows, amber in the highlights.
  l = dot(g, GRADE_LUMA);
  g += uShadowTint * (1.0 - l) * (1.0 - l);
  g += uHighlightTint * l * l;
  g = clamp(g, 0.0, 1.0);
  // Lifted blacks: remap [0,1] onto [LIFT,1] per channel.
  vec3 lift = ${vec3Of(LIFT)};
  g = lift + g * (1.0 - lift);
  // Vignette: radial from the centre, normalised so the corner is 1.
  vec2 d = (vUv - 0.5) * 2.0;
  float r = length(d) / 1.41421356;
  float v = smoothstep(uStart, 1.0, r);
  g *= 1.0 - uVignette * v * v;
  // Static grain (L1): screen-space noise, ±0.5/255 at black and white
  // (the old anti-banding dither) up to GRAIN at mid-grey. No time input.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float gLum = dot(clamp(g, 0.0, 1.0), GRADE_LUMA);
  g += (n - 0.5) * (1.0 / 255.0 + ${(2 * GRAIN).toFixed(4)} * 4.0 * gLum * (1.0 - gLum));
  gl_FragColor.rgb = g;
}
`;

/** Set the split-tone on the pass that carries the grade's uniforms. */
export function setGradeTone(
  pass: { uniforms: Record<string, THREE.IUniform> },
  shadow: readonly number[],
  highlight: readonly number[],
): void {
  (pass.uniforms.uShadowTint?.value as THREE.Vector3).fromArray(shadow);
  (pass.uniforms.uHighlightTint?.value as THREE.Vector3).fromArray(highlight);
}

/**
 * The grade as a pass of its own, after the OutputPass — the pre-O4 chain,
 * kept for `?post=legacy` so the harness can A/B the fused final pass.
 */
export function createGradePass(): ShaderPass {
  return new ShaderPass({
    name: "AbGradeShader",
    uniforms: { tDiffuse: { value: null }, ...gradeUniforms() },
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
    fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
${GRADE_PARS_GLSL}
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tDiffuse, vUv);
${GRADE_GLSL}
}
`,
  });
}
