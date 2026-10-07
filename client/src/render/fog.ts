// Atmosphere (fog realism): a ground-hugging haze layer on top of the
// scene's linear fog, applied to EVERY fogged material through three's
// shader chunks, and a helper the additive beams use to fade to black.
//
// Two layers, two jobs:
//   1. The linear fog (scene.fog, FOG_NEAR → FOG_DISTANCE) is the torus's
//      occlusion guarantee — everything must be fully dissolved into the sky
//      colour before the half-world limit, or the wrap shows. It is applied
//      exactly as three applies it and its factor reaches 1 at fogFar.
//   2. The height haze is the LOOK: exponential density that is thickest at
//      street level and thins with altitude, integrated analytically along
//      the view ray (the classic exp-height fog), tinted toward a city-glow
//      violet. Tower tops stand clear while the canyons swim; from altitude
//      the streets sit under a luminous soup. It only ever ADDS on top of
//      layer 1, and only where layer 1 has not already finished, so the
//      occlusion guarantee is untouched.
//
// Additive materials (beams, lamp pools, lights) must NOT go through the
// lerp-to-fog-colour path — that brightens the distance (the V1 lesson).
// For them the right fog is attenuation: multiply by (1 - fog). The beam
// shader includes `AB_FOG_GLSL` and does exactly that.

import * as THREE from "three";

/** Scale height of the haze, m: density falls to 1/e every H metres. */
export const HAZE_SCALE_HEIGHT = 85;
/** Haze density at street level, 1/m — visibility ~ 1/density. */
export const HAZE_DENSITY = 0.0027;
/** Where the haze layer is tinted toward (sRGB): sodium-and-neon city glow —
 * VO1 lifted it from a near-black plum to a luminous warm violet, so the
 * canyons swim in lit air rather than in murk. */
export const HAZE_COLOR = 0x6e4a6e;
/** How far the haze's colour departs from the fog colour, 0..1. */
export const HAZE_TINT = 0.55;

/**
 * Fraction of a view ray, from a camera at `camY` to a point at `fragY`
 * and view depth `dist`, that the haze layer obscures. Pure mirror of the
 * GLSL below — the tested seam. Altitudes below the ground clamp to 0.
 */
export function hazeAmount(camY: number, fragY: number, dist: number): number {
  const H = HAZE_SCALE_HEIGHT;
  const cy = Math.max(camY, 0);
  const fy = Math.max(fragY, 0);
  const dy = fy - cy;
  const ec = Math.exp(-cy / H);
  // Mean density along the ray, relative to street level.
  const t = Math.abs(dy) > 0.5 ? ((ec - Math.exp(-fy / H)) * H) / dy : ec;
  return 1 - Math.exp(-Math.max(0, dist) * HAZE_DENSITY * Math.max(t, 0));
}

/**
 * O1: the distance every fogged shader measures — the TRUE (radial) distance
 * from the eye, `length(mvPosition.xyz)`, not three's planar view depth
 * `-mvPosition.z`. Planar depth shrinks by cos(angle off-axis): a building
 * at the half-world limit near the screen edge read ~60 % of its distance,
 * stood partly unfogged, and popped as its torus image switched. Pure mirror
 * of the GLSL below — the tested seam.
 */
export function fogDistance(
  viewX: number,
  viewY: number,
  viewZ: number,
): number {
  return Math.hypot(viewX, viewY, viewZ);
}

/** GLSL for fogDistance, on a view-space position. */
export const AB_FOG_DISTANCE_GLSL = "length(mvPosition.xyz)";

/** The two layers combined: what a fogged surface's colour is mixed by. */
export function combinedFog(linear: number, haze: number): number {
  return 1 - (1 - linear) * (1 - haze);
}

const hazeLinear = new THREE.Color(HAZE_COLOR);

/** GLSL for the haze: the function plus its constants. Usable in any shader
 * that has `cameraPosition` (every three shader does). */
export const AB_FOG_GLSL = /* glsl */ `
const float AB_HAZE_H = ${HAZE_SCALE_HEIGHT.toFixed(1)};
const float AB_HAZE_DENSITY = ${HAZE_DENSITY.toFixed(5)};
const vec3 AB_HAZE_COLOR = vec3(${hazeLinear.r.toFixed(4)}, ${hazeLinear.g.toFixed(4)}, ${hazeLinear.b.toFixed(4)});
const float AB_HAZE_TINT = ${HAZE_TINT.toFixed(3)};
float abHazeAmount(float camY, float fragY, float dist) {
  float cy = max(camY, 0.0);
  float fy = max(fragY, 0.0);
  float dy = fy - cy;
  float ec = exp(-cy / AB_HAZE_H);
  float t = abs(dy) > 0.5 ? (ec - exp(-fy / AB_HAZE_H)) * AB_HAZE_H / dy : ec;
  return 1.0 - exp(-max(dist, 0.0) * AB_HAZE_DENSITY * max(t, 0.0));
}
`;

/**
 * Patch three's fog chunks so every material with `fog: true` gets the haze
 * layer. Call ONCE, before the first render — programs compile lazily on
 * first use and read the chunks then. Idempotent.
 *
 * The world height is recovered from the view-space position, which every
 * built-in vertex shader (mesh, points, sprite) has as `mvPosition`:
 * world = cameraPosition + R^T * mvPosition, with R the camera rotation.
 * That works for sprites too, which have no `transformed`.
 */
let installed = false;
export function installHeightFog(): void {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying float vFogWorldY;
#endif
`;
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	// O1: radial distance (see fogDistance), so the fog — the torus's
	// occlusion guarantee — does not thin toward the screen edges.
	vFogDepth = ${AB_FOG_DISTANCE_GLSL};
	// R^T * mv, y component: column 1 of the camera rotation (GLSL is column-major).
	vFogWorldY = cameraPosition.y + dot(viewMatrix[1].xyz, mvPosition.xyz);
#endif
`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying float vFogWorldY;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	${AB_FOG_GLSL}
#endif
`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	float abHaze = abHazeAmount(cameraPosition.y, vFogWorldY, vFogDepth) * (1.0 - fogFactor);
	vec3 abHazeColor = mix(fogColor, AB_HAZE_COLOR, AB_HAZE_TINT);
	gl_FragColor.rgb = mix( gl_FragColor.rgb, abHazeColor, abHaze );
#endif
`;
}
