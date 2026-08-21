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

const VERTEX_PARS = /* glsl */ `
varying vec3 vMeters;
varying vec3 vObjNormal;
varying float vBSeed;
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
// Per-building seed from its (stable) dimensions — NOT its translation,
// which shifts by WORLD_SIZE whenever the building wraps past the seam.
vBSeed = fract(sin(dot(bScale.xz, vec2(12.9898, 78.233)) + bScale.y) * 43758.5453);
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vMeters;
varying vec3 vObjNormal;
varying float vBSeed;
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
totalEmissiveRadiance += pane * lit * winColor * (0.55 + 0.45 * winH) * ${WINDOW_EMISSIVE_INTENSITY};
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
