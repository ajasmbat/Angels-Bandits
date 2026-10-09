// D4 downed planes, client half: every falling wreck the server announced
// (a `death`'s `wreck`, or the welcome's replay), drawn on the shared path
// (common/src/wreck.ts) at the RENDER clock — the clock the movers are drawn
// and crash-checked at, so the wreck you see is the wreck you hit.
//
// One InstancedMesh of charred airframes (1 draw, WRECKS_MAX instances),
// placed at the torus image nearest the viewer and tumbling about their
// flight path. Flames and smoke ride the D1 impact particle pool (fixed
// ring, nothing allocated per frame): a trail while it falls, then a fire
// where it landed for WRECK_BURN_MS. A street landing leaves a scorch disc
// (one more instanced draw). Where it lands is the server's `end`: this
// side never re-sweeps.

import { WRECKS_MAX } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import {
  type WreckParams,
  wreckFalling,
  wreckPosAt,
  wreckTouches,
  wreckVelAt,
} from "@angels-bandits/common/wreck";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Impacts } from "./impacts";
import { nearestImageInto } from "./wrapPlacement";

/** How long a landed wreck keeps burning, ms (on the frame clock). */
export const WRECK_BURN_MS = 8000;
/** Emission at full quality share, particles/s: the falling trail, and the
 * fire where it landed (tapering to nothing over WRECK_BURN_MS). */
const TRAIL_FIRE_RATE = 40;
const TRAIL_SMOKE_RATE = 14;
const BURN_FIRE_RATE = 22;
const BURN_SMOKE_RATE = 8;
/** Tumble about the flight path, rad/s (× the wreck's spin). */
const ROLL_RATE = 5;
/** Street scorch discs kept (a ring: the oldest goes first), and radius, m. */
const SCORCH_MAX = 8;
const SCORCH_RADIUS = 11;
/** Above the street paint (plus polygonOffset), m. */
const SCORCH_Y = 0.06;
/** Charred airframe: near-black, with a dull ember glow well under the
 * fire particles' rung of the emissive ladder. */
const WRECK_COLOR = 0x1b1714;
const WRECK_EMBER = 0x3a1404;

interface Entry {
  w: WreckParams;
  /** Frame time (performance.now) it landed, or null while falling. */
  landedAt: number | null;
  /** Where it landed (canonical). */
  rest: Vec3;
  fireAcc: number;
  smokeAcc: number;
}

/** A burnt-out biplane: fuselage, the lower wing snapped short on one side,
 * a stub of upper wing, the tail. Local −Z is the nose (as a plane's). */
function wreckGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rz = 0,
  ) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rz !== 0) g.rotateZ(rz);
    g.translate(x, y, z);
    parts.push(g);
  };
  box(1.1, 1.1, 6.2, 0, 0, 0); // fuselage
  box(5.4, 0.18, 1.4, -1.9, -0.45, -0.6, 0.12); // lower wing, whole side
  box(2.2, 0.18, 1.4, 1.5, -0.45, -0.6, -0.35); // lower wing, snapped
  box(3.6, 0.16, 1.3, -0.6, 0.95, -0.8, 0.08); // upper wing stub
  box(2.4, 0.14, 0.9, 0, 0.2, 2.8); // tailplane
  box(0.14, 1.2, 0.9, 0, 0.8, 2.8); // fin
  const merged = mergeGeometries(parts) as THREE.BufferGeometry;
  for (const g of parts) g.dispose();
  return merged;
}

/** Soft-edged dark disc for the street scorch. */
function scorchTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.55, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

const FORWARD = new THREE.Vector3(0, 0, -1);
const scratchPos: Vec3 = { x: 0, y: 0, z: 0 };
const scratchVel: Vec3 = { x: 0, y: 0, z: 0 };
const scratchImage: Vec3 = { x: 0, y: 0, z: 0 };
const scratchDir = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchRoll = new THREE.Quaternion();
const scratchMatrix = new THREE.Matrix4();
const scratchScale = new THREE.Vector3(1, 1, 1);
const scratchV3 = new THREE.Vector3();

export class Wrecks {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly scorch: THREE.InstancedMesh;
  private readonly entries: Entry[] = [];
  /** Street scorch centres (canonical), a ring of SCORCH_MAX. */
  private readonly scorches: Vec3[] = [];
  private scorchHead = 0;
  private share = 1;
  private lastFrameMs = Number.POSITIVE_INFINITY;

  constructor(
    private readonly impacts: Impacts,
    /** A wreck hit: the explosion and its sound (main owns both). */
    private readonly onLand: (w: WreckParams, at: Vec3) => void,
  ) {
    const material = new THREE.MeshStandardMaterial({
      color: WRECK_COLOR,
      emissive: WRECK_EMBER,
      roughness: 0.95,
      metalness: 0.1,
    });
    this.mesh = new THREE.InstancedMesh(wreckGeometry(), material, WRECKS_MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    const disc = new THREE.CircleGeometry(SCORCH_RADIUS, 20);
    disc.rotateX(-Math.PI / 2);
    this.scorch = new THREE.InstancedMesh(
      disc,
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        map: scorchTexture(),
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      SCORCH_MAX,
    );
    this.scorch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scorch.frustumCulled = false;
    // One parked instance each until the first update, so the scene-wide
    // pre-warm (prewarm.ts) compiles both programs before any plane falls.
    scratchMatrix.makeTranslation(0, -9999, 0);
    for (const m of [this.mesh, this.scorch]) {
      m.setMatrixAt(0, scratchMatrix);
      m.count = 1;
    }
    this.group.add(this.mesh, this.scorch);
  }

  /** Quality: the tier's share of the flame/smoke emission. */
  setShare(share: number): void {
    this.share = share;
  }

  /** A wreck the server announced (a death). A repeat id is ignored. */
  add(w: WreckParams): void {
    if (this.entries.some((e) => e.w.id === w.id)) return;
    // Over the pool the oldest goes: the server caps a room at the same.
    if (this.entries.length >= WRECKS_MAX) this.entries.shift();
    this.entries.push({
      w,
      landedAt: null,
      rest: { x: 0, y: 0, z: 0 },
      fireAcc: 0,
      smokeAcc: 0,
    });
  }

  /** A welcome (join or resume): exactly the room's falling wrecks. */
  reset(list: readonly WreckParams[]): void {
    this.entries.length = 0;
    for (const w of list) this.add(w);
  }

  /** The announced wreck `id`, while this client still holds it. */
  get(id: number): WreckParams | null {
    return this.entries.find((e) => e.w.id === id)?.w ?? null;
  }

  /** The id of the falling wreck a sphere at `pos` touches at server time
   * `ms` (the render clock), or null. */
  touching(pos: Vec3, radius: number, ms: number | null): number | null {
    if (ms === null) return null;
    for (const e of this.entries) {
      if (e.landedAt !== null) continue;
      if (wreckTouches(e.w, pos, radius, ms, scratchPos)) return e.w.id;
    }
    return null;
  }

  /** Wrecks falling at `ms` (QA / perf). */
  fallingCount(ms: number): number {
    let n = 0;
    for (const e of this.entries) if (wreckFalling(e.w, ms)) n++;
    return n;
  }

  /**
   * Per frame: land what reached its `end` on the render clock `ms`, place
   * the falling ones, feed trails and fires. `now` is the frame clock.
   */
  update(viewer: Vec3, ms: number | null, now: number): void {
    const dt = Math.min(0.25, Math.max(0, (now - this.lastFrameMs) / 1000));
    this.lastFrameMs = now;
    let drawn = 0;
    let kept = 0;
    for (const e of this.entries) {
      const w = e.w;
      if (e.landedAt === null && ms !== null && ms >= w.t + w.end) {
        e.landedAt = now;
        wreckPosAt(w, w.t + w.end, e.rest);
        if (w.hit === "ground") this.addScorch(e.rest);
        this.onLand(w, e.rest);
      }
      if (e.landedAt !== null) {
        const age = now - e.landedAt;
        if (age >= WRECK_BURN_MS) continue; // burnt out: dropped
        const k = 1 - age / WRECK_BURN_MS;
        if (w.hit !== "river" && w.hit !== "air") {
          this.emit(
            e,
            e.rest,
            BURN_FIRE_RATE * k,
            BURN_SMOKE_RATE * k,
            2.5,
            dt,
            now,
          );
        }
      } else if (ms !== null) {
        // Before its death time (the render clock lags the server) it
        // holds at the death point: clamped by the path itself.
        wreckPosAt(w, ms, scratchPos);
        wreckVelAt(w, Math.max(ms, w.t), scratchVel);
        this.place(drawn++, viewer, scratchPos, scratchVel, w, ms);
        this.emit(
          e,
          scratchPos,
          TRAIL_FIRE_RATE,
          TRAIL_SMOKE_RATE,
          1.2,
          dt,
          now,
        );
      }
      this.entries[kept++] = e;
    }
    this.entries.length = kept;
    this.mesh.count = drawn;
    if (drawn > 0) this.mesh.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this.scorches.length; i++) {
      const c = nearestImageInto(
        scratchImage,
        viewer,
        this.scorches[i] as Vec3,
      );
      scratchMatrix.makeTranslation(c.x, SCORCH_Y, c.z);
      this.scorch.setMatrixAt(i, scratchMatrix);
    }
    this.scorch.count = this.scorches.length;
    if (this.scorches.length > 0) this.scorch.instanceMatrix.needsUpdate = true;
  }

  /** Orient instance `i` along its flight path, tumbling, at the image of
   * `pos` nearest the viewer. */
  private place(
    i: number,
    viewer: Vec3,
    pos: Vec3,
    vel: Vec3,
    w: WreckParams,
    ms: number,
  ): void {
    const p = nearestImageInto(scratchImage, viewer, pos);
    scratchDir.set(vel.x, vel.y, vel.z);
    if (scratchDir.lengthSq() < 1e-6) scratchDir.set(w.v.x, w.v.y - 1, w.v.z);
    scratchDir.normalize();
    scratchQuat.setFromUnitVectors(FORWARD, scratchDir);
    const s = Math.max(0, ms - w.t) / 1000;
    scratchRoll.setFromAxisAngle(FORWARD, w.spin * ROLL_RATE * s);
    scratchQuat.multiply(scratchRoll);
    scratchMatrix.compose(
      scratchV3.set(p.x, p.y, p.z),
      scratchQuat,
      scratchScale,
    );
    this.mesh.setMatrixAt(i, scratchMatrix);
  }

  /** Carry fractional emission and spawn this frame's whole particles. */
  private emit(
    e: Entry,
    at: Vec3,
    fireRate: number,
    smokeRate: number,
    spread: number,
    dt: number,
    now: number,
  ): void {
    e.fireAcc += fireRate * this.share * dt;
    e.smokeAcc += smokeRate * this.share * dt;
    const fire = Math.floor(e.fireAcc);
    const smoke = Math.floor(e.smokeAcc);
    e.fireAcc -= fire;
    e.smokeAcc -= smoke;
    if (fire > 0 || smoke > 0) {
      this.impacts.wreckFire(at, fire, smoke, spread, now);
    }
  }

  private addScorch(at: Vec3): void {
    const c = { x: at.x, y: 0, z: at.z };
    if (this.scorches.length < SCORCH_MAX) this.scorches.push(c);
    else this.scorches[this.scorchHead] = c;
    this.scorchHead = (this.scorchHead + 1) % SCORCH_MAX;
  }
}
