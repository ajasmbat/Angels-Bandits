// G1 street-level detail — the pure layout seam under street-furniture.ts and
// the ground paint in street-paint.ts. THREE-free, like streetlife.ts: every
// answer is a pure function of (seed, block / street side, the shared city),
// so the whole layer is testable in Node and identical on every client.
//
// Two layers, and the split is load-bearing:
//
//  1. THE CURB PLAN is SEED-FREE. `curbPlanFor(side)` decides, per street side
//     of one block, whether it has a parking lane, a bus stop (and where its
//     shelter stands), a fire hydrant, and whether its street line carries a
//     bike lane. The ground shader cannot read a seeded layout (it compiles
//     before the welcome), so this plan is baked into it as a packed const
//     table GENERATED FROM THIS FUNCTION (`curbPlanTableGlsl`) — the same
//     trick as N1's block-kind table. A BUS STOP box, a red curb and a
//     parking line are therefore always where the shelter, the hydrant and
//     the parked cars are.
//  2. THE OBJECTS are seeded (`streetFurnitureFor`, `parkingFor`): which bench,
//     which car, which colour — on their own salted per-block streams, never
//     the streetlife tags 1–4. They read the curb plan and drop any item the
//     live city vetoes (a hole mouth, a train pillar, a gutter vent): paint
//     may outlive an object, never the reverse.
//
// Everything here is street-level, ≤ ITEM_MAX_HEIGHT and NON-collidable (the
// plan's accepted street-level exception): nothing is added to detectCrash,
// the bot probes or losClear.
//
// Ownership: a block dresses its OWN four sidewalk sides — the strip just
// inside its edges (the streetlife ring idea). Each street side belongs to
// exactly one block, so the CITY_GRID² blocks tile every curb exactly once
// across the torus wrap, and the parked cars along a curb belong to the block
// whose sidewalk that curb is.
//
// The cross-section, meters off the street centreline (S1 contract):
//   0 centre line · 5 lane centre (the widest L6 vehicle, the bus, reaches
//   6.25) · 7.9–9.7 bike lane · ~10.9 a double-parked van · 12.4 parking line
//   · 13.75 parked cars · 15 curb · 15–16.67 furniture strip (lamps, tree
//   pits, everything below) · 16.9–19.2 pedestrians · 20 lot line.

import {
  CITY_GRID,
  CONSTRUCTION_BLOCKS,
  type HoleSpan,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  GROUND_FORECOURT,
  GROUND_PARK,
  GROUND_RIVER,
  blockGroundKind,
} from "@angels-bandits/common/city/nature";
import { overChannel } from "@angels-bandits/common/city/river";
import {
  CROSSWALK_DEPTH,
  CURB_LINE,
  INTERSECTION_HALF,
  LAMP_STATIONS_MINUS,
  LAMP_STATIONS_PLUS,
  LANE_CENTERS,
  LOT_LINE,
} from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  HOLE_CORRIDOR_MARGIN,
  HOLE_RUN_OUT,
  STREET_TREE_CANOPY_MAX,
} from "@angels-bandits/common/constants";
import { wrapCoord, wrapDeltaAxis } from "@angels-bandits/common/world";
import { PED_BAND_MIN, PED_HALF_WIDTH } from "./streetlife";

// --- The cross-section ------------------------------------------------------

/** Lane centre, meters off the centreline (the S1 contract's +5). */
const LANE = LANE_CENTERS[1];
/** Everything G1 puts on the street stays at or under this, meters. */
export const ITEM_MAX_HEIGHT = 3;
/** Half-width the WIDEST L6 vehicle (the bus, 2.5 m) sweeps around its lane
 * centre. Mirrors traffic.ts VEHICLES.bus — the test pins the two together
 * (this module stays THREE-free, so it cannot import traffic.ts). */
export const MOVING_HALF_WIDTH = 1.25;
/** The outer edge of the moving traffic, meters off the centreline. */
export const MOVING_EDGE = LANE + MOVING_HALF_WIDTH;
/** Bike lane band (inner, outer), meters off the centreline. */
export const BIKE_LANE_IN = 7.9;
export const BIKE_LANE_OUT = 9.7;
/** Gap a parked car keeps to the curb face, meters. */
const PARK_CURB_GAP = 0.3;
/** The painted parking line (the parking lane's inner edge). */
export const PARKING_LINE = 12.4;
/** Double-parked vans keep these margins (meters) to the bike lane's outer
 * edge and to the moving lane's swept edge. Named so the test asserts them. */
export const DOUBLE_PARK_BIKE_MARGIN = 0.15;
export const DOUBLE_PARK_LANE_MARGIN = 3;
/** Inner edge of the furniture strip and its outer limit: the curb, and the
 * last metre a pedestrian (half-width PED_HALF_WIDTH) never enters. */
export const STRIP_IN = CURB_LINE;
export const STRIP_OUT = PED_BAND_MIN - PED_HALF_WIDTH;
/** Anything below this height must sit inside the strip; above it (a cart's
 * canopy, a shelter roof) pedestrians walk underneath. */
export const PED_HEAD = 2.0;

// --- Along a street side ----------------------------------------------------

/** Furniture and parking stay this far from a crossing street's centreline
 * along the side: the roadway, the crosswalk, and 3 m of daylighting. */
export const CORNER_CLEAR = INTERSECTION_HALF + CROSSWALK_DEPTH + 3;
/** Clearance kept around a lamp post / a tree pit's centre, meters. */
const LAMP_CLEAR = 0.7;
const PIT_CLEAR = 1.1;
/** Clearance around a gutter steam vent (steam.ts), meters along. */
const VENT_CLEAR = 1.4;
/** Clearance around an A1 cart (cart + vendor) and an A1 crowd (bus-stop
 * waiters, a performer's audience), meters along. */
const CART_CLEAR = 2.0;
const CROWD_CLEAR = 3.4;
/** Minimum gap between two furniture items, meters. */
const ITEM_GAP = 0.6;

/** Lamp stations on a side (+1 = PLUS row, −1 = MINUS row). */
export const lampStations = (side: 1 | -1): readonly number[] =>
  side === 1 ? LAMP_STATIONS_PLUS : LAMP_STATIONS_MINUS;

/**
 * Candidate street-tree pits along a side: midway between consecutive lamps,
 * clear of the corners — the same rule nature.ts streetTrees() applies (the
 * test checks every drawn street tree stands on one of these). The ground
 * shader paints a grate at every candidate, tree or no tree.
 */
export function treePits(side: 1 | -1): number[] {
  const s = [...lampStations(side)].sort((a, b) => a - b);
  const clear = INTERSECTION_HALF + CROSSWALK_DEPTH + STREET_TREE_CANOPY_MAX;
  const out: number[] = [];
  for (let i = 1; i < s.length; i++) {
    const m = ((s[i - 1] as number) + (s[i] as number)) / 2;
    if (m >= clear && m <= BLOCK_PITCH - clear) out.push(m);
  }
  return out;
}

// --- Street sides -----------------------------------------------------------

/**
 * One side of one street segment. `axis` is the TRAVEL axis (the S1
 * convention: a north–south street on a line of constant x has axis "z"),
 * `line` the street line (its centreline sits at line·BLOCK_PITCH on the
 * cross axis), `seg` the segment along it (spanning seg·PITCH..(seg+1)·PITCH)
 * and `side` which side of the centreline the curb is on.
 */
export interface StreetSide {
  axis: "x" | "z";
  line: number;
  seg: number;
  side: 1 | -1;
}

const wrapGrid = (v: number) => ((v % CITY_GRID) + CITY_GRID) % CITY_GRID;

/** The four sidewalk sides block (bx, bz) owns, in a fixed order: west,
 * east, south, north. */
export function blockSides(bx: number, bz: number): StreetSide[] {
  return [
    { axis: "z", line: wrapGrid(bx), seg: wrapGrid(bz), side: 1 },
    { axis: "z", line: wrapGrid(bx + 1), seg: wrapGrid(bz), side: -1 },
    { axis: "x", line: wrapGrid(bz), seg: wrapGrid(bx), side: 1 },
    { axis: "x", line: wrapGrid(bz + 1), seg: wrapGrid(bx), side: -1 },
  ];
}

/** The block whose sidewalk a street side is. */
export function sideOwner(s: StreetSide): { bx: number; bz: number } {
  const across = s.side === 1 ? s.line : wrapGrid(s.line - 1);
  return s.axis === "z" ? { bx: across, bz: s.seg } : { bx: s.seg, bz: across };
}

/** Canonical world (x, z) of a point `along` m into the side's segment and
 * `off` m off its centreline on the curb's side. */
export function sidePoint(
  s: StreetSide,
  along: number,
  off: number,
): { x: number; z: number } {
  const a = wrapCoord(s.seg * BLOCK_PITCH + along);
  const c = wrapCoord(s.line * BLOCK_PITCH + s.side * off);
  return s.axis === "z" ? { x: c, z: a } : { x: a, z: c };
}

/** Index of a side in the packed curb-plan table. */
export const sideIndex = (s: StreetSide): number =>
  (((s.axis === "z" ? 0 : 1) * CITY_GRID + s.line) * CITY_GRID + s.seg) * 2 +
  (s.side === 1 ? 0 : 1);

// --- 1. The seed-free curb plan ----------------------------------------------

/** Shelter centres a bus stop may use, per side row: two of A1's street
 * station slots (citylife.ts STATIONS_PLUS / STATIONS_MINUS), so the stop
 * citylife fills with waiters is always one of these shelters — and each
 * clears both lamps and tree pits (asserted by the test). */
const BUS_STATIONS: Readonly<Record<1 | -1, readonly [number, number]>> = {
  1: [44, 119],
  [-1]: [107, 145],
};
/** Bus stop zone (no parking, BUS STOP paint) around the shelter, meters
 * before (upstream) and after it. A bus is 11 m. */
export const BUS_ZONE_BEFORE = 11;
export const BUS_ZONE_AFTER = 6;
/** Hydrant station per side row — between the first lamp and the first tree
 * pit, near the corner like real hydrants. */
const HYDRANT_STATION: Readonly<Record<1 | -1, number>> = { 1: 30.5, [-1]: 29 };
/** No parking within this many meters of a hydrant (the red curb). */
export const HYDRANT_CLEAR = 3.5;
/** Share of sides with a parking lane / a bus stop, and of LINES with a bike
 * lane. */
const PARKING_SHARE = 0.68;
const BUS_SHARE = 0.2;
const BIKE_SHARE = 0.35;

export interface CurbPlan {
  /** A parking lane runs along this curb (outside the zones below). */
  parking: boolean;
  /** Bus shelter centre along the side, or null for no stop. */
  bus: number | null;
  /** Hydrant station along the side, or null (none on a bridge). */
  hydrant: number | null;
}

/** A salted integer hash in [0, 1), seed-free. */
const planHash = (key: number, salt: number): number =>
  mulberry32((Math.imul(key + 1, 0x2c1b3c6d) ^ salt) >>> 0)();

/** True when a side's segment crosses the river channel (a bridge). */
const onBridge = (s: StreetSide): boolean => {
  if (s.axis !== "z") return false;
  for (let a = 0; a <= BLOCK_PITCH; a += 10) {
    if (overChannel(s.seg * BLOCK_PITCH + a)) return true;
  }
  return false;
};

const isSite = (bx: number, bz: number): boolean =>
  CONSTRUCTION_BLOCKS.some(([x, z]) => x === bx && z === bz);

/** The seed-free curb plan for one street side (see the header). */
export function curbPlanFor(s: StreetSide): CurbPlan {
  const key = sideIndex(s);
  if (onBridge(s)) return { parking: false, bus: null, hydrant: null };
  const { bx, bz } = sideOwner(s);
  const site = isSite(bx, bz);
  const busRoll = planHash(key, 0x6b75_5c1e);
  const bus =
    !site && busRoll < BUS_SHARE
      ? BUS_STATIONS[s.side][busRoll < BUS_SHARE / 2 ? 0 : 1]
      : null;
  return {
    parking: planHash(key, 0x0a4c_17e5) < PARKING_SHARE,
    bus: bus ?? null,
    hydrant: HYDRANT_STATION[s.side],
  };
}

/** The street side a sidewalk run belongs to, from its start corner and
 * its inward normal (toward the block) — for callers that walk a block's
 * sides their own way (citylife.ts). Wraps the line and segment. */
export function sideAt(
  axis: "x" | "z",
  x0: number,
  z0: number,
  inward: 1 | -1,
): StreetSide {
  const line = Math.round((axis === "z" ? x0 : z0) / BLOCK_PITCH);
  const seg = Math.floor((axis === "z" ? z0 : x0) / BLOCK_PITCH);
  return { axis, line: wrapGrid(line), seg: wrapGrid(seg), side: inward };
}

/** True when street `line` on travel axis `axis` carries bike lanes (both
 * sides, the whole loop). Seed-free. */
export const bikeLaneOn = (axis: "x" | "z", line: number): boolean =>
  planHash((axis === "z" ? 0 : CITY_GRID) + wrapGrid(line), 0x7b1c_e1a5) <
  BIKE_SHARE;

// Packed for the ground shader: 4 bits per side (parking, bus, bus slot,
// hydrant), SIDES_PER_WORD sides per 32-bit int — highp ints are exact in
// GLSL ES 3.0, and 7 × 4 = 28 bits stays clear of the sign bit.
export const SIDES_PER_WORD = 7;
export const SIDE_COUNT = 2 * CITY_GRID * CITY_GRID * 2;

/** The 4-bit code of one side (bit 0 parking, 1 bus, 2 bus slot, 3 hydrant). */
export function curbCode(s: StreetSide): number {
  const p = curbPlanFor(s);
  const slot = p.bus !== null && p.bus === BUS_STATIONS[s.side][1] ? 1 : 0;
  return (
    (p.parking ? 1 : 0) |
    (p.bus !== null ? 2 : 0) |
    (slot << 2) |
    (p.hydrant !== null ? 8 : 0)
  );
}

/** Every side in sideIndex order. */
export function allSides(): StreetSide[] {
  const out: StreetSide[] = [];
  for (const axis of ["z", "x"] as const) {
    for (let line = 0; line < CITY_GRID; line++) {
      for (let seg = 0; seg < CITY_GRID; seg++) {
        for (const side of [1, -1] as const)
          out.push({ axis, line, seg, side });
      }
    }
  }
  return out;
}

/** The packed curb table, word by word (what the shader bakes). */
export function curbPlanWords(): number[] {
  const words = new Array<number>(Math.ceil(SIDE_COUNT / SIDES_PER_WORD)).fill(
    0,
  );
  for (const s of allSides()) {
    const i = sideIndex(s);
    const w = Math.floor(i / SIDES_PER_WORD);
    words[w] =
      (words[w] as number) | (curbCode(s) << ((i % SIDES_PER_WORD) * 4));
  }
  return words;
}

/** Bike-lane bits, one per (axis, line): bit (axisIdx·GRID + line). */
export function bikeLaneWord(): number {
  let w = 0;
  for (const axis of ["z", "x"] as const) {
    for (let line = 0; line < CITY_GRID; line++) {
      if (bikeLaneOn(axis, line)) {
        w |= 1 << ((axis === "z" ? 0 : CITY_GRID) + line);
      }
    }
  }
  return w;
}

/** The plan's layout constants the shader needs, by row (+1 / −1). */
export const CURB_SHADER = {
  busStations: BUS_STATIONS,
  hydrant: HYDRANT_STATION,
} as const;

// --- 2. Seeded objects ------------------------------------------------------

/** Salted PRNG tags — far from streetlife's 1–4 and from each other. */
export const TAG_FURNITURE = 0x47_31_46; // "G1F"
export const TAG_PARKING = 0x47_31_50; // "G1P"

/** The per-block stream for one G1 subsystem (streetlife's mixing). */
function g1Stream(seed: number, bx: number, bz: number, tag: number) {
  return mulberry32(
    (seed ^
      Math.imul(bx + 1, 73856093) ^
      Math.imul(bz + 1, 19349663) ^
      Math.imul(tag, 0x9e3779b9)) >>>
      0,
  );
}

/** Golden-ratio rank of the i-th object — the low-discrepancy thinning key
 * (streetlife microKeep): drop rank ≥ k and the survivors stay evenly spread. */
const rankOf = (i: number): number => (i * 0.618_033_988_749_894_9) % 1;

/** Food carts are A1's (citylife.ts, with vendor and queue); G1 only gives
 * them steam (cartVents) and keeps its furniture clear of them. */
export type FurnitureKind =
  | "bench"
  | "bin"
  | "hydrant"
  | "newsbox"
  | "shelter"
  | "bikerack"
  | "bollards"
  | "planter"
  | "booth";

/** Footprint along the street and across it (m), plus where its centre sits
 * off the centreline. Every footprint stays inside [STRIP_IN, STRIP_OUT]. */
interface ItemSpec {
  along: number;
  across: number;
  off: number;
}
const SPECS: Readonly<Record<FurnitureKind, ItemSpec>> = {
  bench: { along: 1.9, across: 0.66, off: 16.0 },
  bin: { along: 0.6, across: 0.6, off: 15.95 },
  hydrant: { along: 0.5, across: 0.5, off: 15.5 },
  newsbox: { along: 1.75, across: 0.5, off: 16.05 },
  shelter: { along: 4.8, across: 1.3, off: 15.95 },
  bikerack: { along: 4.2, across: 0.9, off: 16.0 },
  bollards: { along: 4.6, across: 0.3, off: 15.45 },
  planter: { along: 1.3, across: 1.0, off: 15.95 },
  booth: { along: 1.05, across: 1.05, off: 15.95 },
};

/** Random-fill kinds and their weights, by the owner block's ground kind:
 * parks, forecourts and the river promenade get benches, planters and
 * bollards; ordinary streets get the newspaper boxes and phone booths. */
const FILL: Readonly<
  Record<"street" | "open", readonly [FurnitureKind, number][]>
> = {
  street: [
    ["bench", 3],
    ["bin", 3],
    ["newsbox", 2],
    ["bikerack", 2],
    ["planter", 1.5],
    ["booth", 1],
    ["bollards", 0.8],
  ],
  open: [
    ["bench", 5],
    ["bin", 2.5],
    ["planter", 3],
    ["bollards", 2],
    ["bikerack", 1],
  ],
};

/** One furniture item: canonical centre, and the side it stands on. */
export interface StreetItem {
  kind: FurnitureKind;
  x: number;
  z: number;
  /** Travel axis of its street — its long side runs along it. */
  axis: "x" | "z";
  /** +1 / −1: which way is "toward the facade" across the street axis. */
  facing: 1 | -1;
  /** Variant / palette pick in [0, 1), drawn once. */
  variant: number;
  /** Low-discrepancy thinning rank in [0, 1). */
  rank: number;
}

/** Per-block hard caps — enforced inside the pure functions on a stable
 * order, so two clients never draw different truncations (the steam rule). */
export const MAX_FURNITURE_PER_BLOCK = 56;
export const MAX_PARKED_PER_SIDE = 28;
export const MAX_CART_VENTS_PER_BLOCK = 2;

/** An axis-aligned plan-view footprint: centre and half extents, canonical. */
export interface Footprint {
  x: number;
  z: number;
  hx: number;
  hz: number;
}

/** What the live city vetoes. Built once by the caller (renderer or test). */
export interface StreetDetailContext {
  /** Every fly-through hole — its corridor (the mouth plus HOLE_RUN_OUT on
   * each side) stays empty, so nothing parks or stands in a hole approach. */
  holes: readonly HoleSpan[];
  /** Ground-reaching static solids (the train's pillars) to stay clear of. */
  keepOut: readonly Footprint[];
  /** The block's gutter vents (steam.ts street vents), canonical. */
  ventsFor: (bx: number, bz: number) => readonly { x: number; z: number }[];
  /** A1's street stations on the block (citylife.ts blockStations): its
   * food carts (steamed by G1), and the bus-stop waiters and performers
   * whose crowds the furniture stays clear of. */
  stationsFor: (
    bx: number,
    bz: number,
  ) => {
    carts: readonly { x: number; z: number }[];
    crowds: readonly { x: number; z: number }[];
  };
}

/** Clearance around keep-out footprints, meters. */
const KEEP_OUT_MARGIN = 1;

/** Plan-view footprint of a hole's corridor: the hole itself plus
 * HOLE_RUN_OUT beyond each mouth, HOLE_CORRIDOR_MARGIN either side. */
export function holeCorridor(span: HoleSpan): Footprint {
  const along = span.length / 2 + HOLE_RUN_OUT;
  const across = span.hole.width / 2 + HOLE_CORRIDOR_MARGIN;
  return span.hole.axis === "x"
    ? { x: span.center.x, z: span.center.z, hx: along, hz: across }
    : { x: span.center.x, z: span.center.z, hx: across, hz: along };
}

/** Do two canonical footprints overlap (torus-correct)? */
export const overlaps = (a: Footprint, b: Footprint, pad = 0): boolean =>
  Math.abs(wrapDeltaAxis(a.x, b.x)) < a.hx + b.hx + pad &&
  Math.abs(wrapDeltaAxis(a.z, b.z)) < a.hz + b.hz + pad;

/** Is a footprint vetoed by the live city? */
function vetoed(
  f: Footprint,
  ctx: StreetDetailContext,
  corridors: readonly Footprint[],
) {
  for (const c of corridors) if (overlaps(f, c)) return true;
  for (const k of ctx.keepOut) if (overlaps(f, k, KEEP_OUT_MARGIN)) return true;
  return false;
}

/** Corridor cache per holes array (built once per city). */
const corridorCache = new WeakMap<readonly HoleSpan[], Footprint[]>();
function corridorsOf(holes: readonly HoleSpan[]): Footprint[] {
  let c = corridorCache.get(holes);
  if (!c) {
    c = holes.map(holeCorridor);
    corridorCache.set(holes, c);
  }
  return c;
}

/** The footprint of an item standing `along` m into side `s`. */
function itemFootprint(
  s: StreetSide,
  kind: FurnitureKind,
  along: number,
): Footprint {
  const spec = SPECS[kind];
  const p = sidePoint(s, along, spec.off);
  return s.axis === "z"
    ? { x: p.x, z: p.z, hx: spec.across / 2, hz: spec.along / 2 }
    : { x: p.x, z: p.z, hx: spec.along / 2, hz: spec.across / 2 };
}

/** Along-intervals on a side's furniture strip that nothing may overlap. */
function fixedObstacles(
  s: StreetSide,
  vents: readonly { x: number; z: number }[],
  stations: ReturnType<StreetDetailContext["stationsFor"]>,
  crowds: boolean,
): [number, number][] {
  const out: [number, number][] = [];
  if (!crowds) {
    for (const a of lampStations(s.side))
      out.push([a - LAMP_CLEAR, a + LAMP_CLEAR]);
    for (const a of treePits(s.side)) out.push([a - PIT_CLEAR, a + PIT_CLEAR]);
  }
  // Points standing on this side's pavement (curb to lot line), measured
  // along it: gutter vents, A1's carts and crowds.
  const lineCoord = s.line * BLOCK_PITCH;
  const segStart = s.seg * BLOCK_PITCH;
  const along = (p: { x: number; z: number }, clear: number) => {
    const across = s.axis === "z" ? p.x : p.z;
    const alongW = s.axis === "z" ? p.z : p.x;
    const off = wrapDeltaAxis(lineCoord, across) * s.side;
    if (off < CURB_LINE || off > LOT_LINE + 0.5) return;
    const a = wrapDeltaAxis(segStart, alongW);
    if (a < -clear || a > BLOCK_PITCH + clear) return;
    out.push([a - clear, a + clear]);
  };
  if (crowds) {
    // Bus-stop waiters and audiences: only the seeded fill avoids them — a
    // stop's own shelter stands right where its waiters do.
    for (const c of stations.crowds) along(c, CROWD_CLEAR);
  } else {
    for (const v of vents) along(v, VENT_CLEAR);
    for (const c of stations.carts) along(c, CART_CLEAR);
  }
  return out;
}

const clearOf = (lo: number, hi: number, iv: readonly [number, number][]) =>
  iv.every(([a, b]) => hi <= a || lo >= b);

/**
 * Every furniture item on block (bx, bz)'s four sidewalk sides, capped at
 * MAX_FURNITURE_PER_BLOCK. Deterministic from (seed, block, ctx): the plan's
 * hydrant and bus shelter first, then a seeded walk that fills the free
 * strip between lamps, tree pits and vents with a fixed number of draws per
 * step (so one veto never shifts the rest of the stream).
 */
export function streetFurnitureFor(
  seed: number,
  bx: number,
  bz: number,
  ctx: StreetDetailContext,
): StreetItem[] {
  const rand = g1Stream(seed, bx, bz, TAG_FURNITURE);
  const corridors = corridorsOf(ctx.holes);
  const vents = ctx.ventsFor(bx, bz);
  const stations = ctx.stationsFor(bx, bz);
  const kind = blockGroundKind(bx, bz);
  const open =
    kind === GROUND_PARK || kind === GROUND_FORECOURT || kind === GROUND_RIVER;
  const fill = FILL[open ? "open" : "street"];
  const total = fill.reduce((t, [, w]) => t + w, 0);
  const site = isSite(bx, bz);
  const items: StreetItem[] = [];

  for (const s of blockSides(bx, bz)) {
    const plan = curbPlanFor(s);
    const taken: [number, number][] = fixedObstacles(s, vents, stations, false);
    const facing = s.side; // the facade is further from the centreline
    const place = (
      k: FurnitureKind,
      along: number,
      variant: number,
    ): boolean => {
      const half = SPECS[k].along / 2;
      if (
        along - half < CORNER_CLEAR ||
        along + half > BLOCK_PITCH - CORNER_CLEAR
      )
        return false;
      if (!clearOf(along - half - ITEM_GAP, along + half + ITEM_GAP, taken))
        return false;
      const f = itemFootprint(s, k, along);
      if (vetoed(f, ctx, corridors)) return false;
      taken.push([along - half, along + half]);
      items.push({
        kind: k,
        x: f.x,
        z: f.z,
        axis: s.axis,
        facing,
        variant,
        rank: 0,
      });
      return true;
    };
    // Fixed by the curb plan (always the same draws, placed or not).
    const vHydrant = rand();
    const vShelter = rand();
    if (plan.hydrant !== null) place("hydrant", plan.hydrant, vHydrant);
    // A construction site's sidewalk belongs to its hoarding.
    if (site) continue;
    if (plan.bus !== null) place("shelter", plan.bus, vShelter);
    for (const iv of fixedObstacles(s, vents, stations, true)) taken.push(iv);
    // Seeded fill: 4 draws per step, always.
    let a = CORNER_CLEAR;
    while (a < BLOCK_PITCH - CORNER_CLEAR) {
      const gap = 1.5 + rand() * 9;
      const pick = rand() * total;
      const variant = rand();
      const skip = rand() < (open ? 0.25 : 0.15);
      let acc = 0;
      let k: FurnitureKind = fill[0]?.[0] ?? "bench";
      for (const [fk, w] of fill) {
        acc += w;
        if (pick < acc) {
          k = fk;
          break;
        }
      }
      const along = a + gap + SPECS[k].along / 2;
      if (along + SPECS[k].along / 2 > BLOCK_PITCH - CORNER_CLEAR) break;
      if (!skip && place(k, along, variant)) a = along + SPECS[k].along / 2;
      else a += gap;
    }
  }
  // Stable cap, then ranks by final index (so thinning is camera-free).
  const capped = items.slice(0, MAX_FURNITURE_PER_BLOCK);
  capped.forEach((it, i) => {
    it.rank = rankOf(i);
  });
  return capped;
}

/** Food-cart steam sources on a block: A1's carts in citylife's own stable
 * order, capped at MAX_CART_VENTS_PER_BLOCK here (the pure side), so every
 * client steams the same carts. */
export function cartVents(
  bx: number,
  bz: number,
  ctx: StreetDetailContext,
): { x: number; z: number }[] {
  return ctx
    .stationsFor(bx, bz)
    .carts.slice(0, MAX_CART_VENTS_PER_BLOCK)
    .map((c) => ({ x: c.x, z: c.z }));
}

// --- Parked vehicles --------------------------------------------------------

export type ParkedKind = "sedan" | "hatch" | "suv" | "taxi" | "van";

/** Body dims (length, width, height), meters — at most ITEM_MAX_HEIGHT. */
export const PARKED_DIMS: Readonly<
  Record<ParkedKind, readonly [number, number, number]>
> = {
  sedan: [4.4, 1.85, 1.45],
  hatch: [3.9, 1.78, 1.5],
  suv: [4.75, 1.95, 1.78],
  taxi: [4.5, 1.9, 1.5],
  van: [5.6, 2.1, 2.6],
};

/** Night body colours (sRGB hex) — the street's real mix: silvers, whites,
 * a few colours, some black. Taxis are always yellow. */
const PARKED_BODIES = [
  0x2a2d38, 0x4a5160, 0x7a7f88, 0xa9adb5, 0xd0d2d6, 0x8a2a24, 0x2c4a6e,
  0x3a4a3a, 0x5a4a3a, 0x1e1f24, 0x6e7178, 0xc9cbd0,
] as const;
const VAN_BODIES = [0xd9dbe0, 0xc9cbd0, 0x2c4a6e, 0x8a2a24] as const;
const TAXI_BODY = 0xd9a514;

/** A parked (or double-parked) vehicle. */
export interface ParkedVehicle {
  kind: ParkedKind;
  /** Canonical centre. */
  x: number;
  z: number;
  axis: "x" | "z";
  /** Heading along the axis: +1 faces increasing coordinate. */
  heading: 1 | -1;
  /** Small parking-imperfection yaw, radians. */
  skew: number;
  /** Meters off the centreline (the lateral slot it occupies). */
  off: number;
  body: number;
  /** In the bike lane / buffer next to the parked row (a delivery stop). */
  double: boolean;
  rank: number;
}

/** Slot pitch along the parking lane, meters. */
const SLOT = 6.3;
const OCCUPANCY = 0.74;
const DOUBLE_PARK_SHARE = 0.22;

/** Off-centreline position of a double-parked van's centre. */
export const DOUBLE_PARK_OFF =
  BIKE_LANE_OUT + DOUBLE_PARK_BIKE_MARGIN + (PARKED_DIMS.van[1] as number) / 2;

/**
 * Parked cars along one street side's curb, and an occasional double-parked
 * delivery van. Only where the curb plan has a parking lane, between the
 * corners' daylighting, outside the hydrant's red curb and the bus zone, and
 * clear of hole corridors and keep-out solids. Capped per side.
 */
export function parkingFor(
  seed: number,
  s: StreetSide,
  ctx: StreetDetailContext,
): ParkedVehicle[] {
  const plan = curbPlanFor(s);
  if (!plan.parking) return [];
  const { bx, bz } = sideOwner(s);
  // One stream per side: salt the block stream with the side's slot.
  const sideSlot = blockSides(bx, bz).findIndex(
    (o) => o.axis === s.axis && o.side === s.side,
  );
  const rand = g1Stream(seed, bx, bz, TAG_PARKING + sideSlot * 0x101);
  const corridors = corridorsOf(ctx.holes);
  // Travel direction of the lane beside this curb (right-hand traffic: on a
  // "z" street the +x side drives +z — traffic.ts trafficLanes()).
  const heading: 1 | -1 = s.axis === "z" ? s.side : s.side === 1 ? -1 : 1;
  const zones: [number, number][] = [];
  if (plan.hydrant !== null)
    zones.push([plan.hydrant - HYDRANT_CLEAR, plan.hydrant + HYDRANT_CLEAR]);
  if (plan.bus !== null) {
    // The zone runs upstream of the shelter (the bus pulls in, then stops).
    const up = plan.bus - heading * BUS_ZONE_BEFORE;
    const down = plan.bus + heading * BUS_ZONE_AFTER;
    zones.push([Math.min(up, down), Math.max(up, down)]);
  }
  const out: ParkedVehicle[] = [];
  const fits = (lo: number, hi: number) =>
    lo >= CORNER_CLEAR &&
    hi <= BLOCK_PITCH - CORNER_CLEAR &&
    clearOf(lo, hi, zones);
  const footprint = (
    along: number,
    off: number,
    len: number,
    wid: number,
  ): Footprint => {
    const p = sidePoint(s, along, off);
    return s.axis === "z"
      ? { x: p.x, z: p.z, hx: wid / 2, hz: len / 2 }
      : { x: p.x, z: p.z, hx: len / 2, hz: wid / 2 };
  };
  for (
    let a = CORNER_CLEAR;
    a + SLOT <= BLOCK_PITCH - CORNER_CLEAR;
    a += SLOT
  ) {
    // 5 draws per slot, always.
    const occupied = rand() < OCCUPANCY;
    const pickK = rand();
    const pickC = rand();
    const jitter = (rand() - 0.5) * 0.7;
    const skewR = (rand() - 0.5) * 0.04;
    if (!occupied) continue;
    const kind: ParkedKind =
      pickK < 0.03
        ? "taxi"
        : pickK < 0.08
          ? "van"
          : pickK < 0.22
            ? "suv"
            : pickK < 0.42
              ? "hatch"
              : "sedan";
    const [len, wid] = PARKED_DIMS[kind];
    const along = a + SLOT / 2 + jitter;
    if (!fits(along - len / 2, along + len / 2)) continue;
    const off = CURB_LINE - PARK_CURB_GAP - wid / 2;
    if (vetoed(footprint(along, off, len, wid), ctx, corridors)) continue;
    const p = sidePoint(s, along, off);
    const body =
      kind === "taxi"
        ? TAXI_BODY
        : kind === "van"
          ? (VAN_BODIES[Math.floor(pickC * VAN_BODIES.length)] as number)
          : (PARKED_BODIES[Math.floor(pickC * PARKED_BODIES.length)] as number);
    out.push({
      kind,
      x: p.x,
      z: p.z,
      axis: s.axis,
      heading,
      skew: skewR,
      off,
      body,
      double: false,
      rank: 0,
    });
  }
  // The delivery stop: 3 draws, always.
  const dRoll = rand();
  const dAt = rand();
  const dCol = rand();
  if (dRoll < DOUBLE_PARK_SHARE) {
    const [len, wid] = PARKED_DIMS.van;
    const lo = CORNER_CLEAR + len;
    const along = lo + dAt * (BLOCK_PITCH - 2 * lo);
    const f = footprint(along, DOUBLE_PARK_OFF, len, wid);
    if (fits(along - len / 2, along + len / 2) && !vetoed(f, ctx, corridors)) {
      out.push({
        kind: "van",
        x: f.x,
        z: f.z,
        axis: s.axis,
        heading,
        skew: 0,
        off: DOUBLE_PARK_OFF,
        body: VAN_BODIES[Math.floor(dCol * VAN_BODIES.length)] as number,
        double: true,
        rank: 0,
      });
    }
  }
  const capped = out.slice(0, MAX_PARKED_PER_SIDE);
  capped.forEach((v, i) => {
    v.rank = rankOf(i + sideSlot * 7);
  });
  return capped;
}

/** Every parked vehicle along block (bx, bz)'s four curbs, side by side. */
export function blockParking(
  seed: number,
  bx: number,
  bz: number,
  ctx: StreetDetailContext,
): ParkedVehicle[] {
  return blockSides(bx, bz).flatMap((s) => parkingFor(seed, s, ctx));
}

// --- Boxes: the ONE derivation of what is drawn (and what the test reads) ---

/** One drawn box: canonical centre, full size (sx along the box's local X,
 * sz along its local Z after the yaw), yaw about Y, roll about the box's own
 * local Z (a bike wheel's octagon), sRGB albedo, and an optional emissive
 * colour (linear) the renderer adds as light. */
export interface DetailBox {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  roll: number;
  color: number;
  emit: readonly [number, number, number] | null;
  /** Thinning rank shared by every box of one object; +2 marks a vehicle. */
  rank: number;
}

/** Lit surfaces (ad panels, booth light, hazards): peak linear luminance.
 * Sub-bloom on purpose — these are lit posters, not lamps; only the ladder's
 * rungs bloom (threshold 0.72). */
export const AD_PANEL_LUMA = 0.6;
export const BOOTH_LIGHT_LUMA = 0.45;
export const HAZARD_LUMA = 0.5;

/** sRGB hex → linear rgb scaled to a target luminance. */
function litColor(hex: number, luma: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((hex >> 16) & 255);
  const g = lin((hex >> 8) & 255);
  const b = lin(hex & 255);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = luma / Math.max(l, 1e-4);
  return [r * k, g * k, b * k];
}

/** Ad poster palette (each panel picks one, luminance-normalised). */
const AD_COLORS = [0xff5ea8, 0x5ec8ff, 0xffd166, 0x9b7bff, 0x6dffb0, 0xff8a4c];

const pick = <T>(list: readonly T[], v: number): T =>
  list[Math.min(list.length - 1, Math.floor(v * list.length))] as T;

/**
 * The boxes of one furniture item. Local frame: u runs along the street
 * (the item's long side), w across it toward the facade. Every box sits on
 * or above the ground and tops out at ≤ ITEM_MAX_HEIGHT.
 */
export function itemBoxes(it: StreetItem): DetailBox[] {
  const out: DetailBox[] = [];
  const ux = it.axis === "x" ? 1 : 0;
  const uz = it.axis === "z" ? 1 : 0;
  // w (toward the facade): on a "z" street that is ±x, on an "x" street ±z.
  const wx = it.axis === "z" ? it.facing : 0;
  const wz = it.axis === "x" ? it.facing : 0;
  const yaw = it.axis === "z" ? Math.PI / 2 : 0;
  const v = it.variant;
  const r = it.rank;
  /** u, w local offsets; su along, sw across; y0..y1 vertical. */
  const box = (
    u: number,
    w: number,
    su: number,
    sw: number,
    y0: number,
    y1: number,
    color: number,
    emit: readonly [number, number, number] | null = null,
    roll = 0,
  ) => {
    out.push({
      x: wrapCoord(it.x + ux * u + wx * w),
      y: (y0 + y1) / 2,
      z: wrapCoord(it.z + uz * u + wz * w),
      sx: su,
      sy: y1 - y0,
      sz: sw,
      yaw,
      roll,
      color,
      emit,
      rank: r,
    });
  };
  switch (it.kind) {
    case "bench": {
      const wood = v < 0.6 ? 0x5a3d2a : 0x23382d;
      box(0, 0, 1.9, 0.5, 0.42, 0.5, wood); // seat
      box(0, 0.27, 1.9, 0.08, 0.5, 0.9, wood); // back toward the facade
      box(-0.8, 0, 0.08, 0.5, 0, 0.42, 0x1c1e24);
      box(0.8, 0, 0.08, 0.5, 0, 0.42, 0x1c1e24);
      break;
    }
    case "bin": {
      box(0, 0, 0.55, 0.55, 0, 0.92, v < 0.5 ? 0x2b3b33 : 0x3a3a40);
      box(0, 0, 0.6, 0.6, 0.92, 1.0, 0x1c1e24);
      break;
    }
    case "hydrant": {
      const c = v < 0.75 ? 0xb8261f : 0xc9a227;
      box(0, 0, 0.36, 0.36, 0, 0.7, c);
      box(0, 0, 0.5, 0.16, 0.42, 0.56, c); // side outlets
      box(0, 0, 0.26, 0.26, 0.7, 0.85, c); // bonnet
      break;
    }
    case "newsbox": {
      const colors = [0x1f4fa0, 0xa82a2a, 0xc8a01e, 0x2e7d4f, 0xd8d8dc];
      const n = 2 + Math.floor(v * 2);
      for (let i = 0; i < n; i++) {
        const u = (i - (n - 1) / 2) * 0.56;
        box(u, 0, 0.5, 0.45, 0, 1.05, pick(colors, (v * 7.3 + i * 0.37) % 1));
      }
      break;
    }
    case "shelter": {
      const frame = 0x30343c;
      const ad = litColor(pick(AD_COLORS, v), AD_PANEL_LUMA);
      box(0, 0, 4.8, 1.3, 2.45, 2.58, frame); // roof
      box(0, 0.6, 4.4, 0.06, 0.25, 2.42, 0x223348); // back glass
      box(-2.3, 0.6, 0.1, 0.1, 0, 2.45, frame); // posts
      box(2.3, 0.6, 0.1, 0.1, 0, 2.45, frame);
      box(-2.3, -0.55, 0.1, 0.1, 0, 2.45, frame);
      box(2.3, 0.0, 0.16, 1.1, 0.3, 2.3, 0x101014, ad); // lit ad panel
      box(-0.4, 0.35, 2.2, 0.4, 0.42, 0.5, 0x3a3e46); // bench
      break;
    }
    case "bikerack": {
      const metal = 0x5c636e;
      // Sheffield hoops: one thin plate each (an inverted U at this scale).
      for (const u of [-1.425, -0.375, 0.725, 1.775]) {
        box(u, 0, 0.41, 0.05, 0, 0.84, metal);
      }
      const bikes = 1 + Math.floor(v * 3);
      const frameColors = [0xb03a2e, 0x2e5fb0, 0x2a2a2a, 0x3f8a5a, 0xd0d0d0];
      for (let i = 0; i < bikes; i++) {
        const u = -1.3 + i * 1.15 + 0.18;
        const c = pick(frameColors, (v * 5.1 + i * 0.29) % 1);
        // Wheels: two thin squares per wheel, one rolled 45° → an octagon.
        for (const wu of [-0.52, 0.52]) {
          box(u + wu, 0.18, 0.6, 0.04, 0.04, 0.64, 0x16171c, null, 0);
          box(u + wu, 0.18, 0.6, 0.04, 0.04, 0.64, 0x16171c, null, Math.PI / 4);
        }
        box(u, 0.18, 1.0, 0.05, 0.55, 0.62, c); // top tube
        box(u - 0.05, 0.18, 0.2, 0.06, 0.33, 0.9, c); // seat tube + saddle
        box(u + 0.45, 0.18, 0.06, 0.45, 0.88, 0.92, 0x2a2a2a); // bars
      }
      break;
    }
    case "bollards": {
      for (let i = 0; i < 4; i++) {
        const u = -1.8 + i * 1.2;
        box(u, 0, 0.24, 0.24, 0, 0.92, 0x2a2a30);
        box(u, 0, 0.26, 0.26, 0.72, 0.8, 0x8a8f96); // reflective band
      }
      break;
    }
    case "planter": {
      box(0, 0, 1.3, 1.0, 0, 0.62, v < 0.5 ? 0x4a4a52 : 0x3d3428);
      box(0, 0, 1.05, 0.78, 0.62, 1.15, v < 0.7 ? 0x1f3a22 : 0x2a4a24);
      break;
    }
    case "booth": {
      const light = litColor(0xd8ecff, BOOTH_LIGHT_LUMA);
      box(0, 0, 1.05, 1.05, 0, 0.25, 0x1c2a4a);
      box(0, 0, 0.98, 0.98, 0.25, 2.1, 0x2c3e66, light); // lit glass box
      box(0, 0, 1.05, 1.05, 2.1, 2.35, 0x1c2a4a);
      box(
        0,
        0,
        1.0,
        1.0,
        2.35,
        2.5,
        0x101014,
        litColor(0x9fd0ff, AD_PANEL_LUMA),
      ); // sign band
      break;
    }
  }
  return out;
}

/** The boxes of one parked vehicle: chassis, cabin glass, two wheel pairs
 * (and hazard markers on a double-parked van). */
export function vehicleBoxes(p: ParkedVehicle): DetailBox[] {
  const [len, wid, h] = PARKED_DIMS[p.kind];
  const out: DetailBox[] = [];
  // Forward unit vector in the plan (heading along the axis, then skew).
  const yaw0 =
    p.axis === "z"
      ? p.heading === 1
        ? Math.PI
        : 0
      : p.heading === 1
        ? -Math.PI / 2
        : Math.PI / 2;
  const yaw = yaw0 + p.skew;
  // Forward is −Z at yaw 0 (the plane/traffic convention).
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rank = p.rank + 2;
  const box = (
    f: number,
    sl: number,
    sw: number,
    y0: number,
    y1: number,
    color: number,
    emit: readonly [number, number, number] | null = null,
    side = 0,
  ) => {
    // side: offset along the vehicle's right (−fz, fx) axis.
    out.push({
      x: wrapCoord(p.x + fx * f - fz * side),
      y: (y0 + y1) / 2,
      z: wrapCoord(p.z + fz * f + fx * side),
      sx: sw,
      sy: y1 - y0,
      sz: sl,
      yaw,
      roll: 0,
      color,
      emit,
      rank,
    });
  };
  const glass = 0x223044;
  if (p.kind === "van") {
    box(0, len, wid, 0.32, h, p.body); // box body
    box(len / 2 - 0.55, 0.9, wid * 0.94, 1.15, 1.95, glass); // windscreen band
    if (p.double) {
      const amber = litColor(0xffa020, HAZARD_LUMA);
      box(
        -len / 2 + 0.05,
        0.12,
        0.2,
        0.9,
        1.1,
        0x101014,
        amber,
        wid / 2 - 0.15,
      );
      box(
        -len / 2 + 0.05,
        0.12,
        0.2,
        0.9,
        1.1,
        0x101014,
        amber,
        -wid / 2 + 0.15,
      );
    }
  } else {
    const cabin = p.kind === "suv" ? 0.62 : p.kind === "hatch" ? 0.66 : 0.52;
    box(0, len, wid, 0.3, 0.95, p.body); // chassis
    box(-len * 0.04, len * cabin, wid * 0.86, 0.95, h, glass); // cabin
    box(-len * 0.04, len * cabin * 0.9, wid * 0.82, h - 0.04, h, p.body); // roof skin
    if (p.kind === "taxi")
      box(
        -len * 0.04,
        0.5,
        0.3,
        h,
        h + 0.18,
        0x101014,
        litColor(0xffe39a, 0.4),
      );
  }
  const axle = len / 2 - 0.85;
  box(axle, 0.66, wid + 0.04, 0, 0.62, 0x101114);
  box(-axle, 0.66, wid + 0.04, 0, 0.62, 0x101114);
  return out;
}
