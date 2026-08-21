// Torus-aware lead indicator (PLAN.md → Combat): for the nearest target close
// to the aim direction, solve where a bullet fired now meets it and float a
// reticle there. The intercept solver is the pure seam below (quadratic in
// wrapDelta space); target picking + the DOM reticle are thin adapters.

import { BULLET_RANGE, BULLET_SPEED } from "@angels-bandits/common/constants";
import { type FlightState, flightForward } from "@angels-bandits/common/flight";
import {
  type Vec3,
  canonicalize,
  wrapDelta,
} from "@angels-bandits/common/world";
import type * as THREE from "three";
import { nearestImage } from "../render/wrapPlacement";

/** Only targets within this of the aim direction get a reticle (~26°). */
const AIM_CONE_COS = 0.9;
/** Targets farther than this get no reticle — the bullet would die en route. */
const LEAD_MAX_RANGE = BULLET_RANGE * 1.2;

export interface LeadTarget {
  pos: Vec3;
  vel: Vec3;
}

/**
 * Where a bullet at `bulletSpeed` m/s fired from `shooter` NOW meets a
 * target moving at constant velocity: the canonical intercept point, or null
 * when no forward-time intercept exists (target outruns the bullet).
 * Solves |d + v·t| = s·t with d = wrapDelta(shooter, target.pos).
 */
export function leadPoint(
  shooter: Vec3,
  bulletSpeed: number,
  target: LeadTarget,
): Vec3 | null {
  const d = wrapDelta(shooter, target.pos);
  const v = target.vel;
  const a = v.x * v.x + v.y * v.y + v.z * v.z - bulletSpeed * bulletSpeed;
  const b = 2 * (d.x * v.x + d.y * v.y + d.z * v.z);
  const c = d.x * d.x + d.y * d.y + d.z * d.z;

  let t: number;
  if (Math.abs(a) < 1e-9) {
    // Target speed ≈ bullet speed: the quadratic degenerates to b·t + c = 0.
    if (b >= 0) return null;
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
    if (t <= 0) return null;
  }
  return canonicalize({
    x: shooter.x + d.x + v.x * t,
    y: shooter.y + d.y + v.y * t,
    z: shooter.z + d.z + v.z * t,
  });
}

/** DOM reticle over the intercept point of the best on-aim target. */
export class LeadIndicator {
  private readonly el = document.getElementById("lead") as HTMLDivElement;

  /** Pick the target nearest the aim direction, inside cone and range. */
  private pick(flight: FlightState, targets: readonly LeadTarget[]) {
    const fwd = flightForward(flight);
    let best: LeadTarget | null = null;
    let bestCos = AIM_CONE_COS;
    for (const t of targets) {
      const d = wrapDelta(flight.pos, t.pos);
      const dist = Math.hypot(d.x, d.y, d.z);
      if (dist === 0 || dist > LEAD_MAX_RANGE) continue;
      const cos = (d.x * fwd.x + d.y * fwd.y + d.z * fwd.z) / dist;
      if (cos > bestCos) {
        bestCos = cos;
        best = t;
      }
    }
    return best;
  }

  /** Recompute and place (or hide) the reticle. Call after the render. */
  update(
    camera: THREE.Camera,
    viewer: Vec3,
    flight: FlightState,
    targets: readonly LeadTarget[],
    scratch: THREE.Vector3,
  ): void {
    const target = this.pick(flight, targets);
    // Bullets inherit the plane's forward speed (guns.ts) — lead with it.
    const point =
      target && leadPoint(flight.pos, BULLET_SPEED + flight.speed, target);
    if (!point) {
      this.el.style.display = "none";
      return;
    }
    const p = nearestImage(viewer, point);
    scratch.set(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse);
    if (scratch.z >= 0) {
      // Behind the camera — no reticle.
      this.el.style.display = "none";
      return;
    }
    scratch.applyMatrix4(camera.projectionMatrix);
    const px = ((scratch.x + 1) / 2) * window.innerWidth;
    const py = ((1 - scratch.y) / 2) * window.innerHeight;
    this.el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
    this.el.style.display = "block";
  }
}
