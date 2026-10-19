// FC1 collision assist — the pure seam. A subtle nudge off a near-certain
// head-on impact with a building or an airship: each frame the path the
// plane is ACTUALLY flying (its measured turn and climb rates, held for the
// look-ahead) is swept against the solids; if it meets one inside the
// tuning's collisionHorizon, the smallest change of turn and pull that
// clears (or, failing that, meets the solid latest) is eased in, weighted by
// how close the hit is and never past the tuning's collisionStrength. It
// never picks a change whose path hits sooner than the one already flown,
// so it can't steer into a wall; with no better path it stays silent.
//
// Where it sits next to F9 (effortless.ts): the F9 guard flies the pilot's
// COMMAND ahead against the static city only, and only with Flight assist
// on. This one reads the flown path, sees the movers too — the Z1/K1
// airships cruising the avenues, at the clock they are drawn on — and has
// its own switch (Settings › COLLISION ASSIST, and the Flight Lab's).
//
// CLIENT-ONLY input shaping: the output is stick units (classic / touch /
// keys: added to the command) or an aim-error bias the mouse-aim
// instructor's own loop flies (instructorErrorFor, as effortlessError does)
// — an ordinary FlightInput either way, so the wire, common/ and the
// server's clamps never see it. Off, everything here is the exact identity.
// Allocation-free: probes write module scratch.

import type { Building } from "@angels-bandits/common/city";
import {
  type CityIndex,
  type NatureIndex,
  collideCity,
  collideNature,
} from "@angels-bandits/common/collision";
import { PLAYER_RADIUS } from "@angels-bandits/common/constants";
import { type FlightState, realRoll } from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import { type InstructorTuning, instructorErrorFor } from "./instructor";
import { tuning } from "./tuning";

const DEG = Math.PI / 180;
/** Probe sphere, m: the plane's own sphere plus half a metre of air. */
const RADIUS = PLAYER_RADIUS + 0.5;
/** Path sample spacing, m (< 2 × RADIUS: the spheres overlap). */
const SAMPLE_M = 4;
/** A hit this close (s) gets the full nudge; at the horizon, none. */
const FULL_S = 0.4;
/** Stand down past this much real roll or pitch, rad: aerobatics, where the
 * flown-path model (heading and climb rates) no longer describes a turn. */
const MAX_ROLL = 50 * DEG;
const MAX_PITCH = 60 * DEG;
/** The path's climb is held inside this, rad (a pull doesn't go over). */
const PATH_PITCH_MAX = 70 * DEG;
/** Nudge build-up and release rates, stick units per second. */
const RISE = 4;
const FALL = 2;
/** Changes tried, (turn, pull) stick pairs, smallest first: either way, a
 * pull, both, then harder. */
const CANDIDATES = [
  0.35, 0, -0.35, 0, 0, 0.35, 0.35, 0.35, -0.35, 0.35, 0.7, 0, -0.7, 0, 0, 0.7,
  0.7, 0.5, -0.7, 0.5, 1, 0, -1, 0, 0, 1, 1, 0.6, -1, 0.6,
];

export interface CollisionAssist {
  /** The nudge, stick units (+turn right, +pitch nose up). */
  turn: number;
  pitch: number;
  /** Seconds to impact on the flown path, Infinity for none (or off). */
  tHit: number;
  /** Last frame's heading / climb, for the measured rates. */
  prevYaw: number;
  prevPitch: number;
  primed: boolean;
}

export function createCollisionAssist(): CollisionAssist {
  return {
    turn: 0,
    pitch: 0,
    tHit: Number.POSITIVE_INFINITY,
    prevYaw: 0,
    prevPitch: 0,
    primed: false,
  };
}

/** A fresh start (spawn, death, a manoeuvre's end). */
export function resetCollisionAssist(s: CollisionAssist): void {
  s.turn = 0;
  s.pitch = 0;
  s.tHit = Number.POSITIVE_INFINITY;
  s.primed = false;
}

/** The solids it sweeps: the crash check's static city, and anything that
 * moves (main: collideMovers at `timeMs`; the airships among them). */
export interface CollisionAssistWorld {
  buildings: readonly Building[];
  index?: CityIndex;
  nature?: NatureIndex;
  /** True when a sphere at `pos` of `radius` touches a mover at `timeMs`. */
  moving?: (pos: Vec3, radius: number, timeMs: number) => boolean;
}

/** Whether the assist runs: the player's setting and the tuning's switch. */
export function collisionAssistOn(setting: boolean): boolean {
  return setting && tuning.collisionAssist >= 0.5;
}

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

const probe: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Seconds until a plane at `flight`'s position and speed, its heading and
 * climb changing at `yawRate` / `pitchRate` rad/s, first touches a solid —
 * Infinity inside `horizon`. `timeMs` is the movers' clock (null: none).
 */
export function pathHit(
  world: CollisionAssistWorld,
  flight: Pick<FlightState, "pos" | "yaw" | "pitch" | "speed">,
  yawRate: number,
  pitchRate: number,
  horizon: number,
  timeMs: number | null,
): number {
  const v = Math.max(1, flight.speed);
  const dt = SAMPLE_M / v;
  let x = flight.pos.x;
  let y = flight.pos.y;
  let z = flight.pos.z;
  for (let t = dt; t <= horizon + 1e-9; t += dt) {
    // Midpoint heading over the step: the arc, not its tangent.
    const yaw = flight.yaw + yawRate * (t - dt / 2);
    const pitch = clamp(
      flight.pitch + pitchRate * (t - dt / 2),
      -PATH_PITCH_MAX,
      PATH_PITCH_MAX,
    );
    const cp = Math.cos(pitch);
    x += -Math.sin(yaw) * cp * SAMPLE_M;
    y += Math.sin(pitch) * SAMPLE_M;
    z += -Math.cos(yaw) * cp * SAMPLE_M;
    probe.x = x;
    probe.y = y;
    probe.z = z;
    if (
      collideCity(probe, RADIUS, world.buildings, world.index) !== null ||
      (world.nature !== undefined &&
        collideNature(probe, RADIUS, world.nature) !== null) ||
      (timeMs !== null &&
        world.moving !== undefined &&
        world.moving(probe, RADIUS, timeMs + t * 1000))
    ) {
      return t;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Advance one frame. `enabled` is collisionAssistOn(setting); off, the
 * state is reset and the nudge is exactly zero. `rates` are stepFlight's
 * full-deflection rates this frame (handlingRates). `standDown`: threading a
 * hole or a bore (H2/H3 own that line), the settings autopilot, a death.
 * `last` is the command stepFlight flew last frame (stick units): a change
 * is only worth what the stick has left — a turn already at full deflection
 * can't be turned harder, so that candidate's path is the one flown.
 */
export function stepCollisionAssist(
  s: CollisionAssist,
  flight: FlightState,
  world: CollisionAssistWorld,
  timeMs: number | null,
  enabled: boolean,
  standDown: boolean,
  rates: { turnRate: number; pitchRate: number },
  last: { turn: number; pitch: number },
  dt: number,
): void {
  if (!enabled) {
    resetCollisionAssist(s);
    return;
  }
  const yawRate =
    s.primed && dt > 0 ? wrapAngle(flight.yaw - s.prevYaw) / dt : 0;
  const pitchRate = s.primed && dt > 0 ? (flight.pitch - s.prevPitch) / dt : 0;
  s.prevYaw = flight.yaw;
  s.prevPitch = flight.pitch;
  s.primed = true;
  const roll = realRoll(flight);
  let wantTurn = 0;
  let wantPitch = 0;
  s.tHit = Number.POSITIVE_INFINITY;
  if (
    !standDown &&
    Math.abs(roll) < MAX_ROLL &&
    Math.abs(flight.pitch) < MAX_PITCH
  ) {
    const horizon = tuning.collisionHorizon;
    const tHit = pathHit(world, flight, yawRate, pitchRate, horizon, timeMs);
    s.tHit = tHit;
    if (tHit < horizon) {
      // What a stick change does to the flown path, upright to a 50° bank:
      // the turn swings the heading about world-up (+turn right lowers
      // yaw), the pull lifts the nose by cos(bank) and turns it toward the
      // low wing by sin(bank) (+roll = left wing down: yaw rises).
      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      let best = tHit;
      let pick = -1;
      for (let i = 0; i < CANDIDATES.length && best < horizon; i += 2) {
        const dTurn =
          clamp(last.turn + (CANDIDATES[i] as number), -1, 1) - last.turn;
        const dPull =
          clamp(last.pitch + (CANDIDATES[i + 1] as number), -1, 1) - last.pitch;
        const t = pathHit(
          world,
          flight,
          yawRate - dTurn * rates.turnRate * cr + dPull * rates.pitchRate * sr,
          pitchRate + dPull * rates.pitchRate * cr,
          horizon,
          timeMs,
        );
        if (t > best) {
          best = t;
          pick = i;
        }
      }
      if (pick >= 0) {
        const urgency = clamp((horizon - tHit) / (horizon - FULL_S), 0, 1);
        const cap = tuning.collisionStrength;
        wantTurn = clamp((CANDIDATES[pick] as number) * urgency, -cap, cap);
        wantPitch = clamp(
          (CANDIDATES[pick + 1] as number) * urgency,
          -cap,
          cap,
        );
      }
    }
  }
  s.turn = approach(s.turn, wantTurn, dt);
  s.pitch = approach(s.pitch, wantPitch, dt);
}

/** `v` toward `want`, at RISE away from zero and FALL back toward it. */
function approach(v: number, want: number, dt: number): number {
  const rate = Math.abs(want) > Math.abs(v) ? RISE : FALL;
  const step = rate * dt;
  return want > v ? Math.min(want, v + step) : Math.max(want, v - step);
}

/** Whether a nudge is being applied this frame. */
export function collisionAssistActive(s: CollisionAssist): boolean {
  return s.turn !== 0 || s.pitch !== 0;
}

/** Stick schemes: the nudge added to `cmd` in place (identity at zero). */
export function collisionAssistStick(
  s: CollisionAssist,
  cmd: { turn: number; pitch: number },
): void {
  if (s.turn !== 0) cmd.turn = clamp(cmd.turn + s.turn, -1, 1);
  if (s.pitch !== 0) cmd.pitch = clamp(cmd.pitch + s.pitch, -1, 1);
}

/**
 * Mouse-aim: the nudge as an aim-error bias (rad) into `err` in place, so
 * the instructor's loop flies it rather than fighting it — the inverse of
 * its command law at this feel, exactly as effortlessError's (turn =
 * −rate(yaw)/turnRate; pitch = rate(pitch)/pitchRate). Identity at zero.
 */
export function collisionAssistError(
  s: CollisionAssist,
  feel: Readonly<InstructorTuning>,
  rates: { turnRate: number; pitchRate: number },
  err: { yaw: number; pitch: number },
): void {
  if (s.turn !== 0)
    err.yaw -= instructorErrorFor(s.turn * rates.turnRate, feel);
  if (s.pitch !== 0) {
    err.pitch += instructorErrorFor(s.pitch * rates.pitchRate, feel);
  }
}
