// E1 Air force — the shared, pure half of the SQUADRONS: the cheap tier of
// the enemy air force that lets a room field hundreds of real planes. The
// server flies them (server/src/squadrons.ts), the wire carries a squadron
// in formation as ONE row, and the client expands that row back into its
// planes with exactly this code — so what the server shoots at and what
// every client draws are the same poses.
//
//  - A squadron is up to SQUAD_SIZE planes holding SLOTS off one virtual
//    ANCHOR. The anchor flies a coarse plan (a patrol lane, a strike
//    stream, an escort loop round an airship); a slot is a fixed offset in
//    the anchor's LEVEL frame (heading only), so a wingman is never lower
//    than the anchor and the anchor's floor clears the whole formation.
//  - Collision avoidance is a coarse ROOFLINE GRID: the tallest roof (plus
//    roof structures and crane hubs) within the formation's reach of each
//    cell. The anchor follows it like terrain, never below it, with a climb
//    cone ahead — no probe fans, no rollouts. Its bands are DERIVED from the
//    ceiling constants (BOT_CEILING_ALT, SOFT_CEILING), so a retune of the
//    sky moves them with it, and the squadrons stay low over the city.
//  - Close to a human a squadron plane PROMOTES to an ace (the full RoomBots
//    brain) and DEMOTES back into its slot once neither it nor its slot can
//    be seen by anyone (chooseAces: the hysteresis).
//  - A squadron plane shoots only at a human in its forward cone at short
//    range (squadInCone); the server holds that to the DangerBudget.
//
// Not re-exported from common/src/index.ts; import
// "@angels-bandits/common/squadron".

import type { Building } from "./city/index";
import { ROOF_STRUCTURE_MAX_HEIGHT } from "./city/roof-structures";
import {
  BLIMP_ALT,
  BLIMP_HULL,
  BOT_CEILING_ALT,
  BUILDING_MAX_HEIGHT,
  PLAYER_RADIUS,
  SOFT_CEILING,
  WORLD_SIZE,
} from "./constants";
import { decodeSnapshotEntry, encodeSnapshotEntry } from "./net";
import type {
  Pose,
  Quat,
  SnapshotEntry,
  WireSnapshotEntry,
  WireSquadRow,
} from "./protocol";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
  wrapDistance,
} from "./world/index";

// --- Squadrons and their formations --------------------------------------

/** Planes in one squadron, at most (one wire mask byte). */
export const SQUAD_SIZE = 8;

/** One slot: right / up / back of the anchor in its level frame, m. */
export interface Slot {
  r: number;
  u: number;
  b: number;
}

export const FORM_WEDGE = 0;
export const FORM_FINGER = 1;
export const FORM_TRAIL = 2;
export const FORM_ECHELON = 3;
export const FORM_BOX = 4;

const s = (r: number, u: number, b: number): Slot => ({ r, u, b });

/** Every formation's SQUAD_SIZE slots, slot 0 the lead on the anchor. No
 * slot is below the anchor (u ≥ 0): the anchor's floor clears them all. */
export const FORMATIONS: readonly (readonly Slot[])[] = [
  // WEDGE: a broad V, the tail man closing it.
  [
    s(0, 0, 0),
    s(-12, 1.5, 10),
    s(12, 1.5, 10),
    s(-24, 3, 20),
    s(24, 3, 20),
    s(-36, 4.5, 30),
    s(36, 4.5, 30),
    s(0, 5, 26),
  ],
  // FINGER: two finger-fours side by side.
  [
    s(0, 0, 0),
    s(-11, 1, 9),
    s(13, 0.5, 8),
    s(24, 1.5, 17),
    s(-36, 3, 14),
    s(-47, 4, 23),
    s(-25, 3.5, 22),
    s(-14, 4.5, 32),
  ],
  // TRAIL: two staggered columns — the strike stream down an avenue.
  [
    s(0, 0, 0),
    s(9, 1, 6),
    s(0, 2, 14),
    s(9, 3, 20),
    s(0, 4, 28),
    s(9, 5, 34),
    s(0, 6, 42),
    s(9, 7, 48),
  ],
  // ECHELON right.
  [
    s(0, 0, 0),
    s(10, 1.5, 9),
    s(20, 3, 18),
    s(30, 4.5, 27),
    s(40, 6, 36),
    s(-10, 1.5, 9),
    s(-20, 3, 18),
    s(-30, 4.5, 27),
  ],
  // BOX: two rows of four (the heavy strike).
  [
    s(0, 0, 0),
    s(-14, 0, 0),
    s(14, 0, 0),
    s(28, 0, 0),
    s(0, 6, 18),
    s(-14, 6, 18),
    s(14, 6, 18),
    s(28, 6, 18),
  ],
];

/** The farthest any slot sits from its anchor in plan view, m. */
export const FORM_REACH = Math.max(
  ...FORMATIONS.flat().map((sl) => Math.hypot(sl.r, sl.b)),
);
/** The highest any slot sits over its anchor, m. */
export const FORM_TOP = Math.max(...FORMATIONS.flat().map((sl) => sl.u));

/** A squadron spreads from one point (the launch rig) to its slots over
 * this long, ms — the wingmen fan out of the lead instead of appearing. */
export const SQUAD_FORM_UP_MS = 4000;

// --- Altitude bands (derived) ---------------------------------------------

/** Lowest a squadron anchor ever cruises over open ground, m. */
export const SQUAD_FLOOR_ALT = 60;
/** The anchor's clearance over the (already dilated) roofline, m. */
export const SQUAD_CLEAR = 16;
/** Never below roofline + this, whatever the steering says (the hard
 * floor; counted as a clamp), m. */
export const SQUAD_CLEAR_HARD = 8;
/** Below the bots' ceiling and the storm's by this, m (the formation's top
 * included). */
const SQUAD_TOP_MARGIN = 30;
/** The blimp's belly less a margin, m: K1 put its lane over the rooftops,
 * so the squadrons (which never meet a mover by steering) stay under it —
 * and so under the news heli above it. */
const UNDER_BLIMP = BLIMP_ALT - (BLIMP_HULL[1] as number) - PLAYER_RADIUS - 4;
/** The highest an anchor may fly: under BOT_CEILING_ALT, SOFT_CEILING and
 * the blimp's belly with its formation's top and a margin. Over a roof
 * taller than this the squadron steers round instead. */
export const SQUAD_ALT_MAX =
  Math.min(
    BOT_CEILING_ALT - SQUAD_TOP_MARGIN,
    SOFT_CEILING - SQUAD_TOP_MARGIN,
    UNDER_BLIMP,
  ) - FORM_TOP;
/** The cruise cap: just over the generated skyline (roofs and their
 * structures) and its clearance — the squadrons cruise under it and steer
 * round anything that would lift them over it (the landmark supertalls),
 * which keeps them low and among the towers. Never over SQUAD_ALT_MAX. */
export const SQUAD_CRUISE_CAP = Math.min(
  SQUAD_ALT_MAX,
  BUILDING_MAX_HEIGHT + ROOF_STRUCTURE_MAX_HEIGHT + SQUAD_CLEAR + 10,
);
/** A squadron's preferred height over its terrain-following floor, m — a
 * per-squadron draw in [0, this): low and close over the roofs. */
export const SQUAD_PREF_MAX = 40;

// --- Kinematics ------------------------------------------------------------

/** Cruise airspeed range, m/s (a per-squadron draw). */
export const SQUAD_SPEED_MIN = 66;
export const SQUAD_SPEED_MAX = 80;
/** Heading rate, rad/s. */
export const SQUAD_TURN_RATE = 0.5;
/** Steepest climb and dive, rad. */
const SQUAD_CLIMB_MAX = (40 * Math.PI) / 180;
const SQUAD_DIVE_MAX = (22 * Math.PI) / 180;
/** Pitch rate, rad/s. */
const SQUAD_PITCH_RATE = 1.4;
/** The climb cone the lookahead assumes: a roof d m ahead raises today's
 * need by its height minus d × this (flatter than SQUAD_CLIMB_MAX, so the
 * anchor always has climb in hand). */
const SQUAD_CLIMB_GRADE = Math.tan((20 * Math.PI) / 180);
/** Lookahead distances along a candidate heading, m. */
const LOOK_M: readonly number[] = [
  0, 7, 14, 21, 30, 42, 58, 80, 110, 150, 200, 260, 330, 410, 500, 600, 700,
];
/** Candidate headings off the plan's, rad (0 first: ties keep the plan). */
const STEER_OFFSETS: readonly number[] = [
  0,
  0.35,
  -0.35,
  0.7,
  -0.7,
  1.1,
  -1.1,
  1.6,
  -1.6,
  2.2,
  -2.2,
  Math.PI,
];
/** Banked turn lean limit, rad, and its spring rate, 1/s. */
const SQUAD_BANK_MAX = 0.9;
const SQUAD_BANK_RATE = 3;
/** Boxed in: the chosen way's floor this far over the anchor, m. */
const SQUAD_BOXED_M = 60;
/** The height command looks this far ahead of the anchor, s. */
const SQUAD_LEAD_S = 0.8;
const scratchLead: Vec3 = { x: 0, y: 0, z: 0 };
const G = 9.81;

// --- Roofline grid ----------------------------------------------------------

/** Grid cell, m (divides WORLD_SIZE). */
export const ROOF_CELL = 10;
const ROOF_N = WORLD_SIZE / ROOF_CELL;
/** How far the roofline is dilated: the formation's reach, the plane's
 * radius and a tick's travel at top speed, m. */
export const ROOF_DILATE =
  FORM_REACH + PLAYER_RADIUS + SQUAD_SPEED_MAX / 20 + 2;

/** A column the grid also stands up (a crane hub and its jib's sweep). */
export interface RoofColumn {
  x: number;
  z: number;
  r: number;
  top: number;
}

/**
 * The tallest thing standing within ROOF_DILATE of each ROOF_CELL cell, m —
 * every building at its intact height plus ROOF_STRUCTURE_MAX_HEIGHT when it
 * has roof structures, every column at its top. Conservative by
 * construction (square dilation of a square cell, intact heights): a point
 * at floorAt(x, z) + PLAYER_RADIUS or more, and anything within ROOF_DILATE
 * − PLAYER_RADIUS of it horizontally, touches no building. Destruction only
 * lowers what stands, so a grid built once for a room stays safe.
 */
export class RooflineGrid {
  readonly top: Float32Array;
  /** `top` widened by ROOF_SOFT_CELLS more cells: what the lookahead reads.
   * A path can clip the corner of a square cell between two samples; it
   * cannot cross this ring without a sample landing in it, so the climb
   * starts before the hard floor (`top`) is ever reached. */
  readonly soft: Float32Array;

  constructor(top: Float32Array) {
    this.top = top;
    this.soft = maxFilter(top, ROOF_SOFT_CELLS);
  }

  static build(
    buildings: readonly Building[],
    columns: readonly RoofColumn[] = [],
    dilate: number = ROOF_DILATE,
  ): RooflineGrid {
    const top = new Float32Array(ROOF_N * ROOF_N);
    const stamp = (
      cx: number,
      cz: number,
      hx: number,
      hz: number,
      h: number,
    ) => {
      const x0 = Math.floor((cx - hx - dilate) / ROOF_CELL);
      const x1 = Math.floor((cx + hx + dilate) / ROOF_CELL);
      const z0 = Math.floor((cz - hz - dilate) / ROOF_CELL);
      const z1 = Math.floor((cz + hz + dilate) / ROOF_CELL);
      for (let iz = z0; iz <= z1; iz++) {
        const rz = ((iz % ROOF_N) + ROOF_N) % ROOF_N;
        for (let ix = x0; ix <= x1; ix++) {
          const rx = ((ix % ROOF_N) + ROOF_N) % ROOF_N;
          const k = rz * ROOF_N + rx;
          if ((top[k] as number) < h) top[k] = h;
        }
      }
    };
    for (const b of buildings) {
      const h = b.height + (b.roof?.length ? ROOF_STRUCTURE_MAX_HEIGHT : 0);
      stamp(b.x, b.z, b.width / 2, b.depth / 2, h);
    }
    for (const c of columns) stamp(c.x, c.z, c.r, c.r, c.top);
    return new RooflineGrid(top);
  }

  /** The dilated roofline under (x, z), m (0 over open ground). */
  at(x: number, z: number): number {
    return this.top[cellOf(x, z)] as number;
  }

  /** The lookahead's (wider) roofline under (x, z), m. */
  ahead(x: number, z: number): number {
    return this.soft[cellOf(x, z)] as number;
  }
}

/** The grid index of (x, z), torus-wrapped (integer arithmetic: this is
 * the squadrons' innermost loop). */
function cellOf(x: number, z: number): number {
  const ix = Math.floor(x / ROOF_CELL) % ROOF_N;
  const iz = Math.floor(z / ROOF_CELL) % ROOF_N;
  return (iz < 0 ? iz + ROOF_N : iz) * ROOF_N + (ix < 0 ? ix + ROOF_N : ix);
}

/** How many cells the lookahead's roofline is widened by. */
const ROOF_SOFT_CELLS = 2;

/** A square max filter of radius `r` cells over a torus grid (separable). */
function maxFilter(src: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let z = 0; z < ROOF_N; z++) {
    for (let x = 0; x < ROOF_N; x++) {
      let m = 0;
      for (let d = -r; d <= r; d++) {
        const v = src[z * ROOF_N + ((x + d + ROOF_N) % ROOF_N)] as number;
        if (v > m) m = v;
      }
      tmp[z * ROOF_N + x] = m;
    }
  }
  for (let z = 0; z < ROOF_N; z++) {
    for (let x = 0; x < ROOF_N; x++) {
      let m = 0;
      for (let d = -r; d <= r; d++) {
        const v = tmp[((z + d + ROOF_N) % ROOF_N) * ROOF_N + x] as number;
        if (v > m) m = v;
      }
      out[z * ROOF_N + x] = m;
    }
  }
  return out;
}

// --- The anchor -------------------------------------------------------------

/** A squadron's virtual lead: the pose every slot hangs off. */
export interface SquadAnchor {
  pos: Vec3;
  /** Heading, rad (0 faces −Z, the flight model's convention). */
  yaw: number;
  pitch: number;
  /** The drawn lean of the turn, rad. */
  roll: number;
  speed: number;
  /** The heading the last steering decision chose, rad, and the roofline
   * need along it, m (stepAnchor keeps both). */
  steer: number;
  steerNeed: number;
}

/** Something big and moving the anchor must keep clear of (an airship, the
 * news heli): a vertical cylinder of radius r round pos, ±h. */
export interface SquadObstacle {
  pos: Vec3;
  r: number;
  h: number;
}

/** What one anchor step did (telemetry; the long-sim test reads it). */
export interface SquadStepStats {
  /** Times the hard floor had to lift an anchor (should stay ~0). */
  clamps: number;
}

/**
 * The roofline-following floor ahead: the highest of (roof + SQUAD_CLEAR −
 * d × SQUAD_CLIMB_GRADE) over the lookahead, along the path an anchor at
 * `pos` heading `yaw` flies while it turns toward `toYaw` at
 * SQUAD_TURN_RATE (at `speed`) — the arc, not the straight line, so a
 * tower beside a turn is seen before the turn swings the nose onto it.
 */
export function floorAhead(
  grid: RooflineGrid,
  pos: Vec3,
  yaw: number,
  toYaw: number = yaw,
  speed: number = SQUAD_SPEED_MAX,
): number {
  const perM = SQUAD_TURN_RATE / Math.max(1, speed);
  let h = yaw;
  let left = wrapAngle(toYaw - yaw);
  let x = pos.x;
  let z = pos.z;
  let sx = -Math.sin(yaw);
  let sz = -Math.cos(yaw);
  let prev = 0;
  let need = 0;
  let sum = 0;
  for (let i = 0; i < LOOK_M.length; i++) {
    const d = LOOK_M[i] as number;
    const step = d - prev;
    prev = d;
    if (step > 0) {
      if (left !== 0) {
        // Half the turn before the leg, half after: the chord of the arc.
        const max = perM * step;
        const t1 = Math.max(-max, Math.min(max, left));
        const mid = h + t1 / 2;
        x -= Math.sin(mid) * step;
        z -= Math.cos(mid) * step;
        h += t1;
        left -= t1;
        sx = -Math.sin(h);
        sz = -Math.cos(h);
      } else {
        x += sx * step;
        z += sz * step;
      }
    }
    const roof = grid.ahead(x, z);
    sum += roof;
    const v = roof + SQUAD_CLEAR - d * SQUAD_CLIMB_GRADE;
    if (v > need) need = v;
  }
  aheadMean = sum / LOOK_M.length;
  return need;
}

/** The mean roofline along the last floorAhead() path, m — how much of
 * that way is tall (stepAnchor's tie-break when every way is blocked:
 * the way OUT of a supertall's reach wins). */
let aheadMean = 0;

/** Does flying `yaw` from `pos` at altitude `y` pass inside an obstacle
 * within the lookahead (the formation's reach added)? */
function obstacleAhead(
  pos: Vec3,
  y: number,
  yaw: number,
  obstacles: readonly SquadObstacle[],
): boolean {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  for (let k = 0; k < obstacles.length; k++) {
    const o = obstacles[k] as SquadObstacle;
    if (Math.abs(o.pos.y - y) > o.h + FORM_TOP + SQUAD_CLEAR) continue;
    const r = o.r + FORM_REACH + SQUAD_CLEAR;
    for (let i = 0; i < 8; i++) {
      const d = (LOOK_M[i] as number) * 0.6;
      const dx = wrapDeltaAxis(o.pos.x, pos.x + fx * d);
      const dz = wrapDeltaAxis(o.pos.z, pos.z + fz * d);
      if (dx * dx + dz * dz < r * r) return true;
    }
  }
  return false;
}

const wrapAngle = (a: number): number => {
  const twoPi = Math.PI * 2;
  const m = (((a + Math.PI) % twoPi) + twoPi) % twoPi;
  return m - Math.PI;
};

/**
 * One anchor step of `dt` s toward plan heading `goalYaw`, `pref` m over its
 * floor: pick the candidate heading (the plan's first) whose roofline need
 * fits under SQUAD_CRUISE_CAP and misses every obstacle, turn toward it at
 * SQUAD_TURN_RATE, climb or sink toward the floor ahead + pref, and fly.
 * Never ends below the roofline + SQUAD_CLEAR_HARD. Mutates `a`.
 */
export function stepAnchor(
  a: SquadAnchor,
  goalYaw: number,
  pref: number,
  grid: RooflineGrid,
  obstacles: readonly SquadObstacle[],
  dt: number,
  decide: boolean,
  stats?: SquadStepStats,
): void {
  // Steering (at the decision cadence): the cheapest candidate heading that
  // clears the city and the ships.
  if (decide) {
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < STEER_OFFSETS.length; i++) {
      const yaw = goalYaw + (STEER_OFFSETS[i] as number);
      const need = floorAhead(grid, a.pos, a.yaw, yaw, a.speed);
      let cost = Math.abs(STEER_OFFSETS[i] as number);
      cost += Math.abs(wrapAngle(yaw - a.yaw)) * 0.25;
      // Hysteresis: the last choice is kept unless another is clearly
      // better (no flip-flopping between two near-equal ways).
      cost += Math.abs(wrapAngle(yaw - a.steer)) * 0.3;
      // Behind the climb cone (the roofline ahead is above the anchor):
      // the steeper the climb it would take, the less it wants that way —
      // a tower turned into close is a tower it cannot clear. And a little
      // for height itself: the low way round wins a tie.
      cost += Math.max(0, need - a.pos.y) * 0.2 + need * 0.002;
      cost += aheadMean * 0.005;
      if (need > SQUAD_CRUISE_CAP) cost += 10 + (need - SQUAD_CRUISE_CAP) / 10;
      if (obstacleAhead(a.pos, a.pos.y, yaw, obstacles)) cost += 20;
      if (cost < bestCost) {
        bestCost = cost;
        a.steer = yaw;
        a.steerNeed = need;
      }
    }
  }
  const bestYaw = a.steer;
  const bestNeed = a.steerNeed;
  const turn = wrapAngle(bestYaw - a.yaw);
  // Boxed in (the best way still needs far more climb than the anchor has
  // height): break hard — twice the turn rate — out of the tall block.
  const boxed = bestNeed - a.pos.y > SQUAD_BOXED_M;
  const maxTurn = SQUAD_TURN_RATE * (boxed ? 2 : 1) * dt;
  const dyaw = Math.max(-maxTurn, Math.min(maxTurn, turn));
  a.yaw = wrapAngle(a.yaw + dyaw);
  // The lean of a coordinated turn, sprung.
  const lean = Math.max(
    -SQUAD_BANK_MAX,
    Math.min(SQUAD_BANK_MAX, Math.atan((a.speed * (dyaw / dt)) / G)),
  );
  a.roll += (-lean - a.roll) * Math.min(1, SQUAD_BANK_RATE * dt);

  // Height: follow the floor ahead — along the nose now, from where the
  // anchor will be in SQUAD_LEAD_S (the feed-forward that keeps a rising
  // floor from outrunning the climb) and along the heading it is turning
  // to — never under it, `pref` over it, low and under the cap.
  const lead = a.speed * SQUAD_LEAD_S;
  scratchLead.x = a.pos.x - Math.sin(a.yaw) * lead;
  scratchLead.y = a.pos.y;
  scratchLead.z = a.pos.z - Math.cos(a.yaw) * lead;
  const floor = Math.max(
    bestNeed,
    floorAhead(grid, a.pos, a.yaw, bestYaw, a.speed),
    floorAhead(grid, scratchLead, a.yaw, bestYaw, a.speed),
  );
  const target = Math.max(
    floor,
    Math.min(SQUAD_CRUISE_CAP, Math.max(SQUAD_FLOOR_ALT, floor + pref)),
  );
  const vy = Math.max(
    -a.speed * Math.sin(SQUAD_DIVE_MAX),
    Math.min(a.speed * Math.sin(SQUAD_CLIMB_MAX), (target - a.pos.y) * 2.5),
  );
  const pitchWant = Math.asin(vy / a.speed);
  const maxPitch = SQUAD_PITCH_RATE * dt;
  a.pitch += Math.max(-maxPitch, Math.min(maxPitch, pitchWant - a.pitch));

  const cp = Math.cos(a.pitch);
  a.pos.x = wrapCoord(a.pos.x - Math.sin(a.yaw) * cp * a.speed * dt);
  a.pos.z = wrapCoord(a.pos.z - Math.cos(a.yaw) * cp * a.speed * dt);
  a.pos.y += Math.sin(a.pitch) * a.speed * dt;
  const hard = grid.at(a.pos.x, a.pos.z) + SQUAD_CLEAR_HARD;
  if (a.pos.y < hard) {
    a.pos.y = hard;
    if (a.pitch < 0) a.pitch = 0;
    if (stats) stats.clamps++;
  }
}

// --- Plans -------------------------------------------------------------------

export const PLAN_LANE = 0;
export const PLAN_STREAM = 1;
export const PLAN_ESCORT = 2;
export type PlanKind = 0 | 1 | 2;

/** A squadron's coarse plan. LANE: along a world axis at `cross` (`dir`
 * ±1), endless on the torus. STREAM: at a point, then the next one. ESCORT:
 * round `center` at `radius`, `dir` ±1 (counter-/clockwise). */
export interface SquadPlan {
  kind: PlanKind;
  axis: "x" | "z";
  cross: number;
  dir: 1 | -1;
  center: Vec3;
  radius: number;
}

/** The heading `plan` asks of an anchor at `pos`, rad. */
export function planYaw(plan: SquadPlan, pos: Vec3): number {
  if (plan.kind === PLAN_LANE) {
    // Along the axis, easing onto the lane (≤ ~35° of correction).
    const off =
      plan.axis === "x"
        ? wrapDeltaAxis(pos.z, plan.cross)
        : wrapDeltaAxis(pos.x, plan.cross);
    const lean = Math.max(-0.6, Math.min(0.6, off / 200));
    if (plan.axis === "x") {
      // +x is yaw −π/2, −x is +π/2; the lane's z offset leans the nose.
      const base = plan.dir === 1 ? -Math.PI / 2 : Math.PI / 2;
      return base + (plan.dir === 1 ? -lean : lean);
    }
    const base = plan.dir === 1 ? Math.PI : 0;
    return base + (plan.dir === 1 ? lean : -lean);
  }
  const dx = wrapDeltaAxis(pos.x, plan.center.x);
  const dz = wrapDeltaAxis(pos.z, plan.center.z);
  if (plan.kind === PLAN_STREAM) return Math.atan2(-dx, -dz);
  // ESCORT: tangent to the circle, eased onto its radius.
  const d = Math.hypot(dx, dz) || 1;
  const radial = Math.atan2(-dx, -dz);
  const err = Math.max(-1, Math.min(1, (d - plan.radius) / plan.radius));
  return radial - plan.dir * (Math.PI / 2) * (1 - err);
}

// --- Slots and poses -----------------------------------------------------------

/** Unit quaternion of a yaw / pitch / roll attitude (Euler YXZ, Three.js
 * order — RoomBots.poseOf's convention). */
export function attitudeQuatInto(
  yaw: number,
  pitch: number,
  roll: number,
  out: Quat,
): Quat {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cx = Math.cos(pitch / 2);
  const sx = Math.sin(pitch / 2);
  const cz = Math.cos(roll / 2);
  const sz = Math.sin(roll / 2);
  out.x = sx * cy * cz + cx * sy * sz;
  out.y = cx * sy * cz - sx * cy * sz;
  out.z = cx * cy * sz - sx * sy * cz;
  out.w = cx * cy * cz + sx * sy * sz;
  return out;
}

/** The heading of a pose's nose, rad (0 faces −Z). */
export function quatYaw(q: Quat): number {
  // The rotated −Z axis' plan components.
  const fx = -2 * q.w * q.y - 2 * q.x * q.z;
  const fz = -1 + 2 * q.x * q.x + 2 * q.y * q.y;
  return Math.atan2(-fx, -fz);
}

/**
 * Slot `slot` of formation `form` off anchor pose `anchor`, the formation
 * opened to `spread` (0: every plane on the anchor, 1: on its slot) —
 * written into `out`. The offset turns with the anchor's HEADING only; the
 * wingman flies the anchor's attitude and speed. Pure: the server and every
 * client compute exactly this from the same (quantised) anchor.
 */
export function slotPoseInto(
  anchor: Pose,
  form: number,
  slot: number,
  spread: number,
  out: Pose,
): Pose {
  const sl = (FORMATIONS[form] ?? (FORMATIONS[0] as readonly Slot[]))[slot] as
    | Slot
    | undefined;
  const r = (sl?.r ?? 0) * spread;
  const u = (sl?.u ?? 0) * spread;
  const b = (sl?.b ?? 0) * spread;
  const yaw = quatYaw(anchor.quat);
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  // right = (cos, 0, −sin), back = (sin, 0, cos).
  out.pos.x = wrapCoord(anchor.pos.x + c * r + sn * b);
  out.pos.y = anchor.pos.y + u;
  out.pos.z = wrapCoord(anchor.pos.z - sn * r + c * b);
  out.quat.x = anchor.quat.x;
  out.quat.y = anchor.quat.y;
  out.quat.z = anchor.quat.z;
  out.quat.w = anchor.quat.w;
  out.speed = anchor.speed;
  return out;
}

// --- Promotion ---------------------------------------------------------------

/** A squadron plane this close to a human (m) is wanted as an ace. */
export const PROMOTE_M = 600;
/** An ace demotes only once it — and the slot it would take — is at least
 * this far from every human: past the camera's far plane (900 m), so the
 * hand-back is never seen. */
export const DEMOTE_M = 950;
/** Aces in a room: ACE_MIN with one human, ACE_PER_HUMAN more for each
 * other one, never past ACE_MAX. */
export const ACE_MIN = 12;
export const ACE_PER_HUMAN = 4;
export const ACE_MAX = 24;

export const aceCap = (humans: number): number =>
  Math.max(ACE_MIN, Math.min(ACE_MAX, ACE_MIN + ACE_PER_HUMAN * (humans - 1)));

/** One enemy plane as the promotion pass sees it. */
export interface AceCandidate {
  id: string;
  /** Its distance to the nearest human, m. */
  dist: number;
  /** Its slot's distance to the nearest human, m (aces only; a squadron
   * plane is on its slot). */
  slotDist: number;
  ace: boolean;
  /** Must stay an ace whatever the distances (a bomb run). */
  locked: boolean;
}

/**
 * Who changes tier this tick. An ace demotes only with it AND its slot at
 * DEMOTE_M or more from every human (and not locked); a squadron plane
 * promotes within PROMOTE_M, nearest first, while the aces stay under
 * `cap`. The gap between the two distances is the hysteresis: a plane
 * cannot flicker between tiers. Over the cap (humans left), demotable aces
 * go first, farthest first — a visible ace is never forced back. Pure.
 */
export function chooseAces(
  cands: readonly AceCandidate[],
  cap: number,
): { promote: string[]; demote: string[] } {
  const demote: string[] = [];
  let aces = 0;
  for (const c of cands) {
    if (!c.ace) continue;
    if (!c.locked && c.dist >= DEMOTE_M && c.slotDist >= DEMOTE_M) {
      demote.push(c.id);
    } else {
      aces++;
    }
  }
  const want = cands
    .filter((c) => !c.ace && c.dist <= PROMOTE_M)
    .sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
  const promote: string[] = [];
  for (const c of want) {
    if (aces >= cap) break;
    promote.push(c.id);
    aces++;
  }
  return { promote, demote };
}

// --- Fire ----------------------------------------------------------------------

/** A squadron plane fires only at a human this close, m… */
export const SQUAD_FIRE_RANGE = 260;
/** …and inside this half-angle of its nose, rad. */
export const SQUAD_FIRE_CONE = (5 * Math.PI) / 180;
const FIRE_COS = Math.cos(SQUAD_FIRE_CONE);

/** Is `target` in the forward cone of a plane at `pos` flying `fwd` (unit),
 * within SQUAD_FIRE_RANGE? Torus-safe. */
export function squadInCone(pos: Vec3, fwd: Vec3, target: Vec3): boolean {
  const dx = wrapDeltaAxis(pos.x, target.x);
  const dy = target.y - pos.y;
  const dz = wrapDeltaAxis(pos.z, target.z);
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > SQUAD_FIRE_RANGE * SQUAD_FIRE_RANGE || d2 < 1) return false;
  return (dx * fwd.x + dy * fwd.y + dz * fwd.z) / Math.sqrt(d2) >= FIRE_COS;
}

// --- The wire ---------------------------------------------------------------------

/** One squadron in formation as the server holds it for the wire. */
export interface SquadRow {
  /** Slot 0's plane id; slot k's is squadMemberId(id0, k). */
  id0: string;
  anchor: Pose;
  form: number;
  /** 0..1, how far open the formation is. */
  spread: number;
  prot: boolean;
  /** Bit k: slot k's plane is up and in formation. */
  mask: number;
  /** HP of each plane in the mask, in slot order. */
  hp: readonly number[];
}

/** Wire units of `spread`. */
const SPREAD_SCALE = 100;

/** Slot `k`'s plane id in the squadron whose slot 0 is `id0`: the ids of a
 * squadron are minted in one run, so they count up from slot 0's. */
export function squadMemberId(id0: string, k: number): string {
  const cut = id0.lastIndexOf(":");
  return `${id0.slice(0, cut + 1)}${Number(id0.slice(cut + 1)) + k}`;
}

/** Quantise one squadron row for the wire (the anchor through the snapshot
 * entry's own quantisation). */
export function encodeSquadRow(row: SquadRow): WireSquadRow {
  const e = encodeSnapshotEntry({
    id: row.id0,
    pose: row.anchor,
    hp: 0,
    prot: false,
  });
  const out: WireSquadRow = [
    row.id0,
    e[1],
    e[2],
    e[3],
    e[4],
    e[5],
    e[6],
    e[7],
    e[8],
    row.form,
    Math.round(Math.max(0, Math.min(1, row.spread)) * SPREAD_SCALE),
    row.prot ? 1 : 0,
    row.mask,
  ];
  for (const hp of row.hp) out.push(Math.round(hp));
  return out;
}

/** The anchor pose, form and spread of a wire row, as every reader sees it
 * (the server flies its wingmen off exactly this). */
export function decodeSquadRow(w: WireSquadRow): {
  id0: string;
  anchor: Pose;
  form: number;
  spread: number;
  prot: boolean;
  mask: number;
} {
  const e = decodeSnapshotEntry([
    w[0],
    w[1],
    w[2],
    w[3],
    w[4],
    w[5],
    w[6],
    w[7],
    w[8],
    0,
  ] as WireSnapshotEntry);
  return {
    id0: w[0],
    anchor: e.pose,
    form: w[9],
    spread: w[10] / SPREAD_SCALE,
    prot: w[11] === 1,
    mask: w[12],
  };
}

/** Is `w` a well-formed squadron row? */
export function isSquadRow(w: unknown): w is WireSquadRow {
  if (!Array.isArray(w) || w.length < 13 || typeof w[0] !== "string") {
    return false;
  }
  for (let i = 1; i < w.length; i++) {
    if (typeof w[i] !== "number" || !Number.isFinite(w[i])) return false;
  }
  const mask = w[12] as number;
  let bits = 0;
  for (let k = 0; k < SQUAD_SIZE; k++) if (mask & (1 << k)) bits++;
  return w.length === 13 + bits && mask >= 0 && mask < 1 << SQUAD_SIZE;
}

/** Expand a squadron row into one snapshot entry per plane in formation,
 * appended to `out` — what the client's interpolation buffers take, so a
 * plane is the same remote whether it came as a row or on its own. */
export function expandSquadRow(w: WireSquadRow, out: SnapshotEntry[]): void {
  const row = decodeSquadRow(w);
  let h = 13;
  for (let k = 0; k < SQUAD_SIZE; k++) {
    if (!(row.mask & (1 << k))) continue;
    const pose: Pose = {
      pos: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      speed: 0,
    };
    slotPoseInto(row.anchor, row.form, k, row.spread, pose);
    out.push({
      id: squadMemberId(row.id0, k),
      pose,
      hp: w[h++] as number,
      prot: row.prot,
    });
  }
}

// --- Distances --------------------------------------------------------------------

/** The nearest of `points` to `p`, m (∞ with none). */
export function nearestDistance(p: Vec3, points: readonly Vec3[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const q of points) {
    const d = wrapDistance(p, q);
    if (d < best) best = d;
  }
  return best;
}

/** The roofline columns of the L2 cranes: each hub's jib sweep, from the
 * ground to a little over the hub. */
export function craneColumns(
  cranes: readonly {
    x: number;
    z: number;
    hubY: number;
    jibLength: number;
    counterLength: number;
  }[],
): RoofColumn[] {
  return cranes.map((c) => ({
    x: c.x,
    z: c.z,
    r: Math.max(c.jibLength, c.counterLength),
    top: c.hubY + 12,
  }));
}
