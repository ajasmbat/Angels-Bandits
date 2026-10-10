// F10 roll control — the pure seam between the pilot's roll keys (A/D, Q/E,
// the touch roll buttons) and FlightInput.roll. CLIENT-ONLY input shaping,
// like effortless.ts: its output is an ordinary roll command, so the wire,
// common/ and the server never see it. main.ts is the thin adapter and the
// tests drive these very functions.
//
// - Easy roll: the keys' roll axis ramps to full over the tuning's rollRamp
//   and, released, ramps out RELEASE_FASTER × quicker — so a let-go stops
//   within a few degrees of where the pilot let go.
// - A held bank: the flight model no longer levels a released roll (the
//   player's rollLevelRate is 0). Bank the PILOT put in (keys, snap roll) is
//   theirs and holds — unless the ROLL AUTO-LEVEL setting is gentle or
//   strong, which rolls it upright once the keys have been quiet
//   rollLevelDelay s.
//   Bank nobody commanded (the mouse's turn about the body's up near
//   vertical, a loop's gimbal flip, the instructor's own bank-and-pull once
//   it lets go) is always levelled at F7's old self-levelling rate, so a
//   pilot who never touches A/D is never left tilted.
// - Snap roll: a quick double-tap of a roll key rolls onto the next
//   multiple of snapRollAngle that way (90°: onto the wing).
// - One arbitration: keys (or a snap) > the instructor's bank-and-pull >
//   levelling, every source through the same slew, so a hand-off can only
//   change the roll rate at the ramp's own bounded rate (no jerk).

import { ROLL_LEVEL_RATE } from "@angels-bandits/common/constants";
import { tuning } from "./tuning";

const DEG = Math.PI / 180;

export type RollLevelMode = "off" | "gentle" | "strong";
export const ROLL_LEVEL_MODES: readonly RollLevelMode[] = [
  "off",
  "gentle",
  "strong",
];

/** The auto-level a device gets when the player hasn't chosen one: off on
 * the desktop (the bank is yours), gentle on touch (no thumb to spare). */
export function defaultRollLevel(touch: boolean): RollLevelMode {
  return touch ? "gentle" : "off";
}

/** The mode that applies: the Flight Lab's override (the tuning's
 * rollLevelMode, 1–3) over the ROLL AUTO-LEVEL setting `setting`. */
export function effectiveRollLevel(setting: RollLevelMode): RollLevelMode {
  const m = Math.round(tuning.rollLevelMode);
  return m >= 1 && m <= 3
    ? (ROLL_LEVEL_MODES[m - 1] as RollLevelMode)
    : setting;
}

/** A release ramps the axis out this many times faster than it ramps in. */
export const RELEASE_FASTER = 2.5;
/** Double-tap: the first press lasts at most this, s… */
export const TAP_MAX_S = 0.15;
/** …and the second starts within this of its release, s. */
export const DOUBLE_TAP_GAP_S = 0.25;
/** Within this share of a snap step of the next mark, a snap goes one
 * further (so a snap always rolls a visible amount). */
const SNAP_SLACK = 0.1;
/** Snap roll: stick per rad of error left (full rate until ~10° out, then
 * an exponential settle), and done within this. */
const SNAP_GAIN = 6;
const SNAP_DONE = 0.5 * DEG;
/** Below this much of a wing down (|sin roll|: level or inverted) a bank
 * stops being the pilot's. */
const OWN_MIN = Math.sin(3 * DEG);
/** Levelling settles to exactly nothing inside this, rad (the flight
 * model's own snap then puts it back on the exact wings-level path). */
const LEVEL_DONE = 5e-4;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Wrap an angle to (−π, π]. */
const wrapAngle = (a: number): number => {
  if (a > -Math.PI && a <= Math.PI) return a;
  const w = Math.atan2(Math.sin(a), Math.cos(a));
  return w === -Math.PI ? Math.PI : w;
};

export interface RollControlState {
  /** The slewed roll command, stick units (+ = left wing down). */
  axis: number;
  /** The bank is the pilot's (keys / snap): held, or auto-levelled. */
  owned: boolean;
  /** Seconds since the pilot's last roll input. */
  quiet: number;
  /** Last frame's key (−1, 0, +1). */
  keyPrev: number;
  /** When the current press started, s on `clock`. */
  pressAt: number;
  /** When the last quick tap ended and which way it was. */
  tapAt: number;
  tapSide: number;
  /** A snap roll's target real roll, rad, or null. */
  snap: number | null;
  /** Seconds since creation. */
  clock: number;
}

export function createRollControl(): RollControlState {
  return {
    axis: 0,
    owned: false,
    quiet: 0,
    keyPrev: 0,
    pressAt: Number.NEGATIVE_INFINITY,
    tapAt: Number.NEGATIVE_INFINITY,
    tapSide: 0,
    snap: null,
    clock: 0,
  };
}

/** A fresh start (spawn, death, the settings panel's autopilot). */
export function resetRollControl(s: RollControlState): void {
  Object.assign(s, createRollControl());
}

/** One frame's view of the pilot and the plane. */
export interface RollFrame {
  /** The roll keys: +1 rolls left (A, Q, ⟲), −1 right (D, E, ⟳), 0 none. */
  key: number;
  /** An automatic roll command (the instructor's bank-and-pull), stick
   * units, or null for none. */
  auto: number | null;
  /** The ROLL AUTO-LEVEL setting. */
  mode: RollLevelMode;
  /** The airframe's real roll and its pitch, rad. */
  roll: number;
  pitch: number;
}

/** The snap target from `roll` rolling `side` (+1 left): the next multiple
 * of `step` that way, wrapped to (−π, π]. */
export function snapTarget(roll: number, side: number, step: number): number {
  const k = roll / step;
  const n =
    side > 0 ? Math.floor(k + SNAP_SLACK) + 1 : Math.ceil(k - SNAP_SLACK) - 1;
  return wrapAngle(n * step);
}

/** Stick that levels `roll` at `rate` 1/s, scaled by cos(pitch) — at
 * vertical "level" has no direction. `upright` levels to wings-up (the
 * ROLL AUTO-LEVEL assist); otherwise to the nearest of upright or inverted
 * (F7's self-levelling, done by input: the top of a loop stays inverted).
 * Exactly 0 once there. */
export function levelStick(
  roll: number,
  pitch: number,
  rate: number,
  upright = false,
): number {
  const target =
    upright || Math.abs(roll) <= Math.PI / 2
      ? 0
      : roll > 0
        ? Math.PI
        : -Math.PI;
  const err = target - roll;
  if (Math.abs(err) < LEVEL_DONE) return 0;
  return clamp(
    (err * rate * Math.cos(pitch)) / Math.max(1e-6, tuning.rollRate),
    -1,
    1,
  );
}

/** The levelling rate of a mode, 1/s (0 = off). */
function modeRate(mode: RollLevelMode): number {
  return mode === "strong"
    ? tuning.rollLevelStrong
    : mode === "gentle"
      ? tuning.rollLevelGentle
      : 0;
}

/**
 * Advance one frame; returns the roll command for stepFlight (stick units).
 */
export function stepRollControl(
  s: RollControlState,
  f: RollFrame,
  dt: number,
): number {
  s.clock += dt;
  const key = f.key > 0 ? 1 : f.key < 0 ? -1 : 0;
  const roll = f.roll;

  // Taps: a press shorter than TAP_MAX_S is a tap; a second press the same
  // way within DOUBLE_TAP_GAP_S of it is a snap roll.
  if (key !== s.keyPrev) {
    if (s.keyPrev !== 0) {
      const quick = s.clock - s.pressAt <= TAP_MAX_S + 1e-9;
      s.tapAt = quick ? s.clock : Number.NEGATIVE_INFINITY;
      s.tapSide = quick ? s.keyPrev : 0;
    }
    if (key !== 0) {
      s.pressAt = s.clock;
      if (key === s.tapSide && s.clock - s.tapAt <= DOUBLE_TAP_GAP_S + 1e-9) {
        s.snap = snapTarget(roll, key, tuning.snapRollAngle);
        s.tapAt = Number.NEGATIVE_INFINITY;
        s.tapSide = 0;
      } else if (s.snap !== null) {
        s.snap = null; // any other press takes the roll back
      }
    }
    s.keyPrev = key;
  }

  let want: number;
  if (s.snap !== null) {
    const err = wrapAngle(s.snap - roll);
    if (Math.abs(err) < SNAP_DONE) {
      s.snap = null;
      want = 0;
    } else {
      want = clamp(err * SNAP_GAIN, -1, 1);
    }
    s.owned = true;
    s.quiet = 0;
  } else if (key !== 0) {
    want = key;
    s.owned = true;
    s.quiet = 0;
  } else {
    s.quiet += dt;
    if (Math.abs(Math.sin(roll)) < OWN_MIN) s.owned = false;
    if (f.auto !== null) {
      // The instructor's bank-and-pull: never the pilot's bank.
      want = f.auto;
      s.owned = false;
    } else if (!s.owned) {
      want = levelStick(roll, f.pitch, ROLL_LEVEL_RATE);
    } else {
      const rate = modeRate(f.mode);
      want =
        rate > 0 && s.quiet >= tuning.rollLevelDelay
          ? levelStick(roll, f.pitch, rate, true)
          : 0;
    }
  }

  s.axis = slew(s.axis, want, dt);
  return s.axis;
}

/** Move `axis` toward `want`: growing at 1/rollRamp per second, shrinking
 * (to zero, on a reversal) RELEASE_FASTER × quicker. Exact at the end. */
function slew(axis: number, want: number, dt: number): number {
  const ramp = tuning.rollRamp;
  if (ramp <= 0) return want;
  const up = dt / ramp;
  const down = up * RELEASE_FASTER;
  if (axis !== 0 && Math.sign(want) !== Math.sign(axis)) {
    // Out toward zero first (a release or a reversal); a reversal ramps
    // up the other way from the next frame.
    return Math.sign(axis) * Math.max(0, Math.abs(axis) - down);
  }
  const d = want - axis;
  if (Math.abs(want) < Math.abs(axis)) {
    return Math.abs(d) <= down ? want : axis + Math.sign(d) * down;
  }
  return Math.abs(d) <= up ? want : axis + Math.sign(d) * up;
}

/** The roll keys → the frame's key: A/Q roll left (+1), D/E right (−1). */
export function rollKey(held: (code: string) => boolean): number {
  const left = held("KeyA") || held("KeyQ") ? 1 : 0;
  const right = held("KeyD") || held("KeyE") ? 1 : 0;
  return left - right;
}
