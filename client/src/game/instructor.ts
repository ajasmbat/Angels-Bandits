// Mouse-aim instructor (F1) — the pure seam. The cursor is the aim point: each
// frame the instructor reads the ray through the cursor and the ray to the
// pipper (both seen from the chase eye) and flies the pipper onto the cursor
// with stepFlight's own rate inputs. Same shape as freelook.ts and zoom.ts: a
// per-frame step over immutable state, renderer-free, thin adapters in
// flight-input/camera/main. CLIENT-ONLY — the output is an ordinary
// FlightInput, so nothing here touches the wire, common/ or the server.
//
// What "the cursor is the aim point" can mean without pointer lock: the chase
// camera follows the plane, so a cursor HELD off the pipper keeps re-aiming as
// the view swings and reads as a smooth turn whose rate grows with the offset.
// A cursor KEPT on something in the world — a bandit, a gap between towers —
// converges the pipper onto it, critically damped. Neutral is "cursor on the
// pipper", never screen centre: the chase eye looks ~9° below the gun line.

import {
  BULLET_RANGE,
  PITCH_LIMIT,
  PITCH_RATE,
  TURN_RATE,
} from "@angels-bandits/common/constants";
import { type FlightState, flightForward } from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";

/** Loop gain, rad/s of commanded rate per rad of error, on both axes. */
const GAIN = 6;
/** Command lag, s. GAIN × LAG = 0.25 is critical damping on the plant
 * (yaw/pitch integrate the rate command), so the pipper never overshoots. */
const LAG = 1 / (4 * GAIN);
/** Exp fade of a latched reframe offset, s (~0.6 s to 5%). */
const LATCH_FADE = 0.2;
/** Pipper-to-cursor angle under which the reticle reads as converged. */
export const CONVERGED_RAD = (1.5 * Math.PI) / 180;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** Wrap an angle to (−π, π]. */
const wrapAngle = (a: number): number => {
  const w = Math.atan2(Math.sin(a), Math.cos(a));
  return w === -Math.PI ? Math.PI : w;
};

export interface InstructorState {
  /** Lagged commands, already in stepFlight's [-1, 1] input units. */
  turn: number;
  pitch: number;
  /** Latched view-change error, rad, fading back to zero. */
  offYaw: number;
  offPitch: number;
}

/** Fresh, neutral instructor (spawn / death / mode toggle). */
export function createInstructor(): InstructorState {
  return { turn: 0, pitch: 0, offYaw: 0, offPitch: 0 };
}

/** Heading/elevation error, rad, that would bring the pipper onto the aim. */
export interface AimError {
  yaw: number;
  pitch: number;
}

/**
 * World ray through the cursor for a view. `eye` and `at` are the camera
 * position and look-at target as offsets from the plane (any common origin
 * works — only their difference is used); `fovDeg` is the VERTICAL FOV; ndc is
 * −1..1 with +y up. Up is world +Y, exactly as camera.lookAt builds it.
 */
export function cursorRay(
  eye: Vec3,
  at: Vec3,
  fovDeg: number,
  aspect: number,
  ndcX: number,
  ndcY: number,
): Vec3 {
  let fx = at.x - eye.x;
  let fy = at.y - eye.y;
  let fz = at.z - eye.z;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = forward × worldUp, then up = right × forward.
  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const sx = ndcX * t * aspect;
  const sy = ndcY * t;
  const x = fx + rx * sx + ux * sy;
  const y = fy + uy * sy;
  const z = fz + rz * sx + uz * sy;
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
}

/** The two rays the instructor compares, both from the chase eye. */
export interface AimView {
  /** Through the cursor. */
  aimDir: Vec3;
  /** To the gun line's far point — where the pipper is drawn. */
  pipperDir: Vec3;
}

/**
 * Both rays for one view: `frame` is ChaseCamera.aimFrame (eye/look-at as
 * offsets from the plane), `ndc` the smoothed cursor (+y up). The pipper ray
 * starts at the eye, not the plane, so "cursor on the pipper" is exactly
 * neutral on screen — the parallax of a 22 m eye offset included.
 */
export function aimView(
  flight: Pick<FlightState, "yaw" | "pitch">,
  frame: { eye: Vec3; at: Vec3 },
  fovDeg: number,
  aspect: number,
  ndc: { x: number; y: number },
): AimView {
  const fwd = flightForward(flight);
  return {
    aimDir: cursorRay(frame.eye, frame.at, fovDeg, aspect, ndc.x, ndc.y),
    pipperDir: {
      x: fwd.x * BULLET_RANGE - frame.eye.x,
      y: fwd.y * BULLET_RANGE - frame.eye.y,
      z: fwd.z * BULLET_RANGE - frame.eye.z,
    },
  };
}

const yawOf = (d: Vec3): number => Math.atan2(-d.x, -d.z);
const elevOf = (d: Vec3): number => Math.atan2(d.y, Math.hypot(d.x, d.z));

/**
 * How far to turn and pitch the plane so the pipper ray (`pipperDir`, from the
 * eye to the gun line's far point) lands on `aimDir`. The target nose
 * elevation is clamped to ±PITCH_LIMIT, so a cursor near the zenith never
 * asks for a pitch the model refuses.
 */
export function aimError(
  flight: Pick<FlightState, "pitch">,
  aimDir: Vec3,
  pipperDir: Vec3,
): AimError {
  const yaw = wrapAngle(yawOf(aimDir) - yawOf(pipperDir));
  const want = clamp(
    flight.pitch + elevOf(aimDir) - elevOf(pipperDir),
    -PITCH_LIMIT,
    PITCH_LIMIT,
  );
  return { yaw, pitch: want - flight.pitch };
}

/** Angle between two directions, rad — the pipper-to-cursor gap on screen. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  if (la === 0 || lb === 0) return 0;
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return Math.acos(clamp(cos, -1, 1));
}

/**
 * Advance one frame. `err` is this frame's raw aim error; `latch` is the part
 * of it that only the VIEW changed this frame (the zoom easing, a free-look
 * drag) — main measures it by recomputing the error with last frame's view.
 * It is added to an offset the controller ignores, so reframing never kicks
 * the nose; while `reframing` holds the offset stays put, after that it fades
 * and the cursor takes back over smoothly. The plane's own motion is never
 * latched, so a zoom pressed mid-turn keeps the turn.
 */
export function instructorInput(
  err: AimError,
  latch: AimError,
  reframing: boolean,
  dt: number,
  s: InstructorState,
): InstructorState {
  const keep = reframing ? 1 : Math.exp(-dt / LATCH_FADE);
  const offYaw = wrapAngle(s.offYaw + latch.yaw) * keep;
  const offPitch = (s.offPitch + latch.pitch) * keep;
  // turn +1 is a right-hand turn, which DEcreases yaw (flight.ts).
  const turnCmd = clamp(
    (-GAIN * wrapAngle(err.yaw - offYaw)) / TURN_RATE,
    -1,
    1,
  );
  const pitchCmd = clamp((GAIN * (err.pitch - offPitch)) / PITCH_RATE, -1, 1);
  const blend = 1 - Math.exp(-dt / LAG);
  return {
    turn: s.turn + (turnCmd - s.turn) * blend,
    pitch: s.pitch + (pitchCmd - s.pitch) * blend,
    offYaw,
    offPitch,
  };
}
