// D9 more destruction — the shared, pure half of every destructible thing in
// the city that is not a building chunk: parked cars and taxis, fuel trucks,
// the riverside gas stations and utility poles, street lamps and signal
// masts, the R2 roof water tanks, billboards and antenna masts, the S1
// jumbotrons, the middle span of every river bridge and the tower cranes.
//
// A PROP is one of those things. Its id is its index in generateProps()'s
// output — the order is protocol, exactly like the building order — and
// everything about it (where it stands, how big it is, how it falls, where
// it lands) is a pure function of (seed, the GENERATED city, its movers), so
// the server, every live client and every late joiner agree on it from the
// prop's id and the instant it went down alone.
//
// AUTHORITY (PLAN.md's split): the SERVER decides what goes down and when —
// bullets, blasts, crushes, chain explosions (server/src/destruction.ts) —
// and broadcasts it (`props` messages, the welcome's `props`). Clients hold
// the same PropState and pose everything from it.
//
// SOLID vs COSMETIC. What can block or kill is solid and drawn == collided:
// a roof tank, billboard panel, mast, jumbotron or bridge span that goes
// down FALLS as one closed-form PiecePose (propPieceInto) that collideProps
// tests, the crash check, the camera arm and every bot probe included (it is
// MoverField.props). Street-level things (vehicles, the gas stations' ≤ 3 m
// canopies) and the thin furniture (lamps, signals, poles — non-solid since
// V1) are cosmetic: their state is still server-stamped, so they chain and
// every client sees the same wrecks, but nothing about them collides.
//
// Roof props write through to `b.roof` (standing.ts setRoofDown), so a felled
// tank leaves collision, sight lines, rays and the roof renderer at once; a
// fallen span opens a gap in its deck (river.ts riverHit `gaps`).
//
// Not re-exported from common/src/index.ts; import "@angels-bandits/common/city/props".

import {
  BLOCK_PITCH,
  COLLAPSE_GRAVITY,
  CRANE_MAST_SIDE,
  CROSSWALK_DEPTH,
  HOLE_CLEARANCE,
  HOLE_CORRIDOR_MARGIN,
  HOLE_RUN_OUT,
  WORLD_SIZE,
} from "../constants";
import { type Vec3, wrapCoord, wrapDeltaAxis } from "../world/index";
import {
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
  type PiecePose,
  blankPose,
  sphereHitsPiece,
} from "./collapse";
import type { Collapse } from "./collapse";
import {
  cellBox,
  cellIndex,
  chunkBuilding,
  chunkCell,
  chunkId,
  chunkMask,
  chunkTier,
  tierGrids,
} from "./destruction";
import type { LocalBox } from "./destruction";
import { type HoleSpan, cityHoles } from "./holes";
import type { Building } from "./index";
import {
  SCREEN_DEPTH,
  TICKER_GAP,
  TICKER_HEIGHT,
  jumbotronSites,
} from "./jumbotron-sites";
import type { CraneSite } from "./movers";
import {
  BRIDGE_COUNT,
  BRIDGE_DECK_DEPTH,
  BRIDGE_HALF_WIDTH,
  BRIDGE_SPAN_HALF,
  PROMENADE_DEPTH,
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
  RIVER_ROW,
  RIVER_WATER_Y,
  overChannel,
  riverOffset,
} from "./river";
import { mulberry32 } from "./rng";
import { generatedRoof, pointStands, setRoofDown } from "./standing";
import {
  CURB_LINE,
  INTERSECTION_HALF,
  isInRoadway,
  signalMastsForBlock,
  streetlampPositions,
} from "./street";
import type { TrainLine } from "./train";
import { inPortalCut } from "./tunnels";

// --- Kinds -----------------------------------------------------------------

export const PROP_LAMP = 0;
export const PROP_SIGNAL = 1;
export const PROP_CAR = 2;
export const PROP_TAXI = 3;
export const PROP_FUEL = 4;
export const PROP_STATION = 5;
export const PROP_POLE = 6;
export const PROP_TANK = 7;
export const PROP_BILLBOARD = 8;
export const PROP_MAST = 9;
export const PROP_JUMBO = 10;
export const PROP_BRIDGE = 11;
export const PROP_CRANE = 12;
export type PropKind =
  | typeof PROP_LAMP
  | typeof PROP_SIGNAL
  | typeof PROP_CAR
  | typeof PROP_TAXI
  | typeof PROP_FUEL
  | typeof PROP_STATION
  | typeof PROP_POLE
  | typeof PROP_TANK
  | typeof PROP_BILLBOARD
  | typeof PROP_MAST
  | typeof PROP_JUMBO
  | typeof PROP_BRIDGE
  | typeof PROP_CRANE;
export const PROP_KIND_COUNT = 13;

/** Names, for QA, logs and tests (index = kind). */
export const PROP_KIND_NAMES = [
  "lamp",
  "signal",
  "car",
  "taxi",
  "fuel",
  "station",
  "pole",
  "tank",
  "billboard",
  "mast",
  "jumbo",
  "bridge",
  "crane",
] as const;

/** HP per kind (bullets take BULLET_DAMAGE = 7 each). */
export const PROP_HP: readonly number[] = [
  25, 25, 40, 40, 60, 140, 30, 90, 70, 40, 160, 400, 500,
];

/** Kinds that fall as a SOLID piece (draw == collide) once down. */
export const isFaller = (kind: number): boolean =>
  kind === PROP_TANK ||
  kind === PROP_BILLBOARD ||
  kind === PROP_MAST ||
  kind === PROP_JUMBO ||
  kind === PROP_BRIDGE;

/** Kinds that are R2 roof structures (they live in `b.roof` while up). */
export const isRoofProp = (kind: number): boolean =>
  kind === PROP_TANK || kind === PROP_BILLBOARD || kind === PROP_MAST;

/** Kinds that explode when they go down: blast radius m and damage (chunks
 * and props, falling off linearly to 0 at the radius). */
export const PROP_BLAST: readonly (readonly [number, number] | null)[] = [
  null,
  null,
  [8, 120],
  [8, 120],
  [20, 320],
  [28, 420],
  null,
  null,
  null,
  null,
  null,
  null,
  null,
];
export const isExplosive = (kind: number): boolean => PROP_BLAST[kind] !== null;

// --- Bounds (the chain can never run away) ---------------------------------

/** Links in one chain of prop events (blast → blast, crush → blast, …) —
 * ONE counter shared with D5's structural chain (destruction.ts). */
export const PROP_CHAIN_DEPTH_MAX = 5;
/** At most this many prop blasts land per server tick (the rest wait). */
export const PROP_BLASTS_PER_TICK = 6;
/** At most this many props go down per server tick. */
export const PROP_DOWN_PER_TICK = 64;
/** No prop goes down while this share of all props is down. */
export const PROP_DOWN_CAP = 0.4;
/** A fire can jump to another building's chunk within this, m. */
export const FIRE_JUMP_M = 6;
/** A blast leaves a crater when its centre is this close over a roadway. */
export const CRATER_MAX_Y = 4;
/** Craters held per room (the oldest is repaired first). */
export const CRATERS_MAX = 24;
/** A crater closer than this to a held one is the same crater, m. */
export const CRATER_MERGE_M = 4;
/** A solid faller's landing drives a D2 blast this big into its deck. */
export const LANDING_BLAST: readonly [number, number] = [6, 140];
/** Street props and craters repair this long after going down, ms (a
 * seeded share of the band per prop). */
export const PROP_REPAIR_MS: readonly [number, number] = [60_000, 100_000];
/** A fallen bridge span is rebuilt after this, ms — only when clear. */
export const SPAN_REPAIR_MS = 120_000;
/** A span repair is announced this long before the deck is back, ms. */
export const SPAN_REPAIR_LEAD_MS = 2000;

// --- The layout ------------------------------------------------------------

/** One destructible prop. The standing box is axis-aligned in plan view:
 * canonical centre (x, y, z) and half extents along the world axes. */
export interface Prop {
  readonly id: number;
  readonly kind: PropKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  /** Heading for drawing, rad (MoverBox convention). */
  readonly yaw: number;
  readonly hp: number;
  /** Building it belongs to (roof props, jumbotrons), else −1. */
  readonly b: number;
  /** Roof props: the generatedRoof(b) indices it removes (bitmask). */
  readonly roof: number;
  /** Kind-specific: lamp / signal-mast index, bridge index, jumbotron site,
   * crane site id, the next pole's prop id (−1 = end of a run). */
  readonly ref: number;
  /** A lamp standing on a bridge's breakable span: that bridge, else −1. */
  readonly span: number;
  /** Solid fallers: fall direction (collapse.ts DIR_*), else −1. */
  readonly dir: number;
  /** Solid fallers: the generated surface it lands on, m. */
  readonly landY: number;
  /** A per-prop roll in [0, 1) (variants, fuse, repair delay). */
  readonly seed: number;
}

export interface PropLayout {
  readonly props: readonly Prop[];
  /** Props by block (bx·GRID + bz of their centre), ascending ids. */
  readonly buckets: readonly (readonly number[])[];
  /** First id of each kind (props are generated kind by kind), and one
   * past the last. */
  readonly first: readonly number[];
  /** Roof props per building index → their ids. */
  readonly roofOf: ReadonlyMap<number, readonly number[]>;
  /** The roof prop removing generated roof structure k of building b. */
  readonly roofProp: ReadonlyMap<number, number>;
  /** Lamps standing on each bridge's span (by bridge index). */
  readonly spanLamps: readonly (readonly number[])[];
  /** Bridge prop id by bridge index. */
  readonly bridges: readonly number[];
  /** Crane prop id by crane site id. */
  readonly cranes: ReadonlyMap<number, number>;
}

const GRID = WORLD_SIZE / BLOCK_PITCH;
const wrapGrid = (v: number) => ((v % GRID) + GRID) % GRID;
/** Every prop's plan-view half extent is under this (a jumbotron is 24 m). */
const PROP_MAX_HALF = 26;
/** Key for `roofProp`: building index × 64 + generated roof index. */
export const roofKey = (b: number, k: number): number => b * 64 + k;

/** G1's parked-car curb gap (street-detail.ts PARK_CURB_GAP), m. */
const PARK_CURB_GAP = 0.3;
/** Vehicle body (length, width, height), m — G1's sedan and taxi, and a
 * fuel tanker kept at the ≤ 3 m street exception. */
export const VEHICLE_DIMS: Readonly<
  Record<number, readonly [number, number, number]>
> = {
  [PROP_CAR]: [4.4, 1.85, 1.45],
  [PROP_TAXI]: [4.5, 1.9, 1.5],
  [PROP_FUEL]: [9, 2.5, 3],
};
/** G1's corner clear: off the intersection and its crosswalks. */
const CORNER_CLEAR = INTERSECTION_HALF + CROSSWALK_DEPTH + 3;
/** G1's hydrant red curb (station ± clear), avoided by parked props. */
const HYDRANT_ZONE: readonly [number, number] = [24, 36];
/** Share of street sides with a D9 vehicle, and of those a taxi / tanker. */
const VEHICLE_SHARE = 0.62;
const TAXI_SHARE = 0.17;
const FUEL_SHARE = 0.035;

/** Gas stations: how many, and their footprint (x along the river, z
 * across), canopy height. */
export const STATION_COUNT = 3;
export const STATION_HALF: readonly [number, number] = [8, 6];
export const STATION_HEIGHT = 3;
/** Utility poles along each promenade: spacing, height, off the wall. */
export const POLE_STEP = 25;
export const POLE_HEIGHT = 9;
const POLE_WALL_OFF = 1.5;
/** Lamp and signal heights (render/streetlights.ts, signals.ts). */
export const LAMP_HEIGHT = 7;
export const MAST_HEIGHT = 5.4;
export const XWALK_MAST_HEIGHT = 3.6;
/** Drawn (and collided) half thickness of a felled antenna mast, m. */
const MAST_HALF = 0.25;

/** Seconds a solid faller takes to topple over (before any drop). */
const TOPPLE_S: Readonly<Record<number, number>> = {
  [PROP_TANK]: 1.3,
  [PROP_BILLBOARD]: 1.1,
  [PROP_MAST]: 1.7,
  [PROP_JUMBO]: 1.6,
};
/** A fallen span rests this far over the water (mostly submerged), m. */
const SPAN_REST_Y = RIVER_WATER_Y + 0.4;

const propRand = (seed: number, salt: number, n: number): (() => number) =>
  mulberry32((seed ^ salt ^ Math.imul(n + 1, 0x9e3779b9)) >>> 0);

/** A hash in [0, 1) of a prop id (fuse, repair delay — pure in the id). */
export const propHash = (id: number, salt: number): number =>
  mulberry32((Math.imul(id + 1, 0x85ebca6b) ^ salt) >>> 0)();

/** Fuse of an explosive prop, ms after it goes down. */
export const propFuseMs = (id: number): number =>
  250 + 650 * propHash(id, 0x0f05e);

/** When a street prop or crater repairs, ms after it went down. */
export const propRepairMs = (id: number): number =>
  PROP_REPAIR_MS[0] +
  (PROP_REPAIR_MS[1] - PROP_REPAIR_MS[0]) * propHash(id, 0x2e9a17);

/** What the movers bring: the cranes and the train lines (both optional so
 * tests can build a layout from a bare city). */
export interface PropWorld {
  cranes?: readonly CraneSite[];
  trains?: readonly TrainLine[];
}

/** A plan-view rectangle (canonical centre, half extents). */
interface Area {
  x: number;
  z: number;
  hx: number;
  hz: number;
}

const overlapsArea = (a: Area, b: Area, pad = 0): boolean =>
  Math.abs(wrapDeltaAxis(a.x, b.x)) < a.hx + b.hx + pad &&
  Math.abs(wrapDeltaAxis(a.z, b.z)) < a.hz + b.hz + pad;

/** G1's hole veto (street-detail.ts vetoesStreet / holeCorridor): a low
 * hole's corridor stays empty. */
function holeCorridors(spans: readonly HoleSpan[]): Area[] {
  const out: Area[] = [];
  for (const span of spans) {
    if (span.hole.y0 >= 3 + HOLE_CLEARANCE) continue;
    const along = span.length / 2 + HOLE_RUN_OUT;
    const across = span.hole.width / 2 + HOLE_CORRIDOR_MARGIN;
    out.push(
      span.hole.axis === "x"
        ? { x: span.center.x, z: span.center.z, hx: along, hz: across }
        : { x: span.center.x, z: span.center.z, hx: across, hz: along },
    );
  }
  return out;
}

/** The train lines' ground-reaching boxes (pillars, stairs, posts). */
function trainKeepOut(trains: readonly TrainLine[]): Area[] {
  const out: Area[] = [];
  for (const line of trains) {
    line.viaduct.forEach((b, i) => {
      if (b.y - b.hy > 4) return;
      out.push({
        x: b.x,
        z: b.z,
        hx: line.extents[2 * i] ?? b.hx,
        hz: line.extents[2 * i + 1] ?? b.hz,
      });
    });
  }
  return out;
}

/** Mutable builder record. */
type Draft = { -readonly [K in keyof Prop]: Prop[K] };

/**
 * Every destructible prop of the city `buildings` (MUST be the generated
 * city for `seed`, undamaged) and its movers. Deterministic: the same inputs
 * give the same props in the same order on every machine.
 */
export function generateProps(
  seed: number,
  buildings: readonly Building[],
  world: PropWorld = {},
): PropLayout {
  const props: Draft[] = [];
  const first: number[] = [];
  const add = (p: Omit<Draft, "id">): Draft => {
    const d = { ...p, id: props.length } as Draft;
    props.push(d);
    return d;
  };
  const base = {
    yaw: 0,
    b: -1,
    roof: 0,
    ref: -1,
    span: -1,
    dir: -1,
    landY: 0,
    seed: 0,
  };

  // Lamps — streetlampPositions() order, so lamp i is prop first[LAMP] + i.
  first[PROP_LAMP] = props.length;
  const spanLamps: number[][] = Array.from({ length: BRIDGE_COUNT }, () => []);
  streetlampPositions().forEach((l, i) => {
    const onSpan =
      Math.abs(riverOffset(l.z)) < BRIDGE_SPAN_HALF &&
      Math.abs(
        wrapDeltaAxis(Math.round(l.x / BLOCK_PITCH) * BLOCK_PITCH, l.x),
      ) <= BRIDGE_HALF_WIDTH;
    const span = onSpan ? wrapGrid(Math.round(l.x / BLOCK_PITCH)) : -1;
    const p = add({
      ...base,
      kind: PROP_LAMP,
      x: l.x,
      y: LAMP_HEIGHT / 2,
      z: l.z,
      hx: 0.25,
      hy: LAMP_HEIGHT / 2,
      hz: 0.25,
      hp: PROP_HP[PROP_LAMP] as number,
      ref: i,
      span,
      seed: propHash(i, 0x1a3b),
    });
    if (span >= 0) (spanLamps[span] as number[]).push(p.id);
  });

  // Signal masts — block by block (bx outer), signalMastsForBlock order.
  first[PROP_SIGNAL] = props.length;
  let mast = 0;
  for (let bx = 0; bx < GRID; bx++) {
    for (let bz = 0; bz < GRID; bz++) {
      for (const m of signalMastsForBlock(bx, bz)) {
        const h = m.kind === "vehicle" ? MAST_HEIGHT : XWALK_MAST_HEIGHT;
        add({
          ...base,
          kind: PROP_SIGNAL,
          x: m.x,
          y: h / 2,
          z: m.z,
          hx: 0.2,
          hy: h / 2,
          hz: 0.2,
          yaw: m.yaw,
          hp: PROP_HP[PROP_SIGNAL] as number,
          ref: mast,
          seed: propHash(mast, 0x5161),
        });
        mast++;
      }
    }
  }

  // Vehicles — at most one per owned street side, in the parking lane.
  first[PROP_CAR] = props.length;
  const corridors = holeCorridors(cityHoles(buildings));
  const keepOut = trainKeepOut(world.trains ?? []);
  for (let bx = 0; bx < GRID; bx++) {
    for (let bz = 0; bz < GRID; bz++) {
      const sides = [
        { axis: "z" as const, line: bx, seg: bz, side: 1 },
        { axis: "z" as const, line: wrapGrid(bx + 1), seg: bz, side: -1 },
        { axis: "x" as const, line: bz, seg: bx, side: 1 },
        { axis: "x" as const, line: wrapGrid(bz + 1), seg: bx, side: -1 },
      ];
      sides.forEach((s, k) => {
        const rand = propRand(seed, 0x0d9ca5, (bx * GRID + bz) * 4 + k);
        // Fixed draws, whatever happens to the slot.
        const occupied = rand() < VEHICLE_SHARE;
        const pick = rand();
        const at = rand();
        const variant = rand();
        if (!occupied) return;
        // A north–south side through the river row is a bridge: no parking.
        if (s.axis === "z" && s.seg === RIVER_ROW) return;
        const kind =
          pick < FUEL_SHARE
            ? PROP_FUEL
            : pick < TAXI_SHARE
              ? PROP_TAXI
              : PROP_CAR;
        const [len, wid, h] = VEHICLE_DIMS[kind] as readonly [
          number,
          number,
          number,
        ];
        const span = BLOCK_PITCH - 2 * CORNER_CLEAR - len;
        let along = CORNER_CLEAR + len / 2 + at * span;
        if (
          along + len / 2 > HYDRANT_ZONE[0] &&
          along - len / 2 < HYDRANT_ZONE[1]
        ) {
          along = HYDRANT_ZONE[1] + len / 2 + 1 + at * 20;
        }
        const off = CURB_LINE - PARK_CURB_GAP - wid / 2;
        const a = wrapCoord(s.seg * BLOCK_PITCH + along);
        const c = wrapCoord(s.line * BLOCK_PITCH + s.side * off);
        const x = s.axis === "z" ? c : a;
        const z = s.axis === "z" ? a : c;
        const area: Area =
          s.axis === "z"
            ? { x, z, hx: wid / 2, hz: len / 2 }
            : { x, z, hx: len / 2, hz: wid / 2 };
        if (overChannel(z) && s.axis === "z") return;
        if (inPortalCut(x, z, 3)) return;
        if (corridors.some((r) => overlapsArea(area, r))) return;
        if (keepOut.some((r) => overlapsArea(area, r, 1))) return;
        // Right-hand traffic: the lane beside this curb drives +along on
        // the + side of a "z" street (street-detail.ts parkingFor).
        const heading = s.axis === "z" ? s.side : -s.side;
        const yaw =
          s.axis === "z"
            ? heading > 0
              ? Math.PI
              : 0
            : heading > 0
              ? -Math.PI / 2
              : Math.PI / 2;
        add({
          ...base,
          kind,
          x,
          y: h / 2,
          z,
          hx: area.hx,
          hy: h / 2,
          hz: area.hz,
          yaw,
          hp: PROP_HP[kind] as number,
          seed: variant,
        });
      });
    }
  }

  // Gas stations — riverside, mid-block between two bridges, on either
  // promenade (seeded pick of the candidates that are clear).
  first[PROP_STATION] = props.length;
  const promenadeZ = (bank: -1 | 1) =>
    RIVER_CENTER_Z + bank * (RIVER_HALF_WIDTH + PROMENADE_DEPTH / 2);
  const candidates: { x: number; z: number; bank: -1 | 1 }[] = [];
  for (let i = 0; i < GRID; i++) {
    for (const bank of [-1, 1] as const) {
      candidates.push({
        x: i * BLOCK_PITCH + BLOCK_PITCH / 2,
        z: promenadeZ(bank),
        bank,
      });
    }
  }
  const order = propRand(seed, 0x6a5057, 0);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(order() * (i + 1));
    const t = candidates[i] as (typeof candidates)[number];
    candidates[i] = candidates[j] as (typeof candidates)[number];
    candidates[j] = t;
  }
  const stations: { x: number; bank: -1 | 1 }[] = [];
  for (const c of candidates) {
    if (stations.length >= STATION_COUNT) break;
    if (inPortalCut(c.x, c.z, STATION_HALF[0] + 4)) continue;
    stations.push({ x: c.x, bank: c.bank });
    add({
      ...base,
      kind: PROP_STATION,
      x: wrapCoord(c.x),
      y: STATION_HEIGHT / 2,
      z: c.z,
      hx: STATION_HALF[0],
      hy: STATION_HEIGHT / 2,
      hz: STATION_HALF[1],
      yaw: c.bank > 0 ? Math.PI : 0,
      hp: PROP_HP[PROP_STATION] as number,
      seed: order(),
    });
  }

  // Utility poles — a line along each promenade, 1.5 m off the channel
  // wall, broken by every bridge and every gas station.
  first[PROP_POLE] = props.length;
  for (const bank of [-1, 1] as const) {
    const z = RIVER_CENTER_Z + bank * (RIVER_HALF_WIDTH + POLE_WALL_OFF);
    let prev: Draft | null = null;
    for (let x = POLE_STEP / 2; x < WORLD_SIZE; x += POLE_STEP) {
      const line = Math.round(x / BLOCK_PITCH) * BLOCK_PITCH;
      const nearBridge = Math.abs(x - line) < BRIDGE_HALF_WIDTH + 4;
      const nearStation = stations.some(
        (s) =>
          s.bank === bank &&
          Math.abs(wrapDeltaAxis(s.x, x)) < STATION_HALF[0] + 4,
      );
      if (nearBridge || nearStation || inPortalCut(x, z, 2)) {
        prev = null;
        continue;
      }
      const p = add({
        ...base,
        kind: PROP_POLE,
        x,
        y: POLE_HEIGHT / 2,
        z,
        hx: 0.2,
        hy: POLE_HEIGHT / 2,
        hz: 0.2,
        hp: PROP_HP[PROP_POLE] as number,
        seed: propHash(props.length, 0x9013),
      });
      if (prev) prev.ref = p.id;
      prev = p;
    }
  }

  // Roof props — the generated R2 tanks, billboards (panel + legs) and
  // antenna masts, building by building.
  first[PROP_TANK] = props.length;
  const roofOf = new Map<number, number[]>();
  const roofProp = new Map<number, number>();
  buildings.forEach((b, bi) => {
    const roof = generatedRoof(b) ?? [];
    for (let k = 0; k < roof.length; k++) {
      const r = roof[k] as (typeof roof)[number];
      let kind: PropKind | -1 = -1;
      let mask = 1 << k;
      if (r.kind === "waterTank") kind = PROP_TANK;
      else if (r.kind === "mast") kind = PROP_MAST;
      else if (r.kind === "billboard") {
        kind = PROP_BILLBOARD;
        for (let j = k + 1; j < roof.length; j++) {
          if ((roof[j] as (typeof roof)[number]).kind !== "billboardLeg") break;
          mask |= 1 << j;
        }
      }
      if (kind === -1) continue;
      const half = kind === PROP_MAST ? MAST_HALF : 0;
      const hx = half || r.width / 2;
      const hz = half || r.depth / 2;
      let dir: number;
      if (kind === PROP_BILLBOARD) {
        // Backwards, off its face, onto the roof it stands at the edge of.
        dir = [DIR_NEG_X, DIR_POS_X, DIR_NEG_Z, DIR_POS_Z][r.face] as number;
      } else if (Math.abs(r.dx) >= Math.abs(r.dz) && r.dx !== 0) {
        dir = r.dx > 0 ? DIR_NEG_X : DIR_POS_X; // toward the roof centre
      } else if (r.dz !== 0) {
        dir = r.dz > 0 ? DIR_NEG_Z : DIR_POS_Z;
      } else {
        dir = r.seed < 0.5 ? DIR_POS_X : DIR_POS_Z;
      }
      const p = add({
        ...base,
        kind,
        x: wrapCoord(b.x + r.dx),
        y: r.baseY + r.height / 2,
        z: wrapCoord(b.z + r.dz),
        hx,
        hy: r.height / 2,
        hz,
        hp: PROP_HP[kind] as number,
        b: bi,
        roof: mask,
        ref: k,
        dir,
        landY: b.height,
        seed: r.seed,
      });
      for (let j = 0; j < 31; j++) {
        if (mask & (1 << j)) roofProp.set(roofKey(bi, j), p.id);
      }
      const list = roofOf.get(bi) ?? [];
      list.push(p.id);
      roofOf.set(bi, list);
    }
  });
  // (Tanks, billboards and masts share one id range, in building order.)
  first[PROP_BILLBOARD] = first[PROP_TANK] as number;
  first[PROP_MAST] = first[PROP_TANK] as number;

  // Jumbotrons — the S1 sites; each falls outward off its facade.
  first[PROP_JUMBO] = props.length;
  jumbotronSites(buildings).forEach((s, i) => {
    const b = buildings[s.building] as Building;
    const lift = TICKER_GAP + TICKER_HEIGHT;
    const hy = (s.height + lift) / 2;
    const thin = SCREEN_DEPTH / 2;
    const dir =
      s.axis === "x"
        ? s.dir > 0
          ? DIR_POS_X
          : DIR_NEG_X
        : s.dir > 0
          ? DIR_POS_Z
          : DIR_NEG_Z;
    // Where it lands: the highest lower tier its lying footprint (out from
    // the facade by its full height) overlaps — a landmark's podium — else
    // the street. Generated shape only, so it is pure.
    const fx = wrapDeltaAxis(b.x, s.x);
    const fz = wrapDeltaAxis(b.z, s.z);
    const out0 = s.axis === "x" ? fx : fz;
    const lo = Math.min(out0, out0 + s.dir * 2 * hy);
    const hi = Math.max(out0, out0 + s.dir * 2 * hy);
    const across = s.axis === "x" ? fz : fx;
    let landY = 0;
    let top = 0;
    for (const t of b.tiers) {
      top += t.height;
      if (top > s.y - lift) break;
      const half = (s.axis === "x" ? t.width : t.depth) / 2;
      const halfAcross = (s.axis === "x" ? t.depth : t.width) / 2;
      if (
        lo < half &&
        hi > -half &&
        Math.abs(across) < halfAcross + s.width / 2
      ) {
        landY = top;
      }
    }
    add({
      ...base,
      kind: PROP_JUMBO,
      x: s.x,
      y: s.y - lift + hy,
      z: s.z,
      hx: s.axis === "x" ? thin : s.width / 2,
      hy,
      hz: s.axis === "x" ? s.width / 2 : thin,
      hp: PROP_HP[PROP_JUMBO] as number,
      b: s.building,
      ref: i,
      dir,
      landY,
      seed: propHash(i, 0x7b0),
    });
  });

  // Bridge spans — the middle of each deck.
  first[PROP_BRIDGE] = props.length;
  const bridges: number[] = [];
  for (let i = 0; i < BRIDGE_COUNT; i++) {
    const p = add({
      ...base,
      kind: PROP_BRIDGE,
      x: i * BLOCK_PITCH,
      y: -BRIDGE_DECK_DEPTH / 2,
      z: RIVER_CENTER_Z,
      hx: BRIDGE_HALF_WIDTH,
      hy: BRIDGE_DECK_DEPTH / 2,
      hz: BRIDGE_SPAN_HALF,
      hp: PROP_HP[PROP_BRIDGE] as number,
      ref: i,
      dir: DIR_POS_Z,
      landY: RIVER_WATER_Y,
      seed: propHash(i, 0xb41d),
    });
    bridges.push(p.id);
  }

  // Tower cranes — their mast (a 0-HP crane is condemned, D5 fells it).
  first[PROP_CRANE] = props.length;
  const cranes = new Map<number, number>();
  for (const site of world.cranes ?? []) {
    const p = add({
      ...base,
      kind: PROP_CRANE,
      x: site.x,
      y: site.hubY / 2,
      z: site.z,
      hx: CRANE_MAST_SIDE / 2,
      hy: site.hubY / 2,
      hz: CRANE_MAST_SIDE / 2,
      hp: PROP_HP[PROP_CRANE] as number,
      ref: site.id,
      seed: propHash(site.id, 0xc7a9),
    });
    cranes.set(site.id, p.id);
  }
  first[PROP_KIND_COUNT] = props.length;
  // Kinds with no range of their own start where the next one does.
  first[PROP_TAXI] = first[PROP_CAR] as number;
  first[PROP_FUEL] = first[PROP_CAR] as number;

  return buildPropLayout(props, {
    first,
    roofOf,
    roofProp,
    spanLamps,
    bridges,
    cranes,
  });
}

/**
 * A layout over `props` (ids = their indices): the block buckets built
 * here, the per-kind tables as given (empty by default). generateProps'
 * last step — and how tests hand-build a street of props.
 */
export function buildPropLayout(
  props: readonly Prop[],
  tables: Partial<Omit<PropLayout, "props" | "buckets">> = {},
): PropLayout {
  const buckets: number[][] = Array.from({ length: GRID * GRID }, () => []);
  for (const p of props) {
    const bx = wrapGrid(Math.floor(p.x / BLOCK_PITCH));
    const bz = wrapGrid(Math.floor(p.z / BLOCK_PITCH));
    (buckets[bx * GRID + bz] as number[]).push(p.id);
  }
  return {
    props,
    buckets,
    first: tables.first ?? [],
    roofOf: tables.roofOf ?? new Map(),
    roofProp: tables.roofProp ?? new Map(),
    spanLamps: tables.spanLamps ?? [],
    bridges: tables.bridges ?? [],
    cranes: tables.cranes ?? new Map(),
  };
}

/** Point-to-box distance from `p` to prop `q`'s standing box. */
export function propDistance(q: Prop, p: Vec3): number {
  const dx = Math.max(0, Math.abs(wrapDeltaAxis(q.x, p.x)) - q.hx);
  const dy = Math.max(0, Math.abs(p.y - q.y) - q.hy);
  const dz = Math.max(0, Math.abs(wrapDeltaAxis(q.z, p.z)) - q.hz);
  return Math.hypot(dx, dy, dz);
}

/**
 * Visit every prop whose standing box may come within `r` of plan point
 * (x, z) — a superset (the visitor does the exact test), each once, in
 * ascending block then id order. Allocation-free.
 */
export function propsNear(
  layout: PropLayout,
  x: number,
  z: number,
  r: number,
  visit: (id: number) => void,
): void {
  const reach = r + PROP_MAX_HALF;
  const bx0 = Math.floor((x - reach) / BLOCK_PITCH);
  const bx1 = Math.floor((x + reach) / BLOCK_PITCH);
  const bz0 = Math.floor((z - reach) / BLOCK_PITCH);
  const bz1 = Math.floor((z + reach) / BLOCK_PITCH);
  const nx = Math.min(GRID, bx1 - bx0 + 1);
  const nz = Math.min(GRID, bz1 - bz0 + 1);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const list = layout.buckets[
        wrapGrid(bx0 + i) * GRID + wrapGrid(bz0 + j)
      ] as readonly number[];
      for (let k = 0; k < list.length; k++) visit(list[k] as number);
    }
  }
}

// --- Solid fallers: the one pose -------------------------------------------

const G = COLLAPSE_GRAVITY;
const HALF_PI = Math.PI / 2;

/** The angle sign that topples toward `dir` (collapse.ts rotate()). */
const toppleSign = (dir: number): number =>
  dir === DIR_POS_X ? -1 : dir === DIR_NEG_X ? 1 : dir === DIR_POS_Z ? 1 : -1;

/** A fallen span's tilt as it rests, rad (seeded sign). */
const spanTilt = (p: Prop): number => (p.seed < 0.5 ? -0.14 : 0.14);

/** Seconds from going down to rest. */
export function fallSeconds(p: Prop): number {
  if (p.kind === PROP_BRIDGE) return Math.sqrt((2 * (p.y - SPAN_REST_Y)) / G);
  const T = TOPPLE_S[p.kind] ?? 1.3;
  const pivotY = p.y - p.hy;
  const drop = Math.max(0, pivotY - p.landY);
  return T + Math.sqrt((2 * drop) / G);
}

/**
 * Faller `p`'s pose `tau` seconds after it went down, into `out`: x/z
 * relative to the prop's canonical (x, z), y absolute. Closed form and
 * allocation-free: standing before 0 (a render clock trails the message),
 * then a topple about its base edge toward `dir` (a span: a drop into the
 * river), a free-fall drop to the GENERATED surface it lands on, then rest.
 */
export function fallerPose(p: Prop, tau: number, out: PiecePose): PiecePose {
  out.hx = p.hx;
  out.hy = p.hy;
  out.hz = p.hz;
  if (p.kind === PROP_BRIDGE) {
    out.axis = 0;
    out.x = 0;
    out.z = 0;
    if (!(tau > 0)) {
      out.y = p.y;
      out.phi = 0;
      out.rest = false;
      return out;
    }
    const T = fallSeconds(p);
    const k = Math.min(1, tau / T);
    out.y = tau >= T ? SPAN_REST_Y : p.y - 0.5 * G * tau * tau;
    out.phi = spanTilt(p) * k;
    out.rest = tau >= T;
    return out;
  }
  const alongX = p.dir === DIR_POS_X || p.dir === DIR_NEG_X;
  out.axis = alongX ? 1 : 0;
  if (!(tau > 0)) {
    out.x = 0;
    out.y = p.y;
    out.z = 0;
    out.phi = 0;
    out.rest = false;
    return out;
  }
  const T = TOPPLE_S[p.kind] ?? 1.3;
  const sgn = toppleSign(p.dir);
  const ex = p.dir === DIR_POS_X ? p.hx : p.dir === DIR_NEG_X ? -p.hx : 0;
  const ez = p.dir === DIR_POS_Z ? p.hz : p.dir === DIR_NEG_Z ? -p.hz : 0;
  const pivotY = p.y - p.hy;
  const u = Math.min(1, tau / T);
  const phi = sgn * HALF_PI * u * u;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  // The centre relative to the pivot, rotated (collapse.ts rotate()).
  const rx = -ex;
  const ry = p.hy;
  const rz = -ez;
  let x: number;
  let y: number;
  let z: number;
  if (out.axis === 0) {
    x = rx;
    y = ry * c - rz * s;
    z = ry * s + rz * c;
  } else {
    x = rx * c - ry * s;
    y = rx * s + ry * c;
    z = rz;
  }
  out.x = ex + x;
  out.z = ez + z;
  out.phi = phi;
  out.rest = false;
  let yc = pivotY + y;
  if (tau >= T) {
    // Lying flat: its half extent along `dir` is now its half height.
    const thick = alongX ? p.hx : p.hz;
    const top = pivotY + thick;
    const rest = p.landY + thick;
    const drop = Math.max(0, top - rest);
    const dt = tau - T;
    const td = Math.sqrt((2 * drop) / G);
    if (dt >= td) {
      yc = rest;
      out.rest = true;
    } else {
      yc = top - 0.5 * G * dt * dt;
    }
  }
  out.y = yc;
  return out;
}

/** Plan-view reach of a faller's every pose from its centre, m, and its
 * altitude band — the per-faller reject before any trigonometry. */
function fallerBounds(p: Prop): { r: number; y0: number; y1: number } {
  if (p.kind === PROP_BRIDGE) {
    return {
      r: Math.hypot(p.hx, p.hz) + 2,
      y0: SPAN_REST_Y - p.hy - 3,
      y1: p.y + p.hy + 1,
    };
  }
  const big = Math.max(p.hx, p.hy, p.hz);
  return {
    r: Math.max(p.hx, p.hz) + 2 * big + 1,
    y0: Math.min(p.landY, p.y - p.hy) - 1,
    y1: p.y + p.hy + 1,
  };
}

// --- The state -------------------------------------------------------------

/** One prop going down: which and when (server ms). */
export interface PropDown {
  id: number;
  t: number;
}

/**
 * One room's prop state — server and client alike, like CityDamage: which
 * props are down and since when, the blasts that landed, their HP (the
 * server's), the chain link and credit of each (the server's), the open
 * bridge gaps and the solid fallers to collide with. Holds bare records
 * until bind() — a client's socket hears the welcome before the city is
 * built — then writes roof props through to the buildings.
 */
export class PropState {
  private layout: PropLayout | null = null;
  private buildings: readonly Building[] | null = null;
  private hpLeft = new Float32Array(0);
  /** Server ms the prop went down; NaN while it stands. */
  private downT = new Float64Array(0);
  /** Server ms its blast landed; NaN if none (yet). */
  private blastT = new Float64Array(0);
  private down = new Uint8Array(0);
  /** Chain link of whatever downed it (server). */
  private link = new Uint8Array(0);
  /** Rest-support cache: damage version checked, and the verdict. */
  private supVer = new Float64Array(0);
  private sup = new Uint8Array(0);
  /** Who downed it (server, for credit). */
  private readonly by = new Map<number, string | null>();
  private held: { id: number; t: number; te: number }[] = [];
  private pending: number[] = [];
  private roofMasks = new Map<number, number>();
  /** Solid fallers that are down, ascending ids. */
  readonly fallers: number[] = [];
  /** Bitmask of fallen bridge spans (bit i = bridge i) — river.ts gaps. */
  gapMask = 0;
  /** Props down. */
  downCount = 0;
  /** Bumped on every change. */
  version = 0;
  /** C2's gone-hold (server): while set, nothing more goes down. */
  hold = false;
  /** Downs left this tick (server; take() resets it). */
  private budget = PROP_DOWN_PER_TICK;

  /** Attach to the layout (and the city whose roofs it writes). */
  bind(layout: PropLayout, buildings: readonly Building[] | null): void {
    const n = layout.props.length;
    this.layout = layout;
    this.buildings = buildings;
    this.hpLeft = new Float32Array(n);
    this.downT = new Float64Array(n).fill(Number.NaN);
    this.blastT = new Float64Array(n).fill(Number.NaN);
    this.down = new Uint8Array(n);
    this.link = new Uint8Array(n);
    this.supVer = new Float64Array(n).fill(-1);
    this.sup = new Uint8Array(n);
    for (const p of layout.props) this.hpLeft[p.id] = p.hp;
    const held = this.held;
    this.held = [];
    this.clearEffects();
    for (const h of held) this.apply(h.id, h.t, h.te);
    this.version++;
  }

  get bound(): PropLayout | null {
    return this.layout;
  }

  isDown(id: number): boolean {
    return this.down[id] === 1;
  }

  /** When prop `id` went down (NaN while standing). */
  downAt(id: number): number {
    return this.downT[id] ?? Number.NaN;
  }

  /** When prop `id`'s blast landed (NaN: none, or not yet). */
  blastAt(id: number): number {
    return this.blastT[id] ?? Number.NaN;
  }

  hpOf(id: number): number {
    return this.down[id] ? 0 : (this.hpLeft[id] ?? 0);
  }

  depthOf(id: number): number {
    return this.link[id] ?? 0;
  }

  byOf(id: number): string | null {
    return this.by.get(id) ?? null;
  }

  /** The down props, ascending ids. */
  downIds(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.down.length; i++) if (this.down[i]) out.push(i);
    return out;
  }

  /**
   * Server: take `amount` off prop `id` (`depth` = the chain link of what
   * hit it, `by` = who to credit). True when that downed it — it joins this
   * tick's take(). Refused (held at 1 HP) at the per-tick and share caps and
   * under the gone-hold.
   */
  damage(
    id: number,
    amount: number,
    depth = 0,
    by: string | null = null,
  ): boolean {
    const layout = this.layout;
    if (!layout || this.down[id] || !(amount > 0)) return false;
    const p = layout.props[id];
    if (!p) return false;
    const left = (this.hpLeft[id] as number) - amount;
    if (left > 0) {
      this.hpLeft[id] = left;
      return false;
    }
    if (!this.mayGoDown()) {
      this.hpLeft[id] = 1;
      return false;
    }
    this.down[id] = 1;
    this.hpLeft[id] = 0;
    this.link[id] = Math.min(255, depth);
    this.by.set(id, by);
    this.pending.push(id);
    this.budget--;
    this.downCount++;
    return true;
  }

  /** Server: down `id` outright (a span's lamps, a crush) — the same caps. */
  knockDown(id: number, depth = 0, by: string | null = null): boolean {
    return this.damage(id, Number.POSITIVE_INFINITY, depth, by);
  }

  private mayGoDown(): boolean {
    const n = this.layout?.props.length ?? 0;
    return (
      !this.hold &&
      this.budget > 0 &&
      this.downCount < Math.floor(n * PROP_DOWN_CAP)
    );
  }

  /** Server: stamp this tick's downs at `now` (ascending ids) and open the
   * next tick's budget. */
  take(now: number): PropDown[] {
    const ids = this.pending.sort((a, b) => a - b);
    this.pending = [];
    this.budget = PROP_DOWN_PER_TICK;
    const out: PropDown[] = [];
    for (const id of ids) {
      this.downT[id] = now;
      this.effects(id, true);
      out.push({ id, t: now });
    }
    if (out.length > 0) this.version++;
    return out;
  }

  /** Server and client: a blast of prop `id` landed at `t`. */
  blasted(id: number, t: number): void {
    if (!this.layout) {
      const h = this.held.find((x) => x.id === id);
      if (h) h.te = t;
      return;
    }
    if (!this.down[id]) return;
    this.blastT[id] = t;
    this.version++;
  }

  /** Client (and replay): prop `id` went down at `t`; `te` its blast (−1 /
   * NaN: none yet). */
  apply(id: number, t: number, te = -1): void {
    const layout = this.layout;
    if (!layout) {
      if (!this.held.some((h) => h.id === id)) this.held.push({ id, t, te });
      return;
    }
    if (!layout.props[id] || this.down[id]) return;
    this.down[id] = 1;
    this.hpLeft[id] = 0;
    this.downT[id] = t;
    this.blastT[id] = te >= 0 ? te : Number.NaN;
    this.downCount++;
    this.effects(id, true);
    this.version++;
  }

  /** Prop `id` stands again (repair, rebuild). */
  restore(id: number): void {
    const layout = this.layout;
    if (!layout) {
      this.held = this.held.filter((h) => h.id !== id);
      return;
    }
    const p = layout.props[id];
    if (!p || !this.down[id]) return;
    this.down[id] = 0;
    this.hpLeft[id] = p.hp;
    this.downT[id] = Number.NaN;
    this.blastT[id] = Number.NaN;
    this.link[id] = 0;
    this.by.delete(id);
    this.downCount--;
    this.pending = this.pending.filter((x) => x !== id);
    this.effects(id, false);
    this.version++;
  }

  /** D5 rebuild of building `b`: its roof props and jumbotrons stand again.
   * Returns the restored ids. */
  restoreBuilding(b: number): number[] {
    const layout = this.layout;
    if (!layout) return [];
    const out: number[] = [];
    for (const id of layout.roofOf.get(b) ?? []) {
      if (this.down[id]) {
        this.restore(id);
        out.push(id);
      }
    }
    for (
      let id = layout.first[PROP_JUMBO] as number;
      id < (layout.first[PROP_BRIDGE] as number);
      id++
    ) {
      if (layout.props[id]?.b === b && this.down[id]) {
        this.restore(id);
        out.push(id);
      }
    }
    return out;
  }

  /** Make the down set exactly `downs` (a welcome, a room reset). */
  reset(downs: readonly { id: number; t: number; te?: number }[]): void {
    if (!this.layout) {
      this.held = downs.map((d) => ({ id: d.id, t: d.t, te: d.te ?? -1 }));
      return;
    }
    const layout = this.layout;
    for (const p of layout.props) this.hpLeft[p.id] = p.hp;
    this.down.fill(0);
    this.downT.fill(Number.NaN);
    this.blastT.fill(Number.NaN);
    this.link.fill(0);
    this.by.clear();
    this.pending = [];
    this.budget = PROP_DOWN_PER_TICK;
    this.downCount = 0;
    this.clearEffects();
    for (const d of downs) this.apply(d.id, d.t, d.te ?? -1);
    this.version++;
  }

  private clearEffects(): void {
    this.fallers.length = 0;
    this.gapMask = 0;
    const buildings = this.buildings;
    if (buildings) {
      for (const b of this.roofMasks.keys()) {
        const bd = buildings[b];
        if (bd) setRoofDown(bd, 0);
      }
    }
    this.roofMasks.clear();
  }

  /** What going down (or back up) changes beyond the arrays. */
  private effects(id: number, isDown: boolean): void {
    const p = (this.layout as PropLayout).props[id] as Prop;
    if (isFaller(p.kind)) {
      const at = this.fallers.indexOf(id);
      if (isDown && at < 0) {
        this.fallers.push(id);
        this.fallers.sort((a, b) => a - b);
      } else if (!isDown && at >= 0) this.fallers.splice(at, 1);
      this.supVer[id] = -1;
    }
    if (p.kind === PROP_BRIDGE) {
      const bit = 1 << p.ref;
      this.gapMask = isDown ? this.gapMask | bit : this.gapMask & ~bit;
    }
    if (isRoofProp(p.kind)) {
      const m = this.roofMasks.get(p.b) ?? 0;
      const next = isDown ? m | p.roof : m & ~p.roof;
      if (next) this.roofMasks.set(p.b, next);
      else this.roofMasks.delete(p.b);
      const b = this.buildings?.[p.b];
      if (b) setRoofDown(b, next);
    }
  }

  /** Re-write every roof mask through (after CityDamage replaced records). */
  syncRoofs(): void {
    const buildings = this.buildings;
    if (!buildings) return;
    for (const [b, m] of this.roofMasks) {
      const bd = buildings[b];
      if (bd) setRoofDown(bd, m);
    }
  }

  /**
   * Does faller `id` still lie where it came to rest? A roof prop or a
   * podium-landed jumbotron whose deck no longer stands (pure in the shared
   * damage) is gone from drawing and collision — nothing floats (D8).
   * Cached on its building's damage version.
   */
  restSupported(id: number, pose: PiecePose): boolean {
    const p = this.layout?.props[id];
    if (!p || p.landY <= 0.01 || p.kind === PROP_BRIDGE) return true;
    const b = this.buildings?.[p.b];
    if (!b) return true;
    const ver = b.damage?.version ?? 0;
    if (this.supVer[id] === ver) return this.sup[id] === 1;
    const lx = wrapDeltaAxis(b.x, p.x) + pose.x;
    const lz = wrapDeltaAxis(b.z, p.z) + pose.z;
    const ok = pointStands(b, lx, p.landY - 0.5, lz);
    this.supVer[id] = ver;
    this.sup[id] = ok ? 1 : 0;
    return ok;
  }
}

/** A room's props for the movers (MoverField.props): layout + state. */
export interface PropSlot {
  readonly layout: PropLayout;
  readonly state: PropState;
}

/** A slot over `layout` with a fresh state bound to `buildings`. */
export function propSlot(
  layout: PropLayout,
  buildings: readonly Building[] | null,
): PropSlot {
  const state = new PropState();
  state.bind(layout, buildings);
  return { layout, state };
}

/** Fallen bridge spans of a mover field's props (0 when it has none) — the
 * `gaps` argument of riverHit / hitsGround / losClear. */
export const gapsOf = (field: { props?: PropSlot } | undefined): number =>
  field?.props?.state.gapMask ?? 0;

/** collideProps' pose scratch. A literal, not blankPose(): collapse.ts ↔
 * movers.ts ↔ this module is an import cycle, so nothing imported may run at
 * module evaluation. */
const scratchPose: PiecePose = {
  x: 0,
  y: 0,
  z: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  axis: 0,
  phi: 0,
  rest: false,
};

/**
 * Faller `id`'s pose at server time `tMs` — or null when it is no longer
 * there (its rest deck gone). The ONE pose the renderer draws and every
 * collider tests.
 */
export function propPieceInto(
  slot: PropSlot,
  id: number,
  tMs: number,
  out: PiecePose,
): PiecePose | null {
  const p = slot.layout.props[id] as Prop;
  const tau = (tMs - slot.state.downAt(id)) / 1000;
  fallerPose(p, Number.isFinite(tau) ? tau : Number.POSITIVE_INFINITY, out);
  if (out.rest && !slot.state.restSupported(id, out)) return null;
  return out;
}

/** What a prop collision reports. Allocated only on a hit. */
export interface PropHit {
  id: number;
  /** Still moving (or about to): falling, not at rest. */
  falling: boolean;
}

/**
 * The first fallen prop a sphere at `pos` touches at server time `tMs`, or
 * null. Walks only the down solid fallers, each behind a plan/altitude
 * reject; allocation-free on a miss. `tMs = Infinity` tests the rest state;
 * `fallingOnly` skips pieces at rest (kill credit).
 */
export function collideProps(
  pos: Vec3,
  radius: number,
  slot: PropSlot,
  tMs: number,
  fallingOnly = false,
): PropHit | null {
  const list = slot.state.fallers;
  for (let i = 0; i < list.length; i++) {
    const id = list[i] as number;
    const p = slot.layout.props[id] as Prop;
    const dx = wrapDeltaAxis(p.x, pos.x);
    const dz = wrapDeltaAxis(p.z, pos.z);
    const bnd = boundsOf(p);
    if (Math.abs(dx) > bnd.r + radius || Math.abs(dz) > bnd.r + radius)
      continue;
    if (pos.y + radius < bnd.y0 || pos.y - radius > bnd.y1) continue;
    const pose = propPieceInto(slot, id, tMs, scratchPose);
    if (!pose || (fallingOnly && pose.rest)) continue;
    if (
      sphereHitsPiece(pose, dx - pose.x, pos.y - pose.y, dz - pose.z, radius)
    ) {
      return { id, falling: !pose.rest };
    }
  }
  return null;
}

const boundsCache = new WeakMap<Prop, { r: number; y0: number; y1: number }>();
function boundsOf(p: Prop): { r: number; y0: number; y1: number } {
  let b = boundsCache.get(p);
  if (!b) {
    b = fallerBounds(p);
    boundsCache.set(p, b);
  }
  return b;
}

// --- Rays --------------------------------------------------------------------

/** Kinds a bullet ray can hit directly (roof props are hit through
 * raycastChunk's roof structures, RayHit.roof). */
const RAYABLE = (kind: number): boolean => !isRoofProp(kind);

/** Slab-clip entry of the ray (origin `o`, unit `d`) into an AABB given by
 * its centre offset (cx, cy, cz) from the origin and half extents; −1 on a
 * miss within [0, range]. */
function rayEntry(
  d: Vec3,
  range: number,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
): number {
  let t0 = 0;
  let t1 = range;
  for (let axis = 0; axis < 3; axis++) {
    const dv = axis === 0 ? d.x : axis === 1 ? d.y : d.z;
    const c = axis === 0 ? cx : axis === 1 ? cy : cz;
    const h = axis === 0 ? hx : axis === 1 ? hy : hz;
    const lo = c - h;
    const hi = c + h;
    if (dv === 0) {
      if (lo > 0 || hi < 0) return -1;
      continue;
    }
    const a = lo / dv;
    const b = hi / dv;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return -1;
  }
  return t1 <= 1e-6 ? -1 : t0;
}

/** The first standing prop a ray from `from` along unit `dir` meets within
 * `range` (torus-correct), or null. */
export function raycastProps(
  slot: PropSlot,
  from: Vec3,
  dir: Vec3,
  range: number,
): { id: number; t: number } | null {
  let best = -1;
  let bestT = range;
  const mx = from.x + (dir.x * range) / 2;
  const mz = from.z + (dir.z * range) / 2;
  const half = (Math.max(Math.abs(dir.x), Math.abs(dir.z)) * range) / 2;
  propsNear(slot.layout, mx, mz, half, (id) => {
    if (slot.state.isDown(id)) return;
    const p = slot.layout.props[id] as Prop;
    if (!RAYABLE(p.kind)) return;
    const t = rayEntry(
      dir,
      bestT,
      wrapDeltaAxis(from.x, p.x),
      p.y - from.y,
      wrapDeltaAxis(from.z, p.z),
      p.hx,
      p.hy,
      p.hz,
    );
    if (t >= 0 && t < bestT) {
      bestT = t;
      best = id;
    }
  });
  return best < 0 ? null : { id: best, t: bestT };
}

// --- Chains --------------------------------------------------------------------

/** One prop crushed by falling debris: which, and when (server ms). */
export interface PropCrush {
  id: number;
  t: number;
}

/**
 * D9: the standing props under collapse `c`'s rest boxes, each crushed at
 * the instant its piece lands (pure in the event and the layout). Ascending
 * time, then id; a prop once.
 */
export function collapseCrushes(c: Collapse, layout: PropLayout): PropCrush[] {
  const found = new Map<number, number>();
  for (let i = 0; i < c.n; i++) {
    const cx = wrapCoord(c.x + (c.rx[i] as number));
    const cz = wrapCoord(c.z + (c.rz[i] as number));
    const ax = c.ax[i] as number;
    const ay = c.ay[i] as number;
    const az = c.az[i] as number;
    const cy = c.ry[i] as number;
    const t = c.t0 + ((c.start[i] as number) + (c.land[i] as number)) * 1000;
    propsNear(layout, cx, cz, Math.max(ax, az), (id) => {
      const p = layout.props[id] as Prop;
      if (p.kind === PROP_BRIDGE || p.kind === PROP_CRANE) return;
      if (
        Math.abs(wrapDeltaAxis(cx, p.x)) < ax + p.hx &&
        Math.abs(wrapDeltaAxis(cz, p.z)) < az + p.hz &&
        Math.abs(cy - p.y) < ay + p.hy
      ) {
        const was = found.get(id);
        if (was === undefined || t < was) found.set(id, t);
      }
    });
  }
  return [...found]
    .map(([id, t]) => ({ id, t }))
    .sort((a, b) => a.t - b.t || a.id - b.id);
}

/** The standing props under faller `id`'s rest box (pure). */
export function fallerCrushes(layout: PropLayout, id: number): number[] {
  const p = layout.props[id] as Prop;
  const pose = fallerPose(p, Number.POSITIVE_INFINITY, blankPose());
  const cx = wrapCoord(p.x + pose.x);
  const cz = wrapCoord(p.z + pose.z);
  // The rest box as a world AABB (it lies at a quarter turn, or nearly).
  const lying = p.kind !== PROP_BRIDGE;
  const alongX = p.dir === DIR_POS_X || p.dir === DIR_NEG_X;
  const ax = lying && alongX ? p.hy : p.hx;
  const az = lying && !alongX ? p.hy : p.hz;
  const ay = lying ? (alongX ? p.hx : p.hz) : p.hy + 1;
  const out: number[] = [];
  propsNear(layout, cx, cz, Math.max(ax, az), (q) => {
    if (q === id) return;
    const o = layout.props[q] as Prop;
    if (o.kind === PROP_BRIDGE || o.kind === PROP_CRANE) return;
    if (
      Math.abs(wrapDeltaAxis(cx, o.x)) < ax + o.hx &&
      Math.abs(wrapDeltaAxis(cz, o.z)) < az + o.hz &&
      Math.abs(pose.y - o.y) < ay + o.hy
    ) {
      out.push(q);
    }
  });
  return out.sort((a, b) => a - b);
}

/** Where faller `id` lands (canonical point on its landing surface). */
export function fallerLanding(layout: PropLayout, id: number): Vec3 {
  const p = layout.props[id] as Prop;
  const pose = fallerPose(p, Number.POSITIVE_INFINITY, blankPose());
  return { x: wrapCoord(p.x + pose.x), y: p.landY, z: wrapCoord(p.z + pose.z) };
}

/**
 * D9 fire jumps: the standing chunks of OTHER buildings within FIRE_JUMP_M
 * of chunk `id`'s box (plan view) in an overlapping floor band, ascending
 * ids, into `out`. Pure in the city's shape and damage.
 */
export function fireJumpTargets(
  buildings: readonly Building[],
  id: number,
  out: number[],
): number[] {
  out.length = 0;
  const bi = chunkBuilding(id);
  const b = buildings[bi];
  const g0 = b && tierGrids(b)[chunkTier(id)];
  if (!b || !g0) return out;
  const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  cellBox(g0, chunkCell(id), box);
  // The chunk in world terms (canonical centre, half extents).
  const wx = wrapCoord(b.x + (box.x0 + box.x1) / 2);
  const wz = wrapCoord(b.z + (box.z0 + box.z1) / 2);
  const hx = (box.x1 - box.x0) / 2;
  const hz = (box.z1 - box.z0) / 2;
  const y0 = box.y0;
  const y1 = box.y1;
  const cell: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  for (let i = 0; i < buildings.length; i++) {
    if (i === bi) continue;
    const o = buildings[i] as Building;
    const dx = wrapDeltaAxis(wx, o.x);
    const dz = wrapDeltaAxis(wz, o.z);
    if (Math.abs(dx) > o.width / 2 + hx + FIRE_JUMP_M) continue;
    if (Math.abs(dz) > o.depth / 2 + hz + FIRE_JUMP_M) continue;
    const grids = tierGrids(o);
    const masks = chunkMask(o);
    const cells = o.damage?.cells;
    for (let k = 0; k < grids.length; k++) {
      const g = grids[k] as (typeof grids)[number];
      if (g.baseY > y1 || g.baseY + g.height < y0) continue;
      const mask = masks[k] as Uint8Array;
      const iy0 = Math.max(0, Math.floor((y0 - g.baseY) / g.ch));
      const iy1 = Math.min(g.ny - 1, Math.floor((y1 - 1e-6 - g.baseY) / g.ch));
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = 0; iz < g.nz; iz++) {
          for (let ix = 0; ix < g.nx; ix++) {
            const c = cellIndex(g, ix, iy, iz);
            if (!mask[c] || cells?.[k]?.[c]) continue;
            cellBox(g, c, cell);
            // Gap between the two boxes in plan view.
            const ox = Math.abs(dx + (cell.x0 + cell.x1) / 2);
            const oz = Math.abs(dz + (cell.z0 + cell.z1) / 2);
            const gx = Math.max(0, ox - hx - (cell.x1 - cell.x0) / 2);
            const gz = Math.max(0, oz - hz - (cell.z1 - cell.z0) / 2);
            if (Math.hypot(gx, gz) <= FIRE_JUMP_M) out.push(chunkId(i, k, c));
          }
        }
      }
    }
  }
  return out.sort((a, c) => a - c);
}

/** A burning chunk tries to jump to a neighbouring building this often,
 * per spread tick. */
export const FIRE_JUMP_P = 0.2;
const jumpScratch: number[] = [];

/**
 * D9: where (if anywhere) the fire on chunk `id` jumps this spread tick: a
 * fireJumpTargets chunk of a building that is ALREADY damaged (fire spreads
 * between damaged buildings, it does not start in a whole one), or −1.
 * Draws from `rand` the same way whatever the city holds (one roll, then
 * one pick when there are targets).
 */
export function pickFireJump(
  buildings: readonly Building[],
  id: number,
  rand: () => number,
): number {
  if (rand() >= FIRE_JUMP_P) return -1;
  const all = fireJumpTargets(buildings, id, jumpScratch);
  let n = 0;
  for (const c of all) {
    if (buildings[chunkBuilding(c)]?.damage !== undefined) all[n++] = c;
  }
  all.length = n;
  if (n === 0) return -1;
  return all[Math.floor(rand() * n)] as number;
}

// --- Craters -------------------------------------------------------------------

/** A blast's scar in a street: a crater, and maybe a burst water main. */
export interface Crater {
  id: number;
  x: number;
  z: number;
  r: number;
  t: number;
  /** A water main burst under it (sprays until it is repaired). */
  water: boolean;
}

/** Does a blast at `pos` with radius `r` leave a crater? Its radius, else 0. */
export function craterRadius(pos: Vec3, r: number): number {
  if (pos.y > CRATER_MAX_Y || pos.y < -1) return 0;
  if (!isInRoadway(pos) || overChannel(pos.z)) return 0;
  if (inPortalCut(pos.x, pos.z, 2)) return 0;
  return Math.round(Math.min(7, Math.max(2.5, r * 0.35)) * 10) / 10;
}

/** Does the crater at (x, z) burst a water main? Seeded by its 4 m cell. */
export function craterWater(seed: number, x: number, z: number): boolean {
  const cx = Math.floor(wrapCoord(x) / 4);
  const cz = Math.floor(wrapCoord(z) / 4);
  return (
    mulberry32(
      (seed ^
        Math.imul(cx + 1, 73856093) ^
        Math.imul(cz + 1, 19349663) ^
        0x3a7e5) >>>
        0,
    )() < 0.5
  );
}

// --- Wire ----------------------------------------------------------------------

/** A crater on the wire: [id, x ×10, z ×10, r ×10, t, water 0 | 1]. */
export type WireCrater = [
  id: number,
  x: number,
  z: number,
  r: number,
  t: number,
  water: number,
];

export const encodeCrater = (c: Crater): WireCrater => [
  c.id,
  Math.round(c.x * 10),
  Math.round(c.z * 10),
  Math.round(c.r * 10),
  Math.round(c.t),
  c.water ? 1 : 0,
];

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

export function decodeCrater(w: unknown): Crater | null {
  if (!Array.isArray(w) || w.length !== 6 || !w.every(finite)) return null;
  const [id, x, z, r, t, water] = w as number[];
  if (!Number.isInteger(id) || !((r as number) > 0)) return null;
  return {
    id: id as number,
    x: wrapCoord((x as number) / 10),
    z: wrapCoord((z as number) / 10),
    r: (r as number) / 10,
    t: t as number,
    water: water === 1,
  };
}

/**
 * Ascending (id, value…) records as a flat list: `width` numbers each, the
 * id delta-encoded from the previous record's (the first absolute), the
 * values as given (integers on the wire: times are rounded).
 */
export function encodeIdRecords(
  records: readonly (readonly number[])[],
  width: number,
): number[] {
  const sorted = [...records].sort(
    (a, b) => (a[0] as number) - (b[0] as number),
  );
  const out: number[] = [];
  let prev = 0;
  sorted.forEach((r, i) => {
    const id = r[0] as number;
    out.push(i === 0 ? id : id - prev);
    for (let k = 1; k < width; k++) out.push(Math.round(r[k] ?? 0));
    prev = id;
  });
  return out;
}

/** Inverse of encodeIdRecords; anything malformed (a non-integer, a
 * negative or zero gap after the first, a ragged length) decodes to []. */
export function decodeIdRecords(wire: unknown, width: number): number[][] {
  if (!Array.isArray(wire) || wire.length % width !== 0) return [];
  const out: number[][] = [];
  let id = 0;
  for (let i = 0; i < wire.length; i += width) {
    const d = wire[i];
    if (typeof d !== "number" || !Number.isInteger(d)) return [];
    if (i === 0 ? d < 0 : d <= 0) return [];
    id = i === 0 ? d : id + d;
    const rec = [id];
    for (let k = 1; k < width; k++) {
      const v = wire[i + k];
      if (!finite(v)) return [];
      rec.push(v);
    }
    out.push(rec);
  }
  return out;
}

/** The welcome's D9 state. */
export interface WirePropState {
  /** Down props: [idΔ, t, te] triples (te: its blast instant, −1 none yet). */
  d: number[];
  c: WireCrater[];
  /** Chunks that burned since their building last rebuilt (encodeChunkIds). */
  s: number[];
}
