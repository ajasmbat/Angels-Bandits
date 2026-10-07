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
import type { Vec3 } from "@angels-bandits/common/world";

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
  return touchesSolid(
    state.pos,
    PLAYER_RADIUS,
    buildings,
    index,
    movers,
    serverTimeMs,
    nature,
  );
}

/**
 * detectCrash's solids for any sphere: true when a sphere of `radius` at
 * `pos` touches the ground (the river's water, walls and decks included), a
 * building, a tree (when `nature` is given) or a mover at `serverTimeMs` —
 * the same clock rules. Wrap-safe, so a render-space position (any torus
 * image) works: the chase camera's spring arm (L11b) sweeps with it.
 */
export function touchesSolid(
  pos: Vec3,
  radius: number,
  buildings: readonly Building[],
  index?: CityIndex,
  movers?: MoverField,
  serverTimeMs?: number | null,
  nature?: NatureIndex,
): boolean {
  if (hitsGround(pos, radius)) return true;
  if (collideCity(pos, radius, buildings, index) !== null) return true;
  if (nature && collideNature(pos, radius, nature) !== null) return true;
  if (!movers) return false;
  if (serverTimeMs === null || serverTimeMs === undefined) {
    // No clock yet: the moving parts are hidden and not solid, but the L5
    // viaduct is static scenery — drawn from the first frame, so solid too.
    return (
      !!movers.train && collideTrain(movers.train, pos, radius, null) !== null
    );
  }
  return collideMovers(pos, radius, movers, serverTimeMs) !== null;
}
