// Ground/wall proximity warning + avoidance assist (F4) — the pure seam. Same
// shape as freelook.ts and instructor.ts: a per-frame step over immutable
// state, renderer-free, thin adapters in main/hud/sound. CLIENT-ONLY — the
// assist's output is an ordinary FlightInput into the shared stepFlight, so
// nothing here touches the wire, common/ or the server, and crashes stay
// exactly as deadly as they were.
//
// "Imminent" means the player cannot get out of it by what they are already
// doing: the path is rolled forward twice, once with the command HELD and
// once with it RELAXING to neutral, and only when BOTH end in something solid
// is there a threat. A player turning through a corner (the held path
// clears) or easing out of a weave (the relaxed path clears) is left alone.
// HOTFIX ANGE-QR7P8U: holding a stick deflection for 2 s in a 40 m street
// canyon always "hits" a facade, and the old pull-up-first escapes then
// dragged players up out of the city. Walls now alarm only when a gentle
// street-following correction would not clear them, and the assist tries
// level, street-following escapes before it ever climbs.

import type { Building } from "@angels-bandits/common/city";
import {
  type MoverField,
  collideMovers,
} from "@angels-bandits/common/city/movers";
import { LOT_LINE } from "@angels-bandits/common/city/street";
import {
  type CityIndex,
  type NatureIndex,
  collideCity,
  collideNature,
  hitsGround,
} from "@angels-bandits/common/collision";
import { BLOCK_PITCH, PLAYER_RADIUS } from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import type { AimError } from "./instructor";

/** Warn (HUD + tone) this long before a predicted ground impact, s. */
export const WARN_S = 1.5;
/** Warn this long before a predicted wall impact, s — shorter than the
 * ground's, because a street canyon is never more than ~2 s from a facade
 * on a straight line and a wall is escaped with a flick, not a pull-out. */
export const WALL_WARN_S = 1.2;
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
/** The relaxed hypothesis eases the player's pitch/turn to neutral with
 * this time constant, s ("they let go of the stick"). */
const RELAX_S = 0.4;
/** The warning stays up this long after the path clears, s — no flicker
 * while a pull-up skims the edge of the window — but never longer than it
 * was actually up, so a one-frame blip stays a one-frame blip. */
const WARN_HOLD_S = 0.3;
/** Most deflection the assist ever ADDS to the player's own command (on a
 * −1..1 axis) — it bends the path, it never takes the stick. Not lower: at
 * 90 m/s a smaller cap's turn and pull radii exceed the ASSIST_S lead. */
export const ASSIST_CAP = 0.7;
/** Assist strength as it starts (ASSIST_S out), as a fraction of
 * ASSIST_CAP; it reaches the full cap ASSIST_FULL_S before impact. */
const ASSIST_FLOOR = 0.3;
const ASSIST_FULL_S = 1.2;
/** Ease time constant of the applied assist, s — no jerks in or out. */
const ASSIST_EASE_S = 0.12;

// Street following: the city is axis-aligned, so "fly the street" is "hold
// the nearest cardinal heading", bent gently toward the street's centreline.
/** Heading-error gain, turn per radian. */
const FOLLOW_GAIN = 3;
/** Centring gain, radians of heading bend per metre off the centreline. */
const CENTRE_GAIN = 0.01;
/** Most the centring bends the heading, rad. */
const CENTRE_MAX = 0.25;
/** The follow axis only switches once the heading is this much past the
 * 45° midpoint, rad — no frame-to-frame flip through a diagonal. */
const AXIS_HYSTERESIS = (10 * Math.PI) / 180;

const QUARTER = Math.PI / 2;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** `a` wrapped to (−π, π]. */
const wrapAngle = (a: number): number =>
  a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

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

/** What a predicted impact hits: the ground (or a roof, from above), or a
 * wall (a facade, a tree, a mover). */
export type ImpactKind = "ground" | "wall";

export interface Impact {
  /** Seconds from now. */
  t: number;
  kind: ImpactKind;
}

/** A command that may change along the predicted path: (state, seconds
 * ahead) → the input flown at that step. */
export type Pilot = (f: FlightState, t: number) => FlightInput;

/** What a probe sphere at `pos`, `ahead` seconds from now, is in — or
 * null. `prevY` is the previous sample's height: a building contact that
 * clears at that height was made by sinking onto it — a roof or setback
 * ledge, which is ground for the cue — and anything else is a wall. */
function solidAt(
  pos: FlightState["pos"],
  prevY: number,
  world: ProximityWorld,
  ahead: number,
): ImpactKind | null {
  if (hitsGround(pos, PROBE_RADIUS)) return "ground";
  if (collideCity(pos, PROBE_RADIUS, world.buildings, world.index) !== null) {
    const level = { ...pos, y: Math.max(pos.y, prevY) };
    const roof =
      collideCity(level, PROBE_RADIUS, world.buildings, world.index) === null;
    return roof ? "ground" : "wall";
  }
  if (world.nature && collideNature(pos, PROBE_RADIUS, world.nature)) {
    return "wall";
  }
  if (!world.movers || world.timeMs === null || world.timeMs === undefined) {
    return null;
  }
  return collideMovers(
    pos,
    PROBE_RADIUS,
    world.movers,
    world.timeMs + ahead * 1000,
  ) !== null
    ? "wall"
    : null;
}

/**
 * When and what the plane would hit flying `input` (held, or a Pilot) from
 * `flight`, or null if the path is clear for `horizonS`. Rolls the shared
 * stepFlight, so turns, the pitch limit, speed bleed and boost are all the
 * real model's.
 */
export function predictImpact(
  flight: FlightState,
  input: FlightInput | Pilot,
  world: ProximityWorld,
  horizonS: number = ASSIST_S,
): Impact | null {
  let f = flight;
  const steps = Math.round(horizonS / STEP_S);
  for (let i = 1; i <= steps; i++) {
    const t = i * STEP_S;
    const cmd = typeof input === "function" ? input(f, t - STEP_S) : input;
    const prevY = f.pos.y;
    f = stepFlight(f, cmd, STEP_S);
    const kind = solidAt(f.pos, prevY, world, t);
    if (kind !== null) return { t, kind };
  }
  return null;
}

/** The player's command easing to neutral: "what if they let go?". */
function relaxed(input: FlightInput): Pilot {
  return (_f, t) => {
    const k = Math.exp(-t / RELAX_S);
    return { ...input, pitch: input.pitch * k, turn: input.turn * k };
  };
}

/** The cardinal heading (a multiple of π/2) nearest `yaw`, kept at `prev`
 * until the heading is AXIS_HYSTERESIS past the diagonal. */
function nearestAxis(yaw: number, prev: number | null): number {
  if (
    prev !== null &&
    Math.abs(wrapAngle(yaw - prev)) < QUARTER / 2 + AXIS_HYSTERESIS
  ) {
    return prev;
  }
  return wrapAngle(Math.round(yaw / QUARTER) * QUARTER);
}

/**
 * The absolute turn command that lines `f` up with the street axis `axis`,
 * bent toward the nearest parallel street centreline while the plane is
 * inside that street (LOT_LINE of it). Elsewhere — over a block, through a
 * mid-block arch — it only holds the heading, so it never pulls the plane
 * sideways into a jamb.
 */
export function followTurn(f: FlightState, axis: number): number {
  const fx = -Math.sin(axis);
  const fz = -Math.cos(axis);
  // Along ±z the street centrelines are x = k·BLOCK_PITCH, and vice versa.
  const alongZ = Math.abs(fz) > Math.abs(fx);
  const lat = alongZ ? f.pos.x : f.pos.z;
  const off = lat - Math.round(lat / BLOCK_PITCH) * BLOCK_PITCH;
  const bend =
    Math.abs(off) < LOT_LINE
      ? clamp(-CENTRE_GAIN * off, -CENTRE_MAX, CENTRE_MAX)
      : 0;
  const dx = fx + (alongZ ? bend : 0);
  const dz = fz + (alongZ ? 0 : bend);
  const err = wrapAngle(Math.atan2(-dx, -dz) - f.yaw);
  // turn +1 DEcreases yaw.
  return clamp(-FOLLOW_GAIN * err, -1, 1);
}

/** `base`'s command with its turn moved toward following `axis` by at
 * most `k`. */
function following(base: FlightInput | Pilot, axis: number, k: number): Pilot {
  return (f, t) => {
    const cmd = typeof base === "function" ? base(f, t) : base;
    return {
      ...cmd,
      turn: cmd.turn + clamp(followTurn(f, axis) - cmd.turn, -k, k),
    };
  };
}

/** An escape: a level one turns onto a street axis (closed-loop, so it rolls
 * out instead of flying on into the far facade); a climbing one is a fixed
 * direction (pitch + = up, turn + = right), normalised to the same size. */
type Escape =
  | { level: true; axisTurn: number }
  | { level: false; pitch: number; turn: number };

/** Index order matters: AvoidanceState.escape stores it. */
const ESCAPES: readonly Escape[] = [
  { level: true, axisTurn: 0 }, // follow the street you are in
  { level: true, axisTurn: QUARTER }, // break left (yaw +)
  { level: true, axisTurn: -QUARTER }, // break right
  { level: false, pitch: Math.SQRT1_2, turn: -Math.SQRT1_2 },
  { level: false, pitch: Math.SQRT1_2, turn: Math.SQRT1_2 },
  { level: false, pitch: 1, turn: 0 },
];
/** Walls: level escapes first, climb only when none clears. */
const WALL_ORDER = [0, 1, 2, 3, 4, 5];
/** Ground: turning never helps — pull up (pure first). */
const GROUND_ORDER = [5, 3, 4];

const clamp1 = (v: number): number => clamp(v, -1, 1);

/** `input` + `dir` × `k` on the steering axes, clamped to ±1. */
function withEscape(
  input: FlightInput,
  dir: { pitch: number; turn: number },
  k: number,
): FlightInput {
  return {
    ...input,
    pitch: clamp1(input.pitch + dir.pitch * k),
    turn: clamp1(input.turn + dir.turn * k),
  };
}

/** The escape `e` as a Pilot at strength `k`. */
function escapePilot(
  e: Escape,
  input: FlightInput,
  axis: number,
  k: number,
): FlightInput | Pilot {
  return e.level
    ? following(input, wrapAngle(axis + e.axisTurn), k)
    : withEscape(input, e, k);
}

/** The assist offset `e` asks for THIS frame at strength `k`. */
function escapeOffset(
  e: Escape,
  input: FlightInput,
  flight: FlightState,
  axis: number,
  k: number,
): { pitch: number; turn: number } {
  if (!e.level) return { pitch: e.pitch * k, turn: e.turn * k };
  const want = followTurn(flight, wrapAngle(axis + e.axisTurn));
  return { pitch: 0, turn: clamp(want - input.turn, -k, k) };
}

/** What the HUD says: PULL UP for the ground (or a climb-out), BREAK
 * LEFT/RIGHT for a wall a turn escapes. */
export type ProximityCue = "pull-up" | "break-left" | "break-right";

export interface AvoidanceState {
  /** Applied (eased) assist, added to the command's pitch/turn axes. */
  pitch: number;
  turn: number;
  /** Index into ESCAPES last chosen, or −1 — kept while it still clears,
   * so the assist never flips sides between two equally clear escapes. */
  escape: number;
  /** The street axis being followed (a multiple of π/2), or null. */
  axis: number | null;
  /** Seconds the warning stays up once the path clears (WARN_HOLD_S). */
  warnHold: number;
  /** Seconds the raw warning has been continuously up. */
  warnUp: number;
  /** The cue held through warnHold. */
  cue: ProximityCue | null;
}

/** Fresh, idle assist (spawn / death). */
export function createAvoidance(): AvoidanceState {
  return {
    pitch: 0,
    turn: 0,
    escape: -1,
    axis: null,
    warnHold: 0,
    warnUp: 0,
    cue: null,
  };
}

export interface AvoidanceStep {
  state: AvoidanceState;
  /** Predicted seconds to impact when neither the held nor the relaxed
   * command clears (within ASSIST_S), or null when the player is safe. */
  impactIn: number | null;
  /** The warning is up: show the cue and sound the tone. */
  warning: boolean;
  /** What the HUD shows while warning, else null. */
  cue: ProximityCue | null;
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

/**
 * Advance one frame. `input` is the command the plane would otherwise fly
 * (instructor, free-look and zoom authority already applied).
 *
 * The threat is the LATER impact of the held and relaxed paths (none if
 * either clears). A wall threat the player escapes by letting go and
 * nudging along the street (half the cap) is dodgeable, not imminent — no
 * alarm and no help, which is what keeps a canyon weave quiet. For an
 * imminent threat:
 * - assist: within ASSIST_S, escapes are tried at the full ASSIST_CAP in
 *   order — for a wall the level, street-following ones first, so the assist
 *   never climbs while a level escape clears; for the ground only the
 *   pull-ups — and the first that clears wins (the previous choice while it
 *   still clears); failing that the one that hits latest, and only if it
 *   beats doing nothing. Strength grows with urgency and is eased in and out.
 * - warning: within WARN_S of the ground (or a roof), or WALL_WARN_S of a
 *   wall.
 * `enabled` false still reports the warning and its cue (the player toggled
 * the help, not the alarm).
 */
export function stepAvoidance(
  s: AvoidanceState,
  input: FlightInput,
  flight: FlightState,
  world: ProximityWorld,
  dt: number,
  enabled = true,
): AvoidanceStep {
  const axis = nearestAxis(flight.yaw, s.axis);
  const held = predictImpact(flight, input, world, ASSIST_S);
  const loose = held && predictImpact(flight, relaxed(input), world, ASSIST_S);
  const threat = held && loose ? (loose.t >= held.t ? loose : held) : null;

  // A wall the player escapes by letting go and nudging along the street is
  // not imminent: no alarm, no help (the canyon-weave case).
  const dodgeable =
    threat?.kind === "wall" &&
    predictImpact(
      flight,
      following(relaxed(input), axis, ASSIST_CAP / 2),
      world,
      ESCAPE_HORIZON_S,
    ) === null;
  const imminent = threat !== null && !dodgeable;
  const warn =
    imminent && threat.t <= (threat.kind === "ground" ? WARN_S : WALL_WARN_S);

  let target = { pitch: 0, turn: 0 };
  let chosen = -1;
  let cue: ProximityCue | null = null;
  if (imminent && (enabled || warn)) {
    const order = threat.kind === "wall" ? WALL_ORDER : GROUND_ORDER;
    const hit = new Map<number, number>();
    const tryEscape = (i: number): number => {
      const known = hit.get(i);
      if (known !== undefined) return known;
      const e = ESCAPES[i];
      const t = !e
        ? 0
        : (predictImpact(
            flight,
            escapePilot(e, input, axis, ASSIST_CAP),
            world,
            ESCAPE_HORIZON_S,
          )?.t ?? Number.POSITIVE_INFINITY);
      hit.set(i, t);
      return t;
    };
    const clears = (i: number) => tryEscape(i) === Number.POSITIVE_INFINITY;
    const first = order.find(clears);
    if (first !== undefined) {
      // Keep the previous choice while it clears — unless it climbs and a
      // level escape has opened up.
      const prev = ESCAPES[s.escape];
      const same = prev && prev.level === ESCAPES[first]?.level;
      chosen =
        same && order.includes(s.escape) && clears(s.escape) ? s.escape : first;
    } else {
      let best = threat.t;
      for (const i of order) {
        if (tryEscape(i) > best) {
          best = tryEscape(i);
          chosen = i;
        }
      }
    }
    const urgency = clamp(
      (ASSIST_S - threat.t) / (ASSIST_S - ASSIST_FULL_S),
      0,
      1,
    );
    const k = ASSIST_CAP * (ASSIST_FLOOR + (1 - ASSIST_FLOOR) * urgency);
    const e = ESCAPES[chosen];
    if (e && enabled) target = escapeOffset(e, input, flight, axis, k);
    if (warn) cue = cueFor(threat.kind, e, input, flight, axis, s.cue, hit);
  }
  const blend = 1 - Math.exp(-dt / ASSIST_EASE_S);
  const warnUp = warn ? s.warnUp + dt : 0;
  const warnHold = warn
    ? Math.min(WARN_HOLD_S, warnUp)
    : Math.max(0, s.warnHold - dt);
  const state: AvoidanceState = {
    pitch: ease(s.pitch, target.pitch, blend),
    turn: ease(s.turn, target.turn, blend),
    escape: chosen,
    axis,
    warnHold,
    warnUp,
    cue: warn ? cue : warnHold > 0 ? s.cue : null,
  };
  const warning = warn || warnHold > 0;
  return {
    state,
    impactIn: threat?.t ?? null,
    warning,
    cue: warning ? state.cue : null,
    input: enabled ? withEscape(input, state, 1) : input,
  };
}

/** The cue for a warning: PULL UP for the ground or a climb-out; for a wall,
 * BREAK toward the level escape's turn (the chosen one, else the level one
 * that hits latest). A dead-level turn keeps the last direction. */
function cueFor(
  kind: ImpactKind,
  chosen: Escape | undefined,
  input: FlightInput,
  flight: FlightState,
  axis: number,
  prev: ProximityCue | null,
  hit: ReadonlyMap<number, number>,
): ProximityCue {
  if (kind === "ground" || (chosen && !chosen.level)) return "pull-up";
  let e: Escape | undefined = chosen;
  if (!e) {
    let best = Number.NEGATIVE_INFINITY;
    for (const i of [0, 1, 2]) {
      const t = hit.get(i) ?? Number.NEGATIVE_INFINITY;
      if (t > best) {
        best = t;
        e = ESCAPES[i];
      }
    }
  }
  if (!e) return "pull-up";
  const turn = escapeOffset(e, input, flight, axis, 1).turn;
  if (turn > SNAP) return "break-right";
  if (turn < -SNAP) return "break-left";
  return prev === "break-right" ? "break-right" : "break-left";
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
