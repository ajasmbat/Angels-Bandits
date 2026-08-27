// The client half of L2: the pure seams of the mover, firework, searchlight
// and bird renderers, plus the two contracts that are easy to break silently.
//
//   1. The emissive ladder. Every L2 light sits on an EXISTING rung and stays
//      under EMISSIVE_TRACER, because combat readability outranks scenery —
//      a firework must never wash out the tracers a fight is read by. The
//      searchlight beams go one further and stay under the bloom threshold
//      entirely; a bloomed 340 m cone would smear over half the screen.
//   2. Program cache keys. Three keys its shader cache on
//      onBeforeCompile.toString(), and both of L2's patches are textually
//      identical to ones already in the repo. The traffic.ts cars once
//      silently reused the buildings' program this exact way.
//
// Like every other render test here, this imports only the pure exports — no
// constructor runs, so no canvas or GL context is needed.

import { generateCity } from "@angels-bandits/common/city";
import {
  CITY_SEED,
  EMISSIVE_BEACON,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_SIGN,
  EMISSIVE_TRACER,
  FIREWORK_LIFETIME_MS,
  FIREWORK_SPARKS,
  LANDMARK_HEIGHT,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { burstsInWindow } from "@angels-bandits/common/fireworks";
import { describe, expect, it } from "vitest";
import {
  BIRDS_PER_FLOCK,
  FLOCK_COUNT,
  birdPosition,
  flocks,
} from "../src/render/birds";
import { luminance } from "../src/render/emissive";
import {
  BurstFeed,
  Fireworks,
  sparkFade,
  sparkOffset,
} from "../src/render/fireworks";
import {
  MOVER_HULL_CACHE_KEY,
  MOVER_LIGHTS_CACHE_KEY,
  type MoverLights,
} from "../src/render/movers";
import {
  BEAM_COLOR,
  BEAM_OPACITY,
  SEARCHLIGHT_COUNT,
  beamDirection,
  searchlightStations,
} from "../src/render/searchlights";

const city = generateCity(CITY_SEED);
/** A server-clock-sized time, never a cosy t = 0. */
const T0 = 1_787_000_000_000;
/** UnrealBloomPass threshold from main.ts — restated, like the ladder spec. */
const BLOOM_THRESHOLD = 0.72;
const ORIGIN = { x: 0, y: 0, z: 0 };
/**
 * A MoverLights stand-in. Fireworks.update() only ever calls place() on it,
 * so a counter is a complete substitute and no GL context is needed.
 */
const sink = () => ({ place: () => {} }) as unknown as MoverLights;

describe("emissive discipline", () => {
  it("puts every L2 light on an existing rung, all under the tracer rung", () => {
    // No new rung: L2 spectacle gets its brightness from count and hue.
    // Crane warning beacons -> BEACON, aircraft nav lights -> NAVLIGHT, the
    // blimp banner -> SIGN, firework sparks -> BEACON.
    for (const rung of [EMISSIVE_BEACON, EMISSIVE_NAVLIGHT, EMISSIVE_SIGN]) {
      expect(rung).toBeLessThan(EMISSIVE_TRACER);
    }
    // Tracers keep the top rung, unchanged and unshared.
    expect(EMISSIVE_TRACER).toBe(1.5);
  });

  it("keeps searchlight beams UNDER the bloom threshold, not on a rung", () => {
    // Beams are light, not geometry, and they are huge. Effective luminance
    // is the colour's, scaled by the additive opacity they are drawn at.
    const effective = luminance(BEAM_COLOR) * BEAM_OPACITY;
    expect(luminance(BEAM_COLOR)).toBeLessThan(1);
    expect(effective).toBeLessThan(BLOOM_THRESHOLD);
  });
});

describe("program cache keys", () => {
  it("gives L2's two patched materials keys nothing else in the repo uses", () => {
    // The existing keys, restated here as the spec (grep customProgramCacheKey).
    const taken = [
      "ab-car-lights",
      "ab-plane-lights",
      "ab-plane-rim",
      "ab-sign-marquee",
      "ab-sign-billboard",
    ];
    expect(taken).not.toContain(MOVER_LIGHTS_CACHE_KEY);
    expect(taken).not.toContain(MOVER_HULL_CACHE_KEY);
    expect(MOVER_LIGHTS_CACHE_KEY).not.toBe(MOVER_HULL_CACHE_KEY);
    expect(MOVER_LIGHTS_CACHE_KEY.length).toBeGreaterThan(0);
    expect(MOVER_HULL_CACHE_KEY.length).toBeGreaterThan(0);
  });
});

describe("searchlightStations", () => {
  const stations = searchlightStations(city);

  it("picks exactly SEARCHLIGHT_COUNT rooftops, deterministically", () => {
    expect(stations).toHaveLength(SEARCHLIGHT_COUNT);
    expect(searchlightStations(city)).toEqual(stations);
  });

  it("never doubles up on a landmark, which already carries a beacon", () => {
    for (const s of stations) {
      expect(s.y).toBeLessThan(LANDMARK_HEIGHT);
    }
  });

  it("stands each light on its own roof, in canonical coordinates", () => {
    const seen = new Set<string>();
    for (const s of stations) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThan(WORLD_SIZE);
      expect(s.z).toBeGreaterThanOrEqual(0);
      expect(s.z).toBeLessThan(WORLD_SIZE);
      seen.add(`${s.x},${s.z}`);
    }
    expect(seen.size).toBe(stations.length);
  });

  it("phases the sweeps apart instead of moving as one bank", () => {
    const phases = new Set(stations.map((s) => s.phase));
    expect(phases.size).toBe(stations.length);
  });
});

describe("beamDirection", () => {
  const station = searchlightStations(city)[0];

  it("is a unit vector pointing upward at every time", () => {
    if (!station) throw new Error("no stations");
    for (let i = 0; i < 200; i++) {
      const d = beamDirection(station, T0 + i * 731);
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
      expect(d.y).toBeGreaterThan(0);
    }
  });

  it("is pure, and actually sweeps", () => {
    if (!station) throw new Error("no stations");
    expect(beamDirection(station, T0)).toEqual(beamDirection(station, T0));
    const a = beamDirection(station, T0);
    const b = beamDirection(station, T0 + 4000);
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(0.05);
  });
});

describe("birds", () => {
  const flock = flocks(CITY_SEED)[0];

  it("lays out the same flocks for a seed, and different ones for another", () => {
    expect(flocks(CITY_SEED)).toEqual(flocks(CITY_SEED));
    expect(flocks(CITY_SEED)).toHaveLength(FLOCK_COUNT);
    expect(flocks(CITY_SEED + 1)).not.toEqual(flocks(CITY_SEED));
  });

  it("keeps every bird canonical and airborne, forever", () => {
    if (!flock) throw new Error("no flocks");
    for (let i = 0; i < 400; i++) {
      const t = T0 + i * 9_973;
      for (let b = 0; b < BIRDS_PER_FLOCK; b++) {
        const p = birdPosition(flock, b, t);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(WORLD_SIZE);
        expect(p.z).toBeGreaterThanOrEqual(0);
        expect(p.z).toBeLessThan(WORLD_SIZE);
        expect(p.y).toBeGreaterThan(0);
      }
    }
  });

  it("is a flock, not a stack — birds hold different positions", () => {
    if (!flock) throw new Error("no flocks");
    const seen = new Set(
      Array.from({ length: BIRDS_PER_FLOCK }, (_, b) => {
        const p = birdPosition(flock, b, T0);
        return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
      }),
    );
    expect(seen.size).toBe(BIRDS_PER_FLOCK);
  });

  it("is pure in time", () => {
    if (!flock) throw new Error("no flocks");
    expect(birdPosition(flock, 3, T0)).toEqual(birdPosition(flock, 3, T0));
  });
});

describe("firework sparks", () => {
  const burst = { timeMs: T0, x: 900, y: 220, z: 900, hue: 0.4 };

  it("starts every spark at the burst center and pushes them outward", () => {
    for (let i = 0; i < FIREWORK_SPARKS; i++) {
      const at0 = sparkOffset(burst, i, 0);
      expect(Math.hypot(at0.x, at0.y, at0.z)).toBeCloseTo(0, 9);
      const at1 = sparkOffset(burst, i, 700);
      expect(Math.hypot(at1.x, at1.y, at1.z)).toBeGreaterThan(3);
    }
  });

  it("opens as a shell, not a clump", () => {
    const dirs = Array.from({ length: FIREWORK_SPARKS }, (_, i) => {
      const o = sparkOffset(burst, i, 500);
      const len = Math.hypot(o.x, o.y, o.z) || 1;
      return { x: o.x / len, y: o.y / len, z: o.z / len };
    });
    // The mean direction of an even shell is near zero.
    const mean = dirs.reduce(
      (a, d) => ({ x: a.x + d.x, y: a.y + d.y, z: a.z + d.z }),
      { x: 0, y: 0, z: 0 },
    );
    const bias = Math.hypot(mean.x, mean.y, mean.z) / FIREWORK_SPARKS;
    expect(bias).toBeLessThan(0.35);
  });

  it("fades from a flash to nothing inside its lifetime", () => {
    expect(sparkFade(0)).toBeCloseTo(1, 6);
    expect(sparkFade(FIREWORK_LIFETIME_MS * 0.5)).toBeGreaterThan(0);
    expect(sparkFade(FIREWORK_LIFETIME_MS * 0.5)).toBeLessThan(1);
    expect(sparkFade(FIREWORK_LIFETIME_MS)).toBe(0);
    expect(sparkFade(FIREWORK_LIFETIME_MS * 2)).toBe(0);
    expect(sparkFade(-1)).toBe(0);
  });

  it("is pure — the same spark at the same age is the same point", () => {
    expect(sparkOffset(burst, 7, 350)).toEqual(sparkOffset(burst, 7, 350));
  });
});

describe("BurstFeed", () => {
  it("primes on the first call instead of replaying the whole show", () => {
    // A client joining mid-match must not get every burst since the epoch.
    const feed = new BurstFeed(CITY_SEED);
    expect(feed.poll(T0)).toEqual([]);
  });

  it("delivers each burst exactly once across successive polls", () => {
    const feed = new BurstFeed(CITY_SEED);
    feed.poll(T0);
    const seen = [];
    for (let i = 1; i <= 400; i++) seen.push(...feed.poll(T0 + i * 250));
    expect(seen).toEqual(burstsInWindow(CITY_SEED, T0, T0 + 400 * 250));
    expect(seen.length).toBeGreaterThan(5); // vacuity guard
  });

  it("re-anchors instead of re-firing when the render clock steps backwards", () => {
    // renderTime() can jump back by up to 192 ms when the adaptive interp
    // delay attacks a jitter spike — that must not replay a burst.
    const feed = new BurstFeed(CITY_SEED);
    feed.poll(T0);
    feed.poll(T0 + 20_000);
    expect(feed.poll(T0 + 19_800)).toEqual([]);
  });

  it("stays silent without a clock", () => {
    expect(new BurstFeed(CITY_SEED).poll(null)).toEqual([]);
  });
});

describe("Fireworks.debug", () => {
  it("derives `live` from the time it is HANDED, not from its own buffer", () => {
    // The two-tab seam check pins one instant and demands identical JSON. The
    // render buffer cannot answer that: it holds what this tab polled at its
    // OWN render clock, and since ANGE-4KO2W2 two tabs sit at different
    // instants. A real two-tab run failed here with both tabs correct -- the
    // same burst was age 1.6 s in one and age 7.3 s (retired) in the other.
    const a = new Fireworks(CITY_SEED);
    const b = new Fireworks(CITY_SEED);
    // Drive the two instances to DIFFERENT internal states, as real tabs are.
    a.update(ORIGIN, T0, sink());
    a.update(ORIGIN, T0 + 30_000, sink());
    b.update(ORIGIN, T0 + 12_000, sink());
    // Same `at` => same answer, whatever each buffer happens to hold.
    const at = T0 + 45_000;
    expect(a.debug(at)).toEqual(b.debug(at));
    expect(a.debug(at)).toEqual(new Fireworks(CITY_SEED).debug(at));
  });

  it("reports exactly the bursts younger than one lifetime", () => {
    const show = new Fireworks(CITY_SEED);
    // Step to an instant that actually has a burst on screen, so this is not
    // vacuously true against an empty sky.
    const bursts = burstsInWindow(CITY_SEED, T0, T0 + 120_000);
    expect(bursts.length).toBeGreaterThan(5);
    const target = bursts[3];
    if (!target) throw new Error("no burst");
    const seen = show.debug(target.timeMs + FIREWORK_LIFETIME_MS / 2);
    expect(seen?.live.map((b) => b.timeMs)).toContain(target.timeMs);
    // One full lifetime later it is gone, and every survivor is in date.
    const after = show.debug(target.timeMs + FIREWORK_LIFETIME_MS + 1);
    expect(after?.live.map((b) => b.timeMs)).not.toContain(target.timeMs);
    for (const b of after?.live ?? []) {
      expect(after.time - b.timeMs).toBeLessThanOrEqual(FIREWORK_LIFETIME_MS);
    }
  });

  it("stays null without a clock", () => {
    expect(new Fireworks(CITY_SEED).debug(null)).toBeNull();
  });
});
