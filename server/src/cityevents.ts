// L1 reactive city, server half: the per-room log of city events. The server
// is the only place the coalescing rule runs (common/src/cityevents.ts), so
// every client receives the same accepted list — live as `cityEvent`
// broadcasts, and as a SMOKE_LIFE_MS replay in the welcome for joiners.

import type { Building } from "@angels-bandits/common/city";
import {
  type CityEvent,
  type CityEventKind,
  GUNFIRE_NEAR_BUILDING_M,
  acceptCityEvent,
  pruneCityEvents,
} from "@angels-bandits/common/cityevents";
import { buildCityIndex, collideCity } from "@angels-bandits/common/collision";
import type { Vec3 } from "@angels-bandits/common/world";

/** "Near buildings" for gunfire: the shooter's sphere of GUNFIRE_NEAR_BUILDING_M
 * touches a building's solids — the same query the crash check uses. */
export function nearBuildingProbe(
  buildings: readonly Building[],
): (pos: Vec3) => boolean {
  const index = buildCityIndex(buildings);
  return (pos) =>
    collideCity(pos, GUNFIRE_NEAR_BUILDING_M, buildings, index) !== null;
}

export class CityEventLog {
  private readonly byRoom = new Map<string, CityEvent[]>();

  constructor(private readonly nearBuilding: (pos: Vec3) => boolean) {}

  /**
   * Offer one event for `roomId` at server time `t`. Returns the event when
   * the city reacts to it — the caller broadcasts exactly that — or null.
   */
  offer(
    roomId: string,
    kind: CityEventKind,
    pos: Vec3,
    t: number,
  ): CityEvent | null {
    const log = pruneCityEvents(this.byRoom.get(roomId) ?? [], t);
    const ev: CityEvent = { kind, x: pos.x, y: pos.y, z: pos.z, t };
    const near = kind === "gunfire" ? this.nearBuilding(pos) : true;
    if (!acceptCityEvent(log, ev, near)) {
      this.byRoom.set(roomId, log);
      return null;
    }
    log.push(ev);
    this.byRoom.set(roomId, log);
    return ev;
  }

  /** The room's events still reacting at `now`, oldest first (welcome replay). */
  recent(roomId: string, now: number): CityEvent[] {
    const log = pruneCityEvents(this.byRoom.get(roomId) ?? [], now);
    this.byRoom.set(roomId, log);
    return log.map((e) => ({ ...e }));
  }

  /** A room wound down: drop its log. */
  forget(roomId: string): void {
    this.byRoom.delete(roomId);
  }
}
