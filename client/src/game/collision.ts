// Death & respawn — the thin client adapter over the shared collision seam.
// Crash detection itself lives in @angels-bandits/common/collision so client
// and (later) server judge crashes from the same generateCity() data.

import type { Building } from "@angels-bandits/common/city";
import { collideCity, hitsGround } from "@angels-bandits/common/collision";
import {
  PLAYER_RADIUS,
  RESPAWN_ALTITUDE,
} from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
} from "@angels-bandits/common/flight";

/**
 * Kill check + instant solo respawn: same x/z at mid altitude, level, combat
 * speed (RESPAWN_ALTITUDE is above every rooftop, so anywhere is safe).
 * Returns the respawned state when the plane died this frame, else null.
 */
export function checkDeath(
  state: FlightState,
  buildings: readonly Building[],
): FlightState | null {
  const dead =
    hitsGround(state.pos, PLAYER_RADIUS) ||
    collideCity(state.pos, PLAYER_RADIUS, buildings) !== null;
  if (!dead) return null;
  return createFlightState(
    { x: state.pos.x, y: RESPAWN_ALTITUDE, z: state.pos.z },
    state.yaw,
  );
}
