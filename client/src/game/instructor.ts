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
// pipper", never screen centre: the chase eye looks ~10° below the gun line.

import {
  BULLET_RANGE,
  PITCH_LIMIT,
  PITCH_RATE,
  TURN_RATE,
} from "@angels-bandits/common/constants";
import {
  type FlightState,
  flightAxes,
  flightForward,
  realRoll,
} from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";

/** Loop gain, rad/s of commanded rate per rad of error, on both axes. High
 * enough that a bandit crossing at ~15°/s is tracked within ~1.5° (rate/K),
 * inside the hit sphere at gun range; 6 lagged it by ~2.5° and mostly missed. */
const GAIN = 10;
/** Command lag, s. GAIN × LAG = 0.25 would be exactly critical damping on
 * the plant (yaw/pitch integrate the rate command) — the stability edge,
 * where any extra delay (the chase eye's own lag, a slow frame) tips it into
 * overshoot. F6 keeps a margin: GAIN × LAG = 1/6, ζ ≈ 1.22. Measured with the
 * camera in the loop, a 30° step settles as fast as at the edge, and the
 * pipper's run-on past an aim snapped mid-turn drops ~25% at 144 fps and
 * ~8% at 30 fps. (Sub-stepping the loop inside a frame was tried: it reads
 * the chase eye only once a frame, so at 30 fps it overshot MORE.) */
const LAG = 1 / (6 * GAIN);
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

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * The camera basis camera.lookAt builds from `eye`, `at` and the camera's
 * `up`: forward, right = forward × up, up' = right × forward — written into
 * `out`. A degenerate up (along the view) falls back to
 * world-up, then to +X. Shared by cursorRay and touch's aimDirNdc.
 */
export function viewBasis(eye: Vec3, at: Vec3, up: Vec3, out: ViewBasis): void {
  let fx = at.x - eye.x;
  let fy = at.y - eye.y;
  let fz = at.z - eye.z;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let rx = fy * up.z - fz * up.y;
  let ry = fz * up.x - fx * up.z;
  let rz = fx * up.y - fy * up.x;
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-9) {
    rx = -fz;
    ry = 0;
    rz = fx;
    rl = Math.hypot(rx, rz) || 1;
    if (Math.hypot(rx, rz) === 0) {
      rx = 1;
      rl = 1;
    }
  }
  rx /= rl;
  ry /= rl;
  rz /= rl;
  out.fx = fx;
  out.fy = fy;
  out.fz = fz;
  out.rx = rx;
  out.ry = ry;
  out.rz = rz;
  out.ux = ry * fz - rz * fy;
  out.uy = rz * fx - rx * fz;
  out.uz = rx * fy - ry * fx;
}

/** A camera basis: forward, right and up, unit. */
export interface ViewBasis {
  fx: number;
  fy: number;
  fz: number;
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
}

const basisScratch: ViewBasis = {
  fx: 0,
  fy: 0,
  fz: -1,
  rx: 1,
  ry: 0,
  rz: 0,
  ux: 0,
  uy: 1,
  uz: 0,
};

/**
 * World ray through the cursor for a view. `eye` and `at` are the camera
 * position and look-at target as offsets from the plane (any common origin
 * works — only their difference is used); `fovDeg` is the VERTICAL FOV; ndc is
 * −1..1 with +y up. `up` is the camera's up, exactly as camera.lookAt builds
 * it (F7: the plane's own up through aerobatics; world +Y by default).
 */
export function cursorRay(
  eye: Vec3,
  at: Vec3,
  fovDeg: number,
  aspect: number,
  ndcX: number,
  ndcY: number,
  up: Vec3 = WORLD_UP,
): Vec3 {
  const b = basisScratch;
  viewBasis(eye, at, up, b);
  const t = Math.tan((fovDeg * Math.PI) / 360);
  const sx = ndcX * t * aspect;
  const sy = ndcY * t;
  const x = b.fx + b.rx * sx + b.ux * sy;
  const y = b.fy + b.ry * sx + b.uy * sy;
  const z = b.fz + b.rz * sx + b.uz * sy;
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
 * neutral on screen — the parallax of the 26–36 m chase eye offset (C1's
 * D(v)) included.
 */
export function aimView(
  flight: Pick<FlightState, "yaw" | "pitch">,
  frame: { eye: Vec3; at: Vec3; up?: Vec3 },
  fovDeg: number,
  aspect: number,
  ndc: { x: number; y: number },
): AimView {
  const fwd = flightForward(flight);
  return {
    aimDir: cursorRay(
      frame.eye,
      frame.at,
      fovDeg,
      aspect,
      ndc.x,
      ndc.y,
      frame.up,
    ),
    pipperDir: {
      x: fwd.x * BULLET_RANGE - frame.eye.x,
      y: fwd.y * BULLET_RANGE - frame.eye.y,
      z: fwd.z * BULLET_RANGE - frame.eye.z,
    },
  };
}

/** Turn authority (how far the turn moves the pipper, per unit of the full
 * turn rate — cos of the pipper's elevation in upright flight) is full down
 * to this… (F7: cos 55°) */
const COS_FADE_START = Math.cos((55 * Math.PI) / 180);
/** …and gone from this one on, where the turn only spins the view. */
const COS_FADE_END = Math.cos((80 * Math.PI) / 180);
/** Nose-ease gain: rad of pitch toward the horizon per rad of side error
 * the fade took away. 1 left a dead zone at the limit — (0.15, 0.35) hung
 * at 83° with no turn; 3 made a cursor 0.1 off-centre pirouette at 74°. */
const EASE = 2;
/** Vertical error, rad, under which that ease turns from following the
 * cursor's side of the pipper to seeking the horizon (F7). */
const EASE_VERT = 0.3;
/** |pitch| from which stepFlight's turn axis blends onto the body's up
 * (flight.ts TURN_AXIS_BLEND) — mirrored here to measure turn authority. */
const TURN_AXIS_BLEND = PITCH_LIMIT;

const axes = { right: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 0 } };

/**
 * How far to turn and pitch the plane so the pipper ray (`pipperDir`, from the
 * eye to the gun line's far point) lands on `aimDir`.
 *
 * F7 aerobatics: measured in the PLANE's own frame — right = the airframe's
 * right axis (its real attitude, the cosmetic lean left out) squared up
 * against the pipper, up = right × pipper — so "above the pipper" means
 * toward the plane's own up at any attitude: a cursor held there pulls the
 * nose up, over the top and round, and inverted it is still the way the
 * pilot sees it. Pitch input rotates the nose exactly along that up; there
 * is no pitch limit, so the vertical error is used as it is.
 *
 * The turn moves the pipper by `k` per unit of the full turn rate — k is
 * measured from stepFlight's own turn axis (world-up upright, world-down
 * inverted, the body's up toward knife-edge and vertical), and is cos of the
 * pipper's elevation in upright flight, exactly the old heading-difference
 * scaling. Where k is small the turn only spins the view, so turn authority
 * fades out between k = cos 55° and cos 80°, and the share of side error the
 * fade takes away eases the nose toward the horizon by the shorter way
 * instead (both ways reach it now). Below 55° in upright flight the yaw error
 * equals the old heading difference for a level step. The error is
 * continuous everywhere, so the zoom/free-look latch (a difference of two
 * calls) can't jump either.
 */
export function aimError(
  flight: Pick<FlightState, "yaw" | "pitch" | "roll" | "bank">,
  aimDir: Vec3,
  pipperDir: Vec3,
): AimError {
  const pl = Math.hypot(pipperDir.x, pipperDir.y, pipperDir.z) || 1;
  const px = pipperDir.x / pl;
  const py = pipperDir.y / pl;
  const pz = pipperDir.z / pl;
  const { right: R, up: U } = flightAxes(flight, axes);
  // right ⟂ pipper (the eye parallax makes them a hair off square).
  const rp = R.x * px + R.y * py + R.z * pz;
  let rx = R.x - rp * px;
  let ry = R.y - rp * py;
  let rz = R.z - rp * pz;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  const ux = ry * pz - rz * py;
  const uy = rz * px - rx * pz;
  const uz = rx * py - ry * px;
  const along = aimDir.x * px + aimDir.y * py + aimDir.z * pz;
  const half = Math.PI / 2;
  const side = clamp(
    Math.atan2(aimDir.x * rx + aimDir.y * ry + aimDir.z * rz, along),
    -half,
    half,
  );
  const vert = Math.atan2(aimDir.x * ux + aimDir.y * uy + aimDir.z * uz, along);
  // stepFlight's turn axis A (normalised); a turn of −1 rad about it moves
  // the pipper by p × A, whose share along right is the authority k.
  const roll = realRoll(flight);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const g = clamp(
    (Math.abs(flight.pitch) - TURN_AXIS_BLEND) /
      (Math.PI / 2 - TURN_AXIS_BLEND),
    0,
    1,
  );
  const kw = cr * Math.abs(cr) * (1 - g);
  const ku = sr * sr * (1 - g) + g;
  const ax = ku * U.x;
  const ay = kw + ku * U.y;
  const az = ku * U.z;
  const al = Math.hypot(ax, ay, az) || 1;
  const k = Math.max(
    1e-9,
    ((py * az - pz * ay) * rx +
      (pz * ax - px * az) * ry +
      (px * ay - py * ax) * rz) /
      al,
  );
  const fade = clamp(
    (k - COS_FADE_END) / (COS_FADE_START - COS_FADE_END),
    0,
    1,
  );
  // turn +1 is right and DEcreases yaw, so a cursor to the right is −yaw.
  const yaw = (-side / k) * fade;
  // Where turn authority fades, the side error the fade took away pitches
  // the nose instead: on toward the cursor's own side of the pipper (over
  // the top, if that is where it is — a turn works again past vertical), and
  // only with the cursor level with the pipper toward the horizon by the
  // shorter way (pitch moves the nose along up, so it lowers the elevation
  // iff up.y and the nose's elevation share a sign). Blended over EASE_VERT,
  // so it is continuous.
  const toCursor = clamp(vert / EASE_VERT, -1, 1);
  const toHorizon = -(py * uy >= 0 ? 1 : -1) * Math.sign(py);
  const ease =
    (toCursor + (1 - Math.abs(toCursor)) * toHorizon) *
    EASE *
    (1 - fade) *
    Math.abs(side);
  return { yaw, pitch: vert + ease };
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
 * latched, so a zoom pressed mid-turn keeps the turn. `rates` are the
 * full-deflection rates stepFlight will apply this frame (handlingRates —
 * boost raises them), so the loop gain, and the damping, never change.
 */
export function instructorInput(
  err: AimError,
  latch: AimError,
  reframing: boolean,
  dt: number,
  s: InstructorState,
  rates: { turnRate: number; pitchRate: number } = {
    turnRate: TURN_RATE,
    pitchRate: PITCH_RATE,
  },
): InstructorState {
  const keep = reframing ? 1 : Math.exp(-dt / LATCH_FADE);
  const offYaw = wrapAngle(s.offYaw + latch.yaw) * keep;
  const offPitch = (s.offPitch + latch.pitch) * keep;
  // turn +1 is a right-hand turn, which DEcreases yaw (flight.ts).
  const turnCmd = clamp(
    (-GAIN * wrapAngle(err.yaw - offYaw)) / rates.turnRate,
    -1,
    1,
  );
  const pitchCmd = clamp(
    (GAIN * (err.pitch - offPitch)) / rates.pitchRate,
    -1,
    1,
  );
  const blend = 1 - Math.exp(-dt / LAG);
  return {
    turn: s.turn + (turnCmd - s.turn) * blend,
    pitch: s.pitch + (pitchCmd - s.pitch) * blend,
    offYaw,
    offPitch,
  };
}
