// Seeded deterministic city generator, shared verbatim by client and server.
// Both sides call generateCity(seed) with the same seed and MUST get the same
// buildings — the client renders them, the server collides against them.
// No Math.random() anywhere in here; a change to the draw order or the PRNG
// is a protocol break.

import {
  BLOCK_PITCH,
  CORE_LOT_MAX_DEPTH,
  CRANE_SITE_REACH,
  CRANE_SITE_ROOF_MAX,
  HEIGHT_BANDS_CORE,
  HEIGHT_BANDS_EDGE,
  HEIGHT_BANDS_MID,
  LANDMARK_FOOTPRINT,
  LOT_CROSS_SPLIT_CHANCE,
  LOT_INTERIOR_INSET_MAX,
  LOT_MAX_DEPTH,
  LOT_MIN_WIDTH,
  LOT_SPLIT_MAX,
  LOT_SPLIT_MIN,
  LOT_STOP_CHANCE,
  SLENDER_MAX,
  TIER_FOUR_MIN_HEIGHT,
  TIER_MIN_SIDE,
  TIER_SETBACK_MAX,
  TIER_SETBACK_MIN,
  TIER_SPLIT_MAX,
  TIER_SPLIT_MIN,
  TIER_THREE_MIN_HEIGHT,
  TIER_TWO_MIN_HEIGHT,
  WORLD_SIZE,
} from "../constants";
import type { BuildingDamage } from "./destruction";
import { type Hole, assignHoles, clearHoleAir, landmarkArch } from "./holes";
import { landmarkProfile } from "./landmarks";
import { CONSTRUCTION_BLOCKS, LANDMARK_BLOCKS, PLAZA_BLOCKS } from "./layout";
import { isRiverRow } from "./river";
import { mulberry32 } from "./rng";
import { type RoofStructure, roofStructuresFor } from "./roof-structures";
import { LOT_LINE } from "./street";
import { type BlockZone, blockZone } from "./zones";

// Re-exported so the hand-placed lists keep their long-standing import site
// (client signage, common/storm) while living in their own module.
export { CONSTRUCTION_BLOCKS, LANDMARK_BLOCKS, PLAZA_BLOCKS };
// L3: the landmark silhouettes and the style lookup the client dresses by.
export {
  type LandmarkProfile,
  type LandmarkStyle,
  LANDMARK_PROFILES,
  landmarkProfile,
  landmarkStyleAt,
} from "./landmarks";
export { mulberry32 };
// H1: the district seam (core / mid / edge) the generator builds heights by.
export {
  type BlockZone,
  CITY_CORES,
  CORE_RADIUS,
  LANDMARK_RING,
  MID_RADIUS,
  blockZone,
} from "./zones";
// D2 breakable buildings: the chunk model and the damage state.
export {
  type BuildingDamage,
  type ChunkSupport,
  type LocalBox,
  type RayHit,
  type TierGrid,
  CUT_NEG_X,
  CUT_NEG_Y,
  CUT_NEG_Z,
  CUT_POS_X,
  CUT_POS_Y,
  CUT_POS_Z,
  CUT_RUBBLE,
  CUT_STEEL,
  CityDamage,
  cellBox,
  chunkAt,
  chunkBox,
  chunkBuilding,
  chunkCell,
  chunkId,
  chunkMask,
  chunkTier,
  chunksOf,
  decodeChunkIds,
  encodeChunkIds,
  isChunk,
  raycastChunk,
  supportGraph,
  tierGrids,
} from "./destruction";
// D8 what still stands: the seam every per-building layer asks.
export {
  type StandingProfile,
  STAND_EPS,
  STAND_OUT,
  STAND_ROOF_RISE,
  decorStands,
  generatedRoof,
  pointStands,
  standingProfile,
  standingTopAt,
  syncRoof,
} from "./standing";
// H1 fly-through holes: the seam collision, rendering and bots all read.
export {
  type Hole,
  type EdgeFrame,
  type HoleAxis,
  type HoleEdge,
  type HoleKind,
  type HoleSpan,
  type SolidBox,
  baseSolids,
  cityHoles,
  clearAirSpans,
  edgeFrame,
  holeEdges,
  inHoleAir,
  opensOnStreets,
  segmentThroughHole,
  solids,
} from "./holes";

/** One box of a setback tower, centered on the building's (x, z). */
export interface Tier {
  width: number;
  depth: number;
  /** This tier's own vertical extent, meters (tiers stack from the ground). */
  height: number;
}

/**
 * One setback tower. (x, z) is the footprint center, on the ground;
 * width/depth/height stay the tier-1 footprint and TOTAL height (minimap,
 * street math, and quick collision rejects read them unchanged), while
 * `tiers` is the exact rendered-and-collided silhouette, bottom-up.
 */
export interface Building {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  tiers: Tier[];
  /**
   * H1 fly-through holes (at most one), absent on a solid building. Tiers
   * stay the OUTER silhouette; `solids()` in ./holes is what is actually
   * there once the holes are cut, and every collider/renderer reads that.
   */
  holes?: Hole[];
  /**
   * R2 solid roof structures (penthouses, cooling towers, tanks,
   * billboards, masts), filled by generateCity from roofStructuresFor().
   * Absent on hand-built buildings. Collision, sight lines and the roof
   * renderer all read exactly this list.
   */
  roof?: RoofStructure[];
  /**
   * D2 destruction, written ONLY by a CityDamage (city/destruction.ts) bound
   * to this city: undefined while the building is intact. `solids()`
   * subtracts what it records, so everything that reads solids agrees.
   */
  damage?: BuildingDamage;
}

/**
 * Every Building is built through here, with every key present in one fixed
 * order, so all buildings — the generator's, a server room's clones, a
 * test's hand-built towers that go through it — share ONE object shape, and
 * the per-probe collision loads stay monomorphic (O5). Undefined keys don't
 * serialise, so the city's JSON digest is unchanged by the absent ones.
 */
export function makeBuilding(b: Building): Building {
  return {
    x: b.x,
    z: b.z,
    width: b.width,
    depth: b.depth,
    height: b.height,
    tiers: b.tiers,
    holes: b.holes,
    roof: b.roof,
    damage: b.damage,
  };
}

/** Blocks per world side (10 for a 2 km world with 200 m blocks). Exported
 * because the collision block index buckets by exactly this lattice. */
export const CITY_GRID = WORLD_SIZE / BLOCK_PITCH;

const blockKey = (bx: number, bz: number) => bx * CITY_GRID + bz;

/** How many tiers a building of `height` gets from its 0..1 tier roll.
 * H1: setbacks scale with height — the skyscrapers of the cores take four. */
function tierCount(height: number, rTier: number): number {
  if (height < TIER_TWO_MIN_HEIGHT) return 1;
  if (height >= TIER_FOUR_MIN_HEIGHT && rTier < 0.6) return 4;
  if (height >= TIER_THREE_MIN_HEIGHT && rTier < 0.55) return 3;
  if (rTier < 0.85) return 2;
  return 1; // some talls stay sheer slabs — skyline variety
}

/**
 * Stack `count` centered tiers: each non-top tier keeps `split` of the height
 * remaining below it, each upper tier shrinks the footprint by `setback`.
 * Heights are integers and sum exactly to `height` (the top takes the rest).
 */
function buildTiers(
  width: number,
  depth: number,
  height: number,
  count: number,
  rSetback: number,
  rSplit: number,
): Tier[] {
  const setback =
    TIER_SETBACK_MIN + rSetback * (TIER_SETBACK_MAX - TIER_SETBACK_MIN);
  const split = TIER_SPLIT_MIN + rSplit * (TIER_SPLIT_MAX - TIER_SPLIT_MIN);
  // H1: never set back past TIER_MIN_SIDE — a tower whose next tier would
  // be a stick keeps fewer, fatter tiers instead. (Only ever binds the
  // extra tiers H1 added: the old 1–3 tier towers never reach it.)
  let n = count;
  while (
    n > 1 &&
    Math.min(width, depth) * setback ** (n - 1) < TIER_MIN_SIDE &&
    n > tierFloor(height)
  ) {
    n--;
  }
  const tiers: Tier[] = [];
  let w = width;
  let d = depth;
  let remaining = height;
  for (let i = 0; i < n; i++) {
    const h = i === n - 1 ? remaining : Math.round(remaining * split);
    tiers.push({ width: w, depth: d, height: h });
    remaining -= h;
    w = Math.round(w * setback);
    d = Math.round(d * setback);
  }
  return tiers;
}

/** The fewest tiers TIER_MIN_SIDE may cut a tower down to: only H1's
 * fourth tier is ever dropped — the 1–3 tier profiles below
 * TIER_FOUR_MIN_HEIGHT keep their old shapes whatever their top width. */
const tierFloor = (height: number): number =>
  height >= TIER_FOUR_MIN_HEIGHT ? 3 : 4;

/**
 * A rectangle of buildable land in canonical world coordinates, x0 < x1 and
 * z0 < z1. Lots never wrap: every one sits strictly inside its block, which
 * is what lets the collision block index bucket them by a single lattice cell.
 */
interface Lot {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Clamp `v` into [lo, hi]. */
const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Recursive binary subdivision of one block's buildable rectangle into lots.
 *
 * Splits favour the longer axis (with a seeded chance to take the shorter one)
 * and land at a seeded ratio rather than the middle, so a block ends up with
 * the irregular rhythm a cadastral map has — one wide lot beside three narrow
 * ones — instead of the uniform widths a fixed grid would give. Recursion
 * stops at LOT_MAX_DEPTH, at a seeded early stop past depth 1, or when neither
 * axis can be cut without leaving a lot under LOT_MIN_WIDTH.
 */
function subdivide(
  lot: Lot,
  depth: number,
  rand: () => number,
  out: Lot[],
  maxDepth: number = LOT_MAX_DEPTH,
): void {
  const width = lot.x1 - lot.x0;
  const depthM = lot.z1 - lot.z0;
  const canX = width >= 2 * LOT_MIN_WIDTH;
  const canZ = depthM >= 2 * LOT_MIN_WIDTH;

  if (depth >= maxDepth || (!canX && !canZ)) {
    out.push(lot);
    return;
  }
  if (depth >= 2 && rand() < LOT_STOP_CHANCE) {
    out.push(lot);
    return;
  }

  // Longer axis by default; the cross-split roll is the irregularity source.
  let splitX = width >= depthM;
  if (rand() < LOT_CROSS_SPLIT_CHANCE) splitX = !splitX;
  if (splitX && !canX) splitX = false;
  if (!splitX && !canZ) splitX = true;

  const len = splitX ? width : depthM;
  const start = splitX ? lot.x0 : lot.z0;
  // Keep the ratio inside the range that leaves both halves buildable; when
  // the lot is so tight that no such ratio exists in [MIN, MAX], halve it.
  const lo = Math.max(LOT_SPLIT_MIN, LOT_MIN_WIDTH / len);
  const hi = Math.min(LOT_SPLIT_MAX, 1 - LOT_MIN_WIDTH / len);
  const ratio = lo >= hi ? 0.5 : lo + rand() * (hi - lo);
  // Round to whole meters, then re-clamp: rounding must not shave a half
  // below LOT_MIN_WIDTH, which is the invariant the whole recursion rests on.
  const cut = clamp(
    Math.round(start + len * ratio),
    start + LOT_MIN_WIDTH,
    start + len - LOT_MIN_WIDTH,
  );

  const a = splitX ? { ...lot, x1: cut } : { ...lot, z1: cut };
  const b = splitX ? { ...lot, x0: cut } : { ...lot, z0: cut };
  subdivide(a, depth + 1, rand, out, maxDepth);
  subdivide(b, depth + 1, rand, out, maxDepth);
}

/**
 * Pull a lot's REAR edges back, opening mid-block light wells — the rear
 * yards a real block has behind its streetwall.
 *
 * An edge may move only when the slot it opens cannot be seen from a street.
 * Moving the edge at z0 opens a slot running along the lot's whole x-span, so
 * it is street-visible unless BOTH x edges are interior; symmetrically for the
 * x edges. An edge lying on the block boundary is street frontage and never
 * moves at all. Together those two rules mean the perimeter of every block
 * stays a solid, unbroken plane while its inside gets light wells.
 */
function insetInterior(lot: Lot, block: Lot, rand: () => number): Lot {
  const freeX = lot.x0 > block.x0 && lot.x1 < block.x1;
  const freeZ = lot.z0 > block.z0 && lot.z1 < block.z1;
  // Draw all four regardless of which edges may actually move, so a lot's
  // inset does not depend on where in the block it happens to sit.
  const pull = (allowed: boolean) =>
    allowed ? Math.round(rand() * LOT_INTERIOR_INSET_MAX) : 0;
  const dx0 = pull(freeZ && lot.x0 > block.x0);
  const dx1 = pull(freeZ && lot.x1 < block.x1);
  const dz0 = pull(freeX && lot.z0 > block.z0);
  const dz1 = pull(freeX && lot.z1 < block.z1);

  const inset = {
    x0: lot.x0 + dx0,
    x1: lot.x1 - dx1,
    z0: lot.z0 + dz0,
    z1: lot.z1 - dz1,
  };
  // Never inset a lot out of existence.
  const minSide = LOT_MIN_WIDTH / 2;
  if (inset.x1 - inset.x0 < minSide || inset.z1 - inset.z0 < minSide) {
    return lot;
  }
  return inset;
}

/** H1: each district's height table (constants.ts). */
const ZONE_BANDS: Record<
  BlockZone,
  ReadonlyArray<readonly [number, number, number]>
> = {
  core: HEIGHT_BANDS_CORE,
  mid: HEIGHT_BANDS_MID,
  edge: HEIGHT_BANDS_EDGE,
};

/**
 * Height for one lot from its zone's band table: `rBand` picks the band,
 * `rIn` picks uniformly inside it. A band table rather than a power curve
 * because the skyline read is the histogram — mostly low streetwall with a
 * thin tail of towers — and that is far easier to tune as bands. H1: then
 * capped at SLENDER_MAX × the lot's short side (a narrow lot keeps a
 * pencil tower, the wide lots take the skyscrapers).
 */
function bandHeight(
  bands: ReadonlyArray<readonly [number, number, number]>,
  rBand: number,
  rIn: number,
  shortSide: number,
): number {
  let pick = bands[bands.length - 1];
  for (const band of bands) {
    if (rBand < band[0]) {
      pick = band;
      break;
    }
  }
  if (!pick) throw new Error("height band table is empty");
  const h = Math.round(pick[1] + rIn * (pick[2] - pick[1]));
  return Math.min(h, Math.round(SLENDER_MAX * shortSide));
}

/**
 * Per-block PRNG stream. Replaces the old "draw every block's randoms even
 * for skipped blocks" trick, which cannot survive lot subdivision drawing a
 * VARIABLE number of randoms per block. Seeding each block independently is
 * strictly stronger: a block's lots depend only on (seed, bx, bz), so editing
 * LANDMARK_BLOCKS or PLAZA_BLOCKS cannot shift any other block's layout.
 * Same spatial-hash recipe the client's roof clutter and signage already use.
 */
const blockSeed = (seed: number, bx: number, bz: number) =>
  (seed ^ Math.imul(bx + 1, 73856093) ^ Math.imul(bz + 1, 19349663)) >>> 0;

/** Torus distance between two canonical coordinates on one axis. */
const axisGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % WORLD_SIZE;
  return Math.min(d, WORLD_SIZE - d);
};

/** H1: does `lot` come within CRANE_SITE_REACH of a construction block?
 * Its building then stays under CRANE_SITE_ROOF_MAX, so the site's crane
 * keeps its full jib over the street (city/movers.ts generateMovers). */
function nearCraneSite(lot: Lot): boolean {
  const cx = (lot.x0 + lot.x1) / 2;
  const cz = (lot.z0 + lot.z1) / 2;
  for (const [bx, bz] of CONSTRUCTION_BLOCKS) {
    const sx = bx * BLOCK_PITCH + BLOCK_PITCH / 2;
    const sz = bz * BLOCK_PITCH + BLOCK_PITCH / 2;
    const gx = axisGap(cx, sx) - (lot.x1 - lot.x0) / 2 - BLOCK_PITCH / 2;
    const gz = axisGap(cz, sz) - (lot.z1 - lot.z0) / 2 - BLOCK_PITCH / 2;
    if (Math.hypot(Math.max(0, gx), Math.max(0, gz)) <= CRANE_SITE_REACH) {
      return true;
    }
  }
  return false;
}

/** Salt for the H1 hole stream — separate from the lot stream (roofs.ts
 * idiom), so adding holes moved no lot, and hole rolls never correlate with
 * lot rolls. */
const HOLE_SALT = 0x4f1bbcdc;
/** Salt for the H2 row-tunnel stream: its own per-block draws, so the row
 * pass never shifts a gate or sky roll. */
const ROW_SALT = 0x2c9277b5;

/**
 * Generate the full city for a seed. Every block of the CITY_GRID×CITY_GRID
 * Manhattan grid is subdivided into irregular lots that build out to the lot
 * line, except fixed plaza blocks (left empty for C2), fixed landmark
 * blocks (one Art Deco or glass supertall each, LANDMARK_PROFILES, arched
 * through its podium) and the L11 river row (city/river.ts — no buildings
 * at all). Some lots then
 * get an H1 tunnel or sky hole. Deterministic for a given seed.
 */
export function generateCity(seed: number): Building[] {
  // Landmark block → its LANDMARK_PROFILES slot.
  const landmarks = new Map(
    LANDMARK_BLOCKS.map(([bx, bz], i) => [blockKey(bx, bz), i]),
  );
  const plazas = new Set(PLAZA_BLOCKS.map(([bx, bz]) => blockKey(bx, bz)));
  // Construction sites are empty ground like plazas: their tower cranes live
  // in city/movers.ts as movers, never as Buildings (see CONSTRUCTION_BLOCKS).
  const sites = new Set(
    CONSTRUCTION_BLOCKS.map(([bx, bz]) => blockKey(bx, bz)),
  );

  const buildings: Building[] = [];
  for (let bx = 0; bx < CITY_GRID; bx++) {
    for (let bz = 0; bz < CITY_GRID; bz++) {
      const key = blockKey(bx, bz);
      if (plazas.has(key) || sites.has(key)) continue;
      // L11: the river row is a walled channel and its promenades — no lots.
      // Skipping costs no other block anything: each block draws from its
      // own PRNG stream (blockSeed), so the rest of the city is unchanged.
      if (isRiverRow(bz)) continue;
      const slot = landmarks.get(key);
      if (slot !== undefined) {
        const profile = landmarkProfile(slot);
        buildings.push({
          x: bx * BLOCK_PITCH + BLOCK_PITCH / 2,
          z: bz * BLOCK_PITCH + BLOCK_PITCH / 2,
          width: LANDMARK_FOOTPRINT,
          depth: LANDMARK_FOOTPRINT,
          // H1: the supertalls differ in height (400–480 m); every one is
          // at least LANDMARK_HEIGHT, which is how the city knows them.
          height: profile.tiers.reduce((s, t) => s + t.height, 0),
          tiers: profile.tiers.map((t) => ({ ...t })),
          holes: [landmarkArch(bx, bz)],
        });
        continue;
      }

      // The buildable rectangle: the block inset by the sidewalk on all four
      // sides. Streets are centered on block-boundary lines, so LOT_LINE off
      // the centerline is exactly LOT_LINE inside the block edge.
      const block: Lot = {
        x0: bx * BLOCK_PITCH + LOT_LINE,
        z0: bz * BLOCK_PITCH + LOT_LINE,
        x1: (bx + 1) * BLOCK_PITCH - LOT_LINE,
        z1: (bz + 1) * BLOCK_PITCH - LOT_LINE,
      };

      const rand = mulberry32(blockSeed(seed, bx, bz));
      const zone = blockZone(bx, bz);
      const lots: Lot[] = [];
      // H1: the cores cut fewer, wider lots — the skyscrapers' footprints.
      subdivide(
        block,
        0,
        rand,
        lots,
        zone === "core" ? CORE_LOT_MAX_DEPTH : LOT_MAX_DEPTH,
      );

      for (const raw of lots) {
        const lot = insetInterior(raw, block, rand);
        const width = lot.x1 - lot.x0;
        const depth = lot.z1 - lot.z0;
        const banded = bandHeight(
          ZONE_BANDS[zone],
          rand(),
          rand(),
          Math.min(width, depth),
        );
        const height = nearCraneSite(lot)
          ? Math.min(banded, CRANE_SITE_ROOF_MAX)
          : banded;
        const rTier = rand();
        const rSetback = rand();
        const rSplit = rand();
        buildings.push({
          x: (lot.x0 + lot.x1) / 2,
          z: (lot.z0 + lot.z1) / 2,
          width,
          depth,
          height,
          tiers: buildTiers(
            width,
            depth,
            height,
            tierCount(height, rTier),
            rSetback,
            rSplit,
          ),
        });
      }
    }
  }
  // Tunnels and sky holes need their neighbours' heights (clear air beyond
  // both mouths), so they are cut once the whole city stands. Lots above
  // stay a pure function of (seed, bx, bz); holes do not.
  assignHoles(
    buildings,
    (bx, bz) => mulberry32((blockSeed(seed, bx, bz) ^ HOLE_SALT) >>> 0),
    (bx, bz) => mulberry32((blockSeed(seed, bx, bz) ^ ROW_SALT) >>> 0),
  );
  // R2: roof structures keep off sky holes, so they come after the holes;
  // each is a pure function of its own building.
  for (const b of buildings) {
    const roof = roofStructuresFor(b);
    // O5: set on EVERY building (undefined when bare), so all buildings share
    // one shape: with `roof` on only some, the per-probe collision loads went
    // polymorphic and boxed their doubles (~56 B a collideCity call).
    b.roof = roof.length > 0 ? roof : undefined;
  }
  // H2: and nothing on a roof rises into a hole's clear air.
  clearHoleAir(buildings);
  // One object shape for every building (makeBuilding), now that holes and
  // roofs are settled.
  return buildings.map(makeBuilding);
}
