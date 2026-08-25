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
import {
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

const VERTEX_PARS = /* glsl */ `
attribute float aArchetype;
varying vec3 vMeters;
varying vec3 vObjNormal;
varying float vBSeed;
varying float vWorldY;
varying float vArch;
varying float vBHeight;
varying vec3 vBWorldPos;
`;

const VERTEX_MAIN = /* glsl */ `
// Unit box (x/z in [-0.5, 0.5], y in [0, 1]) times the instance scale =
// object-space meters; the normal stays the box's axis-aligned face normal.
vec3 bScale = vec3(
  length(instanceMatrix[0].xyz),
  length(instanceMatrix[1].xyz),
  length(instanceMatrix[2].xyz)
);
vMeters = position * bScale;
vObjNormal = normal;
// Ground height in meters: tier-local meters plus the tier's base height
// (the instance's Y translation, which never wraps — Y has no seam).
vWorldY = vMeters.y + instanceMatrix[3].y;
// Per-building seed from its (stable) dimensions — NOT its translation,
// which shifts by WORLD_SIZE whenever the building wraps past the seam.
vBSeed = fract(sin(dot(bScale.xz, vec2(12.9898, 78.233)) + bScale.y) * 43758.5453);
vArch = aArchetype;
// This instance's own height, so weathering scales with the building rather
// than with a constant written for one tower size.
vBHeight = bScale.y;
// World position for the fake window interiors' view ray. Boxes never
// rotate, so world axes == facade axes and the ray needs no basis change;
// instances sit at their nearest torus image, so camera-relative geometry
// is already seam-correct.
vBWorldPos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vMeters;
varying vec3 vObjNormal;
varying float vBSeed;
varying float vWorldY;
varying float vArch;
varying float vBHeight;
varying vec3 vBWorldPos;

float abHash(vec2 p, float s) {
  return fract(sin(dot(p + s * 61.0, vec2(127.1, 311.7))) * 43758.5453);
}
float abSafeDiv(float d) {
  return abs(d) < 1e-4 ? (d < 0.0 ? -1e-4 : 1e-4) : d;
}
`;

/** Injected after color_fragment: derives the shared window-grid locals
 * (in scope for the emissive block below — same main body) and modulates the
 * DIFFUSE facade with the weathering pass. */
const FRAGMENT_COLOR = windowGridGlsl() + weatheringGlsl();

/** The lit-pane emissive, then the V2 street-level shop band: the bottom
 * SHOP_BAND_HEIGHT m of WORLD height (so only tier-1 bases qualify) swaps the
 * window grid for wide, warm storefront glass — brighter life at canyon
 * level. Facades only. */
const SHOP_BAND_GLSL = /* glsl */ `
float shopBand = (1.0 - step(${SHOP_BAND_HEIGHT}, vWorldY)) * facade;
float shopF = fract(winGrid.x / ${SHOP_PITCH});
float shopH = fract(sin((floor(winGrid.x / ${SHOP_PITCH}) + vBSeed * 47.0) * 12.9898) * 43758.5453);
// Tall glass from 0.5 m to 3.4 m with thin mullions between shopfronts.
float glass = step(0.06, shopF) * step(shopF, 0.94)
            * step(0.5, vWorldY) * (1.0 - step(3.4, vWorldY));
float shopLit = step(0.12, shopH); // nearly every storefront glows
vec3 shopColor = mix(vec3(1.0, 0.62, 0.26), vec3(0.45, 0.8, 0.95), step(0.85, shopH));
vec3 shopGlow = glass * shopLit * shopColor * (0.8 + 0.2 * shopH) * ${SHOP_EMISSIVE_INTENSITY};
totalEmissiveRadiance += mix(windowGlow, shopGlow, shopBand);
`;

const FRAGMENT_EMISSIVE = `${windowEmissiveGlsl(
  glslVec3(WINDOW_WARM),
  glslVec3(WINDOW_COOL),
  WINDOW_EMISSIVE_INTENSITY,
)}${SHOP_BAND_GLSL}`;

/** The compiled shader sources, for QA/tests that assert on the patch
 * without a GPU (there is no CPU-side geometry to inspect otherwise). */
export const BUILDING_SHADER_SOURCE = {
  vertexPars: VERTEX_PARS,
  vertexMain: VERTEX_MAIN,
  fragmentPars: FRAGMENT_PARS,
  fragmentColor: FRAGMENT_COLOR,
  fragmentEmissive: FRAGMENT_EMISSIVE,
} as const;

/** The city's instanced material: dark towers + procedural lit windows. */
export function createBuildingsMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.85,
    metalness: 0.15,
  });
  material.onBeforeCompile = (shader) => {
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
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${FRAGMENT_EMISSIVE}`,
      );
  };
  // Distinct compiled program per patch (V3 rule: three keys programs on
  // onBeforeCompile.toString(), and sibling materials collide silently).
  material.customProgramCacheKey = () => "ab-buildings-facade-realism";
  return material;
}
