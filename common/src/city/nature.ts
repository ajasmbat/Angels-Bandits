// Nature in the dead space (N1), shared verbatim by client and server — the
// city's empty ground dressed as night parks, landmark forecourts, street
// trees and construction hoardings. One pure seam feeds both the renderer
// and collision, so a tree is drawn exactly where it is solid.
//
// TWO HALVES, DELIBERATELY:
//   - LAYOUT is seed-free: the pond, the paths, the park lamps, the forecourt
//     rows / lawn panels / planters and the hoardings are the exported
//     constants below. The client's ground shader paints from these same
//     exports, so a lamp pool always sits under its lamp and a path never
//     runs under a trunk.
//   - TREES are seeded — presence, jitter and size — from this module's own
//     salted per-block mulberry32 stream. Never from generateCity's lot
//     stream: drawing there would shift every lot of the seed-42 city.
//
// The flight-band rule (constants.ts, L2): anything that LOOKS solid in the
// flight band IS solid. Park and forecourt trees are collidable; street trees,
// park lamps, planters and hoardings stay under STREET_TREE_MAX_HEIGHT (the
// lamp-pole height) and are the sanctioned no-collision dressing.
//
// ONE derivation of a tree's volume: treeBoxes(). The renderer scales its
// instances from it and collision (common/src/collision.ts) indexes it, so
// the drawn bounds and the solid bounds cannot drift apart. Foliage detail
// lives INSIDE the canopy box — the canopy is drawn as the ellipsoid
// inscribed in it, and that ellipsoid is what collides.

import {
  BLOCK_PITCH,
  CROSSWALK_DEPTH,
  FORECOURT_TREE_HEIGHT_MAX,
  FORECOURT_TREE_HEIGHT_MIN,
  LANDMARK_FOOTPRINT,
  PARK_TREE_HEIGHT_MAX,
  PARK_TREE_HEIGHT_MIN,
  STREET_TREE_CANOPY_MAX,
  STREET_TREE_CANOPY_MIN,
  STREET_TREE_MAX_HEIGHT,
  STREET_TREE_TRUNK_MAX,
  STREET_TREE_TRUNK_MIN,
} from "../constants";
import { canonicalize, wrapDeltaAxis } from "../world/index";
import { type Building, CITY_GRID, mulberry32 } from "./index";
import { CONSTRUCTION_BLOCKS, LANDMARK_BLOCKS, PLAZA_BLOCKS } from "./layout";
import { isRiverRow, overChannel } from "./river";
import {
  FURNITURE_LINE,
  INTERSECTION_HALF,
  LAMP_STATIONS_MINUS,
  LAMP_STATIONS_PLUS,
  LOT_LINE,
  isInRoadway,
} from "./street";

// --- Seed-free layout ------------------------------------------------------
// Park and forecourt offsets are LOCAL: meters from the block's centre, so
// one set of numbers dresses every park (and the shader paints it with
// mod(world, BLOCK_PITCH) − BLOCK_PITCH / 2).

/** Half-side of a park's lawn, m from the block centre. The sidewalk paint
 * runs 8 m past the curb (23 m off the centerline), so the lawn starts there. */
export const PARK_LAWN_HALF = BLOCK_PITCH / 2 - LOT_LINE - 3;
/** The pond: a circle at the park's centre, m. */
export const PARK_POND_RADIUS = 24;
/** Lit stone rim around the pond, m wide. */
export const PARK_POND_RIM = 1.6;
/** Ring path around the pond: centreline radius and half-width of every
 * park path (the ring and the two axial paths through the centre), m. */
export const PARK_RING_RADIUS = 58;
export const PARK_PATH_HALF = 2.5;
/** Park lamps: count, angular phase (off the axial paths), the radius they
 * stand at (just outside the ring path) and their height, m. */
export const PARK_LAMP_COUNT = 8;
export const PARK_LAMP_PHASE = Math.PI / PARK_LAMP_COUNT;
export const PARK_LAMP_RADIUS = PARK_RING_RADIUS + PARK_PATH_HALF + 0.8;
export const PARK_LAMP_HEIGHT = 4.5;

/** Landmark forecourt tree rows, m from the block centre (32 m in from the
 * block edge: between the sidewalk and the 90 m podium), and their spacing. */
export const FORECOURT_ROW = 68;
export const FORECOURT_ROW_STEP = 13.6;
/** Half-width of the entrance approach on each axis, m — no lawn, no tree. */
export const FORECOURT_GATE_HALF = 9;
/** Lawn panels: the band between these offsets from the centre, m, outside
 * the entrance approach. The podium face sits at LANDMARK_FOOTPRINT / 2. */
export const FORECOURT_LAWN_INNER = LANDMARK_FOOTPRINT / 2 + 5;
export const FORECOURT_LAWN_OUTER = 63;
/** Planters flank each entrance at the head of the lawn panels. */
const PLANTER_OFFSET = (FORECOURT_LAWN_INNER + FORECOURT_LAWN_OUTER) / 2;
const PLANTER_HALF = 1.2;
const PLANTER_HEIGHT = 0.9;

/** Hoardings stand this far off the street centerline, m: just inside the
 * lot line, behind the welders' pavement band and well clear of the crane
 * mast (CRANE_MAST_INSET 28 m in). */
export const HOARDING_LINE = LOT_LINE + 0.5;
const HOARDING_HEIGHT = 2.6;
const HOARDING_THICKNESS = 0.3;
/** Site-access gap in the middle of every hoarding side, m. */
const HOARDING_GATE = 12;

/** How much of the canopy the trunk box reaches into, as a canopy fraction —
 * so the drawn trunk meets the crown instead of touching its lowest point. */
const TRUNK_INTO_CANOPY = 0.3;

// --- Ground kinds (the shader's block table) --------------------------------

export const GROUND_NONE = 0;
export const GROUND_PARK = 1;
export const GROUND_FORECOURT = 2;
export const GROUND_SITE = 3;
/** L11: the river row — promenade paving out to the channel (city/river.ts). */
export const GROUND_RIVER = 4;

const blockKey = (bx: number, bz: number) => bx * CITY_GRID + bz;
const PARKS = new Set(PLAZA_BLOCKS.map(([bx, bz]) => blockKey(bx, bz)));
const FORECOURTS = new Set(LANDMARK_BLOCKS.map(([bx, bz]) => blockKey(bx, bz)));
const SITES = new Set(CONSTRUCTION_BLOCKS.map(([bx, bz]) => blockKey(bx, bz)));

/** What block (bx, bz)'s interior is painted as. Seed-free: the hand-placed
 * block lists alone decide it, so the shader can bake it as a constant. */
export function blockGroundKind(bx: number, bz: number): number {
  const key = blockKey(
    ((bx % CITY_GRID) + CITY_GRID) % CITY_GRID,
    ((bz % CITY_GRID) + CITY_GRID) % CITY_GRID,
  );
  if (PARKS.has(key)) return GROUND_PARK;
  if (FORECOURTS.has(key)) return GROUND_FORECOURT;
  if (SITES.has(key)) return GROUND_SITE;
  if (isRiverRow(bz)) return GROUND_RIVER;
  return GROUND_NONE;
}

// --- Types ------------------------------------------------------------------

export type TreeKind = "park" | "forecourt" | "street";

/** One tree. (x, z) is the trunk centre, canonical; heights are m above the
 * ground; the crown sits on top of the clear trunk. */
export interface Tree {
  x: number;
  z: number;
  /** Clear trunk height — the crown's underside, m. */
  trunkH: number;
  /** Trunk half-side, m (the trunk is a square post). */
  trunkR: number;
  /** Crown horizontal radius and full height, m. */
  canopyR: number;
  canopyH: number;
  kind: TreeKind;
}

/** An axis-aligned box: canonical centre (x, z), half-extents, and vertical
 * span [y0, y1]. */
export interface NatureBox {
  x: number;
  z: number;
  hx: number;
  hz: number;
  y0: number;
  y1: number;
}

export interface TreeBoxes {
  trunk: NatureBox;
  /** The crown's box. What is drawn AND what collides is the ellipsoid
   * inscribed in it; the box is its bounds. */
  canopy: NatureBox;
}

/** The ONE derivation of a tree's volume — see the header. */
export function treeBoxes(t: Tree): TreeBoxes {
  return {
    trunk: {
      x: t.x,
      z: t.z,
      hx: t.trunkR,
      hz: t.trunkR,
      y0: 0,
      y1: t.trunkH + t.canopyH * TRUNK_INTO_CANOPY,
    },
    canopy: {
      x: t.x,
      z: t.z,
      hx: t.canopyR,
      hz: t.canopyR,
      y0: t.trunkH,
      y1: t.trunkH + t.canopyH,
    },
  };
}

/** Whether a tree is solid. Street trees are the lamp-pole exception: they
 * never top STREET_TREE_MAX_HEIGHT, below every flight band. */
export const treeCollides = (t: Tree): boolean => t.kind !== "street";

export interface Pond {
  x: number;
  z: number;
  radius: number;
}

export interface ParkLamp {
  x: number;
  z: number;
  height: number;
}

/** A square stone planter with a shrub in it (dressing, never solid). */
export interface Planter {
  x: number;
  z: number;
  half: number;
  height: number;
}

/** One straight run of construction hoarding (dressing, never solid). */
export interface Hoarding {
  x: number;
  z: number;
  hx: number;
  hz: number;
  height: number;
}

/** Everything N1 puts on the ground, for one seed. Build once and reuse. */
export interface Nature {
  trees: Tree[];
  ponds: Pond[];
  lamps: ParkLamp[];
  planters: Planter[];
  hoardings: Hoarding[];
}

// --- Seeded trees -----------------------------------------------------------

/** Salt that keeps every nature stream independent of the C1 lot stream and
 * of the client's streetlife tags, which use the same spatial hash. */
const NATURE_SALT = 0x6e617475;
const TAG_PARK = 1;
const TAG_FORECOURT = 2;
const TAG_STREET = 3;

/** This module's per-block stream, in the house spatial-hash style. Depends
 * only on (seed, block, tag), never on iteration order. */
const natureStream = (seed: number, bx: number, bz: number, tag: number) =>
  mulberry32(
    (seed ^
      NATURE_SALT ^
      Math.imul(bx + 1, 73856093) ^
      Math.imul(bz + 1, 19349663) ^
      Math.imul(tag, 0x85ebca6b)) >>>
      0,
  );

const canon = (x: number, z: number) => canonicalize({ x, y: 0, z });

/** Buildings bucketed by the block their centre sits in. */
function bucketBuildings(
  buildings: readonly Building[],
): Map<number, Building[]> {
  const out = new Map<number, Building[]>();
  for (const b of buildings) {
    const c = canon(b.x, b.z);
    const key = blockKey(
      Math.floor(c.x / BLOCK_PITCH) % CITY_GRID,
      Math.floor(c.z / BLOCK_PITCH) % CITY_GRID,
    );
    const bucket = out.get(key);
    if (bucket) bucket.push(b);
    else out.set(key, [b]);
  }
  return out;
}

/** True when the tree's widest horizontal extent overlaps any building's
 * tier-1 footprint (which bounds the whole tier stack), with a little air. */
function overlapsBuilding(t: Tree, byBlock: Map<number, Building[]>): boolean {
  const reach = Math.max(t.canopyR, t.trunkR) + 0.5;
  const bx = Math.floor(t.x / BLOCK_PITCH);
  const bz = Math.floor(t.z / BLOCK_PITCH);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const key = blockKey(
        (((bx + i) % CITY_GRID) + CITY_GRID) % CITY_GRID,
        (((bz + j) % CITY_GRID) + CITY_GRID) % CITY_GRID,
      );
      for (const b of byBlock.get(key) ?? []) {
        if (
          Math.abs(wrapDeltaAxis(b.x, t.x)) < b.width / 2 + reach &&
          Math.abs(wrapDeltaAxis(b.z, t.z)) < b.depth / 2 + reach
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Park lamp positions, local to the block centre. */
function parkLampLocal(k: number): { lx: number; lz: number } {
  const a = PARK_LAMP_PHASE + (k * 2 * Math.PI) / PARK_LAMP_COUNT;
  return {
    lx: Math.cos(a) * PARK_LAMP_RADIUS,
    lz: Math.sin(a) * PARK_LAMP_RADIUS,
  };
}

/** Clusters of trees on a park's lawn — off the paths, the pond and the
 * lamps, crowns inside the lawn. */
function parkTrees(seed: number, bx: number, bz: number, out: Tree[]): void {
  const rand = natureStream(seed, bx, bz, TAG_PARK);
  const cx = bx * BLOCK_PITCH + BLOCK_PITCH / 2;
  const cz = bz * BLOCK_PITCH + BLOCK_PITCH / 2;
  const placed: { lx: number; lz: number; r: number }[] = [];
  const clusters = 8;
  for (let c = 0; c < clusters; c++) {
    const ccx = (rand() * 2 - 1) * (PARK_LAWN_HALF - 8);
    const ccz = (rand() * 2 - 1) * (PARK_LAWN_HALF - 8);
    const count = 3 + Math.floor(rand() * 4);
    let accepted = 0;
    for (let n = 0; n < count * 3 && accepted < count; n++) {
      // Every candidate draws the same number of randoms, accepted or not.
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * 15;
      const h =
        PARK_TREE_HEIGHT_MIN +
        rand() * (PARK_TREE_HEIGHT_MAX - PARK_TREE_HEIGHT_MIN);
      const canopyH = h * (0.55 + 0.15 * rand());
      const canopyR = Math.min(
        5.5,
        Math.max(2.4, canopyH * (0.38 + 0.2 * rand())),
      );
      const trunkR = 0.22 + 0.025 * h;
      const lx = ccx + Math.cos(a) * d;
      const lz = ccz + Math.sin(a) * d;
      if (!parkSpotFree(lx, lz, canopyR, trunkR, placed)) continue;
      placed.push({ lx, lz, r: canopyR });
      accepted++;
      const p = canon(cx + lx, cz + lz);
      out.push({
        x: p.x,
        z: p.z,
        trunkH: h - canopyH,
        trunkR,
        canopyR,
        canopyH,
        kind: "park",
      });
    }
  }
}

/** Is a park tree at local (lx, lz) clear of everything it must avoid? */
function parkSpotFree(
  lx: number,
  lz: number,
  canopyR: number,
  trunkR: number,
  placed: readonly { lx: number; lz: number; r: number }[],
): boolean {
  // Crown inside the lawn: never oversails the sidewalk ring.
  const edge = PARK_LAWN_HALF - 1;
  if (Math.abs(lx) + canopyR > edge || Math.abs(lz) + canopyR > edge) {
    return false;
  }
  // Crown clear of the pond and its rim.
  const r = Math.hypot(lx, lz);
  if (r < PARK_POND_RADIUS + PARK_POND_RIM + canopyR + 1.5) return false;
  // Trunk off every path.
  const pathClear = PARK_PATH_HALF + trunkR + 1;
  if (Math.abs(lx) < pathClear || Math.abs(lz) < pathClear) return false;
  if (Math.abs(r - PARK_RING_RADIUS) < pathClear) return false;
  // Crown clear of the lamp heads.
  for (let k = 0; k < PARK_LAMP_COUNT; k++) {
    const l = parkLampLocal(k);
    if (Math.hypot(lx - l.lx, lz - l.lz) < canopyR + 1.5) return false;
  }
  // Crowns may touch within a cluster, never stack.
  for (const p of placed) {
    if (Math.hypot(lx - p.lx, lz - p.lz) < 0.85 * (canopyR + p.r)) {
      return false;
    }
  }
  return true;
}

/** Formal rows around a landmark's podium: one species per forecourt, so
 * only a small seeded variation in size. */
function forecourtTrees(
  seed: number,
  bx: number,
  bz: number,
  out: Tree[],
): void {
  const rand = natureStream(seed, bx, bz, TAG_FORECOURT);
  const cx = bx * BLOCK_PITCH + BLOCK_PITCH / 2;
  const cz = bz * BLOCK_PITCH + BLOCK_PITCH / 2;
  const h0 =
    FORECOURT_TREE_HEIGHT_MIN +
    rand() * (FORECOURT_TREE_HEIGHT_MAX - FORECOURT_TREE_HEIGHT_MIN - 1);
  const steps = Math.round((2 * FORECOURT_ROW) / FORECOURT_ROW_STEP);
  for (const side of [0, 1, 2, 3]) {
    for (let k = 0; k <= steps; k++) {
      const along = -FORECOURT_ROW + k * FORECOURT_ROW_STEP;
      const h = h0 + rand();
      const canopyH = h * 0.6;
      const canopyR = 2.8 + rand() * 0.6;
      // The z-rows skip their ends: the x-rows already own the corners.
      if (side >= 2 && Math.abs(along) > FORECOURT_ROW - 1) continue;
      if (Math.abs(along) < FORECOURT_GATE_HALF + canopyR) continue;
      const off = side % 2 === 0 ? -FORECOURT_ROW : FORECOURT_ROW;
      const lx = side < 2 ? off : along;
      const lz = side < 2 ? along : off;
      const p = canon(cx + lx, cz + lz);
      out.push({
        x: p.x,
        z: p.z,
        trunkH: h - canopyH,
        trunkR: 0.3,
        canopyR,
        canopyH,
        kind: "forecourt",
      });
    }
  }
}

/**
 * Street trees in tree pits on the furniture line, midway between two
 * consecutive lamps of the SAME segment (never across a corner), and never
 * within INTERSECTION_HALF + CROSSWALK_DEPTH of one. Like the lamps, each
 * block dresses its own west and south street lines, both sides, so every
 * street is covered exactly once across the torus wrap. A side whose
 * sidewalk belongs to a construction block is left to the hoarding.
 */
function streetTrees(seed: number, out: Tree[]): void {
  const mids = (stations: readonly number[]) => {
    const s = [...stations].sort((a, b) => a - b);
    const m: number[] = [];
    for (let i = 1; i < s.length; i++) {
      m.push(((s[i - 1] as number) + (s[i] as number)) / 2);
    }
    const clear = INTERSECTION_HALF + CROSSWALK_DEPTH + STREET_TREE_CANOPY_MAX;
    return m.filter((a) => a >= clear && a <= BLOCK_PITCH - clear);
  };
  const plus = mids(LAMP_STATIONS_PLUS);
  const minus = mids(LAMP_STATIONS_MINUS);
  const wrap = (v: number) => ((v % CITY_GRID) + CITY_GRID) % CITY_GRID;

  for (let bx = 0; bx < CITY_GRID; bx++) {
    for (let bz = 0; bz < CITY_GRID; bz++) {
      const rand = natureStream(seed, bx, bz, TAG_STREET);
      const x0 = bx * BLOCK_PITCH;
      const z0 = bz * BLOCK_PITCH;
      // [owner block, ground position] for every candidate pit, in a fixed
      // order: west line plus side, west minus, south plus, south minus.
      const pits: [number, number, number, number][] = [];
      for (const a of plus) pits.push([bx, bz, x0 + FURNITURE_LINE, z0 + a]);
      for (const a of minus) {
        pits.push([wrap(bx - 1), bz, x0 - FURNITURE_LINE, z0 + a]);
      }
      for (const a of plus) pits.push([bx, bz, x0 + a, z0 + FURNITURE_LINE]);
      for (const a of minus) {
        pits.push([bx, wrap(bz - 1), x0 + a, z0 - FURNITURE_LINE]);
      }
      for (const [ox, oz, x, z] of pits) {
        const present = rand() < 0.8;
        const trunkH =
          STREET_TREE_TRUNK_MIN +
          rand() * (STREET_TREE_TRUNK_MAX - STREET_TREE_TRUNK_MIN);
        const canopyR =
          STREET_TREE_CANOPY_MIN +
          rand() * (STREET_TREE_CANOPY_MAX - STREET_TREE_CANOPY_MIN);
        const canopyH = Math.min(
          STREET_TREE_MAX_HEIGHT - trunkH,
          canopyR * (0.95 + 0.15 * rand()),
        );
        if (!present) continue;
        if (blockGroundKind(ox, oz) === GROUND_SITE) continue;
        const p = canon(x, z);
        if (isInRoadway({ x: p.x, y: 0, z: p.z })) continue;
        // L11: no tree pits on a bridge deck — the sidewalk there is a slab
        // over the water. Promenade-side pits keep their trees.
        if (overChannel(p.z)) continue;
        out.push({
          x: p.x,
          z: p.z,
          trunkH,
          trunkR: 0.17,
          canopyR,
          canopyH,
          kind: "street",
        });
      }
    }
  }
}

// --- Seed-free dressing -----------------------------------------------------

function blockCentre(bx: number, bz: number): { cx: number; cz: number } {
  return {
    cx: bx * BLOCK_PITCH + BLOCK_PITCH / 2,
    cz: bz * BLOCK_PITCH + BLOCK_PITCH / 2,
  };
}

function hoardingsFor(bx: number, bz: number, out: Hoarding[]): void {
  const { cx, cz } = blockCentre(bx, bz);
  const line = BLOCK_PITCH / 2 - HOARDING_LINE; // local offset of the fence
  const runHalf = (line - HOARDING_GATE / 2) / 2;
  const runMid = HOARDING_GATE / 2 + runHalf;
  for (const off of [-line, line]) {
    for (const along of [-runMid, runMid]) {
      // A fence parallel to z at x = off, and one parallel to x at z = off.
      const a = canon(cx + off, cz + along);
      out.push({
        x: a.x,
        z: a.z,
        hx: HOARDING_THICKNESS / 2,
        hz: runHalf,
        height: HOARDING_HEIGHT,
      });
      const b = canon(cx + along, cz + off);
      out.push({
        x: b.x,
        z: b.z,
        hx: runHalf,
        hz: HOARDING_THICKNESS / 2,
        height: HOARDING_HEIGHT,
      });
    }
  }
}

/**
 * Everything N1 puts on the ground for `seed`. `buildings` is the same
 * generateCity(seed) array the city renders and collides with; no tree is
 * allowed to stand in (or overhang) any of its footprints. Deterministic,
 * and independent of the lot PRNG — it never touches generateCity's stream.
 */
export function natureFor(
  seed: number,
  buildings: readonly Building[],
): Nature {
  const nature: Nature = {
    trees: [],
    ponds: [],
    lamps: [],
    planters: [],
    hoardings: [],
  };
  const candidates: Tree[] = [];

  for (const [bx, bz] of PLAZA_BLOCKS) {
    const { cx, cz } = blockCentre(bx, bz);
    const c = canon(cx, cz);
    nature.ponds.push({ x: c.x, z: c.z, radius: PARK_POND_RADIUS });
    for (let k = 0; k < PARK_LAMP_COUNT; k++) {
      const l = parkLampLocal(k);
      const p = canon(cx + l.lx, cz + l.lz);
      nature.lamps.push({ x: p.x, z: p.z, height: PARK_LAMP_HEIGHT });
    }
    parkTrees(seed, bx, bz, candidates);
  }

  for (const [bx, bz] of LANDMARK_BLOCKS) {
    const { cx, cz } = blockCentre(bx, bz);
    for (const off of [-PLANTER_OFFSET, PLANTER_OFFSET]) {
      for (const flank of [-1, 1]) {
        const along = flank * (FORECOURT_GATE_HALF + PLANTER_HALF + 0.6);
        for (const [lx, lz] of [
          [off, along],
          [along, off],
        ] as const) {
          const p = canon(cx + lx, cz + lz);
          nature.planters.push({
            x: p.x,
            z: p.z,
            half: PLANTER_HALF,
            height: PLANTER_HEIGHT,
          });
        }
      }
    }
    forecourtTrees(seed, bx, bz, candidates);
  }

  for (const [bx, bz] of CONSTRUCTION_BLOCKS)
    hoardingsFor(bx, bz, nature.hoardings);

  streetTrees(seed, candidates);

  const byBlock = bucketBuildings(buildings);
  for (const t of candidates) {
    if (!overlapsBuilding(t, byBlock)) nature.trees.push(t);
  }
  return nature;
}
