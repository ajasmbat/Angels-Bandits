// Night-neon building material (PLAN.md → Presentation: "dark boxy towers
// with emissive window grids"). The city is one InstancedMesh of unit boxes
// scaled per building, so a texture would stretch per instance; instead a
// small onBeforeCompile patch paints the window grid procedurally in METERS
// (recovered from the instance matrix scale), giving every tower crisp
// same-sized windows with a deterministic lit/unlit mix. Purely visual —
// no gameplay code touches this.
//
// ANGE-XY8LH8: the grid now branches on the per-instance facade archetype
// (client/src/render/archetypes.ts — GLASS curtain-wall / punched MASONRY /
// strip-window OFFICE), delivered as ONE instanced float attribute
// `aArchetype` set at construction. Pitch, pane proportions, lit ratio,
// lit-color bias, and cluster pattern are per-archetype; the facade tint
// rides the existing instance color channel (city.ts).

import { EMISSIVE_WINDOW } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { luminance } from "./emissive";

/** Window palette, linear (GLSL space): warm incandescent vs cool
 * fluorescent — each archetype mixes them with its own bias. */
const WINDOW_WARM = new THREE.Color(1.0, 0.72, 0.35);
const WINDOW_COOL = new THREE.Color(0.55, 0.85, 1.0);
const glslVec3 = (c: THREE.Color) =>
  `vec3(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)})`;

/** Lifts lit windows to the ladder's WINDOW rung (S1): the BRIGHTEST palette
 * variant peaks exactly at EMISSIVE_WINDOW, so no window outshines the rung —
 * always below sign/lamp/beacon/tracer emissives, still over the 0.72 bloom
 * threshold for a gentle glow. */
const WINDOW_EMISSIVE_INTENSITY = (
  EMISSIVE_WINDOW / Math.max(luminance(WINDOW_WARM), luminance(WINDOW_COOL))
).toFixed(4);

/** Per-archetype window geometry/lighting, indexable by the attribute value
 * (0 GLASS, 1 MASONRY, 2 OFFICE — FacadeArchetype in archetypes.ts).
 * Chosen design: "Concept 5 — Balanced blend". */
const ARCHETYPE_PARAMS = /* glsl */ `
vec2 winPitch = vec2(3.2, 2.2);   // GLASS: tight curtain-wall floor bands
vec2 winPane = vec2(0.86, 0.78);  //   thin mullions
float winLitRatio = 0.43;
float winCoolBias = 0.74;         //   mostly cool fluorescent
float winInset = 0.0;
float winFloorCluster = 0.0;
if (vArch > 1.5) {                // OFFICE: horizontal strips, floor blocks
  winPitch = vec2(6.0, 4.5);
  winPane = vec2(0.9, 0.48);
  winLitRatio = 0.38;
  winCoolBias = 0.4;
  winFloorCluster = 1.0;
} else if (vArch > 0.5) {         // MASONRY: small punched windows, warm
  winPitch = vec2(3.5, 3.5);
  winPane = vec2(0.45, 0.42);
  winLitRatio = 0.3;
  winCoolBias = 0.08;
  winInset = 1.0;
}
`;

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
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vMeters;
varying vec3 vObjNormal;
varying float vBSeed;
varying float vWorldY;
varying float vArch;
`;

/** Injected after color_fragment: derives the shared window-grid locals
 * (in scope for the emissive block below — same main body) and modulates the
 * DIFFUSE facade: masonry's deep punched-window insets darken the surround. */
const FRAGMENT_COLOR = /* glsl */ `
${ARCHETYPE_PARAMS}
// Facade plane: side faces get (facade-run, height) meters; roofs none.
vec2 winGrid = vec2(1e6);
if (abs(vObjNormal.x) > 0.5) winGrid = vec2(vMeters.z, vMeters.y);
else if (abs(vObjNormal.z) > 0.5) winGrid = vec2(vMeters.x, vMeters.y);
float facade = 1.0 - step(1e5, abs(winGrid.x));
vec2 winCell = floor(winGrid / winPitch);
vec2 winF = fract(winGrid / winPitch);
// The window pane inside its cell (mullions between panes stay dark).
vec2 paneLo = (1.0 - winPane) * 0.5;
vec2 paneHi = 1.0 - paneLo;
float pane = step(paneLo.x, winF.x) * step(winF.x, paneHi.x)
           * step(paneLo.y, winF.y) * step(winF.y, paneHi.y);
// Deterministic lit/unlit mix per window, seeded per building. OFFICE
// clusters lit windows into whole late-shift floors; others scatter.
float winH = fract(sin(dot(winCell + vBSeed * 61.0, vec2(127.1, 311.7))) * 43758.5453);
float rowH = fract(sin(dot(vec2(winCell.y, 1.0) + vBSeed * 61.0, vec2(127.1, 311.7))) * 43758.5453);
float lit = mix(
  step(1.0 - winLitRatio, winH),
  step(rowH, winLitRatio * 1.1) * step(winH, 0.92),
  winFloorCluster
) * facade;
// MASONRY punched windows read as deep holes: darken a surround ring around
// the pane (diffuse only — the lit glow below is emissive and unaffected).
float surround = step(paneLo.x - 0.08, winF.x) * step(winF.x, paneHi.x + 0.08)
               * step(paneLo.y - 0.1, winF.y) * step(winF.y, paneHi.y + 0.1);
diffuseColor.rgb *= 1.0 - winInset * surround * facade * 0.6;
`;

const FRAGMENT_EMISSIVE = /* glsl */ `
// Per-archetype lit-color bias: mostly warm incandescent or mostly cool
// fluorescent depending on the building's type.
float winHC = fract(sin(dot(winCell + vBSeed * 53.0, vec2(269.5, 183.3))) * 43758.5453);
vec3 winColor = mix(${glslVec3(WINDOW_WARM)}, ${glslVec3(WINDOW_COOL)}, step(1.0 - winCoolBias, winHC));
vec3 windowGlow = pane * lit * winColor * (0.55 + 0.45 * winH) * ${WINDOW_EMISSIVE_INTENSITY};
// V2 street-level shop band: the bottom ${SHOP_BAND_HEIGHT} m of WORLD height
// (so only tier-1 bases qualify) swaps the window grid for wide, warm
// storefront glass — brighter life at canyon level. Facades only.
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
  material.customProgramCacheKey = () => "ab-buildings-archetypes";
  return material;
}
