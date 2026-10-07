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
import { collideTrain } from "@angels-bandits/common/city/train";
import {
  type CityIndex,
  type NatureIndex,
  collideCity,
  collideNature,
  hitsGround,
} from "@angels-bandits/common/collision";
import { PLAYER_RADIUS } from "@angels-bandits/common/constants";
import type { FlightState } from "@angels-bandits/common/flight";

/**
 * True the frame the plane hits a building, the ground, a solid N1 tree, or
 * an L2 mover.
 *
 * `movers`/`serverTimeMs` are optional so the existing call sites and tests
 * keep working, but when they are supplied the TIME MUST BE THE ONE THE
 * MOVERS ARE RENDERED AT — main.ts latches socket.renderTime() once per frame
 * and passes that same value here and to the mover renderers. Use any other
 * clock and you die to a jib drawn somewhere else. A null clock means the
 * movers are hidden, so they are not solid either — except the L5 viaduct,
 * which never moves and is always drawn.
 *
 * `nature` is static (trees never move), so unlike the movers it is solid
 * whatever the clock says.
 */
export function detectCrash(
  state: FlightState,
  buildings: readonly Building[],
  index?: CityIndex,
  movers?: MoverField,
  serverTimeMs?: number | null,
  nature?: NatureIndex,
): boolean {
  if (hitsGround(state.pos, PLAYER_RADIUS)) return true;
  if (collideCity(state.pos, PLAYER_RADIUS, buildings, index) !== null) {
    return true;
  }
  if (nature && collideNature(state.pos, PLAYER_RADIUS, nature) !== null) {
    return true;
  }
  if (!movers) return false;
  if (serverTimeMs === null || serverTimeMs === undefined) {
    // No clock yet: the moving parts are hidden and not solid, but the L5
    // viaduct is static scenery — drawn from the first frame, so solid too.
    return (
      !!movers.train &&
      collideTrain(movers.train, state.pos, PLAYER_RADIUS, null) !== null
    );
  }
  return collideMovers(state.pos, PLAYER_RADIUS, movers, serverTimeMs) !== null;
}
