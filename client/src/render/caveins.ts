// U6 cave-ins, THREE half: every piece of every live cave-in in the room's
// slot (common/src/city/caveins.ts) on the synced RENDER clock — the clock
// the crash check and the movers use, so the rock you see is the rock you
// hit.
//
// Draw == collide: each piece is drawn as exactly the box caveInPieceInto
// poses and collideCaveIns tests — a unit box scaled to its half extents,
// yawed and tumbled the same way — all of them in ONE InstancedMesh (one
// draw), placed at the torus image nearest the viewer. Unlit like the bores
// (tunnels.ts, underground.ts): per-face light is baked into the box's
// vertex colours, the rock / concrete / steel tint is the instance colour.
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
import { type Impacts, Kind } from "./impacts";
import { nearestImageInto } from "./wrapPlacement";

/** Instances: every piece of the most cave-ins a room holds. */
export const CAVEIN_INSTANCES = CAVEIN_MAX * CAVEIN_PIECES_MAX;
/** Warning dust and pebbles per event, particles/s (at full share). */
const WARN_DUST_RATE = 28;
const WARN_PEBBLE_RATE = 12;
/** Particles per landing / settling puff, at most (full share). */
const PUFF_DUST = 14;
const PUFF_CHIPS = 10;

/** Linear tints (unlit; the baked face light multiplies them). */
const TINT: Record<number, THREE.Color> = {
  0: new THREE.Color(0x6e6254).multiplyScalar(0.62), // rock
  1: new THREE.Color(0x9a958c).multiplyScalar(0.6), // concrete slab
  2: new THREE.Color(0x7a4a32).multiplyScalar(0.62), // rusted steel beam
};
const DUST_RGB = [0.46, 0.42, 0.36] as const;
const CHIP_RGB = [0.38, 0.33, 0.27] as const;

/** A unit box whose faces carry baked light: top bright, sides mid,
 * bottom dark (three's BoxGeometry face order: +x, −x, +y, −y, +z, −z). */
function shadedBox(): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const light = [0.82, 0.7, 1, 0.45, 0.76, 0.64];
  const col = new Float32Array(24 * 3);
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const k = light[f] as number;
      col.set([k, k, k], (f * 4 + v) * 3);
    }
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/** Per-event effect state: dust emitted so far, pieces landed, settled. */
interface FxState {
  dust: number;
  pebbles: number;
  landed: Uint8Array;
  settled: boolean;
  seen: number;
}

export class CaveInRenderer {
  readonly mesh: THREE.InstancedMesh;
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
    this.mesh = new THREE.InstancedMesh(
      shadedBox(),
      new THREE.MeshBasicMaterial({ vertexColors: true, fog: true }),
      CAVEIN_INSTANCES,
    );
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
          n++;
          if (!p.falling && !(fx.landed[i] as number)) {
            fx.landed[i] = 1;
            this.puff(p.x, p.y - p.hy, p.z, c.kind[i] as number, now);
          }
        }
        if (!fx.settled && renderMs >= c.t0 + c.clearMs) {
          fx.settled = true;
          for (let i = 0; i < c.n; i += 3) {
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
    fx.dust += WARN_DUST_RATE * Math.min(0.1, dt);
    fx.pebbles += WARN_PEBBLE_RATE * Math.min(0.1, dt);
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
