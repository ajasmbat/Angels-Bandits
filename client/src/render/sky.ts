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

/**
 * VO1 "Neon Blue Hour" palette. The night stays a night — windows, neon and
 * tracers still carry identity — but it is a LUMINOUS night: light pollution
 * makes the horizon the brightest part of the sky, so the fog that dissolves
 * distant towers is a glowing blue-violet rather than black, and silhouettes
 * separate by depth (aerial perspective) instead of merging into one mass.
 */
export const DUSK = {
  sky: 0x3a3160, // horizon glow — clear color AND fog color, always identical
  ambient: 0x56587e, // cool skylight floor so nothing is ever pure black
  moon: 0xc8d2ff, // cool moonlight key: the light that gives faces their form
  glow: 0xff8a5c, // warm low afterglow / sodium city glow from the far side
  hemiSky: 0x5c64a0, // hemisphere: blue sky above...
  hemiGround: 0x845038, // ...warm street-glow bounce from below
} as const;

/**
 * Moonlight direction (towards the moon, world space). Low enough — ~24°
 * up — that a chase camera flying toward it actually sees the disc, high
 * enough that it lights roofs as well as facades. The disc on the dome and
 * the directional key share this vector, so the light always comes from
 * where the moon is drawn.
 */
export const MOON_DIR = new THREE.Vector3(0.52, 0.42, -0.74).normalize();

/** Light intensities (three's physical units: irradiance multipliers). */
export const LIGHT_RIG = {
  ambient: 0.75,
  moon: 2.1,
  glow: 1.15,
  hemi: 1.35,
} as const;

/** Tone-mapping exposure — the whole-image lift (ACES filmic). */
export const EXPOSURE = 1.18;

/** Where the linear fog starts, m. VO1 pushed it out from 60 m: with a
 * luminous fog colour, a fog that starts at 60 m flattens the mid-distance
 * into one violet wash. The far end (FOG_DISTANCE) is the torus contract and
 * does not move. */
export const FOG_NEAR = 140;

const GROUND_SIZE = 2 * FOG_DISTANCE + 200; // fully covers the fog radius

export function setupSky(scene: THREE.Scene): void {
  scene.background = new THREE.Color(DUSK.sky);
  scene.fog = new THREE.Fog(DUSK.sky, FOG_NEAR, FOG_DISTANCE);

  // VO1 rig: a cool moon key gives every face a lit side and a shadow side,
  // a warm low glow from the opposite quarter rims the dark side, and the
  // hemisphere supplies sky-blue from above and street-glow from below — the
  // canyon reads as lit by its own city. Still no shadow maps and no point
  // lights: these four are uniform-cost per fragment.
  scene.add(new THREE.AmbientLight(DUSK.ambient, LIGHT_RIG.ambient));
  const moon = new THREE.DirectionalLight(DUSK.moon, LIGHT_RIG.moon);
  moon.position.copy(MOON_DIR); // direction only
  scene.add(moon);
  const glow = new THREE.DirectionalLight(DUSK.glow, LIGHT_RIG.glow);
  glow.position.set(-0.6, 0.18, 0.78); // the old dusk sun, now a rim
  scene.add(glow);
  scene.add(
    new THREE.HemisphereLight(DUSK.hemiSky, DUSK.hemiGround, LIGHT_RIG.hemi),
  );
}

/** Canvas fraction at which the gradient becomes the fog colour for good.
 * 0.5 is the horizon; 0.4 is 18° above it — higher than the tallest landmark
 * at the fog limit can reach seen from the street, so a fully fogged tower
 * can never be told apart from the sky behind it (the torus occlusion
 * guarantee; pinned in client/test/sky.test.ts). */
export const SKY_FOG_STOP = 0.4;

/** 1×256 vertical gradient: deep blue zenith, through moonlit blue and a
 * violet light-pollution band, to the fog colour from SKY_FOG_STOP down. */
function skyGradientTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const fog = `#${DUSK.sky.toString(16).padStart(6, "0")}`;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, "#060a26"); // zenith — deep blue night
    grad.addColorStop(0.14, "#0b1336"); // night blue
    grad.addColorStop(0.25, "#131d4a"); // moonlit blue
    grad.addColorStop(0.32, "#22245a"); // lifting toward the band
    grad.addColorStop(0.37, "#30295f"); // violet light pollution
    grad.addColorStop(SKY_FOG_STOP, fog); // the horizon glow IS the fog
    grad.addColorStop(1.0, fog);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1, 256);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Moon disc angular radius, radians (~2.6° — big and cinematic, the way a
 * long lens shows it; the real 0.26° would be a sub-pixel dot at FOV 70). */
export const MOON_RADIUS = 0.045;
/** Peak linear luminance of the disc: just over the 0.72 bloom threshold so
 * it carries a soft halo, still far under the tracer rung (1.5). */
export const MOON_PEAK = 0.95;

const MOON_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MOON_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uDisc; // disc radius as a fraction of the quad half-size
uniform vec3 uTint; // storm dome tint, multiplied in like the dome's
varying vec2 vUv;
float mHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float mNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mHash(i), mHash(i + vec2(1.0, 0.0)), u.x),
             mix(mHash(i + vec2(0.0, 1.0)), mHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  float r = length(vUv) / uDisc;
  // Disc: soft limb darkening + maria (low-frequency dark patches).
  float disc = 1.0 - smoothstep(0.96, 1.0, r);
  vec2 q = vUv / uDisc;
  float maria = mNoise(q * 2.3 + 3.1) * 0.6 + mNoise(q * 5.1) * 0.4;
  float limb = 0.78 + 0.22 * sqrt(max(0.0, 1.0 - r * r));
  vec3 discCol = uColor * limb * (1.0 - 0.28 * smoothstep(0.45, 0.75, maria));
  // Halo: two exponential falloffs — a tight corona and a wide moonlit haze.
  float d = max(r - 1.0, 0.0);
  float halo = 0.22 * exp(-d * 2.6) + 0.07 * exp(-d * 0.55);
  vec3 col = discCol * disc + uColor * halo * (1.0 - disc);
  float a = max(disc, halo * 1.4);
  gl_FragColor = vec4(col * uTint, clamp(a, 0.0, 1.0));
}
`;

/** The moon: one camera-facing quad on the dome, at MOON_DIR. */
function moonMesh(radius: number): THREE.Mesh {
  const peak = new THREE.Color(DUSK.moon);
  const lum = 0.2126 * peak.r + 0.7152 * peak.g + 0.0722 * peak.b;
  peak.multiplyScalar(MOON_PEAK / lum);
  // Quad half-size covers the halo: 9 disc radii.
  const half = Math.tan(MOON_RADIUS) * radius * 9;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: peak },
      uDisc: { value: 1 / 9 },
      uTint: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: MOON_VERTEX,
    fragmentShader: MOON_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 2, half * 2),
    material,
  );
  mesh.name = "moon";
  mesh.position.copy(MOON_DIR).multiplyScalar(radius);
  mesh.lookAt(0, 0, 0); // faces the dome centre — the camera
  mesh.frustumCulled = false;
  return mesh;
}

/** Stars on the dome: count, and the elevation band they occupy. */
export const STAR_COUNT = 900;
const STAR_ELEVATION_MIN = 0.24; // rad above the horizon — clear of the glow band
/** Brightest star, as a multiplier on white: sub-bloom (luminance < 0.72). */
export const STAR_PEAK = 0.62;

/**
 * A seeded star field, as a child of the dome so it follows the camera and
 * hides with it. NOT additive over emissives — stars are drawn first (the
 * dome's render order) and the city paints over them, as it should. Sizes
 * are in pixels with no attenuation: a star is a point, not a sprite.
 */
function starField(seed: number): THREE.Points {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const radius = FOG_DISTANCE + 40;
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const az = rand() * Math.PI * 2;
    // Uniform on the cap above STAR_ELEVATION_MIN.
    const sinMin = Math.sin(STAR_ELEVATION_MIN);
    const el = Math.asin(sinMin + rand() * (1 - sinMin));
    positions[i * 3] = Math.cos(el) * Math.cos(az) * radius;
    positions[i * 3 + 1] = Math.sin(el) * radius;
    positions[i * 3 + 2] = Math.cos(el) * Math.sin(az) * radius;
    // Mostly faint, a few bright; fade into the haze near the horizon; a
    // little colour temperature spread so it is not a field of one white.
    const mag = rand() ** 2.2;
    const horizon = Math.min(1, (el - STAR_ELEVATION_MIN) / 0.35);
    const k = STAR_PEAK * (0.25 + 0.75 * mag) * horizon;
    const warm = rand();
    colors[i * 3] = k * (0.85 + 0.15 * warm);
    colors[i * 3 + 1] = k * (0.88 + 0.08 * warm);
    colors[i * 3 + 2] = k * (1.0 - 0.12 * warm);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 1.6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      fog: false,
    }),
  );
  points.renderOrder = -1;
  points.frustumCulled = false;
  return points;
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
    // Stars ride the dome: same centre, hidden with it inside the cloud deck.
    this.mesh.add(starField(0x57a2f1e1));
    // So does the moon — drawn in the transparent pass, after the city, so
    // towers occlude it through the depth buffer.
    this.moon = moonMesh(FOG_DISTANCE + 20);
    this.moonTint = (this.moon.material as THREE.ShaderMaterial).uniforms.uTint
      ?.value as THREE.Color;
    this.mesh.add(this.moon);
  }

  private readonly moon: THREE.Mesh;
  private readonly moonTint: THREE.Color;

  /** Keep the dome centered on the viewer. */
  update(cameraPos: Vec3): void {
    this.mesh.position.set(cameraPos.x, cameraPos.y, cameraPos.z);
  }

  /** Storm hook (ST2): multiplicative tint over the gradient — white is the
   * resting state, a sky flash pulls it violet and brightens it briefly. */
  tint(color: THREE.Color): void {
    (this.mesh.material as THREE.MeshBasicMaterial).color.copy(color);
    this.moonTint.copy(color);
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
