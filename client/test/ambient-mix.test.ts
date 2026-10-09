// City soundscape mix (L2): the pure seam behind ambience.ts. Invariants
// under test: city layers never get louder as you climb and are silent at
// the cloud base; wind never gets quieter as you climb or speed up; the
// tunnel reverb is on only inside a hole (or, U5, under a bore's cover);
// the siren schedule is a pure function of (seed, server clock).

import { cityHoles, generateCity } from "@angels-bandits/common/city";
import {
  TUNNELS,
  guideY,
  tunnelPointInto,
} from "@angels-bandits/common/city/tunnels";
import { CLOUD_BASE } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  ambientMix,
  cavernLevel,
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

  it("U5: cavern 0 is exactly the city mix; deeper, the city ducks and the echo rises", () => {
    for (const y of [-50, 0, 30, 200]) {
      for (const hole of [false, true]) {
        const city = ambientMix(at(y), 70, 20, 150, hole);
        expect(ambientMix(at(y), 70, 20, 150, hole, 0)).toEqual(city);
        expect(city.cavern).toBe(0);
        let prev = city;
        for (const cave of [0.25, 0.5, 1]) {
          const mix = ambientMix(at(y), 70, 20, 150, hole, cave);
          for (const k of [
            "traffic",
            "horn",
            "siren",
            "plaza",
            "wind",
          ] as const) {
            expect(mix[k]).toBeLessThanOrEqual(prev[k]);
          }
          expect(mix.reverb).toBeGreaterThanOrEqual(cave);
          expect(mix.cavern).toBe(cave);
          prev = mix;
        }
      }
    }
    expect(ambientMix(at(-50), 70, 20, 150, false, 3).cavern).toBe(1);
  });
});

describe("U5 cavern level", () => {
  const t = TUNNELS[0] as (typeof TUNNELS)[number];
  const on = (s: number, y: number) => {
    const p = tunnelPointInto(t, s, { x: 0, z: 0, th: 0 });
    return { x: p.x, y, z: p.z };
  };

  it("is 1 deep in a bore, 0 in the open air and over a plaza cut's ramp", () => {
    expect(cavernLevel(on(485, -52))).toBe(1);
    expect(cavernLevel(on(485, 30))).toBe(0);
    // Inside the open cut, below street level: open sky, no cavern.
    expect(cavernLevel(on(40, -8))).toBe(0);
    // A river mouth's channel stretch is open river.
    const riverside = TUNNELS[1] as (typeof TUNNELS)[number];
    const m = tunnelPointInto(riverside, 10, { x: 0, z: 0, th: 0 });
    expect(cavernLevel({ x: m.x, y: -20, z: m.z })).toBe(0);
  });

  it("eases in with depth under the lintel", () => {
    let prev = 0;
    for (let s = 80; s < 300; s += 5) {
      const c = cavernLevel(on(s, guideY(t, s)));
      expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(c).toBeLessThanOrEqual(1);
      prev = c;
    }
    expect(prev).toBe(1);
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
