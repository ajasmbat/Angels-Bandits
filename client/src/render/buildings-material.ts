// Night-neon building material (PLAN.md → Presentation: "dark boxy towers
// with emissive window grids"). The city is one InstancedMesh of unit boxes
// scaled per building, so a texture would stretch per instance; instead a
// small onBeforeCompile patch paints the window grid procedurally in METERS
// (recovered from the instance matrix scale), giving every tower crisp
// same-sized windows with a deterministic lit/unlit mix. Purely visual —
// no gameplay code touches this.

import * as THREE from "three";

/** Window cell pitch, meters (x = along the facade, y = per floor). */
const WINDOW_PITCH = "vec2(5.0, 3.6)";

/** Lifts lit windows just over the bloom threshold (V1: gentle window glow,
 * peak ~0.94 luminance — always below tracer/lamp emissives). */
const WINDOW_EMISSIVE_INTENSITY = "1.25";

/** Street-level shop band height, meters of WORLD height (tier 1 only —
 * upper-tier bases sit far above this and keep ordinary windows). */
const SHOP_BAND_HEIGHT = "4.0";
/** Storefront pitch along the facade, meters — wider than the window grid. */
const SHOP_PITCH = "7.0";
/** Shop glass sits just over the bloom threshold, ~0.88 luminance warm /
 * ~0.96 for the rare cool accent — under the V1 ladder's tracer rung. */
const SHOP_EMISSIVE_INTENSITY = "1.3";

const VERTEX_PARS = /* glsl */ `
varying vec3 vMeters;
varying vec3 vObjNormal;
varying float vBSeed;
varying float vWorldY;
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
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vMeters;
varying vec3 vObjNormal;
varying float vBSeed;
varying float vWorldY;
`;

const FRAGMENT_MAIN = /* glsl */ `
// Facade plane: side faces get (facade-run, height) meters; roofs none.
vec2 winGrid = vec2(1e6);
if (abs(vObjNormal.x) > 0.5) winGrid = vec2(vMeters.z, vMeters.y);
else if (abs(vObjNormal.z) > 0.5) winGrid = vec2(vMeters.x, vMeters.y);
vec2 winCell = floor(winGrid / ${WINDOW_PITCH});
vec2 winF = fract(winGrid / ${WINDOW_PITCH});
// The window pane inside its cell (mullions between panes stay dark).
float pane = step(0.18, winF.x) * step(winF.x, 0.82)
           * step(0.28, winF.y) * step(winF.y, 0.74);
// Deterministic lit/unlit mix per window, seeded per building.
float winH = fract(sin(dot(winCell + vBSeed * 61.0, vec2(127.1, 311.7))) * 43758.5453);
float lit = step(0.62, winH);
// Mostly warm incandescent windows, a few cool fluorescent ones.
vec3 winColor = mix(vec3(1.0, 0.72, 0.35), vec3(0.55, 0.85, 1.0), step(0.88, winH));
vec3 windowGlow = pane * lit * winColor * (0.55 + 0.45 * winH) * ${WINDOW_EMISSIVE_INTENSITY};
// V2 street-level shop band: the bottom ${SHOP_BAND_HEIGHT} m of WORLD height
// (so only tier-1 bases qualify) swaps the window grid for wide, warm
// storefront glass — brighter life at canyon level. Facades only.
float facade = 1.0 - step(1e5, abs(winGrid.x));
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
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${FRAGMENT_MAIN}`,
      );
  };
  return material;
}
