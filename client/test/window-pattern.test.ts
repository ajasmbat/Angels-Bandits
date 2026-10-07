// C3 facade realism (ANGE-M763XM). The facade look lives in generated GLSL,
// so there is nothing on the CPU to inspect after the fact — these tests
// drive the SEAM instead: the TypeScript mirror in window-pattern.ts (same
// constants, same hashes, same decisions the shader makes per window) plus
// the emitted GLSL itself, checked for the invariants that would otherwise
// only fail on a GPU: the seam rule, the emissive ladder, and the clustering
// that is the whole point of the ticket.

import { readFileSync } from "node:fs";
import { type Building, generateCity } from "@angels-bandits/common/city";
import { EMISSIVE_WINDOW } from "@angels-bandits/common/constants";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { FacadeArchetype, archetypeFor } from "../src/render/archetypes";
import {
  BUILDING_SHADER_SOURCE,
  WINDOW_EMISSIVE_INTENSITY,
  createBuildingsMaterial,
} from "../src/render/buildings-material";
import { luminance } from "../src/render/emissive";
import {
  LIVE,
  LiveClock,
  TV_COLOR,
  TV_GAIN_MAX,
  crewLevel,
  crewSchedule,
  crewSwitchesOn,
  crewVisitSeconds,
  hasBlinds,
  isTvWindow,
  liveClockSeconds,
  silhouetteFactor,
  tvGain,
  windowCycle,
  windowLitLevel,
} from "../src/render/living-windows";
import {
  FACADE,
  abHash,
  aoFadeHeight,
  buildingSeed,
  coolProbability,
  facadeFor,
  isWindowLit,
  litProbability,
  windowColorMix,
  windowPitch,
} from "../src/render/window-pattern";

const ARCHES = [
  FacadeArchetype.GLASS,
  FacadeArchetype.MASONRY,
  FacadeArchetype.OFFICE,
] as const;

/** A spread of building seeds standing in for the real city's variety. */
const seeds = (n: number): number[] =>
  Array.from({ length: n }, (_, i) =>
    buildingSeed(22 + i * 3.7, 20 + i * 5.3, 26 + i * 2.1),
  );

/** Every window cell of one facade of `cols` bays by `rows` floors. */
function litGrid(
  arch: FacadeArchetype,
  seed: number,
  cols: number,
  rows: number,
): boolean[][] {
  return Array.from({ length: rows }, (_, y) =>
    Array.from({ length: cols }, (_, x) => isWindowLit(arch, seed, x, y)),
  );
}

describe("window-pattern seam", () => {
  it("hashes stay in [0, 1) for ordinary and extreme cells", () => {
    for (const [px, py, s] of [
      [0, 0, 0],
      [3, 41, 0.5],
      [-120, -400, 0.999],
      [1e5, -1e5, 1e-6],
      [312500, 7, 61],
    ]) {
      const h = abHash(px, py, s);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  it("seeds a building from its DIMENSIONS, never its position (seam rule)", () => {
    // The mirror takes no position at all, and the vertex patch must seed from
    // the instance SCALE — seeding from instanceMatrix[3].xz would repaint a
    // building the moment it wraps past the torus seam.
    expect(buildingSeed(40, 90, 30)).toBe(buildingSeed(40, 90, 30));
    expect(buildingSeed(40, 90, 30)).not.toBe(buildingSeed(41, 90, 30));
    const vs = BUILDING_SHADER_SOURCE.vertexMain;
    const seedLine = vs
      .split("\n")
      .find((l) => l.includes("vBSeed ="))
      ?.trim();
    expect(seedLine).toContain("bScale");
    expect(seedLine).not.toContain("instanceMatrix[3]");
  });
});

describe("clustered occupancy", () => {
  it("keeps the lit fraction in a plausible night-city band per archetype", () => {
    for (const arch of ARCHES) {
      let lit = 0;
      let total = 0;
      for (const seed of seeds(40)) {
        for (const row of litGrid(arch, seed, 12, 30)) {
          for (const on of row) {
            total += 1;
            if (on) lit += 1;
          }
        }
      }
      const fraction = lit / total;
      // Concept 1 is a sparse city: roughly one window in four once the
      // vacant floors are counted, never the old uniform wall of light and
      // never a fully black city.
      expect(fraction).toBeGreaterThan(0.12);
      expect(fraction).toBeLessThan(0.45);
    }
  });

  it("clusters lit windows far more than independent coin flips would", () => {
    // The statistic: how often two neighbours ON THE SAME FLOOR agree. Under
    // an independent Bernoulli(p) model that is p² + (1-p)², so the clustered
    // pattern has to beat its OWN marginal's baseline by a wide margin. The
    // floor is Concept 1's dominant unit (a floor goes home together), so this
    // is where the clustering has to show up — see the tenant-zone test below
    // for the vertical mechanism.
    for (const arch of ARCHES) {
      let agree = 0;
      let pairs = 0;
      let lit = 0;
      let cells = 0;
      for (const seed of seeds(40)) {
        const grid = litGrid(arch, seed, 12, 30);
        for (const row of grid) {
          for (let x = 0; x < row.length; x++) {
            cells += 1;
            if (row[x]) lit += 1;
            if (x + 1 < row.length) {
              pairs += 1;
              if (row[x] === row[x + 1]) agree += 1;
            }
          }
        }
      }
      const p = lit / cells;
      const baseline = p * p + (1 - p) * (1 - p);
      expect(agree / pairs).toBeGreaterThan(baseline + 0.1);
    }
  });

  it("gives one tenant zone one occupancy, and the next zone another", () => {
    // The second clustering scale, asserted on the mechanism rather than on
    // the realised coin flips: every cell of a tenant zone whose floors are
    // ORDINARY shares one occupancy probability, and crossing the zone
    // boundary — in either axis — usually changes it.
    const ordinary = (seed: number, y: number) => {
      const h = abHash(3, y, seed * 61);
      return h >= FACADE.darkFloor && h <= 1 - FACADE.brightFloor;
    };
    let sameZone = 0;
    let changedAcross = 0;
    let across = 0;
    for (const seed of seeds(40)) {
      for (let y = 0; y + 1 < 40; y++) {
        if (!ordinary(seed, y)) continue;
        const p = litProbability(FacadeArchetype.OFFICE, seed, 0, y);
        // Same zone, other bay on the same floor: identical by construction.
        for (let x = 1; x < FACADE.zoneW; x++) {
          expect(litProbability(FacadeArchetype.OFFICE, seed, x, y)).toBe(p);
        }
        // Same zone, next floor up (when that floor is ordinary too).
        if (
          Math.floor((y + 1) / FACADE.zoneH) === Math.floor(y / FACADE.zoneH)
        ) {
          if (ordinary(seed, y + 1)) {
            expect(litProbability(FacadeArchetype.OFFICE, seed, 0, y + 1)).toBe(
              p,
            );
            sameZone += 1;
          }
        } else if (ordinary(seed, y + 1)) {
          across += 1;
          if (litProbability(FacadeArchetype.OFFICE, seed, 0, y + 1) !== p) {
            changedAcross += 1;
          }
        }
        // Next zone across the facade.
        across += 1;
        if (
          litProbability(FacadeArchetype.OFFICE, seed, FACADE.zoneW, y) !== p
        ) {
          changedAcross += 1;
        }
      }
    }
    expect(sameZone).toBeGreaterThan(100);
    expect(changedAcross / across).toBeGreaterThan(0.95);
  });

  it("produces whole floors that are dark and whole floors that blaze", () => {
    // Floor state is the coarsest clustering scale: over a tall tower some
    // floors must come out (nearly) empty and some (nearly) full.
    const seed = buildingSeed(48, 180, 44);
    const rows = Array.from({ length: 60 }, (_, y) =>
      Array.from({ length: 14 }, (_, x) =>
        isWindowLit(FacadeArchetype.GLASS, seed, x, y),
      ),
    );
    const fractions = rows.map((r) => r.filter(Boolean).length / r.length);
    expect(fractions.filter((f) => f <= 0.1).length).toBeGreaterThan(6);
    expect(fractions.filter((f) => f >= 0.8).length).toBeGreaterThan(2);
  });

  it("varies occupancy between tenant zones on an ordinary floor", () => {
    // Same floor, different bays: the zone multiplier must actually move the
    // probability, not collapse to one value across the facade.
    const seen = new Set<number>();
    for (const seed of seeds(30)) {
      for (let y = 0; y < 40; y++) {
        const ps = [0, 3, 6, 9, 12].map((x) =>
          litProbability(FacadeArchetype.OFFICE, seed, x, y),
        );
        if (new Set(ps).size > 1)
          for (const p of ps) seen.add(Math.round(p * 100));
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(Math.max(...seen) / 100).toBeGreaterThan(FACADE.office.lit);
    expect(Math.min(...seen) / 100).toBeLessThan(FACADE.office.lit);
  });

  it("never asks for a probability outside [0, 0.97]", () => {
    for (const arch of ARCHES) {
      for (const seed of [0, 1e-9, 0.5, 1 - 1e-9]) {
        for (let y = -50; y < 400; y += 7) {
          for (let x = -20; x < 60; x += 3) {
            const p = litProbability(arch, seed, x, y);
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(0.97);
          }
        }
      }
    }
  });
});

describe("mixed colour temperature", () => {
  it("stays a CONVEX warm↔cool mix, so the WINDOW rung cannot be exceeded", () => {
    // Luminance is linear in colour: as long as mixT ∈ [0,1] every window sits
    // between the two palette entries, and the intensity is normalised against
    // the brighter of them. A mix outside [0,1] would extrapolate past it.
    for (const arch of ARCHES) {
      for (const seed of seeds(20)) {
        for (let y = 0; y < 40; y++) {
          for (let x = 0; x < 10; x++) {
            const m = windowColorMix(arch, seed, x, y);
            expect(m).toBeGreaterThanOrEqual(0);
            expect(m).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it("keeps the emissive boost pinned to the ladder's WINDOW rung", () => {
    // The brightest palette colour is COOL (0.55, 0.85, 1.0); boosting it by
    // the shipped intensity must land exactly on EMISSIVE_WINDOW.
    const coolLum = 0.2126 * 0.55 + 0.7152 * 0.85 + 0.0722 * 1.0;
    expect(coolLum * Number(WINDOW_EMISSIVE_INTENSITY)).toBeCloseTo(
      EMISSIVE_WINDOW,
      3,
    );
  });

  it("mixes both temperatures within one building, biased per archetype", () => {
    for (const arch of ARCHES) {
      let cool = 0;
      let total = 0;
      for (const seed of seeds(30)) {
        for (let y = 0; y < 30; y++) {
          for (let x = 0; x < 10; x++) {
            total += 1;
            if (windowColorMix(arch, seed, x, y) > 0.5) cool += 1;
          }
        }
      }
      const share = cool / total;
      // Neither temperature may vanish — the old look was one bulb everywhere.
      expect(share).toBeGreaterThan(0.05);
      expect(share).toBeLessThan(0.95);
      // …and the archetype's bias must still be visible in the aggregate.
      expect(Math.abs(share - facadeFor(arch).cool)).toBeLessThan(0.2);
    }
  });

  it("swings the temperature per building and per floor", () => {
    const perBuilding = seeds(30).map((s) =>
      coolProbability(FacadeArchetype.OFFICE, s, 0),
    );
    expect(Math.max(...perBuilding) - Math.min(...perBuilding)).toBeGreaterThan(
      0.3,
    );
    const seed = buildingSeed(38, 120, 40);
    const perFloor = Array.from({ length: 40 }, (_, y) =>
      coolProbability(FacadeArchetype.OFFICE, seed, y),
    );
    expect(Math.max(...perFloor) - Math.min(...perFloor)).toBeGreaterThan(0.3);
    for (const p of [...perBuilding, ...perFloor]) {
      expect(p).toBeGreaterThanOrEqual(0.02);
      expect(p).toBeLessThanOrEqual(0.98);
    }
  });
});

describe("window grid geometry", () => {
  it("jitters pitch per building within the declared ±band, always positive", () => {
    for (const arch of ARCHES) {
      const base = facadeFor(arch).pitch;
      const xs: number[] = [];
      for (const seed of seeds(60)) {
        const [px, py] = windowPitch(arch, seed);
        expect(px).toBeGreaterThan(0);
        expect(py).toBeGreaterThan(0);
        expect(px / base[0]).toBeGreaterThanOrEqual(1 - FACADE.pitchJitter);
        expect(px / base[0]).toBeLessThanOrEqual(1 + FACADE.pitchJitter);
        expect(py / base[1]).toBeGreaterThanOrEqual(1 - FACADE.pitchJitter);
        expect(py / base[1]).toBeLessThanOrEqual(1 + FACADE.pitchJitter);
        xs.push(px);
      }
      // Neighbouring lots must not share one grid — that is the "one long
      // wall" read C1's density made possible.
      expect(new Set(xs.map((v) => v.toFixed(3))).size).toBeGreaterThan(40);
    }
  });

  it("leaves at least a few bays even on the narrowest post-C1 lot", () => {
    // C1's BSP lots bottom out around 22 m of frontage; a jittered OFFICE
    // pitch is the widest grid, and it must still fit more than one bay.
    for (const seed of seeds(60)) {
      const [px] = windowPitch(FacadeArchetype.OFFICE, seed);
      expect(22 / px).toBeGreaterThan(3);
    }
  });

  it("fades street AO over the building's own height, floored for short lots", () => {
    // A 20 m lot must not be uniformly dark just because the constant was
    // written for a 120 m tower.
    expect(aoFadeHeight(200)).toBe(FACADE.aoHeight);
    expect(aoFadeHeight(20)).toBeCloseTo(9, 6);
    expect(aoFadeHeight(0)).toBe(6);
    expect(aoFadeHeight(-5)).toBe(6);
    for (const h of [0, 1, 12, 26, 60, 232, 1e6]) {
      const a = aoFadeHeight(h);
      expect(a).toBeGreaterThanOrEqual(6);
      expect(a).toBeLessThanOrEqual(FACADE.aoHeight);
    }
  });
});

describe("generated shader", () => {
  const { fragmentColor, fragmentEmissive, fragmentPars, vertexPars } =
    BUILDING_SHADER_SOURCE;
  const all = fragmentPars + fragmentColor + fragmentEmissive;

  it("emits finite numeric literals only — no NaN/undefined leaking in", () => {
    expect(all).not.toMatch(/NaN|undefined|Infinity/);
    for (const lit of all.match(/-?\d+\.\d+/g) ?? []) {
      expect(Number.isFinite(Number(lit))).toBe(true);
    }
  });

  it("declares every varying it reads", () => {
    for (const v of [
      "vMeters",
      "vObjNormal",
      "vBSeed",
      "vWorldY",
      "vArch",
      "vBHeight",
      "vBWorldPos",
    ]) {
      expect(vertexPars).toContain("varying");
      expect(vertexPars).toContain(v);
      expect(fragmentPars).toContain(v);
      expect(all).toContain(v);
    }
  });

  it("declares each fragment local exactly once (no redeclaration)", () => {
    const decls = [
      ...all.matchAll(/^\s*(?:float|vec2|vec3)\s+(\w+)\s*=/gm),
    ].map((m) => m[1]);
    expect(new Set(decls).size).toBe(decls.length);
  });

  it("guards every division that a degenerate facade could zero out", () => {
    // A grazing view ray makes rayUV.x/y ~0; abSafeDiv is what keeps the
    // interior raycast from producing inf/NaN on a real GPU.
    for (const div of ["rayUV.x", "rayUV.y"]) {
      expect(fragmentEmissive).toContain(`abSafeDiv(${div})`);
    }
    expect(fragmentEmissive).toContain("max(rayIn, 0.03)");
    expect(fragmentColor).toContain("max(winPitch.x");
  });

  it("weathers setback tiers in TIER-LOCAL meters, and grounds in world Y", () => {
    // Streaks run from a sill down the tier they belong to; if they were
    // measured in world Y, every upper tier would come out spotless.
    expect(fragmentColor).toMatch(/streak\s*=[\s\S]*vMeters\.y/);
    expect(fragmentColor).toContain("clamp(vWorldY / aoH, 0.0, 1.0)");
  });

  it("keeps ONE program cache key for the whole city (one draw call)", () => {
    const a = createBuildingsMaterial();
    const b = createBuildingsMaterial();
    expect(a.customProgramCacheKey?.()).toBe(b.customProgramCacheKey?.());
    expect(a.customProgramCacheKey?.()).not.toBe("");
  });
});

describe("against the real city", () => {
  const city: Building[] = generateCity(CITY_SEED);

  it("gives every tier of every building a finite, sane window grid", () => {
    let narrowest = Number.POSITIVE_INFINITY;
    for (const b of city) {
      const arch = archetypeFor(b);
      let baseY = 0;
      for (const tier of b.tiers) {
        const seed = buildingSeed(tier.width, tier.height, tier.depth);
        const [px, py] = windowPitch(arch, seed);
        expect(Number.isFinite(px)).toBe(true);
        expect(Number.isFinite(py)).toBe(true);
        expect(px).toBeGreaterThan(0);
        expect(py).toBeGreaterThan(0);
        narrowest = Math.min(narrowest, Math.min(tier.width, tier.depth) / px);
        // The lit decision must be total for every cell the tier can show.
        const rows = Math.ceil(tier.height / py);
        for (const y of [0, Math.floor(rows / 2), rows]) {
          expect(typeof isWindowLit(arch, seed, 0, y)).toBe("boolean");
        }
        baseY += tier.height;
      }
      expect(baseY).toBeCloseTo(b.height, 6);
    }
    // Even the tightest lot in the generated city shows more than one bay.
    expect(narrowest).toBeGreaterThan(2);
  });

  it("lights up a mixed skyline rather than one uniform wall", () => {
    // Sample the ground floor band of every building: the block must contain
    // both busy and dark facades.
    const fractions = city.slice(0, 200).map((b) => {
      const arch = archetypeFor(b);
      const seed = buildingSeed(
        b.tiers[0].width,
        b.tiers[0].height,
        b.tiers[0].depth,
      );
      let lit = 0;
      for (let y = 0; y < 12; y++)
        for (let x = 0; x < 8; x++) if (isWindowLit(arch, seed, x, y)) lit += 1;
      return lit / 96;
    });
    expect(Math.min(...fractions)).toBeLessThan(0.15);
    expect(Math.max(...fractions)).toBeGreaterThan(0.5);
  });
});

// L3 living windows (ANGE-GUFAK3): the lit pattern moves on the shared live
// clock. Metrics: lit fraction = Σ crossfaded level / windows; a toggle = the
// level crossing 0.5. Time samples include the clock wrap (7199.9 → 0).
describe("living windows", () => {
  const P = LIVE.period;
  const SAMPLES = [
    0, 0.05, 37.5, 59.9, 450, 1234.5, 3599.9, 3600, 5000, 7140, 7199.9,
  ];

  it("keeps the lit fraction inside the C3 band at every time sample", () => {
    for (const arch of ARCHES) {
      for (const t of SAMPLES) {
        let level = 0;
        let total = 0;
        for (const seed of seeds(40)) {
          for (let y = 0; y < 30; y++) {
            for (let x = 0; x < 12; x++) {
              level += windowLitLevel(arch, seed, x, y, t);
              total += 1;
            }
          }
        }
        expect(level / total).toBeGreaterThan(0.12);
        expect(level / total).toBeLessThan(0.45);
      }
    }
  });

  it("keeps the real city in the band with the cleaning crew included", () => {
    const city = generateCity(CITY_SEED);
    const rota = crewSchedule(city, CITY_SEED);
    for (const t of [0, 300, 1800, 3599.9, 7199.9]) {
      let level = 0;
      let total = 0;
      for (const b of city) {
        const arch = archetypeFor(b);
        const tier = b.tiers[0];
        const seed = buildingSeed(tier.width, tier.height, tier.depth);
        const [, py] = windowPitch(arch, seed);
        const slot = rota.get(b);
        const rows = Math.min(Math.floor(tier.height / py), 40);
        for (let y = 0; y < rows; y++) {
          const crew = slot ? crewLevel(slot, (y + 0.5) * py, t) : 0;
          for (let x = 0; x < 8; x++) {
            const on = crewSwitchesOn(seed, x, y) ? crew : 0;
            level += Math.max(windowLitLevel(arch, seed, x, y, t), on);
            total += 1;
          }
        }
      }
      expect(level / total).toBeGreaterThan(0.12);
      expect(level / total).toBeLessThan(0.45);
    }
  });

  /** Crossing times (level through 0.5) and the largest per-step change. */
  function trace(f: (t: number) => number, from: number, to: number) {
    const dt = 0.1;
    const crossings: number[] = [];
    let maxStep = 0;
    let prev = f(from);
    for (let i = 1; from + i * dt <= to; i++) {
      const t = from + i * dt;
      const cur = f(((t % P) + P) % P);
      maxStep = Math.max(maxStep, Math.abs(cur - prev));
      if (prev < 0.5 !== cur < 0.5) crossings.push(t);
      prev = cur;
    }
    return { crossings, maxStep };
  }

  it("toggles each window at most once per 20 s, always as a slow crossfade", () => {
    // 0.1 s steps across the clock wrap: smoothstep over LIVE.fade s peaks at
    // 1.5 / fade per second, so no 0.1 s step may move more than that — the
    // no-pop proof, wrap included.
    const stepCap = (1.5 / 1.5) * 0.1; // a ramp no faster than 1.5 s
    let volatileSeen = 0;
    let toggles = 0;
    for (const seed of seeds(6)) {
      for (let y = 0; y < 20; y++) {
        for (let x = 0; x < 12; x++) {
          if (!windowCycle(seed, x, y).volatile) continue;
          volatileSeen += 1;
          const { crossings, maxStep } = trace(
            (t) => windowLitLevel(FacadeArchetype.OFFICE, seed, x, y, t),
            P - 600,
            P + 600,
          );
          expect(maxStep).toBeLessThanOrEqual(stepCap);
          for (let i = 1; i < crossings.length; i++) {
            expect(crossings[i] - crossings[i - 1]).toBeGreaterThanOrEqual(20);
          }
          toggles += crossings.length;
        }
      }
    }
    expect(volatileSeen).toBeGreaterThan(100);
    expect(toggles).toBeGreaterThan(50);
  });

  it("moves the crew band floor by floor, slowly, one row at a time", () => {
    const slot = { start: 100, duration: crewVisitSeconds(120), cycle: 900 };
    for (const rowY of [1.5, 20, 64.2, 119]) {
      const { crossings, maxStep } = trace(
        (t) => crewLevel(slot, rowY, t),
        0,
        1800,
      );
      expect(maxStep).toBeLessThanOrEqual(0.1);
      // Lit once per visit (two visits in 1800 s), for ≥ 20 s each time.
      expect(crossings.length).toBe(4);
      for (let i = 1; i < crossings.length; i++) {
        expect(crossings[i] - crossings[i - 1]).toBeGreaterThanOrEqual(20);
      }
    }
    // Lower rows light first: the band climbs.
    const onAt = (rowY: number) =>
      trace((t) => crewLevel(slot, rowY, t), 0, 900).crossings[0];
    expect(onAt(4)).toBeLessThan(onAt(40));
    expect(onAt(40)).toBeLessThan(onAt(100));
  });

  it("changes a visible share of lit windows over a minute", () => {
    for (const t of [0, 1000, 7170]) {
      let lit = 0;
      let changed = 0;
      for (const seed of seeds(40)) {
        for (let y = 0; y < 30; y++) {
          for (let x = 0; x < 12; x++) {
            const a = windowLitLevel(FacadeArchetype.GLASS, seed, x, y, t);
            const b = windowLitLevel(
              FacadeArchetype.GLASS,
              seed,
              x,
              y,
              (t + 60) % P,
            );
            if (a > 0.5) lit += 1;
            if (Math.abs(a - b) > 0.5) changed += 1;
          }
        }
      }
      expect(changed / lit).toBeGreaterThan(0.08);
    }
  });

  it("puts a TV in at most 3% of lit windows, peaking below the WINDOW rung", () => {
    let lit = 0;
    let tv = 0;
    for (const seed of seeds(60)) {
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 12; x++) {
          if (windowLitLevel(FacadeArchetype.MASONRY, seed, x, y, 900) <= 0.5)
            continue;
          lit += 1;
          if (isTvWindow(seed, x, y)) tv += 1;
        }
      }
    }
    expect(tv).toBeGreaterThan(0);
    expect(tv / lit).toBeLessThanOrEqual(0.03);
    // Amplitude: the brightest the flicker can get, at the real boost.
    const peak =
      luminance(TV_COLOR) * TV_GAIN_MAX * Number(WINDOW_EMISSIVE_INTENSITY);
    expect(peak).toBeLessThan(EMISSIVE_WINDOW);
    for (const [, hz] of LIVE.tvWobble) expect(hz).toBeLessThanOrEqual(3);
    for (let t = 0; t < 120; t += 0.05) {
      const g = tvGain(seeds(1)[0], 3, 4, t);
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThanOrEqual(TV_GAIN_MAX);
    }
  });

  it("only darkens lit blinds with silhouettes, and only now and then", () => {
    let crossings = 0;
    let lo = 1;
    let hi = 0;
    let gatedOff = true;
    for (const seed of seeds(10)) {
      for (let x = 0; x < 12; x++) {
        const blinds = hasBlinds(FacadeArchetype.MASONRY, seed, x, 2);
        let seen = false;
        for (let t = 0; t < 300; t += 0.5) {
          for (const u of [0.2, 0.5, 0.8]) {
            const f = silhouetteFactor(seed, x, 2, t, u, 0.4, blinds, 1);
            lo = Math.min(lo, f);
            hi = Math.max(hi, f);
            if (f < 0.9) seen = true;
            // No silhouette on an open window or an unlit one.
            if (
              silhouetteFactor(seed, x, 2, t, u, 0.4, false, 1) !== 1 ||
              silhouetteFactor(seed, x, 2, t, u, 0.4, blinds, 0) !== 1
            )
              gatedOff = false;
          }
        }
        if (seen) crossings += 1;
      }
    }
    expect(lo).toBeGreaterThanOrEqual(1 - LIVE.silDark - 1e-9);
    expect(hi).toBeLessThanOrEqual(1);
    expect(gatedOff).toBe(true);
    expect(crossings).toBeGreaterThan(0);
  });

  it("sends the crew to one building per block at a time, seamlessly", () => {
    const city = generateCity(CITY_SEED);
    const rota = crewSchedule(city, CITY_SEED);
    expect(rota.size).toBeGreaterThan(city.length * 0.5);
    const byCycle = new Map<string, { start: number; end: number }[]>();
    for (const [b, slot] of rota) {
      expect(LIVE.period % slot.cycle).toBe(0);
      expect(slot.duration).toBeCloseTo(crewVisitSeconds(b.height), 9);
      expect(slot.start).toBeGreaterThanOrEqual(0);
      expect(slot.start).toBeLessThan(slot.cycle);
      const key = `${Math.floor(b.x / 200)},${Math.floor(b.z / 200)}`;
      const list = byCycle.get(key) ?? [];
      list.push({ start: slot.start, end: slot.start + slot.duration });
      byCycle.set(key, list);
    }
    for (const [key, visits] of byCycle) {
      const slot = [...rota].find(
        ([b]) => `${Math.floor(b.x / 200)},${Math.floor(b.z / 200)}` === key,
      )?.[1];
      const cycle = slot?.cycle ?? 0;
      // Unwrap onto [0, 2·cycle) and check no two visits (ramps included —
      // crewLevel is 0 outside [start, start+duration)) overlap.
      const spans = visits
        .flatMap((v) => [v, { start: v.start + cycle, end: v.end + cycle }])
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
      }
    }
    // The same city and seed always give the same rota (every client).
    const again = crewSchedule(generateCity(CITY_SEED), CITY_SEED);
    expect([...again.values()]).toEqual([...rota.values()]);
  });

  it("is a pure function of the clock (deterministic, no Math.random)", () => {
    const seed = seeds(3)[2];
    for (const t of [0, 61.25, 7199.9]) {
      expect(windowLitLevel(FacadeArchetype.GLASS, seed, 4, 9, t)).toBe(
        windowLitLevel(FacadeArchetype.GLASS, seed, 4, 9, t),
      );
      expect(tvGain(seed, 4, 9, t)).toBe(tvGain(seed, 4, 9, t));
    }
    const src = readFileSync(
      new URL("../src/render/living-windows.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("Math.random");
    expect(liveClockSeconds(1_760_000_000.5)).toBeGreaterThanOrEqual(0);
    expect(liveClockSeconds(1_760_000_000.5)).toBeLessThan(P);
  });

  it("runs a live clock that snaps once, then slews instead of popping", () => {
    const c = new LiveClock();
    expect(c.update(null, 0)).toBe(0); // before the first snapshot: hold
    const base = 1_760_000_000_000; // epoch ms, like the server's
    const t0 = c.update(base, 16);
    expect(t0).toBeCloseTo(liveClockSeconds(base / 1000), 6);
    // A 2 s re-sync step: the clock moves at most 1.1× real time.
    let prev = t0;
    for (let i = 1; i <= 60; i++) {
      const t = c.update(base + i * 16 + 2000, 16 + i * 16);
      expect(t - prev).toBeLessThanOrEqual(0.016 * (1 + LIVE.slew) + 1e-6);
      expect(t - prev).toBeGreaterThanOrEqual(0.016 * (1 - LIVE.slew) - 1e-6);
      prev = t;
    }
    // A jump past LIVE.snap snaps; a QA pin overrides.
    expect(c.update(base + 60_000, 1000)).toBeCloseTo(
      liveClockSeconds(base / 1000 + 60),
      6,
    );
    c.pinned = 123;
    expect(c.update(base + 60_016, 1016)).toBe(123);
  });

  it("splices the live clock and crew slot into the patched shader", () => {
    const { fragmentPars, fragmentColor, fragmentEmissive, vertexPars } =
      BUILDING_SHADER_SOURCE;
    expect(fragmentPars).toContain("uniform float uLiveTime;");
    expect(vertexPars).toContain("attribute vec4 aCrew;");
    expect(fragmentColor).toContain("liveCrew");
    expect(fragmentEmissive).toContain("liveTvPh");
    expect(fragmentEmissive).toContain("liveFig");
    const live = { value: 42 };
    const m = createBuildingsMaterial(live);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: "#include <common>\n#include <begin_vertex>",
      fragmentShader: "#include <common>\n#include <color_fragment>",
    };
    m.onBeforeCompile(
      shader as unknown as Parameters<typeof m.onBeforeCompile>[0],
      undefined as unknown as Parameters<typeof m.onBeforeCompile>[1],
    );
    expect(shader.uniforms.uLiveTime).toBe(live);
  });
});
