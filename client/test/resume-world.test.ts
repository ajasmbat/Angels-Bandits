// A2: a W2 resume's welcome refreshes the client's world even when it lands
// back in the SAME room — the drop was long enough for the news heli to be
// re-tasked and wrecks to start falling (before A2 only a resume into
// another room took them, so a same-room one kept a stale, solid heli).

import type { NewsHeliSlot } from "@angels-bandits/common/city/newsheli";
import type { CityEvent } from "@angels-bandits/common/cityevents";
import type { WelcomeMsg } from "@angels-bandits/common/protocol";
import type { WreckParams } from "@angels-bandits/common/wreck";
import { describe, expect, it } from "vitest";
import { refreshResumedWorld } from "../src/game/resume-world";

describe("refreshResumedWorld", () => {
  it("takes the welcome's heli, wrecks and city events, whatever the room", () => {
    const ingested: CityEvent[][] = [];
    const blasts: CityEvent[][] = [];
    let wrecks: readonly WreckParams[] = [];
    const news = {
      target: { kind: "idle" },
      prev: null,
    } as unknown as NewsHeliSlot;
    const event: CityEvent = { kind: "death", x: 10, y: 20, z: 30, t: 1000 };
    const moved = {
      target: { kind: "kill", x: 500, z: 700, t0: 900 },
      prev: { kind: "idle" },
    } as unknown as NewsHeliSlot;
    const wreck: WreckParams = {
      id: 3,
      p: { x: 100, y: 200, z: 300 },
      v: { x: 40, y: -5, z: 0 },
      t: 950,
      spin: 1,
      end: 3000,
      hit: "city",
    };
    const welcome = {
      roomId: "room-1",
      cityEvents: [event],
      newsHeli: moved,
      wrecks: [wreck, { junk: true }],
    } as unknown as WelcomeMsg;
    refreshResumedWorld(welcome, {
      reactor: { ingest: (e) => ingested.push([...e]) },
      blastLedger: { ingest: (e) => blasts.push([...e]) },
      wrecks: {
        reset: (list) => {
          wrecks = list;
        },
      },
      news,
    });
    expect(ingested).toEqual([[event]]);
    expect(blasts).toEqual([[event]]);
    expect(news.target).toBe(moved.target);
    expect(news.prev).toBe(moved.prev);
    // Only well-formed wrecks reach the renderer.
    expect(wrecks).toEqual([wreck]);
  });
});
