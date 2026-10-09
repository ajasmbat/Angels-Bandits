// Chase camera with lag. The chase state is the eye's OFFSET from the plane,
// not a world position (C1): a direction that swings after the nose in turns
// and a length that eases toward D(v), the chase distance for the airspeed
// (constants.ts) — so speed adds no lag, and corner brakes and boosts no
// longer make the camera breathe. Being relative, the eye always sits next to
// the plane's own image — when the plane's canonical coordinate jumps
// 2000→0 at the seam, the camera jumps WITH it and nothing moves on screen.
//
// Spring arm (L11b): when something solid sits between the plane and the
// displayed eye — a bridge deck on a climb-out from the river, a bank wall, a
// facade in a canyon turn — the eye is pulled in along its own line to the
// plane — at a steady rate, early enough for the cuts it foresees along the
// plane's path — let out slowly, and hard-clamped so it is never inside a
// solid. It never enters the chase state (`position`), and it only
// translates the view, never turns it (C1). aimFrame takes the same pull-in,
// so the cursor ray starts from the eye actually shown: the plane flies at
// what is under the cursor, even with the arm all the way in under a deck.

import type { Collapse } from "@angels-bandits/common/city/collapse";
import {
  CAMERA_RESPONSE,
  CHASE_BASE,
  CHASE_RISE,
  CHASE_STRETCH,
  COLLAPSE_LEAD_MS,
  MIN_SPEED,
} from "@angels-bandits/common/constants";
import { type FlightState, flightForward } from "@angels-bandits/common/flight";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import type * as THREE from "three";
import { orbitOffset } from "./freelook";
import { leadLookAt, stepLead } from "./jet-camera";
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
  /** Unit direction from the plane to the chase eye; null until snapped. */
  private dir: Vec3 | null = null;
  /** The chase eye's eased distance from the plane, m. */
  private len = 0;
  /** Plane + chase offset as of the last update or snap — frozen between
   * them (the kill-cam and the world placement read it while dead). */
  private pos: Vec3 = { x: 0, y: 0, z: 0 };
  /** The spring arm's eased length, as a fraction of the displayed arm. */
  private arm = 1;
  /** The pull-in last shown (eased arm or hard clamp), as a fraction of the
   * displayed arm; 1 = not pulled in. */
  private armShown = 1;
  /** Last frame's plane velocity, for the arm's lookahead. */
  private lastVel: Vec3 | null = null;
  /** Eased look-into-the-turn angle, rad, + = left (F6, jet-camera.ts). */
  private lead = 0;
  /** What the spring arm may not pass through; unset = no arm. */
  solid: SolidQuery | null = null;

  /** Smoothed camera position, for placing the world around the viewer. */
  get position(): Vec3 {
    return this.pos;
  }

  /** Hold the eye at `eye` (canonical) — a kill-cam that rides something
   * other than the plane (D4 wreck); the next snap or update takes over. */
  holdAt(eye: Vec3): void {
    this.pos.x = eye.x;
    this.pos.y = eye.y;
    this.pos.z = eye.z;
  }

  /** Snap directly behind the plane (spawn / respawn — no swoop across town). */
  snapTo(state: FlightState): void {
    this.dir = chaseDir(flightForward(state));
    this.len = chaseDistance(state.speed);
    this.place(state);
    this.arm = 1;
    this.armShown = 1;
    this.lastVel = null;
    this.lead = 0;
  }

  /**
   * The view the mouse-aim instructor reads the cursor through: eye and
   * look-at as offsets from the plane, at zoom `zoom`, built from the
   * smoothed chase state with the same dolly/look-at the render uses but
   * BEFORE any free-look orbit or turbulence shake — neither may steer.
   * The turn lead (F6) IS in it: it is part of what the cursor sits on. So
   * is the spring arm's last pull-in (C1), applied the way the render does —
   * the eye moves in along its line, the look direction stays.
   * Computed on demand (any zoom, so main can diff two of them), from the
   * chase offset as last updated or snapped, so it is never stale.
   */
  aimFrame(state: FlightState, zoom: number): { eye: Vec3; at: Vec3 } {
    if (!this.dir) this.snapTo(state);
    const fwd = flightForward(state);
    const chase = this.offset();
    const eye = zoom !== 0 ? zoomOffset(chase, fwd, zoom) : chase;
    const at = leadLookAt(
      eye,
      zoomLookAt({ x: 0, y: 0, z: 0 }, fwd, zoom),
      this.lead * (1 - zoom),
    );
    const k = this.armShown;
    if (k === 1) return { eye, at };
    return {
      eye: { x: eye.x * k, y: eye.y * k, z: eye.z * k },
      at: {
        x: at.x + eye.x * (k - 1),
        y: at.y + eye.y * (k - 1),
        z: at.z + eye.z * (k - 1),
      },
    };
  }

  /** The chase eye's offset from the plane. */
  private offset(): Vec3 {
    const d = this.dir as Vec3;
    return { x: d.x * this.len, y: d.y * this.len, z: d.z * this.len };
  }

  /** Re-place the eye at the plane's position plus the chase offset. */
  private place(state: FlightState): void {
    const off = this.offset();
    this.pos = {
      x: state.pos.x + off.x,
      y: state.pos.y + off.y,
      z: state.pos.z + off.z,
    };
  }

  update(
    camera: THREE.PerspectiveCamera,
    state: FlightState,
    dt: number,
    look?: { yaw: number; pitch: number },
    shake?: Vec3,
    zoom = 0,
    yawRate = 0,
  ): void {
    if (!this.dir) this.snapTo(state);
    // F6: the view leans into the turn the pilot is commanding (yawRate,
    // rad/s, + = left); out at full zoom, where the view axis is the gun line.
    this.lead = stepLead(this.lead, yawRate, dt);

    // Direction and length ease separately, so a turn swings the arm without
    // shortening it (a straight lerp of the offset would cut the chord).
    const fwd = flightForward(state);
    const blend = 1 - Math.exp(-CAMERA_RESPONSE * dt);
    const want = chaseDir(fwd);
    const d = this.dir as Vec3;
    const mixed = {
      x: d.x + (want.x - d.x) * blend,
      y: d.y + (want.y - d.y) * blend,
      z: d.z + (want.z - d.z) * blend,
    };
    const m = Math.hypot(mixed.x, mixed.y, mixed.z);
    this.dir =
      m > 1e-6 ? { x: mixed.x / m, y: mixed.y / m, z: mixed.z / m } : want;
    this.len += (chaseDistance(state.speed) - this.len) * blend;
    this.place(state);

    // From here on this is viewer-local math around the plane's own image
    // (the eye is an offset from it), not entity-to-entity world math —
    // plain arithmetic is correct.
    //
    // Free-look orbits the DISPLAYED camera around the plane; the chase state
    // itself stays un-orbited, so releasing E always eases back to the exact
    // chase framing and the orbit never feeds back into the smoothing.
    const aim = { x: state.pos.x, y: state.pos.y, z: state.pos.z };
    let view = this.pos;
    // Aim zoom (ANGE-G9CPCV) dollies the DISPLAYED eye in toward the nose and
    // swings the look-at out along the gun line. Like the orbit and the shake
    // below it rides `view`, never `this.pos` — so releasing the button eases
    // back to the exact chase framing and the dolly never feeds the smoothing.
    // It runs FIRST so the orbit rotates the shortened offset, not the long one.
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
    let at = leadLookAt(
      view,
      zoomLookAt(aim, fwd, zoom),
      this.lead * (1 - zoom),
    );
    // The spring arm runs LAST, on the eye actually shown, so neither the
    // orbit nor the shake can push it back into a wall. It moves the eye,
    // never the view direction (C1): the look-at rides along by the same
    // displacement, so the screen keeps pointing where aimFrame — what the
    // instructor steers by — says it does.
    this.armShown = this.solid
      ? this.springArm(
          aim,
          view,
          this.armLeads(state, fwd, aim, view, dt),
          dt,
          this.solid,
        )
      : 1;
    const k = this.armShown;
    if (k !== 1) {
      const armed = {
        x: aim.x + (view.x - aim.x) * k,
        y: aim.y + (view.y - aim.y) * k,
        z: aim.z + (view.z - aim.z) * k,
      };
      at = {
        x: at.x + armed.x - view.x,
        y: at.y + armed.y - view.y,
        z: at.z + armed.z - view.z,
      };
      view = armed;
    }
    camera.position.set(view.x, view.y, view.z);
    camera.lookAt(at.x, at.y, at.z);
  }

  /**
   * Where the plane and the displayed eye will be ARM_LEADS_S from now: the
   * plane's velocity and acceleration extrapolated (so a pull-up's rise
   * counts), and the eye by the chase model itself — the arm's direction
   * behind the extrapolated heading and its length for the extrapolated
   * speed, with today's lag on each decaying at CAMERA_RESPONSE. The display
   * modifiers' share of the offset (zoom, orbit, shake) is carried over
   * unchanged.
   */
  private armLeads(
    state: FlightState,
    fwd: Vec3,
    aim: Vec3,
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
    const d = this.dir as Vec3;
    const want = chaseDir(fwd);
    const dirLag = { x: d.x - want.x, y: d.y - want.y, z: d.z - want.z };
    const lenLag = this.len - chaseDistance(state.speed);
    // The display modifiers' share of today's offset.
    const p = this.pos;
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
      const speed = Math.hypot(v.x, v.y, v.z);
      const nose =
        speed > 1e-6 ? { x: v.x / speed, y: v.y / speed, z: v.z / speed } : fwd;
      const decay = Math.exp(-CAMERA_RESPONSE * t);
      const w = chaseDir(nose);
      const dx = w.x + dirLag.x * decay;
      const dy = w.y + dirLag.y * decay;
      const dz = w.z + dirLag.z * decay;
      const k =
        (chaseDistance(speed) + lenLag * decay) / (Math.hypot(dx, dy, dz) || 1);
      const off = {
        x: dx * k + extra.x,
        y: dy * k + extra.y,
        z: dz * k + extra.z,
      };
      return { t, from, off };
    });
  }

  /** How far to pull `view` in toward `aim` (the plane), as a fraction of
   * the arm, so the line between them is clear of solids: the eased arm,
   * never longer than the clear length now, and pulled in early enough for
   * the cuts `leads` foresee. */
  private springArm(
    aim: Vec3,
    view: Vec3,
    leads: readonly ArmLead[],
    dt: number,
    solid: SolidQuery,
  ): number {
    const off = { x: view.x - aim.x, y: view.y - aim.y, z: view.z - aim.z };
    const len = Math.hypot(off.x, off.y, off.z);
    if (len < 1e-6 || dt <= 0) return 1;
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
    return Math.min(this.arm, hard);
  }
}

/** The chase eye's distance from the plane at airspeed `speed`, m: D(v),
 * an explicit function of speed (C1), not a by-product of lag. */
function chaseDistance(speed: number): number {
  return CHASE_BASE + CHASE_STRETCH * Math.max(0, speed - MIN_SPEED);
}

/** Unit direction from the plane to its chase eye for the unit nose `fwd`:
 * straight back along the nose and CHASE_RISE up (never zero: |fwd| = 1 and
 * CHASE_RISE < 1). */
function chaseDir(fwd: Vec3): Vec3 {
  const x = -fwd.x;
  const y = CHASE_RISE - fwd.y;
  const z = -fwd.z;
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
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

/** D3: peak camera shake next to a collapse coming down, m. */
export const COLLAPSE_SHAKE_PEAK = 1.4;
/** …fading to nothing this far from it, m. */
export const COLLAPSE_SHAKE_RANGE = 600;

/**
 * D3: how hard the ground is shaking at `pos` at server time `serverMs`,
 * 0..1 — every collapse from its first movement until a second after its
 * last chunk lands, strongest for the big ones, falling off with distance
 * (torus-correct). Pure, so tests and main.ts agree.
 */
export function collapseShakeAmount(
  list: readonly Collapse[],
  pos: Vec3,
  serverMs: number,
): number {
  let amount = 0;
  for (let e = 0; e < list.length; e++) {
    const c = list[e] as Collapse;
    const age = serverMs - c.t0 - COLLAPSE_LEAD_MS;
    if (age < 0 || age > c.endMs - COLLAPSE_LEAD_MS + 1000) continue;
    const d = Math.hypot(
      wrapDeltaAxis(c.x, pos.x),
      pos.y * 0.5,
      wrapDeltaAxis(c.z, pos.z),
    );
    if (d >= COLLAPSE_SHAKE_RANGE) continue;
    const size = Math.min(1, 0.35 + c.n / 120);
    const near = 1 - d / COLLAPSE_SHAKE_RANGE;
    amount = Math.max(amount, size * near * near);
  }
  return amount;
}

/** The displayed camera's offset for a shake `amount` (0..1) at wall time
 * `nowMs`: a fast irregular jolt, mostly vertical. */
export function collapseShakeOffset(amount: number, nowMs: number): Vec3 {
  if (amount <= 0) return { x: 0, y: 0, z: 0 };
  const t = nowMs / 1000;
  const a = amount * COLLAPSE_SHAKE_PEAK;
  return {
    x: a * 0.5 * (Math.sin(t * 37.1) + 0.5 * Math.sin(t * 71.3 + 1.7)),
    y: a * (Math.sin(t * 43.7 + 0.4) + 0.5 * Math.sin(t * 89.9 + 2.1)),
    z: a * 0.5 * (Math.sin(t * 31.3 + 2.9) + 0.5 * Math.sin(t * 67.7 + 0.8)),
  };
}
