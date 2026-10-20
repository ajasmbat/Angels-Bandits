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

import { WORLD_SIZE } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { BROKEN_STOREY } from "./broken-shading";

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

/** L7b: burning districts — broad firelight from below over each burning
 * block (render/inferno.ts's cloud-glow spots), the light a sea of fire
 * throws on everything round it, not just the walls by one flame. */
export const FIRE_ZONES = 8;
/** Zones: xy = render-space x, z; z = strength (burn-scaled); w = reach, m. */
export const FIRE_ZONE_UNIFORM: { value: THREE.Vector4[] } = {
  value: Array.from({ length: FIRE_ZONES }, () => new THREE.Vector4()),
};
export const FIRE_ZONE_COUNT_UNIFORM = { value: 0 };

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
  uniforms.uFireZ = FIRE_ZONE_UNIFORM;
  uniforms.uFireZCount = FIRE_ZONE_COUNT_UNIFORM;
}

/** L7b: an exposed storey ablaze and a rubble pile's embers at their
 * hottest (linear) — red-orange, under the WINDOW rung. */
const WRECK_FIRE = "vec3(1.0, 0.15, 0.012)";
const WRECK_EMBER = "vec3(0.8, 0.1, 0.008)";
/** Most firelight one surface takes, per channel (on its albedo). */
const FIRELIGHT_CAP = 1.6;
/** A burning district's light at full strength (linear, on albedo): a
 * facade's albedo stays ≤ ~0.35, so a lit wall stays under the 0.72 bloom
 * threshold — firelit, never a lamp. */
const ZONE_RGB = ["1.1", "0.3", "0.06"];

/** Uniform declarations + the light loop, for the fragment pars. */
export const INFERNO_PARS_GLSL = /* glsl */ `
uniform float uBurn;
uniform vec4 uFireL[${FIRE_LIGHTS}];
uniform vec4 uFireC[${FIRE_LIGHTS}];
uniform int uFireCount;
uniform vec4 uFirePhase;
uniform vec4 uFireZ[${FIRE_ZONES}];
uniform int uFireZCount;
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
  // L7b: the burning districts' light from below — strongest at street
  // level, fading up the towers over ~140 m, flickering slowly.
  float zk = 0.0;
  for (int i = 0; i < ${FIRE_ZONES}; i++) {
    if (i >= uFireZCount) break;
    vec4 z = uFireZ[i];
    vec2 zd = z.xy - p.xz;
    zd -= ${WORLD_SIZE.toFixed(1)} * floor(zd / ${WORLD_SIZE.toFixed(1)} + 0.5);
    float zf = 1.0 - smoothstep(0.0, z.w, length(zd));
    zk += z.z * zf * zf;
  }
  if (zk > 0.0) {
    float zUp = exp(-max(p.y, 0.0) / 140.0) * (0.55 + 0.45 * max(-n.y, 0.0) + 0.25 * max(n.y, 0.0));
    float zFlick = 0.85 + 0.15 * sin(6.2832 * uFirePhase.y);
    acc += vec3(${ZONE_RGB.join(", ")}) * (min(zk, 1.0) * zUp * zFlick);
  }
  return min(acc, vec3(${FIRELIGHT_CAP.toFixed(1)}));
}
`;

/** Gutted: the room's burn gates the building's gut wear. */
const GUT_K_GLSL = "vRoof.w * smoothstep(0.08, 0.45, uBurn)";

/** After BROKEN_COLOR_GLSL: an original face of a gutted building chars —
 * G7: to a dark grey-brown (CHAR_RGB, varied by soot), never near-black:
 * a black albedo with its lights out fogged to a flat navy monolith. The
 * window voids go darker still, recesses inside the lighter charred frame,
 * and a share of the original facade (its slabs, sills, reveals) shows
 * through. Every per-cell term resolves to its mean as its cell goes
 * sub-pixel, from the grid's top-level `wAA` — no derivative in a branch. */
const CHAR_RGB = "vec3(0.11, 0.092, 0.078)";
export const GUTTED_COLOR_GLSL = /* glsl */ `
// --- L7 gutted frames: charred grey-brown, sooty, on the original faces only ---
float gutK = ${GUT_K_GLSL};
if (gutK > 0.0 && brkDmg < 0.5) {
  // DS2: smooth soot in the face's own plane — the old 5 m hash of
  // (x + y, z + y) ran in diagonal bands down every face, and with x (or
  // z) fixed on a face it streaked.
  vec2 gutP = abs(vObjNormal.x) > 0.5 ? vMeters.zy : abs(vObjNormal.z) > 0.5 ? vMeters.xy : vMeters.xz;
  float gutSootN = abVNoise(gutP * 0.2, vBSeed * 29.0);
  float gutSoot = mix(0.5, gutSootN, abDetail(5.0, max(wAA.x, wAA.y)));
  vec3 gutChar = ${CHAR_RGB} * (0.7 + 0.6 * gutSoot) * (1.0 - 0.65 * pane * facade);
  diffuseColor.rgb = mix(diffuseColor.rgb, gutChar, gutK * 0.85);
}
`;

/** Fire behind a gutted window, at its hottest (linear) — L7b: a deep
 * red-orange room ablaze (the filmic curve keeps a linear red under ~1
 * red, where a brighter one washes out to yellow), under the WINDOW rung
 * as a lit window is. */
const GUT_FIRE_HOT = "vec3(1.1, 0.16, 0.014)";
/** L7b: the ember rim on a charred frame (the corners, the floor slabs and
 * the grazing faces): its colour (luminance GUT_RIM_LUM) and its peak
 * luminance, under the WINDOW rung like the ember edges. */
const GUT_RIM_RGB = "vec3(0.75, 0.17, 0.03)";
const GUT_RIM_LUM = 0.283;
export const GUT_RIM_PEAK = 0.55;

/** G7: the charred frame's own smoulder (linear; luminance ≈ 0.06 at its
 * hottest, low down) — a gutted tower is never an unlit block at night. */
const GUT_GLOW_RGB = "vec3(0.16, 0.035, 0.008)";

/**
 * After BROKEN_EMISSIVE_GLSL: a gutted building's own lights die with the
 * fire, burning rooms glow through its window cells (flickering, hotter at
 * the sill), the frame just outside each burning opening carries a thin
 * ember line and the char smoulders. Then the firelight on every building
 * face, broken or not.
 *
 * G7: LOD-stable. Every per-cell decision resolves to its expected value
 * before its cell turns to noise — a room's coin flip to its probability
 * while a cell is ~12 px, a floor's by `floorDetail`, heat / sill / flicker to their
 * means, the ember ring and slab line to their area shares — so a distant
 * tower glows as burning floor bands, then as an even ember wash, never as
 * an orange and black checkerboard. Every far value is a convex mix of the
 * near ones, so the ladder bound holds: the far sum (fire ≲ 0.04, ring ≲
 * 0.02, rim ≤ GUT_RIM_PEAK, glow ≤ 0.06) stays under the 0.72 rung.
 */
export const GUTTED_EMISSIVE_GLSL = /* glsl */ `
// --- L7 gutted frames: the lights out, fire inside, ember edges ---
if (gutK > 0.0 && brkDmg < 0.5) {
  // L7b: past burn ~0.7 nearly every room of nearly every floor is alight.
  float gutHi = smoothstep(0.5, 0.8, uBurn);
  // G7: half the building's own lights linger at a moderate burn, none at
  // full burn (by then ~85 % of its rooms are alight).
  totalEmissiveRadiance *= 1.0 - gutK * (0.5 + 0.5 * gutHi);
  // Fire takes whole floors (some burnt out, dark), and within a burning
  // floor some rooms: a skeleton of dark voids and burning ones, from a dull
  // ember to a roaring blaze.
  float gutRoom = abHash(winCell + 113.0, vBSeed * 23.0);
  float gutFloor = abHash(vec2(winCell.y, 3.0), vBSeed * 17.0);
  float gutPRoom = min(0.15 + 0.5 * gutK + 0.2 * gutHi, 1.0);
  float gutPFloor = 0.72 + 0.2 * gutHi;
  // A burning/dark coin flip per room is noise until a room is large on
  // screen: it resolves to its probability while a cell is still ~12 px
  // (the floor bands carry the read from there), not at the grid's ~3 px.
  float gutRoomDetail = min(abCellDetail(4.0 * winPitch.x, wAA.x), abCellDetail(4.0 * winPitch.y, wAA.y));
  float gutBand = mix(gutPFloor, step(gutFloor, gutPFloor), floorDetail);
  float gutBurning = mix(gutPRoom, step(gutRoom, gutPRoom), gutRoomDetail) * gutBand * facade;
  float gutHeat = mix(0.65, 0.3 + 0.7 * abHash(winCell + 7.0, vBSeed * 31.0), gutRoomDetail);
  // Each room flickers on its own clock; a distant floor on the floor's,
  // a distant tower gently, as one.
  float gutKey = mix(mix(0.5, gutFloor, floorDetail), gutRoom, gutRoomDetail);
  float gutFlick = 0.72 + 0.28 * mix(0.3, 1.0, floorDetail)
    * sin(6.2832 * (uFirePhase.x + gutKey * 3.0)) * sin(6.2832 * (uFirePhase.y + gutKey * 7.0));
  float gutSill = mix(0.5, 1.0 - winF.y, winDetail);
  vec3 gutFire = mix(vec3(0.6, 0.1, 0.012), ${GUT_FIRE_HOT}, gutSill * gutFlick * gutHeat);
  totalEmissiveRadiance += gutFire * (pane * gutBurning * gutK * gutFlick * gutHeat);
  // The frame: within 0.25 m outside a burning opening (L11's shaped
  // opening), its area share once the cell is sub-pixel.
  vec2 gutOpen = 2.0 * fwHalf;
  float gutRing = 0.5 * ((gutOpen.x + 0.5) * (gutOpen.y + 0.5) - gutOpen.x * gutOpen.y)
    / max(winPitch.x * winPitch.y, 1.0);
  float gutEdgeNear = (1.0 - smoothstep(0.0, 0.25, fwSdWall)) * step(0.0, fwSdWall);
  float gutEdge = mix(gutRing, gutEdgeNear, winDetail);
  totalEmissiveRadiance += vec3(0.62, 0.15, 0.025)
    * (gutEdge * gutBurning * gutK * (0.6 + 0.4 * gutFlick) * winRow);
  // L7b: the ember rim — the frame lit from the fire inside: its vertical
  // corners (within ~1.5 m of the tier's edge), its floor slabs (the
  // bottom of each window cell, their area share far away) and, faintly,
  // every face seen edge-on; hotter low down, flickering on the fire clock.
  float gutAlong = abs(vObjNormal.x) > 0.5 ? vHalfXZ.y - abs(vMeters.z) : vHalfXZ.x - abs(vMeters.x);
  float gutCorner = 1.0 - smoothstep(0.0, 1.5, gutAlong);
  float gutSlab = mix(0.15 / winPitch.y, 1.0 - smoothstep(0.0, 0.3 / winPitch.y, winF.y), winDetail) * winRow;
  float gutGraze = pow(1.0 - abs(dot(viewRay, vObjNormal)), 3.0);
  float gutRimFlick = 0.75 + 0.25 * sin(6.2832 * (uFirePhase.x * 2.0 + gutKey * 5.0));
  float gutLow = 0.6 + 0.4 * exp(-vMeters.y / 60.0);
  float gutRim = min(1.0, 0.5 * gutCorner + 0.4 * gutSlab + 0.35 * gutGraze)
    * gutK * smoothstep(0.2, 0.7, uBurn) * gutRimFlick * gutLow * facade;
  totalEmissiveRadiance += ${GUT_RIM_RGB} * (${(GUT_RIM_PEAK / GUT_RIM_LUM).toFixed(3)} * gutRim);
  // G7: the char smoulders between the openings.
  totalEmissiveRadiance += ${GUT_GLOW_RGB}
    * (gutK * smoothstep(0.1, 0.5, uBurn) * gutLow * facade * (1.0 - pane));
}
// --- L7b the wreckage burns: exposed rooms ablaze and rubble smouldering ---
if (brkDmg > 0.5 && brkDmg < 2.5 && uBurn > 0.0) {
  float wrK = smoothstep(0.3, 0.8, uBurn);
  vec3 wrN = abs(vObjNormal);
  vec2 wrW = wrN.x > 0.5 ? vPatPos.zy : wrN.z > 0.5 ? vPatPos.xy : vPatPos.xz;
  // G7: the 6 m room × storey cells resolve to their means well before
  // they are sub-pixel (the grid's top-level wAA: no derivative here).
  // Rooms burn or not at random: resolved while a room is still ~12 px.
  float wrDetail = min(abCellDetail(18.0, wAA.x), abCellDetail(${(3 * BROKEN_STOREY).toFixed(1)}, wAA.y));
  float wrFlick = 0.7 + 0.3 * sin(6.2832 * (uFirePhase.x + mix(0.5, abHash(floor(wrW / 6.0), vBSeed * 3.0), wrDetail) * 4.0));
  if (brkDmg < 1.5) {
    // An exposed storey: most rooms between the slabs on fire, hottest
    // at the floor, a few burnt out (the reference's lit skeletons).
    float wrStorey = vPatY / ${BROKEN_STOREY.toFixed(1)};
    float wrIn = fract(wrStorey);
    float wrRoom = abHash(vec2(floor(wrW.x / 6.0), floor(wrStorey)), vBSeed * 13.0);
    float wrP = 0.3 + 0.5 * wrK;
    float wrLit = mix(wrP * 0.86, step(wrRoom, wrP) * smoothstep(0.1, 0.18, wrIn), wrDetail) * (1.0 - step(0.5, wrN.y));
    float wrHeat = mix(0.54, (1.0 - 0.6 * wrIn) * (0.55 + 0.45 * wrRoom), wrDetail);
    totalEmissiveRadiance += ${WRECK_FIRE} * (wrLit * wrHeat * wrFlick * wrK);
  } else {
    // Rubble: glowing patches of embers under the soot.
    // DS2: in the face's own plane, smooth (the plan-view hash striped
    // every steep face of the pile).
    float wrPatch = mix(0.5, smoothstep(0.35, 0.65, abVNoise(wrW * 0.6, vBSeed * 19.0)),
      abDetail(1.67, max(wAA.x, wAA.y)));
    totalEmissiveRadiance += ${WRECK_EMBER} * (wrPatch * wrFlick * wrK);
  }
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
