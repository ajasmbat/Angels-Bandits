// Torus-aware lead indicator (PLAN.md → Combat): for the nearest target close
// to the aim direction, solve where a bullet fired now meets it and float a
// reticle there. The intercept solver is the pure seam below (quadratic in
// wrapDelta space); target picking + the DOM reticle are thin adapters.

import {
  BULLET_RANGE,
  BULLET_SPEED,
  HIT_RADIUS,
} from "@angels-bandits/common/constants";
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
/** Off-axis ceiling for a firing solution. Miss distance alone would sit hot
 * through a whole knife fight: 6 m of miss at 20 m range is 17 degrees off. */
const MAX_SOLUTION_ANGLE = (4 * Math.PI) / 180;
/** Minimum gap between solution ticks, so a jinking target can't machine-gun it. */
const SOLUTION_TONE_COOLDOWN_MS = 400;

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

/** How far off the gun line a point sits, in metres and in radians. */
export interface AimError {
  /** Perpendicular distance from the gun line — what actually decides a hit. */
  miss: number;
  /** Angle between the nose and the point. Behind the plane is > 90 degrees. */
  angleRad: number;
}

/**
 * Measure a point against the gun line. Pure geometry over `wrapDelta`, with
 * no camera or FOV input — which is exactly why the verdict cannot change
 * with the zoom level or the window size.
 */
export function solutionMiss(flight: FlightState, point: Vec3): AimError {
  const d = wrapDelta(flight.pos, point);
  const dist = Math.hypot(d.x, d.y, d.z);
  if (dist === 0) return { miss: 0, angleRad: 0 };
  const fwd = flightForward(flight);
  const along = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;
  const cos = Math.min(1, Math.max(-1, along / dist));
  const angleRad = Math.acos(cos);
  return { miss: dist * Math.sin(angleRad), angleRad };
}

/**
 * Hot means "these bullets would connect": inside the shared hit radius, and
 * genuinely lined up rather than merely close because the target is on top of
 * you. A flat angular threshold would be 7.3 m of slop at 350 m and 1.0 m at
 * 50 m — the same cue meaning wildly different things at different ranges.
 */
export function hasSolution(e: AimError): boolean {
  return e.miss < HIT_RADIUS && e.angleRad < MAX_SOLUTION_ANGLE;
}

/**
 * When to sound the solution tick: on ACQUIRING it, never while it holds, and
 * never twice inside the cooldown. Pure policy, injected `now` — GameAudio has
 * no tests by design, so the decision lives out here where it can have some.
 */
export class SolutionTone {
  private wasHot = false;
  private lastAt = Number.NEGATIVE_INFINITY;

  shouldPlay(hot: boolean, nowMs: number): boolean {
    const rising = hot && !this.wasHot;
    this.wasHot = hot;
    if (!rising || nowMs - this.lastAt < SOLUTION_TONE_COOLDOWN_MS) {
      return false;
    }
    this.lastAt = nowMs;
    return true;
  }
}

/**
 * Where the gun line reaches at `range`. guns.ts fires from alternating
 * wingtips with velocity exactly along flightForward, so the honest single
 * line is the plane's centreline — this is the point bullets occupy at the
 * end of their effective range.
 */
export function gunLinePoint(flight: FlightState, range: number): Vec3 {
  const fwd = flightForward(flight);
  return canonicalize({
    x: flight.pos.x + fwd.x * range,
    y: flight.pos.y + fwd.y * range,
    z: flight.pos.z + fwd.z * range,
  });
}

/**
 * Project a canonical world point to pixels for the viewer, or null when it is
 * behind the camera. Call AFTER the render, when the matrices are fresh — and
 * after any FOV write, or it projects with the previous frame's projection.
 */
export function projectToScreen(
  camera: THREE.Camera,
  viewer: Vec3,
  point: Vec3,
  scratch: THREE.Vector3,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const p = nearestImage(viewer, point);
  scratch.set(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse);
  if (scratch.z >= 0) return null; // behind the camera
  scratch.applyMatrix4(camera.projectionMatrix);
  return {
    x: ((scratch.x + 1) / 2) * width,
    y: ((1 - scratch.y) / 2) * height,
  };
}

/** What one frame of aim chrome resolved to. */
export interface AimResult {
  /** Where the gun line lands on screen, or null when it is behind us. */
  aim: { x: number; y: number } | null;
  /** Whether the shot is on — the lead reticle is hot this frame. */
  solution: boolean;
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

  /**
   * Recompute and place (or hide) the reticle, and return where the gun line
   * lands on screen so the HUD can put the pipper (and the hitmarker) there.
   * Call AFTER the render and after any FOV write — it reads the camera's
   * matrices directly.
   */
  update(
    camera: THREE.Camera,
    viewer: Vec3,
    flight: FlightState,
    targets: readonly LeadTarget[],
    scratch: THREE.Vector3,
  ): AimResult {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aim = projectToScreen(
      camera,
      viewer,
      gunLinePoint(flight, BULLET_RANGE),
      scratch,
      w,
      h,
    );
    const target = this.pick(flight, targets);
    // Bullets inherit the plane's forward speed (guns.ts) — lead with it.
    const point =
      target && leadPoint(flight.pos, BULLET_SPEED + flight.speed, target);
    // The solution is world geometry, decided before anything is projected —
    // so it reads the same at every zoom level and every window size.
    const solution = point ? hasSolution(solutionMiss(flight, point)) : false;
    this.el.classList.toggle("solution", solution);
    const px = point
      ? projectToScreen(camera, viewer, point, scratch, w, h)
      : null;
    if (!px) {
      // No target, or behind the camera — no reticle.
      this.el.style.display = "none";
      return { aim, solution: false };
    }
    this.el.style.transform = `translate(${px.x.toFixed(1)}px, ${px.y.toFixed(1)}px)`;
    this.el.style.display = "block";
    return { aim, solution };
  }
}
