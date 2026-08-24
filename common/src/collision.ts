// Torus-aware collision between the player sphere and the city — pure and
// shared: the client uses it for crash-death (T2), the server reuses it for
// crash credit/validation (T3/T4). Consumes the same generateCity() Building[]
// the renderer draws, so there is exactly one truth for where buildings are.
//
// Buildings are axis-aligned boxes sitting on the ground; the sphere test is
// the expanded-AABB approximation (box grown by the radius), which is within
// ~radius·0.41 at corners — plenty for an arcade crash check.

import { type Building, CITY_GRID } from "./city/index";
import { BLOCK_PITCH, PLAYER_RADIUS } from "./constants";
import { type Vec3, wrapDelta } from "./world/index";

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
 * First building the player sphere intersects, or null. Distances go through
 * wrapDelta, so footprints and planes on opposite sides of the seam still hit.
 * The hit volume is the building's tier stack — exactly the rendered setback
 * silhouette, so a plane above a ledge flies clean (no invisible walls).
 */
export function collideCity(
  pos: Vec3,
  radius: number = PLAYER_RADIUS,
  buildings: readonly Building[] = [],
  index?: CityIndex,
): Building | null {
  if (index && index.buildings === buildings) {
    return collideIndexed(pos, radius, buildings, index);
  }
  for (const b of buildings) {
    if (hits(pos, radius, b)) return b;
  }
  return null;
}

/** True when the player sphere intersects this building's tier stack. */
function hits(pos: Vec3, radius: number, b: Building): boolean {
  if (pos.y - radius > b.height) return false;
  const d = wrapDelta({ x: b.x, y: 0, z: b.z }, { x: pos.x, y: 0, z: pos.z });
  // Tier-1 footprint bounds the whole stack — cheap whole-building reject.
  if (
    Math.abs(d.x) > b.width / 2 + radius ||
    Math.abs(d.z) > b.depth / 2 + radius
  ) {
    return false;
  }
  let base = 0;
  for (const t of b.tiers) {
    const top = base + t.height;
    if (
      pos.y - radius <= top &&
      pos.y + radius >= base &&
      Math.abs(d.x) <= t.width / 2 + radius &&
      Math.abs(d.z) <= t.depth / 2 + radius
    ) {
      return true;
    }
    base = top;
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
): Building | null {
  let best = -1;
  for (const bx of blockSpan(pos.x - radius, pos.x + radius)) {
    for (const bz of blockSpan(pos.z - radius, pos.z + radius)) {
      const cell = index.cells[bx * CITY_GRID + bz];
      if (!cell) continue;
      for (const i of cell) {
        // Cells are ascending, so once we pass the best hit this cell is done.
        if (best >= 0 && i >= best) break;
        const b = buildings[i];
        if (b && hits(pos, radius, b)) {
          best = i;
          break;
        }
      }
    }
  }
  return best < 0 ? null : (buildings[best] ?? null);
}

/** True when the player sphere touches the ground plane at y = 0. */
export function hitsGround(pos: Vec3, radius: number = PLAYER_RADIUS): boolean {
  return pos.y - radius <= 0;
}

/**
 * Segment vs one axis-aligned box, both already in the sight line's local
 * frame (origin = the viewer). The standard slab clip: keep the interval of
 * t in [0, 1] that lies inside every axis's pair of planes; empty ⇒ no hit.
 */
function segmentHitsBox(
  d: Vec3,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const [dv, lo, hi] of [
    [d.x, minX, maxX],
    [d.y, minY, maxY],
    [d.z, minZ, maxZ],
  ] as const) {
    if (dv === 0) {
      // Parallel to this slab: inside it for all t, or never.
      if (lo > 0 || hi < 0) return false;
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
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * True when nothing in the city stands between `from` and `to` — the sight
 * line the bot brain acquires targets on (ANGE-SINI5F).
 *
 * Exact, not sampled: every tier box is clipped against the segment, so a
 * sight line can neither tunnel through a slim tower nor be blocked by one it
 * passes wide of. It tests the SAME tier stack collideCity does, so seeing
 * past a setback ledge and flying past it agree by construction. A line
 * exactly tangent to a face counts as blocked — the boxes are closed.
 *
 * Torus-correct the same way collideCity is: the segment and every building
 * center enter one wrapDelta-relative frame. That is exact as long as
 * |segment| + BUILDING_MAX_FOOTPRINT / 2 < WORLD_SIZE / 2 — BOT_DETECT_RANGE
 * (500 m) leaves 415 m of margin — since no second image of a building can
 * then be near enough to matter.
 */
export function losClear(
  from: Vec3,
  to: Vec3,
  buildings: readonly Building[] = [],
): boolean {
  const d = wrapDelta(from, to);
  if (d.x === 0 && d.y === 0 && d.z === 0) return true;
  const loX = Math.min(0, d.x);
  const hiX = Math.max(0, d.x);
  const loZ = Math.min(0, d.z);
  const hiZ = Math.max(0, d.z);
  // Altitude is monotonic along the segment, so its lower end bounds it.
  const loY = Math.min(from.y, to.y);
  for (const b of buildings) {
    // Whole sight line above the roof — the strong reject for high patrols.
    if (loY > b.height) continue;
    const c = wrapDelta(from, { x: b.x, y: 0, z: b.z });
    // Tier-1 footprint vs the segment's XZ bounds — cheap whole-building reject.
    if (
      c.x - b.width / 2 > hiX ||
      c.x + b.width / 2 < loX ||
      c.z - b.depth / 2 > hiZ ||
      c.z + b.depth / 2 < loZ
    ) {
      continue;
    }
    let base = 0;
    for (const t of b.tiers) {
      const top = base + t.height;
      if (
        segmentHitsBox(
          d,
          c.x - t.width / 2,
          c.x + t.width / 2,
          base - from.y,
          top - from.y,
          c.z - t.depth / 2,
          c.z + t.depth / 2,
        )
      ) {
        return false;
      }
      base = top;
    }
  }
  return true;
}
