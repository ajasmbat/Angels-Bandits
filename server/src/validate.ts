// Server-side clamp on client-authoritative movement (PLAN.md authority
// split). The server never runs the flight sim — it only judges whether a
// claimed pose is PLAUSIBLE given the last accepted one: speed within
// tolerance, per-update displacement within a physical bound (via
// wrapDistance — the seam makes raw distance meaningless), sane altitude,
// unit-ish quaternion. An implausible claim is snap-rejected: the previous
// pose stands until a believable one arrives.

import {
  MAX_ALTITUDE,
  MAX_SPEED,
  MUSH_SINK,
  POSE_DISTANCE_SLACK,
  SPEED_TOLERANCE,
} from "@angels-bandits/common/constants";
import type { Pose, Quat, SpawnState } from "@angels-bandits/common/protocol";
import { canonicalize, wrapDistance } from "@angels-bandits/common/world";

export interface PoseVerdict {
  /** Was the claim accepted? */
  ok: boolean;
  /** The pose now on record: the sanitized claim, or `prev` on reject. */
  pose: Pose;
}

const finiteQuat = (q: Quat) =>
  Number.isFinite(q.x) &&
  Number.isFinite(q.y) &&
  Number.isFinite(q.z) &&
  Number.isFinite(q.w);

/**
 * Judge `claim` against the last accepted `prev`, `dt` seconds apart.
 * MUSH_SINK rides on top of the speed cap because above the soft ceiling the
 * sink adds vertical motion the airspeed number doesn't carry.
 */
export function validatePose(prev: Pose, claim: Pose, dt: number): PoseVerdict {
  const reject: PoseVerdict = { ok: false, pose: prev };

  const { pos, quat, speed } = claim;
  if (
    !Number.isFinite(pos.x) ||
    !Number.isFinite(pos.y) ||
    !Number.isFinite(pos.z) ||
    !Number.isFinite(speed) ||
    !finiteQuat(quat)
  ) {
    return reject;
  }

  if (speed > MAX_SPEED * SPEED_TOLERANCE || speed < 0) return reject;

  const norm = Math.hypot(quat.x, quat.y, quat.z, quat.w);
  if (norm < 0.9 || norm > 1.1) return reject;

  const clampedPos = canonicalize({
    x: pos.x,
    y: Math.min(Math.max(pos.y, 0), MAX_ALTITUDE),
    z: pos.z,
  });
  const maxTravel =
    (MAX_SPEED * SPEED_TOLERANCE + MUSH_SINK) * dt + POSE_DISTANCE_SLACK;
  if (wrapDistance(prev.pos, clampedPos) > maxTravel) return reject;

  return {
    ok: true,
    pose: {
      pos: clampedPos,
      quat: {
        x: quat.x / norm,
        y: quat.y / norm,
        z: quat.z / norm,
        w: quat.w / norm,
      },
      speed,
    },
  };
}

/** The Pose a freshly spawned player is on record with (attitude = yaw only). */
export function poseFromSpawn(spawn: SpawnState): Pose {
  const half = spawn.yaw / 2;
  return {
    pos: canonicalize(spawn.pos),
    quat: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
    speed: spawn.speed,
  };
}
