// Bullet magnetism (gun feel): each frame an own bullet's velocity bends a
// hair toward the nearest target inside a tight cone of its flight line —
// connection help against 100 ms interpolation, not an aimbot. Pure math,
// torus-aware: target offsets go through wrapDelta, so a target just across
// the seam pulls the short way. Client presentation only — the server's hit
// validation never sees or needs this.

import {
  MAGNETISM_CONE_DEG,
  MAGNETISM_MAX_DEG_PER_S,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";

const CONE_RAD = (MAGNETISM_CONE_DEG * Math.PI) / 180;
const MAX_RAD_PER_S = (MAGNETISM_MAX_DEG_PER_S * Math.PI) / 180;

/**
 * Bend `vel` toward the nearest of `targets` within MAGNETISM_CONE_DEG of
 * the flight line, by at most MAGNETISM_MAX_DEG_PER_S × `dt` (never past the
 * target line). Speed is preserved; with no target in the cone the velocity
 * comes back unchanged.
 */
export function magnetizeVelocity(
  pos: Vec3,
  vel: Vec3,
  targets: readonly { pos: Vec3 }[],
  dt: number,
): Vec3 {
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if (speed === 0) return vel;

  // Nearest target whose torus direction sits inside the aim cone.
  let best: Vec3 | null = null;
  let bestDistSq = Number.POSITIVE_INFINITY;
  let bestAngle = 0;
  for (const t of targets) {
    const d = wrapDelta(pos, t.pos);
    const distSq = d.x * d.x + d.y * d.y + d.z * d.z;
    if (distSq === 0 || distSq >= bestDistSq) continue;
    const dot = (d.x * vel.x + d.y * vel.y + d.z * vel.z) / speed;
    const cos = dot / Math.sqrt(distSq);
    const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
    if (angle > CONE_RAD) continue;
    best = d;
    bestDistSq = distSq;
    bestAngle = angle;
  }
  if (!best || bestAngle === 0) return vel;

  // Rotate vel toward the target direction by the capped angle (Rodrigues).
  const theta = Math.min(bestAngle, MAX_RAD_PER_S * dt);
  // Axis = normalize(vel × toTarget); bestAngle > 0 keeps it well-defined.
  let ax = vel.y * best.z - vel.z * best.y;
  let ay = vel.z * best.x - vel.x * best.z;
  let az = vel.x * best.y - vel.y * best.x;
  const alen = Math.hypot(ax, ay, az);
  if (alen === 0) return vel; // exactly on the aim line — nothing to bend
  ax /= alen;
  ay /= alen;
  az /= alen;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const k = (ax * vel.x + ay * vel.y + az * vel.z) * (1 - cos);
  return {
    x: vel.x * cos + (ay * vel.z - az * vel.y) * sin + ax * k,
    y: vel.y * cos + (az * vel.x - ax * vel.z) * sin + ay * k,
    z: vel.z * cos + (ax * vel.y - ay * vel.x) * sin + az * k,
  };
}
