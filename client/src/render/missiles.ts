// X1 missile strikes, THREE half: every missile in the air as one instanced
// body (1 draw) plus one red glint Points (1 draw) that reads from far off
// through the haze, its smoke trail through the wounded-plane SmokeTrails,
// and the impact's debris throw. Positions come from the shared pure arc
// (common/src/strike.ts missilePosAt) on the synced render clock and are
// placed at the torus image nearest the viewer every frame.
//
// Visibility parity (quality.ts rule 2): the body, glint and trail are the
// telegraph — identical on every tier. Only the debris throw scales.
//
// C2: meteors and bombs fly the same pipeline. A meteor is a glowing
// fireball (its own instanced mesh, 1 draw) with a big orange glint that
// reads from anywhere in the city (fog-free, 1 draw) and a fire trail
// through the D1 particle pool (the tier's `chaosFx` share — cosmetic; the
// fireball and glint are the telegraph, on every tier). A bomb is a short,
// fat body with the red glint and no smoke trail (a carpet of 24 trails
// would starve the planes' wound smoke).

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

/** Most strikes drawn at once: C2's worst case is 8 missiles, a couple of
 * meteors and a formation's falling bombs (three ships, ~3 each in the air)
 * — 48 leaves a welcome replay room to spare. Past it a strike is skipped
 * for that frame only (its glint first: never in practice). */
export const MISSILE_POOL = 48;
/** Meteor fireballs drawn at once. */
export const METEOR_POOL = 8;
const METEOR_RADIUS = 2.6;
/** The fireball's core and its glint: hot orange on the beacon rung. */
const METEOR_COLOR = new THREE.Color(0xff8a2a);
const METEOR_GLINT_SIZE_PX = 18;
/** Fire particles a meteor sheds per second at full share. */
const METEOR_FIRE = 70;
const METEOR_SMOKE = 18;
/** A bomb's body: the missile cylinder squashed short and fat. */
const BOMB_SCALE_XY = 1.6;
const BOMB_SCALE_Z = 0.5;
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
  /** C2: the meteors' fireballs and glints, and the tier's chaosFx share. */
  private readonly meteors: THREE.InstancedMesh;
  private readonly meteorGlints: THREE.Points;
  private readonly meteorGlintPos: THREE.BufferAttribute;
  private chaosFx = 1;
  private readonly fireAcc = new Map<number, number>();
  /** QA (__ab.chaos): missile/bomb bodies and meteors drawn last frame. */
  readonly stats = { bodies: 0, meteors: 0 };
  /** A1: last frame's live counts (an emptied pool uploads once more). */
  private lastBodies = 1;
  private lastMeteors = 1;
  private lastMs = Number.NaN;

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

    // C2 meteors: a fireball and a big fog-free glint.
    const core = METEOR_COLOR.clone().multiplyScalar(
      emissiveBoost(METEOR_COLOR, EMISSIVE_BEACON),
    );
    this.meteors = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(METEOR_RADIUS, 1),
      new THREE.MeshBasicMaterial({ color: core }),
      METEOR_POOL,
    );
    this.meteors.count = 0;
    this.meteors.frustumCulled = false;
    this.group.add(this.meteors);
    const mg = new THREE.BufferGeometry();
    this.meteorGlintPos = new THREE.BufferAttribute(
      new Float32Array(METEOR_POOL * 3),
      3,
    );
    for (let i = 0; i < METEOR_POOL; i++) {
      this.meteorGlintPos.setXYZ(i, 0, PARKED_Y, 0);
    }
    mg.setAttribute("position", this.meteorGlintPos);
    this.meteorGlints = new THREE.Points(
      mg,
      new THREE.PointsMaterial({
        color: core,
        size: METEOR_GLINT_SIZE_PX,
        sizeAttenuation: false,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // Visible city-wide, on every tier: the meteor's telegraph.
        fog: false,
      }),
    );
    this.meteorGlints.frustumCulled = false;
    this.group.add(this.meteorGlints);
  }

  /** Quality rows: missileDebris (share of the impact debris throw) and
   * C2's chaosFx (share of a meteor's fire trail). */
  setQuality(debris: number, chaosFx = 1): void {
    this.debris = Math.max(0, Math.min(1, debris));
    this.chaosFx = Math.max(0, Math.min(1, chaosFx));
  }

  /** Place every flying missile for this frame and feed its smoke trail. */
  update(
    flying: readonly MissileStrike[],
    viewer: Vec3,
    renderMs: number,
    now: number,
  ): void {
    const dt = Number.isFinite(this.lastMs)
      ? Math.min(0.1, Math.max(0, (now - this.lastMs) / 1000))
      : 0;
    this.lastMs = now;
    let n = 0;
    let nm = 0;
    for (let f = 0; f < flying.length; f++) {
      const m = flying[f] as MissileStrike;
      const meteor = m.kind === "meteor";
      if (meteor ? nm >= METEOR_POOL : n >= MISSILE_POOL) continue;
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
      if (meteor) {
        this.dummy.scale.set(1, 1, 1.6); // stretched along its streak
        this.dummy.updateMatrix();
        this.meteors.setMatrixAt(nm, this.dummy.matrix);
        this.meteorGlintPos.setXYZ(nm, this.img.x, this.img.y, this.img.z);
        nm++;
        // The fire trail, through the D1 pool (cosmetic: scales).
        const acc =
          (this.fireAcc.get(m.id) ?? 0) + METEOR_FIRE * this.chaosFx * dt;
        const fire = Math.floor(acc);
        this.fireAcc.set(m.id, acc - fire);
        if (fire > 0) {
          this.impacts.wreckFire(
            this.pos,
            fire,
            Math.round((fire * METEOR_SMOKE) / METEOR_FIRE),
            METEOR_RADIUS,
            now,
          );
        }
        continue;
      }
      const bomb = m.kind === "bomb";
      if (bomb)
        this.dummy.scale.set(BOMB_SCALE_XY, BOMB_SCALE_XY, BOMB_SCALE_Z);
      else this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.bodies.setMatrixAt(n, this.dummy.matrix);
      this.glintPos.setXYZ(n, this.img.x, this.img.y, this.img.z);
      n++;
      if (!bomb) this.smoke.sync(this.trailKey(m.id), this.pos, now, true);
    }
    this.dummy.scale.set(1, 1, 1);
    for (let i = n; i < MISSILE_POOL; i++) {
      if (this.glintPos.getY(i) !== PARKED_Y) {
        this.glintPos.setXYZ(i, 0, PARKED_Y, 0);
      }
    }
    for (let i = nm; i < METEOR_POOL; i++) {
      if (this.meteorGlintPos.getY(i) !== PARKED_Y) {
        this.meteorGlintPos.setXYZ(i, 0, PARKED_Y, 0);
      }
    }
    this.bodies.count = n;
    // A1: nothing in the air, nothing to upload — but the frame a pool
    // empties still uploads once (its parked glints).
    if (n > 0 || this.lastBodies > 0) {
      this.bodies.instanceMatrix.needsUpdate = true;
      this.glintPos.needsUpdate = true;
    }
    // P4: the glint pools draw their live prefix only — nothing at rest.
    this.glints.geometry.setDrawRange(0, n);
    // three still issues a (counted) draw for an empty range: hide instead.
    this.glints.visible = n > 0;
    this.meteors.count = nm;
    if (nm > 0 || this.lastMeteors > 0) {
      this.meteors.instanceMatrix.needsUpdate = true;
      this.meteorGlintPos.needsUpdate = true;
    }
    this.meteorGlints.geometry.setDrawRange(0, nm);
    this.meteorGlints.visible = nm > 0;
    this.lastBodies = n;
    this.lastMeteors = nm;
    this.stats.bodies = n;
    this.stats.meteors = nm;
  }

  /** A missile landed: its trail stops feeding (and fades on its own), and
   * the debris throws out of the struck surface. */
  impact(m: MissileStrike, now: number): void {
    this.fireAcc.delete(m.id);
    if (m.kind === "cruise" || m.kind === "artillery") {
      const key = this.trailKey(m.id);
      this.smoke.sync(key, m.to, now, false);
      this.trailKeys.delete(m.id);
    }
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
