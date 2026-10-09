// Server-side clamp on client-authoritative movement (PLAN.md authority
// split). The server never runs the flight sim — it only judges whether a
// claimed pose is PLAUSIBLE given the last accepted one: speed within
// tolerance, per-update displacement within a physical bound (via
// wrapDistance — the seam makes raw distance meaningless), sane altitude,
// unit-ish quaternion. An implausible claim is snap-rejected: the previous
// pose stands until a believable one arrives.

import { minAltitude } from "@angels-bandits/common/city/river";
import { groundFloor } from "@angels-bandits/common/city/tunnels";
import {
  MAX_ALTITUDE,
  MAX_SPEED,
  MUSH_SINK,
  POSE_DISTANCE_SLACK,
  SPEED_TOLERANCE,
} from "@angels-bandits/common/constants";
import type { Pose, SpawnState } from "@angels-bandits/common/protocol";
import { type FlightTuning, labSpeedCap } from "@angels-bandits/common/tuning";
import { canonicalize, wrapDistance } from "@angels-bandits/common/world";
import { isPose } from "./guards";

export interface PoseVerdict {
  /** Was the claim accepted? */
  ok: boolean;
  /** The pose now on record: the sanitized claim, or `prev` on reject. */
  pose: Pose;
}

/**
 * Judge `claim` against the last accepted `prev`, `dt` seconds apart.
 * MUSH_SINK rides on top of the speed cap because above the soft ceiling the
 * sink adds vertical motion the airspeed number doesn't carry. `maxSpeed` is
 * the fastest the model allows over the window — MAX_SPEED, or the boost
 * mirror's boostSpeedCap (F2) — and bounds both the claimed airspeed and the
 * displacement, so a boost is legal on record and nothing beyond it is.
 */
export function validatePose(
  prev: Pose,
  claim: unknown,
  dt: number,
  maxSpeed: number = MAX_SPEED,
): PoseVerdict {
  const reject: PoseVerdict = { ok: false, pose: prev };

  // The claim came off the wire: check its shape (every field present and
  // finite) before touching a single field of it.
  if (!isPose(claim)) return reject;
  const { pos, quat, speed } = claim;

  if (speed > maxSpeed * SPEED_TOLERANCE || speed < 0) return reject;

  const norm = Math.hypot(quat.x, quat.y, quat.z, quat.w);
  if (norm < 0.9 || norm > 1.1) return reject;

  const clampedPos = canonicalize({
    x: pos.x,
    // Street level is the floor — except over the L11 river, where a plane
    // may fly the channel down to the water (and under the bridges), and
    // over a U4 tunnel, down to the bores' floor.
    y: Math.min(
      Math.max(pos.y, groundFloor(pos.x, pos.z, minAltitude(pos.z))),
      MAX_ALTITUDE,
    ),
    z: pos.z,
  });
  const maxTravel =
    (maxSpeed * SPEED_TOLERANCE + MUSH_SINK) * dt + POSE_DISTANCE_SLACK;
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

/**
 * The `maxSpeed` validatePose judges a room's poses by (FL1). A normal room
 * uses `boostCap`, the boost mirror's window cap, exactly as before — its
 * lab fields are never read. A Flight Lab room uses its own lab tuning's top
 * speed instead (labSpeedCap): the lab's boost gauge is tunable, so the
 * mirror no longer describes it.
 */
export function roomPoseCap(
  room: { readonly lab: boolean; readonly labTuning: FlightTuning },
  boostCap: number,
): number {
  return room.lab ? labSpeedCap(room.labTuning) : boostCap;
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
