// Crash detection — the thin client adapter over the shared collision seam.
// Crash detection itself lives in @angels-bandits/common/collision so client
// and server judge crashes from the same generateCity() data. Since T4 the
// client only DETECTS the crash and reports it; death, credit, and the
// respawn all come back from the server (authority split).

import type { Building } from "@angels-bandits/common/city";
import { collideCity, hitsGround } from "@angels-bandits/common/collision";
import { PLAYER_RADIUS } from "@angels-bandits/common/constants";
import type { FlightState } from "@angels-bandits/common/flight";

/** True the frame the plane hits a building or the ground. */
export function detectCrash(
  state: FlightState,
  buildings: readonly Building[],
): boolean {
  return (
    hitsGround(state.pos, PLAYER_RADIUS) ||
    collideCity(state.pos, PLAYER_RADIUS, buildings) !== null
  );
}
