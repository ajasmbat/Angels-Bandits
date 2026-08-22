// Dusk sky, fog, lights, and the ground plane. The fog color matches the
// clear color exactly, so geometry dissolves into "city haze" well before the
// torus's half-world limit (FOG_DISTANCE = 800 < WORLD_SIZE/2 = 1000).
//
// The ground is a camera-following plane — equivalent to chunk-shifting for an
// infinite-looking floor. Its paint (S1, "wet neon" direction) is a shader
// patch anchored to canonical WORLD coordinates via a per-frame origin
// uniform: asphalt, lane markings, crosswalk zebras, and sidewalks are all
// computed from the street contract's constants, so the paint can never
// disagree with lamp/traffic geometry. Mod arithmetic on canonical coords
// tiles across the seam by construction — no wrap special-cases.

import {
  CROSSWALK_DEPTH,
  CURB_LINE,
  LANE_CENTERS,
  ROADWAY_HALF,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH, FOG_DISTANCE } from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";
import * as THREE from "three";
import { LAMP_STATIONS_MINUS, LAMP_STATIONS_PLUS } from "./streetlights";

export const DUSK = {
  sky: 0x141225, // deep dusk indigo — clear color AND fog color, always identical
  ambient: 0x3a3a5c,
  sun: 0xff9a66, // low orange sun for long dusk shadows on tower faces
} as const;

const GROUND_SIZE = 2 * FOG_DISTANCE + 200; // fully covers the fog radius

export function setupSky(scene: THREE.Scene): void {
  scene.background = new THREE.Color(DUSK.sky);
  scene.fog = new THREE.Fog(DUSK.sky, 60, FOG_DISTANCE);

  // Night rebalance (V1): ambient way down so the emissives — windows,
  // tracers, street lamps — carry the scene; the hemisphere shapes the cool
  // ambient (indigo sky over a near-black ground) and the directional is a
  // low warm dusk key. No shadow maps, no point lights.
  scene.add(new THREE.AmbientLight(DUSK.ambient, 0.5));
  const sun = new THREE.DirectionalLight(DUSK.sun, 0.9);
  sun.position.set(-0.6, 0.25, 0.75); // direction only — a low dusk sun
  scene.add(sun);
  const fill = new THREE.HemisphereLight(0x2c2c4a, 0x05050a, 0.7);
  scene.add(fill);
}

/** 1×256 vertical dusk gradient: fog indigo at the horizon (so buildings
 * dissolve into it seamlessly) warming through neon violet, deep night up top. */
function skyGradientTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, "#08071a"); // zenith — deep night
    grad.addColorStop(0.45, "#141225"); // fog indigo
    grad.addColorStop(0.62, "#2b1838"); // neon violet band
    grad.addColorStop(0.72, "#3d1f33"); // last-light magenta glow
    grad.addColorStop(0.78, "#141225"); // back to fog at the horizon line
    grad.addColorStop(1.0, "#141225");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1, 256);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Camera-following gradient dome, just inside the far plane, above the fog. */
export class SkyDome {
  readonly mesh: THREE.Mesh;

  constructor() {
    const material = new THREE.MeshBasicMaterial({
      map: skyGradientTexture(),
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(FOG_DISTANCE + 60, 24, 16),
      material,
    );
    this.mesh.renderOrder = -1; // always the backdrop
  }

  /** Keep the dome centered on the viewer. */
  update(cameraPos: Vec3): void {
    this.mesh.position.set(cameraPos.x, cameraPos.y, cameraPos.z);
  }
}

// --- S1 painted ground ------------------------------------------------------

/** Linear-space GLSL literal for an sRGB hex (THREE.Color converts). */
const glslColor = (hex: number): string => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};
const glslNum = (v: number): string => v.toFixed(4);
const glslVec3Of = (vs: readonly number[]): string =>
  `vec3(${vs.map((v) => v.toFixed(2)).join(", ")})`;

// Wet-neon palette (approved concept 4): cool damp asphalt, crisp cool-white
// markings, warm lamp-reflection streaks. Colors are albedo; markings also get
// a low emissive lift (sub-bloom — only the ladder's rungs may bloom).
const GROUND_COLORS = {
  asphalt: glslColor(0x1a1c28),
  interior: glslColor(0x0d0d14),
  sidewalk: glslColor(0x262838),
  seam: glslColor(0x1e1f2d),
  curb: glslColor(0x363a4a),
  marking: glslColor(0xcfd8e8),
  edge: glslColor(0x9ca4b6),
  zebra: glslColor(0xd4dcea),
  lampWarm: glslColor(0xffb35c), // the existing streetlight color family
} as const;
/** Marking emissive lift: ~0.45 peak luminance — under the 0.72 bloom threshold. */
const MARKING_GLOW = "0.65";
/** Peak of a lamp-reflection streak (~0.27 luminance — sub-bloom, warm). */
const STREAK_GLOW = "0.5";
/** Damp roadway roughness; sidewalks/interiors stay matte at the base 1.0. */
const ROADWAY_ROUGHNESS = "0.7";
/** Sidewalk paint band beyond the curb, meters (building faces sit further out). */
const SIDEWALK_BAND = 8;

// Geometry anchors — every street offset comes from the contract imports.
const G = {
  pitch: glslNum(BLOCK_PITCH),
  road: glslNum(ROADWAY_HALF),
  curb: glslNum(CURB_LINE),
  xwalkOut: glslNum(ROADWAY_HALF + CROSSWALK_DEPTH),
  lane: glslNum(LANE_CENTERS[1]),
  edgeIn: glslNum(CURB_LINE - 0.8), // lane-edge line: 0.35 m wide, inset off the curb
  edgeOut: glslNum(CURB_LINE - 0.45),
  walkOut: glslNum(CURB_LINE + SIDEWALK_BAND),
  streakCross: glslNum(CURB_LINE - 2), // reflection streak center on the roadway
  stationsPlus: glslVec3Of(LAMP_STATIONS_PLUS),
  stationsMinus: glslVec3Of(LAMP_STATIONS_MINUS),
} as const;

const GROUND_VERTEX_PARS = /* glsl */ `
uniform vec2 uGroundOrigin;
varying vec2 vWorldXZ;
`;

const GROUND_VERTEX_MAIN = /* glsl */ `
// Canonical world XZ: plane local coords + the canonicalized camera origin
// (the plane is rotated -90° about X, so local +y maps to world -z).
vWorldXZ = uGroundOrigin + vec2(position.x, -position.y);
`;

const GROUND_FRAGMENT_PARS = /* glsl */ `
varying vec2 vWorldXZ;
float abHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float abNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(abHash(i), abHash(i + vec2(1.0, 0.0)), u.x),
             mix(abHash(i + vec2(0.0, 1.0)), abHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Signed offset to the nearest street centerline along one axis (wrap-safe:
// BLOCK_PITCH divides WORLD_SIZE, so plain mod tiles across the seam).
float abLineDist(float v) {
  float m = mod(v, ${G.pitch});
  return m > ${G.pitch} * 0.5 ? m - ${G.pitch} : m;
}
// Distance to the nearest lamp station along a street (stations per side).
float abStationDist(float v, vec3 stations) {
  vec3 m = abs(vec3(mod(v, ${G.pitch})) - stations);
  vec3 w = min(m, ${G.pitch} - m);
  return min(w.x, min(w.y, w.z));
}
// Elongated soft falloff: a lamp's glow smeared along the wet roadway.
float abStreak(float dAlong, float dCross) {
  float a = 1.0 - smoothstep(0.0, 14.0, dAlong);
  float c = 1.0 - smoothstep(0.0, 2.2, abs(dCross));
  return a * a * c;
}
`;

const GROUND_FRAGMENT_MAIN = /* glsl */ `
float abDx = abLineDist(vWorldXZ.x);
float abDz = abLineDist(vWorldXZ.y);
float abAdx = abs(abDx);
float abAdz = abs(abDz);
float abRoadX = 1.0 - step(${G.road}, abAdx); // north–south street band
float abRoadZ = 1.0 - step(${G.road}, abAdz); // east–west street band
float abRoad = max(abRoadX, abRoadZ);
float abNoiseV = abNoise(vWorldXZ * 0.5); // ~2 m value noise
vec3 abPaint;
vec3 abEmissive = vec3(0.0);
if (abRoad > 0.5) {
  abPaint = ${GROUND_COLORS.asphalt} * (1.0 + (abNoiseV - 0.5) * 0.5);
  // Wear mask: markings survive where it passes (light wear on the wet look).
  float abWear = step(0.18, abNoise(vWorldXZ * 0.77 + 40.0));
  if (abRoadX * abRoadZ < 0.5) { // outside the intersection core
    float abAlong = abRoadX > 0.5 ? vWorldXZ.y : vWorldXZ.x;
    float abCross = abRoadX > 0.5 ? abDx : abDz;
    float abAcr = abs(abCross);
    float abOther = abRoadX > 0.5 ? abAdz : abAdx;
    if (abOther <= ${G.xwalkOut}) {
      // Crosswalk zebra on this approach: stripes repeat across the roadway.
      float abS = mod(abRoadX > 0.5 ? vWorldXZ.x : vWorldXZ.y, 1.7);
      float abZebra = step(abS, 0.95) * (1.0 - step(${G.road} - 0.6, abAcr)) * abWear;
      abPaint = mix(abPaint, ${GROUND_COLORS.zebra}, abZebra * 0.9);
      abEmissive += ${GROUND_COLORS.zebra} * abZebra * ${MARKING_GLOW};
    } else {
      // Dashed center line (3 m on / 3 m off) + solid lane-edge lines.
      float abDash = (1.0 - step(0.18, abAcr)) * (1.0 - step(3.0, mod(abAlong, 6.0))) * abWear;
      float abEdge = step(${G.edgeIn}, abAcr) * (1.0 - step(${G.edgeOut}, abAcr)) * abWear;
      abPaint = mix(abPaint, ${GROUND_COLORS.marking}, abDash * 0.95);
      abPaint = mix(abPaint, ${GROUND_COLORS.edge}, abEdge * 0.85);
      abEmissive += (${GROUND_COLORS.marking} * abDash + ${GROUND_COLORS.edge} * abEdge * 0.6) * ${MARKING_GLOW};
    }
    // Wet sheen: lamp glow smeared into a warm streak under each lamp.
    float abStr =
      abStreak(abStationDist(abAlong, ${G.stationsPlus}), abCross - ${G.streakCross}) +
      abStreak(abStationDist(abAlong, ${G.stationsMinus}), abCross + ${G.streakCross});
    abEmissive += ${GROUND_COLORS.lampWarm} * abStr * ${STREAK_GLOW};
  }
} else {
  float abWalkX = 1.0 - step(${G.walkOut}, abAdx);
  float abWalkZ = 1.0 - step(${G.walkOut}, abAdz);
  if (max(abWalkX, abWalkZ) > 0.5) {
    // Sidewalk concrete with expansion joints every 5 m and a curb stone.
    abPaint = ${GROUND_COLORS.sidewalk} * (1.0 + (abNoiseV - 0.5) * 0.3);
    float abJoint = max(
      abWalkX * step(mod(vWorldXZ.y, 5.0), 0.15),
      abWalkZ * step(mod(vWorldXZ.x, 5.0), 0.15));
    abPaint = mix(abPaint, ${GROUND_COLORS.seam}, abJoint);
    float abCurb = max(
      abWalkX * (1.0 - step(${G.curb} + 0.5, abAdx)),
      abWalkZ * (1.0 - step(${G.curb} + 0.5, abAdz)));
    abPaint = mix(abPaint, ${GROUND_COLORS.curb}, abCurb);
  } else {
    abPaint = ${GROUND_COLORS.interior}; // block interiors: darkest
  }
}
diffuseColor.rgb = abPaint;
`;

export class GroundPlane {
  readonly mesh: THREE.Mesh;
  private readonly origin: THREE.Vector2;

  constructor() {
    this.origin = new THREE.Vector2();
    const material = new THREE.MeshStandardMaterial({ roughness: 1 });
    // Three keys its program cache on onBeforeCompile.toString(); an explicit
    // key keeps this patch from colliding with the other patched materials.
    material.customProgramCacheKey = () => "ab-ground-paint";
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uGroundOrigin = { value: this.origin };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>\n${GROUND_VERTEX_PARS}`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${GROUND_VERTEX_MAIN}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\n${GROUND_FRAGMENT_PARS}`,
        )
        .replace(
          "vec4 diffuseColor = vec4( diffuse, opacity );",
          `vec4 diffuseColor = vec4( diffuse, opacity );\n${GROUND_FRAGMENT_MAIN}`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          // Damp sheen on the roadway only — no reflections, just roughness.
          `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, ${ROADWAY_ROUGHNESS}, abRoad);`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\ntotalEmissiveRadiance += abEmissive;",
        );
    };
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
      material,
    );
    this.mesh.rotation.x = -Math.PI / 2;
  }

  /** Follow the camera; keep the paint glued to canonical world coords. */
  update(cameraPos: Vec3): void {
    this.mesh.position.set(cameraPos.x, 0, cameraPos.z);
    const canonical = canonicalize(cameraPos);
    this.origin.set(canonical.x, canonical.z);
  }
}
