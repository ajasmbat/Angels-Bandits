// The elevated trains (L5, T2), rendered: the viaducts, their stations and
// every train on both tracks of every line.
//
// Every SOLID box comes from common/src/city/train.ts — `line.viaduct` for
// the static deck, curve chords, pillars, platforms, canopies, rails and
// posts, `carBoxAt` for the cars — the SAME boxes collideTrain tests. This
// file never derives a pose of its own, so what you see is what you hit.
// A car's visible parts (bogies, body, roof unit, pantograph) are all drawn
// INSIDE its collision box, the hero-aircraft rule.
//
// One draw call: a single InstancedMesh of unit boxes for the concrete, the
// station furniture, the waiting people and every car part. instanceColor
// tints them; the car body's skin — windows with passengers in them, the
// ceiling light strip, sliding doors that open at a station, the livery
// stripe, the cab and its destination LED sign — is a patch in the material,
// keyed per instance by `aTrain` (part, sign row, door opening). Head lamps,
// tail lamps, canopy lights and the sparks (wheels on a curve, pantograph at
// a section joint) go into the shared MoverLights cloud, which costs no draw
// call of its own.
//
// The viaduct and stations are static, so they are drawn (and, in
// detectCrash, solid) from the first frame. The cars wait for the server
// clock like every other mover: a train you cannot see must never be able to
// kill you. People are the accepted non-solid exception (they are people).
//
// U5: the underground metro reuses this car rendering — METRO_CARS more
// cars at the end of the same InstancedMesh (no draw call of its own),
// posed from underground-layout.ts's pure schedule. They run in the metro
// hall, in the rock behind the station's glass, so they are never solid;
// they stay out of the sound cues, the horns and the MoverLights, and wait
// for the server clock like every other car. They keep this lit material
// (no new program): the scene's moon and fill reach them as they reach the
// platform people — a deviation from the tunnel shell's unlit rule.

import type { MoverBox } from "@angels-bandits/common/city/movers";
import {
  CAR_PITCH,
  StaticRole,
  type TrainLine,
  type TrainState,
  type TrainTrack,
  blankCar,
  carBoxAt,
  carId,
  carOnCurve,
  nextMeeting,
  stopClock,
  trainState,
} from "@angels-bandits/common/city/train";
import {
  EMISSIVE_LAMP,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_SIGN,
  EMISSIVE_STROBE,
  EMISSIVE_WINDOW,
  FOG_DISTANCE,
  TRAIN_CANOPY_BOTTOM,
  TRAIN_CAR_HEIGHT,
  TRAIN_CAR_LENGTH,
  TRAIN_CAR_LIFT,
  TRAIN_CAR_WIDTH,
  TRAIN_DWELL,
  TRAIN_PLATFORM_GAP,
  TRAIN_PLATFORM_LENGTH,
  TRAIN_PLATFORM_TOP,
  TRAIN_PLATFORM_WIDTH,
  TRAIN_TRACK_OFFSET,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { MoverLights } from "./movers";
import type { QualityTier } from "./quality";
import {
  SIGN_ROW_HEIGHT,
  SIGN_WIDTH,
  signBitmap,
  signRow,
  signText,
} from "./train-sign";
import { METRO_CARS, metroCarBox, metroState } from "./underground-layout";
import { InstanceUploads, imageIndex } from "./wrapPlacement";

/** A1: a fixed slot not yet placed (no torus image index is this). */
const UNPLACED = 0x7fffffff;

/** Program cache key for the patched train material — distinct from every
 * other key in the repo (three keys programs on onBeforeCompile.toString()
 * otherwise; see traffic.ts for the bug that caused). */
export const TRAIN_CACHE_KEY = "ab-train-t2";

/** Concrete, station furniture and car parts, as instance colours. */
const ROLE_COLOR: Record<StaticRole, THREE.Color> = {
  [StaticRole.Deck]: new THREE.Color(0x6a6662),
  [StaticRole.Pillar]: new THREE.Color(0x57534f),
  [StaticRole.Platform]: new THREE.Color(0x7a756e),
  [StaticRole.Canopy]: new THREE.Color(0x3b4047),
  [StaticRole.Rail]: new THREE.Color(0x60646a),
  [StaticRole.Post]: new THREE.Color(0x484b50),
};
const BODY_COLOR = new THREE.Color(0xb3bbc4);
const BOGIE_COLOR = new THREE.Color(0x26272a);
const ROOF_UNIT_COLOR = new THREE.Color(0x8b9197);
const PANTOGRAPH_COLOR = new THREE.Color(0x34363a);
/** Coats on the platform: muted mid-tones, so a figure reads against the
 * concrete under the canopy at night. */
const PEOPLE_COLORS = [
  0x6b5a4a, 0x4a5a6b, 0x7a3b3b, 0x5d6b4a, 0x8a7a6a, 0x3f4a5f,
].map((c) => new THREE.Color(c));
/** Line liveries: line A red, line B blue (the stripe and the cab band). */
const LIVERY = [new THREE.Color(0xc0302a), new THREE.Color(0x2a62c0)];

/** Warm cabin light through the windows, at the WINDOW rung; the ceiling
 * strip and an open doorway read a little brighter. */
const WINDOW_COLOR = new THREE.Color(1.0, 0.88, 0.66);
const WINDOW_BOOST = emissiveBoost(WINDOW_COLOR, EMISSIVE_WINDOW);
/** Amber LEDs at the SIGN rung. */
const LED_COLOR = new THREE.Color(1.0, 0.58, 0.12);
const LED_BOOST = emissiveBoost(LED_COLOR, EMISSIVE_SIGN);

/** Head lamps and canopy lights (LAMP rung), tail lamps (NAVLIGHT), sparks
 * (STROBE). */
const boosted = (c: THREE.Color, rung: number) =>
  c.clone().multiplyScalar(emissiveBoost(c, rung));
const headBoost = boosted(new THREE.Color(1.0, 0.95, 0.85), EMISSIVE_LAMP);
const tailBoost = boosted(new THREE.Color(1.0, 0.1, 0.08), EMISSIVE_NAVLIGHT);
const canopyBoost = boosted(new THREE.Color(0.85, 0.92, 1.0), EMISSIVE_LAMP);
const sparkBoost = boosted(new THREE.Color(1.0, 0.72, 0.32), EMISSIVE_STROBE);
const arcBoost = boosted(new THREE.Color(0.7, 0.8, 1.0), EMISSIVE_STROBE);
/** A spark lives this long before the next one is drawn, ms. */
const SPARK_FRAME_MS = 45;
/** Wheel sparks per car per spark frame on a curve (some frames draw fewer). */
const SPARKS_PER_CAR = 3;
/** Overhead-line section joints, every this many metres of track: the
 * pantograph arcs as it crosses one. */
const JOINT_SPACING = 45;
/** ...for this many metres either side. */
const JOINT_ARC = 1.2;
/** Most train lights per frame (MoverLights is shared with cranes, aircraft
 * and fireworks). */
export const TRAIN_LIGHT_BUDGET = 300;
/** Canopy lamps per platform side. */
const CANOPY_LAMPS = 5;
/** Waiting people per platform side. */
const PEOPLE_PER_SIDE = 7;

/** Car part layout inside the collision box (local y from -1.9 to 1.9). */
const HALF_H = TRAIN_CAR_HEIGHT / 2;
const BOGIE_H = 0.65;
const ROOF_H = 0.35;
const BODY_H = TRAIN_CAR_HEIGHT - BOGIE_H - ROOF_H;
const BODY_Y = -HALF_H + BOGIE_H + BODY_H / 2;
/** Parts per car: front bogie, rear bogie, body, roof unit. */
const PARTS_PER_CAR = 4;
/** Extra parts per train: the pantograph's arm and its collector head. */
const PANTO_PARTS = 2;

/** aTrain.x: which skin a part wears. */
const PART_PLAIN = 0;
const PART_BODY = 1;
const PART_LEAD = 2;
const PART_TAIL = 3;

const TRAIN_PARS = /* glsl */ `
varying vec3 vTrainPos;
varying vec3 vTrainNormal;
varying vec3 vTrain;
// O6: flat — it seeds the passenger hash (see trainSkin), where an
// interpolated copy one ulp off re-rolled the seats per pixel.
flat varying float vTrainId;
`;

const TRAIN_VERTEX = /* glsl */ `
// Unit box scaled per instance: object space is [-0.5, 0.5] on every axis.
vTrainPos = position;
vTrainNormal = normal;
vTrain = aTrain;
vTrainId = float(gl_InstanceID);
`;

const f = (n: number) => n.toFixed(4);

/** The body skin: x = dark glass / opening, y = window light, z = livery,
 * w = LED dot. All in metres on the car body (local x along, y up). */
const SKIN_FN = /* glsl */ `
uniform sampler2D uTrainSign;
uniform float uTrainTime;
float trainHash(float a, float b) {
  return fract(sin(a * 12.9898 + b * 78.233) * 43758.5453);
}
vec4 trainSkin() {
  if (vTrain.x < 0.5) return vec4(0.0);
  float lx = vTrainPos.x * ${f(TRAIN_CAR_LENGTH)};
  float ly = vTrainPos.y * ${f(BODY_H)};
  float lz = vTrainPos.z * ${f(TRAIN_CAR_WIDTH)};
  float livery = step(-1.05, ly) * step(ly, -0.78);
  vec4 o = vec4(0.0, 0.0, livery, 0.0);
  if (abs(vTrainNormal.z) > 0.5) {
    // Two sliding doors a side, 1.4 m wide, at +-4 m.
    float dc = lx > 0.0 ? 4.0 : -4.0;
    float dx = abs(lx - dc);
    float inDoor = step(dx, 0.7) * step(-1.3, ly) * step(ly, 0.95);
    float open = step(dx, 0.7 * vTrain.z) * inDoor;
    float doorWin = inDoor * (1.0 - open) * step(abs(dx - 0.35), 0.2) *
      step(0.05, ly) * step(ly, 0.85);
    // Ten panes a side above the stripe.
    float band = step(-0.15, ly) * step(ly, 0.95) * step(abs(lx), 7.5);
    float cell = floor((lx + 8.0) / 1.6);
    float cx = (cell + 0.5) * 1.6 - 8.0;
    float pane = step(abs(lx - cx), 0.62) * band * (1.0 - inDoor);
    // Passengers: about half the seats taken, head and shoulders.
    // The side as an exact ±1, not the interpolated normal: a sin() hash
    // turns one ulp of its input into another seat, so the passengers
    // sparkled per pixel under any camera move (O6).
    float side = vTrainNormal.z > 0.0 ? 1.0 : -1.0;
    float h = trainHash(cell + vTrainId * 17.0, side);
    float px = cx + (h - 0.5) * 0.6;
    float head = 1.0 - step(0.16, length(vec2(lx - px, ly - 0.5)));
    float torso = step(abs(lx - px), 0.27) * step(ly, 0.28);
    float person = step(h, 0.55) * max(head, torso);
    float strip = step(0.84, ly);
    float glass = max(pane, doorWin);
    o.x = max(glass, open);
    o.y = max(glass * (1.0 - 0.85 * person * pane) * (1.0 + 0.4 * strip),
      open * 1.15);
    return o;
  }
  if (abs(vTrainNormal.x) > 0.5) {
    bool front = vTrainNormal.x > 0.0;
    bool cab = (vTrain.x > 1.5 && vTrain.x < 2.5 && front) ||
      (vTrain.x > 2.5 && !front);
    if (!cab) {
      // Gangway bellows to the next car.
      o.x = 0.85 * step(abs(lz), 0.6) * step(ly, 0.95);
      return o;
    }
    // Destination sign across the top of the cab, a marquee of LED dots.
    float sv = (ly - 0.98) / 0.36;
    float su = (front ? -lz : lz) / 2.4 + 0.5;
    if (sv >= 0.0 && sv <= 1.0 && su >= 0.0 && su <= 1.0) {
      float gx = su * 40.0;
      float gy = (1.0 - sv) * 7.0;
      vec2 cellUv = fract(vec2(gx, gy)) - 0.5;
      float dotMask = 1.0 - step(0.36, length(cellUv));
      int tx = int(mod(floor(gx) + floor(uTrainTime * 8.0), ${SIGN_WIDTH}.0));
      int ty = int(vTrain.y + 0.5) * ${SIGN_ROW_HEIGHT} + int(min(6.0, floor(gy)));
      float on = texelFetch(uTrainSign, ivec2(tx, ty), 0).r;
      o.x = 1.0;
      o.w = dotMask * (0.06 + 0.94 * on);
      return o;
    }
    // Windscreen, and the livery carried round the cab.
    o.x = step(abs(lz), 1.25) * step(-0.1, ly) * step(ly, 0.85);
    o.z = step(-1.4, ly) * step(ly, -0.6);
    return o;
  }
  return vec4(0.0);
}
`;

const TRAIN_COLOR_FRAGMENT = /* glsl */ `
vec4 trainSkinV = trainSkin();
vec3 trainLivery = mix(
  vec3(${f(LIVERY[0]?.r ?? 0)}, ${f(LIVERY[0]?.g ?? 0)}, ${f(LIVERY[0]?.b ?? 0)}),
  vec3(${f(LIVERY[1]?.r ?? 0)}, ${f(LIVERY[1]?.g ?? 0)}, ${f(LIVERY[1]?.b ?? 0)}),
  step(1.5, vTrain.y));
diffuseColor.rgb = mix(diffuseColor.rgb, trainLivery, trainSkinV.z);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.04, 0.05), trainSkinV.x);
`;

const TRAIN_EMISSIVE_FRAGMENT = /* glsl */ `
totalEmissiveRadiance += trainSkinV.y * ${f(WINDOW_BOOST)} *
  vec3(${f(WINDOW_COLOR.r)}, ${f(WINDOW_COLOR.g)}, ${f(WINDOW_COLOR.b)});
totalEmissiveRadiance += trainSkinV.w * ${f(LED_BOOST)} *
  vec3(${f(LED_COLOR.r)}, ${f(LED_COLOR.g)}, ${f(LED_COLOR.b)});
`;

function createSignTexture(lines: number): THREE.DataTexture {
  const rows: string[] = [];
  for (let l = 0; l < Math.max(1, lines); l++) {
    for (let t = 0; t < 2; t++) rows[signRow(l, t)] = signText(l, t);
  }
  const { data, width, height } = signBitmap(rows);
  const tex = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function createTrainMaterial(
  sign: THREE.Texture,
  time: { value: number },
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0.3,
  });
  material.customProgramCacheKey = () => TRAIN_CACHE_KEY;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTrainSign = { value: sign };
    shader.uniforms.uTrainTime = time;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\nattribute vec3 aTrain;\n${TRAIN_PARS}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${TRAIN_VERTEX}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\n${TRAIN_PARS}\n${SKIN_FN}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\n${TRAIN_COLOR_FRAGMENT}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${TRAIN_EMISSIVE_FRAGMENT}`,
      );
  };
  return material;
}

/** A small deterministic hash in [0, 1) — shared visuals never use
 * Math.random (every client must throw the same spark). */
function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (c | 0), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** One train's place in the instance buffer. */
interface TrainSlot {
  line: TrainLine;
  track: TrainTrack;
  j: number;
  /** First instance index of its parts. */
  base: number;
  /** Last time its horn sounded, ms of server time. */
  hornAt: number;
}

/** A waiting passenger: a canonical spot on a platform. */
interface Person {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Visible while the platform's fill is above this. */
  rank: number;
  track: TrainTrack;
  stop: number;
}

/** A canopy lamp: canonical position. */
interface Lamp {
  x: number;
  y: number;
  z: number;
}

/** What the train sound wants to know each frame. */
export interface TrainSound {
  /** The nearest car's rendered position, or null with no train in earshot
   * (or before the server clock). */
  at: Vec3 | null;
  /** That train's speed over its cruise speed, 0..1. */
  speed01: number;
  /** Its speed, m/s — the clatter's rate. */
  speed: number;
  /** Whether any car near the camera is rounding a curve (wheel squeal). */
  squeal: boolean;
  /** A horn to sound this frame (rendered position), or null. */
  horn: Vec3 | null;
}

/** A horn sounds when a plane passes this close to a car, m... */
const HORN_RANGE = 40;
/** ...at most once per train per this long, ms. */
const HORN_COOLDOWN_MS = 6000;

/**
 * The train renderer. One InstancedMesh, posed from the shared seam every
 * frame at the torus image nearest the camera.
 */
export class TrainRenderer {
  readonly mesh: THREE.InstancedMesh;
  /** This frame's sound cues (read by main.ts after update). */
  readonly sound: TrainSound = {
    at: null,
    speed01: 0,
    speed: 0,
    squeal: false,
    horn: null,
  };

  private readonly lines: readonly TrainLine[];
  private readonly statics: number;
  /**
   * A1: each fixed slot's (viaduct, then platform people) last placement —
   * torus image along x and z, and hidden — so a frame only recomposes and
   * uploads the slots whose image flipped (or whose person came or went),
   * not every pillar and slab; the cars are rewritten every frame.
   */
  private readonly placed: Int32Array;
  private readonly uploads: InstanceUploads;
  private readonly people: Person[] = [];
  private readonly lamps: Lamp[] = [];
  private readonly slots: TrainSlot[] = [];
  private readonly count: number;
  /** U5: the first instance of the metro's parts. */
  private readonly metroBase: number;
  private readonly metro = { s: null as number | null, doors: 0 };
  private readonly trainAttr: THREE.InstancedBufferAttribute;
  private readonly time = { value: 0 };
  private showPeople = true;
  private sparkShare = 1;
  private lightRange = FOG_DISTANCE + 100;
  private lightsPlaced = 0;
  private peopleShown = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly tilt = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly car: MoverBox = blankCar();
  private readonly state: TrainState = { q: 0, v: 0, doors: 0, station: -1 };
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly nearest: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly hornPos: Vec3 = { x: 0, y: 0, z: 0 };
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private static readonly AXIS_Z = new THREE.Vector3(0, 0, 1);

  constructor(lines: readonly TrainLine[]) {
    this.lines = lines;
    let statics = 0;
    for (const line of lines) statics += line.viaduct.length;
    this.statics = statics;
    for (const line of lines) this.buildStations(line);
    let next = statics + this.people.length;
    const cars = lines[0]?.cars ?? 0;
    for (const line of lines) {
      for (const track of line.tracks) {
        for (let j = 0; j < track.trains; j++) {
          this.slots.push({ line, track, j, base: next, hornAt: -1e15 });
          next += cars * PARTS_PER_CAR + PANTO_PARTS;
        }
      }
    }
    this.metroBase = next;
    next += METRO_CARS * PARTS_PER_CAR;
    this.count = Math.max(1, next);

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const attr = new Float32Array(this.count * 3);
    for (const slot of this.slots) {
      const row = signRow(slot.line.index, slot.track.index);
      for (let i = 0; i < slot.line.cars; i++) {
        const body = slot.base + i * PARTS_PER_CAR + 2;
        attr[body * 3] =
          i === 0
            ? PART_LEAD
            : i === slot.line.cars - 1
              ? PART_TAIL
              : PART_BODY;
        attr[body * 3 + 1] = row;
      }
    }
    for (let i = 0; i < METRO_CARS; i++) {
      const body = this.metroBase + i * PARTS_PER_CAR + 2;
      attr[body * 3] =
        i === 0 ? PART_LEAD : i === METRO_CARS - 1 ? PART_TAIL : PART_BODY;
      attr[body * 3 + 1] = signRow(0, 0);
    }
    this.trainAttr = new THREE.InstancedBufferAttribute(attr, 3);
    this.trainAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aTrain", this.trainAttr);
    this.mesh = new THREE.InstancedMesh(
      geometry,
      createTrainMaterial(createSignTexture(lines.length), this.time),
      this.count,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.uploads = new InstanceUploads([this.mesh.instanceMatrix]);
    this.placed = new Int32Array((statics + this.people.length) * 3).fill(
      UNPLACED,
    );
    // Instances move relative to the camera every frame.
    this.mesh.frustumCulled = false;
    this.mesh.visible = lines.length > 0;

    let i = 0;
    for (const line of lines) {
      line.viaduct.forEach((_, k) => {
        this.mesh.setColorAt(i++, ROLE_COLOR[line.roles[k] ?? StaticRole.Deck]);
      });
    }
    this.people.forEach((p, k) => {
      this.mesh.setColorAt(
        statics + k,
        PEOPLE_COLORS[
          Math.floor(p.rank * 997) % PEOPLE_COLORS.length
        ] as THREE.Color,
      );
    });
    for (const slot of this.slots) {
      for (let c = 0; c < slot.line.cars; c++) {
        const b = slot.base + c * PARTS_PER_CAR;
        this.mesh.setColorAt(b, BOGIE_COLOR);
        this.mesh.setColorAt(b + 1, BOGIE_COLOR);
        this.mesh.setColorAt(b + 2, BODY_COLOR);
        this.mesh.setColorAt(b + 3, ROOF_UNIT_COLOR);
      }
      const p = slot.base + slot.line.cars * PARTS_PER_CAR;
      this.mesh.setColorAt(p, PANTOGRAPH_COLOR);
      this.mesh.setColorAt(p + 1, PANTOGRAPH_COLOR);
    }
    for (let c = 0; c < METRO_CARS; c++) {
      const b = this.metroBase + c * PARTS_PER_CAR;
      this.mesh.setColorAt(b, BOGIE_COLOR);
      this.mesh.setColorAt(b + 1, BOGIE_COLOR);
      this.mesh.setColorAt(b + 2, BODY_COLOR);
      this.mesh.setColorAt(b + 3, ROOF_UNIT_COLOR);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Waiting people and canopy lamps for a line's stations. Deterministic
   * from the line and station index (never Math.random). */
  private buildStations(line: TrainLine): void {
    const inner = TRAIN_TRACK_OFFSET + TRAIN_CAR_WIDTH / 2 + TRAIN_PLATFORM_GAP;
    line.stations.forEach((st, s) => {
      // Outward normal of the loop at this straight (see stationBoxes).
      const nx = st.uz;
      const nz = -st.ux;
      for (const track of line.tracks) {
        const side = track.index === 0 ? 1 : -1;
        const stop = track.stopStation.indexOf(s);
        for (let k = 0; k < PEOPLE_PER_SIDE; k++) {
          const h1 = hash01(line.index * 31 + s, track.index, k);
          const h2 = hash01(line.index * 31 + s, track.index, k + 101);
          const along = (h1 - 0.5) * (TRAIN_PLATFORM_LENGTH - 8);
          const lat = side * (inner + 0.9 + h2 * (TRAIN_PLATFORM_WIDTH - 2.2));
          this.people.push({
            x: st.x + nx * lat + st.ux * along,
            y: TRAIN_PLATFORM_TOP + 0.85,
            z: st.z + nz * lat + st.uz * along,
            yaw: h2 * Math.PI * 2,
            rank: hash01(line.index * 31 + s, track.index, k + 211),
            track,
            stop,
          });
        }
        for (let k = 0; k < CANOPY_LAMPS; k++) {
          const along =
            ((k + 0.5) / CANOPY_LAMPS - 0.5) * (TRAIN_PLATFORM_LENGTH - 6);
          const lat = side * (inner + TRAIN_PLATFORM_WIDTH / 2);
          this.lamps.push({
            x: st.x + nx * lat + st.ux * along,
            y: TRAIN_CANOPY_BOTTOM - 0.15,
            z: st.z + nz * lat + st.uz * along,
          });
        }
      }
    });
  }

  /** Instances drawn — the perf report's handle. */
  get instanceCount(): number {
    return this.mesh.count;
  }

  /** O3 quality tier: everything solid is identical on every tier; only the
   * waiting people, the sparks and how far out train lights are placed
   * change. Never a material or a define — no compile on a tier switch. */
  setQuality(tier: QualityTier): void {
    this.showPeople = tier === "high" || tier === "medium";
    this.sparkShare =
      tier === "high" || tier === "medium" ? 1 : tier === "low" ? 0.5 : 0;
    this.lightRange =
      tier === "high" || tier === "medium" ? FOG_DISTANCE + 100 : 500;
  }

  /** Write one box at the image of its centre nearest the camera. */
  private put(i: number, b: MoverBox, camera: Vec3, hidden = false): void {
    this.pos.set(
      camera.x + wrapDeltaAxis(camera.x, b.x),
      b.y,
      camera.z + wrapDeltaAxis(camera.z, b.z),
    );
    this.quat.setFromAxisAngle(TrainRenderer.UP, b.yaw);
    if (hidden) this.scale.set(0, 0, 0);
    else this.scale.set(b.hx * 2, b.hy * 2, b.hz * 2);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(i, this.matrix);
  }

  /** put() for a fixed slot, only when its image or `hidden` changed. */
  private putFixed(i: number, b: MoverBox, camera: Vec3, hidden = false): void {
    const kx = imageIndex(camera.x, b.x);
    const kz = imageIndex(camera.z, b.z);
    const h = hidden ? 1 : 0;
    const s = i * 3;
    const p = this.placed;
    if (p[s] === kx && p[s + 1] === kz && p[s + 2] === h) return;
    p[s] = kx;
    p[s + 1] = kz;
    p[s + 2] = h;
    this.put(i, b, camera, hidden);
    this.uploads.mark(i);
  }

  /** A point in a car's own frame (along, up, across), rendered near the
   * camera, written into `this.at`. */
  private local(
    b: MoverBox,
    along: number,
    up: number,
    across: number,
    camera: Vec3,
  ): Vec3 {
    const ax = Math.cos(b.yaw);
    const az = -Math.sin(b.yaw);
    const x = b.x + ax * along - az * across;
    const z = b.z + az * along + ax * across;
    this.at.x = camera.x + wrapDeltaAxis(camera.x, x);
    this.at.y = b.y + up;
    this.at.z = camera.z + wrapDeltaAxis(camera.z, z);
    return this.at;
  }

  /** A part box of size (sx, sy, sz) centred at a point of the car's frame,
   * optionally tilted about the car's across axis. */
  private putPart(
    i: number,
    b: MoverBox,
    along: number,
    up: number,
    sx: number,
    sy: number,
    sz: number,
    camera: Vec3,
    tilt = 0,
  ): void {
    const p = this.local(b, along, up, 0, camera);
    this.pos.set(p.x, p.y, p.z);
    this.quat.setFromAxisAngle(TrainRenderer.UP, b.yaw);
    if (tilt !== 0) {
      this.tilt.setFromAxisAngle(TrainRenderer.AXIS_Z, tilt);
      this.quat.multiply(this.tilt);
    }
    this.scale.set(sx, sy, sz);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(i, this.matrix);
  }

  private hide(i: number): void {
    this.scale.set(0, 0, 0);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(i, this.matrix);
  }

  private light(
    p: Vec3,
    color: THREE.Color,
    size: number,
    lights: MoverLights,
  ) {
    if (this.lightsPlaced >= TRAIN_LIGHT_BUDGET) return;
    this.lightsPlaced++;
    lights.place(p, color, size);
  }

  /**
   * Pose the frame. `serverTimeMs` is main.ts's LATCHED render clock — the
   * same value the crash check uses. Null hides the cars (the viaduct and
   * stations stay). `planes` are the planes that can draw a horn (the local
   * plane and the remotes), any torus image.
   */
  update(
    camera: Vec3,
    serverTimeMs: number | null,
    lights: MoverLights,
    planes: readonly Vec3[] = [],
  ): void {
    const sound = this.sound;
    sound.at = null;
    sound.speed01 = 0;
    sound.speed = 0;
    sound.squeal = false;
    sound.horn = null;
    this.lightsPlaced = 0;
    if (this.lines.length === 0) return;
    this.time.value = serverTimeMs === null ? 0 : (serverTimeMs / 1000) % 3600;

    let n = 0;
    for (const line of this.lines) {
      for (const b of line.viaduct) this.putFixed(n++, b, camera);
    }
    const range2 = this.lightRange * this.lightRange;
    const near = (x: number, z: number) => {
      const dx = wrapDeltaAxis(camera.x, x);
      const dz = wrapDeltaAxis(camera.z, z);
      return dx * dx + dz * dz < range2;
    };
    for (const lamp of this.lamps) {
      if (!near(lamp.x, lamp.z)) continue;
      this.at.x = camera.x + wrapDeltaAxis(camera.x, lamp.x);
      this.at.y = lamp.y;
      this.at.z = camera.z + wrapDeltaAxis(camera.z, lamp.z);
      this.light(this.at, canopyBoost, 1.3, lights);
    }

    // Waiting people: the platform empties as a train boards and fills
    // again until the next one is due.
    this.peopleShown = 0;
    for (let k = 0; k < this.people.length; k++) {
      const p = this.people[k] as Person;
      let fill = 0;
      if (this.showPeople && serverTimeMs !== null && p.stop >= 0) {
        const since = stopClock(p.track, p.stop, serverTimeMs);
        fill =
          since < TRAIN_DWELL
            ? 1 - 0.85 * Math.min(1, since / (TRAIN_DWELL - 2))
            : 0.15 +
              0.85 *
                Math.min(
                  1,
                  (since - TRAIN_DWELL) / (p.track.headway - TRAIN_DWELL),
                );
      }
      this.car.x = p.x;
      this.car.y = p.y;
      this.car.z = p.z;
      this.car.hx = 0.25;
      this.car.hy = 0.85;
      this.car.hz = 0.2;
      this.car.yaw = p.yaw;
      const hidden = p.rank >= fill;
      if (!hidden) this.peopleShown++;
      this.putFixed(this.statics + k, this.car, camera, hidden);
    }

    let best = Number.POSITIVE_INFINITY;
    const doors = this.trainAttr.array as Float32Array;
    for (const slot of this.slots) {
      const { line, track } = slot;
      const panto = slot.base + line.cars * PARTS_PER_CAR;
      if (serverTimeMs === null) {
        for (let i = slot.base; i < panto + PANTO_PARTS; i++) this.hide(i);
        continue;
      }
      const st = trainState(track, slot.j, serverTimeMs, this.state);
      let lit = false;
      for (let i = 0; i < line.cars; i++) {
        const b = carBoxAt(
          line,
          track,
          st.q,
          i,
          carId(line.index, track.index, slot.j, i),
          this.car,
        );
        const base = slot.base + i * PARTS_PER_CAR;
        const bogieY = -HALF_H + BOGIE_H / 2;
        this.putPart(base, b, 5.4, bogieY, 2.8, BOGIE_H, 2.5, camera);
        this.putPart(base + 1, b, -5.4, bogieY, 2.8, BOGIE_H, 2.5, camera);
        this.putPart(
          base + 2,
          b,
          0,
          BODY_Y,
          TRAIN_CAR_LENGTH,
          BODY_H,
          TRAIN_CAR_WIDTH,
          camera,
        );
        this.putPart(
          base + 3,
          b,
          i === 0 ? -3 : 0,
          HALF_H - ROOF_H + 0.15,
          4,
          0.3,
          2.2,
          camera,
        );
        doors[(base + 2) * 3 + 2] = st.doors;

        const dx = wrapDeltaAxis(camera.x, b.x);
        const dz = wrapDeltaAxis(camera.z, b.z);
        const d2 = dx * dx + dz * dz + (b.y - camera.y) ** 2;
        if (d2 < best) {
          best = d2;
          this.nearest.x = camera.x + dx;
          this.nearest.y = b.y;
          this.nearest.z = camera.z + dz;
          sound.at = this.nearest;
          sound.speed = st.v;
          sound.speed01 = Math.min(1, st.v / track.speed);
        }
        if (i === 1 || line.cars === 1) {
          // The pantograph: an arm leaning back and the collector head.
          this.putPart(
            panto,
            b,
            4.2,
            HALF_H - 0.2,
            1.7,
            0.07,
            0.08,
            camera,
            0.22,
          );
          this.putPart(
            panto + 1,
            b,
            4.95,
            HALF_H - 0.04,
            0.16,
            0.07,
            1.9,
            camera,
          );
        }
        if (i === 0) lit = near(b.x, b.z);
        if (!lit) continue;

        if (i === 0) {
          // Twin head lamps low on the nose, a marker over the cab.
          for (const s of [-1, 1]) {
            this.light(
              this.local(b, b.hx, BODY_Y - 0.9, s * b.hz * 0.6, camera),
              headBoost,
              1.6,
              lights,
            );
          }
          this.light(
            this.local(b, b.hx, BODY_Y + 0.75, 0, camera),
            headBoost,
            0.9,
            lights,
          );
        }
        if (i === line.cars - 1) {
          for (const s of [-1, 1]) {
            this.light(
              this.local(b, -b.hx, BODY_Y - 0.9, s * b.hz * 0.6, camera),
              tailBoost,
              1.3,
              lights,
            );
          }
        }
        if (this.sparkShare <= 0 || st.v < 4 || d2 > 400 * 400) continue;
        const frame = Math.floor(serverTimeMs / SPARK_FRAME_MS);
        const id = carId(line.index, track.index, slot.j, i);
        const curve = carOnCurve(track, st.q, i);
        if (curve && d2 < 250 * 250) sound.squeal = true;
        if (curve) {
          // Sparks at the wheels: a fresh, seeded scatter every
          // SPARK_FRAME_MS, on the shared clock so every client throws the
          // same spark.
          for (let k = 0; k < SPARKS_PER_CAR; k++) {
            const r = hash01(frame, id, k);
            if (r < 0.25 || r > 0.25 + 0.75 * this.sparkShare) continue;
            const bogie = (k % 2 === 0 ? 0.62 : -0.62) * b.hx;
            const side = hash01(frame, id, k + 7) < 0.5 ? -1 : 1;
            this.light(
              this.local(
                b,
                bogie + (r - 0.5) * 2.4,
                -b.hy - TRAIN_CAR_LIFT * 0.5 + r * 0.5,
                side * (b.hz + 0.15),
                camera,
              ),
              sparkBoost,
              0.6 + r * 1.4,
              lights,
            );
          }
        }
        if (i === 1 || line.cars === 1) {
          // The pantograph arcs blue-white on curves and at section joints.
          const pq = st.q - i * CAR_PITCH + 4.95;
          const joint = Math.abs(
            pq - Math.round(pq / JOINT_SPACING) * JOINT_SPACING,
          );
          const r = hash01(frame, id, 31);
          if (
            (joint < JOINT_ARC || (curve && r < 0.3)) &&
            r < this.sparkShare
          ) {
            this.light(
              this.local(b, 4.95, HALF_H, (r - 0.5) * 1.4, camera),
              arcBoost,
              0.8 + r * 1.6,
              lights,
            );
          }
        }
      }

      // The horn: a plane passing within HORN_RANGE of a moving train.
      if (
        st.v > 3 &&
        serverTimeMs - slot.hornAt > HORN_COOLDOWN_MS &&
        planes.length > 0
      ) {
        const mid = carBoxAt(line, track, st.q - CAR_PITCH, 0, 0, this.car);
        for (const p of planes) {
          const dx = wrapDeltaAxis(mid.x, p.x);
          const dz = wrapDeltaAxis(mid.z, p.z);
          const dy = p.y - mid.y;
          if (dx * dx + dz * dz + dy * dy > (HORN_RANGE + CAR_PITCH) ** 2)
            continue;
          slot.hornAt = serverTimeMs;
          this.hornPos.x = camera.x + wrapDeltaAxis(camera.x, mid.x);
          this.hornPos.y = mid.y;
          this.hornPos.z = camera.z + wrapDeltaAxis(camera.z, mid.z);
          sound.horn = this.hornPos;
          break;
        }
      }
    }
    this.poseMetro(camera, serverTimeMs, doors);
    // A1: the cars' slots (and metro) are posed every frame; the fixed
    // slots before them were marked as they changed.
    for (let i = this.statics + this.people.length; i < this.count; i++) {
      this.uploads.mark(i);
    }
    this.uploads.flush();
    this.trainAttr.needsUpdate = true;
  }

  /** U5: the metro's cars — hidden before the clock, between trains and
   * wherever a car is wholly beyond the hall's end walls. */
  private poseMetro(
    camera: Vec3,
    serverTimeMs: number | null,
    doors: Float32Array,
  ): void {
    const m =
      serverTimeMs === null ? null : metroState(serverTimeMs, this.metro);
    for (let i = 0; i < METRO_CARS; i++) {
      const base = this.metroBase + i * PARTS_PER_CAR;
      const b = this.car;
      if (m === null || m.s === null || !metroCarBox(m.s, i, b)) {
        for (let k = 0; k < PARTS_PER_CAR; k++) this.hide(base + k);
        continue;
      }
      const bogieY = -HALF_H + BOGIE_H / 2;
      this.putPart(base, b, 5.4, bogieY, 2.8, BOGIE_H, 2.5, camera);
      this.putPart(base + 1, b, -5.4, bogieY, 2.8, BOGIE_H, 2.5, camera);
      this.putPart(
        base + 2,
        b,
        0,
        BODY_Y,
        TRAIN_CAR_LENGTH,
        BODY_H,
        TRAIN_CAR_WIDTH,
        camera,
      );
      this.putPart(base + 3, b, 0, HALF_H - ROOF_H + 0.15, 4, 0.3, 2.2, camera);
      doors[(base + 2) * 3 + 2] = m.doors;
    }
  }

  /** Train lights placed this frame — the perf report's handle. */
  get lightCount(): number {
    return this.lightsPlaced;
  }

  /** QA read-back: the routes and every train's pose and state at a server
   * time. `cars` (L5's shape) is the first train of line 0's outer track;
   * `drawnAt` is that train's lead body as last drawn. */
  debug(serverTimeMs: number | null): {
    route: {
      ox: number;
      oz: number;
      w: number;
      d: number;
      length: number;
      cars: number;
      dir: number;
    };
    lines: {
      ox: number;
      oz: number;
      w: number;
      d: number;
      stations: { x: number; z: number; ux: number; uz: number }[];
      tracks: { trains: number; speed: number; headway: number; dir: number }[];
    }[];
    time: number | null;
    viaductBoxes: number;
    cars: { x: number; y: number; z: number; yaw: number; curve: boolean }[];
    trains: {
      line: number;
      track: number;
      train: number;
      x: number;
      z: number;
      yaw: number;
      v: number;
      doors: number;
      station: number;
      curve: boolean;
    }[];
    drawnAt: Vec3 | null;
    lights: number;
    people: { shown: number; total: number };
  } | null {
    const first = this.lines[0];
    if (!first) return null;
    const s: TrainState = { q: 0, v: 0, doors: 0, station: -1 };
    const outer = first.tracks[0];
    const cars =
      serverTimeMs === null
        ? []
        : Array.from({ length: first.cars }, (_, i) => {
            const q = trainState(outer, 0, serverTimeMs, s).q;
            const b = carBoxAt(first, outer, q, i, 0, blankCar());
            return {
              x: b.x,
              y: b.y,
              z: b.z,
              yaw: b.yaw,
              curve: carOnCurve(outer, q, i),
            };
          });
    const trains =
      serverTimeMs === null
        ? []
        : this.slots.map((slot) => {
            const st = trainState(slot.track, slot.j, serverTimeMs, s);
            const mid = carBoxAt(
              slot.line,
              slot.track,
              st.q - CAR_PITCH,
              0,
              0,
              blankCar(),
            );
            return {
              line: slot.line.index,
              track: slot.track.index,
              train: slot.j,
              x: mid.x,
              z: mid.z,
              yaw: mid.yaw,
              v: st.v,
              doors: st.doors,
              station: st.station,
              curve: carOnCurve(slot.track, st.q, 1),
            };
          });
    let drawnAt: Vec3 | null = null;
    const slot = this.slots[0];
    if (serverTimeMs !== null && slot) {
      this.mesh.getMatrixAt(slot.base + 2, this.matrix);
      const e = this.matrix.elements;
      drawnAt = { x: e[12] ?? 0, y: e[13] ?? 0, z: e[14] ?? 0 };
    }
    return {
      route: {
        ox: first.ox,
        oz: first.oz,
        w: first.w,
        d: first.d,
        length: first.length,
        cars: first.cars,
        dir: first.dir,
      },
      lines: this.lines.map((l) => ({
        ox: l.ox,
        oz: l.oz,
        w: l.w,
        d: l.d,
        stations: l.stations.map((st) => ({ ...st })),
        tracks: l.tracks.map((t) => ({
          trains: t.trains,
          speed: t.speed,
          headway: t.headway,
          dir: t.dir,
        })),
      })),
      time: serverTimeMs,
      viaductBoxes: this.statics,
      cars,
      trains,
      drawnAt,
      lights: this.lightsPlaced,
      people: { shown: this.peopleShown, total: this.people.length },
    };
  }

  /** QA: the next time two trains pass each other at speed on line `line`
   * (meetings at a station, one set standing, are not "passing"). */
  meeting(line: number, fromMs: number): ReturnType<typeof nextMeeting> {
    const l = this.lines[line];
    return l ? nextMeeting(l, fromMs, 120_000, 10) : null;
  }
}
