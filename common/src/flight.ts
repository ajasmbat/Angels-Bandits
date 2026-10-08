// Arcade-plus flight model — a pure, renderer-free step function shared by
// client (local simulation) and server (T3 validation reuses its constants).
// No Three.js, no DOM, no Math.random: stepFlight(state, input, dt) → state.
//
// Conventions (match Three.js so the client can feed angles straight into an
// Euler of order "YXZ"): yaw 0 faces -Z, positive pitch is nose-up, positive
// roll is left-wing-down. `turn` input +1 is a right-hand turn (yaw decreases).

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
  SOFT_CEILING,
  SPEED_RESPONSE,
  THROTTLE_RATE,
  TURN_BLEED,
  TURN_RATE,
  TURN_RATE_SLOW,
} from "./constants";
import { type Vec3, canonicalize } from "./world/index";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export interface FlightState {
  /** Canonical position: x/z always in [0, WORLD_SIZE). */
  pos: Vec3;
  /** Heading, radians. 0 faces -Z; decreases in a right-hand turn. */
  yaw: number;
  /** Radians, positive = nose up. */
  pitch: number;
  /** Radians, bank angle (visual + assist). */
  roll: number;
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
  const yaw = state.yaw - turnIn * turnRate * dt;
  const pitch = clamp(
    state.pitch + pitchIn * pitchRate * dt,
    -PITCH_LIMIT,
    PITCH_LIMIT,
  );

  // Roll: banks into the turn on its own; A/D deflect it further; releasing
  // everything eases the wings level (roll is visual, it steers nothing).
  // F6: a critically damped spring (natural frequency BANK_FREQ) toward the
  // target, stepped in closed form — exact for any dt while the target holds
  // — so it leans in from rest and rolls out with no overshoot at every
  // frame rate. x is roll minus its target, v the roll rate. F7: the target
  // is capped at ±MAX_VISUAL_BANK, so turn + same-side A/D can't draw the
  // plane past knife-edge.
  const rollTarget = clamp(
    -turnIn * BANK_ANGLE + rollIn * BANK_ANGLE,
    -MAX_VISUAL_BANK,
    MAX_VISUAL_BANK,
  );
  const rx = state.roll - rollTarget;
  const rv = state.rollRate ?? 0;
  const rDecay = Math.exp(-BANK_FREQ * dt);
  const rc = rv + BANK_FREQ * rx;
  const roll = rollTarget + (rx + rc * dt) * rDecay;
  const rollRate = (rv - BANK_FREQ * rc * dt) * rDecay;

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

  return { pos, yaw, pitch, roll, rollRate, speed, targetSpeed };
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
