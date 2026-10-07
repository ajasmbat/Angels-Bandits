// Ground/wall proximity warning + avoidance assist (F4) — the pure seam. Same
// shape as freelook.ts and instructor.ts: a per-frame step over immutable
// state, renderer-free, thin adapters in main/hud/sound. CLIENT-ONLY — the
// assist's output is an ordinary FlightInput into the shared stepFlight, so
// nothing here touches the wire, common/ or the server, and crashes stay
// exactly as deadly as they were.
//
// Prediction rolls stepFlight forward with the CURRENT command held, so a
// player who is already pulling out of a dive or turning away from a facade
// sees no warning and gets no help: "imminent" always means "on the path you
// are actually flying".

import type { Building } from "@angels-bandits/common/city";
import {
  type MoverField,
  collideMovers,
} from "@angels-bandits/common/city/movers";
import {
  type CityIndex,
  type NatureIndex,
  collideCity,
  collideNature,
  hitsGround,
} from "@angels-bandits/common/collision";
import { PLAYER_RADIUS } from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import type { AimError } from "./instructor";

/** Warn (HUD + tone) this long before the predicted impact, s. */
export const WARN_S = 1.5;
/** The assist starts bending the path this long before impact, s — a
 * little ahead of the alarm, because at combat speed a perpendicular facade
 * 1.5 s out is already inside the capped pull-up radius (~100 m). */
export const ASSIST_S = 2.2;
/** Escape candidates are judged over this longer horizon, s, so "clear"
 * means clear for a beat after the warning window, not just inside it. */
const ESCAPE_HORIZON_S = 3;
/** Prediction step, s: ≤ 6 m per sample even at full boost. */
const STEP_S = 0.05;
/** Probe radius, m: exactly the crash radius detectCrash judges — any air
 * on top would make an H1 archway or a street tunnel read as a wall and
 * steer players away from the holes they are aiming for. */
const PROBE_RADIUS = PLAYER_RADIUS;
/** The warning stays up this long after the path clears, s — no flicker
 * while a pull-up skims the edge of the window. */
const WARN_HOLD_S = 0.3;
/** Most deflection the assist ever ADDS to the player's own command (on a
 * −1..1 axis) — it bends the path, it never takes the stick. */
export const ASSIST_CAP = 0.7;
/** Assist strength as it starts (ASSIST_S out), as a fraction of
 * ASSIST_CAP; it reaches the full cap ASSIST_FULL_S before impact. */
const ASSIST_FLOOR = 0.3;
const ASSIST_FULL_S = 1.2;
/** Ease time constant of the applied assist, s — no jerks in or out. */
const ASSIST_EASE_S = 0.12;

/** Escape directions, tried in this order (pull up first): pitch + = up,
 * turn + = right. Diagonals are normalised so every escape is the same size. */
const ESCAPES: readonly { pitch: number; turn: number }[] = [
  { pitch: 1, turn: 0 },
  { pitch: Math.SQRT1_2, turn: -Math.SQRT1_2 },
  { pitch: Math.SQRT1_2, turn: Math.SQRT1_2 },
  { pitch: 0, turn: -1 },
  { pitch: 0, turn: 1 },
];

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** Everything the plane can fly into — the same data detectCrash uses. */
export interface ProximityWorld {
  buildings: readonly Building[];
  index?: CityIndex;
  nature?: NatureIndex;
  movers?: MoverField;
  /** The clock the movers are RENDERED at (main's latched renderMs); null
   * means they are hidden, so not solid — detectCrash's rule. */
  timeMs?: number | null;
}

/** True when a probe sphere at `pos`, `ahead` seconds from now, is in
 * something solid. */
function solidAt(
  pos: FlightState["pos"],
  world: ProximityWorld,
  ahead: number,
): boolean {
  if (hitsGround(pos, PROBE_RADIUS)) return true;
  if (collideCity(pos, PROBE_RADIUS, world.buildings, world.index) !== null) {
    return true;
  }
  if (world.nature && collideNature(pos, PROBE_RADIUS, world.nature)) {
    return true;
  }
  if (!world.movers || world.timeMs === null || world.timeMs === undefined) {
    return false;
  }
  return (
    collideMovers(
      pos,
      PROBE_RADIUS,
      world.movers,
      world.timeMs + ahead * 1000,
    ) !== null
  );
}

/**
 * Seconds until the plane would hit the ground, a building, a tree or a
 * mover if it held `input` from `flight`, or null if the path is clear for
 * `horizonS`. Rolls the shared stepFlight, so turns, the pitch limit, speed
 * bleed and boost are all the real model's.
 */
export function predictImpact(
  flight: FlightState,
  input: FlightInput,
  world: ProximityWorld,
  horizonS: number = WARN_S,
): number | null {
  let f = flight;
  const steps = Math.round(horizonS / STEP_S);
  for (let i = 1; i <= steps; i++) {
    f = stepFlight(f, input, STEP_S);
    if (solidAt(f.pos, world, i * STEP_S)) return i * STEP_S;
  }
  return null;
}

export interface AvoidanceState {
  /** Applied (eased) assist, added to the command's pitch/turn axes. */
  pitch: number;
  turn: number;
  /** Index into ESCAPES last chosen, or −1 — ties keep it, so the assist
   * never flips sides between two equally clear escapes. */
  escape: number;
  /** Seconds the warning stays up once the path clears (WARN_HOLD_S). */
  warnHold: number;
}

/** Fresh, idle assist (spawn / death). */
export function createAvoidance(): AvoidanceState {
  return { pitch: 0, turn: 0, escape: -1, warnHold: 0 };
}

export interface AvoidanceStep {
  state: AvoidanceState;
  /** Predicted seconds to impact on the held command (within ASSIST_S), or
   * null when the path is clear. */
  impactIn: number | null;
  /** Impact within WARN_S: show PULL UP and sound the tone. */
  warning: boolean;
  /** The command to fly: the player's, plus the eased assist when enabled. */
  input: FlightInput;
}

/** Below this an easing-out assist snaps to exactly zero, so "is it
 * acting?" has a real answer (main holds the instructor latch on it). */
const SNAP = 1e-3;

/** Ease toward `target`, snapping to an exact 0 on the way out. */
function ease(v: number, target: number, blend: number): number {
  const next = v + (target - v) * blend;
  return target === 0 && Math.abs(next) < SNAP ? 0 : next;
}

/** `input` + `dir` × `k` on the steering axes, clamped to ±1. */
function withEscape(
  input: FlightInput,
  dir: { pitch: number; turn: number },
  k: number,
): FlightInput {
  return {
    ...input,
    pitch: clamp(input.pitch + dir.pitch * k, -1, 1),
    turn: clamp(input.turn + dir.turn * k, -1, 1),
  };
}

/**
 * Advance one frame. `input` is the command the plane would otherwise fly
 * (instructor, free-look and zoom authority already applied). The warning is
 * up while the held command hits something within WARN_S (plus the short
 * hold); from ASSIST_S out each escape is tried at the full
 * ASSIST_CAP and the one whose path is clear — or hits latest — wins; if no
 * escape beats doing nothing, the assist adds nothing, so it can never steer
 * the plane into a different obstacle than the one it was already heading
 * for. Strength grows with urgency and is eased in and out. `enabled` false
 * still reports the warning (the player toggled the help, not the alarm).
 */
export function stepAvoidance(
  s: AvoidanceState,
  input: FlightInput,
  flight: FlightState,
  world: ProximityWorld,
  dt: number,
  enabled = true,
): AvoidanceStep {
  const impactIn = predictImpact(
    flight,
    input,
    world,
    Math.max(WARN_S, ASSIST_S),
  );
  let target = { pitch: 0, turn: 0 };
  let chosen = -1;
  if (enabled && impactIn !== null) {
    let best = impactIn;
    // Previous choice first, so a tie keeps it.
    const order = ESCAPES.map((_, i) => i);
    if (s.escape >= 0) order.unshift(...order.splice(s.escape, 1));
    for (const i of order) {
      const e = ESCAPES[i];
      if (!e) continue;
      const t =
        predictImpact(
          flight,
          withEscape(input, e, ASSIST_CAP),
          world,
          ESCAPE_HORIZON_S,
        ) ?? Number.POSITIVE_INFINITY;
      if (t > best) {
        best = t;
        chosen = i;
      }
    }
    const e = ESCAPES[chosen];
    if (e) {
      const urgency = clamp(
        (ASSIST_S - impactIn) / (ASSIST_S - ASSIST_FULL_S),
        0,
        1,
      );
      const k = ASSIST_CAP * (ASSIST_FLOOR + (1 - ASSIST_FLOOR) * urgency);
      target = { pitch: e.pitch * k, turn: e.turn * k };
    }
  }
  const blend = 1 - Math.exp(-dt / ASSIST_EASE_S);
  const warn = impactIn !== null && impactIn <= WARN_S;
  const state: AvoidanceState = {
    pitch: ease(s.pitch, target.pitch, blend),
    turn: ease(s.turn, target.turn, blend),
    escape: chosen,
    warnHold: warn ? WARN_HOLD_S : Math.max(0, s.warnHold - dt),
  };
  return {
    state,
    impactIn,
    warning: warn || state.warnHold > 0,
    input: enabled ? withEscape(input, state, 1) : input,
  };
}

/**
 * The aim error the assist itself put on the nose this frame, in the
 * instructor's `latch` units — for main to feed back next frame. Without it
 * the mouse-aim instructor sees the nose pulled off the cursor and flies it
 * straight back at the wall (its loop gain beats the capped assist); latched,
 * the instructor ignores the assist's offset while it acts and eases back to
 * the cursor after. `rates` are the full-deflection rates stepFlight used.
 */
export function assistLatch(
  shaped: FlightInput,
  flown: FlightInput,
  rates: { turnRate: number; pitchRate: number },
  dt: number,
): AimError {
  // turn +1 DEcreases yaw, and err = aim − nose, so both signs flip once.
  return {
    yaw: (flown.turn - shaped.turn) * rates.turnRate * dt,
    pitch: -(flown.pitch - shaped.pitch) * rates.pitchRate * dt,
  };
}
