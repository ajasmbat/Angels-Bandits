// Arcade-plus flight model — a pure, renderer-free step function shared by
// client (local simulation) and server (T3 validation reuses its constants).
// No Three.js, no DOM, no Math.random: stepFlight(state, input, dt) → state.
//
// Conventions (match Three.js so the client can feed angles straight into an
// Euler of order "YXZ"): yaw 0 faces -Z, positive pitch is nose-up, positive
// roll is left-wing-down. `turn` input +1 is a right-hand turn (yaw decreases).

import {
  BANK_ANGLE,
  BANK_RESPONSE,
  CEILING_FADE,
  ENERGY_GAIN,
  MAX_SPEED,
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
  /** Current airspeed, m/s. Always in [MIN_SPEED, MAX_SPEED]. */
  speed: number;
  /** Throttle-commanded speed, m/s, set by W/S. In [MIN_SPEED, MAX_SPEED]. */
  targetSpeed: number;
}

/** All axes in [-1, 1]. pitch + = pull up; turn + = turn right; throttle + = W. */
export interface FlightInput {
  pitch: number;
  turn: number;
  roll: number;
  throttle: number;
}

/** Fresh level flight state at `pos` (canonicalized): spawn / respawn shape. */
export function createFlightState(pos: Vec3, yaw = 0): FlightState {
  return {
    pos: canonicalize(pos),
    yaw,
    pitch: 0,
    roll: 0,
    speed: RESPAWN_SPEED,
    targetSpeed: RESPAWN_SPEED,
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

/** Advance the flight model one tick. Pure: never mutates `state` or `input`. */
export function stepFlight(
  state: FlightState,
  input: FlightInput,
  dt: number,
): FlightState {
  const turnIn = clamp(input.turn, -1, 1);
  const pitchIn = clamp(input.pitch, -1, 1);
  const rollIn = clamp(input.roll, -1, 1);

  // Mouse-aim steering: inputs are rate commands at capped rates; neutral
  // input holds the current attitude (no auto-level of pitch or yaw).
  const yaw = state.yaw - turnIn * TURN_RATE * dt;
  const pitch = clamp(
    state.pitch + pitchIn * PITCH_RATE * dt,
    -PITCH_LIMIT,
    PITCH_LIMIT,
  );

  // Roll: banks into the turn on its own; A/D deflect it further; releasing
  // everything eases the wings level (roll is visual, it steers nothing).
  const rollTarget = -turnIn * BANK_ANGLE + rollIn * BANK_ANGLE;
  const rollBlend = 1 - Math.exp(-BANK_RESPONSE * dt);
  const roll = state.roll + (rollTarget - state.roll) * rollBlend;

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
  // Clamped: at MIN_SPEED you mush, never stall.
  const effectiveTarget = MIN_SPEED + (targetSpeed - MIN_SPEED) * power;
  const maneuver = Math.min(1, Math.abs(turnIn) + Math.abs(pitchIn));
  const dSpeed =
    SPEED_RESPONSE * (effectiveTarget - state.speed) -
    ENERGY_GAIN * Math.sin(pitch) -
    TURN_BLEED * maneuver;
  const speed = clamp(state.speed + dSpeed * dt, MIN_SPEED, MAX_SPEED);

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

  return { pos, yaw, pitch, roll, speed, targetSpeed };
}
