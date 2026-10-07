// Street traffic (V3 → L6): deterministic cosmetic vehicles on the street grid
// that OBEY the L1 signals — they stop at red, queue nose to tail, and pull
// away one by one on green. Purely visual — zero netcode, zero collision, zero
// server involvement. Every vehicle's pose is still a PURE FUNCTION of
// (seed, server time), so all clients — late joiners included — see identical
// traffic with no per-frame integration state to drift. Same pure-layout /
// renderer split as streetlights.ts: the exported functions are the tested
// seam.
//
// HOW A PURE FUNCTION OF TIME OBEYS SIGNALS — three ideas, in order:
//
// 1. One LEADER trajectory per lane, built once by an event walk over the
//    lane's intersections: accelerate, cruise, and at each braking point
//    decide pass/stop from the signal's go window (signals.ts goWindowStart);
//    on a stop, brake to the stop line and wait for the go window. The walk
//    starts by leaving the lane's ANCHOR stop line at its green start and ends
//    stopped at the same line, so it departs again exactly a whole number of
//    signal cycles later: the trajectory is periodic, r(t + P) = r(t) + one
//    lap, with P = m · SIGNAL_CYCLE. Evaluating it is a lap index plus a
//    binary search over ~40 kinematic segments — nothing integrates.
// 2. QUEUES are Newell's car-following model: platoon member j drives the
//    leader's trajectory delayed by j·HEADWAY and set back by the lengths and
//    gaps ahead of it. Followers therefore stop nose to tail behind the leader
//    and pull away in a start-up wave, and since r never decreases two members
//    can never overlap. The leader only passes a light if its whole platoon
//    clears the box before red (the platoon-aware pass rule).
// 3. Several platoons share one lane by riding the SAME trajectory shifted by
//    whole signal cycles: a shift of k·SIGNAL_CYCLE meets identical signals, so
//    every platoon obeys them, and ≥ 2 cycles apart they never catch up.
//
// L1 reactive city (ANGE-WCQNFJ) appends MAX_RESPONDERS slots to the same
// mesh for the police cars and ambulances answering a death (reactions.ts —
// their own street routes, not the lane plans), and flashes the hazards
// (light-bar channel band 3) of any vehicle inside an alarm radius. Still one
// draw call.
//
// Emergency vehicles are the exception: they run the street CENTERLINE
// between the two lanes at a steady speed, light bar flashing, through reds.
// The centerline keeps them clear of every queue.
//
// Cross-engine determinism: the walk uses only + − × ÷ and Math.sqrt (all
// correctly rounded in every JS engine) — no pow/exp/trig — so a borderline
// pass/stop decision comes out the same on every client.

import { CITY_GRID, mulberry32 } from "@angels-bandits/common/city";
import {
  CROSSWALK_DEPTH,
  INTERSECTION_HALF,
  LANE_CENTERS,
} from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  EMISSIVE_BEACON,
  EMISSIVE_HAZARD,
  EMISSIVE_SIGN,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import {
  type CityReactions,
  MAX_RESPONDERS,
  type ResponderPose,
  alarmBlinkOn,
  alarmed,
} from "./reactions";
import { GO_WINDOW, GREEN, SIGNAL_CYCLE, goWindowStart } from "./signals";
import { nearestImage } from "./wrapPlacement";

/** Lane centerlines from the S1 street contract (±5 m, right-hand traffic). */
const [LANE_MINUS, LANE_PLUS] = LANE_CENTERS;

// --- The vehicle-type table ------------------------------------------------
// Extensible on purpose: L1's responders (and anything after) add a row here
// and a `code` branch in the shader, nothing else.

export type VehicleKind = "car" | "taxi" | "bus" | "emergency" | "police";

export interface VehicleSpec {
  /** Shader selector: 0 car, 1 taxi (roof sign), 2 bus (window band),
   * 3 emergency (light bar), 4 police (L1 responder; light bar). */
  code: number;
  /** Body box, meters; forward is −Z at yaw 0 (the plane convention). */
  length: number;
  width: number;
  height: number;
  /** Body colours; each vehicle picks one deterministically. */
  bodies: readonly number[];
}

export const VEHICLES: Record<VehicleKind, VehicleSpec> = {
  // Muted night palette.
  car: {
    code: 0,
    length: 4.2,
    width: 1.9,
    height: 1.4,
    bodies: [0x2a2d38, 0x3a2f2c, 0x24333a, 0x38323f, 0x2e3830],
  },
  taxi: { code: 1, length: 4.5, width: 1.9, height: 1.5, bodies: [0xd9a514] },
  bus: {
    code: 2,
    length: 11,
    width: 2.5,
    height: 3.1,
    bodies: [0x2c5470, 0x6b2f2a],
  },
  // Ambulances are pale so the light bar has something to wash across.
  emergency: {
    code: 3,
    length: 5.6,
    width: 2.1,
    height: 2.3,
    bodies: [0xf2f4f7],
  },
  // L1 responders only (never drawn into a lane platoon): a dark navy cruiser.
  police: {
    code: 4,
    length: 4.8,
    width: 1.95,
    height: 1.5,
    bodies: [0x1b2744],
  },
};

/** Light-bar channel value for a vehicle whose hazards are lit this beat
 * (L1 car alarms) — band 2.5–3.5 in the shader, never a light bar. */
const HAZARD_ON = 3;

// --- Kinematics and the signal contract ------------------------------------

/** Lane cruise speed band, m/s. */
const SPEED_MIN = 10;
const SPEED_SPAN = 4;
/** Pull-away acceleration and braking deceleration, m/s². */
export const ACCEL = 2.2;
export const BRAKE = 3.5;
/** Newell's start-up headway: each follower moves this long after the one
 * ahead of it, seconds. */
export const HEADWAY = 1.4;
/** Bumper-to-bumper gap in a stopped queue, meters. */
export const QUEUE_GAP = 2.5;
/** The stop line, meters before an intersection centre (front bumper): clear
 * of the box AND of the painted crosswalk, with a meter to spare. */
export const STOP_BACK = INTERSECTION_HALF + CROSSWALK_DEPTH + 1;
/** Slack between the last platoon member leaving the box and red, seconds. */
export const CLEAR_MARGIN = 0.5;
/** A platoon is only admitted on a lane if its leader may still pass when it
 * reaches the line this many seconds into green — so cars rarely stop with
 * plenty of green left. Bigger draws are trimmed from the tail. */
export const MIN_PASS_WINDOW = 12;
/** Platoon members, at most. */
const MAX_PLATOON = 4;
/** Platoons per lane, at most, and their minimum spacing in signal cycles. */
const MAX_PLATOONS = 4;
const PLATOON_SPACING = 2;
/** Speed searches before the walk accepts a forced anchor stop. */
const SPEED_TRIES = 8;

/** Emergency vehicles on the road. */
export const EMERGENCY_CARS = 2;
/** Slots along a centerline an emergency vehicle can start from. */
export const EMERGENCY_SLOTS = 4;
/** Emergency cruise speed, m/s — a touch over the fastest lane. */
export const EMERGENCY_SPEED = 17;
/** Light-bar alternation beat, seconds — red side, then blue side. */
export const SIREN_BEAT = 0.22;

const mod = (v: number, m: number): number => ((v % m) + m) % m;
const wrapGrid = (i: number): number => mod(i, CITY_GRID);

// --- Lanes -----------------------------------------------------------------

/** One directed traffic lane: a full torus loop parallel to a street line. */
export interface TrafficLane {
  /** Stable id, used to seed this lane's PRNG stream. */
  id: number;
  /** World axis the lane runs along ('z' lanes belong to north–south streets). */
  axis: "x" | "z";
  /** Canonical coordinate on the OTHER axis (a contract lane center). */
  cross: number;
  /** Direction of travel along `axis`. */
  dir: 1 | -1;
}

/**
 * The full lane graph, deterministic from the block grid: every street line
 * (each BLOCK_PITCH multiple, both axes) carries two lanes on the contract's
 * lane centers, driving opposite directions — right-hand traffic. Lanes are
 * complete torus loops of length WORLD_SIZE. Lanes 2i and 2i + 1 share a street.
 */
export function trafficLanes(): TrafficLane[] {
  const lanes: TrafficLane[] = [];
  for (const axis of ["z", "x"] as const) {
    for (let line = 0; line < CITY_GRID; line++) {
      const center = line * BLOCK_PITCH;
      // canonicalize wraps line 0's negative-side lane to WORLD_SIZE − offset.
      const minus = canonicalize({ x: center + LANE_MINUS, y: 0, z: 0 }).x;
      const plus = center + LANE_PLUS;
      // Right-hand traffic: on a 'z' street the +x side drives +z.
      lanes.push(
        { id: lanes.length, axis, cross: minus, dir: axis === "z" ? -1 : 1 },
        { id: lanes.length + 1, axis, cross: plus, dir: axis === "z" ? 1 : -1 },
      );
    }
  }
  return lanes;
}

/** The street line (0..CITY_GRID−1) a lane belongs to. Wrapped, so line 0's
 * negative-side lane at 1995 is line 0, not line 10. */
export const laneLine = (lane: TrafficLane): number =>
  wrapGrid(Math.round(lane.cross / BLOCK_PITCH));

/** The signal axis a lane obeys: 'z' lanes are north–south traffic. */
export const laneSignalAxis = (lane: TrafficLane): "ns" | "ew" =>
  lane.axis === "z" ? "ns" : "ew";

/**
 * Lane space: u = dir · along, so u always grows in the direction of travel
 * and intersections sit at u = k · BLOCK_PITCH. This is the block whose
 * south-west corner — the intersection signals.ts lights — lies at lane
 * intersection k.
 */
export function laneBlock(
  lane: TrafficLane,
  k: number,
): { bx: number; bz: number } {
  const line = laneLine(lane);
  const along = wrapGrid(lane.dir * k);
  return lane.axis === "z" ? { bx: line, bz: along } : { bx: along, bz: line };
}

/** Heading for a lane: forward is −Z at yaw 0 (the plane convention), so
 * +Z travel → π, −Z → 0, +X → −π/2, −X → π/2. */
export const laneYaw = (lane: TrafficLane): number => {
  if (lane.axis === "z") return lane.dir === 1 ? Math.PI : 0;
  return lane.dir === 1 ? -Math.PI / 2 : Math.PI / 2;
};

// --- Platoons ----------------------------------------------------------------

export interface PlatoonMember {
  kind: VehicleKind;
  body: number;
  /** Meters this member's front bumper trails the leader's. */
  back: number;
  /** Seconds this member trails the leader (Newell's j · HEADWAY). */
  lag: number;
}

export interface Platoon {
  members: PlatoonMember[];
  /** Leader's front bumper to the tail's rear bumper, meters. */
  length: number;
  /** The tail's lag, seconds. */
  lag: number;
}

/** Seconds after the leader reaches the stop line at cruise until the tail
 * leaves the box: the pass rule's clearance term. */
export const cruiseClearance = (p: Platoon, speed: number): number =>
  (STOP_BACK + INTERSECTION_HALF + p.length) / speed + p.lag;

/** Time from rest to cover `d` meters at ACCEL, capped at `speed`. */
const timeFromRest = (d: number, speed: number): number => {
  const accelDist = (speed * speed) / (2 * ACCEL);
  if (d <= accelDist) return Math.sqrt((2 * d) / ACCEL);
  return speed / ACCEL + (d - accelDist) / speed;
};

/** Seconds after a standing leader pulls away until the tail leaves the box. */
export const restClearance = (p: Platoon, speed: number): number =>
  timeFromRest(STOP_BACK + INTERSECTION_HALF + p.length, speed) + p.lag;

const PASS_BUDGET = GO_WINDOW - CLEAR_MARGIN - MIN_PASS_WINDOW;

function buildPlatoon(kinds: VehicleKind[], bodies: number[]): Platoon {
  const members: PlatoonMember[] = [];
  let back = 0;
  for (let j = 0; j < kinds.length; j++) {
    const kind = kinds[j] as VehicleKind;
    members.push({ kind, body: bodies[j] as number, back, lag: j * HEADWAY });
    back += VEHICLES[kind].length + QUEUE_GAP;
  }
  return {
    members,
    length: back - QUEUE_GAP,
    lag: (kinds.length - 1) * HEADWAY,
  };
}

/** Draw one platoon: 1–4 members, at most one bus, trimmed from the tail
 * until it fits the lane's pass budget. A fixed number of draws per member
 * whatever is trimmed, so the stream never depends on the trimming. */
function drawPlatoon(rand: () => number, speed: number): Platoon {
  const r = rand();
  const size = r < 0.4 ? 1 : r < 0.75 ? 2 : r < 0.92 ? 3 : MAX_PLATOON;
  const kinds: VehicleKind[] = [];
  const bodies: number[] = [];
  let bus = false;
  for (let j = 0; j < MAX_PLATOON; j++) {
    const pick = rand();
    const shade = rand();
    if (j >= size) continue;
    const kind: VehicleKind =
      pick < 0.09 && !bus ? "bus" : pick < 0.31 ? "taxi" : "car";
    if (kind === "bus") bus = true;
    const palette = VEHICLES[kind].bodies;
    kinds.push(kind);
    bodies.push(palette[Math.floor(shade * palette.length)] as number);
  }
  let platoon = buildPlatoon(kinds, bodies);
  while (kinds.length > 1 && cruiseClearance(platoon, speed) > PASS_BUDGET) {
    kinds.pop();
    bodies.pop();
    platoon = buildPlatoon(kinds, bodies);
  }
  return platoon;
}

// --- The leader walk -----------------------------------------------------------

/** One kinematic piece of the leader trajectory, valid from t0 until the next
 * segment's t0: u(t) = u0 + v0·dt + a·dt²/2. */
export interface Segment {
  t0: number;
  u0: number;
  v0: number;
  a: number;
}

/** A leader stop, for the "how often does a car stop at green" tests. */
export interface LeaderStop {
  /** When the leader would have reached the stop line at cruise. */
  t: number;
  /** Lane intersection index. */
  k: number;
  /** Seconds of green left at `t` (0 when amber or red). */
  greenLeft: number;
}

export interface LanePlan {
  lane: TrafficLane;
  /** Cruise speed, m/s. */
  speed: number;
  /** Lane intersection index the periodic walk starts and ends at. */
  anchor: number;
  /** Server time (seconds, in [0, SIGNAL_CYCLE)) the walk's leader leaves
   * the anchor. */
  t0: number;
  /** Lap period, seconds — an exact whole number of signal cycles. */
  period: number;
  segments: Segment[];
  platoons: Platoon[];
  /** Each platoon's delay behind the reference trajectory, seconds — whole
   * signal cycles. */
  shifts: number[];
  /** True if no anchor/speed gave a natural stop at the anchor and the walk
   * had to stop there anyway. Tests assert this never happens. */
  forced: boolean;
  stops: LeaderStop[];
}

interface Walk {
  segments: Segment[];
  stops: LeaderStop[];
  period: number;
  t0: number;
  natural: boolean;
}

/**
 * Walk the leader once round the lane from the anchor stop line, deciding
 * every light, and close the lap at the anchor.
 */
function walkLane(
  starts: readonly number[],
  speed: number,
  anchor: number,
  platoons: readonly Platoon[],
): Walk {
  const C = SIGNAL_CYCLE;
  let cruiseClear = 0;
  let restClear = 0;
  for (const p of platoons) {
    cruiseClear = Math.max(cruiseClear, cruiseClearance(p, speed));
    restClear = Math.max(restClear, restClearance(p, speed));
  }
  const accelT = speed / ACCEL;
  const accelD = (speed * speed) / (2 * ACCEL);
  const brakeT = speed / BRAKE;
  const brakeD = (speed * speed) / (2 * BRAKE);
  const t0 = starts[anchor] as number;
  const u0 = anchor * BLOCK_PITCH - STOP_BACK;
  const segments: Segment[] = [];
  const stops: LeaderStop[] = [];
  // Cruise origin: where and when the current cruise segment began.
  let tc = 0;
  let uc = 0;
  const depart = (t: number, u: number) => {
    segments.push({ t0: t, u0: u, v0: 0, a: ACCEL });
    tc = t + accelT;
    uc = u + accelD;
    segments.push({ t0: tc, u0: uc, v0: speed, a: 0 });
  };
  depart(t0, u0);
  for (let i = 1; i <= CITY_GRID; i++) {
    const k = (anchor + i) % CITY_GRID;
    const start = starts[k] as number;
    const uStop = u0 + i * BLOCK_PITCH;
    const uBrake = uStop - brakeD;
    const tBrake = tc + (uBrake - uc) / speed;
    // When the leader would reach the line if it kept going.
    const tLine = tBrake + brakeD / speed;
    const q = mod(tLine - start, C);
    const green = q < GREEN;
    const passes =
      green && tLine + cruiseClear <= tLine - q + GO_WINDOW - CLEAR_MARGIN;
    const last = i === CITY_GRID;
    if (passes && !last) continue;
    segments.push({ t0: tBrake, u0: uBrake, v0: speed, a: -BRAKE });
    const tStop = tBrake + brakeT;
    stops.push({ t: tLine, k, greenLeft: green ? GREEN - q : 0 });
    segments.push({ t0: tStop, u0: uStop, v0: 0, a: 0 });
    const qs = mod(tStop - start, C);
    if (last) {
      // Close the lap: leave on a green START so the next lap is this one
      // again. A natural close arrives on amber or red.
      const end = qs === 0 ? tStop : tStop - qs + C;
      return {
        segments,
        stops,
        period: Math.round((end - t0) / C) * C,
        t0,
        natural: !green,
      };
    }
    // Go as soon as the light allows: straight away if it is (or turned)
    // green while braking and the platoon still clears, else at next green.
    const now =
      qs < GREEN && tStop + restClear <= tStop - qs + GO_WINDOW - CLEAR_MARGIN;
    depart(now ? tStop : tStop - qs + C, uStop);
  }
  throw new Error("unreachable: the walk always closes at the anchor");
}

/**
 * The full plan for one lane: speed, platoons, the periodic leader walk and
 * the platoon shifts. A pure function of (lane, seed).
 */
export function planLane(lane: TrafficLane, seed: number): LanePlan {
  const rand = mulberry32(
    (seed ^ Math.imul(lane.id + 1, 0x2545f491) ^ 0x7a1f6b) >>> 0,
  );
  const axis = laneSignalAxis(lane);
  const starts = Array.from({ length: CITY_GRID }, (_, k) => {
    const { bx, bz } = laneBlock(lane, k);
    return goWindowStart(bx, bz, axis, seed);
  });
  type Pick = {
    speed: number;
    anchor: number;
    platoons: Platoon[];
    walk: Walk;
  };
  let fallback: Pick | null = null;
  let chosen: Pick | null = null;
  for (let attempt = 0; attempt < SPEED_TRIES && !chosen; attempt++) {
    const speed = SPEED_MIN + rand() * SPEED_SPAN;
    const platoons = Array.from({ length: MAX_PLATOONS }, () =>
      drawPlatoon(rand, speed),
    );
    const first = Math.floor(rand() * CITY_GRID);
    for (let j = 0; j < CITY_GRID; j++) {
      const anchor = (first + j) % CITY_GRID;
      const walk = walkLane(starts, speed, anchor, platoons);
      if (walk.natural) {
        chosen = { speed, anchor, platoons, walk };
        break;
      }
      fallback ??= { speed, anchor, platoons, walk };
    }
  }
  const pick = chosen ?? fallback;
  if (!pick) throw new Error("unreachable: at least one walk ran");
  // Whole-cycle platoon spacing, ≥ PLATOON_SPACING everywhere including the
  // wrap gap from the last platoon to the first one's next lap.
  const cycles = Math.round(pick.walk.period / SIGNAL_CYCLE);
  const count = Math.max(
    1,
    Math.min(MAX_PLATOONS, Math.floor(cycles / PLATOON_SPACING)),
  );
  const gaps = new Array<number>(count).fill(PLATOON_SPACING);
  for (let spare = cycles - count * PLATOON_SPACING; spare > 0; spare--) {
    const g = Math.floor(rand() * count);
    gaps[g] = (gaps[g] as number) + 1;
  }
  const shifts: number[] = [];
  let shift = 0;
  for (let p = 0; p < count; p++) {
    shifts.push(shift * SIGNAL_CYCLE);
    shift += gaps[p] as number;
  }
  return {
    lane,
    speed: pick.speed,
    anchor: pick.anchor,
    t0: pick.walk.t0,
    period: pick.walk.period,
    segments: pick.walk.segments,
    platoons: pick.platoons.slice(0, count),
    shifts,
    forced: !chosen,
    stops: pick.walk.stops,
  };
}

/** Leader state at server time `t`, seconds: lane-space front bumper `u`
 * (unbounded — one WORLD_SIZE per lap), speed and acceleration. */
export interface LeaderState {
  u: number;
  speed: number;
  accel: number;
}

export function leaderAt(
  plan: LanePlan,
  t: number,
  out: LeaderState,
): LeaderState {
  const rel = t - plan.t0;
  const lap = Math.floor(rel / plan.period);
  // `period` is a whole number of seconds, so lap · period is exact.
  let tl = rel - lap * plan.period;
  if (tl < 0) tl = 0;
  if (tl >= plan.period) tl = plan.period;
  const segs = plan.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((segs[mid] as Segment).t0 - plan.t0 <= tl) lo = mid;
    else hi = mid - 1;
  }
  const seg = segs[lo] as Segment;
  const dt = tl - (seg.t0 - plan.t0);
  out.u = seg.u0 + seg.v0 * dt + 0.5 * seg.a * dt * dt + lap * WORLD_SIZE;
  out.speed = Math.max(0, seg.v0 + seg.a * dt);
  out.accel = seg.a;
  return out;
}

// --- The fleet ----------------------------------------------------------------

/** One emergency vehicle's slot: a lane (its street and direction) and a
 * starting slot along the centerline. */
export interface EmergencyCar {
  laneId: number;
  carIndex: number;
}

/**
 * Which streets carry an ambulance, drawn from the world seed — so every tab
 * has the same ambulance in the same street, flashing on the same server-time
 * beat. Always on DISTINCT streets: two on one centerline driving opposite
 * ways would pass straight through each other.
 */
export function emergencyCars(seed: number): EmergencyCar[] {
  const laneCount = trafficLanes().length;
  const rand = mulberry32((seed ^ 0x4d454447) >>> 0);
  const streets = new Set<number>();
  const out: EmergencyCar[] = [];
  // Bounded: the cap makes the loop terminate whatever the PRNG does.
  for (let guard = 0; guard < 64 && out.length < EMERGENCY_CARS; guard++) {
    const laneId = Math.floor(rand() * laneCount);
    const carIndex = Math.floor(rand() * EMERGENCY_SLOTS);
    if (streets.has(laneId >> 1)) continue;
    streets.add(laneId >> 1);
    out.push({ laneId, carIndex });
  }
  return out;
}

/**
 * The light-bar state of an ambulance at server time `timeSeconds`:
 * 1 = red side lit, 2 = blue side lit — a real bar alternates rather than
 * blinking dark. A pure function of the synced clock, so two tabs strobe on
 * the same beat.
 */
export function sirenState(timeSeconds: number): 1 | 2 {
  let beat = Math.floor(timeSeconds / SIREN_BEAT) % 4;
  if (beat < 0) beat += 4;
  return beat < 2 ? 1 : 2;
}

export interface TrafficVehicle {
  kind: VehicleKind;
  body: number;
  /** Lane id (= index into fleet.plans and fleet.lanes). */
  lane: number;
  /** Platoon index on the lane, or −1 for an emergency runner. */
  platoon: number;
  /** Seconds behind the lane's reference trajectory: platoon shift + lag. */
  delay: number;
  /** Meters the front bumper trails the reference front bumper. */
  back: number;
  /** Emergency runners: centerline start (lane space, m) and speed. */
  runner: { u0: number; speed: number } | null;
}

export interface TrafficFleet {
  lanes: TrafficLane[];
  plans: LanePlan[];
  vehicles: TrafficVehicle[];
}

/** Every vehicle in the city, platoon traffic first, emergency runners last. */
export function trafficFleet(seed: number): TrafficFleet {
  const lanes = trafficLanes();
  const plans = lanes.map((lane) => planLane(lane, seed));
  const vehicles: TrafficVehicle[] = [];
  for (const plan of plans) {
    plan.platoons.forEach((platoon, p) => {
      for (const m of platoon.members) {
        vehicles.push({
          kind: m.kind,
          body: m.body,
          lane: plan.lane.id,
          platoon: p,
          delay: (plan.shifts[p] as number) + m.lag,
          back: m.back,
          runner: null,
        });
      }
    });
  }
  for (const { laneId, carIndex } of emergencyCars(seed)) {
    vehicles.push({
      kind: "emergency",
      body: VEHICLES.emergency.bodies[0] as number,
      lane: laneId,
      platoon: -1,
      delay: 0,
      back: 0,
      runner: {
        u0: (carIndex * WORLD_SIZE) / EMERGENCY_SLOTS + BLOCK_PITCH / 2,
        speed: EMERGENCY_SPEED,
      },
    });
  }
  return { lanes, plans, vehicles };
}

/** A vehicle's state, written in place (the renderer allocates nothing). */
export interface VehicleState {
  /** Front bumper, lane space, unbounded. */
  front: number;
  /** Canonical ground position of the body centre. */
  x: number;
  z: number;
  yaw: number;
  speed: number;
  /** Braking or standing — the brake lights. */
  braking: boolean;
}

export const newVehicleState = (): VehicleState => ({
  front: 0,
  x: 0,
  z: 0,
  yaw: 0,
  speed: 0,
  braking: false,
});

const scratchLeader: LeaderState = { u: 0, speed: 0, accel: 0 };

/** Where vehicle `v` is at server time `t` (seconds). Pure. */
export function vehicleState(
  fleet: TrafficFleet,
  v: TrafficVehicle,
  t: number,
  out: VehicleState,
): VehicleState {
  const lane = fleet.lanes[v.lane] as TrafficLane;
  let cross = lane.cross;
  if (v.runner) {
    out.front = v.runner.u0 + v.runner.speed * t;
    out.speed = v.runner.speed;
    out.braking = false;
    // The street centerline, between the two lanes.
    cross = laneLine(lane) * BLOCK_PITCH;
  } else {
    const s = leaderAt(
      fleet.plans[v.lane] as LanePlan,
      t - v.delay,
      scratchLeader,
    );
    out.front = s.u - v.back;
    out.speed = s.speed;
    out.braking = s.accel < 0 || s.speed < 0.05;
  }
  const centre = out.front - VEHICLES[v.kind].length / 2;
  const along = mod(lane.dir * centre, WORLD_SIZE);
  if (lane.axis === "x") {
    out.x = along;
    out.z = cross;
  } else {
    out.x = cross;
    out.z = along;
  }
  out.yaw = laneYaw(lane);
  return out;
}

/** A vehicle's rendered state: canonical ground position + heading. Forward
 * is −Z at yaw 0 — the same convention the planes use. */
export interface CarPose {
  pos: Vec3;
  yaw: number;
}

/** Allocating convenience for tests and QA. */
export function vehiclePose(
  fleet: TrafficFleet,
  v: TrafficVehicle,
  t: number,
): CarPose {
  const s = vehicleState(fleet, v, t, newVehicleState());
  return { pos: { x: s.x, y: 0, z: s.z }, yaw: s.yaw };
}

/** A red-light queue the gallery can point a camera at. */
export interface QueueSighting {
  laneId: number;
  /** Lane intersection index. */
  k: number;
  bx: number;
  bz: number;
  axis: "ns" | "ew";
  /** Vehicles standing behind the line. */
  count: number;
  /** Canonical stop-line position on the lane, and the lane's heading. */
  x: number;
  z: number;
  yaw: number;
}

/**
 * QA: the longest standing queue anywhere at server time `t` (ties → lowest
 * lane id, then intersection). Used to pin the gallery's red/green views.
 */
export function findQueue(
  fleet: TrafficFleet,
  t: number,
): QueueSighting | null {
  const counts = new Map<number, number>();
  const s = newVehicleState();
  for (const v of fleet.vehicles) {
    if (v.runner) continue;
    vehicleState(fleet, v, t, s);
    if (s.speed > 0.05) continue;
    const k = Math.round((s.front + STOP_BACK) / BLOCK_PITCH);
    const toLine = k * BLOCK_PITCH - STOP_BACK - s.front;
    if (toLine < -0.01 || toLine > 60) continue;
    const key = v.lane * CITY_GRID + wrapGrid(k);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: [number, number] | null = null;
  for (const [key, count] of counts) {
    if (!best || count > best[1] || (count === best[1] && key < best[0])) {
      best = [key, count];
    }
  }
  if (!best) return null;
  const laneId = Math.floor(best[0] / CITY_GRID);
  const k = best[0] % CITY_GRID;
  const lane = fleet.lanes[laneId] as TrafficLane;
  const { bx, bz } = laneBlock(lane, k);
  const along = mod(lane.dir * (k * BLOCK_PITCH - STOP_BACK), WORLD_SIZE);
  return {
    laneId,
    k,
    bx,
    bz,
    axis: laneSignalAxis(lane),
    count: best[1],
    x: lane.axis === "x" ? along : lane.cross,
    z: lane.axis === "x" ? lane.cross : along,
    yaw: laneYaw(lane),
  };
}

// --- Renderer (consumes the pure model above; untested, like Streetlights) ---

/** Headlight emissive, linear HDR. Luminance ≈ 1.0 — above the window peak
 * (~0.94), well below tracers (~1.5): V1's emissive-ladder rule. */
const HEADLIGHT = "vec3(1.05, 1.0, 0.9)";
/** Taillight emissive. Red carries little luminance, so the red channel is
 * pushed hard to clear the 0.72 bloom threshold: luminance ≈ 0.85, just
 * under the lamp heads (~0.87). Unchanged by L6 — moving traffic reads from
 * altitude exactly as before. */
const TAILLIGHT = "vec3(3.4, 0.16, 0.14)";

/**
 * A ladder-derived GLSL literal. The existing HEADLIGHT/TAILLIGHT literals
 * above were hand-tuned and have since drifted off-ladder (the headlight
 * computes to luminance 1.003, above EMISSIVE_LAMP); new lights are DERIVED
 * from a rung instead of adding more drifting literals.
 */
const ladderVec3 = (hex: number, rung: number): string => {
  const c = new THREE.Color(hex);
  c.multiplyScalar(emissiveBoost(c, rung));
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};
/** Sirens sit on the BEACON rung — a light bar is literally a beacon, and it
 * is still two rungs under EMISSIVE_TRACER. */
const SIREN_RED = ladderVec3(0xff1a1f, EMISSIVE_BEACON);
const SIREN_BLUE = ladderVec3(0x2a55ff, EMISSIVE_BEACON);
/** Brake lights: the taillight slot, brightened onto the SIGN rung while a
 * car brakes or stands — the queue reads as a red chain at the stop line. */
const BRAKE_LIGHT = ladderVec3(0xff1410, EMISSIVE_SIGN);
/** A taxi's roof sign is a sign. */
const TAXI_SIGN = ladderVec3(0xffd34a, EMISSIVE_SIGN);
/** A bus's lit cabin: warm, deliberately SUB-bloom (0.55) — a glow behind
 * glass, not a light source. */
const BUS_CABIN = ladderVec3(0xffd6a0, 0.55);
/** L1 car-alarm hazard amber, on its own HAZARD rung (just under the lamps). */
const HAZARD_AMBER = ladderVec3(0xffa21a, EMISSIVE_HAZARD);

const VERTEX_PARS = /* glsl */ `
// Three aliases the attribute KEYWORD via "#define attribute in", but it
// injects no declaration for a custom attribute — these lines are required.
attribute vec4 aBody;
attribute vec2 aLamp;
varying vec3 vCarPos;
varying vec3 vCarNormal;
varying vec3 vDims;
varying float vKind;
varying float vBrake;
varying float vSiren;
`;

const VERTEX_MAIN = /* glsl */ `
// The geometry is a unit box (wheels at y = 0); aBody.xyz scales it to this
// vehicle in OBJECT space, so the instance matrix stays rotation +
// translation and the light patterns below work in true meters. Scaling an
// axis-aligned box leaves its face normals unchanged.
transformed *= aBody.xyz;
vCarPos = transformed;
vCarNormal = normal;
vDims = aBody.xyz;
vKind = aBody.w;
vBrake = aLamp.x;
vSiren = aLamp.y;
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vCarPos;
varying vec3 vCarNormal;
varying vec3 vDims;
varying float vKind;
varying float vBrake;
varying float vSiren;
`;

const FRAGMENT_MAIN = /* glsl */ `
// Kinds are compared by BAND, never by equality: an interpolated varying is
// not bit-exact across the perspective divide.
bool abBus = vKind > 1.5 && vKind < 2.5;
// Paired light dots on the front (−Z) and rear (+Z) faces, in object space.
// Oversized vs real lights on purpose: they must read from flight altitude,
// where bloom merges each pair into one glow.
float abLampX = vDims.x * 0.5 - 0.45;
float abLampY = abBus ? 0.85 : 0.6;
vec2 abFace = vec2(abs(vCarPos.x), vCarPos.y);
// L1 hazards: light-bar channel band 2.5–3.5 lights amber over the head and
// tail dots this beat.
float abHazard = step(2.5, vSiren) * step(vSiren, 3.5);
if (vCarNormal.z < -0.5) {
  float headDist = distance(abFace, vec2(abLampX, abLampY));
  float head = 1.0 - smoothstep(0.28, 0.5, headDist);
  totalEmissiveRadiance += head * mix(${HEADLIGHT}, ${HAZARD_AMBER}, abHazard);
} else if (vCarNormal.z > 0.5) {
  float tailDist = distance(abFace, vec2(abLampX + 0.05, abLampY - 0.05));
  float tail = 1.0 - smoothstep(0.22 + 0.06 * vBrake, 0.4 + 0.08 * vBrake, tailDist);
  vec3 tailLight = mix(${TAILLIGHT}, ${BRAKE_LIGHT}, vBrake);
  totalEmissiveRadiance += tail * mix(tailLight, ${HAZARD_AMBER}, abHazard);
}
// Bus: a lit cabin band down both sides, broken by window pillars.
if (abBus && abs(vCarNormal.x) > 0.5) {
  float band = step(1.45, vCarPos.y) * (1.0 - step(2.55, vCarPos.y));
  float pane = step(0.18, fract(vCarPos.z / 1.35));
  float ends = 1.0 - step(vDims.z * 0.5 - 0.6, abs(vCarPos.z));
  totalEmissiveRadiance += band * pane * ends * ${BUS_CABIN};
}
if (vCarNormal.y > 0.5) {
  // Taxi: the roof sign.
  if (vKind > 0.5 && vKind < 1.5) {
    vec2 d = abs(vCarPos.xz) - vec2(0.38, 0.22);
    float sign = 1.0 - step(0.0, max(d.x, d.y));
    totalEmissiveRadiance += sign * ${TAXI_SIGN};
  }
  // Emergency light bar: red side, then blue side, on the server-time beat.
  // Band 0.5–2.5 only: 3 is the L1 hazard flash, not a bar.
  if (vSiren > 0.5 && vSiren < 2.5) {
    float redSide = step(vSiren, 1.5);
    float dRed = distance(vCarPos.xz, vec2(-0.55, 0.0));
    float dBlue = distance(vCarPos.xz, vec2(0.55, 0.0));
    totalEmissiveRadiance +=
      (1.0 - smoothstep(0.18, 0.42, dRed)) * redSide * ${SIREN_RED};
    totalEmissiveRadiance +=
      (1.0 - smoothstep(0.18, 0.42, dBlue)) * (1.0 - redSide) * ${SIREN_BLUE};
  }
}
`;

/** Dark vehicle body + procedural lights (same onBeforeCompile idiom as
 * buildings-material.ts — emissives only, bloom does the glow). */
function createCarMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.6,
    metalness: 0.4,
  });
  // Three keys its program cache on onBeforeCompile.toString() by default.
  // This patch body is TEXTUALLY identical to buildings-material's (same
  // idiom, same local names), so without an explicit key the cars silently
  // reuse the buildings' compiled program and the light dots never appear.
  material.customProgramCacheKey = () => "ab-traffic-l6-l1-hazard";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${VERTEX_MAIN}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${FRAGMENT_MAIN}`,
      );
  };
  return material;
}

/**
 * The instanced traffic renderer: every vehicle in ONE InstancedMesh, poses
 * from the pure model above, drawn — like everything else — at the torus
 * image nearest the camera. Hidden until the server clock estimate exists, so
 * all clients only ever show clock-agreed traffic.
 *
 * It also publishes, per frame, where each vehicle was drawn (`frame`), so the
 * headlight renderer lights exactly the cars on screen.
 */
export class Traffic {
  readonly mesh: THREE.InstancedMesh;
  readonly fleet: TrafficFleet;
  /** Rendered vehicles this frame: x, z, yaw, half-width per vehicle (the
   * front bumper centre, nearest image) — see `drawn`. */
  readonly frame: Float32Array;
  private drawnCount = 0;
  /** Per-instance brake (x) and light-bar (y) state, rewritten every frame. */
  private readonly lamp: THREE.InstancedBufferAttribute;
  /** Per-instance body dims + kind; responder slots are rewritten on change. */
  private readonly body: THREE.InstancedBufferAttribute;
  /** L1: which kind each responder slot is currently dressed as. */
  private readonly responderKind: ("police" | "ambulance" | null)[] = new Array(
    MAX_RESPONDERS,
  ).fill(null);
  private readonly bodyColor = new THREE.Color();
  private static readonly HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly state = newVehicleState();
  private readonly scratch = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private static readonly UNIT = new THREE.Vector3(1, 1, 1);

  constructor(seed: number) {
    this.fleet = trafficFleet(seed);
    // L1: responder slots ride the end of the same mesh (0 new draws).
    const capacity = this.fleet.vehicles.length + MAX_RESPONDERS;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0); // wheels on the street

    // Instanced attributes on the per-Traffic BoxGeometry are safe:
    // WebGLBindingStates takes the divisor from meshPerAttribute and skips the
    // _maxInstanceCount override for an isInstancedMesh draw.
    const body = new Float32Array(capacity * 4);
    this.fleet.vehicles.forEach((v, i) => {
      const spec = VEHICLES[v.kind];
      body.set([spec.width, spec.height, spec.length, spec.code], i * 4);
    });
    this.body = new THREE.InstancedBufferAttribute(body, 4);
    geometry.setAttribute("aBody", this.body);
    this.lamp = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 2),
      2,
    );
    this.lamp.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aLamp", this.lamp);
    this.frame = new Float32Array(this.fleet.vehicles.length * 4);

    this.mesh = new THREE.InstancedMesh(
      geometry,
      createCarMaterial(),
      capacity,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // instances move relative to the camera every frame
    this.mesh.visible = false; // until the first server clock estimate

    const color = new THREE.Color();
    this.fleet.vehicles.forEach((v, i) => {
      this.mesh.setColorAt(i, color.setHex(v.body));
    });
    for (let k = 0; k < MAX_RESPONDERS; k++) {
      const slot = this.fleet.vehicles.length + k;
      this.mesh.setMatrixAt(slot, Traffic.HIDDEN);
      this.mesh.setColorAt(slot, color.setHex(VEHICLES.police.bodies[0] ?? 0));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Vehicles in the fleet (the lane traffic; responder slots excluded). */
  get capacity(): number {
    return this.fleet.vehicles.length;
  }

  /** Vehicles written to `frame` last update (0 while hidden). */
  get drawn(): number {
    return this.drawnCount;
  }

  /** Place every vehicle for server time `serverTimeMs` (null = clock unknown → hide).
   * `reactions` (L1) adds the responders and lights alarmed vehicles' hazards. */
  update(
    cameraPos: Vec3,
    serverTimeMs: number | null,
    reactions?: CityReactions,
  ): void {
    if (serverTimeMs === null) {
      this.mesh.visible = false;
      this.drawnCount = 0;
      return;
    }
    this.mesh.visible = true;
    const t = serverTimeMs / 1000;
    // One siren state for the whole fleet: the flash is a function of server
    // time alone, so both ambulances beat together and so do both tabs.
    const flash = sirenState(t);
    // Alarms only matter on the lit half of the blink, and only while a
    // source is ringing — otherwise the per-vehicle check is skipped.
    const alarms =
      reactions !== undefined &&
      reactions.wakeCount > 0 &&
      alarmBlinkOn(serverTimeMs)
        ? reactions
        : null;
    const s = this.state;
    const { vehicles } = this.fleet;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i] as TrafficVehicle;
      vehicleState(this.fleet, v, t, s);
      const p = nearestImage(cameraPos, { x: s.x, y: 0, z: s.z });
      this.quat.setFromAxisAngle(Traffic.UP, s.yaw);
      this.pos.set(p.x, 0, p.z);
      this.scratch.compose(this.pos, this.quat, Traffic.UNIT);
      this.mesh.setMatrixAt(i, this.scratch);
      const hazard = !v.runner && alarms !== null && alarmed(alarms, s.x, s.z);
      this.lamp.setXY(
        i,
        s.braking ? 1 : 0,
        v.runner ? flash : hazard ? HAZARD_ON : 0,
      );
      // Front bumper centre: half a length forward (forward = −Z at yaw 0).
      const half = VEHICLES[v.kind].length / 2;
      const f = i * 4;
      this.frame[f] = p.x - Math.sin(s.yaw) * half;
      this.frame[f + 1] = p.z - Math.cos(s.yaw) * half;
      this.frame[f + 2] = s.yaw;
      this.frame[f + 3] = VEHICLES[v.kind].width / 2;
    }
    this.drawnCount = vehicles.length;
    this.placeResponders(cameraPos, flash, reactions);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.lamp.needsUpdate = true;
  }

  /** L1: police + ambulances answering a death, light bars going; idle
   * slots collapse to a zero-scale matrix. A slot is re-dressed (dims, kind
   * code, body colour) only when the responder it carries changes kind. */
  private placeResponders(
    cameraPos: Vec3,
    flash: 1 | 2,
    reactions?: CityReactions,
  ): void {
    const base = this.fleet.vehicles.length;
    const count = reactions?.responderCount ?? 0;
    let redressed = false;
    for (let k = 0; k < MAX_RESPONDERS; k++) {
      const slot = base + k;
      const r = k < count ? (reactions?.responders[k] as ResponderPose) : null;
      if (!r) {
        this.mesh.setMatrixAt(slot, Traffic.HIDDEN);
        this.lamp.setXY(slot, 0, 0);
        continue;
      }
      if (this.responderKind[k] !== r.kind) {
        this.responderKind[k] = r.kind;
        const spec = VEHICLES[r.kind === "police" ? "police" : "emergency"];
        this.body.setXYZW(
          slot,
          spec.width,
          spec.height,
          spec.length,
          spec.code,
        );
        this.mesh.setColorAt(
          slot,
          this.bodyColor.setHex(spec.bodies[0] ?? 0xf2f4f7),
        );
        redressed = true;
      }
      const p = nearestImage(cameraPos, { x: r.x, y: 0, z: r.z });
      this.quat.setFromAxisAngle(Traffic.UP, r.yaw);
      this.pos.set(p.x, 0, p.z);
      this.scratch.compose(this.pos, this.quat, Traffic.UNIT);
      this.mesh.setMatrixAt(slot, this.scratch);
      // Police and ambulance alternate opposite sides of the bar.
      this.lamp.setXY(
        slot,
        0,
        r.kind === "police" ? (flash === 1 ? 2 : 1) : flash,
      );
    }
    if (redressed) {
      this.body.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * QA hook (cross-tab determinism checks): the canonical poses of the first
   * few vehicles at `serverTimeMs`, straight from the pure model — two tabs
   * with synced clocks must report identical cars.
   */
  debug(
    serverTimeMs: number | null,
    count = 5,
  ): {
    time: number;
    cars: CarPose[];
    visible: boolean;
    drawnAt: Vec3;
    /** The light-bar state of every emergency vehicle, in fleet order. */
    siren: number[];
    /** L6: vehicles in the fleet, and how many stand still right now. */
    vehicles: number;
    standing: number;
  } | null {
    if (serverTimeMs === null) return null;
    const t = serverTimeMs / 1000;
    const { vehicles } = this.fleet;
    const cars = vehicles
      .slice(0, count)
      .map((v) => vehiclePose(this.fleet, v, t));
    const s = newVehicleState();
    let standing = 0;
    for (const v of vehicles) {
      if (vehicleState(this.fleet, v, t, s).speed < 0.05) standing++;
    }
    // The rendered truth for vehicle 0, read back from its instance matrix
    // (same idiom as Streetlights.imageOf) — not a re-derivation.
    this.mesh.getMatrixAt(0, this.scratch);
    const e = this.scratch.elements;
    return {
      time: serverTimeMs,
      cars,
      visible: this.mesh.visible,
      drawnAt: { x: e[12] as number, y: e[13] as number, z: e[14] as number },
      siren: vehicles.flatMap((v, i) => (v.runner ? [this.lamp.getY(i)] : [])),
      vehicles: vehicles.length,
      standing,
    };
  }

  /** QA: the longest red-light queue at `serverTimeMs` (gallery pinning). */
  queue(serverTimeMs: number): QueueSighting | null {
    return findQueue(this.fleet, serverTimeMs / 1000);
  }
}
