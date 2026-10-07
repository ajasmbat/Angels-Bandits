// The L5 elevated train, rendered: the viaduct and a lit train looping it.
//
// Every box comes from common/src/city/train.ts — `line.viaduct` for the
// static deck, curve chords and pillars, `carBox` for the cars — the SAME
// boxes collideTrain tests, one instance per box at exactly its size. This
// file never derives a pose of its own, so what you see is what you hit.
//
// One draw call: a single InstancedMesh of unit boxes for the concrete AND
// the cars. instanceColor tints concrete vs. car body; the window glow is a
// patch in the material, flagged per instance by `aTrainWin` (the hull
// banner idiom in movers.ts), at the WINDOW rung. Head lamps, tail lamps and
// the sparks a car throws on a curve go into the shared MoverLights cloud,
// which costs no draw call of its own.
//
// The viaduct is static, so it is drawn (and, in detectCrash, solid) from the
// first frame. The cars wait for the server clock like every other mover: a
// train you cannot see must never be able to kill you.

import type { MoverBox } from "@angels-bandits/common/city/movers";
import {
  type TrainLine,
  carBox,
  carOnCurve,
} from "@angels-bandits/common/city/train";
import {
  EMISSIVE_LAMP,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_STROBE,
  EMISSIVE_WINDOW,
  TRAIN_CAR_LIFT,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { MoverLights } from "./movers";

/** Program cache key for the patched train material — distinct from every
 * other key in the repo (three keys programs on onBeforeCompile.toString()
 * otherwise; see traffic.ts for the bug that caused). */
export const TRAIN_CACHE_KEY = "ab-train";

/** Viaduct concrete and the car body, as instance colours. */
const DECK_COLOR = new THREE.Color(0x6a6662);
const PILLAR_COLOR = new THREE.Color(0x57534f);
const CAR_COLOR = new THREE.Color(0xa7b0bb);

/** Warm cabin light through the windows, at the WINDOW rung. */
const WINDOW_COLOR = new THREE.Color(1.0, 0.86, 0.62);
const WINDOW_BOOST = emissiveBoost(WINDOW_COLOR, EMISSIVE_WINDOW);
/** Windows per car side. */
const WINDOWS_PER_CAR = 9;

/** Head lamps (LAMP rung), tail lamps (NAVLIGHT rung), sparks (STROBE). */
const HEAD = new THREE.Color(1.0, 0.95, 0.85);
const headBoost = HEAD.clone().multiplyScalar(
  emissiveBoost(HEAD, EMISSIVE_LAMP),
);
const TAIL = new THREE.Color(1.0, 0.1, 0.08);
const tailBoost = TAIL.clone().multiplyScalar(
  emissiveBoost(TAIL, EMISSIVE_NAVLIGHT),
);
const SPARK = new THREE.Color(1.0, 0.72, 0.32);
const sparkBoost = SPARK.clone().multiplyScalar(
  emissiveBoost(SPARK, EMISSIVE_STROBE),
);
/** A spark lives this long before the next one is drawn, ms. */
const SPARK_FRAME_MS = 45;
/** Sparks per car per spark frame on a curve (some frames draw fewer). */
const SPARKS_PER_CAR = 3;

const TRAIN_PARS = /* glsl */ `
varying vec3 vTrainPos;
varying vec3 vTrainNormal;
varying float vTrainWin;
`;

const TRAIN_VERTEX = /* glsl */ `
// Unit box scaled per instance: object space is [-0.5, 0.5] on every axis.
vTrainPos = position;
vTrainNormal = normal;
vTrainWin = aTrainWin;
`;

/** 1 on a lit window pane, 0 elsewhere (and always 0 on the concrete). */
const GLASS_FN = /* glsl */ `
float trainGlass() {
  if (vTrainWin < 0.5) return 0.0;
  float band = step(0.0, vTrainPos.y) * step(vTrainPos.y, 0.33);
  if (abs(vTrainNormal.z) > 0.5) {
    // The long sides: a row of panes with mullions between them.
    float cell = fract((vTrainPos.x + 0.5) * ${WINDOWS_PER_CAR.toFixed(1)});
    float pane = step(0.14, cell) * step(cell, 0.86);
    return band * pane * step(abs(vTrainPos.x), 0.46);
  }
  if (abs(vTrainNormal.x) > 0.5) {
    // The ends: one wide cab / gangway window.
    return band * step(abs(vTrainPos.z), 0.34);
  }
  return 0.0;
}
`;

const TRAIN_COLOR_FRAGMENT = /* glsl */ `
float trainPane = trainGlass();
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.05, 0.06), trainPane);
`;

const TRAIN_EMISSIVE_FRAGMENT = /* glsl */ `
// Each pane its own brightness, fixed per pane, so the row reads as
// different cabins rather than one strip light.
float trainCell = floor((vTrainPos.x + 0.5) * ${WINDOWS_PER_CAR.toFixed(1)});
float trainDim = 0.72 + 0.28 * fract(sin(trainCell * 12.9898 + vTrainPos.z * 4.0) * 43758.5453);
totalEmissiveRadiance += trainPane * trainDim * ${WINDOW_BOOST.toFixed(4)} *
  vec3(${WINDOW_COLOR.r.toFixed(4)}, ${WINDOW_COLOR.g.toFixed(4)}, ${WINDOW_COLOR.b.toFixed(4)});
`;

function createTrainMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.7,
    metalness: 0.25,
  });
  material.customProgramCacheKey = () => TRAIN_CACHE_KEY;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\nattribute float aTrainWin;\n${TRAIN_PARS}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${TRAIN_VERTEX}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\n${TRAIN_PARS}\n${GLASS_FN}`,
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

/**
 * The train renderer. One InstancedMesh, posed from the shared seam every
 * frame at the torus image nearest the camera.
 */
export class TrainRenderer {
  readonly mesh: THREE.InstancedMesh;
  /** The nearest car's rendered position this frame, for the rumble. Null
   * with no train, or before the server clock. */
  rumbleAt: Vec3 | null = null;
  /** Whether any car is rounding a curve this frame (wheel squeal). */
  squeal = false;

  private readonly line: TrainLine | null;
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly car: MoverBox = {
    x: 0,
    y: 0,
    z: 0,
    hx: 0,
    hy: 0,
    hz: 0,
    yaw: 0,
    kind: "train",
    id: 0,
  };
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly nearest: Vec3 = { x: 0, y: 0, z: 0 };
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(line: TrainLine | null) {
    this.line = line;
    const statics = line?.viaduct.length ?? 0;
    const count = Math.max(1, statics + (line?.cars ?? 0));
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const win = new Float32Array(count);
    for (let i = statics; i < count; i++) win[i] = 1;
    geometry.setAttribute(
      "aTrainWin",
      new THREE.InstancedBufferAttribute(win, 1),
    );
    this.mesh = new THREE.InstancedMesh(geometry, createTrainMaterial(), count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Instances move relative to the camera every frame.
    this.mesh.frustumCulled = false;
    this.mesh.visible = line !== null;
    for (let i = 0; i < count; i++) {
      const b = line?.viaduct[i];
      this.mesh.setColorAt(
        i,
        i >= statics
          ? CAR_COLOR
          : b && b.y < b.hy + 0.01
            ? PILLAR_COLOR
            : DECK_COLOR,
      );
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Instances drawn — the perf report's handle. */
  get instanceCount(): number {
    return this.mesh.count;
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

  /**
   * Pose the frame. `serverTimeMs` is main.ts's LATCHED render clock — the
   * same value the crash check uses. Null hides the cars (the viaduct stays).
   */
  update(camera: Vec3, serverTimeMs: number | null, lights: MoverLights): void {
    const line = this.line;
    this.rumbleAt = null;
    this.squeal = false;
    if (!line) return;
    const statics = line.viaduct.length;
    for (let i = 0; i < statics; i++) {
      this.put(i, line.viaduct[i] as MoverBox, camera);
    }
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < line.cars; i++) {
      if (serverTimeMs === null) {
        this.put(statics + i, this.car, camera, true);
        continue;
      }
      const b = carBox(line, i, serverTimeMs, this.car);
      this.put(statics + i, b, camera);

      const dx = wrapDeltaAxis(camera.x, b.x);
      const dz = wrapDeltaAxis(camera.z, b.z);
      const d2 = dx * dx + dz * dz + (b.y - camera.y) ** 2;
      if (d2 < best) {
        best = d2;
        this.nearest.x = camera.x + dx;
        this.nearest.y = b.y;
        this.nearest.z = camera.z + dz;
        this.rumbleAt = this.nearest;
      }

      if (i === 0) {
        // Twin head lamps low on the nose, a marker over the cab.
        for (const side of [-1, 1]) {
          lights.place(
            this.local(b, b.hx, -b.hy * 0.45, side * b.hz * 0.6, camera),
            headBoost,
            1.8,
          );
        }
        lights.place(
          this.local(b, b.hx, b.hy * 0.85, 0, camera),
          headBoost,
          1.1,
        );
      }
      if (i === line.cars - 1) {
        for (const side of [-1, 1]) {
          lights.place(
            this.local(b, -b.hx, -b.hy * 0.45, side * b.hz * 0.6, camera),
            tailBoost,
            1.5,
          );
        }
      }
      if (carOnCurve(line, i, serverTimeMs)) {
        this.squeal = true;
        // Sparks at the wheels: a fresh, seeded scatter every SPARK_FRAME_MS,
        // on the shared clock so every client throws the same spark.
        const frame = Math.floor(serverTimeMs / SPARK_FRAME_MS);
        for (let k = 0; k < SPARKS_PER_CAR; k++) {
          const r = hash01(frame, i, k);
          if (r < 0.25) continue; // a frame with a gap reads as crackle
          const bogie = (k % 2 === 0 ? 0.62 : -0.62) * b.hx;
          const side = hash01(frame, i, k + 7) < 0.5 ? -1 : 1;
          lights.place(
            this.local(
              b,
              bogie + (r - 0.5) * 2.4,
              -b.hy - TRAIN_CAR_LIFT * 0.5 + r * 0.5,
              side * (b.hz + 0.15),
              camera,
            ),
            sparkBoost,
            0.6 + r * 1.4,
          );
        }
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** QA read-back: the route, the cars' pure poses and whether they are on a
   * curve at a server time, plus the first car's drawn matrix position. */
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
    viaductBoxes: number;
    cars: { x: number; y: number; z: number; yaw: number; curve: boolean }[];
    drawnAt: Vec3 | null;
  } | null {
    const line = this.line;
    if (!line) return null;
    const cars =
      serverTimeMs === null
        ? []
        : Array.from({ length: line.cars }, (_, i) => {
            const b = carBox(line, i, serverTimeMs, { ...this.car });
            return {
              x: b.x,
              y: b.y,
              z: b.z,
              yaw: b.yaw,
              curve: carOnCurve(line, i, serverTimeMs),
            };
          });
    let drawnAt: Vec3 | null = null;
    if (serverTimeMs !== null) {
      this.mesh.getMatrixAt(line.viaduct.length, this.matrix);
      const e = this.matrix.elements;
      drawnAt = { x: e[12] ?? 0, y: e[13] ?? 0, z: e[14] ?? 0 };
    }
    return {
      route: {
        ox: line.ox,
        oz: line.oz,
        w: line.w,
        d: line.d,
        length: line.length,
        cars: line.cars,
        dir: line.dir,
      },
      viaductBoxes: line.viaduct.length,
      cars,
      drawnAt,
    };
  }
}
