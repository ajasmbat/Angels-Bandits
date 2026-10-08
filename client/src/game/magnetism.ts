// Bullet magnetism (gun feel): each frame an own bullet's velocity bends a
// hair toward the nearest target inside a tight cone of its flight line —
// connection help against 100 ms interpolation, not an aimbot. A moving
// target pulls toward where THIS bullet would meet it (its intercept point),
// not where it is now: a well-led shot at a crossing bandit flies ~8° ahead
// of it, and bending that round toward the bandit's current position would
// drag it behind. Pure math, torus-aware: target offsets go through
// wrapDelta, so a target just across the seam pulls the short way. Client
// presentation only — the server's hit validation never sees or needs this.

import {
  MAGNETISM_CONE_DEG,
  MAGNETISM_MAX_DEG_PER_S,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";

const CONE_RAD = (MAGNETISM_CONE_DEG * Math.PI) / 180;
const MAX_RAD_PER_S = (MAGNETISM_MAX_DEG_PER_S * Math.PI) / 180;

/**
 * Where a bullet at `speed` meets a target offset `d` moving at `v`, as an
 * offset from the bullet — `d` itself for a still target or no forward-time
 * solution (|d + v·t| = speed·t, the same intercept ui/lead.ts draws).
 */
function interceptOffset(d: Vec3, v: Vec3 | undefined, speed: number): Vec3 {
  if (!v || (v.x === 0 && v.y === 0 && v.z === 0)) return d;
  const a = v.x * v.x + v.y * v.y + v.z * v.z - speed * speed;
  const b = 2 * (d.x * v.x + d.y * v.y + d.z * v.z);
  const c = d.x * d.x + d.y * d.y + d.z * d.z;
  let t: number;
  if (Math.abs(a) < 1e-9) {
    if (b >= 0) return d;
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return d;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
    if (t <= 0) return d;
  }
  return { x: d.x + v.x * t, y: d.y + v.y * t, z: d.z + v.z * t };
}

/**
 * Bend `vel` toward the nearest unprotected one of `targets` (a shielded
 * plane can't be damaged — U1) whose intercept point sits
 * within MAGNETISM_CONE_DEG of the flight line, by at most
 * MAGNETISM_MAX_DEG_PER_S × `dt` (never past the intercept line). A target
 * without `vel` is treated as still. Speed is preserved; with no target in
 * the cone the velocity comes back unchanged.
 */
export function magnetizeVelocity(
  pos: Vec3,
  vel: Vec3,
  targets: readonly { pos: Vec3; vel?: Vec3; prot?: boolean }[],
  dt: number,
): Vec3 {
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if (speed === 0) return vel;

  // Nearest target whose intercept direction sits inside the aim cone.
  let best: Vec3 | null = null;
  let bestDistSq = Number.POSITIVE_INFINITY;
  let bestAngle = 0;
  for (const t of targets) {
    if (t.prot) continue;
    const d = wrapDelta(pos, t.pos);
    const distSq = d.x * d.x + d.y * d.y + d.z * d.z;
    if (distSq === 0 || distSq >= bestDistSq) continue;
    const aim = interceptOffset(d, t.vel, speed);
    const aimLen = Math.hypot(aim.x, aim.y, aim.z);
    if (aimLen === 0) continue;
    const dot = (aim.x * vel.x + aim.y * vel.y + aim.z * vel.z) / speed;
    const cos = dot / aimLen;
    const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
    if (angle > CONE_RAD) continue;
    best = aim;
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
