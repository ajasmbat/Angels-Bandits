// X1 missile strikes, THREE half: every missile in the air as one instanced
// body (1 draw) plus one red glint Points (1 draw) that reads from far off
// through the haze, its smoke trail through the wounded-plane SmokeTrails,
// and the impact's debris throw. Positions come from the shared pure arc
// (common/src/strike.ts missilePosAt) on the synced render clock and are
// placed at the torus image nearest the viewer every frame.
//
// Visibility parity (quality.ts rule 2): the body, glint and trail are the
// telegraph — identical on every tier. Only the debris throw scales.

import { EMISSIVE_BEACON } from "@angels-bandits/common/constants";
import {
  type MissileStrike,
  missilePosAt,
} from "@angels-bandits/common/strike";
import { type Vec3, wrapDeltaInto } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { Impacts } from "./impacts";
import type { SmokeTrails } from "./smoke";
import { nearestImageInto } from "./wrapPlacement";

/** Most missiles drawn at once (the server caps the air at 3; a welcome
 * replay can briefly hold a few more). */
export const MISSILE_POOL = 6;
const BODY_LENGTH = 4.2;
const BODY_RADIUS = 0.32;
const BODY_COLOR = 0x26262c;
/** The glint: a hot red seeker/exhaust point, beacon rung — never brighter
 * than tracers (the emissive ladder), never violet like the storm. */
const GLINT_COLOR = new THREE.Color(0xff2a14);
const GLINT_SIZE_PX = 7;
const PARKED_Y = -9999;

/** Surface normal at an impact, for the debris throw: up for a roof or the
 * street, else facing back along the missile's last approach. */
function impactNormal(m: MissileStrike, out: Vec3): Vec3 {
  if (m.to.y <= 0.5) {
    out.x = 0;
    out.y = 1;
    out.z = 0;
    return out;
  }
  wrapDeltaInto(m.to, m.from, out);
  const len = Math.hypot(out.x, out.z) || 1;
  out.x /= len;
  out.z /= len;
  out.y = 0.35;
  return out;
}

export class MissileRenderer {
  readonly group = new THREE.Group();
  private readonly bodies: THREE.InstancedMesh;
  private readonly glints: THREE.Points;
  private readonly glintPos: THREE.BufferAttribute;
  private readonly dummy = new THREE.Object3D();
  private readonly pos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly ahead: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly img: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly normal: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly trailKeys = new Map<number, string>();
  /** The quality row's debris share (missileDebris). */
  private debris = 1;

  constructor(
    private readonly smoke: SmokeTrails,
    private readonly impacts: Impacts,
  ) {
    const geo = new THREE.CylinderGeometry(
      BODY_RADIUS * 0.6,
      BODY_RADIUS,
      BODY_LENGTH,
      8,
    );
    geo.rotateX(Math.PI / 2); // narrow nose along +Z: lookAt points it ahead
    this.bodies = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({ color: BODY_COLOR }),
      MISSILE_POOL,
    );
    this.bodies.count = 0;
    this.bodies.frustumCulled = false;
    this.group.add(this.bodies);

    const g = new THREE.BufferGeometry();
    this.glintPos = new THREE.BufferAttribute(
      new Float32Array(MISSILE_POOL * 3),
      3,
    );
    for (let i = 0; i < MISSILE_POOL; i++) {
      this.glintPos.setXYZ(i, 0, PARKED_Y, 0);
    }
    g.setAttribute("position", this.glintPos);
    const color = GLINT_COLOR.clone().multiplyScalar(
      emissiveBoost(GLINT_COLOR, EMISSIVE_BEACON),
    );
    this.glints = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color,
        size: GLINT_SIZE_PX,
        sizeAttenuation: false,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // The telegraph reads through the haze: seen from far, on every tier.
        fog: false,
      }),
    );
    this.glints.frustumCulled = false;
    this.group.add(this.glints);
  }

  /** Quality row (missileDebris): share of the impact debris throw. */
  setQuality(debris: number): void {
    this.debris = Math.max(0, Math.min(1, debris));
  }

  /** Place every flying missile for this frame and feed its smoke trail. */
  update(
    flying: readonly MissileStrike[],
    viewer: Vec3,
    renderMs: number,
    now: number,
  ): void {
    const n = Math.min(flying.length, MISSILE_POOL);
    for (let i = 0; i < n; i++) {
      const m = flying[i] as MissileStrike;
      missilePosAt(m, renderMs, this.pos);
      missilePosAt(m, renderMs + 40, this.ahead);
      nearestImageInto(this.img, viewer, this.pos);
      wrapDeltaInto(this.pos, this.ahead, this.dir);
      this.dummy.position.set(this.img.x, this.img.y, this.img.z);
      this.dummy.lookAt(
        this.img.x + this.dir.x,
        this.img.y + this.dir.y,
        this.img.z + this.dir.z,
      );
      this.dummy.updateMatrix();
      this.bodies.setMatrixAt(i, this.dummy.matrix);
      this.glintPos.setXYZ(i, this.img.x, this.img.y, this.img.z);
      this.smoke.sync(this.trailKey(m.id), this.pos, now, true);
    }
    for (let i = n; i < MISSILE_POOL; i++) {
      if (this.glintPos.getY(i) !== PARKED_Y) {
        this.glintPos.setXYZ(i, 0, PARKED_Y, 0);
      }
    }
    this.bodies.count = n;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.glintPos.needsUpdate = true;
  }

  /** A missile landed: its trail stops feeding (and fades on its own), and
   * the debris throws out of the struck surface. */
  impact(m: MissileStrike, now: number): void {
    const key = this.trailKey(m.id);
    this.smoke.sync(key, m.to, now, false);
    this.trailKeys.delete(m.id);
    if (this.debris > 0) {
      this.impacts.missileDebris(
        m.to,
        impactNormal(m, this.normal),
        this.debris,
        now,
      );
    }
  }

  /** One stable trail id per missile (no per-frame string building). */
  private trailKey(id: number): string {
    let key = this.trailKeys.get(id);
    if (key === undefined) {
      key = `missile:${id}`;
      this.trailKeys.set(id, key);
    }
    return key;
  }
}
