// FL1: the client's LIVE flight tuning — the one object every control layer
// (effortless, instructor, the hole assist and save, the corner manager,
// flight input, the camera) and main's flight calls read. It equals the
// frozen DEFAULT_TUNING unless the Flight Lab writes it, which only ever
// happens in a lab room (main.ts puts it back to the defaults whenever a
// welcome is not a lab welcome) — so ordinary play reads exactly today's
// numbers, through one seam.

import {
  DEFAULT_TUNING,
  type FlightTuning,
} from "@angels-bandits/common/tuning";

export const tuning: FlightTuning = { ...DEFAULT_TUNING };

/** Back to the shipped values (any non-lab welcome). */
export function resetTuning(): void {
  Object.assign(tuning, DEFAULT_TUNING);
}
