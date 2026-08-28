// Crash detection — the thin client adapter over the shared collision seam.
// Crash detection itself lives in @angels-bandits/common/collision so client
// and server judge crashes from the same generateCity() data. Since T4 the
// client only DETECTS the crash and reports it; death, credit, and the
// respawn all come back from the server (authority split).

import type { Building } from "@angels-bandits/common/city";
import {
  type MoverField,
  collideMovers,
} from "@angels-bandits/common/city/movers";
import {
  type CityIndex,
  collideCity,
  hitsGround,
} from "@angels-bandits/common/collision";
import { PLAYER_RADIUS } from "@angels-bandits/common/constants";
import type { FlightState } from "@angels-bandits/common/flight";

/**
 * True the frame the plane hits a building, the ground, or an L2 mover.
 *
 * `movers`/`serverTimeMs` are optional so the existing call sites and tests
 * keep working, but when they are supplied the TIME MUST BE THE ONE THE
 * MOVERS ARE RENDERED AT — main.ts latches socket.renderTime() once per frame
 * and passes that same value here and to the mover renderers. Use any other
 * clock and you die to a jib drawn somewhere else. A null clock means the
 * movers are hidden, so they are not solid either.
 */
export function detectCrash(
  state: FlightState,
  buildings: readonly Building[],
  index?: CityIndex,
  movers?: MoverField,
  serverTimeMs?: number | null,
): boolean {
  if (hitsGround(state.pos, PLAYER_RADIUS)) return true;
  if (collideCity(state.pos, PLAYER_RADIUS, buildings, index) !== null) {
    return true;
  }
  if (!movers || serverTimeMs === null || serverTimeMs === undefined) {
    return false;
  }
  return collideMovers(state.pos, PLAYER_RADIUS, movers, serverTimeMs) !== null;
}
