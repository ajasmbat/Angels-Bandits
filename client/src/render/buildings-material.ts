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
float roomDepth = 3.5;            //   fake interior depth, meters
float winBlinds = 0.22;           //   share of lit windows with blinds drawn
if (vArch > 1.5) {                // OFFICE: horizontal strips, floor blocks
  winPitch = vec2(6.0, 4.5);
  winPane = vec2(0.9, 0.48);
  winLitRatio = 0.38;
  winCoolBias = 0.4;
  winFloorCluster = 1.0;
  roomDepth = 3.0;
  winBlinds = 0.3;
} else if (vArch > 0.5) {         // MASONRY: small punched windows, warm
  winPitch = vec2(3.5, 3.5);
  winPane = vec2(0.45, 0.42);
  winLitRatio = 0.3;
  winCoolBias = 0.08;
  winInset = 1.0;
  roomDepth = 2.2;
  winBlinds = 0.42;
}
`;

// --- Weathering (Concept 5 "Balanced blend") ---
/** Vertical AO: facades darkest at the street, fading out by this height. */
const AO_HEIGHT = "25.0";
/** AO strength at worldY = 0 (0 = off, 1 = black). */
const AO_STRENGTH = "0.5";
/** Per-face tone jitter amplitude — corners read because faces differ. */
const FACE_JITTER = "0.08";
/** Roof tone variation per building (roofs also sit darker than facades). */
const ROOF_VAR = "0.22";
/** Grime: fraction of facade columns carrying a dark streak. */
const GRIME = "0.22";

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
// --- Weathering ---
// Per-face tone jitter: each box face gets a slightly different value (and
// opposite faces differ), so corners read even in flat night light.
float faceId = abs(vObjNormal.x) > 0.5 ? (vObjNormal.x > 0.0 ? 0.0 : 1.0)
             : abs(vObjNormal.z) > 0.5 ? (vObjNormal.z > 0.0 ? 2.0 : 3.0)
             : 4.0;
float faceJit = 1.0 + ${FACE_JITTER} * (abHash(vec2(faceId, 7.0), vBSeed * 61.0) * 2.0 - 1.0)
              - 0.05 * mod(faceId, 2.0);
// Vertical AO grounding: towers sit dark on their streets, fading out by
// ${AO_HEIGHT} m of WORLD height (Y never wraps, so no seam cases).
float ao = 1.0 - ${AO_STRENGTH} * (1.0 - clamp(vWorldY / ${AO_HEIGHT}, 0.0, 1.0));
// Grime: some facade columns carry a dark streak, denser low on the wall.
float grime = 1.0 - 0.5 * step(abHash(vec2(floor(winGrid.x / winPitch.x), 77.0), vBSeed * 61.0), ${GRIME})
  * (1.0 - clamp(vWorldY / 60.0, 0.0, 0.85)) * facade;
// Roofs: darker than facades, varied per building so the top-down view is
// not one uniform slab color.
float roofTone = 0.55 - ${ROOF_VAR} * abHash(vec2(11.0, 5.0), vBSeed * 61.0);
diffuseColor.rgb *= mix(roofTone, faceJit * ao * grime, facade);
`;

const FRAGMENT_EMISSIVE = /* glsl */ `
// Per-archetype lit-color bias: mostly warm incandescent or mostly cool
// fluorescent depending on the building's type.
float winHC = fract(sin(dot(winCell + vBSeed * 53.0, vec2(269.5, 183.3))) * 43758.5453);
vec3 winColor = mix(${glslVec3(WINDOW_WARM)}, ${glslVec3(WINDOW_COOL)}, step(1.0 - winCoolBias, winHC));
// Fake window interiors (interior mapping): raycast a room box behind every
// lit pane — parallax ceiling/floor/side/back walls, no geometry. Boxes
// never rotate, so the world-space view ray IS the facade-space ray. Every
// wall factor is < 1, so the interior peaks BELOW the flat pane the WINDOW
// rung was normalized for — the ladder ordering cannot be disturbed.
vec3 viewRay = normalize(vBWorldPos - cameraPosition);
float rayIn = 1.0;
vec2 rayUV = vec2(0.0);
if (abs(vObjNormal.x) > 0.5) {
  rayIn = -sign(vObjNormal.x) * viewRay.x;
  rayUV = vec2(viewRay.z, viewRay.y);
} else if (abs(vObjNormal.z) > 0.5) {
  rayIn = -sign(vObjNormal.z) * viewRay.z;
  rayUV = vec2(viewRay.x, viewRay.y);
}
vec2 cellMeters = winF * winPitch;
float tBack = roomDepth / max(rayIn, 0.03);
float tU = ((rayUV.x > 0.0 ? winPitch.x : 0.0) - cellMeters.x) / abSafeDiv(rayUV.x);
float tV = ((rayUV.y > 0.0 ? winPitch.y : 0.0) - cellMeters.y) / abSafeDiv(rayUV.y);
float tHit = min(tBack, min(tU, tV));
vec3 roomLight = winColor * (0.85 + 0.15 * abHash(winCell, vBSeed * 31.0));
vec3 roomCol = tHit == tBack ? roomLight * 0.55
             : tHit == tV ? (rayUV.y > 0.0 ? roomLight * 0.9 : roomLight * 0.24)
             : roomLight * 0.38;
roomCol *= 1.0 - 0.45 * clamp(tHit / (roomDepth * 2.2), 0.0, 1.0);
// Some rooms draw their blinds: flat diffuse glow, no parallax.
float blinds = step(abHash(winCell, vBSeed * 29.0), winBlinds);
vec3 litWindow = mix(roomCol * (0.55 + 0.45 * winH), winColor * (0.5 + 0.3 * winH), blinds);
vec3 windowGlow = pane * lit * litWindow * ${WINDOW_EMISSIVE_INTENSITY} * ao;
// Unlit panes catch a faint grazing-angle sky sheen (far below the bloom
// threshold — a glassy read, not a light source).
float sheenF = pow(1.0 - clamp(abs(dot(viewRay, vObjNormal)), 0.0, 1.0), 3.0);
windowGlow += pane * (1.0 - lit) * facade * vec3(0.35, 0.5, 0.7) * sheenF * 0.05;
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
