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
