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

import { type Building, standingProfile } from "@angels-bandits/common/city";
import {
  ANCHOR_DZ,
  ANCHOR_Y,
  BOAT_CABIN_HEIGHT,
  BOAT_HULL_HEIGHT,
  BRIDGE_COUNT,
  BRIDGE_DECK_DEPTH,
  BRIDGE_HALF_WIDTH,
  BRIDGE_SPAN_HALF,
  type Boat,
  type BoatPose,
  GIRDER_X1,
  PARAPET_HEIGHT,
  PARAPET_THICKNESS,
  PYLON_DZ,
  PYLON_TIERS,
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
  RIVER_ROW,
  RIVER_WATER_Y,
  SADDLE_Y,
  SAG_Y,
  TRUSS_TOP,
  boatPoseInto,
  bridgeBoxes,
  landmarkAt,
  riverBoats,
} from "@angels-bandits/common/city/river";
import { LOT_LINE } from "@angels-bandits/common/city/street";
import { RIVER_MOUTHS } from "@angels-bandits/common/city/tunnels";
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
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import {
  REFLECTION_PARS_GLSL,
  REFL_RIVER_LOD,
  bindReflectionUniforms,
} from "./reflections";
import {
  RAIL_LAMP_STEP,
  STREAM_LOOP,
  emitLandmarks,
  emitPiers,
  emitRailLamps,
} from "./river-bridges";
import { SIGN_PALETTE } from "./signage";
import { StandingWatch } from "./standing-watch";
import { WEATHER_UNIFORM } from "./weather";
import { nearestImage } from "./wrapPlacement";

/** L4: the promenade lamp pools' peak glow (ground emissive, far under
 * the bloom threshold). */
const PROMENADE_POOL = 0.12;
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
  tugHull: 0x5a1c18,
  fender: 0x111214,
  strake: 0xb8b4aa,
  ferryCabin: 0x8f8e88,
  funnel: 0x141518,
  funnelBand: 0xd6802a,
  water: 0x03060c,
  lampWarm: 0xffb35c,
  fasciaLight: 0xffe2b0,
  window: 0xffcf8a,
  port: 0xff2a1e,
  starboard: 0x29ff6a,
  white: 0xffffff,
} as const;

const glsl = (v: number) => v.toFixed(4);

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
  /** D9: per vertex, the bridge (+1) whose breakable span it belongs to —
   * 0 for everything that never falls. Set before emitting a span's faces. */
  readonly spans: number[] = [];
  span = 0;
  /** L4: per vertex, a deck light stream's (phase, signed speed, bridge+1)
   * — all 0 for everything that does not flow (river-bridges.ts). */
  readonly streams: number[] = [];
  stream: [number, number, number] = [0, 0, 0];

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
      this.spans.push(this.span);
      this.streams.push(this.stream[0], this.stream[1], this.stream[2]);
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
    g.setAttribute("aSpan", new THREE.Float32BufferAttribute(this.spans, 1));
    g.setAttribute(
      "aStream",
      new THREE.Float32BufferAttribute(this.streams, 3),
    );
    g.computeVertexNormals();
    return g;
  }
}

/** D9: the fallen bridge spans (bit i = bridge i), shared by reference by
 * the river structure (which drops a fallen span's deck, parapets and
 * lights) and the ground plane (which stops painting its road) — set once
 * a frame from the room's props on the render clock. */
export const BRIDGE_GONE_UNIFORM = { value: 0 };

/**
 * L4: fog by the TRUE per-fragment distance. The fog chunks (fog.ts) carry
 * the eye distance as a per-vertex varying, which is exact on small faces
 * but not on the river's: the water is one 1800 m quad and a wall course a
 * single quad up to two worlds long, so their corners — and so every
 * interpolated pixel between them — read ~900 m and above, and the whole
 * channel drowned in fog colour (the flat lilac band). The fragment has its
 * world position, so the depth is recomputed there and the chunk reads it.
 */
function fogPerFragment(worldPos: string): string {
  return `float abRvFogDepth = length(${worldPos} - cameraPosition);
#define vFogDepth abRvFogDepth
#include <fog_fragment>
#undef vFogDepth`;
}

/** L4: the deck light streams' uniforms (river-bridges.ts), shared by
 * the structure material: the ripple clock and the dressing switch. */
interface StreamUniforms {
  time: { value: number };
  detail: { value: number };
}

/** Deck streams: collapsed nearer than this (traffic.ts's real cars read
 * there), full beyond STREAM_FULL, m. */
const STREAM_NEAR = 170;
const STREAM_FULL = 280;
/** Head- and taillight emissive of a stream streak (warm white toward the
 * viewer, red away): a hair under the window rung, so a far bridge's flow
 * glows without outshining the lamps. */
const STREAM_HEAD = emitOf(0xfff1d6, EMISSIVE_WINDOW);
const STREAM_TAIL = emitOf(0xff2a14, EMISSIVE_WINDOW * 0.8);
const vec3Of = (c: THREE.Color) =>
  `vec3(${glsl(c.r)}, ${glsl(c.g)}, ${glsl(c.b)})`;

/** Vertex colours lit as usual, plus a per-vertex emissive (`aEmit`) — and
 * (D9, `spans`) a fallen span's vertices dropped out of sight, and (L4,
 * `streams`) the deck light streams flowing along their decks. */
function vertexEmissiveMaterial(
  key: string,
  spans = false,
  streams: StreamUniforms | null = null,
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (shader) => {
    if (spans) shader.uniforms.uBridgeGone = BRIDGE_GONE_UNIFORM;
    if (streams) {
      shader.uniforms.uRiverTime = streams.time;
      shader.uniforms.uRiverDetail = streams.detail;
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\nattribute vec3 aEmit;\nvarying vec3 vEmit;${
          spans ? "\nattribute float aSpan;\nuniform int uBridgeGone;" : ""
        }${
          streams
            ? "\nattribute vec3 aStream;\nuniform float uRiverTime;\nuniform float uRiverDetail;\nvarying vec3 vRvWorld;"
            : ""
        }`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\nvEmit = aEmit;${
          spans
            ? "\nif (aSpan > 0.5 && ((uBridgeGone >> (int(aSpan + 0.5) - 1)) & 1) == 1) transformed.y -= 1.0e5;"
            : ""
        }${streams ? `${STREAM_VERTEX}\nvRvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;` : ""}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nvarying vec3 vEmit;${streams ? "\nvarying vec3 vRvWorld;" : ""}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmit;",
      );
    // The structure's long wall courses: fog per fragment (see above).
    if (streams) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <fog_fragment>",
        fogPerFragment("vRvWorld"),
      );
    }
  };
  return m;
}

/** L4 deck streams: slide each streak along its deck (a loop wall to
 * wall), light it by heading against the camera, and collapse it near the
 * camera, over a fallen span, or with the dressing off. */
const STREAM_VERTEX = /* glsl */ `
if (aStream.z > 0.5) {
  float stZ = mod(aStream.x + aStream.y * uRiverTime, ${glsl(STREAM_LOOP)}) - ${glsl(STREAM_LOOP / 2)};
  transformed.z += stZ;
  vec3 stW = (modelMatrix * vec4(transformed, 1.0)).xyz;
  float stF = smoothstep(${glsl(STREAM_NEAR)}, ${glsl(STREAM_FULL)}, distance(stW, cameraPosition)) * uRiverDetail;
  int stK = int(aStream.z + 0.5) - 1;
  bool stGone = ((uBridgeGone >> stK) & 1) == 1 && abs(stZ) < ${glsl(BRIDGE_SPAN_HALF + 3)};
  // Flowing toward the camera: headlights; away: taillights.
  float stToward = step(0.0, sign(aStream.y) * (cameraPosition.z - stW.z));
  vEmit = mix(${vec3Of(STREAM_TAIL)}, ${vec3Of(STREAM_HEAD)}, stToward) * stF;
  if (stF < 0.002 || stGone) transformed.y -= 1.0e5;
}
`;

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
    // U4: the river mouths are holes in the wall, water to lintel. Over a
    // mouth only the lintel course stands; elsewhere the full wall.
    const mouths = riverWallOpenings(side);
    const course = (y0: number, y1: number, color: THREE.Color) => {
      for (const [x0, x1, yb] of wallRuns(span, mouths, y0, y1)) {
        s.quad([x0, yb, z], [x1, yb, z], [x1, y1, z], [x0, y1, z], color);
      }
    };
    // The wall in three courses: a slimy waterline, dressed stone, a coping.
    course(water, -21, c(COLORS.slime));
    course(-21, -0.6, c(COLORS.stone));
    course(-0.6, 0, c(COLORS.coping));
    // Wall lamps just proud of the face, facing the water — none over a
    // mouth (its own frame lights it).
    const zl = z - side * 0.06;
    for (let x = WALL_LAMP_STEP / 2; x < span; x += WALL_LAMP_STEP) {
      if (mouths.some((m) => x > m.x0 - 1 && x < m.x1 + 1)) continue;
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
    // L4: the promenade's lamps, flush in the railing's top.
    emitRailLamps(s, span, r0, r0 + PARAPET_THICKNESS);
  }

  // Bridges: the shared boxes, repeated for the second period — each cut
  // into its two end pieces and the D9 breakable span between them (its
  // vertices tagged, so a fallen span drops out of the mesh).
  for (const period of [0, WORLD_SIZE]) {
    for (const b of bridgeBoxes()) {
      const bridge =
        ((Math.round(b.x / BLOCK_PITCH) % BRIDGE_COUNT) + BRIDGE_COUNT) %
        BRIDGE_COUNT;
      const x0 = period + b.x - b.hx;
      const x1 = period + b.x + b.hx;
      const zs = [
        b.z - b.hz,
        zc - BRIDGE_SPAN_HALF,
        zc + BRIDGE_SPAN_HALF,
        b.z + b.hz,
      ];
      for (let piece = 0; piece < 3; piece++) {
        s.span = piece === 1 ? bridge + 1 : 0;
        const z0 = zs[piece] as number;
        const z1 = zs[piece + 1] as number;
        if (b.y1 > 0) {
          s.box(
            x0,
            x1,
            b.y0,
            b.y1,
            z0,
            z1,
            c(COLORS.rail),
            NO_EMIT,
            true,
            false,
          );
          continue;
        }
        // Deck: fascia on both long sides, the soffit below. No top face —
        // the ground plane paints the road there.
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
        // The broken edge a fallen span leaves (inside the deck while it
        // stands, so never seen then).
        if (piece !== 1) {
          s.span = 0;
          const ze = piece === 0 ? z1 : z0;
          s.quad(
            [x0, b.y0, ze],
            [x1, b.y0, ze],
            [x1, b.y1, ze],
            [x0, b.y1, ze],
            c(COLORS.soffit),
          );
        }
        s.span = piece === 1 ? bridge + 1 : 0;
        // A string of fascia lights along each edge — the cue that says
        // "you can fly under this" from down the channel.
        const y = -BRIDGE_DECK_DEPTH * 0.55;
        const first = b.z - b.hz + FASCIA_STEP / 2;
        // L4: a landmark's girder stands proud of the deck — its string
        // hangs on the girder's outer face instead.
        const reach = landmarkAt(bridge) ? GIRDER_X1 : b.hx;
        const xs = [period + b.x - reach - 0.06, period + b.x + reach + 0.06];
        for (let z = first; z < b.z + b.hz; z += FASCIA_STEP) {
          if (z < z0 || z >= z1) continue;
          for (const x of xs) {
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
      s.span = 0;
    }
    // L4: the landmark bridges and the piers.
    emitLandmarks(s, period);
    emitPiers(s, period);
  }
  return s.geometry();
}

/** A U4 mouth in one embankment wall: its x range (both world periods) and
 * the height its opening reaches. */
interface WallOpening {
  x0: number;
  x1: number;
  y1: number;
}

/** The mouths in wall `side` (−1: low z, +1: high z), for both periods. */
function riverWallOpenings(side: number): WallOpening[] {
  const out: WallOpening[] = [];
  for (const m of RIVER_MOUTHS) {
    if (m.side !== side) continue;
    for (const period of [0, WORLD_SIZE]) {
      out.push({ x0: period + m.x0, x1: period + m.x1, y1: m.y1 });
    }
  }
  return out;
}

/** The runs [x0, x1, bottom] of a wall course [y0, y1] over 0…span: the
 * course minus every opening it reaches into (an opening spans the water up
 * to its y1), plus the strip of it left above each opening (the lintel). */
function wallRuns(
  span: number,
  openings: readonly WallOpening[],
  y0: number,
  y1: number,
): [number, number, number][] {
  const cuts = openings
    .filter((o) => y0 < o.y1)
    .map((o) => [o.x0, o.x1] as const)
    .sort((a, b) => a[0] - b[0]);
  const runs: [number, number, number][] = [];
  let x = 0;
  for (const [a, b] of cuts) {
    if (a > x) runs.push([x, a, y0]);
    x = Math.max(x, b);
  }
  if (x < span) runs.push([x, span, y0]);
  for (const o of openings) {
    if (y0 < o.y1 && y1 > o.y1) runs.push([o.x0, o.x1, o.y1]);
  }
  return runs;
}

/** L4: a hull this long or longer is drawn as a ferry, shorter as a tug —
 * both exactly the shared boat box (common boatBoxInto). */
export const FERRY_MIN_LENGTH = 24;

/** One boat at unit length and beam (x along the hull, bow at +x). Heights
 * are metres above the waterline; instances scale x by length, z by beam.
 * L4: a `ferry` is a long, low saloon glazed end to end; a `tug` a dark red
 * hull, a tall wheelhouse forward and a banded funnel. Both stay inside the
 * hull box up to the cabin roof, their lights a hair proud of it. */
function buildBoatGeometry(kind: "ferry" | "tug"): THREE.BufferGeometry {
  const s = new Soup();
  const c = (hex: number) => new THREE.Color(hex);
  const top = BOAT_HULL_HEIGHT;
  const roof = BOAT_HULL_HEIGHT + BOAT_CABIN_HEIGHT;
  const ferry = kind === "ferry";
  const hull = ferry ? COLORS.hull : COLORS.tugHull;
  s.box(-0.5, 0.5, -1, top, -0.5, 0.5, c(hull), NO_EMIT, true, false);
  // A pale rubbing strake along the hull, and the bow wedge cap.
  s.box(
    -0.5,
    0.5,
    top - 0.45,
    top - 0.25,
    -0.505,
    0.505,
    c(ferry ? COLORS.strake : COLORS.fender),
  );
  s.box(0.42, 0.5, top, top + 0.25, -0.18, 0.18, c(COLORS.cabin));
  const winEmit = emitOf(COLORS.window, EMISSIVE_WINDOW);
  const windows = (
    x0: number,
    x1: number,
    n: number,
    zs: number,
    y0: number,
    y1: number,
  ) => {
    const w = (x1 - x0) / n;
    for (let i = 0; i < n; i++) {
      const a = x0 + i * w + w * 0.18;
      const b = x0 + (i + 1) * w - w * 0.18;
      for (const z of [-zs, zs]) {
        s.quad(
          [a, y0, z],
          [b, y0, z],
          [b, y1, z],
          [a, y1, z],
          c(COLORS.window),
          winEmit,
        );
      }
    }
  };
  if (ferry) {
    // The saloon, nearly the whole length, glazed in one long band.
    s.box(
      -0.42,
      0.34,
      top,
      roof,
      -0.4,
      0.4,
      c(COLORS.ferryCabin),
      NO_EMIT,
      true,
      false,
    );
    windows(-0.4, 0.32, 12, 0.405, top + 0.7, top + 1.9);
    // The wheelhouse's front glass.
    s.quad(
      [0.345, top + 1.2, -0.3],
      [0.345, top + 1.2, 0.3],
      [0.345, top + 2.1, 0.3],
      [0.345, top + 2.1, -0.3],
      c(COLORS.window),
      winEmit,
    );
  } else {
    // The wheelhouse forward, tall; the funnel aft.
    s.box(
      -0.02,
      0.26,
      top,
      roof,
      -0.3,
      0.3,
      c(COLORS.cabin),
      NO_EMIT,
      true,
      false,
    );
    windows(0.0, 0.24, 2, 0.305, top + 1.4, top + 2.2);
    s.quad(
      [0.265, top + 1.4, -0.24],
      [0.265, top + 1.4, 0.24],
      [0.265, top + 2.2, 0.24],
      [0.265, top + 2.2, -0.24],
      c(COLORS.window),
      winEmit,
    );
    s.box(-0.3, -0.14, top, roof - 0.4, -0.12, 0.12, c(COLORS.funnel));
    s.box(
      -0.305,
      -0.135,
      roof - 1.2,
      roof - 0.85,
      -0.125,
      0.125,
      c(COLORS.funnelBand),
    );
  }
  // Navigation lights: red to port (−z with the bow at +x), green to
  // starboard, white at the masthead and the stern — a tug carries two
  // masthead lights, one over the other.
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
  nav(ferry ? 0.2 : 0.12, roof + 0.15, 0, COLORS.white);
  if (!ferry) nav(0.12, roof - 0.35, 0.31, COLORS.white);
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
    // D8: the height that STANDS — a felled bank tower leaves no lit ghost
    // of itself in the water.
    const top = b.damage ? standingProfile(b).top : b.height;
    const h = Math.min(255, Math.round(top / HEIGHT_SCALE));
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

const NEON = `vec3[${SIGN_PALETTE.length}](${SIGN_PALETTE.map(
  (c) => `vec3(${glsl(c.r)}, ${glsl(c.g)}, ${glsl(c.b)})`,
).join(", ")})`;

/** Reflection peak gains — window bays and neon, before the luminance cap. */
const WINDOW_GAIN = "0.55";
const NEON_GAIN = "0.5";
/** L4: how much of the sky (the fake and the probe's) the water mirrors. */
const WATER_SKY_GAIN = "0.45";
/** Whole-water luminance cap: under the 0.72 bloom threshold. */
const WATER_LUMA_CAP = "0.6";

const WATER_VERTEX_PARS = /* glsl */ `
varying vec3 vRiverPos;
`;
const WATER_VERTEX_MAIN = /* glsl */ `
vRiverPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
/** L4: the landmark kind each bridge index carries (0 plain, 1
 * suspension, 2 truss), as a GLSL lookup. */
const RV_KIND = Array.from({ length: BRIDGE_COUNT }, (_, i) => {
  const lm = landmarkAt(i);
  return lm
    ? `  if (k == ${i}) return ${lm.kind === "suspension" ? 1 : 2};\n`
    : "";
}).join("");

/** L4 water: boats whose wakes and light streaks the shader draws (the
 * nearest to the camera), and its streak taps' vertical spread. */
export const WATER_BOATS = 4;

const WATER_FRAGMENT_PARS = /* glsl */ `${REFLECTION_PARS_GLSL}
uniform vec2 uRiverShift; // canonical − render, x and z
uniform float uRiverTime;
uniform sampler2D uRiverSky;
// L4: the fallen spans (D9), the sky's live moon, the weather, the
// dressing switch, and the nearest boats (render x, z, ±half length along
// its heading, half beam; w = 0: no boat).
uniform int uBridgeGone;
uniform vec3 uRiverMoon;
uniform float uRiverMoonVis;
uniform vec4 uWeather;
uniform float uRiverDetail;
uniform vec4 uRiverBoats[${WATER_BOATS}];
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
int rvKind(int k) {
${RV_KIND}  return 0;
}
// The main cable's height |dz| = a off the centreline (common cableY).
float rvCableY(float a) {
  if (a <= ${glsl(PYLON_DZ)}) {
    float u = a / ${glsl(PYLON_DZ)};
    return ${glsl(SAG_Y)} + ${glsl(SADDLE_Y - SAG_Y)} * u * u;
  }
  return mix(${glsl(SADDLE_Y)}, ${glsl(ANCHOR_Y)}, clamp((a - ${glsl(PYLON_DZ)}) / ${glsl(ANCHOR_DZ - PYLON_DZ)}, 0.0, 1.0));
}
// What the mirrored ray from P along rd meets on the bank it heads for:
// rgb, and in a the distance to that bank.
vec4 rvBank(vec3 P, vec3 rd, vec3 sky, float blur) {
  if (abs(rd.z) < 1e-3) return vec4(sky, 1.0e9);
  float side = rd.z > 0.0 ? 1.0 : -1.0;
  float zc = ${glsl(RIVER_CENTER_Z)} - uRiverShift.y;
  // The embankment wall first: under street level it is all the ray meets.
  float tw = (zc + side * ${glsl(RIVER_HALF_WIDTH)} - P.z) / rd.z;
  float yw = P.y + rd.y * tw;
  if (yw < 0.0) {
    float xw = P.x + rd.x * tw;
    float dl = abs(mod(xw + uRiverShift.x, ${glsl(WALL_LAMP_STEP)}) - ${glsl(WALL_LAMP_STEP / 2)});
    // O7: yw - WALL_LAMP_Y is negative below the lamp row, and pow() of a
    // negative base is undefined (NaN on fast-math GPUs): squared instead.
    float dy = yw - (${glsl(WALL_LAMP_Y)});
    float lamp = exp(-dl * dl * 0.35) * exp(-dy * dy * 0.25);
    return vec4(vec3(0.03, 0.03, 0.04) + vec3(1.0, 0.62, 0.3) * lamp * 0.9, tw);
  }
  // Then the bank's streetwall, at the far lot line.
  float tf = (zc + side * ${glsl(FACADE_OFF)} - P.z) / rd.z;
  vec3 hit = P + rd * tf;
  float h = hit.y;
  float xc = mod(hit.x + uRiverShift.x, ${glsl(WORLD_SIZE)});
  vec4 tex = texture2D(uRiverSky, vec2((floor(xc) + 0.5) / ${glsl(SKY_TEX_WIDTH)}, 0.5));
  float height = (side > 0.0 ? tex.g : tex.r) * ${glsl(255 * HEIGHT_SCALE)};
  float seed = (side > 0.0 ? tex.a : tex.b) * 255.0;
  if (h > height) return vec4(sky, tf);
  // Window bays: 3.2 m wide, 3.6 m floors, about 40 % lit; far away (or
  // shredded by ripples) they average out instead of aliasing.
  vec2 g = vec2(xc / 3.2, h / 3.6);
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float inWin = step(0.18, f.x) * step(f.x, 0.82) * step(0.22, f.y) * step(f.y, 0.78);
  float lit = step(rvHash(cell + seed * 0.37), 0.4);
  vec3 tint = mix(vec3(1.0, 0.72, 0.42), vec3(0.62, 0.78, 1.0), step(0.65, rvHash(cell.yx + seed)));
  // L4: and where the ripples swing the ray from pixel to pixel (blur,
  // measured at top level by the caller), the lit average — a smooth
  // streak, not a speckle of individual panes.
  float aa = max(clamp(fwidth(g.x) * 1.5, 0.0, 1.0), blur);
  vec3 win = mix(tint * inWin * lit, vec3(0.86, 0.74, 0.6) * 0.17, aa) * ${WINDOW_GAIN};
  // Street-level neon along the base of the streetwall.
  float seg = floor(xc / 22.0);
  float present = step(rvHash(vec2(seg, side * 3.1)), 0.55);
  int hue = int(floor(rvHash(vec2(seg * 1.7, side + 5.0)) * ${SIGN_PALETTE.length}.0));
  float band = step(4.0, h) * step(h, 8.5) * present;
  vec3 neon = RV_NEON[hue] * band * ${NEON_GAIN};
  return vec4(vec3(0.02, 0.02, 0.03) + win * step(9.0, h) + neon, tf);
}
// L4: the bridges the mirrored ray crosses before that bank — up to four
// street lines ahead of it (the fog is four blocks off). A deck or a pylon
// stops it (a = 1); the landmarks' cable necklaces and truss chords only
// add their glow on the way through.
vec4 rvBridges(vec3 P, vec3 rd, float tBank) {
  vec3 g = vec3(0.0);
  if (abs(rd.x) < 0.03) return vec4(0.0);
  float xc = P.x + uRiverShift.x;
  float zc = ${glsl(RIVER_CENTER_Z)} - uRiverShift.y;
  float dirx = rd.x > 0.0 ? 1.0 : -1.0;
  float l0 = dirx > 0.0 ? ceil(xc / ${glsl(BLOCK_PITCH)}) : floor(xc / ${glsl(BLOCK_PITCH)});
  for (int i = 0; i < 4; i++) {
    float l = l0 + dirx * float(i);
    float t = (l * ${glsl(BLOCK_PITCH)} - xc) / rd.x;
    if (t > tBank) break;
    vec3 h = P + rd * t;
    float az = abs(h.z - zc);
    int k = int(mod(l, ${glsl(BRIDGE_COUNT)}) + 0.5);
    if (k >= ${BRIDGE_COUNT}) k -= ${BRIDGE_COUNT};
    bool gone = ((uBridgeGone >> k) & 1) == 1 && az < ${glsl(BRIDGE_SPAN_HALF)};
    int kind = rvKind(k);
    if (az < ${glsl(RIVER_HALF_WIDTH)} && !gone && h.y < 0.0 && h.y > ${glsl(-BRIDGE_DECK_DEPTH)}) {
      // The deck's edge: dark steel and its string of fascia lights.
      float dy = h.y + ${glsl(BRIDGE_DECK_DEPTH * 0.55)};
      float lamp = exp(-dy * dy * 6.0) * (0.6 + 0.4 * cos(h.z * 0.785));
      return vec4(g + vec3(0.025, 0.025, 0.035) + vec3(1.0, 0.86, 0.62) * lamp * 0.7, 1.0);
    }
    if (kind == 1) {
      if (abs(az - ${glsl(PYLON_DZ)}) < 3.0 && h.y < ${glsl(PYLON_TIERS[2])}) {
        // A floodlit pylon: warm at its foot, darker up the shaft.
        float fl = 0.05 + 0.1 * (1.0 - clamp((h.y - ${glsl(RIVER_WATER_Y)}) / 66.0, 0.0, 1.0));
        return vec4(g + vec3(1.0, 0.7, 0.45) * fl, 1.0);
      }
      if (az < ${glsl(ANCHOR_DZ)} && h.y > 0.0) {
        float dy = h.y - rvCableY(az);
        g += vec3(1.0, 0.86, 0.62) * exp(-dy * dy * 1.2) * 0.55;
      }
    } else if (kind == 2 && !gone && az < ${glsl(RIVER_HALF_WIDTH)} && h.y > 0.0 && h.y < 16.0) {
      float dy = h.y - ${glsl(TRUSS_TOP)};
      g += vec3(1.0, 0.8, 0.55) * exp(-dy * dy * 1.5) * 0.5 + vec3(0.04, 0.03, 0.02);
    }
  }
  return vec4(g, 0.0);
}
// What the mirrored ray from P along rd sees: the bridges, then the bank.
vec3 rvReflect(vec3 P, vec3 rd, float blur) {
  vec3 sky = vec3(0.045, 0.045, 0.09) * (1.0 - rd.y);
  // S6: where the ray clears the bank, the reflection probe (reflections.ts)
  // supplies what is really up there — the moon, the sky and the taller
  // towers behind the streetwall. The traced wall and streetwall stay the
  // authority below it, so no silhouette is drawn twice; near the horizon,
  // where a camera-centred probe disagrees with the water, the fake stays.
  if (uReflOn > 0.5) {
    sky = mix(sky, abRefl(rd, ${glsl(REFL_RIVER_LOD)}), abReflElev(rd));
  }
  // L4: the night sky mirrors dim — the water reads dark and glossy, and
  // the lights in it (windows, lamps, bridges, the moon) carry it.
  sky *= ${WATER_SKY_GAIN};
  vec4 bank = rvBank(P, rd, sky, blur);
  vec4 br = rvBridges(P, rd, bank.a);
  return br.a > 0.5 ? br.rgb : bank.rgb + br.rgb;
}
`;
// L4: the surface. Ripples are ANISOTROPIC — fine along the view's
// heading, broad across it — so the mirrored ray's elevation jitters far
// more than its azimuth and every light stretches into a long vertical
// streak, as on real water at night; a second tap a little higher up the
// column fills the streak's body. A slow swell rolls under it, rain rings
// pock it while it rains (near only), the moon lays its own column, and the
// nearest boats leave wakes and drop their lit cabins' streaks in it.
const WATER_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
{
  vec2 rvC = vRiverPos.xz + uRiverShift;
  vec3 rvToP = vRiverPos - cameraPosition;
  float rvDist = length(rvToP);
  vec3 rvV = rvToP / max(rvDist, 1e-3);
  float rvNear = 1.0 - smoothstep(60.0, 500.0, rvDist);
  float rvT = uRiverTime;
  // The view's heading on the water (along) and its right hand (across).
  vec2 rvF = rvV.xz / max(length(rvV.xz), 1e-4);
  vec2 rvS = vec2(-rvF.y, rvF.x);
  float rvQa = dot(rvC, rvF);
  float rvQs = dot(rvC, rvS);
  // Each octave fades out where a pixel spans more than its wavelength,
  // so the far water averages instead of sparkling.
  float rvFw = fwidth(rvQa);
  float rvA1 = rvNoise(vec2(rvQa * 0.6 + rvT * 0.9, rvQs * 0.07)) - 0.5;
  float rvA2 = rvNoise(vec2(rvQa * 1.9 - rvT * 1.4, rvQs * 0.18 + 5.3)) - 0.5;
  float rvAlong = rvA1 * (1.0 - smoothstep(0.5, 1.4, rvFw * 0.6))
                + 0.6 * rvA2 * (1.0 - smoothstep(0.5, 1.4, rvFw * 1.9));
  float rvAcross = rvNoise(vec2(rvQs * 0.4 + rvT * 0.3, rvQa * 0.3 + 2.0)) - 0.5;
  vec2 rvSwell = 0.02 * vec2(sin(dot(rvC, vec2(0.031, 0.013)) + rvT * 0.55),
                             sin(dot(rvC, vec2(-0.012, 0.029)) - rvT * 0.43));
  vec2 rvTilt = rvF * rvAlong * mix(0.07, 0.16, rvNear)
              + rvS * rvAcross * 0.02 * (0.4 + 0.6 * rvNear) + rvSwell;
  // Rain rings: one per 1.4 m cell, expanding and fading, near only.
  float rvRain = uWeather.y * uRiverDetail * (1.0 - smoothstep(20.0, 80.0, rvDist));
  if (rvRain > 0.001) {
    vec2 rvG = rvC * 0.7;
    vec2 rvCi = floor(rvG);
    vec2 rvCf = fract(rvG) - 0.5 - (vec2(rvHash(rvCi + 3.1), rvHash(rvCi + 7.7)) - 0.5) * 0.4;
    float rvAge = fract(rvT * 1.1 + rvHash(rvCi));
    float rvRr = length(rvCf);
    float rvW = (rvRr - rvAge * 0.45) * 16.0;
    float rvRing = exp(-rvW * rvW) * (1.0 - rvAge);
    rvTilt += rvCf / max(rvRr, 1e-3) * rvRing * 0.25 * rvRain;
  }
  vec3 rvN = normalize(vec3(rvTilt.x, 1.0, rvTilt.y));
  vec3 rvRd = reflect(rvV, rvN);
  rvRd.y = max(rvRd.y, 0.002);
  // O7: the dot of two unit vectors can round past 1 — a negative pow base.
  float rvFres = 0.02 + 0.98 * pow(1.0 - clamp(dot(-rvV, rvN), 0.0, 1.0), 5.0);
  vec3 rvRd2 = normalize(vec3(rvRd.x, rvRd.y + 0.04 + 0.03 * rvAcross, rvRd.z));
  // How fast the mirrored ray swings across a pixel: past ~1/40 rad the
  // window bays it would pick are noise, and the bank reads averaged.
  float rvBlur = clamp((length(fwidth(rvRd)) - 0.01) * 40.0, 0.0, 1.0);
  vec3 rvRefl = 0.5 * (rvReflect(vRiverPos, rvRd, rvBlur) + rvReflect(vRiverPos, rvRd2, rvBlur));
  // The moon's column: tight in azimuth, long in elevation.
  vec2 rvMh = uRiverMoon.xz / max(length(uRiverMoon.xz), 1e-4);
  vec2 rvRh = rvRd.xz / max(length(rvRd.xz), 1e-4);
  float rvMaz = 1.0 - dot(rvRh, rvMh);
  float rvMel = rvRd.y - uRiverMoon.y;
  float rvMoon = exp(-rvMaz * 2500.0) * exp(-rvMel * rvMel * 40.0)
               * step(0.0, uRiverMoon.y) * uRiverMoonVis;
  rvRefl += vec3(0.78, 0.82, 0.95) * rvMoon * 0.9;
  totalEmissiveRadiance += rvRefl * (0.3 + 0.7 * rvFres);
  if (uRiverDetail > 0.5) {
    for (int i = 0; i < ${WATER_BOATS}; i++) {
      vec4 rvB = uRiverBoats[i];
      if (rvB.w <= 0.0) continue;
      vec2 rvD = vRiverPos.xz - rvB.xy;
      float rvHl = abs(rvB.z);
      // The wake: a widening V of foam behind the stern, a churned centre.
      float rvBack = -rvD.x * sign(rvB.z) - rvHl;
      if (rvBack > 0.0 && rvBack < 80.0) {
        float rvE = abs(rvD.y) - (rvB.w + rvBack * 0.22);
        float rvFoam = exp(-rvE * rvE * 0.6) * (1.0 - rvBack / 80.0)
                     + exp(-rvD.y * rvD.y / (rvB.w * rvB.w)) * max(0.0, 1.0 - rvBack / 30.0);
        rvFoam *= 0.6 + 0.4 * rvNoise(vec2(rvBack * 0.8 - rvT * 2.0, rvD.y * 0.9));
        totalEmissiveRadiance += vec3(0.05, 0.055, 0.06) * rvFoam;
      }
      // Its lit cabin mirrored: where the eye's line to the cabin's image
      // (3 m under the water) meets it, smeared toward the eye.
      float rvIy = ${glsl(RIVER_WATER_Y - 3)};
      float rvS0 = (cameraPosition.y - ${glsl(RIVER_WATER_Y)}) / max(cameraPosition.y - rvIy, 1e-3);
      vec2 rvPm = cameraPosition.xz + (rvB.xy - cameraPosition.xz) * rvS0;
      vec2 rvDm = vRiverPos.xz - rvPm;
      float rvAc = abs(dot(rvDm, rvS)) - rvHl * abs(rvS.x) - rvB.w * abs(rvS.y);
      rvAc = max(rvAc, 0.0);
      float rvAl = dot(rvDm, rvF);
      float rvLit = exp(-rvAc * rvAc * 0.4) * exp(-rvAl * rvAl * 0.004);
      totalEmissiveRadiance += vec3(1.0, 0.72, 0.42) * rvLit * 0.22 * (0.5 + rvFres);
    }
  }
}
`;

/** The sky dome's live moon (sky.ts SkyDome), shared by reference so the
 * water's moon column follows the L12 cycle — river.ts must not import
 * sky.ts (sky.ts imports this module). */
export interface MoonUniforms {
  dir: { value: THREE.Vector3 };
  vis: { value: number };
}

/** The river renderer: structure (with the L4 landmark bridges and piers),
 * water, and the boats — tugs and (L4) ferries, one instanced draw each. */
export class RiverRenderer {
  readonly group = new THREE.Group();
  private readonly structure: THREE.Mesh;
  private readonly water: THREE.Mesh;
  private readonly boats: THREE.InstancedMesh;
  private readonly ferries: THREE.InstancedMesh;
  private readonly fleet: readonly Boat[];
  /** Per boat: its slot in the ferry (≥ 0) or tug (< 0: ~slot) mesh. */
  private readonly slot: readonly number[];
  private readonly shift = new THREE.Vector2();
  private readonly time = { value: 0 };
  /** L4: the quality tier's dressing switch (streams, wakes, rain rings). */
  private readonly detail = { value: 1 };
  /** L4: the nearest boats for the water (render x, z, ±half length, half
   * beam), and per-boat scratch for picking them. */
  private readonly boatUniform = Array.from(
    { length: WATER_BOATS },
    () => new THREE.Vector4(),
  );
  private readonly boatAt: THREE.Vector4[];
  private readonly boatDist: number[];
  private readonly pose: BoatPose = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  /** D8: the skyline is re-baked when a bank building breaks or is rebuilt. */
  private readonly sky: THREE.DataTexture;
  private readonly watch: StandingWatch;
  private readonly bank: Uint8Array;
  private skyDirty = false;

  constructor(
    seed: number,
    private readonly buildings: readonly Building[],
    moon: MoonUniforms,
  ) {
    this.watch = new StandingWatch(buildings);
    this.bank = Uint8Array.from(buildings, (b) => {
      const row = Math.floor(b.z / BLOCK_PITCH);
      return row === RIVER_ROW - 1 || row === RIVER_ROW + 1 ? 1 : 0;
    });
    this.structure = new THREE.Mesh(
      buildRiverStructure(),
      vertexEmissiveMaterial("ab-river-structure-l4", true, {
        time: this.time,
        detail: this.detail,
      }),
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
    this.sky = sky;
    const material = new THREE.MeshStandardMaterial({
      color: COLORS.water,
      // Rough on purpose: the reflection is the faked one below. A smooth
      // material adds the real moon's specular as a wide white smear on top.
      roughness: 0.9,
      metalness: 0,
    });
    material.customProgramCacheKey = () => "ab-river-water-s6-refl";
    // (Its fog is per fragment too: fogPerFragment, below.)
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRiverShift = { value: this.shift };
      shader.uniforms.uRiverTime = this.time;
      shader.uniforms.uRiverSky = { value: sky };
      // L4: D9's fallen spans, the live moon, the weather, the dressing
      // switch and the nearest boats — all by reference.
      shader.uniforms.uBridgeGone = BRIDGE_GONE_UNIFORM;
      shader.uniforms.uRiverMoon = moon.dir;
      shader.uniforms.uRiverMoonVis = moon.vis;
      shader.uniforms.uWeather = WEATHER_UNIFORM;
      shader.uniforms.uRiverDetail = this.detail;
      shader.uniforms.uRiverBoats = { value: this.boatUniform };
      // S6: the reflection probe, by reference (the sky over the bank).
      bindReflectionUniforms(shader.uniforms);
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
        .replace("#include <fog_fragment>", fogPerFragment("vRiverPos"))
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
    let ferries = 0;
    let tugs = 0;
    this.slot = this.fleet.map((b) =>
      b.length >= FERRY_MIN_LENGTH ? ferries++ : ~tugs++,
    );
    this.boatAt = this.fleet.map(() => new THREE.Vector4());
    this.boatDist = this.fleet.map(() => 0);
    const boatMesh = (kind: "ferry" | "tug", count: number) => {
      const mesh = new THREE.InstancedMesh(
        buildBoatGeometry(kind),
        vertexEmissiveMaterial("ab-river-boats"),
        Math.max(1, count),
      );
      mesh.count = count;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      return mesh;
    };
    this.boats = boatMesh("tug", tugs);
    this.ferries = boatMesh("ferry", ferries);

    this.group.add(this.structure, this.water, this.boats, this.ferries);
  }

  /** L4: the tier's river dressing — the deck streams, the boats' wakes
   * and light streaks, the rain rings. A uniform only (quality rule 1); the
   * bridges, piers and boats themselves are the same on every tier. */
  setQuality(tier: QualityTier): void {
    this.detail.value = QUALITY_PROFILES[tier].riverDetail ? 1 : 0;
  }

  private readonly markSky = (i: number): void => {
    if (this.bank[i]) this.skyDirty = true;
  };

  /**
   * Place everything for this frame. `serverTimeMs` MUST be the clock the
   * crash check poses movers at (boats are solid movers): null hides them,
   * exactly as it makes them non-solid.
   */
  update(cameraPos: Vec3, serverTimeMs: number | null, nowMs: number): void {
    this.watch.poll(this.markSky);
    if (this.skyDirty) {
      this.skyDirty = false;
      (this.sky.image.data as Uint8Array).set(bakeRiverSkyline(this.buildings));
      this.sky.needsUpdate = true;
    }
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
      this.ferries.visible = false;
      for (const u of this.boatUniform) u.set(0, 0, 0, 0);
      return;
    }
    this.boats.visible = true;
    this.ferries.visible = true;
    for (let i = 0; i < this.fleet.length; i++) {
      const boat = this.fleet[i] as Boat;
      boatPoseInto(boat, serverTimeMs, this.pose);
      const at = nearestImage(cameraPos, this.pose);
      this.q.setFromAxisAngle(RiverRenderer.UP, boat.dir === 1 ? 0 : Math.PI);
      this.p.set(at.x, this.pose.y, at.z);
      this.s.set(boat.length, 1, boat.beam);
      this.m.compose(this.p, this.q, this.s);
      const slot = this.slot[i] as number;
      if (slot >= 0) this.ferries.setMatrixAt(slot, this.m);
      else this.boats.setMatrixAt(~slot, this.m);
      (this.boatAt[i] as THREE.Vector4).set(
        at.x,
        at.z,
        (boat.dir * boat.length) / 2,
        boat.beam / 2,
      );
      this.boatDist[i] = Math.hypot(at.x - cameraPos.x, at.z - cameraPos.z);
    }
    this.boats.instanceMatrix.needsUpdate = true;
    this.ferries.instanceMatrix.needsUpdate = true;
    // The water's wakes and light streaks: the nearest few boats only.
    for (let k = 0; k < WATER_BOATS; k++) {
      let best = -1;
      for (let i = 0; i < this.fleet.length; i++) {
        const d = this.boatDist[i] as number;
        if (d >= 0 && (best < 0 || d < (this.boatDist[best] as number))) {
          best = i;
        }
      }
      const u = this.boatUniform[k] as THREE.Vector4;
      if (best < 0) {
        u.set(0, 0, 0, 0);
        continue;
      }
      u.copy(this.boatAt[best] as THREE.Vector4);
      this.boatDist[best] = -1;
    }
  }
}

// --- Ground-plane splice (sky.ts) --------------------------------------------
// The ground shader includes these so the river's paint lives with the river.

/** GLSL: true where the ground plane must not draw (the open channel, not a
 * bridge deck) — uses sky.ts's abLineDist. */
export const RIVER_GROUND_PARS = /* glsl */ `
uniform int uBridgeGone;
bool abRiverOpen(vec2 w) {
  float off = abs(mod(w.y, ${glsl(WORLD_SIZE)}) - ${glsl(RIVER_CENTER_Z)});
  if (off >= ${glsl(RIVER_HALF_WIDTH)}) return false;
  if (abs(abLineDist(w.x)) > ${glsl(BRIDGE_HALF_WIDTH)}) return true;
  // D9: a fallen span leaves its deck's middle open to the water.
  int k = int(mod(floor(w.x / ${glsl(BLOCK_PITCH)} + 0.5), ${glsl(BRIDGE_COUNT)}));
  return off < ${glsl(BRIDGE_SPAN_HALF)} && ((uBridgeGone >> k) & 1) == 1;
}
// The promenade: granite setts in 1.5 m courses, a darker kerb at the wall.
// L4: and a warm pool of light under each railing lamp (river-bridges.ts
// emitRailLamps — same spacing, same gaps at the bridges), into em.
vec3 abPromenadePaint(vec2 w, float n, vec3 stone, vec3 joint, inout vec3 em) {
  float off = abs(mod(w.y, ${glsl(WORLD_SIZE)}) - ${glsl(RIVER_CENTER_Z)});
  vec3 c = stone * (1.0 + (n - 0.5) * 0.3);
  vec2 j = mod(vec2(w.x + 0.75 * floor(w.y / 1.5), w.y), vec2(3.0, 1.5));
  c = mix(c, joint, max(step(j.x, 0.08), step(j.y, 0.08)));
  if (off < ${glsl(RIVER_HALF_WIDTH + 1.2)}) c = joint;
  float lampX = (floor(w.x / ${glsl(RAIL_LAMP_STEP)}) + 0.5) * ${glsl(RAIL_LAMP_STEP)};
  float lx = w.x - lampX;
  float lineOff = abs(lampX - floor(lampX / ${glsl(BLOCK_PITCH)} + 0.5) * ${glsl(BLOCK_PITCH)});
  float lz = off - ${glsl(RIVER_HALF_WIDTH + 2.0)};
  float pool = exp(-(lx * lx + lz * lz * 1.6) * 0.07) * step(${glsl(GIRDER_X1 + 4)}, lineOff);
  em += vec3(1.0, 0.62, 0.3) * pool * ${glsl(PROMENADE_POOL)};
  return c;
}
`;
