// Hold-E free-look (B2) — the pure seam. All the math behind "look around
// while the plane holds course" lives here, renderer-free (same pattern as
// net/interp.ts and ui/lead.ts): a per-frame step function over immutable
// state, thin adapters in flight-input/camera/main. CLIENT-ONLY by design —
// the shaped input feeds the existing stepFlight; nothing here touches the
// wire or common/.

import type { FlightInput } from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";

/** The free-look key, hardcoded for now (no keybinding UI yet). */
export const FREELOOK_KEY = "KeyE";

/** Seconds of E-held for steering authority to ramp 1 → 0 (linear). */
const STEER_DECAY_S = 0.3;
/** Orbit radians per pixel of mouse motion (steering uses cursor position,
 * free-look uses motion — separate constant by nature, hand-tuned). */
export const LOOK_SENSITIVITY = 0.004;
/** Exp response 1/s: ≥95% of the commanded orbit within 0.15 s. */
const LOOK_ENTER_RESPONSE = 22;
/** Exp response 1/s: released offsets ≤5% within 0.25 s, then snapped. */
const LOOK_EXIT_RESPONSE = 13;
/** Radians below which a released offset snaps to exactly zero. */
const LOOK_SNAP_EPSILON = 1e-3;
/** Commanded look pitch is clamped to ±80° (spec); yaw is unbounded. */
const LOOK_PITCH_LIMIT = (80 * Math.PI) / 180;
/** Total camera elevation cap: the base chase offset already sits above the
 * horizon, so base + look pitch could cross the pole — clamp short of it. */
const ORBIT_ELEVATION_LIMIT = (88 * Math.PI) / 180;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export interface FreeLookState extends SteerAuthority {
  /** Whether E is currently held (edge rules key off this, not events). */
  held: boolean;
  /** Mouse-commanded orbit angles, radians. Yaw unbounded (wraps). */
  targetYaw: number;
  targetPitch: number;
  /** Applied (eased) orbit angles the camera actually uses, radians. */
  yaw: number;
  pitch: number;
}

/** Fresh, inactive free-look (spawn / death force-exit). */
export function createFreeLook(): FreeLookState {
  return {
    held: false,
    steer: 1,
    targetYaw: 0,
    targetPitch: 0,
    yaw: 0,
    pitch: 0,
  };
}

/** Ease toward zero, snapping when within epsilon so exit truly ends. */
function decayToZero(v: number, blend: number): number {
  const next = v - v * blend;
  return Math.abs(next) < LOOK_SNAP_EPSILON ? 0 : next;
}

/**
 * Advance one frame. While E is held, mouse deltas (px) accumulate into the
 * commanded orbit and steering authority ramps linearly to neutral over
 * STEER_DECAY_S; the applied angles chase the command critically-damped.
 * Releasing restores full authority instantly — fresh input must bite on the
 * very next frame — while the offsets ease back to zero and snap out.
 */
export function stepFreeLook(
  s: FreeLookState,
  held: boolean,
  dx: number,
  dy: number,
  dt: number,
): FreeLookState {
  if (!held) {
    const blend = 1 - Math.exp(-LOOK_EXIT_RESPONSE * dt);
    return {
      held: false,
      steer: 1,
      targetYaw: 0,
      targetPitch: 0,
      yaw: decayToZero(s.yaw, blend),
      pitch: decayToZero(s.pitch, blend),
    };
  }
  const targetYaw = s.targetYaw + dx * LOOK_SENSITIVITY;
  const targetPitch = clamp(
    s.targetPitch + dy * LOOK_SENSITIVITY,
    -LOOK_PITCH_LIMIT,
    LOOK_PITCH_LIMIT,
  );
  const blend = 1 - Math.exp(-LOOK_ENTER_RESPONSE * dt);
  return {
    held: true,
    steer: Math.max(0, s.steer - dt / STEER_DECAY_S),
    targetYaw,
    targetPitch,
    yaw: s.yaw + (targetYaw - s.yaw) * blend,
    pitch: s.pitch + (targetPitch - s.pitch) * blend,
  };
}

/**
 * Rotate a viewer-local camera offset (camera − plane, images already
 * aligned) around the plane by the applied look angles: yaw about +Y, pitch
 * as added elevation. Radius is preserved and total elevation is clamped
 * short of the poles, so the result is NaN-free for any input — including a
 * zero or straight-overhead base offset.
 */
export function orbitOffset(o: Vec3, yaw: number, pitch: number): Vec3 {
  const r = Math.hypot(o.x, o.y, o.z);
  if (r < 1e-9) return { x: o.x, y: o.y, z: o.z };
  const baseYaw = Math.atan2(o.x, o.z);
  const baseElev = Math.asin(clamp(o.y / r, -1, 1));
  const orbYaw = baseYaw + yaw;
  const orbElev = clamp(
    baseElev + pitch,
    -ORBIT_ELEVATION_LIMIT,
    ORBIT_ELEVATION_LIMIT,
  );
  return {
    x: r * Math.cos(orbElev) * Math.sin(orbYaw),
    y: r * Math.sin(orbElev),
    z: r * Math.cos(orbElev) * Math.cos(orbYaw),
  };
}

/** Axis × authority, without ever emitting IEEE −0 at full decay. */
const scaleAxis = (v: number, k: number): number => (k === 0 ? 0 : v * k);

/** Anything that can spend steering authority: free-look, the aim zoom, or
 * their product. Kept structural so shapeInput stays the single seam. */
export interface SteerAuthority {
  /** Steering authority 0..1: scales turn/pitch/roll, never throttle. */
  steer: number;
}

/** Scale the steering axes by the current authority; throttle stays live. */
export function shapeInput(input: FlightInput, s: SteerAuthority): FlightInput {
  return {
    turn: scaleAxis(input.turn, s.steer),
    pitch: scaleAxis(input.pitch, s.steer),
    roll: scaleAxis(input.roll, s.steer),
    throttle: input.throttle,
  };
}
