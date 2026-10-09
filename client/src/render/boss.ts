// S4 sky boss, THREE half: the war zeppelin, its flak and its fall, drawn
// from the room's boss slot (common/src/boss.ts) on the synced RENDER clock —
// the clock the crash check and the movers use, so the hull you see is the
// hull you hit.
//
// Draw == collide: every box drawn here comes from bossPartBoxInto /
// bossPiecePartBoxInto, the derivation collideBoss tests — armour in one
// InstancedMesh (1 draw), the weak points (engine pods, gas-cell blisters) in
// a second, glowing one (1 draw). Running lights and flak shell heads are one
// Points each. Flak bursts and the falling sections' fire and smoke ride the
// D1 particle pool (fixed ring, no new draw), scaled by the tier's `bossFx`
// share. Nothing is allocated per frame.
//
// Visibility parity (quality.ts rule 2): the hull, the weak points, the
// lights and the shells — solid things and the flak's telegraph — are the
// same on every tier. Only the particle dressing scales.

import {
  BOSS_PARTS,
  BOSS_WEAK_POINTS,
  type BossFlak,
  type BossPart,
  type BossPiece,
  type BossSlot,
  PIECE_PARTS,
  blankPose,
  bossPartBoxInto,
  bossPiecePartBoxInto,
  bossPoseAt,
  bossPresent,
  flakPosAt,
  piecePoseAt,
} from "@angels-bandits/common/boss";
import type { MoverBox } from "@angels-bandits/common/city/movers";
import {
  EMISSIVE_BEACON,
  EMISSIVE_HAZARD,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_STROBE,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { Impacts } from "./impacts";
import { nearestImageInto } from "./wrapPlacement";

/** Gunmetal armour, a shade lighter on the gondola, darker on the guns. */
const ARMOUR = 0x30343b;
const GONDOLA = 0x3d424a;
const GUNS = 0x1c1e22;
/** The weak points' glow (hazard rung — under tracers, over windows), the
 * white of a fresh hit, and a spent one's char. */
export const WEAK_COLOR = new THREE.Color(0xff5a1f);
const WEAK_BOOST = emissiveBoost(WEAK_COLOR, EMISSIVE_HAZARD);
const HIT_FLASH_MS = 110;
const SPENT = new THREE.Color(0x120c09);
/** Flak shell heads: hot red-orange on the beacon rung (tracers stay the
 * brightest thing in a fight). */
export const SHELL_COLOR = new THREE.Color(0xff6a3a);
const SHELL_BOOST = emissiveBoost(SHELL_COLOR, EMISSIVE_BEACON);
const SHELL_SIZE_PX = 6;
/** Most shells drawn at once (6 turrets × a ~2 s flight / 1.8 s cadence). */
export const SHELL_POOL = 24;
/** Running lights: port red, starboard green, white tail and crown, and the
 * belly's red anti-collision strobe. */
const PORT = new THREE.Color(0xff2a20);
const STARBOARD = new THREE.Color(0x2aff5a);
const WHITE = new THREE.Color(0xffffff);
const NAV_SIZE_PX = 5;
const STROBE_PERIOD_MS = 1300;
const STROBE_ON_MS = 90;
/** Particle emission at full share, per second: a falling section's trail,
 * and the fire where it lands (tapering over BURN_MS). */
const TRAIL_FIRE = 70;
const TRAIL_SMOKE = 26;
const BURN_FIRE = 34;
const BURN_SMOKE = 14;
const BURN_MS = 14_000;
/** A flak burst's puff: flames and dark smoke, whole counts at full share. */
const BURST_FIRE = 7;
const BURST_SMOKE = 6;
const PARKED_Y = -9999;

/** Indices of the armour parts (everything that is not a weak point). */
export const ARMOUR_PARTS: readonly number[] = BOSS_PARTS.flatMap((_, i) =>
  BOSS_WEAK_POINTS.includes(i) ? [] : [i],
);

/** A running light: where on the hull (part frame), and its look. */
interface NavLight {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  rung: number;
  strobe: boolean;
  piece: 0 | 1 | 2;
}
const nav = (
  x: number,
  y: number,
  z: number,
  color: THREE.Color,
  rung: number,
  strobe = false,
): NavLight => ({
  x,
  y,
  z,
  color,
  rung,
  strobe,
  piece: x > 70 ? 0 : x < -70 ? 2 : 1,
});
/** On the box faces, never inside or beyond a box (a light is not solid). */
const NAV_LIGHTS: readonly NavLight[] = [
  nav(136, -1, 0, WHITE, EMISSIVE_NAVLIGHT),
  nav(-132, 0, 0, WHITE, EMISSIVE_NAVLIGHT),
  nav(-110, 32, 0, WHITE, EMISSIVE_NAVLIGHT),
  nav(-110, 0, 36, STARBOARD, EMISSIVE_NAVLIGHT),
  nav(-110, 0, -36, PORT, EMISSIVE_NAVLIGHT),
  nav(56, -14, 38, STARBOARD, EMISSIVE_NAVLIGHT),
  nav(56, -14, -38, PORT, EMISSIVE_NAVLIGHT),
  nav(-56, -14, 38, STARBOARD, EMISSIVE_NAVLIGHT),
  nav(-56, -14, -38, PORT, EMISSIVE_NAVLIGHT),
  nav(12, -36, 0, PORT, EMISSIVE_STROBE, true),
  nav(0, 29, 0, PORT, EMISSIVE_STROBE, true),
];

const UP = new THREE.Vector3(0, 1, 0);
const scratchImage: Vec3 = { x: 0, y: 0, z: 0 };
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();

/**
 * The instance matrix of one hull box, placed at its torus image nearest the
 * viewer: a unit cube scaled to the box's full extents and turned by its yaw
 * about +Y (MoverBox's Three.js convention). Pure — the client half of draw
 * == collide is that this, and only this, places every drawn box.
 */
export function boxMatrixInto(
  box: MoverBox,
  viewer: Vec3,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  nearestImageInto(scratchImage, viewer, box);
  scratchPos.set(scratchImage.x, scratchImage.y, scratchImage.z);
  scratchQuat.setFromAxisAngle(UP, box.yaw);
  scratchScale.set(box.hx * 2, box.hy * 2, box.hz * 2);
  return out.compose(scratchPos, scratchQuat, scratchScale);
}

/** A landed section still burning where it hit. */
interface Burn {
  at: Vec3;
  since: number;
  fireAcc: number;
  smokeAcc: number;
}

export class BossRenderer {
  readonly group = new THREE.Group();
  private readonly armour: THREE.InstancedMesh;
  private readonly weak: THREE.InstancedMesh;
  private readonly lights: THREE.Points;
  private readonly lightPos: THREE.BufferAttribute;
  private readonly lightCol: THREE.BufferAttribute;
  private readonly shells: THREE.Points;
  private readonly shellPos: THREE.BufferAttribute;
  private share = 1;
  private readonly box: MoverBox = {
    x: 0,
    y: 0,
    z: 0,
    hx: 0,
    hy: 0,
    hz: 0,
    yaw: 0,
    kind: "boss",
    id: 0,
  };
  private readonly pose = blankPose();
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  /** Last HP seen per weak point, and when each last took a hit. */
  private readonly lastHp = BOSS_WEAK_POINTS.map(() => Number.NaN);
  private shellCount = 0;
  private readonly flashUntil = BOSS_WEAK_POINTS.map(() => 0);
  /** Per falling section: emission carry, and whether it has landed. */
  private readonly trail = [0, 0, 0, 0, 0, 0];
  private landedFor = -1;
  private readonly landed = [false, false, false];
  private readonly burns: Burn[] = [];
  private lastFrameMs = Number.NaN;

  constructor(
    private readonly impacts: Impacts,
    /** A falling section hit the city at `at` (main: blast, sound, shake). */
    private readonly onLand: (at: Vec3) => void,
    /** A flak shell burst at `at` (main: crack, near-miss radio). */
    private readonly onBurst: (at: Vec3, f: BossFlak) => void,
  ) {
    const cube = new THREE.BoxGeometry(1, 1, 1);
    this.armour = new THREE.InstancedMesh(
      cube,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.55,
        metalness: 0.55,
      }),
      ARMOUR_PARTS.length,
    );
    this.armour.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ARMOUR_PARTS.forEach((i, n) => {
      const kind = (BOSS_PARTS[i] as BossPart).kind;
      this.color.setHex(
        kind === "gondola" ? GONDOLA : kind === "turret" ? GUNS : ARMOUR,
      );
      this.armour.setColorAt(n, this.color);
    });
    this.weak = new THREE.InstancedMesh(
      cube,
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      BOSS_WEAK_POINTS.length,
    );
    this.weak.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
      this.weak.setColorAt(k, WEAK_COLOR);
    }
    for (const mesh of [this.armour, this.weak]) {
      // Posed at the torus image nearest the camera every frame: the stock
      // bounding sphere (from the unit cube at the origin) means nothing.
      mesh.frustumCulled = false;
    }

    const lightGeo = new THREE.BufferGeometry();
    this.lightPos = new THREE.BufferAttribute(
      new Float32Array(NAV_LIGHTS.length * 3),
      3,
    );
    this.lightCol = new THREE.BufferAttribute(
      new Float32Array(NAV_LIGHTS.length * 3),
      3,
    );
    lightGeo.setAttribute("position", this.lightPos);
    lightGeo.setAttribute("color", this.lightCol);
    this.lights = new THREE.Points(
      lightGeo,
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

    const shellGeo = new THREE.BufferGeometry();
    this.shellPos = new THREE.BufferAttribute(
      new Float32Array(SHELL_POOL * 3).fill(PARKED_Y),
      3,
    );
    shellGeo.setAttribute("position", this.shellPos);
    this.shells = new THREE.Points(
      shellGeo,
      new THREE.PointsMaterial({
        color: SHELL_COLOR.clone().multiplyScalar(SHELL_BOOST),
        size: SHELL_SIZE_PX,
        sizeAttenuation: false,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.shells.frustumCulled = false;

    this.group.add(this.armour, this.weak, this.lights, this.shells);
    // Hidden until a raid: the boot pre-warm shows (and so compiles) it.
    this.group.visible = false;
  }

  /** Share of the full particle dressing this tier keeps (quality bossFx). */
  setQuality(share: number): void {
    this.share = share;
  }

  /**
   * Per frame. `renderMs` is the render clock (null: no clock yet — nothing
   * drawn, nothing solid). `flak` is the socket's shells in the air; each is
   * removed once it has burst.
   */
  update(
    slot: BossSlot,
    hp: readonly number[],
    flak: Map<number, BossFlak>,
    viewer: Vec3,
    renderMs: number | null,
    now: number,
  ): void {
    const dt = Number.isNaN(this.lastFrameMs)
      ? 0
      : Math.min(0.1, (now - this.lastFrameMs) / 1000);
    this.lastFrameMs = now;
    this.updateBurns(now, dt);
    if (renderMs === null || !slot.raid) {
      this.group.visible = false;
      return;
    }
    const raid = slot.raid;
    this.updateFlak(raid, flak, viewer, renderMs, now);
    if (bossPresent(slot, renderMs)) {
      this.group.visible = true;
      bossPoseAt(raid, renderMs, this.pose);
      this.drawIntact(hp, viewer, now);
      return;
    }
    const down = slot.down;
    if (down && down.id === raid.id && renderMs >= down.t) {
      if (this.landedFor !== down.id) {
        this.landedFor = down.id;
        this.landed.fill(false);
        this.trail.fill(0);
      }
      this.drawFalling(down.t, down.pieces, viewer, renderMs, now, dt);
      return;
    }
    // Between raids (or on its way out past the haze): the shells may still
    // be in the air, but the hull is not.
    this.armour.count = 0;
    this.weak.count = 0;
    this.lights.visible = false;
    this.group.visible = flak.size > 0;
  }

  private drawIntact(hp: readonly number[], viewer: Vec3, now: number): void {
    this.armour.count = ARMOUR_PARTS.length;
    this.weak.count = BOSS_WEAK_POINTS.length;
    for (let n = 0; n < ARMOUR_PARTS.length; n++) {
      bossPartBoxInto(this.pose, ARMOUR_PARTS[n] as number, this.box);
      this.armour.setMatrixAt(n, boxMatrixInto(this.box, viewer, this.matrix));
    }
    // A slow, shared throb: the weak points read as alive, and as targets.
    const throb = 0.78 + 0.22 * Math.sin(now / 260);
    for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
      bossPartBoxInto(this.pose, BOSS_WEAK_POINTS[k] as number, this.box);
      this.weak.setMatrixAt(k, boxMatrixInto(this.box, viewer, this.matrix));
      const left = hp[k] ?? 0;
      if (left < (this.lastHp[k] as number)) {
        this.flashUntil[k] = now + HIT_FLASH_MS;
      }
      if (left <= 0) this.color.copy(SPENT);
      else if (now < (this.flashUntil[k] as number)) {
        this.color.copy(WHITE).multiplyScalar(WEAK_BOOST);
      } else this.color.copy(WEAK_COLOR).multiplyScalar(WEAK_BOOST * throb);
      this.weak.setColorAt(k, this.color);
      this.lastHp[k] = left;
    }
    this.armour.instanceMatrix.needsUpdate = true;
    this.weak.instanceMatrix.needsUpdate = true;
    if (this.weak.instanceColor) this.weak.instanceColor.needsUpdate = true;
    this.placeLights(viewer, now);
  }

  private drawFalling(
    t: number,
    pieces: readonly BossPiece[],
    viewer: Vec3,
    renderMs: number,
    now: number,
    dt: number,
  ): void {
    let a = 0;
    let w = 0;
    let falling = false;
    for (const piece of pieces) {
      if (renderMs >= t + piece.end) {
        if (!this.landed[piece.k]) {
          this.landed[piece.k] = true;
          const at = piece.at;
          this.burns.push({ at, since: now, fireAcc: 0, smokeAcc: 0 });
          this.onLand(at);
        }
        continue;
      }
      falling = true;
      piecePoseAt(piece, t, piece.end, renderMs, this.pose);
      for (const i of PIECE_PARTS[piece.k] as readonly number[]) {
        bossPiecePartBoxInto(piece, this.pose, i, this.box);
        boxMatrixInto(this.box, viewer, this.matrix);
        const k = BOSS_WEAK_POINTS.indexOf(i);
        if (k >= 0) {
          this.weak.setMatrixAt(w, this.matrix);
          this.weak.setColorAt(w, SPENT);
          w++;
        } else this.armour.setMatrixAt(a++, this.matrix);
      }
      // Fire and smoke pour off the broken section as it goes down.
      const fire = this.trail[piece.k * 2] as number;
      const smoke = this.trail[piece.k * 2 + 1] as number;
      const nf = fire + TRAIL_FIRE * this.share * dt;
      const ns = smoke + TRAIL_SMOKE * this.share * dt;
      this.at.x = this.pose.x;
      this.at.y = this.pose.y;
      this.at.z = this.pose.z;
      this.impacts.wreckFire(this.at, Math.floor(nf), Math.floor(ns), 22, now);
      this.trail[piece.k * 2] = nf - Math.floor(nf);
      this.trail[piece.k * 2 + 1] = ns - Math.floor(ns);
    }
    this.armour.count = a;
    this.weak.count = w;
    this.armour.instanceMatrix.needsUpdate = true;
    this.weak.instanceMatrix.needsUpdate = true;
    if (this.weak.instanceColor) this.weak.instanceColor.needsUpdate = true;
    this.lights.visible = false;
    this.group.visible = falling;
  }

  /** Running lights on the intact hull (strobes blink on the frame clock). */
  private placeLights(viewer: Vec3, now: number): void {
    const c = Math.cos(this.pose.yaw);
    const s = Math.sin(this.pose.yaw);
    const strobeOn = now % STROBE_PERIOD_MS < STROBE_ON_MS;
    for (let n = 0; n < NAV_LIGHTS.length; n++) {
      const l = NAV_LIGHTS[n] as NavLight;
      this.at.x = this.pose.x + l.x * c + l.z * s;
      this.at.y = this.pose.y + l.y;
      this.at.z = this.pose.z - l.x * s + l.z * c;
      nearestImageInto(scratchImage, viewer, this.at);
      this.lightPos.setXYZ(n, scratchImage.x, scratchImage.y, scratchImage.z);
      const on = !l.strobe || strobeOn;
      const k = on ? emissiveBoost(l.color, l.rung) : 0;
      this.lightCol.setXYZ(n, l.color.r * k, l.color.g * k, l.color.b * k);
    }
    this.lightPos.needsUpdate = true;
    this.lightCol.needsUpdate = true;
    this.lights.visible = true;
  }

  /** Shell heads in flight; each burst once, then dropped from `flak`. */
  private updateFlak(
    raid: NonNullable<BossSlot["raid"]>,
    flak: Map<number, BossFlak>,
    viewer: Vec3,
    renderMs: number,
    now: number,
  ): void {
    let n = 0;
    for (const [id, f] of flak) {
      if (renderMs >= f.t0 + f.fuse) {
        flak.delete(id);
        const share = this.share;
        this.impacts.wreckFire(
          f.to,
          Math.max(1, Math.round(BURST_FIRE * share)),
          Math.max(1, Math.round(BURST_SMOKE * share)),
          4,
          now,
        );
        this.onBurst(f.to, f);
        continue;
      }
      if (renderMs < f.t0 || n >= SHELL_POOL) continue;
      flakPosAt(raid, f, renderMs, this.at);
      nearestImageInto(scratchImage, viewer, this.at);
      this.shellPos.setXYZ(n++, scratchImage.x, scratchImage.y, scratchImage.z);
    }
    for (let i = n; i < SHELL_POOL; i++)
      this.shellPos.setXYZ(i, 0, PARKED_Y, 0);
    this.shellPos.needsUpdate = true;
    this.shells.visible = n > 0;
    this.shellCount = n;
  }

  /** Landed sections keep burning, tapering to nothing over BURN_MS. */
  private updateBurns(now: number, dt: number): void {
    for (let i = this.burns.length - 1; i >= 0; i--) {
      const b = this.burns[i] as Burn;
      const left = 1 - (now - b.since) / BURN_MS;
      if (left <= 0) {
        this.burns.splice(i, 1);
        continue;
      }
      b.fireAcc += BURN_FIRE * this.share * left * dt;
      b.smokeAcc += BURN_SMOKE * this.share * left * dt;
      const f = Math.floor(b.fireAcc);
      const s = Math.floor(b.smokeAcc);
      if (f > 0 || s > 0) this.impacts.wreckFire(b.at, f, s, 26, now);
      b.fireAcc -= f;
      b.smokeAcc -= s;
    }
  }

  /** QA: what is drawn this frame. */
  get stats(): { armour: number; weak: number; shells: number } {
    return {
      armour: this.group.visible ? this.armour.count : 0,
      weak: this.group.visible ? this.weak.count : 0,
      shells: this.shells.visible ? this.shellCount : 0,
    };
  }
}
