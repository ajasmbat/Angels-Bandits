// A2: what a W2 resume's welcome refreshes in the client's world. The welcome
// carries the room's whole live state, and a drop of a few seconds is long
// enough for it to move on: a kill re-tasks the news heli, wrecks start
// falling, deaths blow out facades. Before A2 these were only taken from a
// welcome into ANOTHER room, so a same-room resume kept the stale heli — a
// solid mover the own crash check then disagreed with everyone else about —
// and never saw the wrecks of the drop. Every step is idempotent (the city
// events de-duplicate, the wreck list and heli slot are replaced), so it
// runs on every resume.

import type { NewsHeliSlot } from "@angels-bandits/common/city/newsheli";
import type { CityEvent } from "@angels-bandits/common/cityevents";
import type { WelcomeMsg } from "@angels-bandits/common/protocol";
import { type WreckParams, isWreckParams } from "@angels-bandits/common/wreck";

export interface ResumeWorld {
  reactor: { ingest(events: readonly CityEvent[]): void };
  blastLedger: { ingest(events: readonly CityEvent[]): unknown };
  wrecks: { reset(list: readonly WreckParams[]): void };
  /** The room's news heli slot (null: this city has none). */
  news: NewsHeliSlot | null;
}

export function refreshResumedWorld(w: WelcomeMsg, world: ResumeWorld): void {
  world.reactor.ingest(w.cityEvents ?? []);
  world.blastLedger.ingest(w.cityEvents ?? []); // D1: seen ones are skipped
  world.wrecks.reset((w.wrecks ?? []).filter(isWreckParams)); // D4
  if (world.news && w.newsHeli) {
    world.news.target = w.newsHeli.target;
    world.news.prev = w.newsHeli.prev;
  }
}
