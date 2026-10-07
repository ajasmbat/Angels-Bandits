// Chase camera with lag. The camera lives in render space: before smoothing,
// its remembered position is re-aligned to the torus image nearest the plane
// (via wrapDelta, through nearestImage) — so when the plane's canonical
// coordinate jumps 2000→0 at the seam, the camera jumps WITH it and nothing
// moves on screen. That re-alignment is the whole seam trick for the viewer.
//
// Spring arm (L11b): when something solid sits between the plane and the
// displayed eye — a bridge deck on a climb-out from the river, a bank wall, a
// facade in a canyon turn — the eye is pulled in along its own line to the
// plane — at a steady rate, early enough for the cuts it foresees along the
// plane's path — let out slowly, and hard-clamped so it is never inside a
// solid. Like the orbit and the shake it is display-only: neither
// `position` (the chase state) nor `aimFrame` ever sees it.

import {
  CAMERA_RESPONSE,
  CHASE_DISTANCE,
  CHASE_HEIGHT,
} from "@angels-bandits/common/constants";
import { type FlightState, flightForward } from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import type * as THREE from "three";
import { nearestImage } from "../render/wrapPlacement";
import { orbitOffset } from "./freelook";
import { zoomLookAt, zoomOffset } from "./zoom";

/** Does a sphere of radius `r` at `p` (render space: any torus image)
 * touch something solid? */
export type SolidQuery = (p: Vec3, r: number) => boolean;

/** The eye's clearance sphere, m: comfortably more than the near plane's
 * half-diagonal (near 0.1 m), so the near plane never cuts into a solid. */
const ARM_RADIUS = 0.3;
/** Extra clearance the eased target keeps, m, so the pull-in starts before
 * the hard clamp has to act. */
const ARM_PAD = 1.2;
/** Sweep step along the arm, m (< 2·ARM_RADIUS: no gap between samples). */
const ARM_STEP = 0.5;
/** The target also sweeps from where the plane will be at these times
 * ahead, s (velocity and acceleration extrapolated, so a pull-up's rise
 * counts): a deck edge about to cut the arm starts the pull-in in time. */
const ARM_LEADS_S = [0.1, 0.2, 0.35, 0.5, 0.7, 1];
/** Most acceleration the lookahead believes, m/s² (a frame hitch must not
 * fling it across town). */
const ARM_ACCEL_MAX = 80;
/** The pull-in runs at a steady ARM_IN_SPEED, m/s (no snap even when the
 * target drops at once); a solid cutting the arm `t` s from now caps the arm
 * at its clear length there plus ARM_IN_SPEED·t — pulled in just in time,
 * never earlier than it must. The release eases out over ARM_OUT_S, s. */
const ARM_OUT_S = 0.45;
const ARM_IN_SPEED = 60;
/** The pull-in's top speed once a solid is already within the pad of the
 * arm (the lookahead missed it), m/s: a fast swoop, still not a cut. */
const ARM_URGENT_SPEED = 150;

export class ChaseCamera {
  private pos: Vec3 | null = null;
  /** The spring arm's eased length, as a fraction of the displayed arm. */
  private arm = 1;
  /** Last frame's plane velocity, for the arm's lookahead. */
  private lastVel: Vec3 | null = null;
  /** What the spring arm may not pass through; unset = no arm. */
  solid: SolidQuery | null = null;

  /** Smoothed camera position, for placing the world around the viewer. */
  get position(): Vec3 {
    return this.pos ?? { x: 0, y: 0, z: 0 };
  }

  /** Snap directly behind the plane (spawn / respawn — no swoop across town). */
  snapTo(state: FlightState): void {
    this.pos = this.desired(state);
    this.arm = 1;
    this.lastVel = null;
  }

  /**
   * The view the mouse-aim instructor reads the cursor through: eye and
   * look-at as offsets from the plane, at zoom `zoom`, built from the
   * smoothed chase state with the same dolly/look-at the render uses but
   * BEFORE any free-look orbit or turbulence shake — neither may steer.
   * Computed on demand (any zoom, so main can diff two of them), from the
   * chase position as last updated or snapped, so it is never stale.
   */
  aimFrame(state: FlightState, zoom: number): { eye: Vec3; at: Vec3 } {
    if (!this.pos) this.snapTo(state);
    const plane = nearestImage(this.pos as Vec3, state.pos);
    const p = this.pos as Vec3;
    const fwd = flightForward(state);
    const chase = { x: p.x - plane.x, y: p.y - plane.y, z: p.z - plane.z };
    const eye = zoom !== 0 ? zoomOffset(chase, fwd, zoom) : chase;
    const at = zoomLookAt({ x: 0, y: 0, z: 0 }, fwd, zoom);
    return { eye, at };
  }

  private desired(state: FlightState): Vec3 {
    const fwd = flightForward(state);
    return {
      x: state.pos.x - fwd.x * CHASE_DISTANCE,
      y: state.pos.y - fwd.y * CHASE_DISTANCE + CHASE_HEIGHT,
      z: state.pos.z - fwd.z * CHASE_DISTANCE,
    };
  }

  update(
    camera: THREE.PerspectiveCamera,
    state: FlightState,
    dt: number,
    look?: { yaw: number; pitch: number },
    shake?: Vec3,
    zoom = 0,
  ): void {
    if (!this.pos) this.snapTo(state);
    else this.pos = nearestImage(state.pos, this.pos); // seam re-alignment

    // From here on this is viewer-local math on already-aligned images, not
    // entity-to-entity world math — plain arithmetic is correct.
    const target = this.desired(state);
    const blend = 1 - Math.exp(-CAMERA_RESPONSE * dt);
    const p = this.pos as Vec3;
    this.pos = {
      x: p.x + (target.x - p.x) * blend,
      y: p.y + (target.y - p.y) * blend,
      z: p.z + (target.z - p.z) * blend,
    };

    // Free-look orbits the DISPLAYED camera around the plane; the chase state
    // itself stays un-orbited, so releasing E always eases back to the exact
    // chase framing and the orbit never feeds back into the smoothing.
    const aim = nearestImage(this.pos, state.pos);
    let view = this.pos as Vec3;
    // Aim zoom (ANGE-G9CPCV) dollies the DISPLAYED eye in toward the nose and
    // swings the look-at out along the gun line. Like the orbit and the shake
    // below it rides `view`, never `this.pos` — so releasing the button eases
    // back to the exact chase framing and the dolly never feeds the smoothing.
    // It runs FIRST so the orbit rotates the shortened offset, not the long one.
    const fwd = flightForward(state);
    if (zoom !== 0) {
      const off = zoomOffset(
        { x: view.x - aim.x, y: view.y - aim.y, z: view.z - aim.z },
        fwd,
        zoom,
      );
      view = { x: aim.x + off.x, y: aim.y + off.y, z: aim.z + off.z };
    }
    if (look && (look.yaw !== 0 || look.pitch !== 0)) {
      const off = orbitOffset(
        { x: view.x - aim.x, y: view.y - aim.y, z: view.z - aim.z },
        look.yaw,
        look.pitch,
      );
      view = { x: aim.x + off.x, y: aim.y + off.y, z: aim.z + off.z };
    }
    // Turbulence shake (ST2) displaces the DISPLAYED camera only — like the
    // free-look orbit, it never enters the chase state or the flight state,
    // so nothing visual can leak into the streamed pose.
    if (shake) {
      view = { x: view.x + shake.x, y: view.y + shake.y, z: view.z + shake.z };
    }
    // The spring arm runs LAST, on the eye actually shown, so neither the
    // orbit nor the shake can push it back into a wall.
    if (this.solid) {
      const leads = this.armLeads(state, fwd, aim, target, view, dt);
      view = this.springArm(aim, view, leads, dt, this.solid);
    }
    camera.position.set(view.x, view.y, view.z);
    const at = zoomLookAt(aim, fwd, zoom);
    camera.lookAt(at.x, at.y, at.z);
  }

  /**
   * Where the plane and the displayed eye will be ARM_LEADS_S from now: the
   * plane's velocity and acceleration extrapolated (so a pull-up's rise
   * counts), and the eye by the chase model itself — the desired pose behind
   * the extrapolated heading, with today's lag decaying at CAMERA_RESPONSE.
   * The display modifiers' share of the offset (zoom, orbit, shake) is
   * carried over unchanged.
   */
  private armLeads(
    state: FlightState,
    fwd: Vec3,
    aim: Vec3,
    target: Vec3,
    view: Vec3,
    dt: number,
  ): ArmLead[] {
    const vel = {
      x: fwd.x * state.speed,
      y: fwd.y * state.speed,
      z: fwd.z * state.speed,
    };
    const prev = this.lastVel;
    this.lastVel = vel;
    let acc = { x: 0, y: 0, z: 0 };
    if (prev && dt > 0) {
      acc = {
        x: (vel.x - prev.x) / dt,
        y: (vel.y - prev.y) / dt,
        z: (vel.z - prev.z) / dt,
      };
      const a = Math.hypot(acc.x, acc.y, acc.z);
      if (a > ARM_ACCEL_MAX) {
        const k = ARM_ACCEL_MAX / a;
        acc = { x: acc.x * k, y: acc.y * k, z: acc.z * k };
      }
    }
    const p = this.pos as Vec3;
    const lag = { x: p.x - target.x, y: p.y - target.y, z: p.z - target.z };
    // The display modifiers' share of today's offset.
    const extra = { x: view.x - p.x, y: view.y - p.y, z: view.z - p.z };
    return ARM_LEADS_S.map((t) => {
      const h = 0.5 * t * t;
      const from = {
        x: aim.x + vel.x * t + acc.x * h,
        y: aim.y + vel.y * t + acc.y * h,
        z: aim.z + vel.z * t + acc.z * h,
      };
      const v = {
        x: vel.x + acc.x * t,
        y: vel.y + acc.y * t,
        z: vel.z + acc.z * t,
      };
      const speed = Math.hypot(v.x, v.y, v.z) || 1;
      const decay = Math.exp(-CAMERA_RESPONSE * t);
      const back = CHASE_DISTANCE / speed;
      const off = {
        x: -v.x * back + lag.x * decay + extra.x,
        y: -v.y * back + CHASE_HEIGHT + lag.y * decay + extra.y,
        z: -v.z * back + lag.z * decay + extra.z,
      };
      return { t, from, off };
    });
  }

  /** `view` pulled in toward `aim` (the plane) so the line between them is
   * clear of solids: the eased arm, never longer than the clear length now,
   * and pulled in early enough for the cuts `leads` foresee. */
  private springArm(
    aim: Vec3,
    view: Vec3,
    leads: readonly ArmLead[],
    dt: number,
    solid: SolidQuery,
  ): Vec3 {
    const off = { x: view.x - aim.x, y: view.y - aim.y, z: view.z - aim.z };
    const len = Math.hypot(off.x, off.y, off.z);
    if (len < 1e-6 || dt <= 0) return view;
    // The padded sweeps — from the plane now and over the next ARM_LEADS_S —
    // set the eased target as a fraction of the arm, each lead t allowing
    // ARM_IN_SPEED·t of slack; only when the one from now is blocked can the
    // tight one (the hard clamp) be short of the arm.
    const pad = ARM_RADIUS + ARM_PAD;
    const now = clearLength(aim, off, len, pad, solid) / len;
    let target = now;
    for (const lead of leads) {
      const slack = (ARM_IN_SPEED * lead.t) / len;
      if (target <= slack) break; // no later cut can bind tighter
      const l = Math.hypot(lead.off.x, lead.off.y, lead.off.z);
      if (l < 1e-6) continue;
      const clear = clearLength(lead.from, lead.off, l, pad, solid) / l;
      target = Math.min(target, clear + slack);
    }
    const hard =
      now < 1 ? clearLength(aim, off, len, ARM_RADIUS, solid) / len : 1;
    if (target < this.arm) {
      // In at a steady rate: the lead slack assumes exactly this speed.
      const speed = now < this.arm ? ARM_URGENT_SPEED : ARM_IN_SPEED;
      this.arm = Math.max(target, this.arm - (speed * dt) / len);
    } else {
      this.arm += (target - this.arm) * (1 - Math.exp(-dt / ARM_OUT_S));
    }
    const k = Math.min(this.arm, hard);
    return { x: aim.x + off.x * k, y: aim.y + off.y * k, z: aim.z + off.z * k };
  }
}

/** A lookahead sample: the plane `t` s from now, and the eye's offset. */
interface ArmLead {
  t: number;
  from: Vec3;
  off: Vec3;
}

/** How far along `off` (length `len`) from `from` a sphere of radius `r`
 * stays clear: the last clear sample (every ARM_STEP, and the end) before the
 * first blocked one, or `len` when every sample is clear. */
function clearLength(
  from: Vec3,
  off: Vec3,
  len: number,
  r: number,
  solid: SolidQuery,
): number {
  const n = Math.ceil(len / ARM_STEP);
  const at = (i: number): Vec3 => {
    const k = Math.min(i * ARM_STEP, len) / len;
    return {
      x: from.x + off.x * k,
      y: from.y + off.y * k,
      z: from.z + off.z * k,
    };
  };
  // Bisection over the samples (i0, i1]: one sphere around a stretch rules
  // the whole stretch out, so open air and far solids cost a few queries.
  const first = (i0: number, i1: number): number | null => {
    if (i1 - i0 === 1) return solid(at(i1), r) ? i1 : null;
    const a = at(i0);
    const b = at(i1);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    const half = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 2;
    if (!solid(mid, half + r)) return null;
    const m = (i0 + i1) >> 1;
    return first(i0, m) ?? first(m, i1);
  };
  const hit = n > 0 ? first(0, n) : null;
  return hit === null ? len : Math.min(len, (hit - 1) * ARM_STEP);
}
