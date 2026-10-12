// L7 Inferno, the zero-draw half: the GLSL the building and ground materials
// splice in, and the shared uniforms render/inferno.ts writes once a frame.
//
//  - FIRELIGHT: FIRE_LIGHTS pooled point lights — the strongest fires near
//    the camera — as a uniform array (L1's window-wake pattern: a count-led
//    loop, the xz delta torus-wrapped), never a THREE light (that would
//    change the light count and recompile every lit program, quality rule
//    1). It is light: it multiplies the surface's own albedo, so brick glows
//    brick-orange and the street glows asphalt-orange, and it stays well
//    under the 0.72 bloom threshold — the flames are the lamp, the facade is
//    only lit by them. Both materials read the same render-space positions
//    (the building shader's vBWorldPos, the ground's canonical vWorldXZ: the
//    wrapped delta makes the two frames agree).
//
//  - GUTTED FRAMES: a building fire has gutted (heavy D2 damage — its gut
//    wear rides the city mesh's free aRoof.w, written per damaged building
//    by city.ts) turns into a charred skeleton as the room's burn rises: the
//    ORIGINAL facade and roof go soot-black, every light it had dies, its
//    window cells open on fire inside, and the frame round them glows with
//    ember lines. It is shading on the building's own standing solids — the
//    same boxes the crash check collides with — so draw == collide and the
//    D8 standing-profile rule hold by construction; D2's exposed insides
//    and rubble (broken-shading.ts) keep their own look.
//
// Every animated term reads FIRE_PHASE_UNIFORM: phases fract(worldMs / P)
// computed on the CPU in double precision from the latched world clock, so
// a pinned QA frame is the same frame on every machine and nothing ever
// wraps with a jump.

import { EMISSIVE_WINDOW, WORLD_SIZE } from "@angels-bandits/common/constants";
import * as THREE from "three";

/** Pooled fire lights the facades and the street see at once. */
export const FIRE_LIGHTS = 6;

/** The room's burn level as the shaders see it (0..1), by reference. */
export const INFERNO_BURN_UNIFORM = { value: 0 };

/** Fire lights: xyz = render-space position, w = reach (m, 0 = off). */
export const FIRE_LIGHT_UNIFORM: { value: THREE.Vector4[] } = {
  value: Array.from({ length: FIRE_LIGHTS }, () => new THREE.Vector4()),
};
/** Fire lights' colour × strength (rgb; w unused). */
export const FIRE_LIGHT_COLOR_UNIFORM: { value: THREE.Vector4[] } = {
  value: Array.from({ length: FIRE_LIGHTS }, () => new THREE.Vector4()),
};
/** How many of the fire lights are live this frame. */
export const FIRE_LIGHT_COUNT_UNIFORM = { value: 0 };

/** The flicker clocks' periods, s (their phases are FIRE_PHASE_UNIFORM). */
export const FIRE_PHASE_PERIODS = [1.3, 4.7, 17, 61] as const;
/** fract(worldMs / 1000 / P) per FIRE_PHASE_PERIODS entry. */
export const FIRE_PHASE_UNIFORM = { value: new THREE.Vector4() };

/** Set the four phases from the latched world clock (double precision). */
export function setFirePhase(worldMs: number): void {
  const s = worldMs / 1000;
  const p = FIRE_PHASE_PERIODS;
  FIRE_PHASE_UNIFORM.value.set(
    fract(s / p[0]),
    fract(s / p[1]),
    fract(s / p[2]),
    fract(s / p[3]),
  );
}

const fract = (v: number): number => v - Math.floor(v);

/** A building is gutted between these shares of its chunks worn away. */
export const GUT_WEAR_LO = 0.1;
export const GUT_WEAR_HI = 0.3;

/** The gut wear a damaged building's instances carry (aRoof.w), 0..1. */
export function gutWear(wearShare: number): number {
  const t = Math.min(
    1,
    Math.max(0, (wearShare - GUT_WEAR_LO) / (GUT_WEAR_HI - GUT_WEAR_LO)),
  );
  return t * t * (3 - 2 * t);
}

/** Bind the shared inferno uniforms into a patched material's shader. */
export function bindInfernoUniforms(
  uniforms: Record<string, THREE.IUniform>,
): void {
  uniforms.uBurn = INFERNO_BURN_UNIFORM;
  uniforms.uFireL = FIRE_LIGHT_UNIFORM;
  uniforms.uFireC = FIRE_LIGHT_COLOR_UNIFORM;
  uniforms.uFireCount = FIRE_LIGHT_COUNT_UNIFORM;
  uniforms.uFirePhase = FIRE_PHASE_UNIFORM;
}

/** Most firelight one surface takes, per channel (on its albedo). */
const FIRELIGHT_CAP = 1.6;

/** Uniform declarations + the light loop, for the fragment pars. */
export const INFERNO_PARS_GLSL = /* glsl */ `
uniform float uBurn;
uniform vec4 uFireL[${FIRE_LIGHTS}];
uniform vec4 uFireC[${FIRE_LIGHTS}];
uniform int uFireCount;
uniform vec4 uFirePhase;
// L7 firelight at p (render space or canonical — the xz delta is wrapped)
// on a surface facing n: a soft-edged reach, a wrap-around N·L.
vec3 abFireLight(vec3 p, vec3 n) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${FIRE_LIGHTS}; i++) {
    if (i >= uFireCount) break;
    vec4 fl = uFireL[i];
    vec3 fd = fl.xyz - p;
    fd.xz -= ${WORLD_SIZE.toFixed(1)} * floor(fd.xz / ${WORLD_SIZE.toFixed(1)} + 0.5);
    float fdist = length(fd);
    float fk = 1.0 - smoothstep(0.0, fl.w, fdist);
    if (fk <= 0.0) continue;
    float fndl = dot(n, fd / max(fdist, 1e-3));
    acc += uFireC[i].rgb * (fk * fk) * (0.3 + 0.7 * max(fndl, 0.0));
  }
  return min(acc, vec3(${FIRELIGHT_CAP.toFixed(1)}));
}
`;

/** Gutted: the room's burn gates the building's gut wear. */
const GUT_K_GLSL = "vRoof.w * smoothstep(0.08, 0.45, uBurn)";

/** After BROKEN_COLOR_GLSL: an original face of a gutted building chars. */
export const GUTTED_COLOR_GLSL = /* glsl */ `
// --- L7 gutted frames: soot-black, patchy, on the original faces only ---
float gutK = ${GUT_K_GLSL};
if (gutK > 0.0 && brkDmg < 0.5) {
  float gutSoot = abHash(floor(vMeters.xz * 0.35 + vec2(vMeters.y * 0.21)), vBSeed * 29.0);
  vec3 gutChar = vec3(0.035, 0.03, 0.028) * (0.55 + 0.9 * gutSoot);
  diffuseColor.rgb = mix(diffuseColor.rgb, gutChar, gutK * 0.94);
}
`;

/** Fire behind a gutted window, at its hottest (linear) — under the WINDOW
 * rung, as a lit window would be. */
const GUT_FIRE_HOT = `vec3(1.0, 0.5, 0.1) * ${(EMISSIVE_WINDOW / 0.6).toFixed(3)}`;

/**
 * After BROKEN_EMISSIVE_GLSL: a gutted building's own lights die, burning
 * rooms glow through its window cells (flickering, hotter at the sill), and
 * the frame just outside each burning pane carries a thin ember line. Then
 * the firelight on every building face, broken or not.
 */
export const GUTTED_EMISSIVE_GLSL = /* glsl */ `
// --- L7 gutted frames: the lights out, fire inside, ember edges ---
if (gutK > 0.0 && brkDmg < 0.5) {
  totalEmissiveRadiance *= 1.0 - gutK;
  // Fire takes whole floors (some burnt out, dark), and within a burning
  // floor some rooms: a skeleton of black voids and burning ones, from a dull
  // ember to a roaring blaze.
  float gutRoom = abHash(winCell + 113.0, vBSeed * 23.0);
  float gutFloor = abHash(vec2(winCell.y, 3.0), vBSeed * 17.0);
  float gutBurning = step(gutRoom, 0.15 + 0.5 * gutK) * step(gutFloor, 0.72) * facade;
  float gutHeat = 0.3 + 0.7 * abHash(winCell + 7.0, vBSeed * 31.0);
  float gutFlick = 0.72 + 0.28 * sin(6.2832 * (uFirePhase.x + gutRoom * 3.0))
                         * sin(6.2832 * (uFirePhase.y + gutRoom * 7.0));
  vec3 gutFire = mix(vec3(0.6, 0.1, 0.012), ${GUT_FIRE_HOT}, (1.0 - winF.y) * gutFlick * gutHeat);
  totalEmissiveRadiance += gutFire * (pane * gutBurning * gutK * gutFlick * gutHeat);
  // The frame: within 0.25 m outside a burning pane's edge, at full detail.
  float gutOut = max(paneD.x * winPitch.x, paneD.y * winPitch.y);
  float gutEdge = (1.0 - smoothstep(0.0, 0.25, gutOut)) * step(0.0, gutOut) * winDetail;
  totalEmissiveRadiance += vec3(0.62, 0.15, 0.025)
    * (gutEdge * gutBurning * gutK * (0.6 + 0.4 * gutFlick) * winRow);
}
// --- L7 firelight on every face (exposed insides included) ---
if (uFireCount > 0) {
  totalEmissiveRadiance += diffuseColor.rgb * abFireLight(vBWorldPos, vObjNormal);
}
`;

/** The ground's firelight (street level, facing up), in its emissive pass. */
export const FIRELIGHT_GROUND_GLSL = /* glsl */ `
if (uFireCount > 0) {
  totalEmissiveRadiance += diffuseColor.rgb * abFireLight(vec3(vWorldXZ.x, 0.0, vWorldXZ.y), vec3(0.0, 1.0, 0.0));
}
`;
