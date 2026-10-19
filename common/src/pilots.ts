// I1 Individual pilots — the shared, pure half of the E1 air force's cheap
// tier: the brain that lets a room field hundreds of real enemy planes, each
// flying ALONE. The server flies them (server/src/pilots.ts); the wire
// carries each as an ordinary snapshot entry, so there is nothing to expand.
//
//  - Every pilot has a seeded PERSONALITY (personalityOf): aggression,
//    skill, preferred altitude, turn style (rate and lean), risk taking,
//    cruise speed and a weave of its own. No two planes fly alike: no
//    parallel tracks, no mirrored turns, no evenly spaced groups.
//  - Every pilot has its own INTENT (chooseIntent), re-thought on a
//    staggered fraction of the pilots each tick: hunt a human, patrol a
//    district, strafe a street, escort an airship loosely, jump on a
//    human's tail, climb to dive-attack, break off when hit, flee when
//    burning. Pilots may meet and tangle; nothing holds formation, and a
//    pilot that finds itself flying another's line (SEP_M, SEP_COS) peels
//    off it (flyPilots' separation pass).
//  - Collision avoidance is a coarse ROOFLINE GRID: the tallest roof (plus
//    roof structures and crane hubs) near each cell, dilated for ONE plane.
//    A pilot follows it like terrain, never below it, with a climb cone
//    ahead — no probe fans, no rollouts — and steers round the supertalls
//    it may not climb over and the airships. Its bands are DERIVED from the
//    ceiling constants (BOT_CEILING_ALT, SOFT_CEILING), so a retune of the
//    sky moves them with it.
//  - Steering re-plans (the candidate headings) on a staggered fraction of
//    the pilots per tick (DECIDE_EVERY), so 500 stay inside the tick.
//  - Close to a human a pilot PROMOTES to an ace (the full RoomBots brain)
//    and DEMOTES back to its pilot once nobody can see it (chooseAces: the
//    hysteresis).
//  - A pilot shoots only at a human in its forward cone at short range
//    (pilotInCone); the server holds that to the DangerBudget.
//
// Not re-exported from common/src/index.ts; import
// "@angels-bandits/common/pilots".

import type { Building } from "./city/index";
import { mulberry32 } from "./city/rng";
import { ROOF_STRUCTURE_MAX_HEIGHT } from "./city/roof-structures";
import { nearestStreet } from "./city/street";
import {
  BLIMP_ALT,
  BLIMP_HULL,
  BOT_CEILING_ALT,
  BUILDING_MAX_HEIGHT,
  MAX_HP,
  PLAYER_RADIUS,
  SMOKE_HP_FRAC,
  SOFT_CEILING,
  WORLD_SIZE,
} from "./constants";
import type { Quat } from "./protocol";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
  wrapDistance,
} from "./world/index";

// --- Altitude bands (derived) ---------------------------------------------

/** Lowest a pilot ever cruises over open ground, m. */
export const PILOT_FLOOR_ALT = 60;
/** A pilot's clearance over the (already dilated) roofline, m. */
export const PILOT_CLEAR = 16;
/** Never below roofline + this, whatever the steering says (the hard
 * floor; counted as a clamp), m. */
export const PILOT_CLEAR_HARD = 8;
/** Below the bots' ceiling and the storm's by this, m. */
const PILOT_TOP_MARGIN = 30;
/** The blimp's belly less a margin, m: K1 put its lane over the rooftops,
 * so the pilots (which never meet a mover by steering) stay under it — and
 * so under the news heli above it. */
const UNDER_BLIMP = BLIMP_ALT - (BLIMP_HULL[1] as number) - PLAYER_RADIUS - 4;
/** The highest a pilot may fly: under BOT_CEILING_ALT, SOFT_CEILING and the
 * blimp's belly with a margin. Over a roof taller than this it steers round
 * instead. */
export const PILOT_ALT_MAX = Math.min(
  BOT_CEILING_ALT - PILOT_TOP_MARGIN,
  SOFT_CEILING - PILOT_TOP_MARGIN,
  UNDER_BLIMP,
);
/** The cruise cap: just over the generated skyline (roofs and their
 * structures) and its clearance — the pilots cruise under it and steer
 * round anything that would lift them over it (the landmark supertalls),
 * which keeps them low and among the towers. Never over PILOT_ALT_MAX. */
export const PILOT_CRUISE_CAP = Math.min(
  PILOT_ALT_MAX,
  BUILDING_MAX_HEIGHT + ROOF_STRUCTURE_MAX_HEIGHT + PILOT_CLEAR + 10,
);
/** A pilot's preferred height over its terrain-following floor, m — a
 * per-pilot draw in [0, this). */
export const PILOT_PREF_MAX = 60;

// --- Kinematics ------------------------------------------------------------

/** Cruise airspeed range, m/s (a per-pilot draw). */
export const PILOT_SPEED_MIN = 62;
export const PILOT_SPEED_MAX = 84;
/** The fastest any pilot ever flies (a dive or a flight), m/s. */
export const PILOT_SPEED_TOP = 96;
/** Heading rate of an average pilot, rad/s (each one's own is this times
 * its personality's `turn`). */
export const PILOT_TURN_RATE = 0.7;
/** Steepest climb, cruise dive and dive-attack, rad. */
const CLIMB_MAX = (40 * Math.PI) / 180;
const DIVE_MAX = (22 * Math.PI) / 180;
const ATTACK_DIVE_MAX = (36 * Math.PI) / 180;
/** Pitch rate, rad/s. */
const PITCH_RATE = 1.4;
/** The climb cone the lookahead assumes: a roof d m ahead raises today's
 * need by its height minus d × this (flatter than CLIMB_MAX, so a pilot
 * always has climb in hand). */
const CLIMB_GRADE = Math.tan((16 * Math.PI) / 180);
/** Lookahead distances along a candidate heading, m. */
const LOOK_M: readonly number[] = [
  0, 7, 14, 21, 30, 42, 58, 80, 110, 150, 200, 260, 330, 410, 500, 600, 700,
];
/** Candidate headings off the goal's, rad (0 first: ties keep the goal). */
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
/** Banked turn lean limit, rad, and its spring rate, 1/s (each scaled by
 * the personality's `bank`). */
const BANK_MAX = 0.9;
const BANK_RATE = 3;
/** A way whose floor is this far over the pilot is more climb than it can
 * be sure to make in time, m. */
const CLIMB_FEASIBLE_M = 15;
/** Boxed in: the chosen way's floor this far over the pilot, m. */
const BOXED_M = 12;
/** The height command's climb cone starts this far ahead of the pilot, s,
 * and the hard floor it never goes under is read this far ahead, s. */
const LEAD_S = 1.2;
const NEAR_LEAD_S = 0.6;
/** Speed change toward the wanted speed, m/s². */
const SPEED_EASE = 7;
const G = 9.81;
const scratchLead: Vec3 = { x: 0, y: 0, z: 0 };

// --- Roofline grid ----------------------------------------------------------

/** Grid cell, m (divides WORLD_SIZE). */
export const ROOF_CELL = 10;
const ROOF_N = WORLD_SIZE / ROOF_CELL;
/** How far the roofline is dilated: the plane's radius, a tick's travel at
 * top speed and a margin, m. */
export const ROOF_DILATE = PLAYER_RADIUS + PILOT_SPEED_TOP / 20 + 4;

/** A column the grid also stands up (a crane hub and its jib's sweep). */
export interface RoofColumn {
  x: number;
  z: number;
  r: number;
  top: number;
}

/** Something a pilot must keep clear of (an airship, a supertall): a
 * vertical cylinder of radius r round pos, ±h. */
export interface PilotObstacle {
  pos: Vec3;
  r: number;
  h: number;
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

  /** The buildings no pilot may climb over (a spire past PILOT_ALT_MAX with
   * its clearance), as obstacles to steer round: what keeps the pilots out
   * of the deck. */
  readonly walls: readonly PilotObstacle[];

  constructor(top: Float32Array, walls: readonly PilotObstacle[] = []) {
    this.top = top;
    this.soft = maxFilter(top, ROOF_SOFT_CELLS);
    this.walls = walls;
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
    const walls: PilotObstacle[] = [];
    for (const b of buildings) {
      const h = b.height + (b.roof?.length ? ROOF_STRUCTURE_MAX_HEIGHT : 0);
      if (h + PILOT_CLEAR <= PILOT_ALT_MAX) continue;
      walls.push({
        pos: { x: b.x, y: 0, z: b.z },
        r: Math.hypot(b.width, b.depth) / 2 + PLAYER_RADIUS + WALL_MARGIN,
        h: Number.POSITIVE_INFINITY,
      });
    }
    return new RooflineGrid(top, walls);
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
 * the pilots' innermost loop). */
function cellOf(x: number, z: number): number {
  const ix = Math.floor(x / ROOF_CELL) % ROOF_N;
  const iz = Math.floor(z / ROOF_CELL) % ROOF_N;
  return (iz < 0 ? iz + ROOF_N : iz) * ROOF_N + (ix < 0 ? ix + ROOF_N : ix);
}

/** How many cells the lookahead's roofline is widened by. */
const ROOF_SOFT_CELLS = 2;
/** A wall's berth beyond its footprint, m: wide enough that the soft
 * roofline round a spire is met by the steering before the climb. */
const WALL_MARGIN = 45;

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

// --- Personality -------------------------------------------------------------

/** Who a pilot is: every field a seeded draw (personalityOf). */
export interface Personality {
  /** 0..1: hunts and tails rather than patrols, presses closer. */
  aggression: number;
  /** 0..1: how well it leads a target and holds its fire for a shot. */
  skill: number;
  /** Its height over the terrain-following floor, m [0, PILOT_PREF_MAX). */
  prefAlt: number;
  /** Turn style: its heading rate over PILOT_TURN_RATE (0.75–1.35)… */
  turn: number;
  /** …and how hard it leans into a turn (0.6–1.3). */
  bank: number;
  /** 0..1: dives on a target, stays in a fight hurt, flies close. */
  risk: number;
  /** Its cruise airspeed, m/s. */
  speed: number;
  /** Its weave: a slow swing of the heading it wants, rad, Hz, rad. */
  weaveAmp: number;
  weaveHz: number;
  weavePhase: number;
  /** Which way it breaks when hit (+1 right, −1 left). */
  side: 1 | -1;
}

/** A pilot's personality from its seed. Deterministic: the same seed is
 * always the same pilot. */
export function personalityOf(seed: number): Personality {
  const r = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  return {
    aggression: r(),
    skill: r(),
    prefAlt: r() * PILOT_PREF_MAX,
    turn: 0.75 + r() * 0.6,
    bank: 0.6 + r() * 0.7,
    risk: r(),
    speed: PILOT_SPEED_MIN + r() * (PILOT_SPEED_MAX - PILOT_SPEED_MIN),
    weaveAmp: 0.06 + r() * 0.3,
    weaveHz: 0.02 + r() * 0.1,
    weavePhase: r() * Math.PI * 2,
    side: r() < 0.5 ? 1 : -1,
  };
}

// --- Intents -------------------------------------------------------------------

export const INTENT_PATROL = 0;
export const INTENT_STRAFE = 1;
export const INTENT_ESCORT = 2;
export const INTENT_HUNT = 3;
export const INTENT_TAIL = 4;
export const INTENT_DIVE = 5;
export const INTENT_BREAK = 6;
export const INTENT_FLEE = 7;
export type Intent = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const INTENT_COUNT = 8;

/** Below this HP a plane is burning (it trails smoke): it flees. */
export const PILOT_BURNING_HP = MAX_HP * SMOKE_HP_FRAC;
/** A human this close (m) is worth an attack; past it, only the bold go. */
export const PILOT_HUNT_M = 1100;

/** What a pilot weighs when it chooses what to do. */
export interface PilotSituation {
  hp: number;
  /** Took damage since it last thought. */
  hit: boolean;
  /** To the nearest human, m (∞ with none). */
  humanDist: number;
  /** An airship to escort is up. */
  ship: boolean;
}

/**
 * What a pilot does next, from who it is, where it is, and a uniform draw
 * `r` in [0, 1). Burning: flee. Hit: break off. Otherwise a weighted pick —
 * the aggressive hunt, tail and (the risk takers) dive on a human within
 * PILOT_HUNT_M; the rest patrol a district, strafe a street or escort an
 * airship. Pure.
 */
export function chooseIntent(
  p: Personality,
  s: PilotSituation,
  r: number,
): Intent {
  if (s.hp > 0 && s.hp < PILOT_BURNING_HP) return INTENT_FLEE;
  if (s.hit) return INTENT_BREAK;
  const near = s.humanDist <= PILOT_HUNT_M;
  const reach = near ? 1 : s.humanDist < Number.POSITIVE_INFINITY ? 0.25 : 0;
  const w = scratchWeights;
  w[INTENT_PATROL] = 0.5 + (1 - p.aggression) * 0.8;
  w[INTENT_STRAFE] = 0.3 + p.risk * 0.5;
  w[INTENT_ESCORT] = s.ship ? 0.25 + (1 - p.risk) * 0.5 : 0;
  w[INTENT_HUNT] = reach * (0.2 + p.aggression * 1.6);
  w[INTENT_TAIL] = reach * p.aggression * (0.3 + p.skill);
  w[INTENT_DIVE] = reach * p.risk * (0.2 + p.aggression * 0.8);
  w[INTENT_BREAK] = 0;
  w[INTENT_FLEE] = 0;
  let sum = 0;
  for (let i = 0; i < INTENT_COUNT; i++) sum += w[i] as number;
  let x = r * sum;
  for (let i = 0; i < INTENT_COUNT; i++) {
    x -= w[i] as number;
    if (x < 0) return i as Intent;
  }
  return INTENT_PATROL;
}

const scratchWeights = new Float64Array(INTENT_COUNT);

// --- The pilot -------------------------------------------------------------------

/** A flying human as the pilots see it. */
export interface PilotHuman {
  id: string;
  pos: Vec3;
  vel: Vec3;
}

/** An airship as the pilots see it this tick: an obstacle and something to
 * escort. */
export interface PilotShip {
  id: number;
  pos: Vec3;
  /** Plan reach and half-height, m. */
  r: number;
  h: number;
}

/** What the pilots fly in this tick. */
export interface PilotWorld {
  now: number;
  humans: readonly PilotHuman[];
  ships: readonly PilotShip[];
  grid: RooflineGrid;
}

/** One pilot: who it is, what it is doing, and its flight. */
export interface Pilot {
  id: string;
  /** Its stagger number: which ticks it thinks and re-plans on. */
  idx: number;
  persona: Personality;
  rand: () => number;
  pos: Vec3;
  /** Heading, rad (0 faces −Z, the flight model's convention). */
  yaw: number;
  pitch: number;
  /** The drawn lean of the turn, rad. */
  roll: number;
  speed: number;
  /** The heading the last steering decision chose, rad, and the roofline
   * need along it, m (stepPilot keeps both). */
  steer: number;
  steerNeed: number;
  /** The roofline floor ahead along its way, and toward the heading it
   * wants (under the cruise cap), that its height last followed, m. */
  floor: number;
  floorWant: number;
  intent: Intent;
  /** When the intent runs out, ms. */
  until: number;
  /** PATROL: its district's centre and the waypoint it flies to. */
  district: Vec3;
  goal: Vec3;
  /** STRAFE: the street it flies down. */
  axis: "x" | "z";
  cross: number;
  dir: 1 | -1;
  /** HUNT / TAIL / DIVE: the human; ESCORT: the airship (its id). */
  human: string | null;
  ship: number;
  /** ESCORT: its loop's radius, height over the ship and turn (±1). */
  orbitR: number;
  orbitUp: number;
  orbitDir: 1 | -1;
  /** DIVE: on the way down (false: climbing to the perch). */
  diving: boolean;
  /** BREAK / FLEE: the heading it breaks to, rad, and the height change. */
  breakYaw: number;
  breakUp: number;
  /** HP when it last thought (a drop is a hit). */
  hp: number;
  /** Peeling off another pilot's line until then, ms, by this much, rad. */
  sepUntil: number;
  sepYaw: number;
  sepUp: number;
  /** This tick's commands (flyPilot sets them, stepPilot flies them). */
  wantYaw: number;
  /** An absolute height it wants, m; −1: its floor + prefAlt… */
  wantAlt: number;
  /** …and this much over it (a break, a peel), m. */
  altBias: number;
  wantSpeed: number;
  turnBoost: number;
  diveMax: number;
}

/** A new pilot `id` (stagger `idx`, personality from `seed`) at `pos`
 * heading `yaw`. It thinks on its first tick. */
export function newPilot(
  id: string,
  idx: number,
  seed: number,
  pos: Vec3,
  yaw: number,
  speed: number,
): Pilot {
  const persona = personalityOf(seed);
  return {
    id,
    idx,
    persona,
    rand: mulberry32((seed * 2654435761) >>> 0),
    pos: { x: pos.x, y: pos.y, z: pos.z },
    yaw,
    pitch: 0,
    roll: 0,
    speed,
    steer: yaw,
    steerNeed: 0,
    floor: 0,
    floorWant: 0,
    intent: INTENT_PATROL,
    until: Number.NEGATIVE_INFINITY,
    district: { x: pos.x, y: 0, z: pos.z },
    goal: { x: pos.x, y: 0, z: pos.z },
    axis: "x",
    cross: 0,
    dir: 1,
    human: null,
    ship: -1,
    orbitR: 0,
    orbitUp: 0,
    orbitDir: 1,
    diving: false,
    breakYaw: yaw,
    breakUp: 0,
    hp: MAX_HP,
    sepUntil: Number.NEGATIVE_INFINITY,
    sepYaw: 0,
    sepUp: 0,
    wantYaw: yaw,
    wantAlt: -1,
    altBias: 0,
    wantSpeed: persona.speed,
    turnBoost: 1,
    diveMax: DIVE_MAX,
  };
}

/** What the pilots did (telemetry; the long-sim test reads it). */
export interface PilotStats {
  /** Times the hard floor had to lift a pilot (should stay ~0). */
  clamps: number;
}

// --- Terrain following -------------------------------------------------------------

/**
 * The roofline-following floor ahead: the highest of (roof + PILOT_CLEAR −
 * (d − lead) × CLIMB_GRADE) over the lookahead, along the path a plane at
 * `pos` heading `yaw` flies while it turns toward `toYaw` at `rate` (at
 * `speed`) — the arc, not the straight line, so a tower beside a turn is
 * seen before the turn swings the nose onto it. `lead` m: the climb cone
 * starts that far ahead (the feed-forward: the floor where the plane will
 * be in a moment).
 */
export function floorAhead(
  grid: RooflineGrid,
  pos: Vec3,
  yaw: number,
  toYaw: number = yaw,
  speed: number = PILOT_SPEED_MAX,
  rate: number = PILOT_TURN_RATE,
  lead = 0,
): number {
  const perM = rate / Math.max(1, speed);
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
    const v = roof + PILOT_CLEAR - Math.max(0, d - lead) * CLIMB_GRADE;
    if (v > need) need = v;
  }
  aheadMean = sum / LOOK_M.length;
  return need;
}

/** The mean roofline along the last floorAhead() path, m — how much of
 * that way is tall (stepPilot's tie-break when every way is blocked: the
 * way OUT of a supertall's reach wins). */
let aheadMean = 0;

/** How far ahead obstacles are looked for, m. */
const OBSTACLE_LOOK_M = 240;
/** The obstacles within reach of the deciding pilot (reused). */
const nearObstacles: PilotObstacle[] = [];

/** Push onto nearObstacles each of `obstacles` a pilot at `pos` (height
 * `y`) could reach within the lookahead. */
function gatherObstacles(
  pos: Vec3,
  y: number,
  obstacles: readonly PilotObstacle[],
): void {
  for (let k = 0; k < obstacles.length; k++) {
    const o = obstacles[k] as PilotObstacle;
    if (Math.abs(o.pos.y - y) > o.h + PILOT_CLEAR) continue;
    const r = o.r + PILOT_CLEAR + OBSTACLE_LOOK_M;
    const dx = wrapDeltaAxis(pos.x, o.pos.x);
    const dz = wrapDeltaAxis(pos.z, o.pos.z);
    if (dx * dx + dz * dz < r * r) nearObstacles.push(o);
  }
}

/** Does flying `yaw` from `pos` pass inside one of nearObstacles[from..to)
 * within the lookahead? (The straight run as a segment: its closest point
 * to each obstacle's axis, in closed form.) Already inside one's berth,
 * only a heading that closes on it does: the way out is always open. */
function obstacleAhead(
  pos: Vec3,
  yaw: number,
  from: number,
  to: number,
): boolean {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  for (let k = from; k < to; k++) {
    const o = nearObstacles[k] as PilotObstacle;
    const r = o.r + PILOT_CLEAR;
    const dx = wrapDeltaAxis(pos.x, o.pos.x);
    const dz = wrapDeltaAxis(pos.z, o.pos.z);
    const along = dx * fx + dz * fz;
    if (dx * dx + dz * dz < r * r) {
      if (along > 0) return true;
      continue;
    }
    const t = Math.max(0, Math.min(OBSTACLE_LOOK_M, along));
    const ex = dx - fx * t;
    const ez = dz - fz * t;
    if (ex * ex + ez * ez < r * r) return true;
  }
  return false;
}

const wrapAngle = (a: number): number => {
  const twoPi = Math.PI * 2;
  const m = (((a + Math.PI) % twoPi) + twoPi) % twoPi;
  return m - Math.PI;
};

/**
 * One step of `dt` s of pilot `p` toward its commands (wantYaw, wantAlt,
 * wantSpeed, turnBoost, diveMax, altBias): when `decide`, pick the
 * candidate heading
 * (the wanted one first) whose roofline need fits under PILOT_CRUISE_CAP and
 * misses every obstacle; turn toward it at its own rate, lean like itself,
 * climb or sink toward the floor ahead and what it wants, and fly. Never
 * ends below the roofline + PILOT_CLEAR_HARD. Mutates `p`.
 */
export function stepPilot(
  p: Pilot,
  grid: RooflineGrid,
  obstacles: readonly PilotObstacle[],
  dt: number,
  decide: boolean,
  fresh: boolean,
  stats?: PilotStats,
): void {
  const rate = PILOT_TURN_RATE * p.persona.turn * p.turnBoost;
  p.speed += Math.max(
    -SPEED_EASE * dt,
    Math.min(SPEED_EASE * dt, p.wantSpeed - p.speed),
  );
  // Steering (at the decision cadence): the cheapest candidate heading that
  // clears the city, the walls and the ships.
  if (decide) {
    nearObstacles.length = 0;
    gatherObstacles(p.pos, p.pos.y, obstacles);
    const ships = nearObstacles.length;
    gatherObstacles(p.pos, p.pos.y, grid.walls);
    const walls = nearObstacles.length;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < STEER_OFFSETS.length; i++) {
      const off = STEER_OFFSETS[i] as number;
      // Every term below is ≥ 0 and the offsets grow: once the best so far
      // costs less than this offset alone, no later way can win.
      if (bestCost <= Math.abs(off)) break;
      const yaw = p.wantYaw + off;
      const need = floorAhead(grid, p.pos, p.yaw, yaw, p.speed, rate);
      let cost = Math.abs(off);
      cost += Math.abs(wrapAngle(yaw - p.yaw)) * 0.25;
      // Hysteresis: the last choice is kept unless another is clearly
      // better (no flip-flopping between two near-equal ways).
      cost += Math.abs(wrapAngle(yaw - p.steer)) * 0.3;
      // Behind the climb cone (the roofline ahead is above the pilot): the
      // steeper the climb it would take, the less it wants that way — a
      // tower turned into close is a tower it cannot clear. And a little
      // for height itself: the low way round wins a tie.
      const climb = need - p.pos.y;
      cost += Math.max(0, climb) * 0.2 + need * 0.002;
      // More climb than it can make before the roofline arrives: a way
      // it must not take while any other is open (turning round is
      // cheaper than this).
      if (climb > CLIMB_FEASIBLE_M)
        cost += 4 + (climb - CLIMB_FEASIBLE_M) * 0.3;
      cost += aheadMean * 0.005;
      if (need > PILOT_CRUISE_CAP) cost += 10 + (need - PILOT_CRUISE_CAP) / 10;
      if (ships > 0 && obstacleAhead(p.pos, yaw, 0, ships)) cost += 20;
      if (walls > ships && obstacleAhead(p.pos, yaw, ships, walls)) cost += 40;
      if (cost < bestCost) {
        bestCost = cost;
        p.steer = yaw;
        p.steerNeed = need;
      }
    }
  }
  const bestYaw = p.steer;
  const bestNeed = p.steerNeed;
  const turn = wrapAngle(bestYaw - p.yaw);
  // Boxed in (the best way still needs far more climb than the pilot has
  // height): break hard — twice its turn rate — out of the tall block.
  const boxed = bestNeed - p.pos.y > BOXED_M;
  const maxTurn = rate * (boxed ? 2 : 1) * dt;
  const dyaw = Math.max(-maxTurn, Math.min(maxTurn, turn));
  p.yaw = wrapAngle(p.yaw + dyaw);
  // The lean of a coordinated turn, its own style, sprung.
  const bankMax = BANK_MAX * p.persona.bank;
  const lean = Math.max(
    -bankMax,
    Math.min(bankMax, Math.atan((p.speed * (dyaw / dt)) / G) * p.persona.bank),
  );
  p.roll += (-lean - p.roll) * Math.min(1, BANK_RATE * p.persona.bank * dt);

  // Height: follow the floor ahead along the heading it is turning to, its
  // climb cone from where the pilot will be in LEAD_S (the feed-forward
  // that keeps a rising floor from outrunning the climb) — never under it,
  // and what it wants over it, under the cap.
  // (Every other tick, `fresh`: between, the last one stands — the hard
  // floor below is checked every tick.) And the floor toward the heading
  // it WANTS (under the cruise cap): it will turn that way as soon as the
  // steering lets it, so it climbs for what lies there before the turn,
  // not in it — at the decision cadence: it only prepares a climb.
  const lead = p.speed * LEAD_S;
  if (fresh || decide) {
    p.floor = floorAhead(grid, p.pos, p.yaw, bestYaw, p.speed, rate, lead);
  }
  if (decide) {
    p.floorWant =
      Math.abs(wrapAngle(p.wantYaw - bestYaw)) < 0.2
        ? 0
        : Math.min(
            PILOT_CRUISE_CAP,
            floorAhead(grid, p.pos, p.yaw, p.wantYaw, p.speed, rate),
          );
  }
  const floor = Math.max(bestNeed, p.floor, p.floorWant);
  // Over PILOT_ALT_MAX only for the roofline right under the near lead
  // point (the hard floor): a tall block further ahead is the steering's to
  // fly round, never a reason to climb into the deck.
  const nearLead = p.speed * NEAR_LEAD_S;
  const near =
    grid.at(
      p.pos.x - Math.sin(p.yaw) * nearLead,
      p.pos.z - Math.cos(p.yaw) * nearLead,
    ) + PILOT_CLEAR_HARD;
  const want =
    (p.wantAlt >= 0 ? p.wantAlt : floor + p.persona.prefAlt) + p.altBias;
  const target = Math.max(
    Math.min(floor, PILOT_ALT_MAX),
    near,
    Math.min(PILOT_CRUISE_CAP, Math.max(PILOT_FLOOR_ALT, want)),
  );
  const vy = Math.max(
    -p.speed * Math.sin(p.diveMax),
    Math.min(p.speed * Math.sin(CLIMB_MAX), (target - p.pos.y) * 2.5),
  );
  let pitchWant = Math.asin(vy / p.speed);
  // Level out in time: the height a climb (dive) still gains (loses) while
  // the pitch rate brings the nose back to level — no overshoot past the
  // caps, no clipping the floor out of a dive. (A climb to a lower target
  // is the rising floor's: it never eases off that.)
  const stop = (p.speed * (1 - Math.cos(p.pitch))) / PITCH_RATE;
  if (p.pitch > 0 && target >= PILOT_CRUISE_CAP && p.pos.y + stop >= target) {
    pitchWant = Math.min(pitchWant, 0);
  } else if (p.pitch < 0 && p.pos.y - stop <= target) {
    pitchWant = Math.max(pitchWant, 0);
  }
  const maxPitch = PITCH_RATE * dt;
  p.pitch += Math.max(-maxPitch, Math.min(maxPitch, pitchWant - p.pitch));

  const cp = Math.cos(p.pitch);
  p.pos.x = wrapCoord(p.pos.x - Math.sin(p.yaw) * cp * p.speed * dt);
  p.pos.z = wrapCoord(p.pos.z - Math.cos(p.yaw) * cp * p.speed * dt);
  p.pos.y += Math.sin(p.pitch) * p.speed * dt;
  const hard = grid.at(p.pos.x, p.pos.z) + PILOT_CLEAR_HARD;
  if (p.pos.y < hard) {
    p.pos.y = hard;
    if (p.pitch < 0) p.pitch = 0;
    if (stats) stats.clamps++;
  }
}

/** Lift `p` onto the hard floor without counting it (an ace handed back to
 * its pilot out of everyone's sight may be down in a canyon). */
export function settlePilot(p: Pilot, grid: RooflineGrid): void {
  const hard = grid.at(p.pos.x, p.pos.z) + PILOT_CLEAR_HARD;
  if (p.pos.y < hard) p.pos.y = hard;
  p.steer = p.yaw;
  p.steerNeed = 0;
  p.until = Number.NEGATIVE_INFINITY;
}

// --- The brain -------------------------------------------------------------------

/** A pilot thinks again when its intent runs out, at once when hit or
 * burning, and — a patrol, strafe or escort — looks round for a human every
 * this-many ticks (1 Hz), staggered by its idx. */
export const THINK_EVERY = 20;
/** A pilot re-plans its steering every this-many ticks (2.5 Hz), staggered
 * by its idx: an eighth of the air force decides on any tick. */
export const DECIDE_EVERY = 8;
/** How long an intent lasts, ms (a seeded draw in the range). */
const INTENT_MIN_MS = 8_000;
const INTENT_MAX_MS = 30_000;
/** A patrol's district radius, and the waypoint arrival radius, m. */
const DISTRICT_R = 320;
const WAYPOINT_M = 140;
/** A break off lasts this long, ms, from BREAK_MIN_MS (the bold) up. */
const BREAK_MIN_MS = 1800;
const BREAK_SPREAD_MS = 2600;
/** A dive starts from its perch within this of the human (plan), m, and
 * ends this close or once past it. */
const DIVE_START_M = 520;
const DIVE_END_M = 70;
/** A tail chase sits this far behind its human (less with skill), m. */
const TAIL_BACK_M = 170;
/** Lead pursuit looks this far ahead at most, s. */
const LEAD_MAX_S = 2.5;
/** Separation: a pilot this close (m, plan) to another flying its heading
 * (cos of the angle) peels off for SEP_MS. */
export const SEP_M = 70;
export const SEP_COS = Math.cos((22 * Math.PI) / 180);
const SEP_MS = 3000;
/** Separation cells, m (≥ SEP_M: a neighbour is in this cell or the next). */
const SEP_CELL = 100;
const SEP_N = WORLD_SIZE / SEP_CELL;

/** The nearest human to `p` (null with none) and its distance. */
let nearestDist = Number.POSITIVE_INFINITY;
function nearestHuman(
  p: Vec3,
  humans: readonly PilotHuman[],
): PilotHuman | null {
  let best: PilotHuman | null = null;
  let bd = Number.POSITIVE_INFINITY;
  for (let i = 0; i < humans.length; i++) {
    const h = humans[i] as PilotHuman;
    const dx = wrapDeltaAxis(p.x, h.pos.x);
    const dy = h.pos.y - p.y;
    const dz = wrapDeltaAxis(p.z, h.pos.z);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bd) {
      bd = d2;
      best = h;
    }
  }
  nearestDist = Math.sqrt(bd);
  return best;
}

function humanById(
  id: string | null,
  humans: readonly PilotHuman[],
): PilotHuman | null {
  if (id === null) return null;
  for (let i = 0; i < humans.length; i++) {
    if ((humans[i] as PilotHuman).id === id) return humans[i] as PilotHuman;
  }
  return null;
}

function shipById(id: number, ships: readonly PilotShip[]): PilotShip | null {
  for (let i = 0; i < ships.length; i++) {
    if ((ships[i] as PilotShip).id === id) return ships[i] as PilotShip;
  }
  return null;
}

/** The heading from `from` to (x, z), rad. Torus-safe. */
function yawTo(from: Vec3, x: number, z: number): number {
  return Math.atan2(-wrapDeltaAxis(from.x, x), -wrapDeltaAxis(from.z, z));
}

/** A waypoint for `p` round (cx, cz) within `r`, one it can cruise over
 * (never a supertall's roof, which it would only circle), into p.goal. */
function pickPoint(
  p: Pilot,
  grid: RooflineGrid,
  cx: number,
  cz: number,
  r: number,
): void {
  for (let tries = 0; tries < 8; tries++) {
    const ang = p.rand() * Math.PI * 2;
    const d = Math.sqrt(p.rand()) * r;
    const x = wrapCoord(cx + Math.cos(ang) * d);
    const z = wrapCoord(cz + Math.sin(ang) * d);
    if (grid.ahead(x, z) + PILOT_CLEAR > PILOT_CRUISE_CAP) continue;
    p.goal.x = x;
    p.goal.z = z;
    return;
  }
  p.goal.x = wrapCoord(cx);
  p.goal.z = wrapCoord(cz);
}

/**
 * Pilot `p` thinks: a fresh intent from chooseIntent and what it needs — a
 * district and a waypoint, a street, an airship and a loop round it, a
 * human, a heading to break to. `hp` is its HP now. Pure in (p, world).
 */
export function thinkPilot(p: Pilot, w: PilotWorld, hp: number): void {
  const hit = hp < p.hp;
  p.hp = hp;
  // Hit again mid-break: it keeps breaking the way it chose.
  if (
    hit &&
    p.intent === INTENT_BREAK &&
    w.now < p.until &&
    hp >= PILOT_BURNING_HP
  ) {
    p.until += 600;
    return;
  }
  const human = nearestHuman(p.pos, w.humans);
  const dist = nearestDist;
  const intent = chooseIntent(
    p.persona,
    { hp, hit, humanDist: dist, ship: w.ships.length > 0 },
    p.rand(),
  );
  const ps = p.persona;
  p.intent = intent;
  p.until = w.now + INTENT_MIN_MS + p.rand() * (INTENT_MAX_MS - INTENT_MIN_MS);
  p.human = null;
  p.diving = false;
  switch (intent) {
    case INTENT_PATROL: {
      // A district near where it is, or — the restless — anywhere.
      if (p.rand() < 0.35) {
        p.district.x = p.rand() * WORLD_SIZE;
        p.district.z = p.rand() * WORLD_SIZE;
      } else {
        const ang = p.rand() * Math.PI * 2;
        p.district.x = wrapCoord(p.pos.x + Math.cos(ang) * 400);
        p.district.z = wrapCoord(p.pos.z + Math.sin(ang) * 400);
      }
      pickPoint(p, w.grid, p.district.x, p.district.z, DISTRICT_R);
      break;
    }
    case INTENT_STRAFE: {
      // The street under the point a little ahead of the nose, its way.
      const ahead = 60 + p.rand() * 200;
      scratchLead.x = wrapCoord(p.pos.x - Math.sin(p.yaw) * ahead);
      scratchLead.y = 0;
      scratchLead.z = wrapCoord(p.pos.z - Math.cos(p.yaw) * ahead);
      const st = nearestStreet(scratchLead);
      p.axis = st.axis;
      p.cross = st.centerline;
      const along = st.axis === "x" ? -Math.sin(p.yaw) : -Math.cos(p.yaw);
      p.dir = along >= 0 ? 1 : -1;
      break;
    }
    case INTENT_ESCORT: {
      // A loose loop round the nearest airship (or another, now and then).
      let best: PilotShip | null = null;
      let bd = Number.POSITIVE_INFINITY;
      for (const s of w.ships) {
        const d = wrapDistance(s.pos, p.pos) * (0.6 + p.rand() * 0.8);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      if (!best) {
        p.intent = INTENT_PATROL;
        pickPoint(p, w.grid, p.pos.x, p.pos.z, DISTRICT_R);
        break;
      }
      p.ship = best.id;
      p.orbitR = best.r + PILOT_CLEAR + 60 + p.rand() * 260;
      p.orbitUp = -40 + p.rand() * 120;
      p.orbitDir = p.rand() < 0.5 ? 1 : -1;
      break;
    }
    case INTENT_HUNT:
    case INTENT_TAIL:
    case INTENT_DIVE: {
      // Usually the nearest human; the bold pick any.
      const pick =
        w.humans.length > 1 && p.rand() < 0.3
          ? (w.humans[Math.floor(p.rand() * w.humans.length)] as PilotHuman)
          : human;
      p.human = pick?.id ?? null;
      // A dive lasts the climb and the pass, at most.
      if (intent === INTENT_DIVE) p.until = w.now + 25_000;
      break;
    }
    case INTENT_BREAK: {
      // Away from the nearest threat, to its own side, up or down.
      const from = human ? yawTo(p.pos, human.pos.x, human.pos.z) : p.yaw;
      p.breakYaw = wrapAngle(
        from + ps.side * (Math.PI * 0.55 + p.rand() * Math.PI * 0.4),
      );
      p.breakUp = (p.rand() < 0.5 + ps.risk * 0.3 ? -1 : 1) * 50;
      p.until = w.now + BREAK_MIN_MS + (1 - ps.risk) * BREAK_SPREAD_MS;
      break;
    }
    case INTENT_FLEE: {
      // Away from the nearest human, low and fast, until it is mended.
      const from = human ? yawTo(p.pos, human.pos.x, human.pos.z) : p.yaw;
      p.breakYaw = wrapAngle(from + Math.PI + (p.rand() - 0.5) * 0.8);
      p.until = w.now + 6000 + p.rand() * 6000;
      break;
    }
  }
}

/**
 * Pilot `p`'s commands this tick from its intent (heading, height, speed,
 * turn and dive limits), its weave and any separation peel. Pure in
 * (p, world); returns false when the intent is spent (think again).
 */
export function aimPilot(p: Pilot, w: PilotWorld): boolean {
  const ps = p.persona;
  const t = w.now / 1000;
  p.wantAlt = -1;
  p.altBias = 0;
  p.wantSpeed = ps.speed;
  p.turnBoost = 1;
  p.diveMax = DIVE_MAX;
  let weave = ps.weaveAmp;
  let alive = w.now < p.until;
  switch (p.intent) {
    case INTENT_PATROL: {
      const dx = wrapDeltaAxis(p.pos.x, p.goal.x);
      const dz = wrapDeltaAxis(p.pos.z, p.goal.z);
      if (dx * dx + dz * dz < WAYPOINT_M * WAYPOINT_M) {
        pickPoint(p, w.grid, p.district.x, p.district.z, DISTRICT_R);
      }
      p.wantYaw = yawTo(p.pos, p.goal.x, p.goal.z);
      break;
    }
    case INTENT_STRAFE: {
      // Down the street, easing onto its line, low over the roofs.
      const off =
        p.axis === "x"
          ? wrapDeltaAxis(p.pos.z, p.cross)
          : wrapDeltaAxis(p.pos.x, p.cross);
      const lean = Math.max(-0.6, Math.min(0.6, off / 120));
      if (p.axis === "x") {
        // +x is yaw −π/2, −x is +π/2; the line's z offset leans the nose.
        const base = p.dir === 1 ? -Math.PI / 2 : Math.PI / 2;
        p.wantYaw = base + (p.dir === 1 ? -lean : lean);
      } else {
        const base = p.dir === 1 ? Math.PI : 0;
        p.wantYaw = base + (p.dir === 1 ? lean : -lean);
      }
      p.wantAlt = 0; // the floor itself: as low as it may
      p.wantSpeed = ps.speed + 6;
      weave *= 0.3;
      break;
    }
    case INTENT_ESCORT: {
      const s = shipById(p.ship, w.ships);
      if (!s) return false; // its airship went down
      const dx = wrapDeltaAxis(p.pos.x, s.pos.x);
      const dz = wrapDeltaAxis(p.pos.z, s.pos.z);
      const d = Math.hypot(dx, dz) || 1;
      const radial = Math.atan2(-dx, -dz);
      const err = Math.max(-1, Math.min(1, (d - p.orbitR) / p.orbitR));
      p.wantYaw = radial - p.orbitDir * (Math.PI / 2) * (1 - err);
      p.wantAlt = s.pos.y + p.orbitUp;
      break;
    }
    case INTENT_HUNT:
    case INTENT_TAIL:
    case INTENT_DIVE: {
      const h = humanById(p.human, w.humans);
      if (!h) return false; // its human landed, left or died
      const dx = wrapDeltaAxis(p.pos.x, h.pos.x);
      const dz = wrapDeltaAxis(p.pos.z, h.pos.z);
      const plan = Math.hypot(dx, dz);
      // Lead pursuit: the skilled aim where the human will be.
      const lead =
        Math.min(LEAD_MAX_S, plan / Math.max(30, p.speed)) * ps.skill;
      let ax = h.pos.x + h.vel.x * lead;
      let az = h.pos.z + h.vel.z * lead;
      if (p.intent === INTENT_TAIL) {
        // Onto its six: a point behind it, then the human itself.
        const v = Math.hypot(h.vel.x, h.vel.z);
        if (v > 5) {
          const back = TAIL_BACK_M * (1 - ps.skill * 0.6);
          const bx = h.pos.x - (h.vel.x / v) * back;
          const bz = h.pos.z - (h.vel.z / v) * back;
          const ex = wrapDeltaAxis(p.pos.x, bx);
          const ez = wrapDeltaAxis(p.pos.z, bz);
          if (ex * ex + ez * ez > 90 * 90) {
            ax = bx;
            az = bz;
          }
        }
        p.wantSpeed = ps.speed + 8;
      }
      p.wantYaw = yawTo(p.pos, ax, az);
      p.wantAlt = h.pos.y + (ps.prefAlt - PILOT_PREF_MAX / 2) * 0.5;
      weave *= 0.4;
      if (p.intent === INTENT_DIVE) {
        if (!p.diving) {
          // Climb to the perch, then roll in.
          p.wantAlt = PILOT_CRUISE_CAP;
          if (plan < DIVE_START_M && p.pos.y > h.pos.y + 80) p.diving = true;
        } else {
          p.wantAlt = h.pos.y;
          p.diveMax = ATTACK_DIVE_MAX;
          p.wantSpeed = PILOT_SPEED_TOP;
          weave = 0;
          // Past it, or through its height: the pass is over.
          const fx = -Math.sin(p.yaw);
          const fz = -Math.cos(p.yaw);
          if (plan < DIVE_END_M || dx * fx + dz * fz < 0) alive = false;
        }
      } else {
        p.wantSpeed = Math.max(p.wantSpeed, ps.speed + ps.aggression * 8);
      }
      break;
    }
    case INTENT_BREAK: {
      p.wantYaw = p.breakYaw;
      p.altBias = p.breakUp;
      p.turnBoost = 1.5;
      p.wantSpeed = ps.speed + 10;
      weave = 0;
      break;
    }
    case INTENT_FLEE: {
      p.wantYaw = p.breakYaw;
      p.wantAlt = 0; // hug the roofs
      p.wantSpeed = PILOT_SPEED_TOP;
      weave *= 0.5;
      // Mended (regen) before it gives up: back to the fight.
      if (p.hp >= PILOT_BURNING_HP) alive = false;
      break;
    }
  }
  // Its own weave (no two planes share one: no parallel tracks) and, while
  // peeling off another's line, the peel.
  p.wantYaw += weave * Math.sin(t * ps.weaveHz * Math.PI * 2 + ps.weavePhase);
  if (w.now < p.sepUntil) {
    p.wantYaw += p.sepYaw;
    p.altBias += p.sepUp;
  }
  return alive;
}

/** Per tick, reused: the pilots by separation cell (a linked list). */
const sepHead = new Int32Array(SEP_N * SEP_N);
let sepNext = new Int32Array(1024);

const sepCell = (x: number, z: number): number => {
  const ix = Math.floor(x / SEP_CELL) % SEP_N;
  const iz = Math.floor(z / SEP_CELL) % SEP_N;
  return (iz < 0 ? iz + SEP_N : iz) * SEP_N + (ix < 0 ? ix + SEP_N : ix);
};

/**
 * One tick (`tick`, `dt` s) of every pilot in `pilots` (the ones flying):
 * the staggered fraction that thinks (or was hit, or is burning — `hpOf`)
 * picks an intent; every pilot aims and flies; the staggered fraction that
 * re-plans its steering also checks it is not flying another pilot's line,
 * and peels off when it is. Pure in (pilots, world, tick).
 */
export function flyPilots(
  pilots: readonly Pilot[],
  w: PilotWorld,
  dt: number,
  tick: number,
  hpOf: (p: Pilot) => number,
  obstacles: readonly PilotObstacle[],
  stats?: PilotStats,
): void {
  const n = pilots.length;
  // The separation buckets, for the pilots that decide this tick.
  sepHead.fill(-1);
  if (sepNext.length < n) sepNext = new Int32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = pilots[i] as Pilot;
    const c = sepCell(p.pos.x, p.pos.z);
    sepNext[i] = sepHead[c] as number;
    sepHead[c] = i;
  }
  for (let i = 0; i < n; i++) {
    const p = pilots[i] as Pilot;
    const hp = hpOf(p);
    // In trouble — its floor ahead above it, climbing to clear it — a
    // pilot re-plans and re-reads its floor every other tick, not on its
    // turn: the way round may have opened, the wall come closer.
    const trouble = p.floor > p.pos.y;
    const decide =
      (tick + p.idx) % DECIDE_EVERY === 0 ||
      (trouble && (tick + p.idx) % 2 === 0);
    const burning = hp > 0 && hp < PILOT_BURNING_HP;
    if (hp < p.hp || (burning && p.intent !== INTENT_FLEE)) {
      thinkPilot(p, w, hp); // hit, or on fire
    } else if (
      (tick + p.idx) % THINK_EVERY === 0 &&
      p.intent <= INTENT_ESCORT &&
      w.humans.length > 0
    ) {
      // A patrol, a strafe or an escort that notices a human close by may
      // go for it — the aggressive more often.
      nearestHuman(p.pos, w.humans);
      if (
        nearestDist < PILOT_HUNT_M * 0.6 &&
        p.rand() < p.persona.aggression * 0.35
      ) {
        thinkPilot(p, w, hp);
      }
    }
    p.hp = hp;
    if (decide) separate(p, i, pilots, w.now);
    if (!aimPilot(p, w)) {
      p.until = w.now;
      thinkPilot(p, w, hp);
      aimPilot(p, w);
    }
    stepPilot(
      p,
      w.grid,
      obstacles,
      dt,
      decide,
      trouble || (tick + p.idx) % 2 === 0,
      stats,
    );
  }
}

/** Is pilot `p` (index `i`) flying another's line — within SEP_M in plan,
 * 30 m in height, its heading within acos(SEP_COS)? Then it peels off, to
 * the side away from the other and up or down, for SEP_MS. */
function separate(
  p: Pilot,
  i: number,
  pilots: readonly Pilot[],
  now: number,
): void {
  if (now < p.sepUntil) return;
  const ix = Math.floor(wrapCoord(p.pos.x) / SEP_CELL);
  const iz = Math.floor(wrapCoord(p.pos.z) / SEP_CELL);
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cz = (iz + oz + SEP_N) % SEP_N;
      const cx = (ix + ox + SEP_N) % SEP_N;
      const c = cz * SEP_N + cx;
      for (let j = sepHead[c] as number; j >= 0; j = sepNext[j] as number) {
        if (j === i) continue;
        const q = pilots[j] as Pilot;
        const dx = wrapDeltaAxis(p.pos.x, q.pos.x);
        const dz = wrapDeltaAxis(p.pos.z, q.pos.z);
        if (dx * dx + dz * dz > SEP_M * SEP_M) continue;
        if (Math.abs(q.pos.y - p.pos.y) > 30) continue;
        const gx = -Math.sin(q.yaw);
        const gz = -Math.cos(q.yaw);
        if (fx * gx + fz * gz < SEP_COS) continue;
        // The other is to the right (cross < 0 in this frame) → peel left.
        const right = dx * -fz + dz * fx < 0 ? 1 : -1;
        p.sepYaw = right * (0.45 + p.rand() * 0.5);
        p.sepUp = (q.pos.y > p.pos.y ? -1 : 1) * (15 + p.rand() * 25);
        p.sepUntil = now + SEP_MS * (0.7 + p.rand() * 0.6);
        return;
      }
    }
  }
}

/** A place to stage a pilot in the air (no rig: the benches, the QA): a
 * point and heading whose roofline ahead it can cruise over, into `out`. */
export function stagedSpawn(
  grid: RooflineGrid,
  rand: () => number,
  out: { pos: Vec3; yaw: number },
): void {
  for (let tries = 0; tries < 16; tries++) {
    out.pos.x = rand() * WORLD_SIZE;
    out.pos.z = rand() * WORLD_SIZE;
    out.yaw = rand() * Math.PI * 2;
    out.pos.y = floorAhead(grid, out.pos, out.yaw);
    if (out.pos.y <= PILOT_CRUISE_CAP) break;
  }
  out.pos.y = Math.max(PILOT_FLOOR_ALT, Math.min(out.pos.y, PILOT_CRUISE_CAP));
}

// --- Poses ---------------------------------------------------------------------

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

// --- Promotion ---------------------------------------------------------------

/** A pilot this close to a human (m) is wanted as an ace. */
export const PROMOTE_M = 600;
/** An ace demotes only once it is at least this far from every human: past
 * the camera's far plane (900 m), so the hand-back is never seen. */
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
  ace: boolean;
  /** Must stay an ace whatever the distances (a bomb run). */
  locked: boolean;
}

/**
 * Who changes tier this tick. An ace demotes only at DEMOTE_M or more from
 * every human (and not locked); a pilot promotes within PROMOTE_M, nearest
 * first, while the aces stay under `cap`. The gap between the two distances
 * is the hysteresis: a plane cannot flicker between tiers. Over the cap
 * (humans left), demotable aces go first — a visible ace is never forced
 * back. Pure.
 */
export function chooseAces(
  cands: readonly AceCandidate[],
  cap: number,
): { promote: string[]; demote: string[] } {
  const demote: string[] = [];
  let aces = 0;
  for (const c of cands) {
    if (!c.ace) continue;
    if (!c.locked && c.dist >= DEMOTE_M) demote.push(c.id);
    else aces++;
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

/** A pilot fires only at a human this close, m… */
export const PILOT_FIRE_RANGE = 260;
/** …and inside this half-angle of its nose, rad. */
export const PILOT_FIRE_CONE = (5 * Math.PI) / 180;
const FIRE_COS = Math.cos(PILOT_FIRE_CONE);

/** Is `target` in the forward cone of a plane at `pos` flying `fwd` (unit),
 * within PILOT_FIRE_RANGE? Torus-safe. */
export function pilotInCone(pos: Vec3, fwd: Vec3, target: Vec3): boolean {
  const dx = wrapDeltaAxis(pos.x, target.x);
  const dy = target.y - pos.y;
  const dz = wrapDeltaAxis(pos.z, target.z);
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > PILOT_FIRE_RANGE * PILOT_FIRE_RANGE || d2 < 1) return false;
  return (dx * fwd.x + dy * fwd.y + dz * fwd.z) / Math.sqrt(d2) >= FIRE_COS;
}
