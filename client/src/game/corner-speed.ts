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
//   1. Wall ahead: march the nose to WALL_HORIZON; on a hit at D, fan a few
//      rays to find the smallest heading correction φ that clears it, and
//      cap speed to the braking envelope (wallEnvelope) for "brake, then
//      turn φ inside D". A wall met head-on needs a real turn, so the plane
//      brakes early enough to make it even if the pilot holds straight; a
//      nose a few degrees off a long avenue, or about to clip a block corner,
//      only needs those few degrees, so it never brakes.
//   2. Steering arc (intent): only while the pilot commands a hard turn, the
//      fastest speed whose full-deflection 90° arc from here is clear.
// Inside a hole's clear corridor, aligned with it, probe 2 is skipped and
// probe 1 runs along the hole's axis — the hole's own jambs and lintel never
// slow you; only a real wall beyond its far mouth can.
//
// Movers cost ~5x a building lookup, so each ray or arc first asks the
// movers once with a sphere enclosing the whole probe; only when something
// moving is that close does every sample test them.

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
import { type FlightState, turnRadius } from "@angels-bandits/common/flight";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";

/** Probe sphere radius, m: the plane's own sphere plus a little air. */
export const PROBE_RADIUS = PLAYER_RADIUS + 1.5;
/** Spacing of probe samples along a ray or arc, m (< 2 × PROBE_RADIUS, so
 * consecutive spheres overlap and no wall thicker than ~1 m slips between). */
const PROBE_STEP = 6;
/** How far ahead probe 1 looks, m — past the ~206 m a 90 m/s plane needs to
 * brake to MIN_SPEED and still turn away from a wall met head-on. */
export const WALL_HORIZON = 220;
/** Clear air kept between the turn-away arc and the wall, m — on top of
 * PROBE_RADIUS's own 1.5 m. */
const WALL_MARGIN = 2;
/** Heading corrections probe 1 tries on a hit, rad, smallest first; none
 * clear ⇒ a real turn (90°). */
const ESCAPES = [4, 8, 12, 18, 25, 35, 50].map((d) => (d * Math.PI) / 180);
/** cos of the steepest escape: its forward reach costs the most ray. */
const ESCAPE_COS_MIN = Math.cos((50 * Math.PI) / 180);
/** How far past the hit an escape ray must stay clear, m — far enough to be
 * past a block corner, not just past the sample that hit. */
const ESCAPE_PAST = 24;
/** Probe 1 only runs this close to level, rad (30°): a steep dive or climb
 * is escaped with the elevator, not the turn the envelope assumes. */
const WALL_PITCH_MAX = Math.PI / 6;
/** The envelope designs for this fraction of the airbrake, so the plane
 * (which brakes at the full CORNER_BRAKE_DECEL) always leads the cap. */
const BRAKE_DESIGN = 0.85;
/** Band of needed correction φ, rad, over which an obstacle goes from "a
 * correction" (turn-now envelope, below 20°) to "a real turn" (brake-first
 * envelope, above 40°). */
const GLANCE_LO = (20 * Math.PI) / 180;
const GLANCE_HI = (40 * Math.PI) / 180;
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
/** Whether the current ray/arc has a mover near enough to test (armMovers). */
let moversNear = false;

/** detectCrash's mover rules for one sphere: no clock ⇒ only the static
 * viaduct is drawn, so only it is solid. */
function moverAt(
  movers: MoverField,
  p: Vec3,
  radius: number,
  timeMs: number | null,
): boolean {
  if (timeMs === null) {
    return (
      !!movers.train && collideTrain(movers.train, p, radius, null) !== null
    );
  }
  return collideMovers(p, radius, movers, timeMs) !== null;
}

/** Ask the movers once whether anything moving touches the sphere of
 * `radius` around `probe` — one enclosing every sample of the coming ray or
 * arc. The colliders are generic sphere tests, so this is conservative. */
function armMovers(
  world: CornerWorld,
  radius: number,
  timeMs: number | null,
): void {
  moversNear = !!world.movers && moverAt(world.movers, probe, radius, timeMs);
}

/** Does a PROBE_RADIUS sphere at `probe` touch anything the plane can hit? */
function blocked(world: CornerWorld, timeMs: number | null): boolean {
  if (collideCity(probe, PROBE_RADIUS, world.buildings, world.index) !== null)
    return true;
  if (world.nature && collideNature(probe, PROBE_RADIUS, world.nature) !== null)
    return true;
  return (
    moversNear &&
    !!world.movers &&
    moverAt(world.movers, probe, PROBE_RADIUS, timeMs)
  );
}

/** Bisection steps that refine probe 1's hit: 6 m / 2⁶ < 0.1 m. Without it
 * the 6 m sample grid sliding along the ray makes the distance a sawtooth,
 * and the cap twitches up as the plane closes. */
const HIT_REFINE = 6;

/** Clear distance along a ray from `pos` (unit dx, dy, dz) before the first
 * blocked sample within `horizon` (refined to < 0.1 m when `refine`);
 * Infinity when all clear. */
function clearRun(
  world: CornerWorld,
  pos: Vec3,
  dx: number,
  dy: number,
  dz: number,
  horizon: number,
  timeMs: number | null,
  refine = false,
): number {
  for (let s = PROBE_STEP; s <= horizon; s += PROBE_STEP) {
    probe.x = pos.x + dx * s;
    probe.y = pos.y + dy * s;
    probe.z = pos.z + dz * s;
    if (!blocked(world, timeMs)) continue;
    let lo = s - PROBE_STEP; // clear (or the plane itself)
    let hi = s; // blocked
    for (let i = 0; refine && i < HIT_REFINE; i++) {
      const mid = (lo + hi) / 2;
      probe.x = pos.x + dx * mid;
      probe.y = pos.y + dy * mid;
      probe.z = pos.z + dz * mid;
      if (blocked(world, timeMs)) hi = mid;
      else lo = mid;
    }
    return lo;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Probe 1 for one ray from `pos` along unit (dx, dy, dz): MAX_SPEED when the
 * first `horizon` meters are clear, else wallEnvelope at the hit for the
 * smallest heading correction (either way, from ESCAPES) whose ray stays
 * clear ESCAPE_PAST beyond it — a measured "how much turn does this need",
 * which handles faces, corners and movers alike.
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
  // One movers query for every ray this probe may cast from `pos` — the
  // slanted escape rays included.
  probe.x = pos.x;
  probe.y = pos.y;
  probe.z = pos.z;
  armMovers(world, horizon / ESCAPE_COS_MIN + PROBE_RADIUS, timeMs);
  const d = clearRun(world, pos, dx, dy, dz, horizon, timeMs, true);
  if (!Number.isFinite(d)) return MAX_SPEED;
  // An escape must stay clear to `reach` measured FORWARD — along the
  // slanted ray that is reach / cos φ. (Measured along the ray, a wide wall
  // looks escapable at a steep φ simply because the slant meets it later.)
  const reach = Math.min(horizon, d + PROBE_STEP + ESCAPE_PAST);
  let sinPhi = 1;
  for (const phi of ESCAPES) {
    const c = Math.cos(phi);
    const sn = Math.sin(phi);
    const run = reach / c;
    // Rotate the nose about world-up both ways (pitch component kept).
    const ax = dx * c + dz * sn;
    const az = dz * c - dx * sn;
    const bx = dx * c - dz * sn;
    const bz = dz * c + dx * sn;
    if (
      clearRun(world, pos, ax, dy, az, run, timeMs) >= run - PROBE_STEP ||
      clearRun(world, pos, bx, dy, bz, run, timeMs) >= run - PROBE_STEP
    ) {
      sinPhi = sn;
      break;
    }
  }
  return wallEnvelope(d, sinPhi);
}

/**
 * The braking envelope for an obstacle `distance` meters ahead along the
 * nose that a heading correction φ (sinPhi; 1 = a full 90° turn) clears, in
 * [MIN_SPEED, MAX_SPEED].
 *
 * A full-deflection turn through φ at speed v_t covers R(v_t)·sinφ of
 * forward distance, so braking (constant a = BRAKE_DESIGN ×
 * CORNER_BRAKE_DECEL) to v_t and then turning φ fits inside the distance
 * from
 *   v(v_t)² = v_t² + 2a · (D − WALL_MARGIN − R(v_t)·sinφ).
 * - Turn-now (max over v_t): survivable if the pilot turns NOW. Right for a
 *   correction of a few degrees.
 * - Brake-first (v_t = MIN_SPEED): survivable even if the pilot holds
 *   straight until the last moment. Right for a real turn — and the only
 *   version the airbrake can follow: head-on, the turn-now curve collapses
 *   from 90 to 40 m/s over the last ~70 m, faster than any brake.
 * Blended across GLANCE_LO..GLANCE_HI of φ. MIN_SPEED when nothing fits
 * (already too close to help); MAX_SPEED for φ = 0; never NaN.
 */
export function wallEnvelope(distance: number, sinPhi = 1): number {
  if (!Number.isFinite(distance)) return MAX_SPEED;
  const s = sinPhi > 0 ? Math.min(1, sinPhi) : 0;
  const a = BRAKE_DESIGN * CORNER_BRAKE_DECEL;
  const reach = (vt: number): number => {
    const room = distance - WALL_MARGIN - turnRadius(vt) * s;
    return room < 0
      ? MIN_SPEED
      : Math.min(MAX_SPEED, Math.sqrt(vt * vt + 2 * a * room));
  };
  const brakeFirst = reach(MIN_SPEED);
  let turnNow = brakeFirst;
  for (let vt = MIN_SPEED + 2.5; vt <= MAX_SPEED; vt += 2.5) {
    turnNow = Math.max(turnNow, reach(vt));
  }
  const w = Math.min(
    1,
    Math.max(0, (Math.asin(s) - GLANCE_LO) / (GLANCE_HI - GLANCE_LO)),
  );
  return turnNow - w * (turnNow - brakeFirst);
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
  // Every arc point lies within its chord R·√2 of the start: one sphere at
  // the plane covers all of them, the widest (MAX_SPEED) arc included.
  probe.x = flight.pos.x;
  probe.y = flight.pos.y;
  probe.z = flight.pos.z;
  armMovers(world, turnRadius(MAX_SPEED) * Math.SQRT2 + PROBE_RADIUS, timeMs);
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
  // axis instead: an approach a few degrees off the axis must not read the
  // hole's own jamb as a wall (a real wall past the far mouth still counts).
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
