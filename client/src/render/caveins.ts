// U6 cave-ins, THREE half: every piece of every live cave-in in the room's
// slot (common/src/city/caveins.ts) on the synced RENDER clock — the clock
// the crash check and the movers use, so the rock you see is the rock you
// hit.
//
// Draw == collide: each piece is drawn INSIDE exactly the box
// caveInPieceInto poses and collideCaveIns tests — a unit box scaled to its
// half extents, yawed and tumbled the same way — all of them in ONE
// InstancedMesh (one draw), placed at the torus image nearest the viewer.
//
// U7: broken rock, not cubes. The one shared mesh is a subdivided unit box
// that the vertex shader breaks per piece (a stable seed and the kind ride
// in `aRock`): edge and corner vertices are pulled INWARD only — in metres,
// so a long beam or a flat slab keeps its proportions — by at most
// ROCK_INSET of the piece's smallest half extent, and every face centre
// stays on its face. So the drawn rock is always inside its collision box
// and touches all six of its faces: the box's extents ARE the drawn
// extents. Rock is chunky and irregular, a slab is chipped concrete with
// aggregate, a beam keeps a clean 3 cm bevel and rusts. Unlit like the
// bores: the face light comes from the derivative normal, the rock /
// concrete / steel tint is the instance colour. Falling pieces trail dust;
// a beam that lands throws sparks.
//
// The warning and the impacts are particles in the D1 pool (impacts.ts —
// no draw of their own), capped per event: dust streaming and pebbles
// dropping from the cracks over the BLOCKED region only (so the open lane
// reads open), a puff where each piece lands, and one as the rubble
// settles away. The lamp flicker is underground.ts's (setCaveIns).
//
// Visibility parity (quality.ts rule 2): the pieces are solid, so every
// tier draws every one; only the dust follows the pool's tier share.
// Nothing is allocated per frame.

import {
  CAVEIN_CEIL,
  CAVEIN_MAX,
  CAVEIN_PIECES_MAX,
  CAVEIN_WARN_MS,
  type CaveIn,
  type CaveInSlot,
  PIECE_BEAM,
  PIECE_SLAB,
  blankCaveInPose,
  caveInPieceInto,
} from "@angels-bandits/common/city/caveins";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { type Impacts, Kind, SPARK_RGB } from "./impacts";
import { LOOK_NOISE_GLSL, TUNNEL_DETAIL } from "./tunnel-look";
import { nearestImageInto } from "./wrapPlacement";

/** Instances: every piece of the most cave-ins a room holds. */
export const CAVEIN_INSTANCES = CAVEIN_MAX * CAVEIN_PIECES_MAX;
/** Warning dust and pebbles per event, particles/s (at full share). */
const WARN_DUST_RATE = 28;
const WARN_PEBBLE_RATE = 12;
/** Particles per landing / settling puff, at most (full share) — one
 * puff per PUFF_EVERY pieces, so a 48-piece fall throws ~170 into the
 * shared pool, not the whole pool. */
const PUFF_DUST = 8;
const PUFF_CHIPS = 6;
const PUFF_EVERY = 4;
/** U7: dust trailed per falling piece, particles/s (full share), and the
 * most one event may trail in a frame. */
const TRAIL_RATE = 3;
const TRAIL_MAX = 6;
/** U7: sparks off a landing beam (full share). */
const BEAM_SPARKS = 10;

/** U7: the most an edge or corner is pulled in, as a fraction of the
 * piece's smallest half extent (rock; a slab half that, a beam a 3 cm
 * bevel under the same cap). */
export const ROCK_INSET = 0.4;
/** Program cache key (the rock shader). */
export const ROCK_CACHE_KEY = "ab-u7-rock";

/**
 * Mirror of the vertex shader's break: the unit-box vertex `p` (each axis
 * −0.5, 0 or +0.5) of a piece scaled `scale` (full extents, m) of `kind`
 * with `seed`, written into `out`. Only axes on a face move, only inward.
 */
export function rockVertexInto(
  p: readonly [number, number, number],
  scale: readonly [number, number, number],
  kind: number,
  seed: number,
  out: [number, number, number],
): [number, number, number] {
  const onFace = p.filter((v) => Math.abs(v) > 0.49).length;
  const minHalf = Math.min(scale[0], scale[1], scale[2]) / 2;
  const cap = ROCK_INSET * minHalf;
  for (let i = 0; i < 3; i++) {
    const v = p[i] as number;
    out[i] = v;
    if (onFace < 2 || Math.abs(v) < 0.49) continue;
    const h = rockHash(p, seed, i);
    const d =
      kind === PIECE_BEAM
        ? Math.min(0.03, cap)
        : kind === PIECE_SLAB
          ? cap * (0.15 + 0.35 * h)
          : cap * (0.3 + 0.7 * h) * (onFace === 3 ? 1 : 0.75);
    out[i] = v - Math.sign(v) * (d / (scale[i] as number));
  }
  return out;
}

/** Mirror of the shader's hash (fract-based, no sin). */
function rockHash(
  p: readonly [number, number, number],
  seed: number,
  axis: number,
): number {
  const fr = (x: number) => x - Math.floor(x);
  const cx = p[0] * 3 + p[1] * 5 + p[2] * 7 + axis * 11 + seed;
  const cy = seed * 0.37 + axis;
  let a = fr(cx * 0.1031);
  let b = fr(cy * 0.1031);
  let c = fr(cx * 0.1031);
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d;
  b += d;
  c += d;
  return fr((a + b) * c);
}

/** Linear tints (unlit; the shader's face light multiplies them). */
const TINT: Record<number, THREE.Color> = {
  0: new THREE.Color(0x8c7a64).multiplyScalar(0.9), // rock
  1: new THREE.Color(0xaaa59c).multiplyScalar(0.8), // concrete slab
  2: new THREE.Color(0x8e5434).multiplyScalar(0.85), // rusted steel beam
};
const DUST_RGB = [0.46, 0.42, 0.36] as const;
const CHIP_RGB = [0.38, 0.33, 0.27] as const;

/** U7: the shared mesh — a unit box, each face 2×2 quads (so every edge
 * has a midpoint to break and every face a centre to keep). */
function rockBox(): THREE.BoxGeometry {
  return new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
}

const ROCK_VERTEX_PARS = /* glsl */ `
attribute vec2 aRock;
flat varying float vRockKind;
varying vec3 vRockLocal;
varying vec3 vRockView;
float abRockHash(vec3 p, float seed, float axis) {
  vec2 c = vec2(dot(p, vec3(3.0, 5.0, 7.0)) + axis * 11.0 + seed, seed * 0.37 + axis);
  vec3 p3 = fract(vec3(c.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;
/** After begin_vertex: break the box (rockVertexInto, mirrored). */
const ROCK_VERTEX = /* glsl */ `
vec3 rockScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz),
  length(instanceMatrix[2].xyz));
float rockMinHalf = min(rockScale.x, min(rockScale.y, rockScale.z)) * 0.5;
float rockCap = ${ROCK_INSET.toFixed(3)} * rockMinHalf;
vec3 rockP = transformed;
vec3 rockOn = step(vec3(0.49), abs(rockP));
float rockFaces = rockOn.x + rockOn.y + rockOn.z;
float rockKind = floor(aRock.y + 0.5);
vRockKind = rockKind;
if (rockFaces > 1.5) {
  for (int i = 0; i < 3; i++) {
    float v = rockP[i];
    if (abs(v) < 0.49) continue;
    float h = abRockHash(rockP, aRock.x, float(i));
    float d = rockKind > 1.5 ? min(0.03, rockCap)
      : rockKind > 0.5 ? rockCap * (0.15 + 0.35 * h)
      : rockCap * (0.3 + 0.7 * h) * (rockFaces > 2.5 ? 1.0 : 0.75);
    transformed[i] = v - sign(v) * d / rockScale[i];
  }
}
vRockLocal = transformed * rockScale;
`;
const ROCK_VIEW = /* glsl */ `
vRockView = mvPosition.xyz;
`;
const ROCK_FRAGMENT_PARS = /* glsl */ `
flat varying float vRockKind;
varying vec3 vRockLocal;
varying vec3 vRockView;
${LOOK_NOISE_GLSL}
`;
/** After color_fragment: the tint lit by its flat face normal (light from
 * the crown lamps, a cool bounce below) and a surface grain per kind. */
const ROCK_FRAGMENT = /* glsl */ `
vec3 rockN = abSafeNormal(cross(dFdx(vRockView), dFdy(vRockView)), vec3(0.0, 0.0, 1.0));
vec2 rockUV = vec2(vRockLocal.x + vRockLocal.z * 0.7, vRockLocal.y + vRockLocal.z * 0.4);
vec2 rockFw = fwidth(rockUV);
float rockPx = max(max(rockFw.x, rockFw.y), 1e-4);
vec3 rockL = normalize((viewMatrix * vec4(0.3, 1.0, 0.2, 0.0)).xyz);
float rockLit = 0.36 + 0.64 * max(dot(rockN, rockL), 0.0)
  + 0.12 * max(-dot(rockN, rockL), 0.0);
float rockK = floor(vRockKind + 0.5);
vec3 rockG = abFbm(rockUV, rockK > 0.5 ? 3.0 : 1.2, rockPx);
float rockGrain = rockK > 1.5
  ? 0.85 + 0.45 * abNoiseD(rockUV * vec2(0.6, 2.5)).x // rust streaks
  : rockK > 0.5 ? 0.9 + 0.5 * rockG.x                 // aggregate
  : 0.8 + 0.6 * rockG.x;                              // broken rock
diffuseColor.rgb = abUnderClamp(diffuseColor.rgb * rockLit * rockGrain);
`;

/** Per-event effect state: dust emitted so far, pieces landed, settled. */
interface FxState {
  dust: number;
  pebbles: number;
  landed: Uint8Array;
  settled: boolean;
  seen: number;
  /** U7: dust trailed so far (fractional particles). */
  trail: number;
}

export class CaveInRenderer {
  readonly mesh: THREE.InstancedMesh;
  /** U7: per drawn slot, (seed, kind) — rewritten every frame with the
   * matrices, so a reused slot never keeps another piece's shape. */
  private readonly rock: THREE.InstancedBufferAttribute;
  private readonly pose = blankCaveInPose();
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly qTumble = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly down: Vec3 = { x: 0, y: -1, z: 0 };
  private readonly up: Vec3 = { x: 0, y: 1, z: 0 };
  private readonly fx = new Map<number, FxState>();
  private frame = 0;
  /** QA (__ab.caveIns): pieces drawn last frame. */
  readonly stats = { pieces: 0, events: 0 };

  constructor(private readonly impacts: Impacts) {
    const geometry = rockBox();
    this.rock = new THREE.InstancedBufferAttribute(
      new Float32Array(CAVEIN_INSTANCES * 2),
      2,
    );
    this.rock.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aRock", this.rock);
    const material = new THREE.MeshBasicMaterial({ fog: true });
    material.customProgramCacheKey = () => ROCK_CACHE_KEY;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTunnelDetail = TUNNEL_DETAIL;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${ROCK_VERTEX_PARS}`)
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${ROCK_VERTEX}`,
        )
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>\n${ROCK_VIEW}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\n${ROCK_FRAGMENT_PARS}`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>\n${ROCK_FRAGMENT}`,
        );
    };
    this.mesh = new THREE.InstancedMesh(geometry, material, CAVEIN_INSTANCES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // instanceColor exists from the first setColorAt; make it now so the
    // program compiles with it at boot (prewarm).
    for (let i = 0; i < CAVEIN_INSTANCES; i++) {
      this.mesh.setColorAt(i, TINT[0] as THREE.Color);
    }
    this.mesh.count = 0;
    // Posed at the torus image nearest the camera every frame.
    this.mesh.frustumCulled = false;
    // Opaque after the bores' shell, like U5's decor.
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  /** Per frame: every visible piece at `renderMs` (null: no clock yet —
   * nothing drawn, as nothing is solid), and the dust. `dt` s since the
   * last frame (real time: emission must not starve on a slow frame). */
  update(
    slot: CaveInSlot,
    viewer: Vec3,
    renderMs: number | null,
    dt: number,
    now: number,
  ): void {
    let n = 0;
    this.frame++;
    if (renderMs !== null) {
      const list = slot.list;
      for (let e = 0; e < list.length; e++) {
        const c = list[e] as CaveIn;
        if (renderMs < c.t0 || renderMs >= c.t0 + c.endMs) continue;
        const fx = this.fxOf(c, renderMs);
        fx.seen = this.frame;
        this.dust(c, fx, renderMs, dt, now);
        // U7: this frame's dust trail budget for the event (whole particles).
        fx.trail += TRAIL_RATE * c.n * Math.min(0.25, dt);
        let trailEmit = Math.min(TRAIL_MAX, Math.floor(fx.trail));
        fx.trail -= trailEmit;
        let trailing = 0;
        for (let i = 0; i < c.n && n < CAVEIN_INSTANCES; i++) {
          const p = caveInPieceInto(c, i, renderMs, this.pose);
          if (!p.visible) continue;
          this.place(p.x, p.y, p.z, viewer);
          this.quat.setFromAxisAngle(Y_AXIS, p.yaw);
          this.qTumble.setFromAxisAngle(p.axis === 0 ? X_AXIS : Z_AXIS, p.phi);
          this.quat.multiply(this.qTumble);
          this.scale.set(2 * p.hx, 2 * p.hy, 2 * p.hz);
          this.matrix.compose(this.pos, this.quat, this.scale);
          this.mesh.setMatrixAt(n, this.matrix);
          this.mesh.setColorAt(n, TINT[c.kind[i] as number] as THREE.Color);
          this.rock.setXY(
            n,
            (c.id % 997) * 1.37 + i * 2.71,
            c.kind[i] as number,
          );
          n++;
          if (p.falling) {
            trailing++;
          } else if (!(fx.landed[i] as number)) {
            fx.landed[i] = 1;
            if (i % PUFF_EVERY === 0) {
              this.puff(p.x, p.y - p.hy, p.z, c.kind[i] as number, now);
            }
            if ((c.kind[i] as number) === PIECE_BEAM) {
              this.sparks(p.x, p.y - p.hy, p.z, now);
            }
          }
          // U7: dust off a falling piece, at a capped rate per event.
          if (p.falling && trailEmit > 0 && i % 2 === 0) {
            trailEmit--;
            this.trailAt(p.x, p.y + p.hy, p.z, now);
          }
        }
        if (trailing === 0) fx.trail = 0;
        if (!fx.settled && renderMs >= c.t0 + c.clearMs) {
          fx.settled = true;
          for (let i = 0; i < c.n; i += 2 * PUFF_EVERY) {
            this.puff(
              c.px[i] as number,
              (c.yRest[i] as number) - (c.restHy[i] as number),
              c.pz[i] as number,
              PIECE_SLAB,
              now,
            );
          }
        }
      }
    }
    // Forget events no longer drawn (allocation only when one ends).
    if (this.fx.size > 0) {
      for (const [id, s] of this.fx)
        if (s.seen !== this.frame) this.fx.delete(id);
    }
    this.mesh.count = n;
    // No piece, no draw (three issues a counted draw for count 0).
    this.mesh.visible = n > 0;
    this.stats.pieces = n;
    this.stats.events = this.fx.size;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      this.rock.needsUpdate = true;
    }
  }

  private fxOf(c: CaveIn, renderMs: number): FxState {
    let s = this.fx.get(c.id);
    if (!s) {
      s = {
        dust: 0,
        pebbles: 0,
        landed: new Uint8Array(c.n),
        settled: renderMs >= c.t0 + c.clearMs,
        seen: this.frame,
        trail: 0,
      };
      // A late joiner (or a resume) finds rubble already down: no puffs.
      for (let i = 0; i < c.n; i++) {
        if (!caveInPieceInto(c, i, renderMs, this.pose).falling) {
          s.landed[i] = 1;
        }
      }
      this.fx.set(c.id, s);
    }
    return s;
  }

  /** `this.pos` = the image of canonical (x, y, z) nearest the viewer. */
  private place(x: number, y: number, z: number, viewer: Vec3): void {
    this.at.x = x;
    this.at.y = y;
    this.at.z = z;
    nearestImageInto(this.at, viewer, this.at);
    this.pos.set(this.at.x, this.at.y, this.at.z);
  }

  /** The warning: dust streams and pebbles from cracks over the pieces
   * (the blocked region), on a fixed rate per event. */
  private dust(
    c: CaveIn,
    fx: FxState,
    renderMs: number,
    dt: number,
    now: number,
  ): void {
    const ms = renderMs - c.t0;
    if (ms > CAVEIN_WARN_MS + 400 || c.n === 0) return;
    fx.dust += WARN_DUST_RATE * Math.min(0.25, dt);
    fx.pebbles += WARN_PEBBLE_RATE * Math.min(0.25, dt);
    while (fx.dust >= 1) {
      fx.dust -= 1;
      this.crack(c, Math.floor(Math.random() * c.n));
      this.impacts.spray(
        Kind.DUST,
        this.at,
        this.down,
        2.5,
        0.35,
        1,
        2200,
        1.6,
        DUST_RGB,
        now,
      );
    }
    while (fx.pebbles >= 1) {
      fx.pebbles -= 1;
      this.crack(c, Math.floor(Math.random() * c.n));
      this.impacts.spray(
        Kind.CHIP,
        this.at,
        this.down,
        1.5,
        0.3,
        1,
        1800,
        0.22,
        CHIP_RGB,
        now,
      );
    }
  }

  /** `this.at` = a crack point in the ceiling over piece `i`. */
  private crack(c: CaveIn, i: number): void {
    const h = Math.min(c.hx[i] as number, c.hz[i] as number) * 0.8;
    this.at.x = (c.px[i] as number) + (Math.random() - 0.5) * h;
    this.at.y = CAVEIN_CEIL - 0.4;
    this.at.z = (c.pz[i] as number) + (Math.random() - 0.5) * h;
  }

  /** U7: a wisp of dust left behind a falling piece. */
  private trailAt(x: number, y: number, z: number, now: number): void {
    this.at.x = x;
    this.at.y = y;
    this.at.z = z;
    this.impacts.spray(
      Kind.DUST,
      this.at,
      this.up,
      1.2,
      0.6,
      1,
      1800,
      1.4,
      DUST_RGB,
      now,
    );
  }

  /** U7: sparks where a steel beam strikes the floor. */
  private sparks(x: number, y: number, z: number, now: number): void {
    this.at.x = x;
    this.at.y = y + 0.1;
    this.at.z = z;
    this.impacts.spray(
      Kind.SPARK,
      this.at,
      this.up,
      9,
      1.1,
      BEAM_SPARKS,
      700,
      0.12,
      SPARK_RGB,
      now,
    );
  }

  /** Dust and chips thrown up where a piece comes down. */
  private puff(x: number, y: number, z: number, kind: number, now: number) {
    this.at.x = x;
    this.at.y = y + 0.3;
    this.at.z = z;
    const big = kind === PIECE_BEAM ? 0.7 : 1;
    this.impacts.spray(
      Kind.DUST,
      this.at,
      this.up,
      3,
      1.2,
      Math.round(PUFF_DUST * big),
      2600,
      2.2,
      DUST_RGB,
      now,
    );
    this.impacts.spray(
      Kind.CHIP,
      this.at,
      this.up,
      5,
      1,
      Math.round(PUFF_CHIPS * big),
      1400,
      0.25,
      CHIP_RGB,
      now,
    );
  }
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
