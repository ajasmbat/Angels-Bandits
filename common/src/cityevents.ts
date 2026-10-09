// L1 reactive city — the shared event seam. The SERVER decides which combat
// moments the city reacts to and broadcasts them as `cityEvent`s (plus a 60 s
// replay in the welcome), so every client — late joiners included — holds the
// identical event list. Clients turn that list into alarms, lit windows,
// smoke and responders with a pure schedule (client/src/render/reactions.ts).
//
// Coalescing lives HERE, applied once on the server, because a client-side
// "drop it if a recent one is nearby" rule depends on the whole accepted
// history: a client that joined later would accept a different chain.

import { type Vec3, wrapDistance } from "./world/index";

/** What happened. Gunfire wakes the block; a death also smokes and calls
 * the responders, and so does an X1 missile impact (`isBlastEvent`). */
export type CityEventKind = "gunfire" | "death" | "missile";

/** A death or a missile impact: blows out windows, burns, smokes and calls
 * the responders. Gunfire only wakes the block. */
export const isBlastEvent = (e: { kind: CityEventKind }): boolean =>
  e.kind !== "gunfire";

/** One server-stamped event the city reacts to. Canonical world position;
 * `t` is the server clock (the snapshot clock), ms. */
export interface CityEvent {
  kind: CityEventKind;
  x: number;
  y: number;
  z: number;
  t: number;
}

/** Car alarms, hazard flashers and woken windows last this long, ms. */
export const ALARM_LIFE_MS = 30_000;
/** Smoke columns and responders last this long, ms — also the server log's
 * retention, so a welcome replay covers every reaction still running. */
export const SMOKE_LIFE_MS = 60_000;

/** Gunfire within this distance of an already-accepted event... */
export const GUNFIRE_COALESCE_M = 40;
/** ...that started within this window is the same disturbance, ms. */
export const GUNFIRE_COALESCE_MS = 5_000;
/** Gunfire only wakes the city when the shooter is within this distance of a
 * building's solids — "near buildings", not over an empty plaza. */
export const GUNFIRE_NEAR_BUILDING_M = 60;

const posOf = (e: CityEvent): Vec3 => ({ x: e.x, y: e.y, z: e.z });

/**
 * Should `ev` join the log, given the events already accepted (`recent`,
 * any order)? Deaths and missile impacts always count. Gunfire must be near a building (the
 * caller supplies that verdict — the server owns the city index) and is
 * dropped when an accepted event within GUNFIRE_COALESCE_M started in the
 * GUNFIRE_COALESCE_MS before it: a sustained burst is one alarm, not ten
 * per second. Only looks back GUNFIRE_COALESCE_MS, far inside the log's
 * SMOKE_LIFE_MS retention, so pruning never changes a verdict.
 */
export function acceptCityEvent(
  recent: readonly CityEvent[],
  ev: CityEvent,
  nearBuilding: boolean,
): boolean {
  if (isBlastEvent(ev)) return true;
  if (!nearBuilding) return false;
  const p = posOf(ev);
  for (const r of recent) {
    const age = ev.t - r.t;
    if (age < 0 || age > GUNFIRE_COALESCE_MS) continue;
    if (wrapDistance(posOf(r), p) <= GUNFIRE_COALESCE_M) return false;
  }
  return true;
}

/** Drop events whose longest reaction has ended by `now`. Pure. */
export function pruneCityEvents(
  events: readonly CityEvent[],
  now: number,
): CityEvent[] {
  return events.filter((e) => now - e.t < SMOKE_LIFE_MS);
}
