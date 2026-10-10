// D9 destructible props, drawn: ONE instanced unit-box mesh for every prop
// the street and the roofs can lose (common/src/city/props.ts) — the D9
// parked cars, taxis and fuel tankers, the riverside gas stations, the
// utility poles and their wires, the snapped lamps and signal masts lying in
// the street, the flipped and burnt-out wrecks, rubble round them, and every
// SOLID faller (a roof tank, billboard, antenna mast, jumbotron or bridge
// span going down and where it came to rest).
//
// Two rules:
//  - A solid faller is drawn from propPieceInto — the very pose collideProps
//    tests for the crash check and the bots — on EVERY tier and at any
//    distance (quality rule 2: solid things look the same everywhere), and
//    at rest when there is no clock yet (the crash check's no-clock rule).
//  - Everything else is cosmetic (the ≤ 3 m street exception, or thin
//    furniture that never collided): window-packed round the camera, gated
//    by altitude like G1's parked cars, never collided.
//
// Cost: the static part (props that are not moving) is re-packed only when
// the camera's block window, the prop state's version or the gate changes;
// what is moving this frame (falling, flipping, toppling) is appended after
// it every frame. Nearest-image placement like every renderer here.

import { type PiecePose, blankPose } from "@angels-bandits/common/city/collapse";
import {
  LAMP_HEIGHT,
  POLE_HEIGHT,
  PROP_BILLBOARD,
  PROP_BRIDGE,
  PROP_CAR,
  PROP_FUEL,
  PROP_JUMBO,
  PROP_LAMP,
  PROP_MAST,
  PROP_POLE,
  PROP_SIGNAL,
  PROP_STATION,
  PROP_TANK,
  PROP_TAXI,
  type Prop,
  type PropSlot,
  STATION_HEIGHT,
  VEHICLE_DIMS,
  isFaller,
  propPieceInto,
} from "@angels-bandits/common/city/props";
import {
  BLOCK_PITCH,
  EMISSIVE_SIGN,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { uploadPrefix } from "./wrapPlacement";

/** Instances the mesh holds (a derived bound: the window's street props at
 * a few boxes each, plus every faller and wreck the caps allow). */
export const PROPS_INSTANCES = 6144;
/** Cosmetic props are drawn within this of the camera (plan view), m. */
export const PROPS_DRAW_M = 460;
/** Cosmetic street props fade out above this camera altitude, m (G1's
 * parked-car gate). */
export const PROPS_GATE_Y = 320;
/** A flipped car's flight, a snapped lamp's fall, a pole's topple, s. */
const FLIP_S = 1.3;
const SNAP_S = 0.9;
const POLE_S = 1.6;
/** Wrecks glow (embers, under the bloom threshold) this long, ms. */
const EMBER_MS = 45_000;

const GRID = WORLD_SIZE / BLOCK_PITCH;
const wrapGrid = (v: number) => ((v % GRID) + GRID) % GRID;

/** Body colours: G1's street mix (sRGB). */
const CAR_BODIES = [
  0x2a2d38, 0x4a5160, 0x7a7f88, 0xa9adb5, 0xd0d2d6, 0x8a2a24, 0x2c4a6e,
  0x3a4a3a, 0x5a4a3a, 0x1e1f24,
] as const;
const COLORS = {
  taxi: 0xd9a514,
  glass: 0x1a2030,
  tankerCab: 0x8a2a24,
  tanker: 0xb8bcc4,
  chassis: 0x26282c,
  canopy: 0xd8dadf,
  fascia: 0xb3262b,
  column: 0x9a9ea6,
  pump: 0x2f6db5,
  kiosk: 0xc9c2b4,
  sign: 0xf0c040,
  pole: 0x5a4636,
  wire: 0x101012,
  lamp: 0x1a1a26,
  lampHead: 0x6a5a40,
  signal: 0x23262b,
  charred: 0x1c1916,
  rubble: 0x5f5a54,
  tank: 0x6b5442,
  billboard: 0x2b2b33,
  mast: 0x9aa0a8,
  jumbo: 0x0e0f14,
  deck: 0x5c5f66,
} as const;

const scratchColor = new THREE.Color();
const glowOf = (hex: number, rung: number): number => {
  scratchColor.setHex(hex);
  return emissiveBoost(scratchColor, rung);
};
/** Ember glow on a fresh wreck: kept under the 0.72 bloom threshold. */
const EMBER = 0.45;

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

const smooth = (u: number): number => {
  const k = Math.min(1, Math.max(0, u));
  return k * k * (3 - 2 * k);
};

export class PropsRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly glow: THREE.InstancedBufferAttribute;
  private readonly glowArr: Float32Array;
  private readonly m = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly pose: PiecePose = blankPose();
  /** Static instances [0, staticCount); moving ones after them. */
  private staticCount = 0;
  private staticKey = "";
  /** Ids that were moving at the last static pack (drawn per frame). */
  private moving: number[] = [];
  private n = 0;
  /** Camera position the static pack was placed against. */
  private readonly origin: Vec3 = { x: 0, y: 0, z: 0 };
  private share = 1;
  private drawnFallers = 0;

  constructor(private readonly slot: PropSlot) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.glowArr = new Float32Array(PROPS_INSTANCES);
    this.glow = new THREE.InstancedBufferAttribute(this.glowArr, 1);
    this.glow.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aGlow", this.glow);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    material.customProgramCacheKey = () => "d9-props-glow";
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute float aGlow;\nvarying float vGlow;",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvGlow = aGlow;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vGlow;")
        .replace(
          "#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow;",
        );
    };
    this.mesh = new THREE.InstancedMesh(geometry, material, PROPS_INSTANCES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    // One parked instance so the boot pre-warm compiles the program.
    this.m.makeTranslation(0, -9999, 0);
    this.mesh.setMatrixAt(0, this.m);
    this.mesh.setColorAt(0, this.c.setHex(0));
    this.mesh.count = 1;
  }

  /** Quality row (chaosFx): share of the cosmetic wreck dressing. */
  setShare(share: number): void {
    this.share = share;
    this.staticKey = "";
  }

  /** Instances drawn last frame, and the solid fallers among them. */
  get drawStats(): { instances: number; fallers: number } {
    return { instances: this.n, fallers: this.drawnFallers };
  }

  /** Place everything for the camera at `viewer` and server time `tMs`
   * (null: no clock yet — fallers at rest, nothing moving). */
  update(viewer: Vec3, tMs: number | null): void {
    const t = tMs ?? Number.POSITIVE_INFINITY;
    const gate = viewer.y < PROPS_GATE_Y;
    const bx = Math.floor(viewer.x / BLOCK_PITCH);
    const bz = Math.floor(viewer.z / BLOCK_PITCH);
    const key = `${bx},${bz},${this.slot.state.version},${gate ? 1 : 0}`;
    let stillMoving = false;
    for (const id of this.moving) {
      if (this.isMoving(id, t)) {
        stillMoving = true;
      } else {
        // Came to rest: it belongs in the static pack now.
        this.staticKey = "";
      }
    }
    if (key !== this.staticKey) {
      this.staticKey = key;
      this.origin.x = viewer.x;
      this.origin.z = viewer.z;
      this.moving = [];
      this.n = 0;
      this.packStatic(viewer, t, gate);
      this.staticCount = this.n;
      stillMoving = this.moving.length > 0;
    }
    this.n = this.staticCount;
    if (stillMoving || this.moving.length > 0) {
      for (const id of this.moving) this.drawProp(id, t, true);
    }
    this.mesh.count = Math.max(1, this.n);
    if (this.n === 0) {
      this.m.makeTranslation(0, -9999, 0);
      this.mesh.setMatrixAt(0, this.m);
    }
    uploadPrefix(
      [this.mesh.instanceMatrix, this.mesh.instanceColor, this.glow],
      Math.max(1, this.n),
    );
  }

  /** Is prop `id` animating at `t` (its pose changes frame to frame)? */
  private isMoving(id: number, t: number): boolean {
    const state = this.slot.state;
    if (!state.isDown(id) || !Number.isFinite(t)) return false;
    const p = this.slot.layout.props[id] as Prop;
    const since = (t - state.downAt(id)) / 1000;
    if (isFaller(p.kind)) {
      const pose = propPieceInto(this.slot, id, t, this.pose);
      return pose !== null && !pose.rest;
    }
    if (p.kind === PROP_LAMP || p.kind === PROP_SIGNAL) return since < SNAP_S;
    if (p.kind === PROP_POLE) return since < POLE_S;
    const te = state.blastAt(id);
    if (Number.isNaN(te)) return false;
    return (t - te) / 1000 < FLIP_S && p.kind !== PROP_STATION;
  }

  private packStatic(viewer: Vec3, t: number, gate: boolean): void {
    const layout = this.slot.layout;
    const state = this.slot.state;
    this.drawnFallers = 0;
    // Every solid faller, anywhere (they are few and must always draw).
    for (const id of state.fallers) {
      if (this.isMoving(id, t)) this.moving.push(id);
      else this.drawProp(id, t, false);
    }
    if (!gate) return;
    const r = PROPS_DRAW_M;
    const bx0 = Math.floor((viewer.x - r) / BLOCK_PITCH);
    const bx1 = Math.floor((viewer.x + r) / BLOCK_PITCH);
    const bz0 = Math.floor((viewer.z - r) / BLOCK_PITCH);
    const bz1 = Math.floor((viewer.z + r) / BLOCK_PITCH);
    for (let i = bx0; i <= bx1; i++) {
      for (let j = bz0; j <= bz1; j++) {
        const list = layout.buckets[wrapGrid(i) * GRID + wrapGrid(j)];
        for (const id of list ?? []) {
          const p = layout.props[id] as Prop;
          if (isFaller(p.kind)) continue;
          const dx = wrapDeltaAxis(viewer.x, p.x);
          const dz = wrapDeltaAxis(viewer.z, p.z);
          if (dx * dx + dz * dz > r * r) continue;
          if (this.isMoving(id, t)) this.moving.push(id);
          else this.drawProp(id, t, false);
        }
      }
    }
  }

  // --- Composition ----------------------------------------------------------

  /** One box: canonical centre (cx, cy, cz) → its nearest image, rotated
   * by `quat` (or none), sized (sx, sy, sz). */
  private box(
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    quat: THREE.Quaternion | null,
    hex: number,
    glow: number,
  ): void {
    if (this.n >= PROPS_INSTANCES) return;
    this.p.set(
      this.origin.x + wrapDeltaAxis(this.origin.x, cx),
      cy,
      this.origin.z + wrapDeltaAxis(this.origin.z, cz),
    );
    this.s.set(Math.max(sx, 0.01), Math.max(sy, 0.01), Math.max(sz, 0.01));
    this.m.compose(this.p, quat ?? this.q.identity(), this.s);
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.setColorAt(this.n, this.c.setHex(hex));
    this.glowArr[this.n] = glow;
    this.n++;
  }

  /**
   * A box hinged at pivot (px, py, pz): yawed by `yaw`, then tilted by
   * `tilt` about its local x axis, its centre `off` up its local y from the
   * pivot. (A snapped lamp, a toppling pole, a sagging wire.)
   */
  private hinged(
    px: number,
    py: number,
    pz: number,
    yaw: number,
    tilt: number,
    off: number,
    sx: number,
    sy: number,
    sz: number,
    hex: number,
    glow: number,
  ): void {
    this.q.setFromAxisAngle(AXIS_Y, yaw);
    this.q2.setFromAxisAngle(AXIS_X, tilt);
    this.q.multiply(this.q2);
    // Centre = pivot + R · (0, off, 0).
    this.p.set(0, off, 0).applyQuaternion(this.q);
    const cx = px + this.p.x;
    const cy = py + this.p.y;
    const cz = pz + this.p.z;
    this.q2.copy(this.q);
    this.box(cx, cy, cz, sx, sy, sz, this.q2, hex, glow);
  }

  private drawProp(id: number, t: number, _moving: boolean): void {
    const p = this.slot.layout.props[id] as Prop;
    const state = this.slot.state;
    const down = state.isDown(id);
    switch (p.kind) {
      case PROP_LAMP:
      case PROP_SIGNAL:
        if (down) this.snapped(p, t, state.downAt(id));
        return;
      case PROP_CAR:
      case PROP_TAXI:
      case PROP_FUEL:
        this.vehicle(p, t, down, state.blastAt(id));
        return;
      case PROP_STATION:
        this.station(p, t, down, state.blastAt(id));
        return;
      case PROP_POLE:
        this.pole(p, t, down ? state.downAt(id) : Number.NaN);
        return;
      default:
        if (isFaller(p.kind) && down && this.faller(id, p, t)) {
          this.drawnFallers++;
        }
    }
  }

  private faller(id: number, p: Prop, t: number): boolean {
    const pose = propPieceInto(this.slot, id, t, this.pose);
    if (!pose) return false;
    this.q.setFromAxisAngle(pose.axis === 0 ? AXIS_X : AXIS_Z, pose.phi);
    const hex =
      p.kind === PROP_TANK
        ? COLORS.tank
        : p.kind === PROP_BILLBOARD
          ? COLORS.billboard
          : p.kind === PROP_MAST
            ? COLORS.mast
            : p.kind === PROP_JUMBO
              ? COLORS.jumbo
              : COLORS.deck;
    this.q2.copy(this.q);
    this.box(
      p.x + pose.x,
      pose.y,
      p.z + pose.z,
      2 * pose.hx,
      2 * pose.hy,
      2 * pose.hz,
      this.q2,
      hex,
      0,
    );
    return true;
  }

  /** A lamp or signal mast snapped at its base and lying in the street. */
  private snapped(p: Prop, t: number, downAt: number): void {
    const since = Number.isFinite(t) ? (t - downAt) / 1000 : 99;
    const yaw = p.seed * Math.PI * 2;
    const tilt = (Math.PI / 2 - 0.06) * smooth(since / SNAP_S);
    const stump = 0.7;
    const base = p.y - p.hy;
    const h = p.kind === PROP_LAMP ? LAMP_HEIGHT : 2 * p.hy;
    const hex = p.kind === PROP_LAMP ? COLORS.lamp : COLORS.signal;
    this.box(p.x, base + stump / 2, p.z, 0.3, stump, 0.3, null, hex, 0);
    this.hinged(
      p.x,
      base + stump,
      p.z,
      yaw,
      tilt,
      (h - stump) / 2,
      0.22,
      h - stump,
      0.22,
      hex,
      0,
    );
    // The dead head at the far end.
    this.hinged(
      p.x,
      base + stump,
      p.z,
      yaw,
      tilt,
      h - stump,
      p.kind === PROP_LAMP ? 0.8 : 0.45,
      0.5,
      p.kind === PROP_LAMP ? 0.8 : 0.45,
      p.kind === PROP_LAMP ? COLORS.lampHead : COLORS.signal,
      0,
    );
  }

  private vehicle(p: Prop, t: number, down: boolean, blastAt: number): void {
    const [len, wid, h] = VEHICLE_DIMS[p.kind] as readonly [
      number,
      number,
      number,
    ];
    const yaw = p.yaw;
    const blown = down && !Number.isNaN(blastAt);
    if (!blown) {
      // Standing (or hit and smoking, waiting for its fuse): G1's look.
      const body =
        p.kind === PROP_TAXI
          ? COLORS.taxi
          : p.kind === PROP_FUEL
            ? COLORS.tankerCab
            : (CAR_BODIES[Math.floor(p.seed * CAR_BODIES.length)] as number);
      const dim = down ? 0x2a2622 : body;
      this.q.setFromAxisAngle(AXIS_Y, yaw);
      this.q2.copy(this.q);
      if (p.kind === PROP_FUEL) {
        this.local(p, 0, 0.55, -len / 2 + 1.2, 2.4, 1.1, 2.4, dim, 0); // cab base
        this.local(p, 0, 1.75, -len / 2 + 1.1, 2.3, 1.3, 2.0, down ? 0x222 : COLORS.glass, 0);
        this.local(p, 0, 0.4, 0.6, wid, 0.5, len - 2.6, COLORS.chassis, 0);
        this.local(p, 0, 1.75, 1.0, wid, 1.9, len - 3.0, down ? 0x3a3530 : COLORS.tanker, 0);
        return;
      }
      this.local(p, 0, h * 0.32, 0, wid, h * 0.5, len, dim, 0);
      this.local(p, 0, h * 0.78, -len * 0.04, wid * 0.92, h * 0.42, len * 0.55, COLORS.glass, 0);
      if (p.kind === PROP_TAXI && !down) {
        this.local(p, 0, h + 0.15, -len * 0.04, 0.9, 0.25, 0.35, 0xfff2b0, glowOf(0xfff2b0, EMISSIVE_SIGN));
      }
      return;
    }
    // Blown: thrown up, rolled over onto its roof, a charred shell.
    const since = Number.isFinite(t) ? (t - blastAt) / 1000 : 99;
    const u = Math.min(1, since / FLIP_S);
    const lift = (p.kind === PROP_FUEL ? 2.5 : 4.5) * Math.sin(Math.PI * u);
    const roll = (p.seed < 0.5 ? -1 : 1) * Math.PI * smooth(u) * (p.kind === PROP_FUEL ? 0.5 : 1);
    const ember = Number.isFinite(t) && t - blastAt < EMBER_MS ? EMBER * (1 - (t - blastAt) / EMBER_MS) : 0;
    this.q.setFromAxisAngle(AXIS_Y, yaw);
    this.q2.setFromAxisAngle(AXIS_Z, roll);
    this.q.multiply(this.q2);
    this.q2.copy(this.q);
    const hh = p.kind === PROP_FUEL ? h * 0.75 : h * 0.6;
    this.box(p.x, hh / 2 + lift, p.z, wid, hh, len * 0.95, this.q2, COLORS.charred, ember);
    if (this.share > 0.3) this.rubble(p, 3, wid + 2);
  }

  /** A box in prop `p`'s yawed frame: (lx, ly, lz) from its ground centre. */
  private local(
    p: Prop,
    lx: number,
    ly: number,
    lz: number,
    sx: number,
    sy: number,
    sz: number,
    hex: number,
    glow: number,
  ): void {
    this.q.setFromAxisAngle(AXIS_Y, p.yaw);
    this.p.set(lx, 0, lz).applyQuaternion(this.q);
    const x = p.x + this.p.x;
    const z = p.z + this.p.z;
    this.q2.copy(this.q);
    this.box(x, ly, z, sx, sy, sz, this.q2, hex, glow);
  }

  /** Seeded rubble lumps round prop `p` (≤ 1 m: dressing, never solid). */
  private rubble(p: Prop, count: number, spread: number): void {
    for (let k = 0; k < count; k++) {
      const a = (p.seed * 7 + k * 2.399) * Math.PI;
      const r = spread * (0.45 + 0.4 * (((p.seed * 13 + k * 0.37) % 1) + 0));
      const s = 0.5 + 0.5 * ((p.seed * 31 + k * 0.61) % 1);
      this.box(
        p.x + Math.cos(a) * r,
        s * 0.3,
        p.z + Math.sin(a) * r,
        s * 1.1,
        s * 0.6,
        s * 0.9,
        null,
        COLORS.rubble,
        0,
      );
    }
  }

  private station(p: Prop, t: number, down: boolean, blastAt: number): void {
    const blown = down && !Number.isNaN(blastAt);
    const hx = p.hx;
    const hz = p.hz;
    const top = STATION_HEIGHT;
    if (!blown) {
      const lit = down ? 0 : 1;
      // Canopy on four columns, its red fascia lit, two pump islands, the
      // kiosk at the back with a lit window, the price sign.
      this.box(p.x, top - 0.25, p.z, 2 * hx, 0.5, 2 * hz * 0.75, null, down ? 0x4a4642 : COLORS.canopy, 0);
      this.box(p.x, top - 0.55, p.z, 2 * hx + 0.1, 0.18, 2 * hz * 0.75 + 0.1, null, COLORS.fascia, lit * glowOf(COLORS.fascia, EMISSIVE_SIGN) * 0.8);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          this.box(p.x + sx * (hx - 1.2), (top - 0.5) / 2, p.z + sz * (hz * 0.75 - 1), 0.35, top - 0.5, 0.35, null, COLORS.column, 0);
        }
        this.box(p.x + sx * hx * 0.4, 0.75, p.z, 0.9, 1.5, 2.6, null, COLORS.pump, lit * 0.4);
      }
      const back = p.yaw === 0 ? -1 : 1;
      this.box(p.x, 1.4, p.z + back * (hz - 1.6), 2 * hx * 0.6, 2.8, 3, null, COLORS.kiosk, 0);
      this.box(p.x, 1.6, p.z + back * (hz - 3.12), 2 * hx * 0.4, 1.0, 0.05, null, 0xffe0a0, lit * glowOf(0xffe0a0, EMISSIVE_SIGN) * 0.7);
      this.box(p.x + hx + 0.8, 1.4, p.z, 0.25, 2.8, 0.25, null, COLORS.column, 0);
      this.box(p.x + hx + 0.8, 2.6, p.z, 0.2, 0.7, 1.6, null, COLORS.sign, lit * glowOf(COLORS.sign, EMISSIVE_SIGN) * 0.8);
      return;
    }
    // Blown: the canopy down on the pumps at an angle, everything charred.
    const ember = Number.isFinite(t) && t - blastAt < EMBER_MS ? EMBER * (1 - (t - blastAt) / EMBER_MS) : 0;
    this.q.setFromAxisAngle(AXIS_X, (p.seed - 0.5) * 0.5);
    this.q2.copy(this.q);
    this.box(p.x, 1.1, p.z, 2 * hx * 0.95, 0.4, 2 * hz * 0.7, this.q2, COLORS.charred, ember);
    for (const sx of [-1, 1]) {
      this.box(p.x + sx * hx * 0.4, 0.5, p.z, 1, 1, 2.6, null, COLORS.charred, ember * 0.6);
    }
    this.box(p.x, 1.0, p.z + (p.yaw === 0 ? -1 : 1) * (hz - 1.6), 2 * hx * 0.6, 2.0, 3, null, 0x2a2622, 0);
    if (this.share > 0.3) this.rubble(p, 6, hx);
  }

  /** A pole and its wires to the next pole — or, down, toppled with the
   * wires drooping to the street. */
  private pole(p: Prop, t: number, downAt: number): void {
    const layout = this.slot.layout;
    const state = this.slot.state;
    const down = !Number.isNaN(downAt);
    const arm = 1.1;
    const armY = POLE_HEIGHT - 0.4;
    const topple = down
      ? (Math.PI / 2 - 0.05) *
        smooth((Number.isFinite(t) ? (t - downAt) / 1000 : 99) / POLE_S)
      : 0;
    // It falls away from the channel (onto the promenade).
    const yaw = p.z < 1100 ? Math.PI : 0;
    this.hinged(p.x, 0, p.z, yaw, topple, POLE_HEIGHT / 2, 0.3, POLE_HEIGHT, 0.3, COLORS.pole, 0);
    this.hinged(p.x, 0, p.z, yaw, topple, armY, 2 * arm, 0.14, 0.14, COLORS.pole, 0);
    const next = p.ref >= 0 ? layout.props[p.ref] : undefined;
    if (!next) return;
    const nextDown = state.isDown(next.id);
    // Measured from this pole, so a span across the seam stays whole.
    const dx = wrapDeltaAxis(p.x, next.x);
    for (const side of [-1, 1]) {
      // Each end on its pole's arm — or, for a downed pole, in the street
      // at its foot (the wire torn down with it, still live: sparks).
      const ax = p.x + side * (down ? 0.6 : arm * 0.9);
      const ay = down ? 0.3 : armY;
      const bxw = p.x + dx + side * (nextDown ? 0.6 : arm * 0.9);
      const by = nextDown ? 0.3 : armY;
      const sag = down || nextDown ? 0.2 : 0.9;
      const mx = (ax + bxw) / 2;
      const my = Math.max(0.1, (ay + by) / 2 - sag);
      this.wire(ax, ay, p.z, mx, my, p.z);
      this.wire(mx, my, p.z, bxw, by, p.z);
    }
  }

  /** A thin wire box from (x0, y0, z0) to (x1, y1, z1) (canonical; x1 may
   * run past the seam — it is placed relative to x0's image). */
  private wire(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return;
    this.p.set(dx / len, dy / len, dz / len);
    this.q.setFromUnitVectors(AXIS_X, this.p);
    this.q2.copy(this.q);
    this.box(x0 + dx / 2, y0 + dy / 2, z0 + dz / 2, len, 0.06, 0.06, this.q2, COLORS.wire, 0);
  }
}

