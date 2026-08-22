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
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import * as THREE from "three";
import { LIGHT_MOUNTS } from "./planelights";
import { nearestImage } from "./wrapPlacement";

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

  /** The newest sample in canonical coords, or null when empty. */
  get anchor(): Vec3 | null {
    return this.anchorPos;
  }

  /** Record the tip's canonical position at `timeMs` with turn hardness. */
  push(canonical: Vec3, timeMs: number, hard: number): void {
    if (this.anchorPos) {
      // Shortest torus step old-anchor → new-anchor; re-base every offset.
      const step = wrapDelta(canonical, this.anchorPos);
      for (const p of this.pts) {
        p.off = {
          x: p.off.x + step.x,
          y: p.off.y + step.y,
          z: p.off.z + step.z,
        };
      }
    }
    this.anchorPos = { ...canonical };
    // Bound memory at high frame rates: a push hot on the heels of the last
    // sample slides that sample instead of growing the history.
    const head = this.pts[this.pts.length - 1];
    if (head && timeMs - head.t < TRAIL_MIN_SAMPLE_MS) {
      head.off = { x: 0, y: 0, z: 0 };
      head.t = timeMs;
      head.hard = Math.max(head.hard, hard);
      return;
    }
    this.pts.push({ off: { x: 0, y: 0, z: 0 }, t: timeMs, hard });
  }

  /**
   * Live points oldest-first: anchor-relative offset, age01 (0 = newest,
   * 1 = about to expire), and recorded hardness. Prunes expired points.
   */
  points(nowMs: number): { off: Vec3; age01: number; hard: number }[] {
    while (
      this.pts.length &&
      nowMs - (this.pts[0] as TrailPoint).t > TRAIL_LIFETIME_MS
    ) {
      this.pts.shift();
    }
    return this.pts.map((p) => ({
      off: p.off,
      age01: Math.min(1, Math.max(0, (nowMs - p.t) / TRAIL_LIFETIME_MS)),
      hard: p.hard,
    }));
  }

  /** Drop everything (death/respawn — a respawn teleport must not streak). */
  clear(): void {
    this.pts = [];
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
const TRAIL_HALF_WIDTH = 0.22;
const TRAIL_BASE_ALPHA = 0.08;
const TRAIL_TURN_ALPHA = 0.55;
const TRAIL_GREY = new THREE.Color(0.88, 0.88, 0.94);

const tipScratch = new THREE.Vector3();
const quatScratch = new THREE.Quaternion();
const segScratch = new THREE.Vector3();
const viewScratch = new THREE.Vector3();
const sideScratch = new THREE.Vector3();

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
      // Additive + fog brightens the distant scene (V1 lesson) — off.
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
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
    plane.prevQuat = { ...quat };
    quatScratch.set(quat.x, quat.y, quat.z, quat.w);
    for (const [mount, history] of [
      [LIGHT_MOUNTS.navL, plane.left],
      [LIGHT_MOUNTS.navR, plane.right],
    ] as const) {
      tipScratch.set(mount.x, mount.y, mount.z).applyQuaternion(quatScratch);
      history.push(
        {
          x: pos.x + tipScratch.x,
          y: pos.y + tipScratch.y,
          z: pos.z + tipScratch.z,
        },
        timeMs,
        hard,
      );
    }
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
    let v = 0;
    for (const plane of this.planes.values()) {
      for (const history of [plane.left, plane.right]) {
        const anchor = history.anchor;
        if (!anchor) continue;
        const pts = history.points(nowMs);
        if (pts.length < 2) continue;
        // One nearest-image projection per ribbon; offsets are short.
        const base = nearestImage(viewer, anchor);
        for (let i = 1; i < pts.length && v + 6 <= MAX_VERTICES; i++) {
          const a = pts[i - 1] as (typeof pts)[number];
          const b = pts[i] as (typeof pts)[number];
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
          const wa = TRAIL_HALF_WIDTH * (0.5 + a.hard) * (1 - a.age01 * 0.6);
          const wb = TRAIL_HALF_WIDTH * (0.5 + b.hard) * (1 - b.age01 * 0.6);
          const alphaA =
            (1 - a.age01) * (TRAIL_BASE_ALPHA + TRAIL_TURN_ALPHA * a.hard);
          const alphaB =
            (1 - b.age01) * (TRAIL_BASE_ALPHA + TRAIL_TURN_ALPHA * b.hard);
          // Additive blending: bake alpha into RGB (ladder peak at hard=1).
          const ca = EMISSIVE_TRAIL * alphaA;
          const cb = EMISSIVE_TRAIL * alphaB;
          const quad = [
            [
              ax - sideScratch.x * wa,
              ay - sideScratch.y * wa,
              az - sideScratch.z * wa,
              ca,
            ],
            [
              ax + sideScratch.x * wa,
              ay + sideScratch.y * wa,
              az + sideScratch.z * wa,
              ca,
            ],
            [
              bx + sideScratch.x * wb,
              by + sideScratch.y * wb,
              bz + sideScratch.z * wb,
              cb,
            ],
            [
              ax - sideScratch.x * wa,
              ay - sideScratch.y * wa,
              az - sideScratch.z * wa,
              ca,
            ],
            [
              bx + sideScratch.x * wb,
              by + sideScratch.y * wb,
              bz + sideScratch.z * wb,
              cb,
            ],
            [
              bx - sideScratch.x * wb,
              by - sideScratch.y * wb,
              bz - sideScratch.z * wb,
              cb,
            ],
          ] as const;
          for (const [x, y, z, c] of quad) {
            this.positions[v * 3] = x;
            this.positions[v * 3 + 1] = y;
            this.positions[v * 3 + 2] = z;
            this.colors[v * 3] = TRAIL_GREY.r * c;
            this.colors[v * 3 + 1] = TRAIL_GREY.g * c;
            this.colors[v * 3 + 2] = TRAIL_GREY.b * c;
            v++;
          }
        }
      }
    }
    this.geometry.setDrawRange(0, v);
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate =
      true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate =
      true;
  }
}
