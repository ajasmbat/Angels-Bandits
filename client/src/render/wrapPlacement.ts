// Nearest-image torus placement (PLAN.md → "The torus"): the world is stored
// once in canonical [0, WORLD_SIZE) coords, and every frame each thing is
// DRAWN at its torus image nearest the viewer. Built on wrapDelta — the only
// legal way to compare two world positions.

import { type Vec3, wrapDelta } from "@angels-bandits/common/world";

/**
 * The render-space position of `canonical` in the torus image nearest
 * `viewer` (usually the camera): per axis at most WORLD_SIZE/2 away.
 */
export function nearestImage(viewer: Vec3, canonical: Vec3): Vec3 {
  const d = wrapDelta(viewer, canonical);
  return { x: viewer.x + d.x, y: canonical.y, z: viewer.z + d.z };
}
