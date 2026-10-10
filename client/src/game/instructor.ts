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
import { tuning as live } from "./tuning";

/** Loop gain, rad/s of commanded rate per rad of error, on both axes. High
 * enough that a bandit crossing at ~15°/s is tracked within ~1.5° (rate/K),
 * inside the hit sphere at gun range; 6 lagged it by ~2.5° and mostly missed. */
const GAIN = 10;
/** Command lag × gain (the lag, s, is this / the gain). GAIN × LAG = 0.25 would be exactly critical damping on
 * the plant (yaw/pitch integrate the rate command) — the stability edge,
 * where any extra delay (the chase eye's own lag, a slow frame) tips it into
 * overshoot. F6 keeps a margin: GAIN × LAG = 1/6, ζ ≈ 1.22. Measured with the
 * camera in the loop, a 30° step settles as fast as at the edge, and the
 * pipper's run-on past an aim snapped mid-turn drops ~25% at 144 fps and
 * ~8% at 30 fps. (Sub-stepping the loop inside a frame was tried: it reads
 * the chase eye only once a frame, so at 30 fps it overshot MORE.) */
const GAIN_LAG = 1 / 6;
/** The loop's tuning (F9 feel presets, game/effortless.ts). `gain` is the
 * slope at the aim — what holds a crossing bandit — and the command lag
 * follows it so gain × lag stays 1/6, the same damping at every feel. A
 * feel may soften the loop beyond `band` rad of error to the `steer` slope:
 * a big re-aim (a turn) is flown gently, and a hand that reacts late can't
 * whip it into a wobble, while the fine aim stays as crisp as Sharp's. */
export interface InstructorTuning {
  gain: number;
  band?: number;
  steer?: number;
}
/** Today's crisp loop — the default, so every caller without a feel is
 * bit-identical to before F9. */
export const SHARP_TUNING: InstructorTuning = { gain: GAIN };

/** Commanded rate, rad/s, for `e` rad of aim error at `tuning`. */
export function instructorRate(e: number, tuning: InstructorTuning): number {
  const { gain, band, steer } = tuning;
  if (band === undefined || steer === undefined) return gain * e;
  const a = Math.abs(e);
  if (a <= band) return gain * e;
  return Math.sign(e) * (gain * band + steer * (a - band));
}

/** instructorRate's inverse: the aim error that commands `rate` rad/s —
 * how the F9 assist turns a stick nudge into an error bias. */
export function instructorErrorFor(
  rate: number,
  tuning: InstructorTuning,
): number {
  const { gain, band, steer } = tuning;
  if (band === undefined || steer === undefined) return rate / gain;
  const a = Math.abs(rate);
  if (a <= gain * band) return rate / gain;
  return Math.sign(rate) * (band + (a - gain * band) / steer);
}
const DEG_I = Math.PI / 180;
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
  const aimDir = cursorRay(
    frame.eye,
    frame.at,
    fovDeg,
    aspect,
    ndc.x,
    ndc.y,
    frame.up,
  );
  if (live.cameraRoll <= 0) levelAim(aimDir, frame);
  return {
    aimDir,
    pipperDir: {
      x: fwd.x * BULLET_RANGE - frame.eye.x,
      y: fwd.y * BULLET_RANGE - frame.eye.y,
      z: fwd.z * BULLET_RANGE - frame.eye.z,
    },
  };
}

/** F10 LEVEL camera: the steepest the cursor's aim may climb or dive, rad. */
export const LEVEL_AIM_MAX_ELEV = (80 * Math.PI) / 180;

/**
 * F10: with the horizon-locked camera (cameraRoll 0) the screen's up is
 * always the world's, so a cursor near the top of a steep view points past
 * the zenith — at the far side of the sky — and flying there would put the
 * nose over the top, swing the camera round and hunt back. In LEVEL the aim
 * ray (in place) is folded back onto the camera's own side of the zenith
 * and held within LEVEL_AIM_MAX_ELEV of the horizon: a mouse climb settles
 * at a steep, stable attitude instead (loops are flown with a pull on the
 * stick, A/D + pull, or the Follow-plane camera). Continuous everywhere.
 */
export function levelAim(aim: Vec3, frame: { eye: Vec3; at: Vec3 }): void {
  let hx = frame.at.x - frame.eye.x;
  let hz = frame.at.z - frame.eye.z;
  const hl = Math.hypot(hx, hz);
  if (hl < 1e-9) return;
  hx /= hl;
  hz /= hl;
  const along = aim.x * hx + aim.z * hz;
  if (along < 0) {
    aim.x -= 2 * along * hx;
    aim.z -= 2 * along * hz;
  }
  const h = Math.hypot(aim.x, aim.z);
  const elev = Math.atan2(aim.y, h);
  if (Math.abs(elev) <= LEVEL_AIM_MAX_ELEV) return;
  const e = Math.sign(elev) * LEVEL_AIM_MAX_ELEV;
  const ce = Math.cos(e);
  const kx = h > 1e-9 ? aim.x / h : hx;
  const kz = h > 1e-9 ? aim.z / h : hz;
  aim.x = kx * ce;
  aim.y = Math.sin(e);
  aim.z = kz * ce;
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
// |pitch| from which stepFlight's turn axis blends onto the body's up is
// the live tuning's pitchLimit (flight.ts rotateAttitude) — mirrored below to
// measure turn authority.

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
    (Math.abs(flight.pitch) - live.pitchLimit) /
      (Math.PI / 2 - live.pitchLimit),
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
 * `tuning` is the feel's loop gain (F9); the default is today's Sharp loop.
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
  tuning: InstructorTuning = SHARP_TUNING,
): InstructorState {
  const gain = tuning.gain;
  const lag = GAIN_LAG / gain;
  const keep = reframing ? 1 : Math.exp(-dt / LATCH_FADE);
  const offYaw = wrapAngle(s.offYaw + latch.yaw) * keep;
  const offPitch = (s.offPitch + latch.pitch) * keep;
  // turn +1 is a right-hand turn, which DEcreases yaw (flight.ts).
  const turnCmd = clamp(
    -instructorRate(wrapAngle(err.yaw - offYaw), tuning) / rates.turnRate,
    -1,
    1,
  );
  const pitchCmd = clamp(
    instructorRate(err.pitch - offPitch, tuning) / rates.pitchRate,
    -1,
    1,
  );
  const blend = 1 - Math.exp(-dt / lag);
  return {
    turn: s.turn + (turnCmd - s.turn) * blend,
    pitch: s.pitch + (pitchCmd - s.pitch) * blend,
    offYaw,
    offPitch,
  };
}

// --- F10 bank-and-pull ---------------------------------------------------------
//
// A target far off the nose is reached the way a fighter pilot does it: roll
// toward it, pull, roll out on arrival — not a flat yaw. The instructor
// banks up to the tuning's instructorBankMax so the target sits above the
// plane's own up (aimError then reads it as a pull, and the pull on a wing
// bites harder: flight.ts bankPitchMult). Engaged past instructorBankThreshold
// of aim error, released under BANK_EXIT (hysteresis: no hunting at the
// edge), its bank fading out on the way so the wings come level as the nose
// arrives; once released, roll-control.ts levels what is left (the bank was
// never the pilot's). The roll command goes through roll-control, so the
// pilot's own A/D always wins.

/** Bank-and-pull lets go under this much aim error, rad. */
export const BANK_EXIT = 15 * DEG_I;
/** Roll rate per rad of bank error, 1/s: a crisp but damped roll-in. */
const BANK_GAIN = 6;

export interface BankPullState {
  engaged: boolean;
}

export function createBankPull(): BankPullState {
  return { engaged: false };
}

/**
 * The instructor's roll command this frame (stick units, for roll-control's
 * `auto`), or null when it is not banking. `aimDir` / `pipperDir` are
 * aimView's rays; `standDown` is any assist that owns the line (threading a
 * hole, the F9 guard, the ground floor) — banking hard there would switch
 * the hole assist off and swing the pull at the ground.
 */
export function instructorBankPull(
  s: BankPullState,
  flight: Pick<FlightState, "yaw" | "pitch" | "roll" | "bank">,
  aimDir: Vec3,
  pipperDir: Vec3,
  standDown: boolean,
): number | null {
  const max = live.instructorBankMax;
  if (standDown || max <= 0) {
    s.engaged = false;
    return null;
  }
  const off = angleBetween(aimDir, pipperDir);
  const enter = Math.max(live.instructorBankThreshold, BANK_EXIT + 1e-3);
  if (off > enter) s.engaged = true;
  else if (off < BANK_EXIT) s.engaged = false;
  if (!s.engaged) return null;

  // The nose (the pipper ray) and the LEVEL frame around it: up = world-up
  // squared against the nose. Steep, that frame has no direction — hold.
  const pl = Math.hypot(pipperDir.x, pipperDir.y, pipperDir.z) || 1;
  const nx = pipperDir.x / pl;
  const ny = pipperDir.y / pl;
  const nz = pipperDir.z / pl;
  let ux = -ny * nx;
  let uy = 1 - ny * ny;
  let uz = -ny * nz;
  const ul = Math.hypot(ux, uy, uz);
  if (ul < 0.2) return 0;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // right = nose × up.
  const rx = ny * uz - nz * uy;
  const ry = nz * ux - nx * uz;
  const rz = nx * uy - ny * ux;
  // Where the target sits round the nose, from level-up toward right.
  const beta = Math.atan2(
    aimDir.x * rx + aimDir.y * ry + aimDir.z * rz,
    aimDir.x * ux + aimDir.y * uy + aimDir.z * uz,
  );
  // Bank so the plane's up points at it (+roll = left wing down, i.e. up
  // toward −right), at most `max`; a target behind-below (|β| → π) fades
  // back to no bank — that one is a push, not a split-S — so the command
  // is continuous all round.
  const a = Math.abs(beta);
  const bank =
    a <= max
      ? -beta
      : -Math.sign(beta) * max * Math.max(0, (Math.PI - a) / (Math.PI - max));
  // The bank fades out as the nose arrives: level by BANK_EXIT.
  const w = Math.min(1, Math.max(0, (off - BANK_EXIT) / (enter - BANK_EXIT)));
  const want = bank * w;
  const err = want - realRoll(flight);
  const e = Math.atan2(Math.sin(err), Math.cos(err));
  return Math.max(
    -1,
    Math.min(1, (e * BANK_GAIN) / Math.max(1e-6, live.rollRate)),
  );
}
