// Atmosphere (fog realism): a ground-hugging haze layer on top of the
// scene's linear fog, applied to EVERY fogged material through three's
// shader chunks, and a helper the additive beams use to fade to black.
//
// Two layers, two jobs:
//   1. The linear fog (scene.fog, FOG_NEAR → FOG_DISTANCE) is the torus's
//      occlusion guarantee — everything must be fully dissolved into the sky
//      colour before the half-world limit, or the wrap shows. It is applied
//      exactly as three applies it and its factor reaches 1 at fogFar.
//      L1 (Stormlit) shapes it: `abFogFactor` is smoothstep(near, far, d)
//      raised to FOG_SHAPE, so the air stays thin near the camera and only
//      closes in toward the limit (a skyline reads at 600 m), and it still
//      reaches exactly 1 at fogFar. Inside the cloud deck, a dust brown-out
//      and (partly) a downpour the shape flattens back to the plain
//      smoothstep (`abWeather.y`), so those sight-blocking soups keep their
//      full mid-range density.
//   2. The height haze is the LOOK: exponential density that is thickest at
//      street level and thins with altitude, integrated analytically along
//      the view ray (the classic exp-height fog), tinted toward a lit grey
//      street mist. L1 pooled it low (scale height 45 m): tower tops stand
//      clear in steel-blue air while the canyons swim. It only ever ADDS on top of
//      layer 1, and only where layer 1 has not already finished, so the
//      occlusion guarantee is untouched.
//
// Additive materials (beams, lamp pools, lights) must NOT go through the
// lerp-to-fog-colour path — that brightens the distance (the V1 lesson).
// For them the right fog is attenuation: multiply by (1 - fog). The beam
// shader includes `AB_FOG_GLSL` and does exactly that.

import * as THREE from "three";
import { AB_SKY_FOG_GLSL, SKY_FOG_AIR, SKY_FOG_STOPS } from "./sky-fog";

/** Scale height of the haze, m: density falls to 1/e every H metres. L1
 * pooled it low (85 → 45 m): mist between the buildings, clear air above. */
export const HAZE_SCALE_HEIGHT = 45;
/** Haze density at street level, 1/m — visibility ~ 1/density. */
export const HAZE_DENSITY = 0.004;
/** Where the haze layer is tinted toward (sRGB): L1 "Stormlit" — a grey
 * street mist lit warm from below, over the steel-blue fog (VO1's was a
 * luminous violet). */
export const HAZE_COLOR = 0x3b3d46;
/** How far the haze's colour departs from the fog colour, 0..1. */
export const HAZE_TINT = 0.55;

/** L1: the clear-air fog curve's exponent — smoothstep(near, far, d)^k.
 * 2 keeps the mid-distance open (≤ 0.1 at 400 m, ~0.55 at 600 m with the
 * 200 m FOG_NEAR) and still reaches exactly 1 at fogFar. `abWeather.y`
 * flattens it: k = FOG_SHAPE − y·(FOG_SHAPE − 1), so y = 0 (the default,
 * and what a program without the uniform reads) is the clear curve and
 * y = 1 the plain smoothstep. */
export const FOG_SHAPE = 2;

/**
 * L4 weather: the haze's EXTRA density, shared by every fogged material.
 * The shader reads `AB_HAZE_DENSITY * (1.0 + abWeather.x)`, so the default 0
 * is exactly the dry haze. `.y` (L1) flattens the fog curve, 0..1 — 0 the
 * clear shaped curve, 1 the plain smoothstep (in cloud, in dust).
 * StormRenderer.atmosphere() is its only writer, once per frame.
 *
 * Load-bearing: this is a PLAIN `{x, y}` object, never a THREE.Vector2.
 * three's cloneUniforms deep-copies three types (and arrays) per material
 * but copies a plain object BY REFERENCE, so this one object reaches every
 * built-in program's uniform clone — mutate it and every material follows
 * without a recompile. A Vector2 would be cloned and silently freeze.
 */
export const HAZE_WEATHER: { x: number; y: number } = { x: 0, y: 0 };

/**
 * Fraction of a view ray, from a camera at `camY` to a point at `fragY`
 * and view depth `dist`, that the haze layer obscures. Pure mirror of the
 * GLSL below — the tested seam. Altitudes below the ground clamp to 0.
 */
export function hazeAmount(
  camY: number,
  fragY: number,
  dist: number,
  densityMul = 1,
): number {
  const H = HAZE_SCALE_HEIGHT;
  const cy = Math.max(camY, 0);
  const fy = Math.max(fragY, 0);
  const dy = fy - cy;
  const ec = Math.exp(-cy / H);
  // Mean density along the ray, relative to street level.
  const t = Math.abs(dy) > 0.5 ? ((ec - Math.exp(-fy / H)) * H) / dy : ec;
  return (
    1 -
    Math.exp(-Math.max(0, dist) * HAZE_DENSITY * densityMul * Math.max(t, 0))
  );
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

/**
 * L1: the linear-fog layer's factor at distance `dist` — the TS mirror of
 * `abFogFactor` below. `flatten` is `abWeather.y`. Exactly 1 at and past
 * `far` whatever the shape (the torus's occlusion guarantee).
 */
export function fogFactor(
  near: number,
  far: number,
  dist: number,
  flatten = 0,
): number {
  const t = Math.min(1, Math.max(0, (dist - near) / (far - near)));
  const s = t * t * (3 - 2 * t);
  const k = FOG_SHAPE - Math.min(1, Math.max(0, flatten)) * (FOG_SHAPE - 1);
  return s ** k;
}

/** The two layers combined: what a fogged surface's colour is mixed by. */
export function combinedFog(linear: number, haze: number): number {
  return 1 - (1 - linear) * (1 - haze);
}

const hazeLinear = new THREE.Color(HAZE_COLOR);

/**
 * L12 sky cycle: the haze colour (rgb, linear) and tint (a) as ONE shared
 * uniform value. three's cloneUniforms copies typed arrays by reference, so
 * this single array, injected into every fog-capable ShaderLib entry at
 * install time, reaches every material's program — one write per frame.
 * Starts at the VO1 constants above.
 */
export const HAZE_PARAMS = new Float32Array([
  hazeLinear.r,
  hazeLinear.g,
  hazeLinear.b,
  HAZE_TINT,
]);

/**
 * U7: the air in the bores — colour (rgb, linear) and strength (a, 0..1,
 * how deep the camera is under the street) — one shared array like
 * HAZE_PARAMS, written once a frame by tunnel-look.ts. Below street level a
 * fogged surface fades toward this air with distance instead of the pale
 * fog-and-haze, and the linear fog still takes over to reach fogColor
 * exactly at fogFar (the torus's occlusion guarantee is untouched). Zero
 * strength (the camera in the open) is exactly the old fog.
 */
export const TUNNEL_AIR = new Float32Array([0, 0, 0, 0]);
/** How fast distance fades into the tunnel air, 1/m. */
export const AIR_DENSITY = 0.0055;

/** Mirror of the GLSL: how much a fragment at world height `fragY` and
 * distance `dist` takes of the tunnel air at `strength`, given the linear
 * fog factor already there. Zero above −1 m and once the fog is complete. */
export function tunnelAirAmount(
  strength: number,
  fragY: number,
  dist: number,
  fogFactor: number,
): number {
  const u = Math.min(1, Math.max(0, (-1 - fragY) / 7));
  const under = strength * u * u * (3 - 2 * u);
  return (
    under * (1 - Math.exp(-Math.max(0, dist) * AIR_DENSITY)) * (1 - fogFactor)
  );
}

/** Set the haze colour (linear rgb) and tint for every fogged material. */
export function setHaze(color: readonly number[], tint: number): void {
  HAZE_PARAMS[0] = color[0] as number;
  HAZE_PARAMS[1] = color[1] as number;
  HAZE_PARAMS[2] = color[2] as number;
  HAZE_PARAMS[3] = tint;
}

/** GLSL for the haze and the shaped linear fog: the functions plus their
 * constants — THE seam for any custom fogged shader (L2's far field, the
 * beams): `abFogFactor(fogNear, fogFar, dist)` and
 * `abHazeAmount(camY, fragY, dist)`, with fogColor/fogNear/fogFar from
 * three's `UniformsLib.fog` (a ShaderMaterial with `fog: true` gets them
 * live). Usable in any shader
 * that has `cameraPosition` (every three shader does). It declares the L4
 * `abWeather` uniform itself — the ONLY declaration, since the searchlight
 * beams include this raw (without fog_pars_fragment) — so a material using it
 * should carry HAZE_WEATHER in its uniforms (UniformsLib.fog does, once
 * installHeightFog has run). One without it reads 0 or a sibling program's
 * value: the dry haze or the current weather, never garbage. */
export const AB_FOG_GLSL = /* glsl */ `
const float AB_HAZE_H = ${HAZE_SCALE_HEIGHT.toFixed(1)};
const float AB_HAZE_DENSITY = ${HAZE_DENSITY.toFixed(5)};
const vec3 AB_HAZE_COLOR = vec3(${hazeLinear.r.toFixed(4)}, ${hazeLinear.g.toFixed(4)}, ${hazeLinear.b.toFixed(4)});
const float AB_HAZE_TINT = ${HAZE_TINT.toFixed(3)};
const float AB_FOG_SHAPE = ${FOG_SHAPE.toFixed(1)};
uniform vec2 abWeather;
float abFogFactor(float near, float far, float dist) {
  float s = smoothstep(near, far, dist);
  float k = AB_FOG_SHAPE - clamp(abWeather.y, 0.0, 1.0) * (AB_FOG_SHAPE - 1.0);
  return pow(s, k);
}
float abHazeAmount(float camY, float fragY, float dist) {
  float cy = max(camY, 0.0);
  float fy = max(fragY, 0.0);
  float dy = fy - cy;
  float ec = exp(-cy / AB_HAZE_H);
  float t = abs(dy) > 0.5 ? (ec - exp(-fy / AB_HAZE_H)) * AB_HAZE_H / dy : ec;
  return 1.0 - exp(-max(dist, 0.0) * AB_HAZE_DENSITY * (1.0 + abWeather.x) * max(t, 0.0));
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
  // The shared haze uniform rides along with three's own fog uniforms.
  const hazeUniform = { value: HAZE_PARAMS };
  const libs = Object.values(THREE.ShaderLib) as { uniforms: object }[];
  for (const lib of libs) {
    if ("fogColor" in lib.uniforms) {
      (lib.uniforms as Record<string, unknown>).abHazeParams = hazeUniform;
    }
  }
  (THREE.UniformsLib.fog as Record<string, unknown>).abHazeParams = hazeUniform;
  // U7: the bores' air rides the same way.
  const airUniform = { value: TUNNEL_AIR };
  for (const lib of libs) {
    if ("fogColor" in lib.uniforms) {
      (lib.uniforms as Record<string, unknown>).abTunnelAir = airUniform;
    }
  }
  (THREE.UniformsLib.fog as Record<string, unknown>).abTunnelAir = airUniform;
  // H1: the dome's gradient and air map (sky-fog.ts), shared the same way:
  // above the fog stop a fogged surface fades toward the sky behind it.
  const skyStops = { value: SKY_FOG_STOPS };
  const skyAir = { value: SKY_FOG_AIR };
  for (const lib of libs) {
    if ("fogColor" in lib.uniforms) {
      (lib.uniforms as Record<string, unknown>).abSkyStops = skyStops;
      (lib.uniforms as Record<string, unknown>).abSkyAir = skyAir;
    }
  }
  (THREE.UniformsLib.fog as Record<string, unknown>).abSkyStops = skyStops;
  (THREE.UniformsLib.fog as Record<string, unknown>).abSkyAir = skyAir;
  // L4: the weather's haze uniform on every fogged material. Each ShaderLib
  // entry merged its OWN copy of UniformsLib.fog at import, so patch them all
  // (built-ins clone these per program); UniformsLib.fog covers the
  // ShaderMaterials that merge it later (searchlights). Programs compiled
  // BEFORE this call miss it — so this must stay ahead of any pre-warm.
  for (const shader of Object.values(THREE.ShaderLib)) {
    if ("fogColor" in shader.uniforms) {
      shader.uniforms.abWeather = { value: HAZE_WEATHER };
    }
  }
  (THREE.UniformsLib.fog as Record<string, THREE.IUniform>).abWeather = {
    value: HAZE_WEATHER,
  };
  // The clone path every built-in program takes must keep the reference —
  // if a three upgrade starts deep-copying plain objects, say so loudly.
  const probe = THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms);
  if (probe.abWeather?.value !== HAZE_WEATHER) {
    console.error("fog: abWeather no longer shared — weather haze is frozen");
  }
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
	uniform vec4 abHazeParams; // L12: haze colour (rgb) + tint (a)
	uniform vec4 abTunnelAir; // U7: the bores' air (rgb) + strength (a)
	varying float vFogDepth;
	varying float vFogWorldY;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	${AB_FOG_GLSL}
	${AB_SKY_FOG_GLSL}
#endif
`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	// H1: the view ray's climb (sin of its elevation), for the sky-matched
	// fog colour above the stop (sky-fog.ts).
	float abRise = vFogWorldY - cameraPosition.y;
	float abSinEl = abRise / max(vFogDepth, 1e-3);
	float abFogDepth = vFogDepth;
	#ifdef AB_FOG_LIFT
		// H1: the cloud deck fogs as if AB_FOG_LIFT m lower (storm.ts
		// DECK_FOG_LIFT) — from under it, the same air as before the sky
		// rose; past the camera's far plane it is still fully fogged.
		float abFlat = max(vFogDepth * vFogDepth - abRise * abRise, 0.0);
		float abUp = abRise > 0.0 ? max(abRise - AB_FOG_LIFT, 0.0) : abRise;
		abFogDepth = sqrt(abFlat + abUp * abUp);
	#endif
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * abFogDepth * abFogDepth );
	#else
		// L1: the shaped curve (abFogFactor) — still 1 at fogFar.
		float fogFactor = abFogFactor( fogNear, fogFar, abFogDepth );
	#endif
	// U7: under the street, the bores' coloured air first (tunnelAirAmount);
	// then the linear fog, which still reaches fogColor exactly at fogFar.
	// O7b: max() — vFogDepth is a length at every vertex, but interpolated
	// across a long sliver (the zeppelin's searchlight cones) a pixel can
	// read it far below 0: exp() overflows, 0 × Inf is NaN, and a merely
	// negative depth mixes past the air (a negative pixel). The haze below
	// clamps its distance the same way.
	float abUnder = abTunnelAir.a * (1.0 - smoothstep(-8.0, -1.0, vFogWorldY));
	float abAir = abUnder * (1.0 - exp(-max(vFogDepth, 0.0) * ${AIR_DENSITY.toFixed(4)}));
	gl_FragColor.rgb = mix( gl_FragColor.rgb, abTunnelAir.rgb, abAir );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, abSkyFog(fogColor, abSinEl), fogFactor );
	float abHaze = abHazeAmount(cameraPosition.y, vFogWorldY, abFogDepth) * (1.0 - fogFactor) * (1.0 - abUnder);
	vec3 abHazeColor = mix(fogColor, abHazeParams.rgb, abHazeParams.a);
	gl_FragColor.rgb = mix( gl_FragColor.rgb, abHazeColor, abHaze );
#endif
`;
}
