// Torus-aware collision between the player sphere and the city — pure and
// shared: the client uses it for crash-death (T2), the server reuses it for
// crash credit/validation (T3/T4). Consumes the same generateCity() Building[]
// the renderer draws, so there is exactly one truth for where buildings are.
//
// Buildings are axis-aligned boxes sitting on the ground; the sphere test is
// the expanded-AABB approximation (box grown by the radius), which is within
// ~radius·0.41 at corners — plenty for an arcade crash check.

import type { Building } from "./city/index";
import { PLAYER_RADIUS } from "./constants";
import { type Vec3, wrapDelta } from "./world/index";

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
): Building | null {
  for (const b of buildings) {
    if (pos.y - radius > b.height) continue;
    const d = wrapDelta({ x: b.x, y: 0, z: b.z }, { x: pos.x, y: 0, z: pos.z });
    // Tier-1 footprint bounds the whole stack — cheap whole-building reject.
    if (
      Math.abs(d.x) > b.width / 2 + radius ||
      Math.abs(d.z) > b.depth / 2 + radius
    ) {
      continue;
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
        return b;
      }
      base = top;
    }
  }
  return null;
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
