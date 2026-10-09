// Effortless assist (F9) — the pure seam. Controls anyone can pick up in
// seconds: one per-frame step reads the pilot's activity and the plane's
// pose and says how to shape this frame's command. CLIENT-ONLY input
// shaping — its output only ever becomes an ordinary FlightInput, so the
// wire, common/ and the server's validation never see it. Same shape as
// hole-assist.ts: main.ts is the thin adapter, and the tests (the novice
// pilot included) drive these very functions.
//
// Each part stands down where it would fight an intent:
// - Auto-level. Once the pilot has let go (no activity for IDLE_S with the
//   aim settled on the pipper) a weight ramps in that rolls the wings level
//   — upright, inverted included — and, where "let go" means no aim at all
//   (a stick at centre, the pointer gone, a lifted thumb), eases the nose to
//   the horizon. Idle LATCHES until the pilot acts again, so the gap its own
//   bias opens can never toggle it. A still cursor on the desktop
//   instructor is a command (a held climb), so there only the wings level.
// - Coordinated turns. The turn input already leans the plane (the shared
//   bank spring, flight.ts). With assist on a real roll — A/D — turns it
//   too, the way it is banked: one input, bank and turn together.
// - Ground floor. A dive the pull-up radius can no longer recover from at
//   this height (over a U4 bore, its floor's) gets a pull and loses its
//   nose-down authority. Input is
//   never overridden unless the trajectory would meet the ground, so a loop
//   or split-S flown with height to spare is untouched.
// - Soft walls. A building across where the pilot is aiming bends the aim
//   to the nearest clear direction round it (or over it): the pilot still
//   flies at their mark, the line just goes round the corner. Behind that,
//   a guard flies the pilot's own command ahead through the real flight
//   model and, if it meets a solid, takes the smallest change that clears.
//   Both stand down while threading a hole or a U4 bore (H2/H3 own that).
// - The F5 corner manager plans as much turn as the pilot is aiming
//   (arcSweep) instead of always a right-angle street corner.
// Feel presets ride along: the instructor's loop shape and the stick's
// authority (Relaxed / Normal / Sharp — Sharp is today's loop exactly).
//
// Measured in client/test/novice-pilot.test.ts: a novice with a 0.25 s
// hand delay and tremor crashes ~90% less and reaches waypoints ~20%
// sooner than on main's tuning.
//
// Units: `turn`/`pitch`/`biasTurn`/`biasPitch` are stick units, stepFlight's
// [-1, 1] (+turn right, +pitch nose up as the airframe sees it); aimYaw/
// aimPitch are rad of aim error. Allocation-free apart from the guard's
// stepFlight rollout (as hole-save's): everything else writes into
// caller-owned objects.

import type { Building } from "@angels-bandits/common/city";
import { minAltitude } from "@angels-bandits/common/city/river";
import {
  groundFloor,
  tunnelAt,
  tunnelOpen,
} from "@angels-bandits/common/city/tunnels";
import {
  type CityIndex,
  type NatureIndex,
  collideCity,
  collideNature,
  hitsGround,
} from "@angels-bandits/common/collision";
import { BANK_ANGLE, PLAYER_RADIUS } from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  realRoll,
  stepFlight,
} from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import {
  type InstructorTuning,
  SHARP_TUNING,
  instructorErrorFor,
  instructorRate,
} from "./instructor";

const DEG = Math.PI / 180;

// --- Feel presets -----------------------------------------------------------

export type Feel = "relaxed" | "normal" | "sharp";
export const FEELS: readonly Feel[] = ["relaxed", "normal", "sharp"];

export interface FeelTuning extends InstructorTuning {
  /** Classic/touch stick authority: the stick's share of the full rates. */
  stick: number;
}

/**
 * The instructor's loop shape and the stick's authority per feel. Sharp is
 * today's loop exactly. Normal keeps a crisp slope at the aim (a 15°/s
 * crossing bandit held within ~2°) but flies a big re-aim at a gentler
 * slope past 2° — a hand that reacts late can't whip it into a wobble, and
 * the F5 manager isn't asked for a hard turn at every small re-aim. Tuned
 * on the novice pilot; Relaxed is gentler still.
 */
export const FEEL_TUNING: Readonly<Record<Feel, Readonly<FeelTuning>>> = {
  relaxed: { gain: 6, band: 2 * DEG, steer: 2.5, stick: 0.7 },
  normal: { gain: 8, band: 2 * DEG, steer: 3.5, stick: 0.85 },
  sharp: { gain: SHARP_TUNING.gain, stick: 1 },
};

// --- Tunables ---------------------------------------------------------------

/** The hole assist (and the soft walls) stand down past this much real
 * roll, rad (~30°, F7): their nudges are world heading/elevation biases. */
export const ASSIST_MAX_ROLL = Math.PI / 6;
/** No pilot activity for this long, s, before auto-level may take over… */
export const IDLE_S = 0.3;
/** …and only with the aim settled within this of the pipper, rad. */
export const IDLE_GAP = 3 * DEG;
/** Auto-level weight ramp in / drop out, s (no hard cut either way). */
const IDLE_RAMP_S = 0.35;
const IDLE_DROP_S = 0.1;
/** Nose-to-horizon rate per rad of pitch, 1/s, and its stick cap. */
const LEVEL_PITCH_RATE = 3;
const LEVEL_PITCH_MAX = 0.6;
/** Roll-level stick per rad of real roll (full stick past ~30°). */
const LEVEL_ROLL_GAIN = 2;
/** Real roll at which A/D's coordinated turn is full stick (the shared
 * lean's own full bank), and where it fades out toward knife-edge. */
const COORD_FULL = BANK_ANGLE;
const COORD_FADE_START = 75 * DEG;
const COORD_FADE_END = 90 * DEG;
/** Ground floor: the predicted bottom of the dive must stay this far over
 * the ground, m; a full pull is reached FLOOR_BAND under that. */
export const FLOOR_MARGIN = 10;
const FLOOR_BAND = 12;
/** Reaction allowance before the pull-up bites, s. */
const FLOOR_REACT_S = 0.15;
/** Nose-down authority fades to nothing over this much predicted bottom
 * above FLOOR_MARGIN, m. */
const FLOOR_SOFT_BAND = 30;
/** Aim deflection: the aim ray's length = speed × AIM_LOOK_S, clamped, m;
 * samples along it; the weight reaches 1 at AIM_GAIN × closeness = 1; and
 * the corrections tried, smallest first, rad. */
const AIM_LOOK_S = 1;
const AIM_LOOK_MIN = 40;
const AIM_LOOK_MAX = 100;
const AIM_SAMPLES = 12;
const AIM_GAIN = 2;
const AIM_ESCAPES = [10 * DEG, 20 * DEG, 35 * DEG, 55 * DEG];
/** Probe sphere, m — the corner manager's (plane plus a little air). */
const AIM_PROBE_RADIUS = PLAYER_RADIUS + 1.5;
/** Aim deflection stands down past this |pitch|, rad (aerobatics). */
const AIM_MAX_PITCH = 45 * DEG;
/** Guard: how far ahead the pilot's command is flown, s; the rollout step,
 * s; the hit time from which its correction is at full weight, s; and the
 * plane's sphere plus a metre of air, m. */
const GUARD_HORIZON = 1.5;
const GUARD_STEP = 0.1;
const GUARD_FULL = 0.6;
const GUARD_RADIUS = PLAYER_RADIUS + 1;
/** Command changes the guard tries, (turn, pull) pairs in stick units,
 * smallest first: either way, a pull, both, then hard over. */
const GUARD_CANDIDATES = [
  0.5, 0, -0.5, 0, 0, 0.5, 1, 0, -1, 0, 0, 1, 0.7, 0.7, -0.7, 0.7, 2, 0, -2, 0,
  2, 1, -2, 1,
];
/** U4 stand-down: how far ahead the nose is checked for a bore's open
 * volume, m, in how many samples. */
const BORE_AHEAD = 120;
const BORE_SAMPLES = 6;
/** arcSweep: the F5 arc is the aim's offset plus ARC_MARGIN, in
 * [ARC_MIN, ARC_MAX]; past ARC_EDGE (a cursor out toward the screen's
 * edge: "round, and more than I can see") the full corner. */
const ARC_MIN = 25 * DEG;
const ARC_MAX = 90 * DEG;
const ARC_MARGIN = 15 * DEG;
const ARC_EDGE = 40 * DEG;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Wrap an angle to (−π, π]. */
const wrapAngle = (a: number): number => {
  if (a > -Math.PI && a <= Math.PI) return a;
  const w = Math.atan2(Math.sin(a), Math.cos(a));
  return w === -Math.PI ? Math.PI : w;
};

// --- State ------------------------------------------------------------------

export interface EffortlessState {
  /** Seconds since the pilot last acted. */
  quiet: number;
  /** Latched: the pilot has let go (until the next activity). */
  idle: boolean;
  /** Auto-level weight, 0..1. */
  weight: number;
  /** The guard's escape last frame (an index into GUARD_CANDIDATES), −1
   * for none. */
  guard: number;
}

export function createEffortless(): EffortlessState {
  return { quiet: 0, idle: false, weight: 0, guard: -1 };
}

/** A fresh start (spawn, death, M toggle, the settings panel). */
export function resetEffortless(s: EffortlessState): void {
  s.quiet = 0;
  s.idle = false;
  s.weight = 0;
  s.guard = -1;
}

/** The static solids the soft walls probe (the crash check's). */
export interface EffortlessWorld {
  buildings: readonly Building[];
  index?: CityIndex;
  nature?: NatureIndex;
}

/** One frame's view of the pilot. */
export interface EffortlessFrame {
  /** The assist setting. Off ⇒ the output is the identity. */
  enabled: boolean;
  /** The pilot acted this frame: the mouse moved, a thumb is on the aim
   * zone, the stick is out of its deadzone, or A/D is held. */
  active: boolean;
  /** Pipper-to-cursor gap, rad (0 for a stick). Gates idle ENTRY only. */
  gap: number;
  /** Idle may level the nose too, not only the wings: a stick, the
   * instructor with the pointer gone, or a lifted thumb. */
  levelPitch: boolean;
  /** The guns are firing: auto-level waits. */
  firing: boolean;
  /** Threading a hole (hole assist or save engaged, or in a corridor): the
   * soft walls stand down. */
  threading: boolean;
  /** The pilot's own command this frame, assist excluded, and the corner
   * cap as stepFlight will get it — what the guard flies ahead. */
  pilotTurn: number;
  pilotPitch: number;
  cornerCap: number | undefined;
  /** Where the pilot is aiming, unit, world (the instructor's cursor, from
   * the plane); null = along the nose (a stick). */
  aim: Vec3 | null;
  /** stepFlight's full-deflection rates this frame (handlingRates). */
  turnRate: number;
  pitchRate: number;
}

/** How to shape this frame's command. */
export interface EffortlessOut {
  /** Safety corrections (guard, ground floor): stick units added AFTER
   * the instructor, so a saturated loop can't swallow them. */
  turn: number;
  pitch: number;
  /** Gentle biases (coordinated turn, auto-level pitch): stick units the
   * instructor takes as an aim-error bias, so its own loop flies them. */
  biasTurn: number;
  biasPitch: number;
  /** Aim deflection round a wall, rad of aim error: + yaw = left (yaw's
   * own sign), + pitch = up. */
  aimYaw: number;
  aimPitch: number;
  /** Auto-level's roll command — applied only while A/D is idle. */
  roll: number;
  /** Multiplier (≤ 1) for nose-down pitch near the ground. */
  softDown: number;
}

export function createEffortlessOut(): EffortlessOut {
  return {
    turn: 0,
    pitch: 0,
    biasTurn: 0,
    biasPitch: 0,
    aimYaw: 0,
    aimPitch: 0,
    roll: 0,
    softDown: 1,
  };
}

function identity(out: EffortlessOut): EffortlessOut {
  out.turn = 0;
  out.pitch = 0;
  out.biasTurn = 0;
  out.biasPitch = 0;
  out.aimYaw = 0;
  out.aimPitch = 0;
  out.roll = 0;
  out.softDown = 1;
  return out;
}

/**
 * Advance one frame and write the shaping into `out` (returned). `world`
 * null skips the soft walls (no city loaded, or a test without one).
 */
export function stepEffortless(
  s: EffortlessState,
  flight: FlightState,
  frame: EffortlessFrame,
  world: EffortlessWorld | null,
  dt: number,
  out: EffortlessOut,
): EffortlessOut {
  identity(out);
  if (!frame.enabled) {
    resetEffortless(s);
    return out;
  }

  // Idle: entered after IDLE_S quiet with the aim settled, then latched
  // until the pilot acts again.
  if (frame.active) {
    s.quiet = 0;
    s.idle = false;
  } else {
    s.quiet += dt;
    if (!s.idle && s.quiet >= IDLE_S && frame.gap < IDLE_GAP) s.idle = true;
  }
  const want = s.idle && !frame.firing ? 1 : 0;
  s.weight =
    want > s.weight
      ? Math.min(want, s.weight + dt / IDLE_RAMP_S)
      : Math.max(want, s.weight - dt / IDLE_DROP_S);

  const r = realRoll(flight);
  const ar = Math.abs(r);
  const cr = Math.cos(r);

  // Auto-level: wings upright the short way (exactly inverted rolls
  // right), and where "let go" means no aim at all the nose to the horizon
  // — signed by cos(roll), since pitch moves the nose toward the plane's
  // own up. At vertical "level" has no direction: the pitch half brings
  // the nose down first and the roll eases in with cos(pitch).
  const w = s.weight;
  if (w > 0) {
    out.roll = clamp(-r * LEVEL_ROLL_GAIN, -1, 1) * w * Math.cos(flight.pitch);
    if (frame.levelPitch) {
      out.biasPitch =
        clamp(
          (-flight.pitch * LEVEL_PITCH_RATE) / frame.pitchRate,
          -LEVEL_PITCH_MAX,
          LEVEL_PITCH_MAX,
        ) *
        cr *
        w;
    }
  }

  // Coordinated: a banked airframe turns the way it is banked (+roll is
  // left wing down — a left turn, i.e. −turn). Fades out toward knife-edge
  // and is off past it (inverted, the turn input is already reversed).
  if (ar > 0 && ar < COORD_FADE_END) {
    const fade = clamp(
      (COORD_FADE_END - ar) / (COORD_FADE_END - COORD_FADE_START),
      0,
      1,
    );
    out.biasTurn = clamp(-Math.sin(r) / Math.sin(COORD_FULL), -1, 1) * fade;
  }

  // Ground floor (upright only: inverted, a pull heads for the ground —
  // the guard below handles that one).
  if (cr > 0) {
    const v = flight.speed;
    const dive = Math.max(0, -flight.pitch);
    const drop =
      (v / frame.pitchRate) * (1 - Math.cos(dive)) +
      v * Math.sin(dive) * FLOOR_REACT_S;
    // The lowest legal altitude here — the server's own pose clamp: the
    // water over the L11 channel, a U4 bore's floor over its footprint (a
    // ramp is flown down into) — so the floor never fights a dive into the
    // river or a tunnel; the guard below sees the real ramps and walls.
    const ground = groundFloor(
      flight.pos.x,
      flight.pos.z,
      minAltitude(flight.pos.z),
    );
    const bottom = flight.pos.y - drop - ground;
    const need = FLOOR_MARGIN - bottom;
    if (need > 0) out.pitch += clamp(need / FLOOR_BAND, 0, 1) * cr;
    out.softDown = clamp((bottom - FLOOR_MARGIN) / FLOOR_SOFT_BAND, 0, 1);
  }

  if (world === null || frame.threading || boreAhead(flight, frame.aim)) {
    s.guard = -1;
    return out;
  }

  // Soft walls, 1: a solid across where the pilot is aiming bends the aim
  // to the nearest clear direction round it — the aim's own side of the
  // nose first, then the other, then over the top — weighted by how close
  // it is. A hole's mouth is air, so an aim a few degrees off a hole finds
  // the hole itself.
  if (Math.abs(flight.pitch) < AIM_MAX_PITCH && ar < ASSIST_MAX_ROLL) {
    const { pos, yaw, pitch } = flight;
    const aim = frame.aim;
    const ay = aim === null ? yaw : Math.atan2(-aim.x, -aim.z);
    const ap =
      aim === null ? pitch : Math.atan2(aim.y, Math.hypot(aim.x, aim.z));
    const look = clamp(flight.speed * AIM_LOOK_S, AIM_LOOK_MIN, AIM_LOOK_MAX);
    const near = closeness(world, pos, ay, ap, look);
    if (near > 0) {
      const weight = clamp(near * AIM_GAIN, 0, 1);
      const off = wrapAngle(ay - yaw);
      const side = off > 0 ? 1 : off < 0 ? -1 : frame.pilotTurn > 0 ? -1 : 1;
      let best = near;
      for (let i = 0; i < AIM_ESCAPES.length && best > 0; i++) {
        const e = AIM_ESCAPES[i] as number;
        for (let c = 0; c < 3 && best > 0; c++) {
          const dy = c === 2 ? 0 : (c === 0 ? side : -side) * e;
          const dp = c === 2 ? e : 0;
          const k = closeness(world, pos, ay + dy, ap + dp, look);
          if (k < best) {
            best = k;
            out.aimYaw = dy * weight;
            out.aimPitch = dp * weight;
          }
        }
      }
    }
  }

  // Soft walls, 2 — the guard: fly the pilot's own command ahead through
  // the real flight model; if it meets a solid inside GUARD_HORIZON, take
  // the smallest change that clears (or meets it latest), eased in as the
  // hit draws nearer. Last frame's escape is tried first and kept while it
  // still clears: no search, and no flip-flop between two near-equal ones.
  const tHit = rollout(world, flight, frame, -1, 1);
  if (tHit >= GUARD_HORIZON) {
    s.guard = -1;
    return out;
  }
  const flip = cr >= 0 ? 1 : -1; // a pull is toward the plane's own up
  let pick = -1;
  let best = tHit;
  if (
    s.guard >= 0 &&
    rollout(world, flight, frame, s.guard, flip) >= GUARD_HORIZON
  ) {
    pick = s.guard;
    best = GUARD_HORIZON;
  }
  for (let i = 0; i < GUARD_CANDIDATES.length && best < GUARD_HORIZON; i += 2) {
    const t = rollout(world, flight, frame, i, flip);
    if (t > best) {
      best = t;
      pick = i;
    }
  }
  s.guard = pick;
  if (pick >= 0) {
    const urgency = clamp(
      (GUARD_HORIZON - tHit) / (GUARD_HORIZON - GUARD_FULL),
      0,
      1,
    );
    out.turn += (GUARD_CANDIDATES[pick] as number) * urgency;
    out.pitch += (GUARD_CANDIDATES[pick + 1] as number) * flip * urgency;
  }
  return out;
}

const probe: Vec3 = { x: 0, y: 0, z: 0 };

/** U4: in a bore, or the nose — or the aim — about to enter one's open
 * volume within BORE_AHEAD m: a portal or river mouth is threaded, not a
 * wall to be steered off (the bores are H3's, like a hole: hole-save.ts). */
function boreAhead(flight: FlightState, aim: Vec3 | null): boolean {
  if (tunnelAt(flight.pos) !== null) return true;
  const cp = Math.cos(flight.pitch);
  if (
    rayEntersBore(
      flight.pos,
      -Math.sin(flight.yaw) * cp,
      Math.sin(flight.pitch),
      -Math.cos(flight.yaw) * cp,
    )
  ) {
    return true;
  }
  return aim !== null && rayEntersBore(flight.pos, aim.x, aim.y, aim.z);
}

function rayEntersBore(pos: Vec3, dx: number, dy: number, dz: number): boolean {
  for (let k = 1; k <= BORE_SAMPLES; k++) {
    const d = (BORE_AHEAD * k) / BORE_SAMPLES;
    probe.x = pos.x + dx * d;
    probe.y = pos.y + dy * d;
    probe.z = pos.z + dz * d;
    if (probe.y < 0 && tunnelOpen(probe, PLAYER_RADIUS)) return true;
  }
  return false;
}

/** 1 − (distance to the first solid — the ground and U4's bore walls
 * included — along the ray at `yaw`/`pitch`) / `look`; 0 when the ray is
 * clear. Wrap-safe: the colliders measure via wrapDelta. */
function closeness(
  world: EffortlessWorld,
  pos: Vec3,
  yaw: number,
  pitch: number,
  look: number,
): number {
  const cp = Math.cos(pitch);
  const dx = -Math.sin(yaw) * cp;
  const dy = Math.sin(pitch);
  const dz = -Math.cos(yaw) * cp;
  for (let k = 1; k <= AIM_SAMPLES; k++) {
    const d = (look * k) / AIM_SAMPLES;
    probe.x = pos.x + dx * d;
    probe.y = pos.y + dy * d;
    probe.z = pos.z + dz * d;
    if (
      hitsGround(probe, AIM_PROBE_RADIUS) ||
      collideCity(probe, AIM_PROBE_RADIUS, world.buildings, world.index) !==
        null ||
      (world.nature !== undefined &&
        collideNature(probe, AIM_PROBE_RADIUS, world.nature) !== null)
    ) {
      return 1 - (d - look / AIM_SAMPLES) / look;
    }
  }
  return 0;
}

const guardInput: FlightInput = { turn: 0, pitch: 0, roll: 0, throttle: 1 };

/** Seconds until the plane, flying the pilot's command plus guard
 * candidate `i` (−1: none; its pull signed by `flip`) under the corner cap,
 * first touches the ground, a building or a tree — Infinity inside
 * GUARD_HORIZON. */
function rollout(
  world: EffortlessWorld,
  flight: FlightState,
  frame: EffortlessFrame,
  i: number,
  flip: number,
): number {
  const dTurn = i < 0 ? 0 : (GUARD_CANDIDATES[i] as number);
  const dPull = i < 0 ? 0 : (GUARD_CANDIDATES[i + 1] as number) * flip;
  guardInput.turn = clamp(frame.pilotTurn + dTurn, -1, 1);
  guardInput.pitch = clamp(frame.pilotPitch + dPull, -1, 1);
  guardInput.cornerCap = frame.cornerCap;
  let st = flight;
  for (let t = GUARD_STEP; t <= GUARD_HORIZON + 1e-9; t += GUARD_STEP) {
    st = stepFlight(st, guardInput, GUARD_STEP);
    const p = st.pos;
    if (
      hitsGround(p, GUARD_RADIUS) ||
      collideCity(p, GUARD_RADIUS, world.buildings, world.index) !== null ||
      (world.nature !== undefined &&
        collideNature(p, GUARD_RADIUS, world.nature) !== null)
    ) {
      return t;
    }
  }
  return Number.POSITIVE_INFINITY;
}

// --- Applying it --------------------------------------------------------------

/**
 * The final command (either scheme): nose-down softened near the ground,
 * the safety corrections added, and auto-level's roll handed over while
 * A/D is idle — written into `cmd` in place.
 */
export function effortlessCommand(
  out: EffortlessOut,
  realRollRad: number,
  cmd: { turn: number; pitch: number; roll: number },
): void {
  let pitch = cmd.pitch;
  if (pitch * Math.cos(realRollRad) < 0) pitch *= out.softDown;
  cmd.turn = clamp(cmd.turn + out.turn, -1, 1);
  cmd.pitch = clamp(pitch + out.pitch, -1, 1);
  if (cmd.roll === 0 && out.roll !== 0) cmd.roll = out.roll;
}

/**
 * Classic / touch stick: the pilot's stick at the feel's authority plus
 * every part of the assist — the gentle biases and the aim deflection (the
 * latter through the instructor's own law at this feel), then
 * effortlessCommand. Written into `cmd` in place. With the identity output
 * and Sharp this leaves `cmd` exactly as it was.
 */
export function effortlessStick(
  out: EffortlessOut,
  feel: Readonly<FeelTuning>,
  realRollRad: number,
  turnRate: number,
  pitchRate: number,
  cmd: { turn: number; pitch: number; roll: number },
): void {
  // +aimYaw is left, i.e. −turn.
  cmd.turn =
    cmd.turn * feel.stick +
    out.biasTurn -
    instructorRate(out.aimYaw, feel) / turnRate;
  cmd.pitch =
    cmd.pitch * feel.stick +
    out.biasPitch +
    instructorRate(out.aimPitch, feel) / pitchRate;
  effortlessCommand(out, realRollRad, cmd);
}

/**
 * Instructor: the gentle part of the assist as an aim-error bias (rad),
 * into `err` in place — the instructor's own loop then flies it, so a
 * nudge is never flown straight back out. instructorInput's command law,
 * inverted at this feel (the bias reads as if the aim were settled).
 */
export function effortlessError(
  out: EffortlessOut,
  feel: Readonly<FeelTuning>,
  turnRate: number,
  pitchRate: number,
  err: { yaw: number; pitch: number },
): void {
  // turn = −rate(yaw)/turnRate; pitch = rate(pitch)/pitchRate.
  err.yaw += out.aimYaw - instructorErrorFor(out.biasTurn * turnRate, feel);
  err.pitch +=
    out.aimPitch + instructorErrorFor(out.biasPitch * pitchRate, feel);
}

/**
 * The F5 corner manager's arc (cornerSpeed's `sweep`) with assist on: as
 * much turn as the pilot is aiming off the nose plus ARC_MARGIN — so a
 * pilot pointing 15° off is not braked for a right angle they never asked
 * for — and the full corner for a stick (no aim) or a cursor out toward
 * the screen's edge.
 */
export function arcSweep(
  flight: Pick<FlightState, "yaw">,
  aim: Vec3 | null,
): number {
  if (aim === null) return ARC_MAX;
  const off = Math.abs(wrapAngle(Math.atan2(-aim.x, -aim.z) - flight.yaw));
  if (off > ARC_EDGE) return ARC_MAX;
  return clamp(off + ARC_MARGIN, ARC_MIN, ARC_MAX);
}
