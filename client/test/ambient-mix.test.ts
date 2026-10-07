// City soundscape mix (L2): the pure seam behind ambience.ts. Invariants
// under test: city layers never get louder as you climb and are silent at
// the cloud base; wind never gets quieter as you climb or speed up; the
// tunnel reverb is on only inside a hole; the siren schedule is a pure
// function of (seed, server clock).

import { cityHoles, generateCity } from "@angels-bandits/common/city";
import { CLOUD_BASE } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  ambientMix,
  insideHole,
  plazaDistance,
  sirenAt,
  sirenGain,
  streetDistance,
} from "../src/audio/ambient-mix";

const at = (y: number) => ({ x: 1000, y, z: 1000 });
const CITY_LAYERS = ["traffic", "horn", "siren", "plaza"] as const;

describe("ambientMix", () => {
  it("is monotonic with altitude: city layers fall, wind rises", () => {
    for (const street of [0, 30, 100]) {
      for (const plaza of [0, 150, 600]) {
        let prev = ambientMix(at(0), 60, street, plaza, false);
        for (let y = 5; y <= 900; y += 5) {
          const mix = ambientMix(at(y), 60, street, plaza, false);
          for (const k of CITY_LAYERS)
            expect(mix[k]).toBeLessThanOrEqual(prev[k]);
          expect(mix.wind).toBeGreaterThanOrEqual(prev.wind);
          prev = mix;
        }
      }
    }
  });

  it("silences the city murmur at and above the cloud base", () => {
    for (const y of [CLOUD_BASE, CLOUD_BASE + 50, 800]) {
      const mix = ambientMix(at(y), 90, 0, 0, false);
      for (const k of CITY_LAYERS) expect(mix[k]).toBe(0);
      expect(mix.wind).toBeGreaterThan(0);
    }
  });

  it("hears the street right under you, and only down low", () => {
    const street = ambientMix(at(30), 60, 10, 600, false);
    const midBlock = ambientMix(at(30), 60, 100, 600, false);
    expect(street.traffic).toBeGreaterThan(midBlock.traffic);
    expect(street.horn).toBeGreaterThan(0.5);
    expect(midBlock.horn).toBe(0);
    expect(ambientMix(at(200), 60, 10, 600, false).horn).toBe(0);
  });

  it("grows the wind with airspeed", () => {
    let prev = 0;
    for (let speed = 40; speed <= 125; speed += 5) {
      const wind = ambientMix(at(200), speed, 50, 600, false).wind;
      expect(wind).toBeGreaterThanOrEqual(prev);
      prev = wind;
    }
  });

  it("keeps every layer within 0..1", () => {
    for (const y of [0, 30, 200, 450, 800]) {
      for (const speed of [0, 40, 90, 125, 200]) {
        for (const hole of [false, true]) {
          const mix = ambientMix(at(y), speed, 0, 0, hole);
          for (const v of Object.values(mix)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("sends to the tunnel reverb only inside a hole", () => {
    expect(ambientMix(at(30), 60, 50, 300, false).reverb).toBe(0);
    expect(ambientMix(at(30), 60, 50, 300, true).reverb).toBe(1);
  });
});

describe("listener geometry", () => {
  it("measures street distance off either centerline, seam-safe", () => {
    expect(streetDistance({ x: 400, y: 0, z: 1050 })).toBe(0);
    expect(streetDistance({ x: 1990, y: 0, z: 1100 })).toBeCloseTo(10);
    expect(streetDistance({ x: 1100, y: 0, z: 1100 })).toBe(100);
  });

  it("measures plaza distance across the torus seam", () => {
    // Plaza (1, 7) centers on (300, 1500); 1950 sits 350 m west of it
    // through the seam, never 1650 m east.
    expect(plazaDistance({ x: 300, y: 0, z: 1500 })).toBe(0);
    expect(plazaDistance({ x: 1950, y: 0, z: 1500 })).toBeCloseTo(350);
  });

  it("finds the inside of a real hole and nothing beside it", () => {
    const spans = cityHoles(generateCity(42));
    const span = spans.find((s) => s.hole.kind === "arch");
    expect(span).toBeDefined();
    if (!span) return;
    expect(insideHole(spans, span.center)).toBe(true);
    const beside = {
      ...span.center,
      [span.hole.axis === "x" ? "z" : "x"]:
        (span.hole.axis === "x" ? span.center.z : span.center.x) +
        span.hole.width,
    };
    expect(insideHole(spans, beside)).toBe(false);
    expect(insideHole(spans, { ...span.center, y: span.center.y + 200 })).toBe(
      false,
    );
  });
});

describe("sirens", () => {
  it("is deterministic in (seed, clock) and silent on a null clock", () => {
    for (let t = 0; t < 600_000; t += 7_000) {
      expect(sirenAt(42, t)).toEqual(sirenAt(42, t));
    }
    expect(sirenAt(42, null)).toBeNull();
  });

  it("drives sirens through the schedule, and seeds change it", () => {
    const times = Array.from({ length: 400 }, (_, i) => i * 2_500);
    const heard = times.filter((t) => sirenAt(42, t) !== null);
    expect(heard.length).toBeGreaterThan(50);
    const other = times.map((t) => JSON.stringify(sirenAt(7, t)));
    expect(other).not.toEqual(times.map((t) => JSON.stringify(sirenAt(42, t))));
  });

  it("falls off with distance and goes silent at the haze", () => {
    expect(sirenGain(50)).toBeGreaterThan(sirenGain(400));
    expect(sirenGain(400)).toBeGreaterThan(0);
    expect(sirenGain(800)).toBe(0);
  });
});
