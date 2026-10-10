// Wingtip trail math (ticket ANGE-L7F2OS): pure, renderer-free history of
// recent wingtip positions plus the turn-hardness signal that scales trail
// opacity/width. The renderer (PlaneTrails, below the pure section) turns
// histories into one merged additive ribbon mesh.
//
// SEAM RULE (mandatory, unit-tested): points are stored as wrapDelta offsets
// from the CURRENT canonical anchor and re-projected through nearestImage at
// draw time. World-space point history is banned — a plane crossing the
// torus seam (x = WORLD_SIZE−ε → ε) would connect two images ~WORLD_SIZE
// apart and draw a 2 km streak.

import {
  EMISSIVE_TRAIL,
  ROOM_CAP,
  TURN_RATE,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaInto } from "@angels-bandits/common/world";
import * as THREE from "three";
import { lightMountsFor } from "./planelights";
import { nearestImageInto, uploadPrefix } from "./wrapPlacement";

/** How long a trail point lives, ms (~the plan's "short ribbon trails"). */
export const TRAIL_LIFETIME_MS = 1500;
/** Pushes closer together than this slide the newest sample instead of
 * appending — bounds every history to TRAIL_LIFETIME_MS / this points. */
export const TRAIL_MIN_SAMPLE_MS = 25;

/** Wire-shaped quaternion (the streamed Pose carries exactly this). */
export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Turn hardness in [0, 1] from a frame-to-frame orientation delta: the
 * rotation rate between the two quaternions, normalized so the flight
 * model's full-deflection TURN_RATE reads exactly 1. Works for remotes too —
 * it needs only the streamed pose quats, no input state.
 */
export function turnHardness(
  prev: QuatLike,
  curr: QuatLike,
  dtS: number,
): number {
  if (dtS <= 0) return 0;
  const dot = Math.abs(
    prev.x * curr.x + prev.y * curr.y + prev.z * curr.z + prev.w * curr.w,
  );
  const angle = 2 * Math.acos(Math.min(1, dot));
  return Math.min(1, angle / dtS / TURN_RATE);
}

interface TrailPoint {
  /** Offset from the current anchor (small — a trail is tens of meters). */
  off: Vec3;
  /** Absolute time this point was recorded, ms. */
  t: number;
  /** Turn hardness when recorded (drives width/opacity at draw time). */
  hard: number;
}

/**
 * One wingtip's recent path, stored seam-safely: every stored point is an
 * offset from the newest sample (the anchor). Each push re-bases the whole
 * history through wrapDelta, so offsets stay short across seam crossings.
 */
export class TrailHistory {
  private pts: TrailPoint[] = [];
  private anchorPos: Vec3 | null = null;
  /** P4: points that expired, reused by the next push (no per-frame
   * allocation in a 12-plane furball — README P4's allocation table). */
  private readonly spare: TrailPoint[] = [];
  private readonly step: Vec3 = { x: 0, y: 0, z: 0 };

  /** The newest sample in canonical coords, or null when empty. */
  get anchor(): Vec3 | null {
    return this.anchorPos;
  }

  /** Record the tip's canonical position at `timeMs` with turn hardness. */
  push(canonical: Vec3, timeMs: number, hard: number): void {
    const pts = this.pts;
    if (this.anchorPos) {
      // Shortest torus step old-anchor → new-anchor; re-base every offset
      // (in place: the same sums the old copies held).
      const step = wrapDeltaInto(canonical, this.anchorPos, this.step);
      for (let i = 0; i < pts.length; i++) {
        const off = (pts[i] as TrailPoint).off;
        off.x = off.x + step.x;
        off.y = off.y + step.y;
        off.z = off.z + step.z;
      }
      this.anchorPos.x = canonical.x;
      this.anchorPos.y = canonical.y;
      this.anchorPos.z = canonical.z;
    } else {
      this.anchorPos = { x: canonical.x, y: canonical.y, z: canonical.z };
    }
    // Bound memory at high frame rates: a push hot on the heels of the last
    // sample slides that sample instead of growing the history.
    const head = pts[pts.length - 1];
    if (head && timeMs - head.t < TRAIL_MIN_SAMPLE_MS) {
      head.off.x = 0;
      head.off.y = 0;
      head.off.z = 0;
      head.t = timeMs;
      head.hard = Math.max(head.hard, hard);
      return;
    }
    const p = this.spare.pop();
    if (p) {
      p.off.x = 0;
      p.off.y = 0;
      p.off.z = 0;
      p.t = timeMs;
      p.hard = hard;
      pts.push(p);
    } else {
      pts.push({ off: { x: 0, y: 0, z: 0 }, t: timeMs, hard });
    }
  }

  /**
   * Live points oldest-first: anchor-relative offset (a copy), age01 (0 =
   * newest, 1 = about to expire), and recorded hardness. Prunes expired
   * points. QA and tests; the renderer reads `live`.
   */
  points(nowMs: number): { off: Vec3; age01: number; hard: number }[] {
    return this.live(nowMs).map((p) => ({
      off: { ...p.off },
      age01: age01(nowMs, p.t),
      hard: p.hard,
    }));
  }

  /**
   * The live points themselves, oldest-first, after pruning — no copies. The
   * renderer reads these every frame for every ribbon (O4: points() built a
   * fresh object per point per frame, steady garbage in a 12-plane furball).
   */
  live(nowMs: number): readonly TrailPoint[] {
    while (
      this.pts.length &&
      nowMs - (this.pts[0] as TrailPoint).t > TRAIL_LIFETIME_MS
    ) {
      this.spare.push(this.pts.shift() as TrailPoint);
    }
    return this.pts;
  }

  /** Drop everything (death/respawn — a respawn teleport must not streak). */
  clear(): void {
    for (const p of this.pts) this.spare.push(p);
    this.pts.length = 0;
    this.anchorPos = null;
  }
}

// --- Renderer: every plane's two wingtip ribbons in ONE additive mesh ---

/** Points a history can hold given the sampling floor (+1 for the head). */
const MAX_POINTS = Math.ceil(TRAIL_LIFETIME_MS / TRAIL_MIN_SAMPLE_MS) + 1;
/** Two tips per plane, a quad (6 vertices) per segment. */
const MAX_VERTICES = ROOM_CAP * 2 * (MAX_POINTS - 1) * 6;

/** Concept 1 "Regulation Night Traffic": pale grey-white streaks, faint in
 * level flight, assertive only under hard turns. */
const TRAIL_HALF_WIDTH = 0.42;
const TRAIL_BASE_ALPHA = 0.08;
const TRAIL_TURN_ALPHA = 0.55;
const TRAIL_GREY = new THREE.Color(0.88, 0.88, 0.94);

const tipScratch = new THREE.Vector3();
const quatScratch = new THREE.Quaternion();
const segScratch = new THREE.Vector3();
const viewScratch = new THREE.Vector3();
const sideScratch = new THREE.Vector3();
const baseScratch = { x: 0, y: 0, z: 0 };
const tipPos: Vec3 = { x: 0, y: 0, z: 0 };
/** A point's age as a share of the trail's life, 0 (new) .. 1 (expiring). */
const age01 = (nowMs: number, t: number): number =>
  Math.min(1, Math.max(0, (nowMs - t) / TRAIL_LIFETIME_MS));

interface PlaneTrail {
  left: TrailHistory;
  right: TrailHistory;
  prevQuat: QuatLike | null;
}

export class PlaneTrails {
  readonly mesh: THREE.Mesh;
  private readonly planes = new Map<string, PlaneTrail>();
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  /** The two attributes `uploadPrefix` queues (built once). */
  private readonly uploads: THREE.BufferAttribute[];
  /** update()'s state for drawPlane (P4: a pre-bound walk, no iterator). */
  private readonly walk = { viewer: tipPos as Vec3, now: 0, v: 0 };

  constructor() {
    this.positions = new Float32Array(MAX_VERTICES * 3);
    this.colors = new Float32Array(MAX_VERTICES * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.colors, 3),
    );
    this.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Number.POSITIVE_INFINITY,
    );
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Additive is order-free, so three's back-then-front pair buys nothing
      // and costs two program re-checks and a draw a frame (O3).
      forceSinglePass: true,
      // Additive + fog brightens the distant scene (V1 lesson) — off.
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.uploads = [
      this.geometry.attributes.position as THREE.BufferAttribute,
      this.geometry.attributes.color as THREE.BufferAttribute,
    ];
  }

  /**
   * Feed one plane's pose for this frame. Positions are CANONICAL (trail
   * history is seam-safe by construction); `timeMs` must come from one
   * monotonic clock shared by every emit call (performance.now()).
   */
  emit(
    id: string,
    pos: Vec3,
    quat: QuatLike,
    timeMs: number,
    dtS: number,
  ): void {
    let plane = this.planes.get(id);
    if (!plane) {
      plane = {
        left: new TrailHistory(),
        right: new TrailHistory(),
        prevQuat: null,
      };
      this.planes.set(id, plane);
    }
    const hard = plane.prevQuat ? turnHardness(plane.prevQuat, quat, dtS) : 0;
    if (plane.prevQuat) {
      plane.prevQuat.x = quat.x;
      plane.prevQuat.y = quat.y;
      plane.prevQuat.z = quat.z;
      plane.prevQuat.w = quat.w;
    } else {
      plane.prevQuat = { x: quat.x, y: quat.y, z: quat.z, w: quat.w };
    }
    quatScratch.set(quat.x, quat.y, quat.z, quat.w);
    const mounts = lightMountsFor(id);
    this.pushTip(mounts.navL, plane.left, pos, timeMs, hard);
    this.pushTip(mounts.navR, plane.right, pos, timeMs, hard);
  }

  /** One wingtip's sample: the mount turned by `quatScratch`, off `pos`. */
  private pushTip(
    mount: Vec3,
    history: TrailHistory,
    pos: Vec3,
    timeMs: number,
    hard: number,
  ): void {
    tipScratch.set(mount.x, mount.y, mount.z).applyQuaternion(quatScratch);
    tipPos.x = pos.x + tipScratch.x;
    tipPos.y = pos.y + tipScratch.y;
    tipPos.z = pos.z + tipScratch.z;
    history.push(tipPos, timeMs, hard);
  }

  /** Cut a plane's ribbons (death / respawn teleport must not streak). */
  clear(id: string): void {
    const plane = this.planes.get(id);
    plane?.left.clear();
    plane?.right.clear();
    if (plane) plane.prevQuat = null;
  }

  /** Forget a plane entirely (left the room). */
  drop(id: string): void {
    this.planes.delete(id);
  }

  /** Rebuild the merged ribbon geometry around the viewer. Every frame. */
  update(viewer: Vec3, nowMs: number): void {
    const w = this.walk;
    w.viewer = viewer;
    w.now = nowMs;
    w.v = 0;
    this.planes.forEach(this.drawPlane);
    const v = w.v;
    this.geometry.setDrawRange(0, v);
    uploadPrefix(this.uploads, v);
  }

  /** update()'s per-plane step (pre-bound: no closure per frame). */
  private readonly drawPlane = (plane: PlaneTrail): void => {
    this.ribbon(plane.left);
    this.ribbon(plane.right);
  };

  /** One wingtip's ribbon from the walk's next free vertex. The viewer, the
   * clock and the cursor ride in `walk`: no double is handed to a call, so
   * none is boxed per ribbon (P4 allocation table). */
  private ribbon(history: TrailHistory): void {
    const w = this.walk;
    const viewer = w.viewer;
    const nowMs = w.now;
    let v = w.v;
    const anchor = history.anchor;
    if (!anchor) return;
    const pts = history.live(nowMs);
    if (pts.length < 2) return;
    // One nearest-image projection per ribbon; offsets are short.
    const base = nearestImageInto(baseScratch, viewer, anchor);
    for (let i = 1; i < pts.length && v + 6 <= MAX_VERTICES; i++) {
      const a = pts[i - 1] as TrailPoint;
      const b = pts[i] as TrailPoint;
      const ax = base.x + a.off.x;
      const ay = base.y + a.off.y;
      const az = base.z + a.off.z;
      const bx = base.x + b.off.x;
      const by = base.y + b.off.y;
      const bz = base.z + b.off.z;
      segScratch.set(bx - ax, by - ay, bz - az);
      viewScratch.set(ax - viewer.x, ay - viewer.y, az - viewer.z);
      sideScratch.crossVectors(segScratch, viewScratch);
      const len = sideScratch.length();
      if (len < 1e-6) continue;
      sideScratch.multiplyScalar(1 / len);
      // Fade with age; swell with the turn hardness recorded per point.
      const aAge = age01(nowMs, a.t);
      const bAge = age01(nowMs, b.t);
      const wa = TRAIL_HALF_WIDTH * (0.5 + a.hard) * (1 - aAge * 0.6);
      const wb = TRAIL_HALF_WIDTH * (0.5 + b.hard) * (1 - bAge * 0.6);
      const alphaA =
        (1 - aAge) * (TRAIL_BASE_ALPHA + TRAIL_TURN_ALPHA * a.hard);
      const alphaB =
        (1 - bAge) * (TRAIL_BASE_ALPHA + TRAIL_TURN_ALPHA * b.hard);
      // Additive blending: bake alpha into RGB (ladder peak at hard=1).
      const ca = EMISSIVE_TRAIL * alphaA;
      const cb = EMISSIVE_TRAIL * alphaB;
      // Two triangles, written in place: this runs per segment per
      // frame, and the array-of-arrays it replaced was ~1 400 short-lived
      // allocations a frame in a full room (O3 profile).
      const sx = sideScratch.x;
      const sy = sideScratch.y;
      const sz = sideScratch.z;
      v = this.vertex(v, ax - sx * wa, ay - sy * wa, az - sz * wa, ca);
      v = this.vertex(v, ax + sx * wa, ay + sy * wa, az + sz * wa, ca);
      v = this.vertex(v, bx + sx * wb, by + sy * wb, bz + sz * wb, cb);
      v = this.vertex(v, ax - sx * wa, ay - sy * wa, az - sz * wa, ca);
      v = this.vertex(v, bx + sx * wb, by + sy * wb, bz + sz * wb, cb);
      v = this.vertex(v, bx - sx * wb, by - sy * wb, bz - sz * wb, cb);
    }
    w.v = v;
  }

  /** Write vertex `v` (position + additive grey at strength `c`); returns v+1. */
  private vertex(
    v: number,
    x: number,
    y: number,
    z: number,
    c: number,
  ): number {
    this.positions[v * 3] = x;
    this.positions[v * 3 + 1] = y;
    this.positions[v * 3 + 2] = z;
    this.colors[v * 3] = TRAIL_GREY.r * c;
    this.colors[v * 3 + 1] = TRAIL_GREY.g * c;
    this.colors[v * 3 + 2] = TRAIL_GREY.b * c;
    return v + 1;
  }
}
