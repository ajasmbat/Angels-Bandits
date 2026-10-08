// Torus-aware collision between the player sphere and the city — pure and
// shared: the client uses it for crash-death (T2), the server reuses it for
// crash credit/validation (T3/T4). Consumes the same generateCity() Building[]
// the renderer draws, so there is exactly one truth for where buildings are.
//
// Buildings are axis-aligned boxes sitting on the ground; the sphere test is
// the expanded-AABB approximation (box grown by the radius), which is within
// ~radius·0.41 at corners — plenty for an arcade crash check.

import { type Building, CITY_GRID, type SolidBox, solids } from "./city/index";
import {
  type Nature,
  type NatureBox,
  type Tree,
  treeBoxes,
  treeCollides,
} from "./city/nature";
import { riverHit, riverSegmentClear } from "./city/river";
import {
  BLOCK_PITCH,
  CANOPY_COLLISION_SLACK,
  PLAYER_RADIUS,
} from "./constants";
import { type Vec3, wrapDeltaAxis, wrapDeltaInto } from "./world/index";

/**
 * A block-lattice bucket index over one `Building[]`, built once and reused.
 *
 * Buildings already live on the CITY_GRID×CITY_GRID block lattice, so a
 * probe only has to test the buildings in the blocks its own radius touches
 * — normally 4 cells of a handful of lots each, instead of the whole city.
 * The cost is therefore independent of how dense the city gets, which is what
 * makes the C1 building count affordable on the server's 15 Hz tick.
 *
 * `buildings` is kept so a query can verify the index actually describes the
 * array it was handed; a mismatch degrades to the linear scan rather than
 * silently answering from a stale bucket.
 */
export interface CityIndex {
  /** The exact array this index was built from — identity, not contents. */
  readonly buildings: readonly Building[];
  /** CITY_GRID² cells of ASCENDING indices into `buildings`. */
  readonly cells: ReadonlyArray<readonly number[]>;
}

/**
 * Bucket `buildings` by the blocks their footprints touch. A building is
 * inserted into EVERY block its (possibly seam-straddling) footprint AABB
 * overlaps, so the index is correct for any array — hand-built test towers
 * included — not only for lattice-aligned generated lots.
 */
export function buildCityIndex(buildings: readonly Building[]): CityIndex {
  const cells: number[][] = Array.from(
    { length: CITY_GRID * CITY_GRID },
    () => [],
  );
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (!b) continue;
    // Ascending insertion order per cell is what preserves the linear scan's
    // "first building in array order wins" tie-break.
    for (const bx of blockSpan(b.x - b.width / 2, b.x + b.width / 2)) {
      for (const bz of blockSpan(b.z - b.depth / 2, b.z + b.depth / 2)) {
        cells[bx * CITY_GRID + bz]?.push(i);
      }
    }
  }
  return { buildings, cells };
}

/**
 * The block indices an interval [lo, hi] touches, wrapped. An interval at
 * least a world wide covers every block exactly once. A non-finite interval
 * (an infinite probe radius) also covers everything — falling through to an
 * empty span there would silently answer "no hit" where the linear scan hits.
 */
function blockSpan(lo: number, hi: number): number[] {
  const first = Math.floor(lo / BLOCK_PITCH);
  const last = Math.floor(hi / BLOCK_PITCH);
  const width = last - first + 1;
  if (!Number.isFinite(width)) {
    return Array.from({ length: CITY_GRID }, (_, i) => i);
  }
  const count = Math.min(width, CITY_GRID);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push((((first + i) % CITY_GRID) + CITY_GRID) % CITY_GRID);
  }
  return out;
}

/**
 * blockSpan without the array, for the per-probe queries (O5: the shared
 * collision path runs per frame on the client and per probe on the server's
 * bots, so it must allocate nothing). The span is `spanCount(lo, hi)` blocks
 * from `spanFirst(lo, hi)`, each wrapped by `wrapBlock` — the same blocks in
 * the same order as blockSpan(lo, hi), its non-finite case included.
 */
function spanFirst(lo: number, hi: number): number {
  const first = Math.floor(lo / BLOCK_PITCH);
  const width = Math.floor(hi / BLOCK_PITCH) - first + 1;
  return Number.isFinite(width) ? first : 0;
}

function spanCount(lo: number, hi: number): number {
  const width = Math.floor(hi / BLOCK_PITCH) - Math.floor(lo / BLOCK_PITCH) + 1;
  return Number.isFinite(width) ? Math.min(width, CITY_GRID) : CITY_GRID;
}

const wrapBlock = (n: number): number =>
  ((n % CITY_GRID) + CITY_GRID) % CITY_GRID;

/**
 * How a query treats H1 fly-through holes. "open" is the truth — the plane
 * crashes into exactly what is drawn. "solid" fills every hole back in, for
 * AVOIDANCE probes only: a bot's point-sampled probes can straddle a thin
 * hole wall, so a probe steers clear of holes instead of discovering them.
 * Bots fly holes only as committed threads (B2), checked "open" at 50 ms
 * steps by a full rollout before they commit.
 */
export type HoleMode = "open" | "solid";

/**
 * First building the player sphere intersects, or null. Distances go through
 * wrapDelta, so footprints and planes on opposite sides of the seam still hit.
 * The hit volume is the building's solids — exactly the rendered setback
 * silhouette with its holes cut, so a plane above a ledge or through an arch
 * flies clean (no invisible walls).
 */
export function collideCity(
  pos: Vec3,
  radius: number = PLAYER_RADIUS,
  buildings: readonly Building[] = [],
  index?: CityIndex,
  holes: HoleMode = "open",
): Building | null {
  if (index && index.buildings === buildings) {
    return collideIndexed(pos, radius, buildings, index, holes);
  }
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i] as Building;
    if (hits(pos, radius, b, holes)) return b;
  }
  return null;
}

/** True when the player sphere intersects this building's solids. */
function hits(
  pos: Vec3,
  radius: number,
  b: Building,
  holes: HoleMode,
): boolean {
  if (pos.y - radius > b.height) return false;
  // Scalars, not wrapDelta's object: this runs per building per probe.
  const dx = wrapDeltaAxis(b.x, pos.x);
  const dz = wrapDeltaAxis(b.z, pos.z);
  // Tier-1 footprint bounds the whole stack — cheap whole-building reject.
  if (
    Math.abs(dx) > b.width / 2 + radius ||
    Math.abs(dz) > b.depth / 2 + radius
  ) {
    return false;
  }
  if (holes === "solid" || !b.holes) {
    let base = 0;
    for (let k = 0; k < b.tiers.length; k++) {
      const t = b.tiers[k] as Building["tiers"][number];
      const top = base + t.height;
      if (
        pos.y - radius <= top &&
        pos.y + radius >= base &&
        Math.abs(dx) <= t.width / 2 + radius &&
        Math.abs(dz) <= t.depth / 2 + radius
      ) {
        return true;
      }
      base = top;
    }
    return false;
  }
  const boxes = solids(b);
  for (let k = 0; k < boxes.length; k++) {
    const s = boxes[k] as SolidBox;
    if (
      pos.y - radius <= s.baseY + s.height &&
      pos.y + radius >= s.baseY &&
      Math.abs(dx - s.dx) <= s.width / 2 + radius &&
      Math.abs(dz - s.dz) <= s.depth / 2 + radius
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The indexed query. Only the blocks the probe sphere touches are visited,
 * and the LOWEST array index that hits wins — byte-identical to what the
 * linear scan returns even when the sphere sits inside two expanded
 * footprints at once (which happens at every party wall in a dense block).
 */
function collideIndexed(
  pos: Vec3,
  radius: number,
  buildings: readonly Building[],
  index: CityIndex,
  holes: HoleMode,
): Building | null {
  let best = -1;
  const x0 = spanFirst(pos.x - radius, pos.x + radius);
  const nx = spanCount(pos.x - radius, pos.x + radius);
  const z0 = spanFirst(pos.z - radius, pos.z + radius);
  const nz = spanCount(pos.z - radius, pos.z + radius);
  for (let ix = 0; ix < nx; ix++) {
    const bx = wrapBlock(x0 + ix);
    for (let iz = 0; iz < nz; iz++) {
      const cell = index.cells[bx * CITY_GRID + wrapBlock(z0 + iz)];
      if (!cell) continue;
      for (let k = 0; k < cell.length; k++) {
        const i = cell[k] as number;
        // Cells are ascending, so once we pass the best hit this cell is done.
        if (best >= 0 && i >= best) break;
        const b = buildings[i];
        if (b && hits(pos, radius, b, holes)) {
          best = i;
          break;
        }
      }
    }
  }
  return best < 0 ? null : (buildings[best] ?? null);
}

/** One solid tree as the index stores it: its treeBoxes(), computed once. */
interface IndexedTree {
  readonly tree: Tree;
  /** The tree's base as a Vec3, for wrapDeltaInto. */
  readonly at: Vec3;
  readonly trunk: NatureBox;
  readonly canopy: NatureBox;
}

/**
 * A block-lattice bucket index over the SOLID trees of one Nature (N1) —
 * the CityIndex idea applied to trees. Street trees are the lamp-pole
 * exception (treeCollides) and are never indexed.
 */
export interface NatureIndex {
  readonly trees: readonly IndexedTree[];
  /** CITY_GRID² cells of indices into `trees`. */
  readonly cells: ReadonlyArray<readonly number[]>;
}

/** No trees at all — the default for callers that predate N1. */
export const EMPTY_NATURE_INDEX: NatureIndex = {
  trees: [],
  cells: Array.from({ length: CITY_GRID * CITY_GRID }, () => []),
};

/**
 * Index `nature`'s solid trees by every block their crown or trunk touches.
 * Boxes come from treeBoxes() — the same call the renderer scales its
 * instances from — so the solid volume is the drawn one by construction.
 */
export function buildNatureIndex(nature: Pick<Nature, "trees">): NatureIndex {
  const trees: IndexedTree[] = [];
  const cells: number[][] = Array.from(
    { length: CITY_GRID * CITY_GRID },
    () => [],
  );
  for (const tree of nature.trees) {
    if (!treeCollides(tree)) continue;
    const { trunk, canopy } = treeBoxes(tree);
    const i = trees.length;
    trees.push({ tree, at: { x: tree.x, y: 0, z: tree.z }, trunk, canopy });
    const reach = Math.max(trunk.hx, canopy.hx);
    for (const bx of blockSpan(tree.x - reach, tree.x + reach)) {
      for (const bz of blockSpan(tree.z - reach, tree.z + reach)) {
        cells[bx * CITY_GRID + bz]?.push(i);
      }
    }
  }
  return { trees, cells };
}

/**
 * Does the sphere touch this tree? The trunk is an exact sphere-vs-box test;
 * the crown is the ellipsoid inscribed in its canopy box — what is drawn —
 * tested by inflating its semi-axes by the radius (plus CANOPY_COLLISION_
 * SLACK, which covers the few cm that approximation misses at oblique
 * angles). No empty-air deaths at the box's corners.
 */
/** hitsTree's torus delta — module scratch (one probe at a time). */
const treeDelta: Vec3 = { x: 0, y: 0, z: 0 };

function hitsTree(pos: Vec3, radius: number, t: IndexedTree): boolean {
  const { trunk, canopy } = t;
  if (pos.y - radius > canopy.y1) return false;
  // Into scratch: a float returned from a call that is not inlined is boxed,
  // and this runs per tree per probe.
  const d = wrapDeltaInto(t.at, pos, treeDelta);
  const dx = d.x;
  const dz = d.z;
  const reach = Math.max(trunk.hx, canopy.hx) + radius;
  if (Math.abs(dx) > reach || Math.abs(dz) > reach) return false;

  const ex = Math.max(0, Math.abs(dx) - trunk.hx);
  const ez = Math.max(0, Math.abs(dz) - trunk.hz);
  const ey = Math.max(0, trunk.y0 - pos.y, pos.y - trunk.y1);
  if (ex * ex + ey * ey + ez * ez <= radius * radius) return true;

  const grow = radius + CANOPY_COLLISION_SLACK;
  const ax = canopy.hx + grow;
  const az = canopy.hz + grow;
  const ay = (canopy.y1 - canopy.y0) / 2 + grow;
  const cy = (canopy.y0 + canopy.y1) / 2;
  const nx = dx / ax;
  const ny = (pos.y - cy) / ay;
  const nz = dz / az;
  return nx * nx + ny * ny + nz * nz <= 1;
}

/**
 * First solid tree the sphere touches, or null. Torus-correct through
 * wrapDeltaAxis; only the blocks the sphere spans are visited, so this is
 * cheap enough for the bot probe loop.
 */
export function collideNature(
  pos: Vec3,
  radius: number,
  index: NatureIndex,
): Tree | null {
  if (index.trees.length === 0) return null;
  const x0 = spanFirst(pos.x - radius, pos.x + radius);
  const nx = spanCount(pos.x - radius, pos.x + radius);
  const z0 = spanFirst(pos.z - radius, pos.z + radius);
  const nz = spanCount(pos.z - radius, pos.z + radius);
  for (let ix = 0; ix < nx; ix++) {
    const bx = wrapBlock(x0 + ix);
    for (let iz = 0; iz < nz; iz++) {
      const cell = index.cells[bx * CITY_GRID + wrapBlock(z0 + iz)];
      if (!cell) continue;
      for (let k = 0; k < cell.length; k++) {
        const t = index.trees[cell[k] as number];
        if (t && hitsTree(pos, radius, t)) return t.tree;
      }
    }
  }
  return null;
}

/**
 * True when the player sphere touches the ground: the street-level plane at
 * y = 0 — or, over the L11 river, the water, the embankment walls and
 * railings, and the bridge decks and parapets (city/river.ts riverHit).
 */
export function hitsGround(pos: Vec3, radius: number = PLAYER_RADIUS): boolean {
  return riverHit(pos, radius);
}

/**
 * True when nothing in the city stands between `from` and `to` — the sight
 * line the bot brain acquires targets on (ANGE-SINI5F). The L11 river's
 * solids (bank ground, bridge decks, parapets, railings) count too.
 *
 * Exact, not sampled: every solid box is clipped against the segment, so a
 * sight line can neither tunnel through a slim tower nor be blocked by one it
 * passes wide of. It tests the SAME solids collideCity does, so seeing past a
 * setback ledge or through an H1 hole and flying there agree by construction. A line
 * exactly tangent to a face counts as blocked — the boxes are closed.
 *
 * Torus-correct the same way collideCity is: the segment and every building
 * center enter one wrapDelta-relative frame. That is exact as long as
 * |segment| + BUILDING_MAX_FOOTPRINT / 2 < WORLD_SIZE / 2 — BOT_DETECT_RANGE
 * (500 m) leaves 415 m of margin — since no second image of a building can
 * then be near enough to matter.
 */
/** losClear's sight vector, handed to riverSegmentClear (which keeps no
 * reference) — module scratch, so a sight-line test allocates nothing. */
const sight: Vec3 = { x: 0, y: 0, z: 0 };

export function losClear(
  from: Vec3,
  to: Vec3,
  buildings: readonly Building[] = [],
): boolean {
  const dx = wrapDeltaAxis(from.x, to.x);
  const dy = to.y - from.y;
  const dz = wrapDeltaAxis(from.z, to.z);
  if (dx === 0 && dy === 0 && dz === 0) return true;
  // L11: the river's decks and embankments are cover like any facade.
  sight.x = dx;
  sight.y = dy;
  sight.z = dz;
  if (!riverSegmentClear(from, sight)) return false;
  const loX = Math.min(0, dx);
  const hiX = Math.max(0, dx);
  const loZ = Math.min(0, dz);
  const hiZ = Math.max(0, dz);
  // Altitude is monotonic along the segment, so its lower end bounds it.
  const loY = Math.min(from.y, to.y);
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i] as Building;
    // Whole sight line above the roof — the strong reject for high patrols.
    if (loY > b.height) continue;
    const cx = wrapDeltaAxis(from.x, b.x);
    const cz = wrapDeltaAxis(from.z, b.z);
    // Tier-1 footprint vs the segment's XZ bounds — cheap whole-building reject.
    if (
      cx - b.width / 2 > hiX ||
      cx + b.width / 2 < loX ||
      cz - b.depth / 2 > hiZ ||
      cz + b.depth / 2 < loZ
    ) {
      continue;
    }
    const boxes = solids(b);
    for (let k = 0; k < boxes.length; k++) {
      const t = boxes[k] as SolidBox;
      const x = cx + t.dx;
      const z = cz + t.dz;
      // Segment (0 → d) vs this box in the sight line's local frame (origin
      // = the viewer): the standard slab clip, keeping the interval of t in
      // [0, 1] inside every axis's pair of planes — x, then y, then z. Inline
      // rather than a call: doubles handed to a call that is not inlined are
      // boxed, and this runs per solid per sight line (O5: allocation-free).
      let t0 = 0;
      let t1 = 1;
      let hit = true;
      for (let axis = 0; axis < 3 && hit; axis++) {
        const dv = axis === 0 ? dx : axis === 1 ? dy : dz;
        const lo =
          axis === 0
            ? x - t.width / 2
            : axis === 1
              ? t.baseY - from.y
              : z - t.depth / 2;
        const hi =
          axis === 0
            ? x + t.width / 2
            : axis === 1
              ? t.baseY + t.height - from.y
              : z + t.depth / 2;
        if (dv === 0) {
          // Parallel to this slab: inside it for all t, or never.
          if (lo > 0 || hi < 0) hit = false;
          continue;
        }
        const inv = 1 / dv;
        const a = lo * inv;
        const b = hi * inv;
        if (a < b) {
          if (a > t0) t0 = a;
          if (b < t1) t1 = b;
        } else {
          if (b > t0) t0 = b;
          if (a < t1) t1 = a;
        }
        if (t0 > t1) hit = false;
      }
      // The boxes are closed: a line exactly tangent to a face is blocked.
      if (hit) return false;
    }
  }
  return true;
}
