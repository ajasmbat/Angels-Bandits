// L1 reactive city — the pure schedule seam. Everything the city does about
// the dogfight is a function of (server-accepted events, server time): these
// pin that it is deterministic whatever order events arrive in, that every
// reaction expires on time, that radii are respected (across the seam too),
// and that responders only ever drive on the roadway.

import {
  cityHoles,
  generateCity,
  mulberry32,
} from "@angels-bandits/common/city";
import { isInRoadway, nearestStreet } from "@angels-bandits/common/city/street";
import {
  ALARM_LIFE_MS,
  type CityEvent,
  SMOKE_LIFE_MS,
} from "@angels-bandits/common/cityevents";
import {
  CITY_SEED,
  LANE_CENTER_OFFSET,
} from "@angels-bandits/common/constants";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { BUILDING_SHADER_SOURCE } from "../src/render/buildings-material";
import {
  ALARM_RADIUS,
  DISPATCH_DELAY_MS,
  type LowPass,
  MAX_RESPONDER_SITES,
  MAX_WAKES,
  SCATTER_LIFE_MS,
  SCATTER_RADIUS,
  TRACK_RANGE,
  WAKE_RADIUS,
  alarmed,
  cityReactions,
  cityReactionsInto,
  createReactions,
  prepareEvent,
  puffPhase,
  responderPoseInto,
  responderRoute,
  scatterShift,
  smokeBase,
  trackPlanesInto,
  wakeAt,
  wakeStrength,
} from "../src/render/reactions";

const T0 = 1_791_000_000_000;
const death = (x: number, z: number, dt = 0, y = 40): CityEvent => ({
  kind: "death",
  x,
  y,
  z,
  t: T0 + dt,
});
const gunfire = (x: number, z: number, dt = 0, y = 60): CityEvent => ({
  kind: "gunfire",
  x,
  y,
  z,
  t: T0 + dt,
});

/** Deterministic shuffle (no Math.random in a determinism test). */
const shuffled = <T>(xs: readonly T[], seed: number): T[] => {
  const out = [...xs];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

const MIXED: CityEvent[] = [
  death(520, 610, 0),
  gunfire(1400, 330, 400),
  death(1880, 1250, 900),
  gunfire(90, 1990, 1500),
  death(1000, 1180, 2100, 0.5),
  gunfire(700, 700, 3000),
];

describe("cityReactions — determinism", () => {
  it("gives the identical schedule whatever order the events were ingested in", () => {
    for (const at of [500, 2_500, 12_000, 31_000, 59_000]) {
      const ref = cityReactions(MIXED, T0 + at);
      for (const seed of [1, 2, 3, 4, 5]) {
        expect(cityReactions(shuffled(MIXED, seed), T0 + at)).toEqual(ref);
      }
    }
  });

  it("is a pure function of (events, time): two evaluations agree exactly", () => {
    expect(cityReactions(MIXED, T0 + 9_999)).toEqual(
      cityReactions(MIXED, T0 + 9_999),
    );
  });

  it("caps evict the OLDEST: 10 deaths in one second keep the same 4 newest responder sites on every client", () => {
    const burst = Array.from({ length: 10 }, (_, i) =>
      death(100 + i * 170, 130 + i * 90, i * 100),
    );
    const newest = burst.slice(-MAX_RESPONDER_SITES);
    for (const seed of [7, 8, 9]) {
      const r = cityReactions(shuffled(burst, seed), T0 + 30_000);
      expect(r.responderCount).toBe(MAX_RESPONDER_SITES * 2);
      // Each kept site's responders park within a block of its scene.
      const sites = new Set<number>();
      for (const v of r.responders.slice(0, r.responderCount)) {
        const near = newest.findIndex(
          (e) =>
            Math.abs(wrapDeltaAxis(e.x, v.x)) < 120 &&
            Math.abs(wrapDeltaAxis(e.z, v.z)) < 120,
        );
        expect(near).toBeGreaterThanOrEqual(0);
        sites.add(near);
      }
      expect(sites.size).toBe(MAX_RESPONDER_SITES);
      expect(r.wakeCount).toBe(MAX_WAKES);
    }
  });

  it("writes into the SAME pooled objects every frame (allocation-free Into)", () => {
    const prepared = MIXED.map((e) => prepareEvent(e, []));
    const out = createReactions();
    const firstWake = out.wakes[0];
    const firstResponder = out.responders[0];
    cityReactionsInto(out, prepared, T0 + 4_000);
    cityReactionsInto(out, prepared, T0 + 8_000);
    expect(out.wakes[0]).toBe(firstWake);
    expect(out.responders[0]).toBe(firstResponder);
    expect(out.wakes).toHaveLength(MAX_WAKES);
  });
});

describe("cityReactions — expiry", () => {
  const one = [death(600, 300)];

  it("nothing reacts before the event, on this client's clock", () => {
    const r = cityReactions(one, T0 - 1);
    expect(r.wakeCount + r.smokeCount + r.responderCount).toBe(0);
  });

  it("alarms and woken windows last exactly ALARM_LIFE_MS (30 s)", () => {
    expect(cityReactions(one, T0 + ALARM_LIFE_MS - 1).wakeCount).toBe(1);
    expect(cityReactions(one, T0 + ALARM_LIFE_MS).wakeCount).toBe(0);
    expect(ALARM_LIFE_MS).toBe(30_000);
  });

  it("smoke and responders last exactly SMOKE_LIFE_MS (60 s)", () => {
    const live = cityReactions(one, T0 + SMOKE_LIFE_MS - 1);
    expect(live.smokeCount).toBe(1);
    expect(live.responderCount).toBe(2);
    const gone = cityReactions(one, T0 + SMOKE_LIFE_MS);
    expect(gone.smokeCount).toBe(0);
    expect(gone.responderCount).toBe(0);
    expect(SMOKE_LIFE_MS).toBe(60_000);
  });

  it("gunfire wakes the block but never smokes or calls responders", () => {
    const r = cityReactions([gunfire(800, 800)], T0 + 5_000);
    expect(r.wakeCount).toBe(1);
    expect(r.smokeCount).toBe(0);
    expect(r.responderCount).toBe(0);
  });

  it("wake strength ramps in, holds, and fades to 0 by the end of life", () => {
    expect(wakeStrength(-1)).toBe(0);
    expect(wakeStrength(0)).toBe(0);
    expect(wakeStrength(1_200)).toBe(1);
    expect(wakeStrength(5_000)).toBe(1);
    expect(wakeStrength(20_000)).toBeLessThan(wakeStrength(10_000));
    expect(wakeStrength(ALARM_LIFE_MS - 1)).toBeLessThan(0.001);
    expect(wakeStrength(ALARM_LIFE_MS)).toBe(0);
  });

  it("the smoke column builds from the ground and is fully spent at 60 s", () => {
    // 2 s in, only puffs that have had time to rise are in the air — low.
    for (let i = 0; i < 28; i++) {
      const u = puffPhase(2_000, i, T0);
      if (u >= 0) expect(u * 9_000).toBeLessThanOrEqual(2_000 + 1e-6);
    }
    for (let i = 0; i < 28; i++) {
      expect(puffPhase(SMOKE_LIFE_MS + 1, i, T0)).toBe(-1);
    }
  });
});

describe("cityReactions — radius", () => {
  it("window wake is exactly 0 at and beyond WAKE_RADIUS, full near the source", () => {
    expect(wakeAt(1, 0)).toBe(1);
    expect(wakeAt(1, WAKE_RADIUS * 0.3)).toBe(1);
    expect(wakeAt(1, WAKE_RADIUS * 0.7)).toBeGreaterThan(0);
    expect(wakeAt(1, WAKE_RADIUS)).toBe(0);
    expect(wakeAt(1, WAKE_RADIUS + 50)).toBe(0);
  });

  it("alarms ring inside ALARM_RADIUS only — and across the torus seam", () => {
    const r = cityReactions([gunfire(1995, 1000)], T0 + 5_000);
    expect(alarmed(r, 1995 + ALARM_RADIUS - 1, 1000)).toBe(true);
    expect(alarmed(r, 1995, 1000 + ALARM_RADIUS + 1)).toBe(false);
    // 10 m east of x = 1995 is x = 5 on the other side of the seam.
    expect(alarmed(r, 5, 1000)).toBe(true);
    expect(alarmed(r, 1995 - ALARM_RADIUS - 5, 1000)).toBe(false);
  });

  it("alarms fall silent once the source has faded", () => {
    const r = cityReactions([gunfire(400, 400)], T0 + ALARM_LIFE_MS - 100);
    expect(alarmed(r, 400, 400)).toBe(false);
  });

  it("pedestrians scatter only inside SCATTER_RADIUS, away from the pass, and settle back", () => {
    const passes: LowPass[] = [{ x: 500, z: 500, t: T0 }];
    const at = T0 + 2_500;
    // Tangent +x; a walker east of the pass runs further east (+), west runs −.
    expect(scatterShift(passes, 1, 510, 500, 1, 0, at)).toBeGreaterThan(0);
    expect(scatterShift(passes, 1, 490, 500, 1, 0, at)).toBeLessThan(0);
    expect(scatterShift(passes, 1, 500 + SCATTER_RADIUS, 500, 1, 0, at)).toBe(
      0,
    );
    expect(scatterShift(passes, 1, 510, 500, 1, 0, T0 + SCATTER_LIFE_MS)).toBe(
      0,
    );
    // Seam: a pass at x = 1990 scatters a walker at x = 5.
    const seam: LowPass[] = [{ x: 1990, z: 500, t: T0 }];
    expect(scatterShift(seam, 1, 5, 500, 1, 0, at)).toBeGreaterThan(0);
  });
});

describe("responders", () => {
  const rand = mulberry32(99);
  const sites: CityEvent[] = Array.from({ length: 60 }, (_, i) =>
    death(rand() * 2000, rand() * 2000, i),
  );
  // The seam on both axes, and a site sitting on an intersection.
  sites.push(death(1999.5, 37), death(3, 1998), death(1000, 1000));

  it("drive only on the roadway, the whole way in, for every site", () => {
    for (const ev of sites) {
      for (const kind of ["police", "ambulance"] as const) {
        const route = responderRoute(ev, kind);
        const pose = { kind, x: 0, z: 0, yaw: 0 };
        for (let age = 0; age < SMOKE_LIFE_MS; age += 250) {
          if (!responderPoseInto(route, age, pose)) continue;
          expect(pose.x).toBeGreaterThanOrEqual(0);
          expect(pose.x).toBeLessThan(2000);
          expect(isInRoadway({ x: pose.x, y: 0, z: pose.z })).toBe(true);
        }
      }
    }
  });

  it("leave after the dispatch beat and park on the scene street, either side of the scene", () => {
    for (const ev of sites) {
      const street = nearestStreet(ev);
      const along = street.axis === "x" ? ev.x : ev.z;
      const parked: number[] = [];
      for (const kind of ["police", "ambulance"] as const) {
        const route = responderRoute(ev, kind);
        const pose = { kind, x: 0, z: 0, yaw: 0 };
        expect(responderPoseInto(route, DISPATCH_DELAY_MS - 1, pose)).toBe(
          false,
        );
        expect(responderPoseInto(route, 45_000, pose)).toBe(true);
        const a = street.axis === "x" ? pose.x : pose.z;
        const c = street.axis === "x" ? pose.z : pose.x;
        // In a lane of the scene street…
        expect(
          Math.abs(
            Math.abs(wrapDeltaAxis(street.centerline, c)) - LANE_CENTER_OFFSET,
          ),
        ).toBeLessThan(1e-6);
        // …within a few meters of the scene.
        expect(Math.abs(wrapDeltaAxis(along, a))).toBeLessThanOrEqual(8 + 1e-6);
        parked.push(wrapDeltaAxis(along, a));
      }
      // The police car parks on the + side of the ambulance (a scene right
      // at an intersection clamps both to the turn, so only the order holds).
      expect(parked[0] as number).toBeGreaterThan(parked[1] as number);
    }
  });

  it("are a police car and an ambulance per site", () => {
    const r = cityReactions([death(700, 900)], T0 + 20_000);
    expect(r.responders.slice(0, r.responderCount).map((v) => v.kind)).toEqual([
      "police",
      "ambulance",
    ]);
  });
});

describe("smokeBase", () => {
  const city = generateCity(CITY_SEED);

  it("rises from the street for a death over the roadway", () => {
    expect(smokeBase(city, 1000, 300, 1180)).toBe(0);
  });

  it("rises from the roof for a death above a building", () => {
    const b = city.find((x) => !x.holes && x.tiers.length === 1);
    expect(b).toBeDefined();
    if (!b) return;
    expect(smokeBase(city, b.x, b.height + 40, b.z)).toBeCloseTo(b.height, 6);
  });

  it("rises from the hole floor — not the roof — for a crash inside a tunnel", () => {
    const span = cityHoles(city).find((s) => s.hole.kind === "tunnel");
    expect(span).toBeDefined();
    if (!span) return;
    const base = smokeBase(city, span.center.x, span.center.y, span.center.z);
    expect(base).toBeLessThanOrEqual(span.center.y);
    expect(base).toBeLessThan(span.building.height);
  });
});

describe("searchlight tracking", () => {
  const lamp = { x: 1000, y: 150, z: 1000 };
  const sweep = { x: 0.6, y: 0.8, z: 0 };
  const out = { x: 0, y: 0, z: 0 };

  it("leaves the sweep alone when no plane is within TRACK_RANGE", () => {
    trackPlanesInto(
      lamp,
      sweep,
      [{ x: 1000 + TRACK_RANGE + 5, y: 150, z: 1000 }],
      out,
    );
    expect(out.x).toBeCloseTo(0.6, 6);
    expect(out.y).toBeCloseTo(0.8, 6);
  });

  it("swings toward a plane in range (seam-aware) and stays pointing up", () => {
    // Plane 100 m away across the seam in −x: lamp at x = 40, plane at 1940.
    trackPlanesInto(
      { x: 40, y: 150, z: 1000 },
      sweep,
      [{ x: 1940, y: 260, z: 1000 }],
      out,
    );
    expect(out.x).toBeLessThan(0);
    expect(out.y).toBeGreaterThan(0);
  });

  it("does not pop when two equidistant planes trade places", () => {
    const a = { x: 1100, y: 200, z: 1000 };
    const b = { x: 1000, y: 200, z: 1100 };
    const d1 = { ...trackPlanesInto(lamp, sweep, [a, b], out) };
    const nudge = { x: 1100.5, y: 200, z: 1000 };
    const d2 = { ...trackPlanesInto(lamp, sweep, [nudge, b], out) };
    expect(Math.hypot(d1.x - d2.x, d1.y - d2.y, d1.z - d2.z)).toBeLessThan(
      0.01,
    );
  });
});

describe("window wake shader contract", () => {
  it("reads the window block's locals it depends on, and declares its uniform", () => {
    const { fragmentEmissive, fragmentPars, fragmentColor } =
      BUILDING_SHADER_SOURCE;
    expect(fragmentPars).toContain("uniform vec4 uWake[");
    expect(fragmentEmissive).toContain("uWake[wi]");
    // The wake block sits after the window emissive and before the shop band.
    const wake = fragmentEmissive.indexOf("windows woken by nearby");
    expect(wake).toBeGreaterThan(fragmentEmissive.indexOf("vec3 windowGlow"));
    expect(wake).toBeLessThan(fragmentEmissive.indexOf("float shopBand"));
    const all = fragmentColor + fragmentEmissive;
    for (const local of [
      "pane",
      "lit",
      "facade",
      "winCell",
      "litWindow",
      "ao",
    ]) {
      expect(all).toMatch(new RegExp(`(?:float|vec2|vec3) ${local} =`));
    }
    expect(fragmentEmissive).toContain(WAKE_RADIUS.toFixed(1));
  });
});

describe("prepared events", () => {
  it("dispatch the police/ambulance pair only for deaths", () => {
    expect(prepareEvent(gunfire(10, 10), []).routes).toEqual([]);
    expect(prepareEvent(death(10, 10), []).routes.map((r) => r.kind)).toEqual([
      "police",
      "ambulance",
    ]);
  });

  it("ALARM_RADIUS sits inside WAKE_RADIUS (alarms are the near ring)", () => {
    expect(ALARM_RADIUS).toBeLessThanOrEqual(WAKE_RADIUS);
  });
});
