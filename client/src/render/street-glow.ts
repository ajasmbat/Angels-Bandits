// Stormlit L8: the street grid as it reads from altitude — a web of warm
// sodium light with rivers of white headlights and red taillights. Two far-
// field LODs, ONE draw call each, both light (no collision — nothing here is
// solid, so quality.ts rule 2 lets them scale):
//
//  1. StreetGlow — an additive emissive strip over every street line. Near
//     the camera the real lamps (streetlights.ts: heads + ground pools) own
//     the look; the strip fades IN with camera distance over exactly the band
//     the lamp pools fade OUT (GLOW_FADE_NEAR → GLOW_FADE_FAR, both on the
//     same radial distance), so the hand-off adds no light. Far away the
//     discrete lamp pools resolve to their mean and the avenues become
//     continuous lines of light, with bright corner pools at every crossing,
//     warm storefront spill along building lots and a few hashed neon smears.
//  2. FarTraffic — phantom car lights: DENSITY beyond the simulated fleet
//     (traffic.ts still draws every real car out to the fog). Two GL points
//     per car — white at the nose, red at the tail, each weighted smoothly by
//     how much it faces the camera — fading in past FAR_TRAFFIC_NEAR, where a
//     real car is a few pixels. A pure function of the synced server clock
//     (so `__ab.pinWorld` pins it and every client agrees); phantoms do not
//     stop at signals — at 250 m and beyond a queue is a few pixels.
//
// Both are ATTENUATED by the linear fog (in full) and the height haze (in
// part), never lerped toward the fog colour (fog.ts: the V1 lesson for
// additive light), and
// both stay SUB-BLOOM (peaks under the 0.72 threshold): moving sub-pixel
// bloom blobs are the O5 shimmer case, and the lamp heads already carry the
// LAMP rung.
//
// Torus: the strip is built once around the origin and placed every frame at
// the render camera snapped to the block grid (BLOCK_PITCH divides
// WORLD_SIZE, so a snapped copy lies exactly on the street lines), covering
// ±STRIP_SPAN — every image the 800 m fog can show. Its field is computed
// from world coordinates with wrap-safe mod arithmetic, so both sides of the
// seam agree. The phantom cars take the nearest image of the render camera
// in the vertex shader.
//
// Accepted (far-LOD) simplifications: a snapped lamp (D9) still contributes
// its share of a far lamp line, and a collapsed (D3) lot keeps its
// storefront spill — each is one lamp or shopfront's share of a line seen
// from 120 m+. Fallen bridge spans DO open a hole in both (the shared
// BRIDGE_GONE_UNIFORM, as the ground and the river use).

import { CITY_GRID, mulberry32 } from "@angels-bandits/common/city";
import { blockGroundKind } from "@angels-bandits/common/city/nature";
import {
  BRIDGE_COUNT,
  BRIDGE_HALF_WIDTH,
  BRIDGE_SPAN_HALF,
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
} from "@angels-bandits/common/city/river";
import {
  CURB_LINE,
  FURNITURE_LINE,
  LAMP_STATIONS_MINUS,
  LAMP_STATIONS_PLUS,
  LOT_LINE,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { AB_AA_GLSL } from "./aa-glsl";
import { AB_FOG_DISTANCE_GLSL, AB_FOG_GLSL } from "./fog";
import { applyPointFloor } from "./point-floor";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { BRIDGE_GONE_UNIFORM } from "./river";
import { SIGN_PALETTE } from "./signage";
import { trafficLanes } from "./traffic";

// --- Shared contract ---------------------------------------------------------

/** The sodium street-light colour: the lamp heads' family (streetlights.ts)
 * and the ground's `lampWarm` (sky.ts). Exported for L5's under-lit mist,
 * so the haze over the streets can take the same light. */
export const STREET_GLOW_COLOR = 0xffb35c;

/** The lamp-pool → strip hand-off band, metres of RADIAL camera distance
 * (fog.ts's AB_FOG_DISTANCE_GLSL): the strip fades in across it while the
 * lamp pools fade out across it, so the two always sum to one. */
export const GLOW_FADE_NEAR = 120;
export const GLOW_FADE_FAR = 260;

/** Half-width of a street strip: out to the lot line (the building faces),
 * so the lamp rows, the sidewalks and the storefront spill all fit. */
export const STRIP_HALF = LOT_LINE;
/** Strip coverage around the snapped camera, metres — more than the fog's
 * reach plus the snap's half-pitch. */
const STRIP_SPAN = 1100;
/** Strip segment length, metres: short pieces, so no clipped multi-km
 * triangle carries the world-coordinate varying, and so whole segments
 * inside the fade-in band can be collapsed in the vertex shader. */
const SEGMENT = 40;
/** Share of the street-level haze that attenuates the street light (the
 * linear fog always applies in full — the torus guarantee). */
const HAZE_PASS = 0.45;
/** Strip height above the street (plus polygonOffset, like the L6 pools). */
const STRIP_Y = 0.05;

// --- Luminance budget (linear, pre-bloom; the bloom threshold is 0.72) -----
// Multipliers on STREET_GLOW_COLOR (luminance ~0.54) BEFORE the hard
// STRIP_CAP below, which bounds whatever these stack to.
/** The lamp row's bright core. */
const ROW_CORE = 1.15;
/** The soft halo either side of a lamp row. */
const ROW_HALO = 0.42;
/** The warm wash over the roadway. */
const ROAD_WASH = 0.24;
/** A crossing's corner pools, where two lamp rows meet. */
const CORNER = 1.0;
/** Storefront spill along a building lot (the brightest shops). */
const SHOP = 0.35;
/** Hard cap on the luminance the strip adds to any pixel (see main()). */
const STRIP_CAP = 0.45;
/** Neon smear peak luminance (sparse, a few lots per street). */
const NEON_LUM = 0.18;

const glsl = (n: number): string => {
  const s = String(n);
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
};
const glslVec3 = (v: readonly number[]): string =>
  `vec3(${v.map(glsl).join(", ")})`;

const STREET_COLOR = new THREE.Color(STREET_GLOW_COLOR);

/** Every block's ground kind, from the same seed-free source the ground
 * shader bakes (nature.ts blockGroundKind): only kind 0 lots have buildings
 * and so storefronts. */
const BLOCK_KIND_TABLE = `int[${CITY_GRID * CITY_GRID}](${Array.from(
  { length: CITY_GRID * CITY_GRID },
  (_, i) => blockGroundKind(Math.floor(i / CITY_GRID), i % CITY_GRID),
).join(", ")})`;

const NEON = `vec3[${SIGN_PALETTE.length}](${SIGN_PALETTE.map((c) => {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const k = NEON_LUM / l;
  return glslVec3([c.r * k, c.g * k, c.b * k].map((v) => +v.toFixed(4)));
}).join(", ")})`;

/** Wrap-safe GLSL helpers both shaders share. */
const STREET_GLSL = /* glsl */ `
// Signed offset to the nearest street centreline along one axis (BLOCK_PITCH
// divides WORLD_SIZE, so plain mod tiles across the seam).
float abLineDist(float v) {
  float m = mod(v, ${glsl(BLOCK_PITCH)});
  return m > ${glsl(BLOCK_PITCH / 2)} ? m - ${glsl(BLOCK_PITCH)} : m;
}
// D9: over a fallen bridge span's open hole (river.ts RIVER_GROUND_PARS).
uniform int uBridgeGone;
bool abSpanGone(vec2 w) {
  if (uBridgeGone == 0) return false;
  float off = abs(mod(w.y, ${glsl(WORLD_SIZE)}) - ${glsl(RIVER_CENTER_Z)});
  if (off >= ${glsl(Math.min(RIVER_HALF_WIDTH, BRIDGE_SPAN_HALF))}) return false;
  if (abs(abLineDist(w.x)) > ${glsl(BRIDGE_HALF_WIDTH)}) return false;
  int k = int(mod(floor(w.x / ${glsl(BLOCK_PITCH)} + 0.5), ${glsl(BRIDGE_COUNT)}));
  return ((uBridgeGone >> k) & 1) == 1;
}
`;

const FOG_PARS = /* glsl */ `
uniform float fogNear;
uniform float fogFar;
${AB_FOG_GLSL}
// Additive fog: attenuate, never lerp toward the fog colour. The (L1-shaped)
// linear fog in full (the torus's occlusion guarantee); the street-level haze only by
// HAZE_PASS of its amount — a light source seen through lit mist keeps
// reading (the lamp pools it replaces were never fogged at all).
float abAdditiveFog(float depth, float worldY) {
  float fogFactor = abFogFactor(fogNear, fogFar, depth);
  float haze = abHazeAmount(cameraPosition.y, worldY, depth);
  return (1.0 - fogFactor) * (1.0 - ${glsl(HAZE_PASS)} * haze);
}
`;

// --- 1. The street glow strip -------------------------------------------------

/**
 * The strip geometry, around the origin: every north–south line (x = k·PITCH)
 * as full-length strips over z ∈ ±STRIP_SPAN, and every east–west line as
 * pieces BETWEEN the north–south strips' edges, so each crossing square is
 * drawn exactly once (by the north–south strip) and nothing adds twice.
 * Each vertex carries its segment's centre and bounding radius (`aSeg`).
 */
export function stripGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const seg: number[] = [];
  const index: number[] = [];
  const quad = (x0: number, x1: number, z0: number, z1: number) => {
    const base = pos.length / 3;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const r = Math.hypot(x1 - x0, z1 - z0) / 2;
    for (const [x, z] of [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ] as const) {
      pos.push(x, STRIP_Y, z);
      seg.push(cx, cz, r);
    }
    // Counter-clockwise seen from above (+Y): FrontSide faces the sky.
    index.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const lines = Math.ceil(STRIP_SPAN / BLOCK_PITCH);
  // North–south strips: full length.
  const nsPieces = Math.ceil((2 * STRIP_SPAN) / SEGMENT);
  const nsStep = (2 * STRIP_SPAN) / nsPieces;
  for (let k = -lines; k <= lines; k++) {
    const x = k * BLOCK_PITCH;
    for (let p = 0; p < nsPieces; p++) {
      const z0 = -STRIP_SPAN + p * nsStep;
      quad(x - STRIP_HALF, x + STRIP_HALF, z0, z0 + nsStep);
    }
  }
  // East–west strips: between the north–south strips' edges, every block.
  const gap = BLOCK_PITCH - 2 * STRIP_HALF;
  const ewPieces = Math.ceil(gap / SEGMENT);
  const ewStep = gap / ewPieces;
  for (let k = -lines; k <= lines; k++) {
    const z = k * BLOCK_PITCH;
    for (let b = -lines - 1; b <= lines; b++) {
      const start = b * BLOCK_PITCH + STRIP_HALF;
      for (let p = 0; p < ewPieces; p++) {
        const x0 = start + p * ewStep;
        quad(x0, x0 + ewStep, z - STRIP_HALF, z + STRIP_HALF);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aSeg", new THREE.Float32BufferAttribute(seg, 3));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(),
    Number.POSITIVE_INFINITY,
  );
  return g;
}

const STRIP_VERTEX = /* glsl */ `
precision highp float;
uniform vec3 uOrigin;
attribute vec3 aSeg;
varying vec2 vWorld;
varying float vDepth;
varying float vWorldY;

void main() {
  vec3 wp = position + uOrigin;
  vWorld = wp.xz;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  vDepth = ${AB_FOG_DISTANCE_GLSL}; // radial, like every fogged material (O1)
  vWorldY = wp.y;
  gl_Position = projectionMatrix * mvPosition;
  // A segment wholly inside the fade-in distance shades nothing: collapse it
  // (every vertex of a segment shares aSeg, so all four agree) — the near
  // ground pays no fill for a strip that would be invisible there.
  vec2 c = uOrigin.xz + aSeg.xy - cameraPosition.xz;
  float far = length(vec3(c.x, cameraPosition.y - wp.y, c.y)) + aSeg.z;
  if (far < ${glsl(GLOW_FADE_NEAR)}) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const STRIP_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uLevel;
uniform float uSpill;
varying vec2 vWorld;
varying float vDepth;
varying float vWorldY;
${AB_AA_GLSL}
${STREET_GLSL}
${FOG_PARS}
const int AB_BLOCK_KIND[${CITY_GRID * CITY_GRID}] = ${BLOCK_KIND_TABLE};
const vec3 AB_NEON[${SIGN_PALETTE.length}] = ${NEON};
// Hash of exact (floored, canonical) cell ids only — never an interpolated
// value (concepts/traps/interpolated-hash-inputs.md).
float abHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
bool abBuiltLot(vec2 w) {
  vec2 c = mod(w, ${glsl(WORLD_SIZE)});
  ivec2 b = clamp(ivec2(floor(c / ${glsl(BLOCK_PITCH)})), ivec2(0), ivec2(${CITY_GRID - 1}));
  return AB_BLOCK_KIND[b.x * ${CITY_GRID} + b.y] == 0;
}
// Distance along a street to the nearest lamp station on one side.
float abStation(float along, vec3 stations) {
  vec3 m = abs(vec3(mod(along, ${glsl(BLOCK_PITCH)})) - stations);
  vec3 w = min(m, ${glsl(BLOCK_PITCH)} - m);
  return min(w.x, min(w.y, w.z));
}
// The roadway's warm wash, a touch brighter toward the lamp rows. Taken as
// the MAX of the two streets inside a crossing, never their sum, so the box
// is no brighter than either roadway.
float abWash(float d) {
  float ad = abs(d);
  return ${glsl(ROAD_WASH)} * (0.6 + 0.4 * smoothstep(4.0, ${glsl(CURB_LINE)}, ad)) * (1.0 - smoothstep(${glsl(CURB_LINE)}, ${glsl(CURB_LINE + 2)}, ad));
}
// Fade 1 → 0 toward the strip's edge, so every strip border is dark.
float abTaper(float d) {
  return 1.0 - smoothstep(${glsl(STRIP_HALF - 1.5)}, ${glsl(STRIP_HALF - 0.1)}, abs(d));
}

// One street's light: d = signed metres off its centreline, along = metres
// along it, line = its canonical line index, aaC / aaA the metres per pixel
// across / along it, cross = the OTHER street system's offset (lamp rows
// stop at a crossing's roadway). Returns the sodium light as a multiplier
// of uColor; adds the (already coloured) neon to \`neon\`.
float abStreet(float d, float along, float line, float aaC, float aaA, float cross, vec2 lotDir, vec2 w, inout vec3 neon) {
  float ad = abs(d);
  float side = d >= 0.0 ? 1.0 : 0.0;
  // Lamp rows on the furniture lines: discrete pools at the contract's
  // stations, resolving to a continuous line once the pools alias.
  float st = d >= 0.0
    ? abStation(along, ${glslVec3(LAMP_STATIONS_PLUS)})
    : abStation(along, ${glslVec3(LAMP_STATIONS_MINUS)});
  float pool = 1.0 - smoothstep(0.0, 24.0, st);
  pool *= pool;
  // ~0.27: the pool's mean over the 50/75/75 m station rhythm.
  float rowAlong = 0.3 + 0.7 * mix(0.27, pool, abDetail(50.0, aaA));
  float off = abs(ad - ${glsl(FURNITURE_LINE)});
  float core = abLine(off, 1.2, aaC);
  float halo = 1.0 - smoothstep(0.0, 7.0, off);
  float notCrossing = smoothstep(${glsl(CURB_LINE - 1)}, ${glsl(CURB_LINE + 3)}, abs(cross));
  float light = rowAlong * (${glsl(ROW_CORE)} * core + ${glsl(ROW_HALO)} * halo * halo) * notCrossing;
  // Storefront spill: the back of the sidewalk along a BUILT lot, shop by
  // shop (28 shops per block side), warm, some dark.
  float band = smoothstep(${glsl(FURNITURE_LINE + 0.5)}, ${glsl(LOT_LINE - 1.5)}, ad) * notCrossing * uSpill;
  if (band > 0.0 && abBuiltLot(w + lotDir * (d >= 0.0 ? 1.0 : -1.0) * 4.0)) {
    float pitch = ${glsl(BLOCK_PITCH / 28)};
    float cell = mod(floor(along / pitch), ${glsl((WORLD_SIZE / BLOCK_PITCH) * 28)});
    vec2 key = vec2(line * 2.0 + side, cell);
    float lit = step(0.3, abHash(key));
    float tone = 0.55 + 0.45 * abHash(key + 17.0);
    float shop = mix(0.53, lit * tone, abCellDetail(pitch, aaA));
    light += ${glsl(SHOP)} * shop * band;
    // Sparse neon: about one lot in fourteen throws a coloured smear.
    float neonKey = floor(cell / 4.0);
    float present = step(0.93, abHash(vec2(neonKey, line * 2.0 + side) + 41.0));
    int hue = int(floor(abHash(vec2(neonKey, side) + 7.0) * ${glsl(SIGN_PALETTE.length)}));
    float smear = 1.0 - abs(mod(along, pitch * 4.0) / (pitch * 2.0) - 1.0);
    neon += AB_NEON[hue] * present * smear * band;
  }
  return light;
}

void main() {
  // Derivatives first, in uniform control flow (aa-glsl.ts).
  float aaX = fwidth(vWorld.x);
  float aaZ = fwidth(vWorld.y);
  float fade = smoothstep(${glsl(GLOW_FADE_NEAR)}, ${glsl(GLOW_FADE_FAR)}, vDepth);
  if (fade <= 0.0 || abSpanGone(vWorld)) discard;
  float dX = abLineDist(vWorld.x);
  float dZ = abLineDist(vWorld.y);
  float lineX = mod(floor(vWorld.x / ${glsl(BLOCK_PITCH)} + 0.5), ${glsl(WORLD_SIZE / BLOCK_PITCH)});
  float lineZ = mod(floor(vWorld.y / ${glsl(BLOCK_PITCH)} + 0.5), ${glsl(WORLD_SIZE / BLOCK_PITCH)});
  float tX = abTaper(dX);
  float tZ = abTaper(dZ);
  float light = 0.0;
  vec3 neon = vec3(0.0);
  // North–south streets (lines of constant x): across = x, along = z.
  if (tX > 0.0) light += tX * abStreet(dX, vWorld.y, lineX, aaX, aaZ, dZ, vec2(1.0, 0.0), vWorld, neon);
  // East–west streets: across = z, along = x (line ids offset by 10 so
  // the two systems' shop hashes differ).
  vec3 neonZ = vec3(0.0);
  if (tZ > 0.0) light += tZ * abStreet(dZ, vWorld.x, lineZ + 10.0, aaZ, aaX, dX, vec2(0.0, 1.0), vWorld, neonZ);
  neon = tX * neon + tZ * neonZ;
  // A crossing's corners: four lamp rows meet in a bright pool.
  vec2 cd = vec2(abs(dX), abs(dZ)) - ${glsl(FURNITURE_LINE)};
  float corner = 1.0 - smoothstep(0.0, 11.0, length(cd));
  light += ${glsl(CORNER)} * corner * corner * max(tX, tZ);
  light += max(tX * abWash(dX), tZ * abWash(dZ));
  float a = fade * uLevel * abAdditiveFog(vDepth, vWorldY);
  vec3 rgb = (uColor * light + neon) * a;
  // The luminance budget as a hard cap, not a tuning outcome: whatever the
  // terms stack to (a lamp station on a storefront at a corner, little haze),
  // the strip adds at most STRIP_CAP — so strip + a phantom car light + the
  // night street stays under the 0.72 bloom threshold.
  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb *= min(1.0, ${glsl(STRIP_CAP)} / max(lum, 1e-4));
  gl_FragColor = vec4(rgb, 1.0);
}
`;

/** The far-field street glow: one additive draw for the whole grid. */
export class StreetGlow {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uColor: { value: STREET_COLOR.clone() },
          uLevel: { value: 1 },
          uSpill: { value: 1 },
          uOrigin: { value: new THREE.Vector3() },
        },
      ]),
      vertexShader: STRIP_VERTEX,
      fragmentShader: STRIP_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // `fog: true` only feeds fogNear/fogFar (the storm's in-cloud fog);
      // the shader attenuates rather than lerping.
      fog: true,
      side: THREE.FrontSide, // invisible from the bores below the street
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    // Shared by reference (merge would clone it): the fallen spans follow.
    this.material.uniforms.uBridgeGone = BRIDGE_GONE_UNIFORM;
    this.mesh = new THREE.Mesh(stripGeometry(), this.material);
    this.mesh.frustumCulled = false;
    // After the opaque city, with the other additive street light.
    this.mesh.renderOrder = 2;
    const origin = this.material.uniforms.uOrigin?.value as THREE.Vector3;
    // Snap to the RENDER camera (a QA eye is not the chase camera), every
    // draw, so the strip always covers what is actually on screen.
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      const p = camera.position;
      origin.set(
        Math.round(p.x / BLOCK_PITCH) * BLOCK_PITCH,
        0,
        Math.round(p.z / BLOCK_PITCH) * BLOCK_PITCH,
      );
    };
  }

  /** L12 sky cycle: the same 0..1 level the lamp pools take (dusk dims). */
  setLevel(k: number): void {
    (this.material.uniforms.uLevel as THREE.IUniform).value = k;
  }

  /** The street light's current level, 0..1 — for L5's under-lit mist,
   * with STREET_GLOW_COLOR. */
  get level(): number {
    return (this.material.uniforms.uLevel as THREE.IUniform).value as number;
  }

  /** O3: Mobile drops the storefront and neon spill (a uniform — rule 1). */
  setQuality(tier: QualityTier): void {
    (this.material.uniforms.uSpill as THREE.IUniform).value = QUALITY_PROFILES[
      tier
    ].streetGlowSpill
      ? 1
      : 0;
  }
}

// --- 2. Far traffic -------------------------------------------------------------

/** Lap period, seconds: every lane's speed is a whole number of m/s, so a
 * lane moves a whole number of WORLD_SIZE laps per period and the clock can
 * be reduced mod this on the CPU (in double) with no jump at the wrap. */
export const FAR_TRAFFIC_PERIOD = WORLD_SIZE;
/** Lane cruise speeds, whole m/s (the simulated cruise band is 10–14). */
const SPEEDS = [10, 11, 12, 13, 14] as const;
/** Camera-distance fade-in band, metres (radial). */
export const FAR_TRAFFIC_NEAR = 220;
export const FAR_TRAFFIC_FAR = 320;
/** Nose-to-tail light separation and lamp height, metres. */
const CAR_LENGTH = 4.4;
const LAMP_Y = 0.7;
/** World size of one light point, metres (both lamps and their glare). */
const POINT_SIZE = 4.5;
/** Platoon shape: members, spacing, and the gap after a platoon, metres. */
const PLATOON_MAX = 4;
const MEMBER_SPACING = 7.5;
const GAP_MIN = 14;
const GAP_SPAN = 70;
/** Light colours, linear: peaks ≈ 0.40 (white) and ≈ 0.34 (red) luminance —
 * sub-bloom even where one crosses the brightest street glow (STRIP_CAP). */
const HEAD_COLOR = [0.43, 0.4, 0.34] as const;
const TAIL_COLOR = [1.26, 0.1, 0.06] as const;

export interface FarCar {
  /** 1 for a lane along z (a north–south street), 0 along x. */
  axisZ: number;
  /** Canonical coordinate on the other axis: the lane centre. */
  cross: number;
  /** Travel direction along the axis. */
  dir: 1 | -1;
  /** Speed, whole m/s. */
  speed: number;
  /** Front bumper's canonical coordinate along the axis at lap time 0. */
  along: number;
}

/**
 * The phantom fleet, a pure function of the seed: every lane of the
 * simulated grid (traffic.ts trafficLanes — never the emergency centreline)
 * filled with platoons. INTERLEAVED — car j of every lane before car j+1 of
 * any lane — so any draw-range prefix is an even subsample of every avenue.
 */
export function farTrafficCars(seed: number): FarCar[] {
  const perLane: FarCar[][] = [];
  for (const lane of trafficLanes()) {
    const rand = mulberry32(
      (seed ^ Math.imul(lane.id + 7, 0x5bd1e995) ^ 0x18f4c3) >>> 0,
    );
    const speed = SPEEDS[Math.floor(rand() * SPEEDS.length)] as number;
    const cars: FarCar[] = [];
    const start = rand() * WORLD_SIZE;
    let u = 0;
    // Fill one lap, leaving at least GAP_MIN before the first car again.
    while (u < WORLD_SIZE - GAP_MIN - MEMBER_SPACING) {
      const size = 1 + Math.floor(rand() * PLATOON_MAX);
      for (let m = 0; m < size && u < WORLD_SIZE - GAP_MIN; m++) {
        cars.push({
          axisZ: lane.axis === "z" ? 1 : 0,
          cross: lane.cross,
          dir: lane.dir,
          speed,
          along: (start + u) % WORLD_SIZE,
        });
        u += MEMBER_SPACING;
      }
      u += GAP_MIN + rand() * GAP_SPAN;
    }
    perLane.push(cars);
  }
  const out: FarCar[] = [];
  const most = Math.max(...perLane.map((c) => c.length));
  for (let j = 0; j < most; j++) {
    for (const cars of perLane) {
      const car = cars[j];
      if (car) out.push(car);
    }
  }
  return out;
}

/** Server time (ms) → the lap clock the shader takes, seconds in
 * [0, FAR_TRAFFIC_PERIOD) — reduced here in double precision. */
export function farTrafficLap(serverTimeMs: number): number {
  const t = serverTimeMs / 1000;
  return t - Math.floor(t / FAR_TRAFFIC_PERIOD) * FAR_TRAFFIC_PERIOD;
}

const FAR_VERTEX_PARS = /* glsl */ `
uniform float uLap;
attribute vec4 aLane; // axisZ, cross, dir, speed
attribute vec2 aCar; // along at lap 0, end (0 nose, 1 tail)
varying vec3 vAbColor;
varying float vAbFade;
${STREET_GLSL}
`;

const FAR_BEGIN_VERTEX = /* glsl */ `
float abAlong = mod(aCar.x - aCar.y * aLane.z * ${glsl(CAR_LENGTH)} + aLane.z * aLane.w * uLap, ${glsl(WORLD_SIZE)});
vec2 abP = aLane.x > 0.5 ? vec2(aLane.y, abAlong) : vec2(abAlong, aLane.y);
// Nearest torus image of the render camera.
vec2 abRel = abP - cameraPosition.xz;
abRel -= ${glsl(WORLD_SIZE)} * floor(abRel / ${glsl(WORLD_SIZE)} + 0.5);
vec3 transformed = vec3(cameraPosition.x + abRel.x, ${glsl(LAMP_Y)}, cameraPosition.z + abRel.y);
// Nose white, tail red, each weighted by how squarely it faces the camera.
vec3 abFwd = aLane.x > 0.5 ? vec3(0.0, 0.0, aLane.z) : vec3(aLane.z, 0.0, 0.0);
vec3 abToCam = normalize(cameraPosition - transformed);
float abFacing = dot(abFwd, abToCam) * (aCar.y > 0.5 ? -1.0 : 1.0);
float abWeight = 0.3 + 0.7 * smoothstep(-0.3, 0.6, abFacing);
vAbColor = (aCar.y > 0.5 ? ${glslVec3([...TAIL_COLOR])} : ${glslVec3([...HEAD_COLOR])}) * abWeight;
vAbFade = abSpanGone(abP) ? 0.0 : 1.0;
`;

const FAR_FOG_VERTEX = /* glsl */ `
#include <fog_vertex>
{
  float abDist = ${AB_FOG_DISTANCE_GLSL};
  vAbFade *= smoothstep(${glsl(FAR_TRAFFIC_NEAR)}, ${glsl(FAR_TRAFFIC_FAR)}, abDist);
  // Faded out (near, or over a fallen span): culled before raster.
  if (vAbFade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

/** Points patch cache key: its own, so it can never share a program with
 * another PointsMaterial patch (traffic.ts explains the trap). */
const FAR_TRAFFIC_CACHE_KEY = "ab-l8-far-traffic";

/** The phantom car lights: one GL-points draw for the whole far field. */
export class FarTraffic {
  readonly points: THREE.Points;
  private readonly lap = { value: 0 };
  private readonly total: number;

  constructor(seed: number) {
    const cars = farTrafficCars(seed);
    this.total = cars.length * 2;
    const lane = new Float32Array(this.total * 4);
    const car = new Float32Array(this.total * 2);
    cars.forEach((c, i) => {
      for (let end = 0; end < 2; end++) {
        const v = i * 2 + end;
        lane.set([c.axisZ, c.cross, c.dir, c.speed], v * 4);
        car.set([c.along, end], v * 2);
      }
    });
    const geometry = new THREE.BufferGeometry();
    // `position` is unused by the patched shader, but three draws a
    // geometry by its position count.
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(this.total * 3), 3),
    );
    geometry.setAttribute("aLane", new THREE.BufferAttribute(lane, 4));
    geometry.setAttribute("aCar", new THREE.BufferAttribute(car, 2));
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Number.POSITIVE_INFINITY,
    );
    const material = new THREE.PointsMaterial({
      size: POINT_SIZE,
      sizeAttenuation: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // fog: true feeds fogNear/fogFar; the fragment patch ATTENUATES.
      fog: true,
    });
    material.customProgramCacheKey = () => FAR_TRAFFIC_CACHE_KEY;
    const lap = this.lap;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uLap = lap;
      shader.uniforms.uBridgeGone = BRIDGE_GONE_UNIFORM;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${FAR_VERTEX_PARS}`)
        .replace("#include <begin_vertex>", FAR_BEGIN_VERTEX)
        .replace("#include <fog_vertex>", FAR_FOG_VERTEX);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vAbColor;\nvarying float vAbFade;",
        )
        .replace(
          "#include <map_particle_fragment>",
          /* glsl */ `{
  vec2 abPc = gl_PointCoord * 2.0 - 1.0;
  float abR = max(0.0, 1.0 - dot(abPc, abPc));
  diffuseColor.rgb *= vAbColor;
  diffuseColor.a *= abR * abR * vAbFade;
}`,
        )
        .replace(
          "#include <fog_fragment>",
          /* glsl */ `#ifdef USE_FOG
  gl_FragColor.a *= (1.0 - abFogFactor(fogNear, fogFar, vFogDepth)) * (1.0 - ${glsl(HAZE_PASS)} * abHazeAmount(cameraPosition.y, vFogWorldY, vFogDepth));
#endif`,
        );
      // O5: never drawn under 2 px, alpha-paid, faded below 1 px.
      applyPointFloor(shader);
    };
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.visible = false; // until the first server clock estimate
    // With the other additive street light, after the opaque city.
    this.points.renderOrder = 2;
  }

  /** Phantom cars (two lights each) in the fleet. */
  get cars(): number {
    return this.total / 2;
  }

  /** Advance to server time `serverTimeMs` (null = clock unknown → hide). */
  update(serverTimeMs: number | null): void {
    if (serverTimeMs === null) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    this.lap.value = farTrafficLap(serverTimeMs);
  }

  /** O3: the tier's share of the phantom fleet (an interleaved prefix). */
  setQuality(tier: QualityTier): void {
    const share = QUALITY_PROFILES[tier].farTraffic;
    this.points.geometry.setDrawRange(
      0,
      Math.round((this.total / 2) * share) * 2,
    );
  }
}
