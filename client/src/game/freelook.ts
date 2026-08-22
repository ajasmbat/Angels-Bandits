// Hold-E free-look (B2) — the pure seam. All the math behind "look around
// while the plane holds course" lives here, renderer-free (same pattern as
// net/interp.ts and ui/lead.ts): a per-frame step function over immutable
// state, thin adapters in flight-input/camera/main. CLIENT-ONLY by design —
// the shaped input feeds the existing stepFlight; nothing here touches the
// wire or common/.

import type { FlightInput } from "@angels-bandits/common/flight";

/** The free-look key, hardcoded for now (no keybinding UI yet). */
export const FREELOOK_KEY = "KeyE";

/** Seconds of E-held for steering authority to ramp 1 → 0 (linear). */
const STEER_DECAY_S = 0.3;

export interface FreeLookState {
  /** Whether E is currently held (edge rules key off this, not events). */
  held: boolean;
  /** Steering authority 0..1: scales turn/pitch/roll while free-looking. */
  steer: number;
}

/** Fresh, inactive free-look (spawn / death force-exit). */
export function createFreeLook(): FreeLookState {
  return { held: false, steer: 1 };
}

/**
 * Advance one frame. While E is held, steering authority ramps linearly to
 * neutral over STEER_DECAY_S; releasing restores full authority instantly —
 * fresh input must bite on the very next frame.
 */
export function stepFreeLook(
  s: FreeLookState,
  held: boolean,
  _dx: number,
  _dy: number,
  dt: number,
): FreeLookState {
  if (!held) return { held: false, steer: 1 };
  return { held: true, steer: Math.max(0, s.steer - dt / STEER_DECAY_S) };
}

/** Axis × authority, without ever emitting IEEE −0 at full decay. */
const scaleAxis = (v: number, k: number): number => (k === 0 ? 0 : v * k);

/** Scale the steering axes by the current authority; throttle stays live. */
export function shapeInput(
  input: FlightInput,
  s: FreeLookState,
): FlightInput {
  return {
    turn: scaleAxis(input.turn, s.steer),
    pitch: scaleAxis(input.pitch, s.steer),
    roll: scaleAxis(input.roll, s.steer),
    throttle: input.throttle,
  };
}
