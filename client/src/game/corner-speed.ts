// F5 corner speed manager — the silent auto-throttle that bleeds speed so the
// plane can make the turn. Just steer: approaching a wall, or committing to a
// hard turn toward one, the manager lowers a ceiling on the commanded speed
// (FlightInput.cornerCap) and stepFlight's CORNER_BRAKE_DECEL airbrake does
// the rest; when the way is clear the ceiling lifts and the full throttle
// pulls the plane back up. No HUD, no warning — the engine note is the only
// cue (main.ts feeds it the effective command).
//
// Pure and position-only: cornerSpeed() answers from where the plane is and
// where it points, never from its own airspeed, so the ceiling cannot chatter
// with the speed it causes. stepCornerCap() rate-limits it (falls fast,
// recovers slowly) — that asymmetry is what keeps it from oscillating.
//
// Two probes, both sphere samples against the SAME solids detectCrash uses
// (buildings with their holes cut, solid trees, movers at the latched render
// clock, the L5 viaduct) — but never the ground, so a strafing dive is never
// braked. All positions are wrap-safe: every collider measures through
// wrapDelta, so a probe that runs past the seam needs no canonicalising.
//   1. Wall ahead: march the nose to WALL_HORIZON; a hit at D caps speed to
//      the braking envelope — the fastest speed that can brake (closed form,
//      constant deceleration) and still turn parallel to the wall it hit.
//      Every solid in the city is an axis-aligned box, so which face was hit
//      (and so the incidence angle) falls out of one extra sample: a nose a
//      few degrees off a long avenue only has to cancel those degrees.
//   2. Steering arc (intent): only while the pilot commands a hard turn, the
//      fastest speed whose full-deflection 90° arc from here is clear.
// Inside a hole's clear corridor, aligned with it, probe 2 is skipped and
// probe 1 runs along the hole's axis — threading a hole never slows you.

import type { Building, HoleSpan } from "@angels-bandits/common/city";
import {
  type MoverField,
  collideMovers,
} from "@angels-bandits/common/city/movers";
import { collideTrain } from "@angels-bandits/common/city/train";
import {
  type CityIndex,
  type NatureIndex,
  collideCity,
  collideNature,
} from "@angels-bandits/common/collision";
import {
  CORNER_BRAKE_DECEL,
  MAX_SPEED,
  MIN_SPEED,
  PLAYER_RADIUS,
} from "@angels-bandits/common/constants";
import {
  type FlightState,
  speedForRadius,
  turnRadius,
} from "@angels-bandits/common/flight";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";

/** Probe sphere radius, m: the plane's own sphere plus a little air. */
export const PROBE_RADIUS = PLAYER_RADIUS + 1.5;
/** Spacing of probe samples along a ray or arc, m (< 2 × PROBE_RADIUS, so
 * consecutive spheres overlap and no wall thicker than ~1 m slips between). */
const PROBE_STEP = 6;
/** How far ahead probe 1 looks, m — past the 106 m a 90 m/s plane needs to
 * turn away from a wall without braking at all. */
export const WALL_HORIZON = 220;
/** Clear air kept between the turn-away arc and the wall, m. */
const WALL_MARGIN = 6;
/** Probe 1 only runs this close to level, rad (30°): a steep dive or climb
 * is escaped with the elevator, not the turn the envelope assumes. */
const WALL_PITCH_MAX = Math.PI / 6;
/** The envelope designs for this fraction of the airbrake, so the plane
 * (which brakes at the full CORNER_BRAKE_DECEL) always leads the cap. */
const BRAKE_DESIGN = 0.75;
/** Probe 2 engages at this much commanded turn, |turn| ∈ [0, 1]: a hard
 * turn. Small corrections in a canyon never brake. */
export const ARC_INTENT = 0.5;
/** Probe 2's arc sweep, rad: a full street corner. */
const ARC_SWEEP = Math.PI / 2;
/** Bisection steps between the slowest clear arc and the fastest blocked
 * one — 50 m/s / 2⁴ ≈ 3 m/s of resolution. */
const ARC_BISECT = 4;
/** A hole's corridor runs this far beyond each mouth, m. */
export const CORRIDOR_LEAD = 40;
/** Nose within this of a hole's axis counts as threading it, rad (30°). */
const CORRIDOR_ALIGN = Math.cos(Math.PI / 6);
/** stepCornerCap: how fast the ceiling may fall / recover, m/s². Falling is
 * effectively instant (the airbrake is the smoothing); recovering is slow so
 * a probe that clears for a frame never lets the plane surge. */
export const CAP_FALL_RATE = 250;
export const CAP_RISE_RATE = 12;

/** One hole's clear corridor: the hole's box, extended along its axis. */
export interface HoleCorridor {
  center: Vec3;
  axis: "x" | "z";
  halfLength: number;
  halfWidth: number;
  y0: number;
  y1: number;
}

/** Everything solid the manager probes. Build once; `corridors` from
 * holeCorridors(). `index` must describe `buildings` (collideCity checks). */
export interface CornerWorld {
  buildings: readonly Building[];
  index?: CityIndex;
  nature?: NatureIndex;
  movers?: MoverField;
  corridors: readonly HoleCorridor[];
}

/** Corridors for every hole (cityHoles) and river underpass (bridgeSpans).
 * Built at runtime, so any hole the city grows is covered automatically. */
export function holeCorridors(spans: readonly HoleSpan[]): HoleCorridor[] {
  return spans.map((s) => ({
    center: s.center,
    axis: s.hole.axis,
    halfLength: s.length / 2 + CORRIDOR_LEAD,
    halfWidth: s.hole.width / 2,
    y0: s.hole.y0,
    y1: s.hole.y0 + s.hole.height,
  }));
}

// Scratch sample — the colliders read it and never keep it, so one object
// serves every probe (no per-frame allocation in the march itself).
const probe: Vec3 = { x: 0, y: 0, z: 0 };

/** Does a PROBE_RADIUS sphere at `probe` touch anything the plane can hit? */
function blocked(world: CornerWorld, timeMs: number | null): boolean {
  if (collideCity(probe, PROBE_RADIUS, world.buildings, world.index) !== null)
    return true;
  if (world.nature && collideNature(probe, PROBE_RADIUS, world.nature) !== null)
    return true;
  const movers = world.movers;
  if (!movers) return false;
  // detectCrash's clock rules: no clock ⇒ only the static viaduct is drawn.
  if (timeMs === null) {
    return (
      !!movers.train &&
      collideTrain(movers.train, probe, PROBE_RADIUS, null) !== null
    );
  }
  return collideMovers(probe, PROBE_RADIUS, movers, timeMs) !== null;
}

/**
 * Probe 1 for one ray from `pos` along unit (dx, dy, dz): MAX_SPEED when the
 * first `horizon` meters are clear, else wallEnvelope at the hit with the
 * incidence of the face it hit. The face comes from one extra sample: if the
 * last clear point moved only along z is already blocked, the z step crossed
 * the face, so it is a z-normal wall — and the plane's angle to it is the
 * angle between the nose and the x axis.
 */
function rayCap(
  world: CornerWorld,
  pos: Vec3,
  dx: number,
  dy: number,
  dz: number,
  horizon: number,
  timeMs: number | null,
): number {
  for (let s = PROBE_STEP; s <= horizon; s += PROBE_STEP) {
    probe.x = pos.x + dx * s;
    probe.y = pos.y + dy * s;
    probe.z = pos.z + dz * s;
    if (!blocked(world, timeMs)) continue;
    const clear = s - PROBE_STEP;
    // Hit: back x up to the last clear sample, keep z where it hit.
    probe.x = pos.x + dx * clear;
    probe.y = pos.y + dy * clear;
    const zFace = blocked(world, timeMs);
    const h = Math.hypot(dx, dz);
    const sinPhi = h > 0 ? Math.abs(zFace ? dz : dx) / h : 1;
    return wallEnvelope(clear, sinPhi);
  }
  return MAX_SPEED;
}

/**
 * The braking envelope: the fastest speed that can brake (constant
 * deceleration BRAKE_DESIGN × CORNER_BRAKE_DECEL) to some v_t and then turn
 * at full deflection until parallel to a wall `distance` meters ahead along
 * the nose, met at incidence φ (sinPhi; 1 = head-on). Braking for s meters
 * closes on the wall by s·sinφ, and turning φ away costs R(v_t)·(1 − cos φ)
 * of the remaining normal gap, so
 *   v² = v_t² + 2a · (D·sinφ − WALL_MARGIN − R(v_t)(1 − cos φ)) / sinφ,
 * maximised over v_t. Head-on that is the plain "brake, then a 90° turn
 * inside D"; a few degrees off a long avenue it is never binding.
 * MIN_SPEED when no v_t fits (the wall is already too close to help).
 */
export function wallEnvelope(distance: number, sinPhi = 1): number {
  if (!Number.isFinite(distance) || sinPhi <= 0) return MAX_SPEED;
  const s = Math.min(1, sinPhi);
  const cosPhi = Math.sqrt(1 - s * s);
  const normal = distance * s - WALL_MARGIN;
  const a = BRAKE_DESIGN * CORNER_BRAKE_DECEL;
  let best = MIN_SPEED;
  for (let vt = MIN_SPEED; vt <= MAX_SPEED; vt += 2.5) {
    const room = normal - turnRadius(vt) * (1 - cosPhi);
    if (room < 0) continue;
    const v = Math.sqrt(vt * vt + (2 * a * room) / s);
    if (v > best) best = v;
  }
  return Math.min(MAX_SPEED, best);
}

/** Is the full-deflection 90° arc of `radius`, turning `dir` (+1 right), from
 * the plane's position and heading, clear? Flown level at its altitude. */
function arcClear(
  world: CornerWorld,
  flight: FlightState,
  radius: number,
  dir: 1 | -1,
  timeMs: number | null,
): boolean {
  const { pos, yaw } = flight;
  const c0 = Math.cos(yaw);
  const s0 = Math.sin(yaw);
  const n = Math.max(2, Math.ceil((radius * ARC_SWEEP) / PROBE_STEP));
  probe.y = pos.y;
  for (let i = 1; i <= n; i++) {
    const th = (ARC_SWEEP * i) / n;
    // ∫ forward(yaw − dir·t) dt, forward(y) = (−sin y, −cos y): the closed
    // form of flying the arc (turn +1 is right, yaw decreases).
    const a = yaw - dir * th;
    probe.x = pos.x - radius * dir * (Math.cos(a) - c0);
    probe.z = pos.z + radius * dir * (Math.sin(a) - s0);
    if (blocked(world, timeMs)) return false;
  }
  return true;
}

/** Fastest speed in [MIN_SPEED, MAX_SPEED] whose 90° arc turning `dir` is
 * clear; MIN_SPEED when even the tightest arc is blocked. */
function arcSpeed(
  world: CornerWorld,
  flight: FlightState,
  dir: 1 | -1,
  timeMs: number | null,
): number {
  if (arcClear(world, flight, turnRadius(MAX_SPEED), dir, timeMs))
    return MAX_SPEED;
  if (!arcClear(world, flight, turnRadius(MIN_SPEED), dir, timeMs))
    return MIN_SPEED;
  let lo = MIN_SPEED; // clear
  let hi = MAX_SPEED; // blocked
  for (let i = 0; i < ARC_BISECT; i++) {
    const mid = (lo + hi) / 2;
    if (arcClear(world, flight, turnRadius(mid), dir, timeMs)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The corridor the plane is threading — inside it with the nose within 30°
 * of its axis — or null. */
export function threadingCorridor(
  world: CornerWorld,
  flight: FlightState,
  fx: number,
  fz: number,
): HoleCorridor | null {
  const { pos } = flight;
  for (const c of world.corridors) {
    if (pos.y < c.y0 || pos.y > c.y1) continue;
    const d = wrapDelta(c.center, pos);
    const along = c.axis === "x" ? d.x : d.z;
    const across = c.axis === "x" ? d.z : d.x;
    if (Math.abs(along) > c.halfLength || Math.abs(across) > c.halfWidth)
      continue;
    const h = Math.hypot(fx, fz);
    const axial = Math.abs(c.axis === "x" ? fx : fz);
    if (h > 0 && axial >= CORRIDOR_ALIGN * h) return c;
  }
  return null;
}

/**
 * The speed the corner manager allows here, m/s, in [MIN_SPEED, MAX_SPEED]:
 * MAX_SPEED in open air. `turn` is the pilot's commanded turn (−1..1, +1
 * right) — the intent probe 2 reads. `timeMs` is the clock the movers are
 * rendered at (detectCrash's rule: null ⇒ only the viaduct is solid).
 */
export function cornerSpeed(
  flight: FlightState,
  world: CornerWorld,
  turn = 0,
  timeMs: number | null = null,
): number {
  const cosP = Math.cos(flight.pitch);
  const fx = -Math.sin(flight.yaw) * cosP;
  const fy = Math.sin(flight.pitch);
  const fz = -Math.cos(flight.yaw) * cosP;
  const corridor = threadingCorridor(world, flight, fx, fz);
  let cap = MAX_SPEED;

  // Probe 1 — wall ahead. In a corridor it runs straight down the hole's
  // axis instead: the H1 run-out guarantees that air, and an approach a few
  // degrees off the axis must not read the hole's own jamb as a wall.
  if (corridor) {
    const sx = corridor.axis === "x" ? Math.sign(fx) : 0;
    const sz = corridor.axis === "z" ? Math.sign(fz) : 0;
    const c = rayCap(world, flight.pos, sx, 0, sz, WALL_HORIZON, timeMs);
    return Math.min(cap, c);
  }
  if (Math.abs(flight.pitch) < WALL_PITCH_MAX) {
    cap = Math.min(
      cap,
      rayCap(world, flight.pos, fx, fy, fz, WALL_HORIZON, timeMs),
    );
  }

  // Probe 2 — the pilot is committing to a hard turn: make it makeable.
  if (Math.abs(turn) >= ARC_INTENT) {
    cap = Math.min(cap, arcSpeed(world, flight, turn > 0 ? 1 : -1, timeMs));
  }
  return cap;
}

/** Advance the rate-limited ceiling toward `raw`: falls at CAP_FALL_RATE,
 * recovers at CAP_RISE_RATE. Monotone toward `raw`, never overshoots it. */
export function stepCornerCap(prev: number, raw: number, dt: number): number {
  if (raw < prev) return Math.max(raw, prev - CAP_FALL_RATE * dt);
  return Math.min(raw, prev + CAP_RISE_RATE * dt);
}

/** What main hands stepFlight: no cap at all once the ceiling is back at
 * MAX_SPEED, so the post-boost tail above MAX_SPEED is never airbraked. */
export function cornerCapInput(cap: number): number | undefined {
  return cap < MAX_SPEED ? cap : undefined;
}
