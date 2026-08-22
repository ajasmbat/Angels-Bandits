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

import { TURN_RATE } from "@angels-bandits/common/constants";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";

/** How long a trail point lives, ms (~the plan's "short ribbon trails"). */
export const TRAIL_LIFETIME_MS = 1500;

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
    this.pts.push({ off: { x: 0, y: 0, z: 0 }, t: timeMs, hard });
  }

  /**
   * Live points oldest-first: anchor-relative offset, age01 (0 = newest,
   * 1 = about to expire), and recorded hardness. Prunes expired points.
   */
  points(nowMs: number): { off: Vec3; age01: number; hard: number }[] {
    while (this.pts.length && nowMs - (this.pts[0] as TrailPoint).t > TRAIL_LIFETIME_MS) {
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
