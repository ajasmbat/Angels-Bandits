// O1: the director's warned events as a HUD line — the C1 low chaos fires
// every 2–4 s around a low pilot, and its tells (the alarm, dust trickling,
// a gas main's hiss) are easy to miss in a furball. While an event is
// warned and still to come near the own plane, the HUD's alert slot (W4's
// bombing warning; a bomb outranks it) names what is about to happen.

import {
  type DirectorEvent,
  EVENT_CARS,
  EVENT_COLLAPSE,
  EVENT_CRANE,
  EVENT_FACADE,
  EVENT_GAS,
  EVENT_ROOF,
  EVENT_SPAN,
} from "@angels-bandits/common/director";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";

/** An event this close (plan view, m) to the own plane is called. C1 stages
 * its events 80–420 m ahead; a tower toppling reaches about its height. */
export const HAZARD_WARN_M = 320;

/** The line for each event kind (≤ the bombing warning's 25 characters, so
 * the phone's strip holds it). */
export const HAZARD_TEXT: Readonly<Record<number, string>> = {
  [EVENT_COLLAPSE]: "⚠ TOWER COMING DOWN",
  [EVENT_GAS]: "⚠ GAS MAIN ABOUT TO BLOW",
  [EVENT_CRANE]: "⚠ CRANE COMING DOWN",
  [EVENT_FACADE]: "⚠ FACADE FALLING",
  [EVENT_ROOF]: "⚠ DEBRIS FALLING",
  [EVENT_SPAN]: "⚠ BRIDGE SPAN FALLING",
  [EVENT_CARS]: "⚠ VEHICLES ABOUT TO BLOW",
};

/**
 * The line for the nearest event warned and still to come at `serverMs`
 * within HAZARD_WARN_M of `self`; null when none, or `self` is null (dead).
 * Pure.
 */
export function hazardWarning(
  events: Iterable<DirectorEvent>,
  self: Vec3 | null,
  serverMs: number,
): string | null {
  if (self === null) return null;
  let best = HAZARD_WARN_M;
  let text: string | null = null;
  for (const e of events) {
    if (serverMs < e.w || serverMs >= e.at) continue;
    const d = Math.hypot(
      wrapDeltaAxis(self.x, e.x),
      wrapDeltaAxis(self.z, e.z),
    );
    if (d > best) continue;
    const line = HAZARD_TEXT[e.k];
    if (line === undefined) continue;
    best = d;
    text = line;
  }
  return text;
}
