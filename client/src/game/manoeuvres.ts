// FC1 one-key manoeuvres — the pure seam. Two macros that fly a short,
// scripted stick for the pilot and hand back:
//
// - QUICK 180 (X): reverse the heading. Where the half loop above is clear
//   (the sky over the street, a ceiling to spare) it is an IMMELMANN: a full
//   pull up and over, then a half roll upright at the top — out higher,
//   going back the way you came. Where it isn't (a deck or a tower above, the
//   storm ceiling) it is a flat U-TURN instead: roll to the tuning's
//   uTurnBank toward the side with more room, pull round (F10's bank-and-pull
//   bites hard on a wing), roll out.
// - BARREL-ROLL DODGE (V): a full 360° roll toward one side with a little
//   pull held through it — a corkscrew that steps the plane off its line
//   (and off a pursuer's gun line) and ends where it began, wings level.
//
// Same shape as the other seams: plain state, a per-frame step that writes
// stepFlight's stick units into caller-owned output, renderer-free. The
// roll goes to roll-control.ts as its `auto` (never the pilot's bank: what
// is left when the macro ends is levelled), and the pilot's own A/D always
// wins over it. CLIENT-ONLY — the output is an ordinary FlightInput, so the
// wire, common/ and the server's clamps never see it. Allocation-free.

import {
  type FlightState,
  flightForward,
  pitchRadius,
  realRoll,
} from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import { tuning } from "./tuning";

const DEG = Math.PI / 180;

/** The keys: hardcoded like FREELOOK_KEY (no keybinding UI). */
export const UTURN_KEY = "KeyX";
export const DODGE_KEY = "KeyV";

export type ManoeuvreKind = "loop" | "flat" | "dodge";

/** Phases. Loop: 0 pull over the top, 1 half roll upright. Flat: 0 roll
 * in, 1 pull round, 2 roll out. Dodge: 0 roll. */
export interface Manoeuvre {
  kind: ManoeuvreKind | null;
  phase: number;
  /** Seconds in. */
  t: number;
  /** +1 rolls left (+roll is left wing down), −1 right. */
  side: number;
  /** The heading it started on, as a level unit vector. */
  fx: number;
  fz: number;
  /** Dodge: the roll flown so far, rad, and last frame's roll. */
  rolled: number;
  prevRoll: number;
}

export function createManoeuvre(): Manoeuvre {
  return {
    kind: null,
    phase: 0,
    t: 0,
    side: 1,
    fx: 0,
    fz: -1,
    rolled: 0,
    prevRoll: 0,
  };
}

/** Stop whatever is being flown (a death, the settings, a threat). */
export function cancelManoeuvre(m: Manoeuvre): void {
  m.kind = null;
  m.phase = 0;
  m.t = 0;
}

export const manoeuvreActive = (m: Manoeuvre): boolean => m.kind !== null;

/** Give up after this long whatever the phase, s (a stuck macro must
 * never hold the stick). */
const TIMEOUT_S = 5;
/** The Immelmann's air: clear sky this far round the half loop, m, and
 * this far under the storm ceiling at its top. */
const LOOP_CLEAR = 6;
const LOOP_SAMPLES = 16;
/** Done once the wings are this close to level, rad. */
const LEVEL_DONE = 8 * DEG;
/** A heading counts as reversed once the nose points this far back (cos of
 * the angle to the start heading): the flat turn rolls out there, and the
 * loop half-rolls there — 18° short of inverted-level, so it comes out in
 * a gentle climb. */
const REVERSED = -0.85;
const LOOP_REVERSED = -0.95;
/** Roll gain onto a target bank, stick per rad. */
const ROLL_GAIN = 3;
/** Dodge: done this short of a full turn (roll-control levels the rest). */
const DODGE_DONE = 2 * Math.PI - 20 * DEG;
/** Flat U-turn: the bank it pulls from, as a share of uTurnBank. */
const BANK_READY = 0.85;

/** A sphere test against the world: true when `pos` (radius `r`) touches
 * a solid. main: touchesSolid at the render clock. */
export type Solid = (pos: Vec3, r: number) => boolean;

const probe: Vec3 = { x: 0, y: 0, z: 0 };

/** Whether the half loop from `flight` (pull radius at its speed, plus
 * LOOP_CLEAR) is clear of `solid` and stays under `ceiling`. */
export function loopClear(
  flight: Pick<FlightState, "pos" | "yaw" | "pitch" | "speed">,
  solid: Solid,
  ceiling: number,
): boolean {
  const r = pitchRadius(flight.speed, tuning);
  if (flight.pos.y + 2 * r + LOOP_CLEAR > ceiling) return false;
  const fx = -Math.sin(flight.yaw);
  const fz = -Math.cos(flight.yaw);
  for (let i = 1; i <= LOOP_SAMPLES; i++) {
    // Up and over the circle tangent to the path: forward r·sin, up
    // r·(1 − cos).
    const a = (Math.PI * i) / LOOP_SAMPLES;
    probe.x = flight.pos.x + fx * r * Math.sin(a);
    probe.y = flight.pos.y + r * (1 - Math.cos(a));
    probe.z = flight.pos.z + fz * r * Math.sin(a);
    if (solid(probe, LOOP_CLEAR)) return false;
  }
  return true;
}

/** How far round a flat U-turn toward `side` stays clear: the share of its
 * half circle (radius `r`) before the first solid, 0..1. */
export function flatClear(
  flight: Pick<FlightState, "pos" | "yaw">,
  side: number,
  r: number,
  solid: Solid,
): number {
  const fx = -Math.sin(flight.yaw);
  const fz = -Math.cos(flight.yaw);
  // Left of forward on the ground plane is (fz, −fx): yaw 0 faces −Z, and
  // its left is −X. +side (a left turn) swings that way.
  const lx = fz * side;
  const lz = -fx * side;
  for (let i = 1; i <= LOOP_SAMPLES; i++) {
    const a = (Math.PI * i) / LOOP_SAMPLES;
    probe.x = flight.pos.x + fx * r * Math.sin(a) + lx * r * (1 - Math.cos(a));
    probe.y = flight.pos.y;
    probe.z = flight.pos.z + fz * r * Math.sin(a) + lz * r * (1 - Math.cos(a));
    if (solid(probe, LOOP_CLEAR)) return (i - 1) / LOOP_SAMPLES;
  }
  return 1;
}

/**
 * Start the quick 180 from `flight`: the Immelmann where loopClear, else a
 * flat U-turn toward the clearer side (`prefer`'s on a tie: +1 left). The
 * flat turn's radius is the bank-and-pull's at this speed.
 */
export function startUTurn(
  m: Manoeuvre,
  flight: FlightState,
  solid: Solid,
  ceiling: number,
  prefer: number,
): void {
  begin(m, flight, prefer >= 0 ? 1 : -1);
  if (loopClear(flight, solid, ceiling)) {
    m.kind = "loop";
    return;
  }
  const s = Math.sin(tuning.uTurnBank);
  const r = flight.speed / (tuning.pitchRate * (1 + tuning.bankPull * s * s));
  const left = flatClear(flight, 1, r, solid);
  const right = flatClear(flight, -1, r, solid);
  if (left !== right) m.side = left > right ? 1 : -1;
  m.kind = "flat";
}

/** Start the barrel-roll dodge toward `side` (+1 left, −1 right). */
export function startDodge(
  m: Manoeuvre,
  flight: FlightState,
  side: number,
): void {
  begin(m, flight, side >= 0 ? 1 : -1);
  m.kind = "dodge";
}

function begin(m: Manoeuvre, flight: FlightState, side: number): void {
  const f = flightForward(flight);
  const h = Math.hypot(f.x, f.z) || 1;
  m.phase = 0;
  m.t = 0;
  m.side = side;
  m.fx = f.x / h;
  m.fz = f.z / h;
  m.rolled = 0;
  m.prevRoll = realRoll(flight);
}

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** The stick a macro flies this frame. `roll` is for roll-control's `auto`. */
export interface ManoeuvreStick {
  turn: number;
  pitch: number;
  roll: number;
}

export function createManoeuvreStick(): ManoeuvreStick {
  return { turn: 0, pitch: 0, roll: 0 };
}

/**
 * Advance one frame and write the stick into `out`. Returns false (and
 * clears the macro) once it is done — `out` is then all zero.
 */
export function stepManoeuvre(
  m: Manoeuvre,
  flight: FlightState,
  dt: number,
  out: ManoeuvreStick,
): boolean {
  out.turn = 0;
  out.pitch = 0;
  out.roll = 0;
  if (m.kind === null) return false;
  m.t += dt;
  if (m.t > TIMEOUT_S) {
    cancelManoeuvre(m);
    return false;
  }
  const roll = realRoll(flight);
  const f = flightForward(flight);
  const back = f.x * m.fx + f.z * m.fz; // cos to the start heading (level)
  if (m.kind === "dodge") {
    m.rolled += Math.abs(wrapAngle(roll - m.prevRoll));
    m.prevRoll = roll;
    if (m.rolled >= DODGE_DONE) {
      cancelManoeuvre(m);
      return false;
    }
    out.roll = m.side;
    out.pitch = tuning.dodgePull;
    return true;
  }
  if (m.kind === "loop") {
    if (m.phase === 0) {
      // Pull up and over, no roll: the pull alone carries the nose through
      // vertical and onto its back (the Euler roll flips to ±180° there —
      // that is the loop, not a bank to level).
      out.pitch = 1;
      // Over the top: the nose is back the other way and still well up
      // from vertical.
      if (back < LOOP_REVERSED) m.phase = 1;
      return true;
    }
    // The half roll upright at the top, the macro's own way round.
    const toUp = wrapAngle(-roll);
    if (Math.abs(toUp) < LEVEL_DONE) {
      cancelManoeuvre(m);
      return false;
    }
    out.roll =
      Math.abs(toUp) > Math.PI - LEVEL_DONE
        ? m.side
        : clamp(toUp * ROLL_GAIN, -1, 1);
    return true;
  }
  // Flat U-turn.
  const bank = m.side * tuning.uTurnBank;
  if (m.phase === 0) {
    out.roll = clamp((bank - roll) * ROLL_GAIN, -1, 1);
    if (Math.abs(roll) >= tuning.uTurnBank * BANK_READY) m.phase = 1;
    return true;
  }
  if (m.phase === 1) {
    out.roll = clamp((bank - roll) * ROLL_GAIN, -1, 1);
    out.pitch = 1;
    if (back < REVERSED) m.phase = 2;
    return true;
  }
  out.roll = clamp(-roll * ROLL_GAIN, -1, 1);
  if (Math.abs(roll) < LEVEL_DONE) {
    cancelManoeuvre(m);
    return false;
  }
  return true;
}
