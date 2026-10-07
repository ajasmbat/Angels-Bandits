// L11 the river, drawn: the embankment walls, the bridges, the water and the
// boats. Three draw calls, all of them hidden when the channel's nearest
// image is beyond the fog.
//
// Everything solid here is drawn from common/src/city/river.ts — the same
// constants and boxes riverHit() collides — so a deck, a parapet or a hull is
// exactly where it kills. The ground plane (sky.ts) paints the road surface
// of every bridge and discards itself over the open channel only; the deck
// mesh therefore has NO top face, and nothing z-fights at street level.
//
// THE WATER'S REFLECTION is faked, not rendered: the view ray is mirrored off
// a rippled water normal and walked to the bank it heads for. Below street
// level it meets the embankment wall (dark stone, the wall lamps); above it,
// the bank's front facade plane, where a baked 1D texture of the real
// skyline height along the river says whether that point is building (lit
// window bays, street-level neon) or sky. One texture fetch per fragment, no
// second scene render. Luminance is capped under the bloom threshold: a
// reflection is never a ladder rung.
//
// TORUS. The static mesh spans two world periods of x and is snapped by whole
// periods so the camera always sits in its middle one; the water follows the
// camera in x like the ground plane. In z both sit at the channel's nearest
// image. Boats are placed per frame at nearestImage(camera, pose).

import type { Building } from "@angels-bandits/common/city";
import {
  BOAT_CABIN_HEIGHT,
  BOAT_HULL_HEIGHT,
  BRIDGE_DECK_DEPTH,
  BRIDGE_HALF_WIDTH,
  type Boat,
  type BoatPose,
  PARAPET_HEIGHT,
  PARAPET_THICKNESS,
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
  RIVER_ROW,
  RIVER_WATER_Y,
  boatPoseInto,
  bridgeBoxes,
  riverBoats,
} from "@angels-bandits/common/city/river";
import { LOT_LINE } from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  EMISSIVE_LAMP,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_WINDOW,
  FOG_DISTANCE,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type Vec3,
  canonicalize,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { SIGN_PALETTE } from "./signage";
import { nearestImage } from "./wrapPlacement";

/** Embankment wall lamps: spacing along the wall and height on it, m. */
const WALL_LAMP_STEP = 25;
const WALL_LAMP_Y = -3;
/** Bridge fascia lights: spacing along the deck edge, m. */
const FASCIA_STEP = 8;
/** The water strip's length along x, m: covers the fog radius both ways. */
const WATER_LENGTH = 2 * FOG_DISTANCE + 200;
/** Off-channel distance beyond which the whole river is fogged out, m. */
const HIDE_BEYOND = FOG_DISTANCE + RIVER_HALF_WIDTH + 40;
/** Bank facade plane, m off the channel centreline: the bank streets' far
 * lot lines, where the streetwall the water mirrors stands. */
const FACADE_OFF = BLOCK_PITCH / 2 + LOT_LINE;
/** Reflection texture: one texel per metre of river. */
const SKY_TEX_WIDTH = WORLD_SIZE;
/** Heights are stored halved in a byte (≤ 510 m). */
const HEIGHT_SCALE = 2;

const COLORS = {
  stone: 0x2b2d36,
  slime: 0x14191b,
  coping: 0x4a4b55,
  fascia: 0x30323d,
  soffit: 0x1b1c24,
  rail: 0x5a5c68,
  hull: 0x1c2330,
  cabin: 0x4c5160,
  water: 0x03060c,
  lampWarm: 0xffb35c,
  fasciaLight: 0xffe2b0,
  window: 0xffcf8a,
  port: 0xff2a1e,
  starboard: 0x29ff6a,
  white: 0xffffff,
} as const;

/** Linear emissive RGB that puts `hex` exactly on ladder rung `rung`. */
function emitOf(hex: number, rung: number): THREE.Color {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(emissiveBoost(c, rung));
}

const NO_EMIT = new THREE.Color(0, 0, 0);

/** A non-indexed triangle soup with per-vertex colour and emissive. */
class Soup {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly emit: number[] = [];

  /** Quad a→b→c→d (any winding: the materials are double-sided). */
  quad(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    color: THREE.Color,
    emit: THREE.Color = NO_EMIT,
  ): void {
    for (const v of [a, b, c, a, c, d]) {
      this.pos.push(v[0], v[1], v[2]);
      this.col.push(color.r, color.g, color.b);
      this.emit.push(emit.r, emit.g, emit.b);
    }
  }

  /** Axis-aligned box; `top`/`bottom` false leave that face out. */
  box(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    color: THREE.Color,
    emit: THREE.Color = NO_EMIT,
    top = true,
    bottom = true,
  ): void {
    this.quad(
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      color,
      emit,
    );
    this.quad(
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
      color,
      emit,
    );
    this.quad(
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
      color,
      emit,
    );
    this.quad(
      [x1, y0, z0],
      [x1, y0, z1],
      [x1, y1, z1],
      [x1, y1, z0],
      color,
      emit,
    );
    if (top) {
      this.quad(
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y1, z1],
        color,
        emit,
      );
    }
    if (bottom) {
      this.quad(
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
        color,
        emit,
      );
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aEmit", new THREE.Float32BufferAttribute(this.emit, 3));
    g.computeVertexNormals();
    return g;
  }
}

/** Vertex colours lit as usual, plus a per-vertex emissive (`aEmit`). */
function vertexEmissiveMaterial(key: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute vec3 aEmit;\nvarying vec3 vEmit;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvEmit = aEmit;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vEmit;")
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmit;",
      );
  };
  return m;
}

/**
 * The static river structure for two world periods of x (0 … 2·WORLD_SIZE),
 * canonical z: bank walls with their lamps, the railings between bridges,
 * and every bridge's deck (sides and soffit — no top), parapets and fascia
 * lights. Exported for the tests' vertex sanity checks.
 */
export function buildRiverStructure(): THREE.BufferGeometry {
  const s = new Soup();
  const c = (hex: number) => new THREE.Color(hex);
  const span = 2 * WORLD_SIZE;
  const zc = RIVER_CENTER_Z;
  const lampEmit = emitOf(COLORS.lampWarm, EMISSIVE_LAMP);
  const fasciaEmit = emitOf(COLORS.fasciaLight, EMISSIVE_LAMP);
  const water = RIVER_WATER_Y - 1;

  for (const side of [-1, 1]) {
    const z = zc + side * RIVER_HALF_WIDTH;
    // The wall in three courses: a slimy waterline, dressed stone, a coping.
    s.quad(
      [0, water, z],
      [span, water, z],
      [span, -21, z],
      [0, -21, z],
      c(COLORS.slime),
    );
    s.quad(
      [0, -21, z],
      [span, -21, z],
      [span, -0.6, z],
      [0, -0.6, z],
      c(COLORS.stone),
    );
    s.quad(
      [0, -0.6, z],
      [span, -0.6, z],
      [span, 0, z],
      [0, 0, z],
      c(COLORS.coping),
    );
    // Wall lamps just proud of the face, facing the water.
    const zl = z - side * 0.06;
    for (let x = WALL_LAMP_STEP / 2; x < span; x += WALL_LAMP_STEP) {
      s.quad(
        [x - 0.3, WALL_LAMP_Y - 0.3, zl],
        [x + 0.3, WALL_LAMP_Y - 0.3, zl],
        [x + 0.3, WALL_LAMP_Y + 0.3, zl],
        [x - 0.3, WALL_LAMP_Y + 0.3, zl],
        c(COLORS.lampWarm),
        lampEmit,
      );
    }
    // Railings on the bank side of the wall top, bridge to bridge.
    const r0 = side === 1 ? z : z - PARAPET_THICKNESS;
    for (let line = 0; line < span; line += BLOCK_PITCH) {
      s.box(
        line + BRIDGE_HALF_WIDTH,
        line + BLOCK_PITCH - BRIDGE_HALF_WIDTH,
        0,
        PARAPET_HEIGHT,
        r0,
        r0 + PARAPET_THICKNESS,
        c(COLORS.rail),
        NO_EMIT,
        true,
        false,
      );
    }
  }

  // Bridges: the shared boxes, repeated for the second period.
  for (const period of [0, WORLD_SIZE]) {
    for (const b of bridgeBoxes()) {
      const x0 = period + b.x - b.hx;
      const x1 = period + b.x + b.hx;
      const z0 = b.z - b.hz;
      const z1 = b.z + b.hz;
      if (b.y1 > 0) {
        s.box(x0, x1, b.y0, b.y1, z0, z1, c(COLORS.rail), NO_EMIT, true, false);
        continue;
      }
      // Deck: fascia on both long sides, the soffit below. No top face — the
      // ground plane paints the road there.
      s.quad(
        [x0, b.y0, z0],
        [x0, b.y0, z1],
        [x0, b.y1, z1],
        [x0, b.y1, z0],
        c(COLORS.fascia),
      );
      s.quad(
        [x1, b.y0, z0],
        [x1, b.y0, z1],
        [x1, b.y1, z1],
        [x1, b.y1, z0],
        c(COLORS.fascia),
      );
      s.quad(
        [x0, b.y0, z0],
        [x1, b.y0, z0],
        [x1, b.y0, z1],
        [x0, b.y0, z1],
        c(COLORS.soffit),
      );
      // A string of fascia lights along each edge — the cue that says "you
      // can fly under this" from down the channel.
      const y = -BRIDGE_DECK_DEPTH * 0.55;
      for (let z = z0 + FASCIA_STEP / 2; z < z1; z += FASCIA_STEP) {
        for (const x of [x0 - 0.06, x1 + 0.06]) {
          s.quad(
            [x, y - 0.18, z - 0.35],
            [x, y - 0.18, z + 0.35],
            [x, y + 0.18, z + 0.35],
            [x, y + 0.18, z - 0.35],
            c(COLORS.fasciaLight),
            fasciaEmit,
          );
        }
      }
    }
  }
  return s.geometry();
}

/** One boat at unit length and beam (x along the hull, bow at +x). Heights
 * are metres above the waterline; instances scale x by length, z by beam. */
function buildBoatGeometry(): THREE.BufferGeometry {
  const s = new Soup();
  const c = (hex: number) => new THREE.Color(hex);
  const top = BOAT_HULL_HEIGHT;
  const roof = BOAT_HULL_HEIGHT + BOAT_CABIN_HEIGHT;
  s.box(-0.5, 0.5, -1, top, -0.5, 0.5, c(COLORS.hull), NO_EMIT, true, false);
  // Bow wedge cap so the hull reads as a boat, not a barge.
  s.box(0.42, 0.5, top, top + 0.25, -0.18, 0.18, c(COLORS.cabin));
  s.box(
    -0.36,
    0.14,
    top,
    roof,
    -0.32,
    0.32,
    c(COLORS.cabin),
    NO_EMIT,
    true,
    false,
  );
  const winEmit = emitOf(COLORS.window, EMISSIVE_WINDOW);
  for (let i = 0; i < 4; i++) {
    const x0 = -0.33 + i * 0.115;
    const x1 = x0 + 0.08;
    for (const z of [-0.325, 0.325]) {
      s.quad(
        [x0, top + 1.0, z],
        [x1, top + 1.0, z],
        [x1, top + 1.9, z],
        [x0, top + 1.9, z],
        c(COLORS.window),
        winEmit,
      );
    }
  }
  // Navigation lights: red to port (−z with the bow at +x), green to
  // starboard, white at the masthead and the stern.
  const nav = (x: number, y: number, z: number, hex: number) =>
    s.box(
      x - 0.02,
      x + 0.02,
      y - 0.12,
      y + 0.12,
      z - 0.04,
      z + 0.04,
      c(hex),
      emitOf(hex, EMISSIVE_NAVLIGHT),
    );
  nav(0.3, top + 0.3, -0.52, COLORS.port);
  nav(0.3, top + 0.3, 0.52, COLORS.starboard);
  nav(0.05, roof + 0.15, 0, COLORS.white);
  nav(-0.5, top + 0.3, 0, COLORS.white);
  return s.geometry();
}

/**
 * The reflection's skyline: per metre of river (x), the tallest building
 * standing in each bank's block row, plus a per-building hash that varies
 * the window pattern from one building to the next.
 * R = south bank height / 2, G = north bank height / 2, B/A = their hashes.
 */
export function bakeRiverSkyline(
  buildings: readonly Building[],
): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(SKY_TEX_WIDTH * 4);
  const south = RIVER_ROW - 1;
  const north = RIVER_ROW + 1;
  buildings.forEach((b, i) => {
    const row = Math.floor(b.z / BLOCK_PITCH);
    const channel = row === south ? 0 : row === north ? 1 : -1;
    if (channel < 0) return;
    const h = Math.min(255, Math.round(b.height / HEIGHT_SCALE));
    const hash = (Math.imul(i + 1, 2654435761) >>> 24) & 0xff;
    const x0 = Math.floor(b.x - b.width / 2);
    const x1 = Math.ceil(b.x + b.width / 2);
    for (let x = x0; x < x1; x++) {
      const t = (((x % SKY_TEX_WIDTH) + SKY_TEX_WIDTH) % SKY_TEX_WIDTH) * 4;
      if (h > (data[t + channel] ?? 0)) {
        data[t + channel] = h;
        data[t + 2 + channel] = hash;
      }
    }
  });
  return data;
}

const glsl = (v: number) => v.toFixed(4);
const NEON = `vec3[${SIGN_PALETTE.length}](${SIGN_PALETTE.map(
  (c) => `vec3(${glsl(c.r)}, ${glsl(c.g)}, ${glsl(c.b)})`,
).join(", ")})`;

/** Reflection peak gains — window bays and neon, before the luminance cap. */
const WINDOW_GAIN = "0.55";
const NEON_GAIN = "0.5";
/** Whole-water luminance cap: under the 0.72 bloom threshold. */
const WATER_LUMA_CAP = "0.6";

const WATER_VERTEX_PARS = /* glsl */ `
varying vec3 vRiverPos;
`;
const WATER_VERTEX_MAIN = /* glsl */ `
vRiverPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const WATER_FRAGMENT_PARS = /* glsl */ `
uniform vec2 uRiverShift; // canonical − render, x and z
uniform float uRiverTime;
uniform sampler2D uRiverSky;
varying vec3 vRiverPos;
float rvHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rvNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rvHash(i), rvHash(i + vec2(1.0, 0.0)), u.x),
             mix(rvHash(i + vec2(0.0, 1.0)), rvHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
const vec3 RV_NEON[${SIGN_PALETTE.length}] = ${NEON};
// What the mirrored ray from P along rd sees on the bank it heads for.
vec3 rvReflect(vec3 P, vec3 rd) {
  vec3 sky = vec3(0.10, 0.08, 0.20) * (1.0 - rd.y);
  if (abs(rd.z) < 1e-3) return sky;
  float side = rd.z > 0.0 ? 1.0 : -1.0;
  float zc = ${glsl(RIVER_CENTER_Z)} - uRiverShift.y;
  // The embankment wall first: under street level it is all the ray meets.
  float tw = (zc + side * ${glsl(RIVER_HALF_WIDTH)} - P.z) / rd.z;
  float yw = P.y + rd.y * tw;
  if (yw < 0.0) {
    float xw = P.x + rd.x * tw;
    float dl = abs(mod(xw + uRiverShift.x, ${glsl(WALL_LAMP_STEP)}) - ${glsl(WALL_LAMP_STEP / 2)});
    float lamp = exp(-dl * dl * 0.35) * exp(-pow(yw - (${glsl(WALL_LAMP_Y)}), 2.0) * 0.25);
    return vec3(0.03, 0.03, 0.04) + vec3(1.0, 0.62, 0.3) * lamp * 0.9;
  }
  // Then the bank's streetwall, at the far lot line.
  float tf = (zc + side * ${glsl(FACADE_OFF)} - P.z) / rd.z;
  vec3 hit = P + rd * tf;
  float h = hit.y;
  float xc = mod(hit.x + uRiverShift.x, ${glsl(WORLD_SIZE)});
  vec4 tex = texture2D(uRiverSky, vec2((floor(xc) + 0.5) / ${glsl(SKY_TEX_WIDTH)}, 0.5));
  float height = (side > 0.0 ? tex.g : tex.r) * ${glsl(255 * HEIGHT_SCALE)};
  float seed = (side > 0.0 ? tex.a : tex.b) * 255.0;
  if (h > height) return sky;
  // Window bays: 3.2 m wide, 3.6 m floors, about 40 % lit; far away (or
  // shredded by ripples) they average out instead of aliasing.
  vec2 g = vec2(xc / 3.2, h / 3.6);
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float inWin = step(0.18, f.x) * step(f.x, 0.82) * step(0.22, f.y) * step(f.y, 0.78);
  float lit = step(rvHash(cell + seed * 0.37), 0.4);
  vec3 tint = mix(vec3(1.0, 0.72, 0.42), vec3(0.62, 0.78, 1.0), step(0.65, rvHash(cell.yx + seed)));
  float aa = clamp(fwidth(g.x) * 1.5, 0.0, 1.0);
  vec3 win = mix(tint * inWin * lit, vec3(0.86, 0.74, 0.6) * 0.15, aa) * ${WINDOW_GAIN};
  // Street-level neon along the base of the streetwall.
  float seg = floor(xc / 22.0);
  float present = step(rvHash(vec2(seg, side * 3.1)), 0.55);
  int hue = int(floor(rvHash(vec2(seg * 1.7, side + 5.0)) * ${SIGN_PALETTE.length}.0));
  float band = step(4.0, h) * step(h, 8.5) * present;
  vec3 neon = RV_NEON[hue] * band * ${NEON_GAIN};
  return vec3(0.02, 0.02, 0.03) + win * step(9.0, h) + neon;
}
`;
const WATER_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
{
  vec2 rvC = vRiverPos.xz + uRiverShift;
  float rvDist = length(vRiverPos - cameraPosition);
  float rvNear = 1.0 - smoothstep(60.0, 500.0, rvDist);
  // Two octaves of drifting ripples tilt the water normal.
  vec2 rvR = vec2(rvNoise(rvC * 0.3 + vec2(uRiverTime * 0.5, 0.0)),
                  rvNoise(rvC * 0.3 + vec2(7.3, uRiverTime * 0.4))) - 0.5;
  rvR += 0.5 * (vec2(rvNoise(rvC * 1.4 - uRiverTime * 0.8),
                     rvNoise(rvC * 1.4 + 11.0 + uRiverTime * 0.6)) - 0.5);
  float rvAmp = 0.1 * (0.35 + 0.65 * rvNear);
  vec3 rvN = normalize(vec3(rvR.x * rvAmp, 1.0, rvR.y * rvAmp));
  vec3 rvV = normalize(vRiverPos - cameraPosition);
  vec3 rvRd = reflect(rvV, rvN);
  rvRd.y = max(rvRd.y, 0.002);
  float rvFres = 0.02 + 0.98 * pow(1.0 - max(dot(-rvV, rvN), 0.0), 5.0);
  totalEmissiveRadiance += rvReflect(vRiverPos, rvRd) * (0.3 + 0.7 * rvFres);
}
`;

/** The river renderer: structure, water, boats. */
export class RiverRenderer {
  readonly group = new THREE.Group();
  private readonly structure: THREE.Mesh;
  private readonly water: THREE.Mesh;
  private readonly boats: THREE.InstancedMesh;
  private readonly fleet: readonly Boat[];
  private readonly shift = new THREE.Vector2();
  private readonly time = { value: 0 };
  private readonly pose: BoatPose = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(seed: number, buildings: readonly Building[]) {
    this.structure = new THREE.Mesh(
      buildRiverStructure(),
      vertexEmissiveMaterial("ab-river-structure"),
    );
    this.structure.frustumCulled = false;

    const sky = new THREE.DataTexture(
      bakeRiverSkyline(buildings),
      SKY_TEX_WIDTH,
      1,
      THREE.RGBAFormat,
    );
    sky.magFilter = THREE.NearestFilter;
    sky.minFilter = THREE.NearestFilter;
    sky.wrapS = THREE.RepeatWrapping;
    sky.needsUpdate = true;
    const material = new THREE.MeshStandardMaterial({
      color: COLORS.water,
      roughness: 0.3,
      metalness: 0,
    });
    material.customProgramCacheKey = () => "ab-river-water";
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRiverShift = { value: this.shift };
      shader.uniforms.uRiverTime = this.time;
      shader.uniforms.uRiverSky = { value: sky };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${WATER_VERTEX_PARS}`)
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${WATER_VERTEX_MAIN}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\n${WATER_FRAGMENT_PARS}`,
        )
        .replace("#include <emissivemap_fragment>", WATER_EMISSIVE)
        .replace(
          "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
          `vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
outgoingLight *= min(1.0, ${WATER_LUMA_CAP} / max(luminance(outgoingLight), 1e-4));`,
        );
    };
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(WATER_LENGTH, 2 * RIVER_HALF_WIDTH),
      material,
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.frustumCulled = false;

    this.fleet = riverBoats(seed);
    this.boats = new THREE.InstancedMesh(
      buildBoatGeometry(),
      vertexEmissiveMaterial("ab-river-boats"),
      this.fleet.length,
    );
    this.boats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boats.frustumCulled = false;

    this.group.add(this.structure, this.water, this.boats);
  }

  /**
   * Place everything for this frame. `serverTimeMs` MUST be the clock the
   * crash check poses movers at (boats are solid movers): null hides them,
   * exactly as it makes them non-solid.
   */
  update(cameraPos: Vec3, serverTimeMs: number | null, nowMs: number): void {
    const dz = wrapDeltaAxis(cameraPos.z, RIVER_CENTER_Z);
    this.group.visible = Math.abs(dz) < HIDE_BEYOND;
    if (!this.group.visible) return;
    const renderZ = cameraPos.z + dz; // the channel centre's nearest image
    const zOff = renderZ - RIVER_CENTER_Z;

    // Two periods of structure, the camera in the middle one.
    this.structure.position.set(
      Math.floor((cameraPos.x - WORLD_SIZE / 2) / WORLD_SIZE) * WORLD_SIZE,
      0,
      zOff,
    );

    this.water.position.set(cameraPos.x, RIVER_WATER_Y, renderZ);
    this.shift.set(canonicalize(cameraPos).x - cameraPos.x, -zOff);
    // Ripples drift on local time: purely cosmetic, never shared state.
    this.time.value = (nowMs / 1000) % 1000;

    if (serverTimeMs === null) {
      this.boats.visible = false;
      return;
    }
    this.boats.visible = true;
    for (let i = 0; i < this.fleet.length; i++) {
      const boat = this.fleet[i] as Boat;
      boatPoseInto(boat, serverTimeMs, this.pose);
      const at = nearestImage(cameraPos, this.pose);
      this.q.setFromAxisAngle(RiverRenderer.UP, boat.dir === 1 ? 0 : Math.PI);
      this.p.set(at.x, this.pose.y, at.z);
      this.s.set(boat.length, 1, boat.beam);
      this.m.compose(this.p, this.q, this.s);
      this.boats.setMatrixAt(i, this.m);
    }
    this.boats.instanceMatrix.needsUpdate = true;
  }
}

// --- Ground-plane splice (sky.ts) --------------------------------------------
// The ground shader includes these so the river's paint lives with the river.

/** GLSL: true where the ground plane must not draw (the open channel, not a
 * bridge deck) — uses sky.ts's abLineDist. */
export const RIVER_GROUND_PARS = /* glsl */ `
bool abRiverOpen(vec2 w) {
  float off = abs(mod(w.y, ${glsl(WORLD_SIZE)}) - ${glsl(RIVER_CENTER_Z)});
  return off < ${glsl(RIVER_HALF_WIDTH)} && abs(abLineDist(w.x)) > ${glsl(BRIDGE_HALF_WIDTH)};
}
// The promenade: granite setts in 1.5 m courses, a darker kerb at the wall.
vec3 abPromenadePaint(vec2 w, float n, vec3 stone, vec3 joint) {
  float off = abs(mod(w.y, ${glsl(WORLD_SIZE)}) - ${glsl(RIVER_CENTER_Z)});
  vec3 c = stone * (1.0 + (n - 0.5) * 0.3);
  vec2 j = mod(vec2(w.x + 0.75 * floor(w.y / 1.5), w.y), vec2(3.0, 1.5));
  c = mix(c, joint, max(step(j.x, 0.08), step(j.y, 0.08)));
  if (off < ${glsl(RIVER_HALF_WIDTH + 1.2)}) c = joint;
  return c;
}
`;
