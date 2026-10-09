// H3 invisible hole save — the last-moment correction that threads a hole.
// Where H2's centering nudge (hole-assist.ts) biases the pilot's INPUT long
// before the mouth, this acts on the POSE, and only when a crash is coming:
// lined up on a hole or a river underpass, with a hit on that hole's walls,
// lintel, sill or deck predicted within SAVE_HORIZON, it searches for the
// smallest correction that clears and slides the plane onto it, unseen.
//
// Gate → predict → search → apply, cheapest first, every frame:
//   - gate: the plane is inside a span's corridor (SAVE_APPROACH before the
//     near mouth to the far mouth, within the opening + SAVE_CAPTURE) and
//     flying along its axis (both heading and elevation < SAVE_ALIGN_MAX
//     off it). Everywhere else the module costs one loop over the spans;
//   - predict: stepFlight rolled forward SAVE_HORIZON on the frame's shaped
//     input, against the very solids detectCrash tests (touchesSolid). The
//     predicted impact must lie on THAT span's hole surfaces — so an open
//     canyon wall, a river bank or a building down the street still kills;
//   - search: SAVE_CANDIDATES, smallest first and toward the centreline
//     first — position offsets (≤ SAVE_MAX_OFFSET, vector) and, in classic
//     stick mode, heading/pitch tweaks (≤ SAVE_MAX_ANGLE, vector). Each one is
//     flown through the same rollout with its ramp applied, and must stay
//     clear for SAVE_CLEAR_HORIZON. A hard probe budget bounds the frame;
//   - apply: a trapezoid rate profile over SAVE_TIME (SAVE_RAMP ramps), so
//     the slide peaks at ≈ 5.8 m/s and ≈ 11.5°/s — under the 6 m/s / 20°/s a
//     pilot notices — and starts and stops without a rate step. A slice that
//     would put the plane inside a solid is dropped and the save stops.
//
// U4 tunnels ride the same machinery: a bore is a corridor too, measured in
// its own path frame (arc length, lateral off the centreline, height off
// the guide line, alignment against the path's heading AND its ramp grade)
// instead of an axis — so the save threads a portal's lintel, a river
// mouth, or a bend's wall exactly as it threads a hole.
//
// Every save in one pass through the holes shares one budget (SAVE_MAX_OFFSET
// and SAVE_MAX_ANGLE in total), re-armed only once the plane has left every
// corridor: it threads a hole, it never flies one for you.
//
// Mouse-aim and touch fly through the instructor, which would fly an attitude
// tweak straight back out (and walk the pipper off the cursor), so the caller
// passes angles=false there and only position offsets are tried.
//
// Allocation: state and scratch live in caller-owned / module objects, but
// stepFlight (deliberately reused, not forked — the flight model keeps
// evolving) returns fresh objects per call. That cost is only paid on gated
// frames, i.e. while lined up on a hole. No HUD, no sound.

import type { HoleSpan } from "@angels-bandits/common/city";
import type { Building } from "@angels-bandits/common/city";
import type { MoverField } from "@angels-bandits/common/city/movers";
import {
  BORE_HEIGHT,
  BORE_WIDTH,
  type Tunnel,
  type TunnelFrame,
  guideSlope,
  guideY,
  tunnelFrameInto,
} from "@angels-bandits/common/city/tunnels";
import type { CityIndex, NatureIndex } from "@angels-bandits/common/collision";
import { PLAYER_RADIUS, WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import { touchesSolid } from "./collision";

const DEG = Math.PI / 180;
/** A crash predicted within this, s, triggers a search. */
export const SAVE_HORIZON = 0.35;
/** A candidate must keep the plane clear this long, s. */
export const SAVE_CLEAR_HORIZON = 0.5;
/** Caps on one pass's corrections: position offset, m, and attitude tweak,
 * rad — each a vector magnitude (lateral+vertical, heading+pitch). */
export const SAVE_MAX_OFFSET = 1.5;
export const SAVE_MAX_ANGLE = 3 * DEG;
/** The correction's duration and its ramp in/out, s. */
export const SAVE_TIME = 0.3;
export const SAVE_RAMP = 0.04;
/** The corridor: this far before the near mouth, m, and this far outside
 * the opening across and vertically. */
export const SAVE_APPROACH = 60;
export const SAVE_CAPTURE = 2.5;
/** Heading or elevation off the hole's axis past which it never acts. */
export const SAVE_ALIGN_MAX = 20 * DEG;
/** Rollout sub-step: at most this much travel, m (a 2 m sphere can't skip a
 * 2.5 m deck or a 4 m sill), and at most SAVE_MAX_DT. */
export const SAVE_MAX_STEP = 3;
const SAVE_MAX_DT = 1 / 40;
/** Per-frame work budget: collision probes across prediction and search. */
export const SAVE_MAX_PROBES = 1500;

const RADIUS = PLAYER_RADIUS;
/** Peak of the normalised trapezoid profile (its integral over SAVE_TIME is
 * 1): the rate the correction slides at, as a fraction of it per second. */
const V_PEAK = 1 / (SAVE_TIME - SAVE_RAMP);

/** A corridor the save threads: an H1 hole / river underpass, or a U4 bore. */
export type SaveSpan = HoleSpan | Tunnel;

const isTunnel = (s: SaveSpan): s is Tunnel => "segs" in s;

/** Everything the save reads — the same solids the crash check does. */
export interface SaveWorld {
  spans: readonly HoleSpan[];
  /** U4: the bores (common/city/tunnels TUNNELS); none when omitted. */
  tunnels?: readonly Tunnel[];
  buildings: readonly Building[];
  index?: CityIndex;
  nature?: NatureIndex;
  movers?: MoverField;
}

/** Caller-owned save state. */
export interface HoleSave {
  /** The committed correction, world: position offset (m) and attitude
   * tweak (rad). Zero when idle. */
  dx: number;
  dy: number;
  dz: number;
  dyaw: number;
  dpitch: number;
  /** Seconds into the profile; −1 when idle. */
  t: number;
  /** Ease-out after a cancel: the rate it started from (fraction/s) and the
   * seconds into it; easeT −1 when not easing. */
  easeV: number;
  easeT: number;
  /** The span the committed correction threads. */
  span: SaveSpan | null;
  /** This pass's spent budget, m and rad. */
  usedPos: number;
  usedAng: number;
  /** Corrections committed since creation (diagnostics). */
  saves: number;
}

export function createHoleSave(): HoleSave {
  return {
    dx: 0,
    dy: 0,
    dz: 0,
    dyaw: 0,
    dpitch: 0,
    t: -1,
    easeV: 0,
    easeT: -1,
    span: null,
    usedPos: 0,
    usedAng: 0,
    saves: 0,
  };
}

/** Stop dead and forget the pass (death, respawn, teleport). */
export function resetHoleSave(s: HoleSave): void {
  s.dx = s.dy = s.dz = s.dyaw = s.dpitch = 0;
  s.t = -1;
  s.easeV = 0;
  s.easeT = -1;
  s.span = null;
  s.usedPos = 0;
  s.usedAng = 0;
}

/** Is a correction moving the plane (committed or easing out)? */
export function holeSaveActive(s: HoleSave): boolean {
  return s.t >= 0 || s.easeT >= 0;
}

// --- The rate profile --------------------------------------------------

/** Fraction of the correction applied by `t` s into the profile. */
function profile(t: number): number {
  if (t <= 0) return 0;
  if (t >= SAVE_TIME) return 1;
  if (t < SAVE_RAMP) return (V_PEAK * t * t) / (2 * SAVE_RAMP);
  if (t <= SAVE_TIME - SAVE_RAMP)
    return V_PEAK * (SAVE_RAMP / 2 + t - SAVE_RAMP);
  const r = SAVE_TIME - t;
  return 1 - (V_PEAK * r * r) / (2 * SAVE_RAMP);
}

/** The profile's rate at `t`, fraction/s. */
function profileRate(t: number): number {
  if (t <= 0 || t >= SAVE_TIME) return 0;
  if (t < SAVE_RAMP) return (V_PEAK * t) / SAVE_RAMP;
  if (t <= SAVE_TIME - SAVE_RAMP) return V_PEAK;
  return (V_PEAK * (SAVE_TIME - t)) / SAVE_RAMP;
}

/** Fraction applied by `e` s into an ease-out from rate `v`. */
function easeProfile(v: number, e: number): number {
  const u = Math.min(Math.max(e, 0), SAVE_RAMP);
  return v * (u - (u * u) / (2 * SAVE_RAMP));
}

// --- The corridor --------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;
const wrapAngle = (a: number): number => {
  const m = (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return m - Math.PI;
};
const wrap = (v: number) => ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

/** The last frame of `spanFrame`: the point in the span's own frame (and,
 * for a bore, its heading there). */
const frame = { along: 0, lateral: 0, up: 0, sg: 1, th: 0 };
/** The bore frame scratch (tunnelFrameInto). */
const tf: TunnelFrame = { s: 0, lat: 0, th: 0 };

/** A span's clear width and height (a bore's section; a cut's open sky is
 * measured as the bore's height about the guide line). */
const spanWidth = (s: SaveSpan) => (isTunnel(s) ? BORE_WIDTH : s.hole.width);
const spanHeight = (s: SaveSpan) => (isTunnel(s) ? BORE_HEIGHT : s.hole.height);

/** Fill `frame` with `p` in `span`'s frame for travel sign `sg` (+1 along
 * increasing axis coordinate — along increasing arc length for a bore).
 * Torus-correct (wrapDeltaAxis / tunnelFrameInto). */
function spanFrame(span: SaveSpan, p: Vec3, sg: number): void {
  frame.sg = sg;
  if (isTunnel(span)) {
    tunnelFrameInto(span, p, tf);
    frame.along = (tf.s - span.length / 2) * sg;
    frame.lateral = tf.lat;
    frame.up = p.y - guideY(span, tf.s);
    frame.th = tf.th;
    return;
  }
  const x = span.hole.axis === "x";
  frame.sg = sg;
  frame.along =
    (x
      ? wrapDeltaAxis(span.center.x, p.x)
      : wrapDeltaAxis(span.center.z, p.z)) * sg;
  frame.lateral = x
    ? wrapDeltaAxis(span.center.z, p.z)
    : wrapDeltaAxis(span.center.x, p.x);
  frame.up = p.y - span.center.y;
}

/** The travel sign along `span`'s axis, or 0 when the nose is more than
 * SAVE_ALIGN_MAX off the axis (heading or elevation). A bore's axis is its
 * path at `pos` — heading and ramp grade both. */
function travelSign(
  span: SaveSpan,
  pos: Vec3,
  yaw: number,
  pitch: number,
): number {
  if (isTunnel(span)) {
    tunnelFrameInto(span, pos, tf);
    // flightForward's horizontal heading, as an angle in x/z.
    const head = Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
    const off = wrapAngle(head - tf.th);
    const sg = Math.abs(off) < Math.PI / 2 ? 1 : -1;
    const dev = sg === 1 ? off : wrapAngle(off - Math.PI);
    if (Math.abs(dev) >= SAVE_ALIGN_MAX) return 0;
    const climb = Math.atan(guideSlope(span, tf.s) * sg);
    if (Math.abs(pitch - climb) >= SAVE_ALIGN_MAX) return 0;
    return sg;
  }
  if (Math.abs(pitch) >= SAVE_ALIGN_MAX) return 0;
  // flightForward's horizontal part, in place: (−sin yaw, −cos yaw).
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const x = span.hole.axis === "x";
  const fa = x ? fx : fz;
  const fc = x ? fz : fx;
  if (Math.abs(Math.atan2(fc, Math.abs(fa))) >= SAVE_ALIGN_MAX) return 0;
  return fa > 0 ? 1 : -1;
}

/** How far before the near mouth the plane is (≤ 0 inside), when it is in
 * `span`'s corridor and lined up on it — else NaN. Leaves `frame` filled. */
function corridorDistance(span: SaveSpan, st: FlightState): number {
  const sg = travelSign(span, st.pos, st.yaw, st.pitch);
  if (sg === 0) return Number.NaN;
  spanFrame(span, st.pos, sg);
  const half = span.length / 2;
  const toMouth = -frame.along - half;
  if (toMouth > SAVE_APPROACH || frame.along > half) return Number.NaN;
  if (Math.abs(frame.lateral) > spanWidth(span) / 2 + SAVE_CAPTURE) {
    return Number.NaN;
  }
  if (Math.abs(frame.up) > spanHeight(span) / 2 + SAVE_CAPTURE) {
    return Number.NaN;
  }
  return toMouth;
}

/** The span that owns the plane this frame: of every corridor it is in,
 * the one whose near mouth is closest (a row tunnel is one merged span). */
export function saveCorridor(
  world: SaveWorld,
  st: FlightState,
): SaveSpan | null {
  let best: SaveSpan | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  const consider = (s: SaveSpan) => {
    const d = corridorDistance(s, st);
    if (Number.isNaN(d)) return;
    const dd = Math.max(0, d);
    if (dd < bestD) {
      bestD = dd;
      best = s;
    }
  };
  for (const s of world.spans) consider(s);
  for (const t of world.tunnels ?? NO_TUNNELS) consider(t);
  return best;
}

const NO_TUNNELS: readonly Tunnel[] = [];

/** Does an impact at `q` (travel sign `sg`) land on `span`'s own hole
 * surfaces? Building holes: the walls, lintel and sill round and inside the
 * mouth. River underpasses: only the deck's underside or the water beneath
 * it, inside the channel — never a bank wall or the open river. */
function onHoleSurface(span: SaveSpan, q: Vec3, sg: number): boolean {
  spanFrame(span, q, sg);
  if (Math.abs(frame.along) > span.length / 2 + RADIUS) return false;
  if (isTunnel(span)) {
    // A bore's own walls, floor, ceiling and lintel faces: inside its
    // section, grown like a hole's. A street-level wall beyond a portal's
    // lip is outside the section and still kills.
    return (
      Math.abs(frame.lateral) <= BORE_WIDTH / 2 + SAVE_CAPTURE + RADIUS &&
      Math.abs(frame.up) <= BORE_HEIGHT / 2 + SAVE_CAPTURE + RADIUS
    );
  }
  const { width, height, kind } = span.hole;
  if (kind === "bridge") {
    if (Math.abs(frame.lateral) > width / 2 - RADIUS) return false;
    const reach = height / 2 - RADIUS - SAVE_MAX_STEP;
    return (
      Math.abs(frame.up) >= reach && Math.abs(frame.up) <= height / 2 + RADIUS
    );
  }
  return (
    Math.abs(frame.lateral) <= width / 2 + SAVE_CAPTURE + RADIUS &&
    Math.abs(frame.up) <= height / 2 + SAVE_CAPTURE + RADIUS
  );
}

// --- The rollout ---------------------------------------------------------

/** Probes spent this frame (reset per stepHoleSave). */
let probes = 0;
/** Where the last rollout hit. */
const hit: Vec3 = { x: 0, y: 0, z: 0 };
/** Scratch start state for rollouts (the caller's state is never touched). */
const start: FlightState = {
  pos: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  roll: 0,
  bank: 0,
  rollRate: 0,
  speed: 0,
  targetSpeed: 0,
};

/** One correction under trial: totals, and where on the profile it starts. */
const trial = {
  dx: 0,
  dy: 0,
  dz: 0,
  dyaw: 0,
  dpitch: 0,
  t0: 0,
  ease: false,
  easeV: 0,
};

/** Fraction of `trial` applied between profile times a and b. */
function trialSlice(a: number, b: number): number {
  return trial.ease
    ? easeProfile(trial.easeV, b) - easeProfile(trial.easeV, a)
    : profile(b) - profile(a);
}

function applyTo(st: FlightState, f: number): void {
  if (f === 0) return;
  st.pos.x = wrap(st.pos.x + trial.dx * f);
  st.pos.y += trial.dy * f;
  st.pos.z = wrap(st.pos.z + trial.dz * f);
  st.yaw += trial.dyaw * f;
  st.pitch += trial.dpitch * f;
}

/**
 * Fly `st` forward `horizon` s on `input` with `trial` applied on its
 * profile (from trial.t0), testing detectCrash's solids at the matching
 * clock. Returns the seconds to the first touch (and fills `hit`), Infinity
 * when clear, or NaN when the probe budget ran out.
 */
function rollout(
  st: FlightState,
  input: FlightInput,
  horizon: number,
  world: SaveWorld,
  clockMs: number | null,
): number {
  start.pos.x = st.pos.x;
  start.pos.y = st.pos.y;
  start.pos.z = st.pos.z;
  start.yaw = st.yaw;
  start.pitch = st.pitch;
  start.roll = st.roll;
  // F7: the cosmetic lean, so the real roll (inverted, A/D) carries over.
  start.bank = st.bank ?? st.roll;
  start.rollRate = st.rollRate ?? 0;
  start.speed = st.speed;
  start.targetSpeed = st.targetSpeed;
  const h = Math.min(SAVE_MAX_DT, SAVE_MAX_STEP / Math.max(st.speed, 1));
  let s: FlightState = start;
  let t = 0;
  while (t < horizon) {
    if (t > 0) s = stepFlight(s, input, h);
    applyTo(s, trialSlice(trial.t0 + t, trial.t0 + t + h));
    t += h;
    if (probes >= SAVE_MAX_PROBES) return Number.NaN;
    probes++;
    if (solidAt(world, s.pos, clockMs === null ? null : clockMs + t * 1000)) {
      hit.x = s.pos.x;
      hit.y = s.pos.y;
      hit.z = s.pos.z;
      return t;
    }
  }
  return Number.POSITIVE_INFINITY;
}

function clearTrial(): void {
  trial.dx = trial.dy = trial.dz = trial.dyaw = trial.dpitch = 0;
  trial.t0 = 0;
  trial.ease = false;
  trial.easeV = 0;
}

// --- The candidates ------------------------------------------------------

/** One candidate in "toward the centreline" units: l/v across and up, a/p
 * heading and pitch, each signed so + moves toward the centre, and scaled so
 * the position and angle parts each have magnitude `level` (of the cap). */
interface Candidate {
  l: number;
  v: number;
  a: number;
  p: number;
}

const LEVELS = [0.2, 0.4, 0.6, 0.8, 1];
const R2 = Math.SQRT1_2;
/** Smallest first; within a level, position alone (the least visible),
 * then position + attitude, then attitude alone; across, up, then both. */
export const SAVE_CANDIDATES: readonly Candidate[] = (() => {
  const out: Candidate[] = [];
  const dirs: [number, number][] = [
    [1, 0],
    [0, 1],
    [R2, R2],
  ];
  for (const k of LEVELS) {
    for (const kind of [0, 1, 2]) {
      for (const [l, v] of dirs) {
        const pos = kind === 2 ? 0 : k;
        const ang = kind === 0 ? 0 : k;
        out.push({ l: l * pos, v: v * pos, a: l * ang, p: v * ang });
      }
    }
  }
  return out;
})();

/** Fill `trial` with candidate `c` for `span` from state `st`. */
function setTrial(c: Candidate, span: SaveSpan, st: FlightState): void {
  spanFrame(span, st.pos, 1);
  if (isTunnel(span)) {
    // Across = the path's left normal at the plane, (−sin th, cos th).
    const nx = -Math.sin(frame.th);
    const nz = Math.cos(frame.th);
    const sL = frame.lateral > 0 ? -1 : 1;
    const sV = frame.up > 0 ? -1 : 1;
    // A +yaw swings the nose's across component by sin(th + yaw).
    const sA = (Math.sin(frame.th + st.yaw) >= 0 ? 1 : -1) * sL;
    const lat = c.l * sL * SAVE_MAX_OFFSET;
    trial.dx = nx * lat;
    trial.dz = nz * lat;
    trial.dy = c.v * sV * SAVE_MAX_OFFSET;
    trial.dyaw = c.a * sA * SAVE_MAX_ANGLE;
    trial.dpitch = c.p * sV * SAVE_MAX_ANGLE;
    trial.t0 = 0;
    trial.ease = false;
    return;
  }
  const x = span.hole.axis === "x";
  const sL = frame.lateral > 0 ? -1 : 1; // across, toward the centreline
  const sV = frame.up > 0 ? -1 : 1; // up, toward the centreline
  // A +yaw swings the nose's across component by d(fwd)/dyaw: (−cos, sin).
  const dLat = x ? Math.sin(st.yaw) : -Math.cos(st.yaw);
  const sA = (dLat >= 0 ? 1 : -1) * sL;
  const lat = c.l * sL * SAVE_MAX_OFFSET;
  trial.dx = x ? 0 : lat;
  trial.dz = x ? lat : 0;
  trial.dy = c.v * sV * SAVE_MAX_OFFSET;
  trial.dyaw = c.a * sA * SAVE_MAX_ANGLE;
  trial.dpitch = c.p * sV * SAVE_MAX_ANGLE;
  trial.t0 = 0;
  trial.ease = false;
}

// --- The frame step ------------------------------------------------------

/**
 * One frame of the save, run on the state stepFlight just produced (which it
 * corrects IN PLACE — call it before anything reads the frame's pose).
 * `input` is the shaped input that state was stepped with; `clockMs` the
 * clock the movers are drawn and crash-checked at (null: hidden). `angles`
 * false keeps it to position offsets (instructor-flown modes). Returns
 * whether it moved the plane this frame.
 */
export function stepHoleSave(
  save: HoleSave,
  st: FlightState,
  input: FlightInput,
  dt: number,
  world: SaveWorld,
  clockMs: number | null,
  angles: boolean,
): boolean {
  probes = 0;
  const owner = saveCorridor(world, st);
  // Out of every corridor and still: the pass is over, its budget re-arms.
  if (owner === null && !holeSaveActive(save)) {
    save.usedPos = 0;
    save.usedAng = 0;
    save.span = null;
    return false;
  }

  // A running correction is re-checked every frame: off its corridor, off
  // the axis, or no longer clearing with the pilot's current input, it
  // eases out (no rate step) instead of pushing on.
  if (save.t >= 0 && save.span) {
    let keep = !Number.isNaN(corridorDistance(save.span, st));
    if (keep) {
      loadTrial(save);
      const tHit = rollout(st, input, SAVE_HORIZON, world, clockMs);
      keep = !(tHit < SAVE_HORIZON);
      clearTrial();
    }
    if (!keep) cancel(save);
  }

  // Idle (no correction moving), in a corridor: predict, and search if the
  // predicted impact is on the owning hole's surfaces.
  if (!holeSaveActive(save) && owner)
    search(save, owner, st, input, world, clockMs, angles);

  return apply(save, st, dt, world, clockMs);
}

/** Put the committed correction (where it has got to) into `trial`. */
function loadTrial(save: HoleSave): void {
  trial.dx = save.dx;
  trial.dy = save.dy;
  trial.dz = save.dz;
  trial.dyaw = save.dyaw;
  trial.dpitch = save.dpitch;
  trial.t0 = save.t;
  trial.ease = false;
}

/** Switch a committed correction to its ease-out from the current rate. */
function cancel(save: HoleSave): void {
  // Already ramping out: let the profile finish. It stops sooner than an
  // ease from the same rate would, and lands on the totals exactly — an
  // ease from here would overshoot them (by up to ~2%, past the caps).
  if (save.t >= SAVE_TIME - SAVE_RAMP) return;
  // The rate falls linearly to zero over SAVE_RAMP (easeProfile, a
  // fraction of the same totals), so what is applied never exceeds them.
  save.easeV = profileRate(save.t);
  save.easeT = 0;
  save.t = -1;
}

function search(
  save: HoleSave,
  span: SaveSpan,
  st: FlightState,
  input: FlightInput,
  world: SaveWorld,
  clockMs: number | null,
  angles: boolean,
): void {
  clearTrial();
  const tHit = rollout(st, input, SAVE_HORIZON, world, clockMs);
  if (!(tHit < SAVE_HORIZON)) return; // clear, or out of budget
  const sg = travelSign(span, st.pos, st.yaw, st.pitch);
  if (sg === 0 || !onHoleSurface(span, hit, sg)) return;
  const bridge = !isTunnel(span) && span.hole.kind === "bridge";
  const posLeft = SAVE_MAX_OFFSET - save.usedPos;
  const angLeft = SAVE_MAX_ANGLE - save.usedAng;
  for (const c of SAVE_CANDIDATES) {
    // Under a bridge only the vertical plane can help (the channel is 120 m
    // wide); instructor modes never tweak the attitude.
    if (bridge && (c.l !== 0 || c.a !== 0)) continue;
    if (!angles && (c.a !== 0 || c.p !== 0)) continue;
    const pos = Math.hypot(c.l, c.v) * SAVE_MAX_OFFSET;
    const ang = Math.hypot(c.a, c.p) * SAVE_MAX_ANGLE;
    if (pos > posLeft + 1e-9 || ang > angLeft + 1e-9) continue;
    setTrial(c, span, st);
    const t = rollout(st, input, SAVE_CLEAR_HORIZON, world, clockMs);
    if (Number.isNaN(t)) break; // budget spent: no save this frame
    if (t === Number.POSITIVE_INFINITY) {
      save.dx = trial.dx;
      save.dy = trial.dy;
      save.dz = trial.dz;
      save.dyaw = trial.dyaw;
      save.dpitch = trial.dpitch;
      save.t = 0;
      save.easeT = -1;
      save.span = span;
      save.usedPos += pos;
      save.usedAng += ang;
      save.saves++;
      break;
    }
  }
  clearTrial();
}

const before: Vec3 = { x: 0, y: 0, z: 0 };

/** detectCrash's solids for the plane's sphere at `p` on `clockMs`. */
function solidAt(world: SaveWorld, p: Vec3, clockMs: number | null): boolean {
  return touchesSolid(
    p,
    RADIUS,
    world.buildings,
    world.index,
    world.movers,
    clockMs,
    world.nature,
  );
}

/** Advance the committed (or easing) correction by `dt` and apply it. */
function apply(
  save: HoleSave,
  st: FlightState,
  dt: number,
  world: SaveWorld,
  clockMs: number | null,
): boolean {
  let f: number;
  if (save.t >= 0) {
    const t1 = Math.min(save.t + dt, SAVE_TIME);
    f = profile(t1) - profile(save.t);
    save.t = t1 >= SAVE_TIME ? -1 : t1;
  } else if (save.easeT >= 0) {
    const e1 = Math.min(save.easeT + dt, SAVE_RAMP);
    f = easeProfile(save.easeV, e1) - easeProfile(save.easeV, save.easeT);
    save.easeT = e1 >= SAVE_RAMP ? -1 : e1;
  } else {
    return false;
  }
  if (f <= 0) return false;
  before.x = st.pos.x;
  before.y = st.pos.y;
  before.z = st.pos.z;
  st.pos.x = wrap(st.pos.x + save.dx * f);
  st.pos.y += save.dy * f;
  st.pos.z = wrap(st.pos.z + save.dz * f);
  // Never INTO a solid: a slice that would touch one (where the plane did
  // not already) is dropped, and the save stops.
  if (solidAt(world, st.pos, clockMs) && !solidAt(world, before, clockMs)) {
    st.pos.x = before.x;
    st.pos.y = before.y;
    st.pos.z = before.z;
    save.t = -1;
    save.easeT = -1;
    return false;
  }
  st.yaw += save.dyaw * f;
  st.pitch = clamp(st.pitch + save.dpitch * f, -Math.PI / 2, Math.PI / 2);
  return true;
}
