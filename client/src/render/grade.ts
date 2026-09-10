// Final grade (visual polish): a soft vignette and a touch of saturation on
// the display-referred image. One fullscreen pass AFTER the OutputPass, so it
// works in tonemapped sRGB where "10 % darker at the corners" means what it
// says — in linear HDR the same vignette would eat the emissive ladder's
// headroom unevenly across the frame.
//
// It is deliberately small: no contrast curve, no colour shift. The night
// look is carried by the ladder and the bloom; this only frames it. Off with
// `?grade=0` so the perf harness can A/B the cost of the pass itself.

import type * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

/** Darkening at the very corner, 0..1 — the centre is untouched. */
export const VIGNETTE_STRENGTH = 0.32;
/** Where the falloff starts, as a fraction of the half-diagonal. */
export const VIGNETTE_START = 0.45;
/** Saturation multiplier: 1 is neutral. */
export const SATURATION = 1.08;

const GradeShader = {
  name: "AbGradeShader",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: VIGNETTE_STRENGTH },
    uStart: { value: VIGNETTE_START },
    uSaturation: { value: SATURATION },
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
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  // Saturation about Rec. 709 luma.
  float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  c.rgb = mix(vec3(luma), c.rgb, uSaturation);
  // Vignette: radial from the centre, normalised so the corner is 1.
  vec2 d = (vUv - 0.5) * 2.0;
  float r = length(d) / 1.41421356;
  float v = smoothstep(uStart, 1.0, r);
  c.rgb *= 1.0 - uVignette * v * v;
  gl_FragColor = c;
}
`,
};

/** The grade pass, ready to add to the composer after the OutputPass. */
export function createGradePass(): ShaderPass {
  return new ShaderPass(GradeShader);
}
