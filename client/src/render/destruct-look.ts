// DL1: the destruction LOOK the renderers read — the dust (dust.ts), the
// collapse detail's particles, fire, LOD and budgets (collapse-fx.ts). ONE
// live object, a copy of DEFAULT_DESTRUCTION_TUNING: every default is the
// very constant the renderer read before, and every multiplier is exactly
// 1, so a normal game draws bit for bit what it did (tools/destruction-
// bench.ts --digest). Only the Destruction Lab writes it (setDestructLook,
// from main.ts when the welcome says `destruct`); a normal room never does.

import {
  DEFAULT_DESTRUCTION_TUNING,
  type DestructionTuning,
} from "@angels-bandits/common/destruction-tuning";

/** The live look. Read it; write it only through setDestructLook. */
export const destructLook: DestructionTuning = {
  ...DEFAULT_DESTRUCTION_TUNING,
};

/** Bumped on every change (a renderer caching something derived from the
 * look re-derives when it moves). */
export let destructLookVersion = 0;

/** The Destruction Lab's tuning becomes the look (every field is copied; the
 * renderers only read the LOOK ones). */
export function setDestructLook(t: Readonly<DestructionTuning>): void {
  Object.assign(destructLook, t);
  destructLookVersion++;
}
