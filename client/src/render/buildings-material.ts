// Night-neon building material (PLAN.md → Presentation: "dark boxy towers
// with emissive window grids"). The city is one InstancedMesh of unit boxes
// scaled per building, so a texture would stretch per instance; instead a
// small onBeforeCompile patch paints the window grid procedurally in METERS
// (recovered from the instance matrix scale), giving every tower crisp
// same-sized windows with a deterministic lit/unlit mix. Purely visual —
// no gameplay code touches this.
//
// ANGE-XY8LH8: the grid branches on the per-instance facade archetype
// (client/src/render/archetypes.ts — GLASS curtain-wall / punched MASONRY /
// strip-window OFFICE), delivered as ONE instanced float attribute
// `aArchetype` set at construction.
//
// ANGE-M763XM (C3): the pattern itself moved out to window-pattern.ts, which
// owns the tuning constants, a testable TS mirror, and the GLSL emitters —
// clustered occupancy (floor states + tenant zones), colour temperature that
// varies per building / floor / window, and grime measured against each
// instance's own height. This file keeps what belongs to the MATERIAL: the
// emissive ladder normalisation, the varyings, and the shader splice points.

import { EMISSIVE_WINDOW } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { luminance } from "./emissive";
import { LIVE_ON_UNIFORM, livingParsGlsl } from "./living-windows";
import { WAKE_PARS_GLSL, wakeWindowGlsl, windowWakeUniform } from "./reactions";
import {
  BUILDING_WET_COLOR_GLSL,
  BUILDING_WET_EMISSIVE_GLSL,
  BUILDING_WET_ROUGHNESS_GLSL,
  WEATHER_PARS_GLSL,
  WEATHER_UNIFORM,
} from "./weather";
import {
  OCCUPANCY_UNIFORM,
  WIN_INTERIOR_UNIFORM,
  holeLightGlsl,
  holeSurfaceGlsl,
  pitchSeedGlsl,
  roofLightGlsl,
  roofParsGlsl,
  roofSurfaceGlsl,
  weatheringGlsl,
  windowEmissiveGlsl,
  windowGridGlsl,
} from "./window-pattern";

/** Window palette, linear (GLSL space): warm incandescent vs cool
 * fluorescent — every window is a CONVEX mix of these two. */
const WINDOW_WARM = new THREE.Color(1.0, 0.72, 0.35);
const WINDOW_COOL = new THREE.Color(0.55, 0.85, 1.0);
const glslVec3 = (c: THREE.Color) =>
  `vec3(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)})`;

/** Lifts lit windows to the ladder's WINDOW rung (S1): the BRIGHTEST palette
 * variant peaks exactly at EMISSIVE_WINDOW, so no window outshines the rung —
 * always below sign/lamp/beacon/tracer emissives, still over the 0.72 bloom
 * threshold for a gentle glow. Because the shader only mixes WARM and COOL
 * convexly, and every interior/blinds/dimming factor is < 1, the real peak
 * sits at or under this. */
export const WINDOW_EMISSIVE_INTENSITY = (
  EMISSIVE_WINDOW / Math.max(luminance(WINDOW_WARM), luminance(WINDOW_COOL))
).toFixed(4);

/** Street-level shop band height, meters of WORLD height (tier 1 only —
 * upper-tier bases sit far above this and keep ordinary windows). */
const SHOP_BAND_HEIGHT = "4.0";
/** Storefront pitch along the facade, meters — wider than the window grid. */
const SHOP_PITCH = "7.0";
/** Shop glass sits just over the bloom threshold, ~0.88 luminance warm /
 * ~0.96 for the rare cool accent — under the V1 ladder's tracer rung. */
const SHOP_EMISSIVE_INTENSITY = "1.3";

/**
 * VO2 canyon bounce: at night the STREET is the light source — sodium lamps,
 * shop glass and neon spill climb the lower facades and fade with height.
 * Modelled as light (it multiplies the facade's own albedo, so terracotta
 * glows warm and teal glass glows teal-amber) with an exponential falloff in
 * WORLD height. A sub-bloom emissive term: on the brightest albedo in the city
 * it peaks under BOUNCE_LUMINANCE_CAP at street level, and the lit facade as a
 * whole stays far below the 0.72 bloom threshold
 * (client/test/facade-palette.test.ts) — the facade never becomes a lamp.
 * NOTE three's setHSL is in LINEAR space, so facadeColor's lightness is
 * already a linear albedo — the reference tuning's 1.4 gain read the bounce
 * as ~0.27 and broke the cap.
 */
export const BOUNCE_INTENSITY = 1.0;
/** e-folding height of the bounce, meters of world height (~10% left by
 * 40 m, gone by the upper floors, which keep the cool moon key). */
export const BOUNCE_HEIGHT = 17;
/** The bounce's ceiling, linear luminance — the ticket's sub-bloom bound. */
export const BOUNCE_LUMINANCE_CAP = 0.15;
/** Sodium bounce colour (linear) and the neon accents some blocks pick up,
 * blended in at BOUNCE_NEON_MIX. */
export const BOUNCE_TINTS = {
  sodium: new THREE.Color(1.0, 0.62, 0.34),
  magenta: new THREE.Color(1.0, 0.36, 0.78),
  cyan: new THREE.Color(0.36, 0.82, 1.0),
} as const;
export const BOUNCE_NEON_MIX = 0.55;

const VERTEX_PARS = /* glsl */ `
attribute float aArchetype;
attribute vec4 aRoof;
attribute vec3 aLed;
attribute vec3 aCrown;
attribute vec3 aSubOff;
attribute vec3 aParent;
attribute vec4 aHole;
attribute vec2 aRun;
attribute vec4 aCrew;
varying vec3 vMeters;
varying vec3 vObjNormal;
varying float vBSeed;
flat varying float vPitchSeed;
varying float vWorldY;
varying float vArch;
varying float vBHeight;
varying vec3 vBWorldPos;
varying vec4 vRoof;
varying vec3 vLed;
varying vec3 vCrown;
varying vec2 vHalfXZ;
varying vec4 vHole;
varying vec2 vRun;
varying vec4 vCrew;
${pitchSeedGlsl()}`;

const VERTEX_MAIN = /* glsl */ `
// Unit box (x/z in [-0.5, 0.5], y in [0, 1]) times the instance scale =
// the solid's own meters; the normal stays the box's axis-aligned face normal.
vec3 sScale = vec3(
  length(instanceMatrix[0].xyz),
  length(instanceMatrix[1].xyz),
  length(instanceMatrix[2].xyz)
);
// H1: everything below lives in the PARENT TIER's frame (city.ts aParent /
// aSubOff). A tier with a hole is drawn as walls + lintel + sill, and they
// must share one window grid and one seed; for an unholed tier the parent IS
// the solid, so nothing changes.
vec3 bScale = aParent;
vMeters = position * sScale + aSubOff;
vObjNormal = normal;
// Ground height in meters: the solid's own meters plus its base height (the
// instance's Y translation, which never wraps — Y has no seam).
vWorldY = position.y * sScale.y + instanceMatrix[3].y;
// Per-building seed from its (stable) dimensions — NOT its translation,
// which shifts by WORLD_SIZE whenever the building wraps past the seam.
vBSeed = fract(sin(dot(bScale.xz, vec2(12.9898, 78.233)) + bScale.y) * 43758.5453);
// L13: the window pitch jitter's seed, bit-exact with window-pattern.ts
// pitchSeed() so facade detail can sit on the drawn rows.
vPitchSeed = abPitchSeed(bScale);
vArch = aArchetype;
// This instance's own height, so weathering scales with the building rather
// than with a constant written for one tower size.
vBHeight = bScale.y;
// World position for the fake window interiors' view ray. Boxes never
// rotate, so world axes == facade axes and the ray needs no basis change;
// instances sit at their nearest torus image, so camera-relative geometry
// is already seam-correct.
vBWorldPos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
// VO3 roofs & crowns (roofs.ts → city.ts): roof kind / crown depth / tone,
// LED outline colour, crown tint — plus the tier's half extents in meters.
vRoof = aRoof;
vLed = aLed;
vCrown = aCrown;
vHalfXZ = bScale.xz * 0.5;
vHole = aHole;
vRun = aRun;
// L3 cleaning crew: this building's visit slot (living-windows.ts).
vCrew = aCrew;
`;

const FRAGMENT_PARS = /* glsl */ `
uniform float uOccupancy; // L12 sky cycle: window occupancy, 0..1
uniform float uWinInterior; // M3 tier: parallax rooms on (1) or mean light (0)
varying vec3 vMeters;
varying vec3 vObjNormal;
varying float vBSeed;
flat varying float vPitchSeed;
varying float vWorldY;
varying float vArch;
varying float vBHeight;
varying vec3 vBWorldPos;
varying vec4 vRoof;
varying vec3 vLed;
varying vec3 vCrown;
varying vec2 vHalfXZ;
varying vec4 vHole;
varying vec2 vRun;

float abHash(vec2 p, float s) {
  return fract(sin(dot(p + s * 61.0, vec2(127.1, 311.7))) * 43758.5453);
}
float abSafeDiv(float d) {
  return abs(d) < 1e-4 ? (d < 0.0 ? -1e-4 : 1e-4) : d;
}
${roofParsGlsl()}${WAKE_PARS_GLSL}${livingParsGlsl()}${WEATHER_PARS_GLSL}`;

/** Injected after color_fragment: derives the shared window-grid locals
 * (in scope for the emissive block below — same main body), modulates the
 * DIFFUSE facade with the weathering pass, then (VO3) repaints the roofs and
 * derives the LED/crown masks — that order is load-bearing: the roof pass
 * reads the grid's `facade`/`winGrid`/`pane`/`lit`; the H1 hole lining
 * comes last, over whatever the facade pass left inside a hole. */
const FRAGMENT_COLOR =
  windowGridGlsl() +
  weatheringGlsl() +
  roofSurfaceGlsl() +
  holeSurfaceGlsl() +
  BUILDING_WET_COLOR_GLSL;

/** G1 lit lobbies: what a storefront's room averages to over its walls,
 * floor and lit ceiling — the far-field (and Mobile, uWinInterior off) value
 * the parallax room resolves to. Every room factor is ≤ 1, so the shop band
 * stays a CONVEX scale of the flat V2 glow and can never pass its rung. */
export const SHOP_ROOM_MEAN = 0.66;
/** Room depth behind the glass, meters: a shop, and a deeper lobby. */
const SHOP_ROOM_DEPTH = { shop: "6.0", lobby: "9.0" } as const;
/** Ceiling height of the street-level rooms, meters of world height. */
const SHOP_CEILING = "3.8";

/** The lit-pane emissive, then the V2 street-level shop band: the bottom
 * SHOP_BAND_HEIGHT m of WORLD height (so only tier-1 bases qualify) swaps the
 * window grid for wide, warm storefront glass — brighter life at canyon
 * level. Facades only.
 *
 * G1: behind the glass is a ROOM (interior mapping, the window-pattern.ts
 * raycast at storefront scale): lit ceiling panels, a glossy floor that
 * catches them, side walls, and a back wall that is shelving (warm shops,
 * now and then a customer's silhouette) or a lobby (the cool accent: marble,
 * a reception desk and lift doors with lit indicators). Detail fades to
 * SHOP_ROOM_MEAN with distance, and Mobile keeps that mean. */
const SHOP_BAND_GLSL = /* glsl */ `
float shopBand = (1.0 - step(${SHOP_BAND_HEIGHT}, vWorldY)) * facade;
float shopH = fract(sin((floor(winGrid.x / ${SHOP_PITCH}) + vBSeed * 47.0) * 12.9898) * 43758.5453);
// Tall glass from 0.5 m to 3.4 m with thin mullions between shopfronts —
// filtered (O1), so from altitude the mullions fade to their 12 % share.
float shopMullion = mix(0.12,
  abLine(abPeriodic(winGrid.x, 0.0, ${SHOP_PITCH}), 0.06 * ${SHOP_PITCH}, wAA.x),
  abDetail(${SHOP_PITCH}, wAA.x));
float glass = (1.0 - shopMullion)
            * step(0.5, vWorldY) * (1.0 - step(3.4, vWorldY));
float shopLit = step(0.12, shopH); // nearly every storefront glows
float shopLobby = step(0.85, shopH); // the cool accent is a lit lobby
vec3 shopColor = mix(vec3(1.0, 0.62, 0.26), vec3(0.45, 0.8, 0.95), shopLobby);
float shopRoom = ${SHOP_ROOM_MEAN.toFixed(2)};
float shopNear = abDetail(${SHOP_PITCH}, wAA.x);
if (shopBand * glass * shopLit > 0.0 && uWinInterior > 0.5 && shopNear > 0.0) {
  float shopIn = 1.0;
  vec2 shopUV = vec2(0.0);
  if (abs(vObjNormal.x) > 0.5) {
    shopIn = -sign(vObjNormal.x) * viewRay.x;
    shopUV = vec2(viewRay.z, viewRay.y);
  } else {
    shopIn = -sign(vObjNormal.z) * viewRay.z;
    shopUV = vec2(viewRay.x, viewRay.y);
  }
  float shopDepth = mix(${SHOP_ROOM_DEPTH.shop}, ${SHOP_ROOM_DEPTH.lobby}, shopLobby);
  float shopCu = winGrid.x - floor(winGrid.x / ${SHOP_PITCH}) * ${SHOP_PITCH};
  float shopTB = shopDepth / max(shopIn, 0.03);
  float shopTU = ((shopUV.x > 0.0 ? ${SHOP_PITCH} : 0.0) - shopCu) / abSafeDiv(shopUV.x);
  float shopTV = ((shopUV.y > 0.0 ? ${SHOP_CEILING} : 0.05) - vWorldY) / abSafeDiv(shopUV.y);
  float shopT = min(shopTB, min(shopTU, shopTV));
  vec2 shopHit = vec2(shopCu, vWorldY) + shopUV * shopT; // (u, height) at the hit
  float shopHitD = max(shopIn, 0.03) * shopT;            // depth into the room
  float shopK = 0.45;
  if (shopT == shopTB) {
    if (shopLobby > 0.5) {
      // Lobby: pale stone, two lift doors with lit floor indicators, a desk.
      shopK = 0.62;
      float shopLift = max(
        (1.0 - smoothstep(0.5, 0.56, abs(shopHit.x - 2.3))) ,
        (1.0 - smoothstep(0.5, 0.56, abs(shopHit.x - 4.7)))) * (1.0 - smoothstep(2.35, 2.42, shopHit.y));
      shopK = mix(shopK, 0.3, shopLift);
      float shopInd = max(
        1.0 - smoothstep(0.1, 0.16, length(shopHit - vec2(2.3, 2.62))),
        1.0 - smoothstep(0.1, 0.16, length(shopHit - vec2(4.7, 2.62))));
      shopK = mix(shopK, 1.0, shopInd);
      float shopDesk = (1.0 - smoothstep(1.05, 1.1, shopHit.y)) * (1.0 - smoothstep(1.4, 1.5, abs(shopHit.x - 3.5)));
      shopK = mix(shopK, 0.22, shopDesk);
    } else {
      // Shop: shelving bands of goods with dark gaps between the shelves.
      // The room sits further than the glass, so its detail fades at twice
      // the facade's metres-per-pixel (O1: no shimmer, resolve to the mean).
      float shopFine = abDetail(0.45, wAA.x * 2.0);
      float shopShelf = abLine(abPeriodic(shopHit.y, 0.0, 0.45), 0.05, wAA.x * 2.0) * shopFine;
      float shopGoods = mix(0.725, 0.55 + 0.35 * abHash(floor(vec2(shopHit.x / 0.35, shopHit.y / 0.45)), vBSeed * 17.0 + shopH), shopFine);
      shopK = mix(0.35, shopGoods, step(0.3, shopHit.y) * (1.0 - step(2.3, shopHit.y))) * (1.0 - 0.6 * shopShelf);
      // Now and then a customer, a dark silhouette against the shelves.
      float shopWho = abHash(vec2(floor(winGrid.x / ${SHOP_PITCH}), 5.0), vBSeed * 13.0);
      float shopWhoU = 1.5 + 4.0 * fract(shopWho * 7.31);
      float shopBody = (1.0 - smoothstep(0.2, 0.26, abs(shopHit.x - shopWhoU))) * (1.0 - smoothstep(1.45, 1.5, shopHit.y));
      float shopHead = 1.0 - smoothstep(0.12, 0.15, length(shopHit - vec2(shopWhoU, 1.62)));
      shopK = mix(shopK, 0.1, max(shopBody, shopHead) * step(shopWho, 0.35));
    }
  } else if (shopT == shopTV) {
    // Ceiling light panels (3 across a storefront, every 2 m deep); the
    // glossy floor catches a soft copy of them.
    float shopLight = mix(0.4,
      abLine(abPeriodic(shopHit.x, 1.1665, 2.333), 0.58, wAA.x * 2.0) * abLine(abPeriodic(shopHitD, 1.0, 2.0), 0.4, wAA.x * 2.0),
      abDetail(2.0, wAA.x * 2.0));
    shopK = shopUV.y > 0.0 ? mix(0.5, 1.0, shopLight) : 0.3 + 0.22 * shopLight;
  } else {
    // Side walls: fixtures in shops, plain in lobbies.
    shopK = 0.4 + (1.0 - shopLobby) * 0.15 * abLine(abPeriodic(shopHit.y, 0.0, 0.45), 0.11, wAA.x * 2.0);
  }
  // Light falls off toward the back of the room.
  shopK *= 1.0 - 0.3 * clamp(shopHitD / (shopDepth * 1.5), 0.0, 1.0);
  shopRoom = mix(shopRoom, shopK, shopNear);
}
vec3 shopGlow = glass * shopLit * shopColor * (0.8 + 0.2 * shopH) * shopRoom * ${SHOP_EMISSIVE_INTENSITY};
totalEmissiveRadiance += mix(windowGlow, shopGlow, shopBand);
// VO2 canyon bounce (see BOUNCE_INTENSITY): street light reflected by the
// facade's own albedo, fading with world height; a third of buildings stand
// in a neon-tinted spill instead of plain sodium. Lit panes and lit shop
// glass already emit their own light, so the bounce skips them.
float bounceK = exp(-vWorldY / ${BOUNCE_HEIGHT.toFixed(1)}) * facade
  * (1.0 - pane * lit) * (1.0 - shopBand * glass * shopLit);
float bounceH = fract(vBSeed * 7.31);
vec3 bounceTint = mix(${glslVec3(BOUNCE_TINTS.sodium)},
  mix(${glslVec3(BOUNCE_TINTS.magenta)}, ${glslVec3(BOUNCE_TINTS.cyan)}, step(0.5, fract(vBSeed * 3.7))),
  step(0.66, bounceH) * ${BOUNCE_NEON_MIX.toFixed(2)});
totalEmissiveRadiance += diffuseColor.rgb * bounceTint * ${BOUNCE_INTENSITY.toFixed(2)} * bounceK;
`;

/** Windows, shops and the VO2 bounce, then the VO3 architectural light so its
 * LED replacement overrides everything the pixel emitted before, then the H1
 * hole frame LAST (a convex replacement too — it never stacks on the rest). */
const FRAGMENT_EMISSIVE = `${windowEmissiveGlsl(
  glslVec3(WINDOW_WARM),
  glslVec3(WINDOW_COOL),
  WINDOW_EMISSIVE_INTENSITY,
)}${wakeWindowGlsl(WINDOW_EMISSIVE_INTENSITY)}${SHOP_BAND_GLSL}${roofLightGlsl()}${holeLightGlsl()}${BUILDING_WET_EMISSIVE_GLSL}`;

/**
 * VO2: cap the grazing-angle Fresnel. Standard materials reflect 100% at
 * grazing (specularF90 = 1), which under the VO1 moon key turned every
 * canyon wall seen edge-on into a pale mirror sheet and washed its windows
 * out. Real concrete and brick are far less reflective than that; curtain
 * glass keeps more of its sheen.
 */
export const GRAZING_REFLECTANCE = { glass: 0.4, solid: 0.2 } as const;
const FRAGMENT_SPECULAR = /* glsl */ `
material.specularF90 = vArch < 0.5 ? ${GRAZING_REFLECTANCE.glass.toFixed(2)} : ${GRAZING_REFLECTANCE.solid.toFixed(2)};
`;

/** The compiled shader sources, for QA/tests that assert on the patch
 * without a GPU (there is no CPU-side geometry to inspect otherwise). */
export const BUILDING_SHADER_SOURCE = {
  vertexPars: VERTEX_PARS,
  vertexMain: VERTEX_MAIN,
  fragmentPars: FRAGMENT_PARS,
  fragmentColor: FRAGMENT_COLOR,
  fragmentEmissive: FRAGMENT_EMISSIVE,
  fragmentSpecular: FRAGMENT_SPECULAR,
} as const;

/** The live-windows clock uniform (L3), seconds in [0, LIVE.period). */
export interface LiveTimeUniform {
  value: number;
}

/** The city's instanced material: dark towers + procedural lit windows.
 * `liveTime` is the L3 living-windows clock; the city renderer owns it and
 * writes it once per frame. */
export function createBuildingsMaterial(
  liveTime: LiveTimeUniform = { value: 0 },
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.85,
    metalness: 0.15,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLiveTime = liveTime;
    // O3: the quality tier's living-windows switch, shared by reference.
    shader.uniforms.uLiveOn = LIVE_ON_UNIFORM;
    // L1 reactive city: the shared window-wake sources (reactions.ts).
    shader.uniforms.uWake = windowWakeUniform;
    shader.uniforms.uOccupancy = OCCUPANCY_UNIFORM;
    // M3: the quality tier's window-interior switch, shared by reference.
    shader.uniforms.uWinInterior = WIN_INTERIOR_UNIFORM;
    // L4: the shared weather uniform (render/weather.ts), by reference.
    shader.uniforms.uWeather = WEATHER_UNIFORM;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${VERTEX_MAIN}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\n${FRAGMENT_COLOR}`,
      )
      .replace(
        "#include <metalnessmap_fragment>",
        `${BUILDING_WET_ROUGHNESS_GLSL}\n#include <metalnessmap_fragment>`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${FRAGMENT_EMISSIVE}`,
      )
      .replace(
        "#include <lights_physical_fragment>",
        `#include <lights_physical_fragment>\n${FRAGMENT_SPECULAR}`,
      );
  };
  // Distinct compiled program per patch (V3 rule: three keys programs on
  // onBeforeCompile.toString(), and sibling materials collide silently).
  material.customProgramCacheKey = () =>
    "ab-buildings-h1-holes-l1-wake-l3-live-l4-wet-g1-lobbies";
  return material;
}
