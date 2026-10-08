// A1 "Full of life" — the pure seam under the new street and facade life:
// cyclists, scooter and delivery riders in the bike lanes; pickup taxis that
// double-park for a hailer; crossers who wait at the corners and cross on
// WALK; couples, groups, joggers and dog walkers on the sidewalk rings; food
// carts, bus-stop waiters and street performers with an audience; people on
// the L13 balconies and the L8 roof terraces.
//
// Same contract as pedestrians.ts and traffic.ts: everything here is a pure
// function of (seed, layout, server time) — no Math.random, no per-frame
// state — so every client, late joiners included, sees the same city.
// Static layout is drawn ONCE per block and cached by the renderer
// (citylife-render.ts); the frame path replays no PRNG.
//
// THE STREET CROSS-SECTION (all derived from the S1 contract):
//
//   centre 0 ── car lane 5 ── taxi lane 8.7 ─ pull-over 10.4 ─ bike lane 12.8 ─ curb 15
//
// Platoon traffic keeps its ±5 m lanes. Riders run a bike lane between the
// curb and the outer travel lane; pickup taxis drive the outer lane and
// double-park at the pull-over line, whose footprint stays clear of the bike
// lane (tested). Both obey the L1 signals through `planRoute`, the same
// whole-signal-cycle trick traffic.ts uses: every lap closes standing at an
// anchor stop line and leaves it at a go-window start, so a lap is a whole
// number of signal cycles and the schedule repeats exactly.

import {
  type Building,
  CITY_GRID,
  PLAZA_BLOCKS,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  PARK_PATH_HALF,
  PARK_RING_RADIUS,
} from "@angels-bandits/common/city/nature";
import {
  CURB_LINE,
  FURNITURE_LINE,
  INTERSECTION_HALF,
  LANE_CENTERS,
  LOT_LINE,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import { wrapCoord, wrapDeltaAxis } from "@angels-bandits/common/world";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import { facadeDetailFor } from "./facade-detail";
import { roofClutterFor } from "./roofclutter";
import { RoofKind, roofStyleFor } from "./roofs";
import { LIFE_MAX_HEIGHT, ROOF_INSET, rooftopLifeFor } from "./rooftop-life";
import { blockHeat } from "./signage";
import { GO_WINDOW, GREEN, SIGNAL_CYCLE, goWindowStart } from "./signals";
import {
  PED_BAND_MAX,
  PED_BAND_MIN,
  type RingPoint,
  blockStream,
  ringPerimeter,
  ringPointInto,
} from "./streetlife";
import {
  STOP_BACK,
  type TrafficLane,
  laneBlock,
  laneSignalAxis,
  laneYaw,
} from "./traffic";

const P = BLOCK_PITCH;
const mod = (v: number, m: number): number => ((v % m) + m) % m;

// --- Cross-section ----------------------------------------------------------

/** Bike-lane centre, meters off the street centreline. */
export const BIKE_LANE = CURB_LINE - 2.2;
/** Half-width of the bike lane band, meters. */
export const BIKE_LANE_HALF = 0.8;
/** Riders weave this much either side of the lane centre, meters. */
const RIDER_JITTER = 0.3;
/** Outer travel lane the pickup taxis drive, meters off the centreline. */
export const TAXI_LANE = (LANE_CENTERS[1] as number) + 3.7;
/** Where a pickup taxi double-parks, meters off the centreline. Its curb-side
 * flank (+ half a taxi width) stays clear of the bike lane's inner edge. */
export const TAXI_PULLOVER = BIKE_LANE - BIKE_LANE_HALF - 1.6;
/** Pickup taxi body, meters (traffic.ts VEHICLES.taxi). */
export const TAXI_LENGTH = 4.5;
export const TAXI_WIDTH = 1.9;

// --- PRNG tags (streetlife's per-block streams; 1–4 are taken) ---------------

const TAG_GROUPS = 11;
const TAG_CROSSERS = 12;
const TAG_STATIONS = 13;
const TAG_HIGH = 14;

// --- Figure kinds (the renderer's shader selector) ---------------------------

export const LifeKind = {
  WALKER: 0,
  BIKE: 1,
  SCOOTER: 2,
  DELIVERY: 3,
  DOG: 4,
  CART: 5,
  PERFORMER: 6,
} as const;
export type LifeKind = (typeof LifeKind)[keyof typeof LifeKind];

// --- Signal-obeying routes ---------------------------------------------------

/** One kinematic piece of a route: u(t) = u0 + v0·dt + a·dt²/2 from t0. */
export interface RouteSegment {
  t0: number;
  u0: number;
  v0: number;
  a: number;
}

/** A mid-block stop: `at` meters past lane intersection `k`, for `wait` s. */
export interface RouteStopSpec {
  k: number;
  at: number;
  wait: number;
}

/** A pickup as it happens in the walk (times within one lap). */
export interface RouteStop {
  k: number;
  /** Lane-space stop position (front of the vehicle), meters. */
  u: number;
  /** Standing from tStop until tGo, seconds (absolute, first lap). */
  tStop: number;
  tGo: number;
}

/** A stop at a red light, for the obey-the-signals tests. */
export interface SignalStop {
  k: number;
  tStop: number;
  tGo: number;
}

export interface RouteKinematics {
  speed: number;
  accel: number;
  brake: number;
  /** Vehicle length, meters (box clearance). */
  length: number;
}

export interface RoutePlan {
  lane: TrafficLane;
  /** Signed meters off the centreline (right-hand side of travel). */
  lateral: number;
  kin: RouteKinematics;
  anchor: number;
  /** Departure from the anchor at the lap start, seconds. */
  t0: number;
  /** Lap period, seconds — a whole number of signal cycles. */
  period: number;
  segments: RouteSegment[];
  pickups: RouteStop[];
  signalStops: SignalStop[];
  /** True when no anchor/speed closed the lap naturally. */
  forced: boolean;
}

/** Slack between the vehicle leaving the box and red, seconds. */
const CLEAR_MARGIN = 0.5;
const SPEED_TRIES = 8;

const timeFromRest = (d: number, k: RouteKinematics): number => {
  const accelDist = (k.speed * k.speed) / (2 * k.accel);
  if (d <= accelDist) return Math.sqrt((2 * d) / k.accel);
  return k.speed / k.accel + (d - accelDist) / k.speed;
};

interface Walked {
  segments: RouteSegment[];
  pickups: RouteStop[];
  signalStops: SignalStop[];
  t0: number;
  period: number;
  natural: boolean;
}

/** Walk one lap from the anchor stop line, deciding every light. */
function walkRoute(
  starts: readonly number[],
  kin: RouteKinematics,
  anchor: number,
  stops: ReadonlyMap<number, RouteStopSpec>,
  force: boolean,
): Walked {
  const C = SIGNAL_CYCLE;
  const v = kin.speed;
  const accelT = v / kin.accel;
  const accelD = (v * v) / (2 * kin.accel);
  const brakeD = (v * v) / (2 * kin.brake);
  const brakeT = v / kin.brake;
  const box = STOP_BACK + INTERSECTION_HALF + kin.length;
  const cruiseClear = box / v;
  const restClear = timeFromRest(box, kin);
  const t0 = starts[anchor] as number;
  const segments: RouteSegment[] = [];
  const pickups: RouteStop[] = [];
  const signalStops: SignalStop[] = [];
  let tc = 0;
  let uc = 0;
  const depart = (t: number, u: number) => {
    segments.push({ t0: t, u0: u, v0: 0, a: kin.accel });
    tc = t + accelT;
    uc = u + accelD;
  };
  /** Brake from cruise to a standstill at `u`; returns the stop time. */
  const brakeTo = (u: number): number => {
    const ub = u - brakeD;
    const tb = tc + (ub - uc) / v;
    segments.push({ t0: tc, u0: uc, v0: v, a: 0 });
    segments.push({ t0: tb, u0: ub, v0: v, a: -kin.brake });
    const tStop = tb + brakeT;
    segments.push({ t0: tStop, u0: u, v0: 0, a: 0 });
    return tStop;
  };
  depart(t0, anchor * P - STOP_BACK);
  for (let j = 1; j <= CITY_GRID; j++) {
    const k = anchor + j;
    const stop = stops.get(mod(k - 1, CITY_GRID));
    if (stop) {
      const u = (k - 1) * P + stop.at;
      const tStop = brakeTo(u);
      pickups.push({
        k: mod(k - 1, CITY_GRID),
        u,
        tStop,
        tGo: tStop + stop.wait,
      });
      depart(tStop + stop.wait, u);
    }
    const ki = mod(k, CITY_GRID);
    const start = starts[ki] as number;
    const us = k * P - STOP_BACK;
    const tArr = tc + (us - uc) / v;
    const q = mod(tArr - start, C);
    const pass = q + cruiseClear <= GO_WINDOW - CLEAR_MARGIN;
    if (pass && j < CITY_GRID) continue;
    if (pass && !force) {
      return { segments, pickups, signalStops, t0, period: 0, natural: false };
    }
    const tStop = brakeTo(us);
    const qs = mod(tStop - start, C);
    const goNow = qs < GREEN && qs + restClear <= GO_WINDOW - CLEAR_MARGIN;
    if (j === CITY_GRID) {
      // Close the lap standing at the anchor, leaving on a go-window start:
      // the lap is then a whole number of signal cycles.
      const tGo = tStop + mod(start - tStop, C);
      signalStops.push({ k: ki, tStop, tGo });
      const period = Math.round((tGo - t0) / C) * C;
      return {
        segments,
        pickups,
        signalStops,
        t0,
        period,
        natural: !pass && !goNow,
      };
    }
    const tGo = goNow ? tStop : tStop + mod(start - tStop, C);
    signalStops.push({ k: ki, tStop, tGo });
    depart(tGo, us);
  }
  throw new Error("unreachable: the walk always closes at the anchor");
}

/**
 * Plan one signal-obeying route on `lane` at `lateral` meters off the
 * centreline: a pure function of (lane, kinematics band, stops, seed).
 * `rand` draws the speed (and the first anchor); the stops are fixed.
 */
export function planRoute(
  lane: TrafficLane,
  lateral: number,
  speedMin: number,
  speedSpan: number,
  base: Omit<RouteKinematics, "speed">,
  stops: readonly RouteStopSpec[],
  seed: number,
  rand: () => number,
): RoutePlan {
  const axis = laneSignalAxis(lane);
  const starts = Array.from({ length: CITY_GRID }, (_, k) => {
    const { bx, bz } = laneBlock(lane, k);
    return goWindowStart(bx, bz, axis, seed);
  });
  const stopMap = new Map(stops.map((s) => [s.k, s]));
  let fallback: { kin: RouteKinematics; anchor: number } | null = null;
  for (let attempt = 0; attempt < SPEED_TRIES; attempt++) {
    const kin = { ...base, speed: speedMin + rand() * speedSpan };
    const first = Math.floor(rand() * CITY_GRID);
    for (let j = 0; j < CITY_GRID; j++) {
      const anchor = (first + j) % CITY_GRID;
      const walk = walkRoute(starts, kin, anchor, stopMap, false);
      if (walk.natural) return finish(lane, lateral, kin, anchor, walk, false);
      fallback ??= { kin, anchor };
    }
  }
  // No natural close: stop at the anchor anyway (once a lap, a rider may
  // wait out a green there). Still a whole number of cycles.
  const { kin, anchor } = fallback ?? {
    kin: { ...base, speed: speedMin },
    anchor: 0,
  };
  return finish(
    lane,
    lateral,
    kin,
    anchor,
    walkRoute(starts, kin, anchor, stopMap, true),
    true,
  );
}

function finish(
  lane: TrafficLane,
  lateral: number,
  kin: RouteKinematics,
  anchor: number,
  walk: Walked,
  forced: boolean,
): RoutePlan {
  return {
    lane,
    lateral,
    kin,
    anchor,
    t0: walk.t0,
    period: walk.period,
    segments: walk.segments,
    pickups: walk.pickups,
    signalStops: walk.signalStops,
    forced,
  };
}

/** Route state at time t: lane-space front `u` (unbounded) and speed. */
export interface RouteState {
  u: number;
  speed: number;
  accel: number;
  /** Seconds into the current lap (for pickup windows). */
  lapTime: number;
  lap: number;
}

export const newRouteState = (): RouteState => ({
  u: 0,
  speed: 0,
  accel: 0,
  lapTime: 0,
  lap: 0,
});

export function routeAt(
  plan: RoutePlan,
  t: number,
  out: RouteState,
): RouteState {
  const rel = t - plan.t0;
  const lap = Math.floor(rel / plan.period);
  let tl = rel - lap * plan.period;
  if (tl < 0) tl = 0;
  if (tl >= plan.period) tl = plan.period;
  const segs = plan.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((segs[mid] as RouteSegment).t0 - plan.t0 <= tl) lo = mid;
    else hi = mid - 1;
  }
  const seg = segs[lo] as RouteSegment;
  const dt = tl - (seg.t0 - plan.t0);
  out.u = seg.u0 + seg.v0 * dt + 0.5 * seg.a * dt * dt + lap * WORLD_SIZE;
  out.speed = Math.max(0, seg.v0 + seg.a * dt);
  out.accel = seg.a;
  out.lapTime = tl;
  out.lap = lap;
  return out;
}

/** The canonical ground point `u` meters along a lane at `lateral` meters
 * (positive = the lane's own right-hand side, away from the centreline). */
export function laneGroundInto(
  lane: TrafficLane,
  lateral: number,
  u: number,
  out: { x: number; z: number },
): { x: number; z: number } {
  const along = mod(lane.dir * u, WORLD_SIZE);
  const line = Math.round(lane.cross / P);
  const side = lineSide(lane);
  const cross = wrapCoord(line * P + side * lateral);
  if (lane.axis === "x") {
    out.x = along;
    out.z = cross;
  } else {
    out.x = cross;
    out.z = along;
  }
  return out;
}

/** Which side of the centreline a lane drives on (+1 = the + side). */
export const lineSide = (lane: TrafficLane): 1 | -1 => {
  const line = Math.round(lane.cross / P);
  const d = lane.cross - line * P;
  return d >= 0 ? 1 : -1;
};

/** Every directed street (both directions of every street line), as
 * TrafficLane records whose `cross` sits at `lateral` on the right-hand side.
 * Same order and right-hand rule as traffic.ts trafficLanes(). */
export function sideLanes(lateral: number): TrafficLane[] {
  const lanes: TrafficLane[] = [];
  for (const axis of ["z", "x"] as const) {
    for (let line = 0; line < CITY_GRID; line++) {
      const center = line * P;
      // On a 'z' street the +x side drives +z; on an 'x' street the +z side
      // drives −x (right-hand traffic, as trafficLanes()).
      lanes.push(
        {
          id: lanes.length,
          axis,
          cross: wrapCoord(center - lateral),
          dir: axis === "z" ? -1 : 1,
        },
        {
          id: lanes.length + 1,
          axis,
          cross: center + lateral,
          dir: axis === "z" ? 1 : -1,
        },
      );
    }
  }
  return lanes;
}

// --- Riders ------------------------------------------------------------------

export type RiderKind =
  | typeof LifeKind.BIKE
  | typeof LifeKind.SCOOTER
  | typeof LifeKind.DELIVERY;

export interface Rider {
  plan: number;
  kind: RiderKind;
  /** Whole signal cycles behind the lane's reference rider, seconds. */
  delay: number;
  /** Lateral weave inside the bike lane, meters. */
  jitter: number;
  tone: number;
}

export interface RiderFleet {
  plans: RoutePlan[];
  riders: Rider[];
}

/** Riders on one bike lane, at most (distinct whole-cycle shifts). */
export const RIDERS_PER_LANE_MAX = 6;

/** Every rider in the city: a few per directed bike lane, sharing one
 * signal-obeying route per lane at distinct whole-cycle shifts — so each
 * meets identical lights and two riders can never overlap. */
export function riderFleet(seed: number): RiderFleet {
  const plans: RoutePlan[] = [];
  const riders: Rider[] = [];
  for (const lane of sideLanes(BIKE_LANE)) {
    const rand = mulberry32(
      (seed ^ Math.imul(lane.id + 1, 0x2c1b3c6d) ^ 0x51ce5) >>> 0,
    );
    const plan = planRoute(
      lane,
      BIKE_LANE,
      4.2,
      2.2,
      { accel: 1.1, brake: 2.2, length: 1.8 },
      [],
      seed,
      rand,
    );
    const p = plans.length;
    plans.push(plan);
    const cycles = Math.round(plan.period / SIGNAL_CYCLE);
    const count = Math.min(
      cycles,
      3 + Math.floor(rand() * (RIDERS_PER_LANE_MAX - 2)),
    );
    const used = new Set<number>();
    for (let r = 0; r < RIDERS_PER_LANE_MAX; r++) {
      const shift = Math.floor(rand() * cycles);
      const pick = rand();
      const jitter = (rand() * 2 - 1) * RIDER_JITTER;
      const tone = rand();
      if (r >= count || used.has(shift)) continue;
      used.add(shift);
      riders.push({
        plan: p,
        kind:
          pick < 0.55
            ? LifeKind.BIKE
            : pick < 0.8
              ? LifeKind.SCOOTER
              : LifeKind.DELIVERY,
        delay: shift * SIGNAL_CYCLE,
        jitter,
        tone,
      });
    }
  }
  return { plans, riders };
}

/** A posed figure on the ground (or up a building): canonical position,
 * facing (local +Z forward, yaw = atan2(fx, fz)), scale and a bob. */
export interface FigurePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** 0 = gone, 1 = full size (boarding/appearing figures scale). */
  scale: number;
  /** Vertical bob, meters. */
  bob: number;
  /** Arm raise, 0 (down) .. 1 (pointing up/forward). */
  arm: number;
}

export const newFigurePose = (): FigurePose => ({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  scale: 1,
  bob: 0,
  arm: 0,
});

const ground = { x: 0, z: 0 };
const routeScratch = newRouteState();

// Scratch for the two direction helpers (written in place: per-frame paths
// call them, and the result is read before the next call).
const tvScratch = { x: 0, z: 0 };
const lvScratch = { x: 0, z: 0 };
/** Unit travel direction of a lane on the ground. */
const travelVec = (lane: TrafficLane): { x: number; z: number } => {
  tvScratch.x = lane.axis === "z" ? 0 : lane.dir;
  tvScratch.z = lane.axis === "z" ? lane.dir : 0;
  return tvScratch;
};
/** Unit direction from the centreline out toward this lane's curb. */
const outwardVec = (lane: TrafficLane): { x: number; z: number } => {
  const side = lineSide(lane);
  lvScratch.x = lane.axis === "z" ? side : 0;
  lvScratch.z = lane.axis === "z" ? 0 : side;
  return lvScratch;
};

/** The heading (figure yaw) of travel along a lane. traffic.ts laneYaw is the
 * plane convention (forward −Z); figures face local +Z, i.e. yaw + π. */
const travelYaw = (lane: TrafficLane): number => laneYaw(lane) + Math.PI;

/** Where rider `r` is at server time `t` (seconds). Pure. */
export function riderPoseInto(
  fleet: RiderFleet,
  r: Rider,
  t: number,
  out: FigurePose,
): FigurePose {
  const plan = fleet.plans[r.plan] as RoutePlan;
  const s = routeAt(plan, t - r.delay, routeScratch);
  // The route tracks the front wheel; the figure sits mid-bike.
  laneGroundInto(plan.lane, BIKE_LANE + r.jitter, s.u - 0.9, ground);
  out.x = ground.x;
  out.y = 0;
  out.z = ground.z;
  out.yaw = travelYaw(plan.lane);
  out.scale = 1;
  // Pedalling bob, keyed to distance (a scooter glides).
  out.bob =
    r.kind === LifeKind.SCOOTER
      ? 0
      : s.speed > 0.2
        ? Math.abs(Math.sin(s.u * 1.9)) * 0.03
        : 0;
  out.arm = 0;
  return out;
}

// --- Pickup taxis --------------------------------------------------------------

/** Pickup taxis in the city (each owns one directed street's taxi lane). */
export const PICKUP_TAXIS = 12;
/** Pickups per lap per taxi. */
const PICKUPS_PER_LAP = 3;
/** Lateral ease in/out of the pull-over, meters of travel. */
const PULL_RAMP = 22;
/** Hailer timeline, seconds relative to the taxi stopping. */
export const HAIL_APPEAR = -34;
const HAIL_AT_CURB = -30;
const HAIL_ARM_UP = -14;
const HAIL_WALK = 2.6;
const HAIL_BOARD = 0.7;
/** Where the hailer waits, and the door they walk to, meters off centre. */
export const HAIL_CURB = CURB_LINE + 0.45;
const HAIL_DOOR = TAXI_PULLOVER + TAXI_WIDTH / 2 + 0.3;
const HAIL_DOORWAY = LOT_LINE - 0.4;

export interface PickupTaxi {
  plan: RoutePlan;
  tone: number;
}

/** The pickup taxis: one per chosen directed street, distinct streets. */
export function pickupTaxis(seed: number): PickupTaxi[] {
  const lanes = sideLanes(TAXI_LANE);
  const rand = mulberry32((seed ^ 0x7a9c1b3) >>> 0);
  const taken = new Set<number>();
  const out: PickupTaxi[] = [];
  for (let guard = 0; guard < 200 && out.length < PICKUP_TAXIS; guard++) {
    const id = Math.floor(rand() * lanes.length);
    if (taken.has(id)) continue;
    taken.add(id);
    const lane = lanes[id] as TrafficLane;
    const stopRand = mulberry32(
      (seed ^ Math.imul(id + 1, 0x6b43a9b5) ^ 0x7a41) >>> 0,
    );
    const ks = new Set<number>();
    const stops: RouteStopSpec[] = [];
    for (
      let s = 0;
      s < PICKUPS_PER_LAP * 3 && stops.length < PICKUPS_PER_LAP;
      s++
    ) {
      const k = Math.floor(stopRand() * CITY_GRID);
      const at = 70 + stopRand() * 50;
      const wait = 8 + stopRand() * 4;
      if (ks.has(k)) continue;
      ks.add(k);
      stops.push({ k, at, wait });
    }
    const plan = planRoute(
      lane,
      TAXI_LANE,
      9,
      3,
      { accel: 2.2, brake: 3.5, length: TAXI_LENGTH },
      stops,
      seed,
      stopRand,
    );
    out.push({ plan, tone: rand() });
  }
  return out;
}

/** A taxi's rendered state: canonical body centre, heading in the PLANE
 * convention (forward −Z, what traffic.ts draws), brake + hazard flags. */
export interface TaxiPose {
  x: number;
  z: number;
  yaw: number;
  /** Meters off the centreline right now. */
  lateral: number;
  braking: boolean;
  hazard: boolean;
}

export const newTaxiPose = (): TaxiPose => ({
  x: 0,
  z: 0,
  yaw: 0,
  lateral: 0,
  braking: false,
  hazard: false,
});

const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/** How far into the pull-over a taxi is at lane position `u` (0 lane, 1 out). */
function pullAt(plan: RoutePlan, u: number): number {
  const lapU = mod(u - (plan.anchor * P - STOP_BACK), WORLD_SIZE);
  let best = 0;
  for (const p of plan.pickups) {
    const pu = mod(p.u - (plan.anchor * P - STOP_BACK), WORLD_SIZE);
    const d = lapU - pu;
    const w =
      d <= 0 ? smooth((d + PULL_RAMP) / PULL_RAMP) : smooth(1 - d / PULL_RAMP);
    if (w > best) best = w;
  }
  return best;
}

export function taxiPoseInto(
  taxi: PickupTaxi,
  t: number,
  out: TaxiPose,
): TaxiPose {
  const plan = taxi.plan;
  const s = routeAt(plan, t, routeScratch);
  const centre = s.u - TAXI_LENGTH / 2;
  const pull = pullAt(plan, centre);
  out.lateral = TAXI_LANE + (TAXI_PULLOVER - TAXI_LANE) * pull;
  laneGroundInto(plan.lane, out.lateral, centre, ground);
  out.x = ground.x;
  out.z = ground.z;
  // Steer into / out of the pull-over: the heading tilts toward the curb by
  // the lateral slope. Forward (plane convention) is (−sin yaw, −cos yaw).
  const slope =
    (pullAt(plan, centre + 0.5) - pullAt(plan, centre - 0.5)) *
    (TAXI_PULLOVER - TAXI_LANE);
  const tv = travelVec(plan.lane);
  const lv = outwardVec(plan.lane);
  out.yaw = Math.atan2(-(tv.x + lv.x * slope), -(tv.z + lv.z * slope));
  out.braking = s.accel < 0 || s.speed < 0.05;
  out.hazard = s.speed < 0.05 && pull > 0.95;
  return out;
}

/**
 * The hailer of the taxi's pickup `i` at time t, or null when nobody is
 * there. They step out of a doorway, wait at the curb (hailing as the taxi
 * nears), walk to the rear door once it stands, and board.
 */
export function hailerPoseInto(
  taxi: PickupTaxi,
  i: number,
  t: number,
  out: FigurePose,
): FigurePose | null {
  const plan = taxi.plan;
  const stop = plan.pickups[i];
  if (!stop) return null;
  const rel = t - plan.t0;
  const lap = Math.floor(rel / plan.period);
  // The nearest occurrence of this stop (this lap's, or next lap's early part).
  let dt = rel - lap * plan.period - (stop.tStop - plan.t0);
  if (dt < HAIL_APPEAR) dt += plan.period;
  if (dt > plan.period + HAIL_APPEAR) dt -= plan.period;
  const end = HAIL_WALK + HAIL_BOARD;
  if (dt < HAIL_APPEAR || dt > end) return null;
  // The door sits beside the taxi's rear half.
  const doorU = stop.u - TAXI_LENGTH * 0.62;
  let lateral: number;
  let yaw: number;
  const toCurb = HAIL_CURB - HAIL_DOORWAY; // negative: toward the street
  const tv = travelVec(plan.lane);
  const lv = outwardVec(plan.lane);
  const inward = Math.atan2(-lv.x, -lv.z);
  // Waiting: look back up the street at the approaching taxi, half turned
  // to the road.
  const watch = Math.atan2(-tv.x * 0.8 - lv.x * 0.6, -tv.z * 0.8 - lv.z * 0.6);
  out.arm = 0;
  out.scale = 1;
  if (dt < HAIL_AT_CURB) {
    const k = (dt - HAIL_APPEAR) / (HAIL_AT_CURB - HAIL_APPEAR);
    lateral = HAIL_DOORWAY + toCurb * k;
    yaw = inward;
    out.scale = smooth((dt - HAIL_APPEAR) / 0.6);
  } else if (dt < 0) {
    lateral = HAIL_CURB;
    // Arm up as the taxi nears.
    yaw = watch;
    out.arm = smooth((dt - HAIL_ARM_UP) / 1.2);
  } else {
    const k = Math.min(1, dt / HAIL_WALK);
    lateral = HAIL_CURB + (HAIL_DOOR - HAIL_CURB) * k;
    yaw = inward;
    out.scale = 1 - smooth((dt - HAIL_WALK) / HAIL_BOARD);
  }
  laneGroundInto(plan.lane, lateral, doorU, ground);
  out.x = ground.x;
  out.y = 0;
  out.z = ground.z;
  out.yaw = yaw;
  out.bob = 0;
  return out;
}

// --- Ring life: couples, groups, joggers, dog walkers ---------------------------

export interface RingFigure {
  bx: number;
  bz: number;
  /** Ring offset (the group leader's), meters. */
  d: number;
  perimeter: number;
  base: number;
  dir: 1 | -1;
  speed: number;
  /** Extra lateral offset (deeper into the block), meters. */
  lat: number;
  /** Along-ring offset from the leader, meters (signed with travel). */
  ahead: number;
  kind: typeof LifeKind.WALKER | typeof LifeKind.DOG;
  /** Meters per bob cycle and bob height. */
  stride: number;
  bobAmp: number;
  tone: number;
  height: number;
  /** Standing groups face this yaw offset (a chat circle). */
  idleYaw: number;
}

/** Group sizes and shares: couples are the common case. */
const GROUP_LAT = 0.62;

/** How many of each ring population a block carries (district gradient). */
export function ringCounts(
  bx: number,
  bz: number,
): { groups: number; joggers: number; dogs: number } {
  const h = blockHeat(bx, bz);
  return {
    groups: Math.round(5 + 12 * h * h),
    joggers: Math.round(2 + 3 * h),
    dogs: Math.round(2 + 2 * h),
  };
}

const clampBand = (d: number): number =>
  Math.min(PED_BAND_MAX, Math.max(PED_BAND_MIN, d));

/** Every ring figure on block (bx, bz), drawn once (fixed draws per unit). */
export function blockRingLife(
  bx: number,
  bz: number,
  seed: number,
): RingFigure[] {
  const rand = blockStream(seed, bx, bz, TAG_GROUPS);
  const { groups, joggers, dogs } = ringCounts(bx, bz);
  const out: RingFigure[] = [];
  const unit = (kind: "group" | "jog" | "dog"): void => {
    const d0 =
      PED_BAND_MIN + 0.35 + rand() * (PED_BAND_MAX - PED_BAND_MIN - 0.7);
    const perimeter = ringPerimeter(d0);
    const base = rand() * perimeter;
    const dir: 1 | -1 = rand() < 0.5 ? -1 : 1;
    const sRoll = rand();
    const sizeRoll = rand();
    const toneRoll = rand();
    const heightRoll = rand();
    const yawRoll = rand();
    const push = (f: Partial<RingFigure>) =>
      out.push({
        bx,
        bz,
        d: d0,
        perimeter,
        base,
        dir,
        speed: 0,
        lat: 0,
        ahead: 0,
        kind: LifeKind.WALKER,
        stride: 0.85,
        bobAmp: 0.045,
        tone: toneRoll,
        height: 0.92 + heightRoll * 0.2,
        idleYaw: yawRoll * Math.PI * 2,
        ...f,
      });
    if (kind === "jog") {
      push({ speed: 2.6 + sRoll * 0.9, stride: 1.25, bobAmp: 0.09 });
      return;
    }
    if (kind === "dog") {
      const speed = 0.95 + sRoll * 0.35;
      push({ speed });
      // The dog trots a leash-length ahead, a little toward the curb.
      push({
        speed,
        kind: LifeKind.DOG,
        ahead: 1.3,
        lat: clampBand(d0 - 0.35) - d0,
        stride: 0.4,
        bobAmp: 0.035,
        tone: (toneRoll * 7.31) % 1,
        height: 0.8 + heightRoll * 0.45,
      });
      return;
    }
    // Couples and groups: side by side, a fourth one step behind.
    const size = sizeRoll < 0.55 ? 2 : sizeRoll < 0.85 ? 3 : 4;
    const standing = sRoll < 0.18;
    const speed = standing ? 0 : 0.9 + sRoll * 0.4;
    for (let m = 0; m < size; m++) {
      const across = m < 3 ? m - (Math.min(size, 3) - 1) / 2 : 0;
      const lat = clampBand(d0 + across * GROUP_LAT) - d0;
      push({
        speed,
        lat,
        ahead: m === 3 ? -0.9 : 0,
        tone: (toneRoll + m * 0.37) % 1,
        height: 0.92 + ((heightRoll + m * 0.29) % 1) * 0.2,
        // A standing group turns in toward its own middle.
        idleYaw: across === 0 && m !== 3 ? yawRoll * Math.PI * 2 : 0,
      });
    }
  };
  for (let g = 0; g < groups; g++) unit("group");
  for (let j = 0; j < joggers; j++) unit("jog");
  for (let k = 0; k < dogs; k++) unit("dog");
  return out;
}

const ringScratch: RingPoint = { x: 0, z: 0, dx: 0, dz: 0 };

/** Where ring figure `f` is at server time `t`. Pure. */
export function ringFigurePoseInto(
  f: RingFigure,
  t: number,
  out: FigurePose,
  /** Extra meters along the ring (signed with +s): the look-up freeze. */
  shift = 0,
): FigurePose {
  const walked = f.base + f.dir * (f.speed * t + f.ahead) + shift;
  ringPointInto(f.bx, f.bz, f.d, walked, ringScratch);
  // Companions walk beside the leader: the leader's ring point pushed along
  // the inward normal (−dz, dx), so a group never drifts apart at corners.
  const nx = -ringScratch.dz;
  const nz = ringScratch.dx;
  out.x = wrapCoord(ringScratch.x + nx * f.lat);
  out.y = 0;
  out.z = wrapCoord(ringScratch.z + nz * f.lat);
  out.scale = 1;
  out.arm = 0;
  if (f.speed > 0) {
    out.yaw = Math.atan2(ringScratch.dx * f.dir, ringScratch.dz * f.dir);
    out.bob = Math.abs(Math.sin((Math.PI * walked) / f.stride)) * f.bobAmp;
  } else {
    // A chat circle: everyone turns toward the group's middle.
    const s = Math.sign(f.lat);
    out.yaw =
      f.lat !== 0
        ? Math.atan2(-nx * s, -nz * s)
        : f.ahead < 0
          ? Math.atan2(ringScratch.dx * f.dir, ringScratch.dz * f.dir)
          : f.idleYaw;
    out.bob = 0;
  }
  return out;
}

// --- Crossers ------------------------------------------------------------------

/**
 * A crosser circulates the four corners of one intersection (its block's
 * south-west lattice corner), crossing only on the steady WALK of the
 * matching axis and finishing before the crossed street's traffic gets its
 * green. A loop is FOUR signal cycles (8 half-cycle slots); legs come in
 * pairs — across one street, straight across the next — then a wait.
 */
export interface Crosser {
  bx: number;
  bz: number;
  /** Corner at slot 0: 0 (−,−), 1 (−,+), 2 (+,+), 3 (+,−). */
  corner: number;
  /** Leg slots in the 8-slot loop. */
  legs: readonly number[];
  /** Waiting depth off each centreline, meters (inside the crosswalk band). */
  rx: number;
  rz: number;
  /** Start delay into the steady WALK, seconds. */
  delay: number;
  speed: number;
  tone: number;
  height: number;
}

/** Corner signs, in loop order. */
const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 1],
  [1, 1],
  [1, -1],
];
/** Leg slots: pattern A starts on an even (z) corner, B on an odd (x) one. */
const LEGS_A = [0, 3, 4, 7] as const;
const LEGS_B = [1, 2, 5, 6] as const;
/** Half a signal cycle: one axis's share, seconds. */
export const HALF_CYCLE = SIGNAL_CYCLE / 2;
/** Crossers start inside the first seconds of steady WALK (6 s long). */
const CROSS_DELAY_MAX = 1.5;
/** Waiting depth band: inside the painted crosswalk (15–19 m). */
const CROSS_R_MIN = 16.6;
const CROSS_R_MAX = 17.6;
/** Slowest crosser: the whole leg ends before the half-cycle does. */
export const CROSS_SPEED_MIN =
  (2 * CROSS_R_MAX) / (HALF_CYCLE - CROSS_DELAY_MAX - 0.3);

/** How many crossers one intersection has. */
export const crosserCount = (bx: number, bz: number): number =>
  Math.round(3 + 7 * blockHeat(bx, bz));

export function blockCrossers(bx: number, bz: number, seed: number): Crosser[] {
  const rand = blockStream(seed, bx, bz, TAG_CROSSERS);
  const n = crosserCount(bx, bz);
  const out: Crosser[] = [];
  for (let i = 0; i < n; i++) {
    const corner = Math.floor(rand() * 4);
    let rx = CROSS_R_MIN + rand() * (CROSS_R_MAX - CROSS_R_MIN);
    let rz = CROSS_R_MIN + rand() * (CROSS_R_MAX - CROSS_R_MIN);
    // Keep clear of the vehicle mast standing at (FURNITURE_LINE, F).
    if (Math.hypot(rx - FURNITURE_LINE, rz - FURNITURE_LINE) < 1) {
      rx = Math.max(rx, FURNITURE_LINE + 1);
      rz = Math.max(rz, FURNITURE_LINE + 1);
    }
    out.push({
      bx,
      bz,
      corner,
      legs: corner % 2 === 0 ? LEGS_A : LEGS_B,
      rx,
      rz,
      delay: rand() * CROSS_DELAY_MAX,
      speed: CROSS_SPEED_MIN + rand() * 0.25,
      tone: rand(),
      height: 0.92 + rand() * 0.2,
    });
  }
  return out;
}

/** Signal phase helper: seconds into the 4-cycle crosser loop. */
const crossLoop = (c: Crosser, t: number, offset: number): number =>
  mod(t + offset, 4 * SIGNAL_CYCLE);

/**
 * Where crosser `c` is at time `t`. `offset` is the intersection's signal
 * offset (signals.ts signalOffset — the renderer caches it per block).
 */
export function crosserPoseInto(
  c: Crosser,
  t: number,
  offset: number,
  out: FigurePose,
): FigurePose {
  const loop = crossLoop(c, t, offset);
  const slot = Math.floor(loop / HALF_CYCLE);
  const q = loop - slot * HALF_CYCLE;
  // Legs completed before this slot → the current corner.
  let done = 0;
  let inLeg = false;
  for (const s of c.legs) {
    if (s < slot) done++;
    else if (s === slot) inLeg = true;
  }
  const from = (c.corner + done) % 4;
  const [fx, fz] = CORNERS[from] as readonly [number, number];
  const X = c.bx * P;
  const Z = c.bz * P;
  let lx = fx * c.rx;
  let lz = fz * c.rz;
  out.bob = 0;
  out.arm = 0;
  out.scale = 1;
  // Waiting: face across the street they will cross next.
  const nextAlongZ = from % 2 === 0;
  out.yaw = nextAlongZ ? Math.atan2(0, -fz) : Math.atan2(-fx, 0);
  if (inLeg) {
    const legT = (2 * (nextAlongZ ? c.rz : c.rx)) / c.speed;
    const k = Math.min(1, Math.max(0, (q - c.delay) / legT));
    const walked = k * legT * c.speed;
    if (nextAlongZ) lz = fz * c.rz - fz * walked;
    else lx = fx * c.rx - fx * walked;
    if (k > 0 && k < 1) {
      out.bob = Math.abs(Math.sin((Math.PI * walked) / 0.85)) * 0.045;
    }
  }
  out.x = wrapCoord(X + lx);
  out.y = 0;
  out.z = wrapCoord(Z + lz);
  return out;
}

// --- Stations: carts, bus stops, performers ---------------------------------------

/**
 * Furniture-zone stations along a block side, meters from the side's start:
 * clear of the lamps (streetlights LAMP_STATIONS) and the N1 street-tree pits
 * by 12 m or more, and of the corners' crosswalks.
 */
const STATIONS_PLUS = [44, 81, 119, 156] as const;
const STATIONS_MINUS = [50, 75, 107, 145] as const;
/** The furniture-zone line carts and waiters stand on (between the curb and
 * the walkers' band, clear of the lamp posts at the furniture line's stations). */
export const STATION_LINE = CURB_LINE + 0.95;

export interface StaticFigure {
  kind: LifeKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  tone: number;
  height: number;
  /** 0 street level, 1 up a building (balcony / roof). */
  high: 0 | 1;
  /** Idle animation phase 0..1. */
  phase: number;
  /** Arm raise at rest 0..1 (performers strum, vendors serve). */
  arm: number;
}

/** One side of a block's sidewalk: start corner, unit direction along the
 * side, the inward normal (toward the block), and its station list. */
interface Side {
  x0: number;
  z0: number;
  ax: number;
  az: number;
  nx: number;
  nz: number;
  stations: readonly number[];
}

function blockSides(bx: number, bz: number): Side[] {
  const x0 = bx * P;
  const z0 = bz * P;
  return [
    // West side (plus side of line x0), along +z.
    { x0, z0, ax: 0, az: 1, nx: 1, nz: 0, stations: STATIONS_PLUS },
    // South side (plus side of line z0), along +x.
    { x0, z0, ax: 1, az: 0, nx: 0, nz: 1, stations: STATIONS_PLUS },
    // East side (minus side of line x0 + P), along +z.
    { x0: x0 + P, z0, ax: 0, az: 1, nx: -1, nz: 0, stations: STATIONS_MINUS },
    // North side (minus side of line z0 + P), along +x.
    { x0, z0: z0 + P, ax: 1, az: 0, nx: 0, nz: -1, stations: STATIONS_MINUS },
  ];
}

/** Ground point `a` along a side at `off` meters from its street centreline. */
const sidePoint = (
  s: Side,
  a: number,
  off: number,
): { x: number; z: number } => ({
  x: wrapCoord(s.x0 + s.ax * a + s.nx * off),
  z: wrapCoord(s.z0 + s.az * a + s.nz * off),
});

/** Yaw that faces along (fx, fz) in the figure convention (+Z forward). */
const yawOf = (fx: number, fz: number): number => Math.atan2(fx, fz);

const isPlaza = (bx: number, bz: number): boolean =>
  PLAZA_BLOCKS.some(([px, pz]) => px === bx && pz === bz);

/** Street stations on block (bx, bz): carts, a bus stop, a performer. */
export interface Stations {
  figures: StaticFigure[];
  /** Performer positions (the busker audio's sources). */
  performers: { x: number; z: number }[];
  /** Bus stops (one ground point per stop) — G1's shelter seam. */
  busStops: { x: number; z: number; yaw: number }[];
}

/** Per-station chances (16 stations a block). A block has at most one bus
 * stop and one sidewalk performer; carts follow the district heat. */
export const BUS_STOP_CHANCE = 0.08;
export const CART_CHANCE_MIN = 0.035;
export const CART_CHANCE_HEAT = 0.075;
export const PERFORMER_CHANCE_MIN = 0.015;
export const PERFORMER_CHANCE_HEAT = 0.05;

export function blockStations(bx: number, bz: number, seed: number): Stations {
  const rand = blockStream(seed, bx, bz, TAG_STATIONS);
  const h = blockHeat(bx, bz);
  const figures: StaticFigure[] = [];
  const performers: { x: number; z: number }[] = [];
  const busStops: { x: number; z: number; yaw: number }[] = [];
  const person = (
    p: { x: number; z: number },
    yaw: number,
    extra: Partial<StaticFigure> = {},
  ) =>
    figures.push({
      kind: LifeKind.WALKER,
      x: p.x,
      y: 0,
      z: p.z,
      yaw,
      tone: rand(),
      height: 0.92 + rand() * 0.2,
      high: 0,
      phase: rand(),
      arm: 0,
      ...extra,
    });
  const cart = h * CART_CHANCE_HEAT + CART_CHANCE_MIN;
  const busker = isPlaza(bx, bz)
    ? 0
    : PERFORMER_CHANCE_MIN + PERFORMER_CHANCE_HEAT * h;
  let bus = false;
  let performer = false;
  // Fixed draw order: per side, per station, two rolls; a role's own draws
  // follow it, so only that station's figures depend on the role.
  for (const s of blockSides(bx, bz)) {
    // Facing the street from this side (toward the centreline).
    const toStreet = yawOf(-s.nx, -s.nz);
    for (const a of s.stations) {
      const roll = rand();
      const count = rand();
      if (!bus && roll < BUS_STOP_CHANCE) {
        bus = true;
        busStops.push({ ...sidePoint(s, a, STATION_LINE), yaw: toStreet });
        const n = 3 + Math.floor(count * 4);
        for (let w = 0; w < n; w++) {
          const along = (w - (n - 1) / 2) * 0.85 + (rand() - 0.5) * 0.3;
          const off = STATION_LINE - 0.35 + rand() * 0.7;
          person(sidePoint(s, a + along, off), toStreet + (rand() - 0.5) * 0.9);
        }
      } else if (roll >= BUS_STOP_CHANCE && roll < BUS_STOP_CHANCE + cart) {
        // The cart stands broadside to the sidewalk, its vendor on the curb
        // side facing the customers queueing in the walkers' band.
        figures.push({
          kind: LifeKind.CART,
          ...sidePoint(s, a, STATION_LINE),
          y: 0,
          yaw: yawOf(s.ax, s.az),
          tone: rand(),
          height: 1,
          high: 0,
          phase: rand(),
          arm: 0,
        });
        person(sidePoint(s, a, CURB_LINE + 0.25), yawOf(s.nx, s.nz), {
          arm: 0.35,
        });
        const queue = 1 + Math.floor(count * 3);
        for (let c = 0; c < queue; c++) {
          person(
            sidePoint(s, a + (c - 0.3) * 0.75, PED_BAND_MIN + 0.1),
            toStreet + (rand() - 0.5) * 0.5,
          );
        }
      } else if (!performer && roll >= 1 - busker) {
        performer = true;
        const at = sidePoint(s, a, LOT_LINE - 0.9);
        performers.push(at);
        person(at, toStreet, { kind: LifeKind.PERFORMER, arm: 0.55 });
        audience(
          rand,
          count,
          (along, off) => sidePoint(s, a + along, off),
          (p) =>
            person(
              p,
              yawOf(wrapDeltaAxis(p.x, at.x), wrapDeltaAxis(p.z, at.z)),
            ),
        );
      }
    }
  }
  if (isPlaza(bx, bz)) plazaLife(bx, bz, rand, figures, performers, person);
  return { figures, performers, busStops };
}

/** An audience arc in front of a performer standing at the lot line. */
function audience(
  rand: () => number,
  count: number,
  at: (along: number, off: number) => { x: number; z: number },
  push: (p: { x: number; z: number }) => void,
): void {
  const n = 4 + Math.floor(count * 5);
  for (let i = 0; i < n; i++) {
    const th = ((i + 0.5) / n - 0.5) * 2.4 + (rand() - 0.5) * 0.15;
    const r = 2.2 + rand() * 0.6;
    push(at(Math.sin(th) * r, LOT_LINE - 0.9 - Math.cos(th) * r));
  }
}

/** Park blocks: two performers and two carts on the ring path. */
function plazaLife(
  bx: number,
  bz: number,
  rand: () => number,
  figures: StaticFigure[],
  performers: { x: number; z: number }[],
  person: (
    p: { x: number; z: number },
    yaw: number,
    extra?: Partial<StaticFigure>,
  ) => void,
): void {
  const cx = (bx + 0.5) * P;
  const cz = (bz + 0.5) * P;
  const at = (th: number, r: number) => ({
    x: wrapCoord(cx + Math.cos(th) * r),
    z: wrapCoord(cz + Math.sin(th) * r),
  });
  // Diagonals sit between the park lamps (phase π/8, step π/4) and off the
  // cross paths.
  for (const th of [Math.PI / 4, (5 * Math.PI) / 4]) {
    const rP = PARK_RING_RADIUS + PARK_PATH_HALF + 0.6;
    const p = at(th, rP);
    performers.push(p);
    const inward = Math.atan2(-Math.cos(th), -Math.sin(th));
    person(p, inward, { kind: LifeKind.PERFORMER, arm: 0.55 });
    const n = 5 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const a = th + ((i + 0.5) / n - 0.5) * 0.09 + (rand() - 0.5) * 0.01;
      const r = PARK_RING_RADIUS - PARK_PATH_HALF + 0.5 + rand() * 3;
      const q = at(a, r);
      person(q, yawOf(wrapDeltaAxis(q.x, p.x), wrapDeltaAxis(q.z, p.z)));
    }
  }
  for (const th of [(3 * Math.PI) / 4, (7 * Math.PI) / 4]) {
    const p = at(th, PARK_RING_RADIUS + PARK_PATH_HALF - 0.6);
    const tangent = Math.atan2(-Math.sin(th), Math.cos(th));
    figures.push({
      kind: LifeKind.CART,
      ...p,
      y: 0,
      yaw: tangent,
      tone: rand(),
      height: 1,
      high: 0,
      phase: rand(),
      arm: 0,
    });
    const v = at(th, PARK_RING_RADIUS + PARK_PATH_HALF + 0.5);
    person(v, Math.atan2(-Math.cos(th), -Math.sin(th)), { arm: 0.35 });
    for (let c = 0; c < 3; c++) {
      const q = at(th + (c - 1) * 0.013, PARK_RING_RADIUS - 0.6);
      person(q, Math.atan2(Math.cos(th), Math.sin(th)));
    }
  }
}

// --- Up the buildings: balconies and roof terraces ---------------------------------

/** Share of L13 balconies with someone standing on them. */
export const BALCONY_OCCUPANCY = 0.3;
/** Share of flat mid-rise roofs with a few people at the parapet. */
export const TERRACE_CHANCE = 0.2;

/** A deterministic 0..1 from a position (no stream to shift). */
const hash3 = (x: number, y: number, z: number, salt: number): number => {
  let h =
    Math.imul(Math.round(x * 8), 0x27d4eb2d) ^
    Math.imul(Math.round(y * 8), 0x165667b1) ^
    Math.imul(Math.round(z * 8), 0x61c88647) ^
    Math.imul(salt, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/**
 * People on one building's balconies and roof terrace. Balconies come from
 * L13's own layout (facadeDetailFor) so a figure always stands ON a slab;
 * terrace people come from L8 (rooftopLifeFor: beside a pool) and from a
 * parapet line on flat mid-rise roofs, clear of every L8 / clutter rect.
 */
export function highFigures(b: Building, seed: number): StaticFigure[] {
  const out: StaticFigure[] = [];
  if (archetypeFor(b) === FacadeArchetype.GLASS) {
    // Curtain-wall towers have no balconies; their roofs are still eligible.
  } else {
    for (const box of facadeDetailFor(b, seed).boxes) {
      if (box.kind !== "balcony" || box.sy > 0.3) continue;
      const r = hash3(box.x, box.y, box.z, 1);
      if (r >= BALCONY_OCCUPANCY) continue;
      const two = r < BALCONY_OCCUPANCY * 0.2;
      const out1 = box.axis === "x" ? box.dir : 0;
      const out2 = box.axis === "z" ? box.dir : 0;
      const along = box.axis === "x" ? [0, 1] : [1, 0];
      const top = box.y + box.sy / 2;
      for (let m = 0; m < (two ? 2 : 1); m++) {
        const a = two
          ? (m - 0.5) * 0.42
          : (hash3(box.x, top, box.z, 2) - 0.5) * 0.3;
        out.push({
          kind: LifeKind.WALKER,
          // Half a meter out from the facade plane, on the slab.
          x:
            box.axis === "x"
              ? box.plane + out1 * 0.55
              : box.x + (along[0] as number) * a,
          y: top,
          z:
            box.axis === "z"
              ? box.plane + out2 * 0.55
              : box.z + (along[1] as number) * a,
          yaw: yawOf(out1, out2) + (hash3(box.x, top, box.z, 3) - 0.5) * 0.8,
          tone: hash3(box.x, top, box.z, 4),
          height: 0.92 + hash3(box.x, top, box.z, 5) * 0.2,
          high: 1,
          phase: hash3(box.x, top, box.z, 6),
          arm: 0,
        });
      }
    }
  }
  terrace(b, out);
  return out;
}

interface Rect {
  x: number;
  z: number;
  hw: number;
  hd: number;
}
const overlaps = (a: Rect, b: Rect, m: number): boolean =>
  Math.abs(a.x - b.x) < a.hw + b.hw + m &&
  Math.abs(a.z - b.z) < a.hd + b.hd + m;

function terrace(b: Building, out: StaticFigure[]): void {
  const top = b.tiers[b.tiers.length - 1];
  if (!top || b.height >= LIFE_MAX_HEIGHT) return;
  const kind = roofStyleFor(b).tierKinds[b.tiers.length - 1];
  if (kind !== RoofKind.MEMBRANE && kind !== RoofKind.GRAVEL) return;
  const life = rooftopLifeFor(b);
  const clutter = roofClutterFor(b);
  const taken: Rect[] = [
    ...clutter.waterTowers.map((t) => ({
      x: t.x,
      z: t.z,
      hw: t.radius,
      hd: t.radius,
    })),
    ...clutter.acBoxes.map((a) => ({
      x: a.x,
      z: a.z,
      hw: a.width / 2,
      hd: a.depth / 2,
    })),
    ...clutter.masts.map((m) => ({ x: m.x, z: m.z, hw: 0.3, hd: 0.3 })),
    ...life.fans.map((f) => ({
      x: f.x,
      z: f.z,
      hw: f.radius + 0.3,
      hd: f.radius + 0.3,
    })),
    ...life.flags.map((f) => ({ x: f.x, z: f.z, hw: 0.4, hd: 0.4 })),
  ];
  if (life.party) {
    const p = life.party;
    taken.push({ x: p.x, z: p.z, hw: p.halfW, hd: p.halfD });
  }
  if (life.pool) {
    const p = life.pool;
    taken.push({ x: p.x, z: p.z, hw: p.halfW + 0.4, hd: p.halfD + 0.4 });
  }
  const innerW = top.width / 2 - ROOF_INSET - 0.6;
  const innerD = top.depth / 2 - ROOF_INSET - 0.6;
  const inside = (x: number, z: number) =>
    Math.abs(x - b.x) <= innerW && Math.abs(z - b.z) <= innerD;
  const free = (x: number, z: number) =>
    inside(x, z) &&
    taken.every((t) => !overlaps({ x, z, hw: 0.3, hd: 0.3 }, t, 0.35));
  const y = b.height;
  const add = (x: number, z: number, yaw: number, salt: number) => {
    if (!free(x, z)) return;
    taken.push({ x, z, hw: 0.3, hd: 0.3 });
    out.push({
      kind: LifeKind.WALKER,
      x: wrapCoord(x),
      y,
      z: wrapCoord(z),
      yaw,
      tone: hash3(x, y, z, salt),
      height: 0.92 + hash3(x, y, z, salt + 1) * 0.2,
      high: 1,
      phase: hash3(x, y, z, salt + 2),
      arm: 0,
    });
  };
  // Loungers beside an L8 pool, facing the water.
  if (life.pool) {
    const p = life.pool;
    const longX = p.halfW >= p.halfD;
    for (const s of [-1, 1]) {
      const x = longX ? p.x + s * p.halfW * 0.4 : p.x + s * (p.halfW + 1.1);
      const z = longX ? p.z + s * (p.halfD + 1.1) : p.z + s * p.halfD * 0.4;
      add(x, z, longX ? yawOf(0, -s) : yawOf(-s, 0), 10 + s);
    }
  }
  // A few people at the parapet of a terrace, looking out over the street.
  if (hash3(b.x, y, b.z, 20) < TERRACE_CHANCE) {
    const longX = top.width >= top.depth;
    const s = hash3(b.x, y, b.z, 21) < 0.5 ? -1 : 1;
    const n = 2 + Math.floor(hash3(b.x, y, b.z, 22) * 2);
    for (let i = 0; i < n; i++) {
      const along = (i - (n - 1) / 2) * 0.8;
      const x = longX ? b.x + along : b.x + s * innerW;
      const z = longX ? b.z + s * innerD : b.z + along;
      add(x, z, longX ? yawOf(0, s) : yawOf(s, 0), 30 + i * 3);
    }
  }
}

// --- Sanity helpers the tests (and QA) share -----------------------------------------

/** Distance from a canonical coordinate to its nearest street centreline. */
export const offCentre = (v: number): number => {
  const m = mod(v, P);
  return Math.min(m, P - m);
};

/** True when a ground point lies on a painted crosswalk band of one street
 * (inside the roadway of one axis, 15–19 m off the other axis's centreline). */
export function onCrosswalk(x: number, z: number): boolean {
  const ox = offCentre(x);
  const oz = offCentre(z);
  const band = (o: number) =>
    o >= INTERSECTION_HALF && o <= INTERSECTION_HALF + 4;
  return (oz < CURB_LINE && band(ox)) || (ox < CURB_LINE && band(oz));
}
