// Arcade-plus flight model — a pure, renderer-free step function shared by
// client (local simulation) and server (T3 validation reuses its constants).
// No Three.js, no DOM, no Math.random: stepFlight(state, input, dt) → state.
//
// Conventions (match Three.js so the client can feed angles straight into an
// Euler of order "YXZ"): yaw 0 faces -Z, positive pitch is nose-up, positive
// roll is left-wing-down. `turn` input +1 is a right-hand turn (yaw decreases).
//
// F7 aerobatics: the attitude is integrated as a quaternion every step —
// pitch about the plane's OWN right axis, A/D a real roll about its own nose,
// the turn about world-up (reversed when inverted) — and stored back as the
// YXZ Euler above, pitch in [−π/2, π/2]. Euler YXZ covers every attitude, so
// a loop is simply pitch running up to vertical and back down with yaw and
// roll both flipped by π (the gimbal flip), and every reader of yaw/pitch
// (flightForward, the pose quat, plane.rotation) stays valid unchanged. The
// quaternion is rebuilt each step rather than stored, so no new field has to
// survive every spread of a FlightState, and level flight with the wings
// level takes an exact Euler fast path — bit-identical to the old model.

import {
  BANK_ANGLE,
  BANK_FREQ,
  BOOST_MAX_SPEED,
  BOOST_PITCH_MULT,
  BOOST_RESPONSE,
  BOOST_TURN_MULT,
  CEILING_FADE,
  CLIMB_FREE_ANGLE,
  CORNER_BRAKE_DECEL,
  DIVE_FADE_BAND,
  ENERGY_GAIN,
  MAX_SPEED,
  MAX_VISUAL_BANK,
  MIN_SPEED,
  MUSH_SINK,
  PITCH_LIMIT,
  PITCH_RATE,
  RESPAWN_SPEED,
  ROLL_LEVEL_RATE,
  ROLL_RATE,
  SOFT_CEILING,
  SPEED_RESPONSE,
  THROTTLE_RATE,
  TURN_BLEED,
  TURN_RATE,
  TURN_RATE_SLOW,
} from "../../src/constants";
import { type Vec3, canonicalize } from "../../src/world/index";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export interface FlightState {
  /** Canonical position: x/z always in [0, WORLD_SIZE). */
  pos: Vec3;
  /** Heading, radians. 0 faces -Z; decreases in a right-hand turn. */
  yaw: number;
  /** Radians, positive = nose up. In [−π/2, π/2]: past vertical the attitude
   * reads as yaw + π, roll + π (F7). */
  pitch: number;
  /** Radians, the drawn roll in (−π, π]: the airframe's REAL roll (A/D, and
   * π when inverted — F7) plus the cosmetic turn lean `bank`. */
  roll: number;
  /** The cosmetic turn lean, rad — the bank spring's position (F6). It steers
   * nothing. Optional: absent means ALL of `roll` is cosmetic (real roll 0),
   * the shape of bots' spawn literals and older states; stepFlight always
   * returns it. */
  bank?: number;
  /** Roll rate, rad/s — the bank spring's velocity (F6). Optional: a state
   * built without it (bots' spawn literals, tests) starts the spring at
   * rest; stepFlight always returns it. */
  rollRate?: number;
  /** Current airspeed, m/s. In [MIN_SPEED, MAX_SPEED], or up to
   * BOOST_MAX_SPEED while boosting and through the post-boost tail. */
  speed: number;
  /** Throttle-commanded speed, m/s, set by W/S. In [MIN_SPEED, MAX_SPEED].
   * Spawns at MAX_SPEED (full throttle, F5). */
  targetSpeed: number;
}

/** All axes in [-1, 1]. pitch + = pull up; turn + = turn right; throttle + = W. */
export interface FlightInput {
  pitch: number;
  turn: number;
  roll: number;
  throttle: number;
  /** SPACE boost (F2) is burning. Optional: bots never boost and simply
   * leave it out — absent is bit-identical to the pre-boost model. */
  boost?: boolean;
  /** F5 corner speed manager's ceiling on the commanded speed, m/s. The
   * throttle command stays the pilot's (`targetSpeed`); the plane flies
   * min(targetSpeed, cornerCap), and above the cap the CORNER_BRAKE_DECEL
   * airbrake bleeds it. Boost ignores it — a burn is the pilot overriding.
   * Optional: bots and remotes leave it out, bit-identical to before. */
  cornerCap?: number;
  /** Clamp pitch to ±this, rad — the pre-F7 envelope. Bots fly with
   * PITCH_LIMIT (they never loop); absent = full aerobatics. */
  pitchLimit?: number;
}

/** Fresh level flight state at `pos` (canonicalized): spawn / respawn shape.
 * Airspeed is RESPAWN_SPEED; the throttle is FULL (F5), so the plane spools
 * up out of every spawn and respawn. */
export function createFlightState(pos: Vec3, yaw = 0): FlightState {
  return {
    pos: canonicalize(pos),
    yaw,
    pitch: 0,
    roll: 0,
    bank: 0,
    rollRate: 0,
    speed: RESPAWN_SPEED,
    targetSpeed: MAX_SPEED,
  };
}

/** Unit vector along the nose for a yaw/pitch attitude (yaw 0, pitch 0 → -Z). */
export function flightForward(state: Pick<FlightState, "yaw" | "pitch">): Vec3 {
  const cosP = Math.cos(state.pitch);
  return {
    x: -Math.sin(state.yaw) * cosP,
    y: Math.sin(state.pitch),
    z: -Math.cos(state.yaw) * cosP,
  };
}

/**
 * Base full-deflection yaw rate at `speed`, rad/s (F5): TURN_RATE_SLOW at
 * MIN_SPEED easing linearly to TURN_RATE at MAX_SPEED, flat outside that.
 */
export function turnRateAt(speed: number): number {
  const u = clamp((speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED), 0, 1);
  return TURN_RATE_SLOW + (TURN_RATE - TURN_RATE_SLOW) * u;
}

/** Full-deflection (un-boosted) turn radius at `speed`, meters. */
export function turnRadius(speed: number): number {
  return speed / turnRateAt(speed);
}

/** Full-deflection (un-boosted) pull-up radius at `speed`, meters (F8). */
export function pitchRadius(speed: number): number {
  return speed / PITCH_RATE;
}

/**
 * The fastest speed in [MIN_SPEED, MAX_SPEED] whose full-deflection turn
 * radius is at most `radius` — turnRadius's inverse, closed form because the
 * rate is linear in speed: v = a·R / (1 + b·R) for rate(v) = a − b·v.
 */
export function speedForRadius(radius: number): number {
  const b = (TURN_RATE_SLOW - TURN_RATE) / (MAX_SPEED - MIN_SPEED);
  const a = TURN_RATE_SLOW + b * MIN_SPEED;
  const r = Math.max(0, radius);
  return clamp((a * r) / (1 + b * r), MIN_SPEED, MAX_SPEED);
}

/**
 * Full-deflection turn and pitch rates, rad/s, at `speed`. The base turn
 * rate is speed-dependent (turnRateAt: tighter when slow, F5). Boost sharpens
 * handling: the full multipliers while burning, and after release they ride
 * the speed back down, so the post-boost tail never turns wider than the burn
 * did (86.8 m at 125 m/s). Exactly turnRateAt/PITCH_RATE at ≤ MAX_SPEED.
 * Exported so the client's mouse-aim instructor normalises by the rates
 * stepFlight will actually apply.
 */
export function handlingRates(
  speed: number,
  boost: boolean,
): { turnRate: number; pitchRate: number } {
  const excess = boost
    ? 1
    : clamp((speed - MAX_SPEED) / (BOOST_MAX_SPEED - MAX_SPEED), 0, 1);
  return {
    turnRate: turnRateAt(speed) * (1 + (BOOST_TURN_MULT - 1) * excess),
    pitchRate: PITCH_RATE * (1 + (BOOST_PITCH_MULT - 1) * excess),
  };
}

/** Advance the flight model one tick. Pure: never mutates `state` or `input`. */
export function stepFlight(
  state: FlightState,
  input: FlightInput,
  dt: number,
): FlightState {
  const turnIn = clamp(input.turn, -1, 1);
  const pitchIn = clamp(input.pitch, -1, 1);
  const rollIn = clamp(input.roll, -1, 1);
  const boost = input.boost === true;

  const { turnRate, pitchRate } = handlingRates(state.speed, boost);

  // Mouse-aim steering: inputs are rate commands at capped rates; neutral
  // input holds the current attitude (no auto-level of pitch or yaw).
  const bank0 = state.bank ?? state.roll;
  const real0 = wrapAngle(state.roll - bank0);
  const dYaw = -turnIn * turnRate * dt;
  const dPitch = pitchIn * pitchRate * dt;
  const limit = input.pitchLimit;
  let yaw: number;
  let pitch: number;
  let real: number;
  if (limit !== undefined) {
    // The pre-F7 model, exactly (bots): world-yaw turn, clamped pitch. Bots
    // never roll, so their real roll stays 0.
    yaw = state.yaw + dYaw;
    pitch = clamp(state.pitch + dPitch, -limit, limit);
    real = real0;
  } else if (
    real0 === 0 &&
    rollIn === 0 &&
    Math.abs(state.pitch + dPitch) <= PITCH_LIMIT
  ) {
    // Wings level, upright, well clear of vertical: the quaternion step below
    // reduces to exactly this Euler update — taken directly, cheap and exact.
    yaw = state.yaw + dYaw;
    pitch = state.pitch + dPitch;
    real = 0;
  } else {
    rotateAttitude(state.yaw, state.pitch, real0, dYaw, dPitch, rollIn, dt);
    yaw = att.yaw;
    pitch = att.pitch;
    real = att.roll;
  }

  // Cosmetic lean: banks into the turn on its own; releasing the stick eases
  // it out (it steers nothing). F6: a critically damped spring (natural
  // frequency BANK_FREQ) toward the target, stepped in closed form — exact
  // for any dt while the target holds — so it leans in from rest and rolls
  // out with no overshoot at every frame rate. x is the lean minus its
  // target, v its rate. Capped at ±MAX_VISUAL_BANK. F7: A/D no longer feed
  // it — they roll the airframe for real (rotateAttitude).
  const bankTarget = clamp(
    -turnIn * BANK_ANGLE,
    -MAX_VISUAL_BANK,
    MAX_VISUAL_BANK,
  );
  const rx = bank0 - bankTarget;
  const rv = state.rollRate ?? 0;
  const rDecay = Math.exp(-BANK_FREQ * dt);
  const rc = rv + BANK_FREQ * rx;
  const bank = bankTarget + (rx + rc * dt) * rDecay;
  const rollRate = (rv - BANK_FREQ * rc * dt) * rDecay;
  const roll = real === 0 ? bank : wrapAngle(real + bank);

  // W/S move the commanded speed within [MIN_SPEED, MAX_SPEED].
  const targetSpeed = clamp(
    state.targetSpeed + clamp(input.throttle, -1, 1) * THROTTLE_RATE * dt,
    MIN_SPEED,
    MAX_SPEED,
  );

  // Soft ceiling: engine power fades to nothing across the CEILING_FADE band
  // above SOFT_CEILING. power=1 below the ceiling, 0 at the top of the band.
  const power = clamp(1 - (state.pos.y - SOFT_CEILING) / CEILING_FADE, 0, 1);

  // Energy rule: airspeed is pulled toward the commanded speed (throttle only
  // reaches MIN_SPEED in thin air), diving adds energy (climbing bleeds it —
  // same term, sign of sin(pitch)), and hard maneuvering bleeds it further.
  // Clamped: at MIN_SPEED you mush, never stall. Boost commands
  // BOOST_MAX_SPEED with a harder pull, through the same ceiling fade — a
  // burn is never a way to climb out past the soft ceiling.
  // F5: the corner manager caps the commanded speed, never the throttle.
  const cap = boost || input.cornerCap === undefined ? null : input.cornerCap;
  const commanded = boost
    ? BOOST_MAX_SPEED
    : cap === null
      ? targetSpeed
      : Math.min(targetSpeed, Math.max(MIN_SPEED, cap));
  const effectiveTarget = MIN_SPEED + (commanded - MIN_SPEED) * power;
  const maneuver = Math.min(1, Math.abs(turnIn) + Math.abs(pitchIn));
  // Above MAX_SPEED without boost (the post-boost tail) speed may only fall:
  // a dive can't hold boost speed. The wall-clock tail envelope itself is
  // boostSpeedCap in boost.ts, which the client clamps to every frame.
  const topSpeed = boost
    ? BOOST_MAX_SPEED
    : Math.max(MAX_SPEED, Math.min(state.speed, BOOST_MAX_SPEED));
  const dSpeed =
    (boost ? BOOST_RESPONSE : SPEED_RESPONSE) *
      (effectiveTarget - state.speed) -
    energyRate(pitch, state.speed, topSpeed) -
    TURN_BLEED * maneuver;
  let speed = clamp(state.speed + dSpeed * dt, MIN_SPEED, topSpeed);
  // F5 airbrake: above the corner cap airspeed falls at least
  // CORNER_BRAKE_DECEL (a constant deceleration, so stopping distances are
  // closed-form), but the brake itself never takes it below the cap.
  if (cap !== null && speed > cap) {
    speed = Math.max(
      Math.max(MIN_SPEED, cap),
      Math.min(speed, state.speed - CORNER_BRAKE_DECEL * dt),
    );
  }

  // Always moving forward along the nose — but above the ceiling, climb fades
  // with power and a sink sets in: the plane mushes back down, no wall.
  const fwd = flightForward({ yaw, pitch });
  let climb = fwd.y * speed;
  if (climb > 0) climb *= power;
  climb -= (1 - power) * MUSH_SINK;
  const pos = canonicalize({
    x: state.pos.x + fwd.x * speed * dt,
    y: state.pos.y + climb * dt,
    z: state.pos.z + fwd.z * speed * dt,
  });

  return { pos, yaw, pitch, roll, bank, rollRate, speed, targetSpeed };
}

/** Wrap an angle to (−π, π]. */
function wrapAngle(a: number): number {
  if (a > -Math.PI && a <= Math.PI) return a;
  const w = Math.atan2(Math.sin(a), Math.cos(a));
  return w === -Math.PI ? Math.PI : w;
}

/** The airframe's REAL roll, rad in (−π, π]: the drawn roll minus the
 * cosmetic lean. 0 = wings level upright, ±π = inverted (F7). */
export function realRoll(state: Pick<FlightState, "roll" | "bank">): number {
  return wrapAngle(state.roll - (state.bank ?? state.roll));
}

/**
 * The airframe's right and up axes (unit, world frame) for its REAL attitude
 * — the cosmetic lean left out: the frame pitch input rotates about (right)
 * and toward (up), and the one the chase camera and the instructor read.
 * Writes into `out` (no allocation).
 */
export function flightAxes(
  state: Pick<FlightState, "yaw" | "pitch" | "roll" | "bank">,
  out: { right: Vec3; up: Vec3 },
): { right: Vec3; up: Vec3 } {
  const r = realRoll(state);
  const sy = Math.sin(state.yaw);
  const cy = Math.cos(state.yaw);
  const sp = Math.sin(state.pitch);
  const cp = Math.cos(state.pitch);
  const sr = Math.sin(r);
  const cr = Math.cos(r);
  // Columns of Ry(yaw)·Rx(pitch)·Rz(roll): body +X and +Y.
  out.right.x = cr * cy + sr * sp * sy;
  out.right.y = sr * cp;
  out.right.z = -cr * sy + sr * sp * cy;
  out.up.x = -sr * cy + cr * sp * sy;
  out.up.y = cr * cp;
  out.up.z = sr * sy + cr * sp * cy;
  return out;
}

/** Where rotateAttitude leaves its result (module scratch: no allocation). */
const att = { yaw: 0, pitch: 0, roll: 0 };

/** |pitch| from which the turn axis blends from world-up to the body's own
 * up, reaching it at vertical, rad. At vertical a world-up turn only spins
 * the plane about its nose — and the Euler flip there reverses which way —
 * while the body up is continuous through the flip. */
const TURN_AXIS_BLEND = PITCH_LIMIT;

/**
 * One attitude step as a quaternion (F7), into `att`. q = Ry(yaw)·Rx(pitch)·
 * Rz(roll); then
 * - the turn rotates about a WORLD axis: world-up when upright (the old
 *   flat turn), world-down when inverted (so the nose still goes to the
 *   pilot's right), the body's own up toward knife-edge (weights cos²/sin²
 *   of the roll) and toward vertical (TURN_AXIS_BLEND);
 * - pitch rotates about the body's right axis, A/D about its nose;
 * and, decomposed back to YXZ, a released roll eases to the nearest of
 * upright or inverted at ROLL_LEVEL_RATE, scaled by cos(pitch) (at vertical
 * "level" is undefined). `prevYaw` keeps yaw continuous (unwrapped) except
 * for the π of a gimbal flip.
 */
function rotateAttitude(
  prevYaw: number,
  pitch: number,
  roll: number,
  dYaw: number,
  dPitch: number,
  rollIn: number,
  dt: number,
): void {
  const hy = prevYaw / 2;
  const hp = pitch / 2;
  const hr = roll / 2;
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  const cp = Math.cos(hp);
  const sp = Math.sin(hp);
  const cr = Math.cos(hr);
  const sr = Math.sin(hr);
  // Ry·Rx·Rz (Three.js "YXZ").
  let x = sy * cp * sr + cy * sp * cr;
  let y = sy * cp * cr - cy * sp * sr;
  let z = cy * cp * sr - sy * sp * cr;
  let w = cy * cp * cr + sy * sp * sr;

  // Turn axis: world-up · cos|cos| + body-up · sin² of the roll, blended to
  // body-up near vertical. Never zero: both terms lean onto body-up.
  if (dYaw !== 0) {
    const cRoll = Math.cos(roll);
    const sRoll = Math.sin(roll);
    const sYaw = Math.sin(prevYaw);
    const cYaw = Math.cos(prevYaw);
    const sPit = Math.sin(pitch);
    const cPit = Math.cos(pitch);
    const ux = -sRoll * cYaw + cRoll * sPit * sYaw;
    const uy = cRoll * cPit;
    const uz = sRoll * sYaw + cRoll * sPit * cYaw;
    const g = clamp(
      (Math.abs(pitch) - TURN_AXIS_BLEND) / (Math.PI / 2 - TURN_AXIS_BLEND),
      0,
      1,
    );
    const kw = cRoll * Math.abs(cRoll) * (1 - g);
    const ku = sRoll * sRoll * (1 - g) + g;
    let ax = ku * ux;
    let ay = kw + ku * uy;
    let az = ku * uz;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    const s = Math.sin(dYaw / 2);
    const c = Math.cos(dYaw / 2);
    // q = (axis, dYaw) ⊗ q — a world-frame rotation.
    const qx = ax * s;
    const qy = ay * s;
    const qz = az * s;
    const nx = c * x + qx * w + qy * z - qz * y;
    const ny = c * y - qx * z + qy * w + qz * x;
    const nz = c * z + qx * y - qy * x + qz * w;
    const nw = c * w - qx * x - qy * y - qz * z;
    x = nx;
    y = ny;
    z = nz;
    w = nw;
  }
  // q = q ⊗ Rx(dPitch) — about the body's right axis.
  if (dPitch !== 0) {
    const s = Math.sin(dPitch / 2);
    const c = Math.cos(dPitch / 2);
    const nx = x * c + w * s;
    const ny = y * c + z * s;
    const nz = z * c - y * s;
    const nw = w * c - x * s;
    x = nx;
    y = ny;
    z = nz;
    w = nw;
  }
  // q = q ⊗ Rz(dRoll) — about the body's nose. Works at any pitch.
  const dRoll = rollIn * ROLL_RATE * dt;
  if (dRoll !== 0) {
    const s = Math.sin(dRoll / 2);
    const c = Math.cos(dRoll / 2);
    const nx = x * c + y * s;
    const ny = y * c - x * s;
    const nz = z * c + w * s;
    const nw = w * c - z * s;
    x = nx;
    y = ny;
    z = nz;
    w = nw;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n;
  y /= n;
  z /= n;
  w /= n;

  // Back to YXZ (Three.js Euler.setFromRotationMatrix, same branches).
  const m23 = 2 * (y * z - w * x);
  let outYaw: number;
  let outRoll: number;
  const outPitch = Math.asin(-clamp(m23, -1, 1));
  if (Math.abs(m23) < 0.9999999) {
    outYaw = Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
    outRoll = Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z));
  } else {
    outYaw = Math.atan2(-2 * (x * z - w * y), 1 - 2 * (y * y + z * z));
    outRoll = 0;
  }

  // Self-levelling of a released roll toward the nearest of 0 or ±π.
  const hold = 1 - Math.min(1, Math.abs(rollIn));
  if (hold > 0) {
    const target =
      Math.abs(outRoll) <= Math.PI / 2 ? 0 : outRoll > 0 ? Math.PI : -Math.PI;
    const err = target - outRoll;
    const k = (1 - Math.exp(-ROLL_LEVEL_RATE * dt)) * hold * Math.cos(outPitch);
    outRoll += err * k;
    // Snap the last hair so the exact fast path takes over again.
    if (Math.abs(target - outRoll) < 1e-6) outRoll = target === 0 ? 0 : target;
    if (outRoll === -Math.PI) outRoll = Math.PI;
  }

  att.yaw = prevYaw + wrapAngle(outYaw - prevYaw);
  att.pitch = outPitch;
  att.roll = outRoll;
}

const SIN_CLIMB_FREE = Math.sin(CLIMB_FREE_ANGLE);

/**
 * Speed lost to the attitude, m/s² (negative = gained) — the energy rule's
 * pitch term (F6). A climb costs nothing up to CLIMB_FREE_ANGLE (thrust
 * carries it), then ramps to ENERGY_GAIN at vertical. A dive gains the full
 * ENERGY_GAIN·|sin(pitch)|, faded out linearly over the last DIVE_FADE_BAND
 * below `topSpeed`, so it eases onto the cap rather than hitting the clamp.
 */
function energyRate(pitch: number, speed: number, topSpeed: number): number {
  const s = Math.sin(pitch);
  if (s >= 0) {
    return (
      (ENERGY_GAIN * Math.max(0, s - SIN_CLIMB_FREE)) / (1 - SIN_CLIMB_FREE)
    );
  }
  return ENERGY_GAIN * s * clamp((topSpeed - speed) / DIVE_FADE_BAND, 0, 1);
}
