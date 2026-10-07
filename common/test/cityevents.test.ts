// L1 reactive city — the server-side acceptance rule. It runs ONCE, on the
// server, so every client receives the same accepted list; these pin what
// it keeps and what it coalesces.

import { describe, expect, it } from "vitest";
import {
  type CityEvent,
  GUNFIRE_COALESCE_M,
  GUNFIRE_COALESCE_MS,
  SMOKE_LIFE_MS,
  acceptCityEvent,
  pruneCityEvents,
} from "../src/cityevents";

const ev = (
  kind: CityEvent["kind"],
  x: number,
  z: number,
  t: number,
): CityEvent => ({ kind, x, y: 50, z, t });

describe("acceptCityEvent", () => {
  it("always accepts a death — even right on top of recent gunfire", () => {
    const recent = [ev("gunfire", 500, 500, 1000)];
    expect(acceptCityEvent(recent, ev("death", 500, 500, 1001), false)).toBe(
      true,
    );
  });

  it("ignores gunfire that is not near a building", () => {
    expect(acceptCityEvent([], ev("gunfire", 500, 500, 0), false)).toBe(false);
    expect(acceptCityEvent([], ev("gunfire", 500, 500, 0), true)).toBe(true);
  });

  it("coalesces a burst: gunfire near an accepted event inside the window is dropped", () => {
    const recent = [ev("gunfire", 500, 500, 1000)];
    const near = GUNFIRE_COALESCE_M - 1;
    expect(
      acceptCityEvent(recent, ev("gunfire", 500 + near, 500, 1400), true),
    ).toBe(false);
    // Outside the radius, or after the window, it is a new disturbance.
    expect(
      acceptCityEvent(
        recent,
        ev("gunfire", 500 + GUNFIRE_COALESCE_M + 1, 500, 1400),
        true,
      ),
    ).toBe(true);
    expect(
      acceptCityEvent(
        recent,
        ev("gunfire", 500, 500, 1000 + GUNFIRE_COALESCE_MS + 1),
        true,
      ),
    ).toBe(true);
  });

  it("coalesces across the torus seam", () => {
    const recent = [ev("gunfire", 1995, 800, 0)];
    expect(acceptCityEvent(recent, ev("gunfire", 10, 800, 500), true)).toBe(
      false,
    );
  });

  it("deaths also count as the disturbance gunfire coalesces into", () => {
    const recent = [ev("death", 700, 700, 0)];
    expect(acceptCityEvent(recent, ev("gunfire", 710, 700, 200), true)).toBe(
      false,
    );
  });
});

describe("pruneCityEvents", () => {
  it("keeps an event until exactly SMOKE_LIFE_MS, then drops it", () => {
    const log = [ev("death", 1, 1, 0), ev("gunfire", 2, 2, 10)];
    expect(pruneCityEvents(log, SMOKE_LIFE_MS - 1)).toHaveLength(2);
    expect(pruneCityEvents(log, SMOKE_LIFE_MS)).toEqual([log[1]]);
    expect(pruneCityEvents(log, SMOKE_LIFE_MS + 10)).toEqual([]);
  });
});
