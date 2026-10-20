// DS1: the page's half of the debris physics. The sim worker's host
// simulates every nearby collapse as Rapier bodies and transfers one pose
// frame per tick (`poses`, ./protocol.ts); they land in this one registry,
// which the GameSocket's CollapseField is attached to — so each Collapse it
// knows gets `phys`, and the renderer and the crash check pose it from the
// same interpolated frames (common/src/city/physpose.ts). Up the other way
// goes the camera and the quality tier, a few times a second: the physics
// keeps collapses past PHYS_LOD_M analytic and caps its moving bodies by the
// tier's budget.

import { PhysRegistry } from "@angels-bandits/common/city/physpose";
import { wrapCoord } from "@angels-bandits/common/world";
import type { PhysTier } from "@angels-bandits/server/debris-physics";
import type { FromWorker, ToWorker } from "./protocol";

/** Every physics collapse the local host has sent poses for. */
export const pagePhysics = new PhysRegistry();

/** A `poses` message from the worker. */
export function ingestPoses(msg: Extract<FromWorker, { t: "poses" }>): void {
  pagePhysics.ingest(msg.at, msg.epoch, msg.data, msg.heaps);
}

/** How often the camera goes up, ms, and how far it must have moved, m. */
const VIEW_MS = 250;
const VIEW_MOVE_M = 25;

let lastAt = Number.NEGATIVE_INFINITY;
let lastX = Number.NaN;
let lastZ = Number.NaN;
let lastTier: PhysTier | null = null;

/** Tell the worker where the camera is (throttled; `now` is the page's
 * clock, ms). `post` is the worker link's postMessage. */
export function sendPhysicsView(
  post: (msg: ToWorker) => void,
  x: number,
  z: number,
  tier: PhysTier,
  now: number,
): void {
  const cx = wrapCoord(x);
  const cz = wrapCoord(z);
  const moved = !(
    Math.abs(cx - lastX) < VIEW_MOVE_M && Math.abs(cz - lastZ) < VIEW_MOVE_M
  );
  if (tier === lastTier && (now - lastAt < VIEW_MS || !moved)) return;
  lastAt = now;
  lastX = cx;
  lastZ = cz;
  lastTier = tier;
  post({ t: "view", x: cx, z: cz, tier });
}
