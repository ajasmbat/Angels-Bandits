// C2 bomber runs, THREE half: every formation in the room's bomber slot
// (common/src/chaos.ts) on the synced RENDER clock — the clock the crash
// check and the movers use, so the ship you see is the ship you hit.
//
// Draw == collide: every box drawn here comes from bomberPartBoxInto, the
// derivation collideBombers tests — all ships' boxes in one InstancedMesh
// (1 draw), placed at the torus image nearest the viewer. Nav lights and the
// belly strobe are one Points (1 draw). A ship shot down bursts into the D1
// pool (the tier's chaosFx share) and stops being drawn — and solid — at
// that instant, exactly as the slot says. Nothing is allocated per frame.
//
// Visibility parity (quality.ts rule 2): the hulls and their lights — solid
// things — are the same on every tier.

import {
  BOMBER_COUNT,
  BOMBER_PARTS,
  type BomberRun,
  type BomberSlot,
  blankBomberPose,
  bomberAlive,
  bomberDownAt,
  bomberPartBoxInto,
  bomberPoseInto,
} from "@angels-bandits/common/chaos";
import type { MoverBox } from "@angels-bandits/common/city/movers";
import {
  EMISSIVE_NAVLIGHT,
  EMISSIVE_STROBE,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { boxMatrixInto } from "./boss";
import { emissiveBoost } from "./emissive";
import type { Impacts } from "./impacts";
import { nearestImageInto } from "./wrapPlacement";

/** Formations drawn at once (the server flies one; a welcome tail or a
 * resume can briefly hold two). */
export const BOMBER_RUNS_DRAWN = 2;
const SHIPS = BOMBER_RUNS_DRAWN * BOMBER_COUNT;
const HULL = 0x2b3038;
/** Per ship: port red and starboard green wingtips, a white tail, and the
 * red belly strobe. */
const LIGHTS_PER_SHIP = 4;
const NAV_SIZE_PX = 5;
const STROBE_PERIOD_MS = 1100;
const STROBE_ON_MS = 90;
/** Each light's colour boosted to its emissive rung, once. */
const lit = (hex: number, rung: number): THREE.Color => {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(emissiveBoost(c, rung));
};
const PORT_LIT = lit(0xff2a20, EMISSIVE_NAVLIGHT);
const STARBOARD_LIT = lit(0x2aff5a, EMISSIVE_NAVLIGHT);
const WHITE_LIT = lit(0xffffff, EMISSIVE_NAVLIGHT);
const STROBE_LIT = lit(0xff2a20, EMISSIVE_STROBE);
const PARKED_Y = -9999;
/** A ship going down: flames and smoke into the D1 pool at full share. */
const BURST_FIRE = 40;
const BURST_SMOKE = 24;

const scratchAt: Vec3 = { x: 0, y: 0, z: 0 };

export class BomberRenderer {
  readonly group = new THREE.Group();
  private readonly hulls: THREE.InstancedMesh;
  private readonly lights: THREE.Points;
  private readonly lightPos: THREE.BufferAttribute;
  private readonly lightCol: THREE.BufferAttribute;
  private readonly box: MoverBox = {
    x: 0,
    y: 0,
    z: 0,
    hx: 0,
    hy: 0,
    hz: 0,
    yaw: 0,
    kind: "bomber",
    id: 0,
  };
  private readonly pose = blankBomberPose();
  private readonly matrix = new THREE.Matrix4();
  private share = 1;
  /** QA (__ab.chaos): ship boxes and lights drawn last frame. */
  readonly stats = { boxes: 0, lights: 0 };
  /** A1: last frame drew a hull or a light (its buffers need one more upload). */
  private lastLive = true;
  /** Downs already burst here, by `run:k` (a ship bursts once). */
  private readonly burst = new Set<string>();

  constructor(
    private readonly impacts: Impacts,
    /** A ship went down at `at` (main: blast, sound). */
    private readonly onDown: (at: Vec3) => void,
  ) {
    this.hulls = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: HULL,
        roughness: 0.6,
        metalness: 0.5,
      }),
      SHIPS * BOMBER_PARTS.length,
    );
    this.hulls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.hulls.count = 0;
    // Posed at the torus image nearest the camera every frame.
    this.hulls.frustumCulled = false;

    const g = new THREE.BufferGeometry();
    const n = SHIPS * LIGHTS_PER_SHIP;
    this.lightPos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.lightCol = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    for (let i = 0; i < n; i++) this.lightPos.setXYZ(i, 0, PARKED_Y, 0);
    g.setAttribute("position", this.lightPos);
    g.setAttribute("color", this.lightCol);
    this.lights = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        size: NAV_SIZE_PX,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.lights.frustumCulled = false;
    this.group.add(this.hulls, this.lights);
  }

  /** Quality row (chaosFx): share of a downed ship's flames and smoke. */
  setQuality(share: number): void {
    this.share = Math.max(0, Math.min(1, share));
  }

  /** Per frame: every live ship of every run at `renderMs` (null: no clock
   * yet — nothing drawn), and a burst for each ship that went down. */
  update(
    slot: BomberSlot,
    viewer: Vec3,
    renderMs: number | null,
    now: number,
  ): void {
    let parts = 0;
    let lights = 0;
    if (renderMs !== null) {
      let runs = 0;
      for (const run of slot.runs) {
        if (runs >= BOMBER_RUNS_DRAWN) break;
        runs++;
        for (let k = 0; k < BOMBER_COUNT; k++) {
          this.maybeBurst(slot, run, k, renderMs, now);
          if (!bomberAlive(slot, run, k, renderMs)) continue;
          bomberPoseInto(run, k, renderMs, this.pose);
          for (let i = 0; i < BOMBER_PARTS.length; i++) {
            bomberPartBoxInto(this.pose, i, this.box);
            boxMatrixInto(this.box, viewer, this.matrix);
            this.hulls.setMatrixAt(parts++, this.matrix);
          }
          lights = this.placeLights(lights, viewer, renderMs);
        }
      }
    }
    for (let i = lights; i < SHIPS * LIGHTS_PER_SHIP; i++) {
      if (this.lightPos.getY(i) !== PARKED_Y) {
        this.lightPos.setXYZ(i, 0, PARKED_Y, 0);
      }
    }
    this.hulls.count = parts;
    // P4: no ship, no light draw (its parked points drew every frame).
    this.lights.visible = lights > 0;
    this.stats.boxes = parts;
    this.stats.lights = lights;
    // A1: no bomber up, nothing to upload — but the frame the sky empties
    // still uploads once (its parked lights).
    if (parts > 0 || lights > 0 || this.lastLive) {
      this.hulls.instanceMatrix.needsUpdate = true;
      this.lightPos.needsUpdate = true;
      this.lightCol.needsUpdate = true;
    }
    this.lastLive = parts > 0 || lights > 0;
  }

  /** The current ship's wingtips, tail and strobe, from `this.pose`. */
  private placeLights(from: number, viewer: Vec3, renderMs: number): number {
    const strobe = renderMs % STROBE_PERIOD_MS < STROBE_ON_MS;
    this.putLight(from, 1.5, 0.3, -15.2, PORT_LIT, viewer, true);
    this.putLight(from + 1, 1.5, 0.3, 15.2, STARBOARD_LIT, viewer, true);
    this.putLight(from + 2, -11.2, 0.4, 0, WHITE_LIT, viewer, true);
    this.putLight(from + 3, 0, -2, 0, STROBE_LIT, viewer, strobe);
    return from + LIGHTS_PER_SHIP;
  }

  /** Light `i` at ship-frame (lx, ly, lz) of `this.pose` (parked when off). */
  private putLight(
    i: number,
    lx: number,
    ly: number,
    lz: number,
    color: THREE.Color,
    viewer: Vec3,
    on: boolean,
  ): void {
    if (!on) {
      this.lightPos.setXYZ(i, 0, PARKED_Y, 0);
      return;
    }
    const p = this.pose;
    const c = Math.cos(p.yaw);
    const s = Math.sin(p.yaw);
    scratchAt.x = p.x + lx * c + lz * s;
    scratchAt.y = p.y + ly;
    scratchAt.z = p.z - lx * s + lz * c;
    const img = nearestImageInto(scratchAt, viewer, scratchAt);
    this.lightPos.setXYZ(i, img.x, img.y, img.z);
    this.lightCol.setXYZ(i, color.r, color.g, color.b);
  }

  /** Ship `k` of `run` went down by `renderMs`: burst it, once. */
  private maybeBurst(
    slot: BomberSlot,
    run: BomberRun,
    k: number,
    renderMs: number,
    now: number,
  ): void {
    const at = bomberDownAt(slot, run.id, k);
    if (!(renderMs >= at)) return;
    const key = `${run.id}:${k}`;
    if (this.burst.has(key)) return;
    this.burst.add(key);
    if (this.burst.size > 64) {
      const first = this.burst.values().next().value;
      if (first !== undefined) this.burst.delete(first);
    }
    bomberPoseInto(run, k, at, this.pose);
    const where = { x: this.pose.x, y: this.pose.y, z: this.pose.z };
    this.onDown(where);
    const fire = Math.round(BURST_FIRE * this.share);
    const smoke = Math.round(BURST_SMOKE * this.share);
    if (fire + smoke > 0) this.impacts.wreckFire(where, fire, smoke, 8, now);
  }
}
