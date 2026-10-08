// Jet camera feel (F6) — the pure seam. Two small, display-side touches the
// chase camera and main's FOV pick up: a look-into-the-turn lead and a gentle
// speed FOV. Same shape as zoom.ts / freelook.ts: renderer-free functions over
// plain numbers, thin hooks in camera.ts and main.ts. CLIENT-ONLY — nothing
// here touches the wire, common/ or the flight state.
//
// The lead is read through the same view the mouse-aim instructor reads the
// cursor through (ChaseCamera.aimFrame), so the cursor ray is always the one
// on screen. That makes it part of the aim loop: a held cursor's turn feeds
// the lead, which swings the cursor ray further into the turn. Two things
// keep that harmless — the lead is EXACTLY zero below LEAD_DEADBAND (all fine
// gun tracking happens there), and above it the turn is already near its
// rate limit, so the extra error has almost no rate left to add.

import { MAX_SPEED, MIN_SPEED } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";

/** Lead angle per rad/s of commanded yaw rate beyond the deadband, rad:
 * ~1.4° in a full-rate turn at MAX_SPEED, ~2.7° at MIN_SPEED. Sized with the
 * aim loop closed through it: a held cursor turns at most ~1.12× main's
 * rate (speed FOV included), and a 30° step gains no overshoot. */
const TURN_LEAD = 0.05;
/** Commanded yaw rate under which there is no lead at all, rad/s. */
const LEAD_DEADBAND = 0.4;
/** Most the view ever leads into a turn, rad (~2.9°). */
const LEAD_MAX = 0.05;
/** Exp response of the lead toward its target, 1/s — it leans in and lets
 * go over ~1 s, never snapping with the stick. */
const LEAD_RESPONSE = 3;
/** Extra vertical FOV at MAX_SPEED over MIN_SPEED, degrees: a gentle sense
 * of speed. Above MAX_SPEED main's boost kick takes over (they stack: at
 * full boost the view is 70 + 4 + 9 = 83°). */
const SPEED_FOV_KICK = 4;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** The lead angle a commanded yaw rate (rad/s, + = left, flight.ts yaw
 * convention) asks for, rad, + = look left. Continuous: it rises from zero
 * at the deadband edge, so it can't kick the aim loop there. */
export function leadTarget(yawRate: number): number {
  const over = Math.max(0, Math.abs(yawRate) - LEAD_DEADBAND);
  return Math.sign(yawRate) * Math.min(LEAD_MAX, TURN_LEAD * over);
}

/** Ease the lead toward its target over `dt` (frame-rate independent). */
export function stepLead(lead: number, yawRate: number, dt: number): number {
  const blend = 1 - Math.exp(-LEAD_RESPONSE * dt);
  return lead + (leadTarget(yawRate) - lead) * blend;
}

/**
 * Swing the look-at `at` about world-up through the eye `eye` by `angle`
 * (rad, + = left, the yaw convention). Any common origin works — main's
 * render space or aimFrame's plane-relative offsets. Returns `at` itself at 0.
 */
export function leadLookAt(eye: Vec3, at: Vec3, angle: number): Vec3 {
  if (angle === 0) return at;
  const dx = at.x - eye.x;
  const dz = at.z - eye.z;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: eye.x + dx * c + dz * s, y: at.y, z: eye.z - dx * s + dz * c };
}

/** Extra vertical FOV for airspeed, degrees: 0 at MIN_SPEED, SPEED_FOV_KICK
 * at MAX_SPEED and above. */
export function speedFov(speed: number): number {
  return (
    SPEED_FOV_KICK * clamp((speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED), 0, 1)
  );
}
