// L6: the war carrier's searchlights LAND. Each beam the carrier and its
// escort scouts throw (boss.ts exports them as SpotBeams) is cast against
// the city with the same query a bullet uses (firstSolidHit — solids with
// holes cut, the roof structures), clamped at the street, and stops on the
// roof it meets; a soft pool of light goes there. The beam's falloff is
// shortened (reach < 1) so its far end still glows where it touches the
// pool instead of fading to nothing just above it.
//
// The pool is a sprite in the shared MoverLights cloud (no draw of its
// own). That cloud is unfogged (additive + fog brightens the distance — the
// V1 lesson), so the pool is faded here, on the CPU, by the same two fog
// layers the beam's shader attenuates by. It sits a few metres toward the
// eye so the roof it lies on cannot clip the sprite in half.
//
// Allocation-free: scratch vectors and one SegmentHit, reused every frame.

import type { Building } from "@angels-bandits/common/city";
import {
  type CityIndex,
  createSegmentHit,
  firstSolidHit,
} from "@angels-bandits/common/collision";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { hazeAmount } from "./fog";
import type { MoverLights } from "./movers";
import type { SpotBeam } from "./searchlights";

/** Longest throw a carrier lamp is rated for, m (it flies at ~305 m). */
export const LANDING_MAX_THROW = 560;
/** Shortest beam drawn, m — a lamp right over a roof is still a lamp. */
const LANDING_MIN_THROW = 12;
/** How far past the hit the cone runs, m, so its tip sits IN the pool. */
const LANDING_OVERSHOOT = 3;
/** The falloff's reach on a landed beam: alpha at the tip is
 * (1 − reach)^1.5 of the throw's — a visible end, not a cut. */
export const LANDING_REACH = 0.72;
/** The pool: warm white, sub-bloom (luminance ~0.3, like the news heli's —
 * light on a roof, not a rung), its size a multiple of the beam's radius
 * where it lands. */
const POOL_COLOR = new THREE.Color(1.0, 0.95, 0.84).multiplyScalar(0.3);
const POOL_SIZE_PER_RADIUS = 2.4;
/** The sprite is nudged this far toward the eye, m. */
const POOL_LIFT = 4;

const hit = createSegmentHit();
const to: Vec3 = { x: 0, y: 0, z: 0 };
const pool: Vec3 = { x: 0, y: 0, z: 0 };
const poolColor = new THREE.Color();

/** The two fog layers the beam shader attenuates by, mirrored on the CPU. */
function fogFade(eye: Vec3, p: Vec3, fogNear: number, fogFar: number): number {
  const dist = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
  const t = Math.min(1, Math.max(0, (dist - fogNear) / (fogFar - fogNear)));
  const linear = t * t * (3 - 2 * t);
  return (1 - linear) * (1 - hazeAmount(eye.y, p.y, dist));
}

/**
 * Land `spot` (rendered coordinates, a unit `aim`) on the city: set its
 * length, radius (`spread` × length) and reach, and place its pool into
 * `lights` (between MoverLights.begin() and commit()). `eye` is the camera,
 * in the same rendered frame.
 */
export function landBeam(
  spot: SpotBeam,
  spread: number,
  buildings: readonly Building[],
  index: CityIndex,
  eye: Vec3,
  fogNear: number,
  fogFar: number,
  lights: MoverLights,
): void {
  const aim = spot.aim as Vec3;
  // The street bounds the throw first, so the query's box stays small.
  const toGround = aim.y < -1e-3 ? spot.y / -aim.y : LANDING_MAX_THROW;
  const max = Math.min(
    LANDING_MAX_THROW,
    Math.max(LANDING_MIN_THROW, toGround),
  );
  to.x = spot.x + aim.x * max;
  to.y = spot.y + aim.y * max;
  to.z = spot.z + aim.z * max;
  // firstSolidHit measures every building in the segment's own wrapDelta
  // frame, so a nearest-image (non-canonical) lamp is fine.
  const length = Math.max(
    LANDING_MIN_THROW,
    firstSolidHit(spot, to, buildings, index, hit) ? max * hit.t : max,
  );
  const radius = Math.max(4, spread * length);
  spot.length = length + LANDING_OVERSHOOT;
  spot.radius = radius;
  spot.reach = LANDING_REACH;
  // The pool, where it lands — only if it lands on something in range.
  if (length >= max && toGround > LANDING_MAX_THROW) return;
  pool.x = spot.x + aim.x * length;
  pool.y = spot.y + aim.y * length;
  pool.z = spot.z + aim.z * length;
  const dx = eye.x - pool.x;
  const dy = eye.y - pool.y;
  const dz = eye.z - pool.z;
  const d = Math.hypot(dx, dy, dz);
  if (d > 1e-3) {
    const lift = Math.min(POOL_LIFT, d * 0.5) / d;
    pool.x += dx * lift;
    pool.y += dy * lift;
    pool.z += dz * lift;
  }
  const fade = fogFade(eye, pool, fogNear, fogFar);
  if (fade <= 0.01) return;
  poolColor.copy(POOL_COLOR).multiplyScalar(fade);
  lights.place(pool, poolColor, radius * POOL_SIZE_PER_RADIUS);
}
