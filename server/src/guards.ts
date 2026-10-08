// Shape guards for untrusted client frames (S1). Everything that arrives on a
// socket is `unknown` until one of these says otherwise: a throw inside the ws
// `message` listener is uncaught and takes the whole process (every room) down
// with it. They mirror common/src/protocol.ts exactly and stay allocation-free
// — poses arrive at TICK_UP_HZ from every player in every room.

import type { Pose, Quat } from "@angels-bandits/common/protocol";
import type { Vec3 } from "@angels-bandits/common/world";

/** A parsed frame that at least looks like a ClientMsg: a plain object with a
 * string `type`. Its other fields stay `unknown` until a per-type guard. */
export interface ClientEnvelope {
  type: string;
  [field: string]: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isClientMsg = (v: unknown): v is ClientEnvelope =>
  isObject(v) && typeof v.type === "string";

export const isVec3 = (v: unknown): v is Vec3 =>
  isObject(v) &&
  Number.isFinite(v.x) &&
  Number.isFinite(v.y) &&
  Number.isFinite(v.z);

export const isQuat = (v: unknown): v is Quat =>
  isObject(v) &&
  Number.isFinite(v.x) &&
  Number.isFinite(v.y) &&
  Number.isFinite(v.z) &&
  Number.isFinite(v.w);

/** Every Pose field present and finite. Plausibility (speed caps, travel,
 * quaternion norm) is validatePose's job, not this one's. */
export const isPose = (v: unknown): v is Pose =>
  isObject(v) && isVec3(v.pos) && isQuat(v.quat) && Number.isFinite(v.speed);

/** A W2 resume token as the server mints it: 16 random bytes, base64url —
 * exactly 22 characters. Anything else never reaches a lookup. */
export const isResumeToken = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{22}$/.test(v);
