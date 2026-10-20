// D10 / DS2: how far a collapse's dust surge rolls down the streets — on
// its own (light) module so the settled dust (dust-deposit.ts, read by the
// car and prop materials) can share it without importing dust.ts's
// renderer and its scene rig.

import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import { destructLook } from "./destruct-look";

/** How far along the street the surge rolls past where it meets it, m
 * (most of a block each way). */
export const SURGE_ALONG_M = 0.8 * BLOCK_PITCH;
/** DS2: a big collapse's surge is a pyroclastic flow — it rolls further
 * down the avenues (× height / SURGE_SCALE_H_M, 1..SURGE_SCALE_MAX: a
 * supertall's runs blocks each way). */
export const SURGE_SCALE_H_M = 110;
export const SURGE_SCALE_MAX = 2.6;

/** How far the surge of a `height` m tower rolls along the street past
 * where it meets it, m (× the lab's roll-out). */
export const surgeAlong = (height: number): number =>
  SURGE_ALONG_M *
  destructLook.dustRollOut *
  Math.min(SURGE_SCALE_MAX, Math.max(1, height / SURGE_SCALE_H_M));
