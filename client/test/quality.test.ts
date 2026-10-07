// M3 mobile tier selection on top of O3's quality tiers (render/quality.ts):
// Auto's start tier from M2's coarse-pointer rule (ui/mobile.ts), the
// thermal step-down below Mobile, and the per-feature table's contract that
// Mobile is the cheapest tier on every knob.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_PRESSURE_MS,
  AUTO_SETTLE_MS,
  FEATURE_TIERS,
  MOBILE_FRAME_BUDGET_MS,
  QUALITY_PROFILES,
  type QualityProfile,
  type QualityTier,
  THERMAL_MAX_LEVEL,
  THERMAL_PRESSURE_MS,
  THERMAL_SETTLE_MS,
  type ThermalState,
  autoStartTier,
  bloomOn,
  createAutoQuality,
  createThermal,
  interruptThermal,
  qualityLimits,
  stepAutoQuality,
  stepThermal,
  thermalCeiling,
  tierBudgetMs,
  tierMissMs,
} from "../src/render/quality";
import {
  FRAME_BUDGET_MS,
  MISS_MS,
  RESOLUTION_FLOOR,
} from "../src/render/resolution";
import { coarsePointer } from "../src/ui/mobile";

/** The scaler's cadence (main.ts's RES_EVAL_MS). */
const TICK_MS = 250;
const TIERS: readonly QualityTier[] = ["high", "medium", "low", "mobile"];

/** Window inputs that are pressure on any tier: every frame misses and the
 * scaler is on its floor, so pixels cannot help. */
const PRESSURE = { missShare: 1, ratio: RESOLUTION_FLOOR, cpuMs: 0 };
const CALM = { missShare: 0, ratio: RESOLUTION_FLOOR, cpuMs: 0 };

const thermalTick = (
  s: ThermalState,
  now: number,
  w: { missShare: number; ratio: number; cpuMs: number },
): ThermalState => stepThermal(s, w.missShare, w.ratio, w.cpuMs, now);

describe("Auto start tier — mobile vs desktop", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const withMatchMedia = (matchMedia: unknown) =>
    vi.stubGlobal("window", { matchMedia });

  it("a coarse primary pointer (phone, tablet) starts Auto at Mobile", () => {
    withMatchMedia((q: string) => ({ matches: q === "(pointer: coarse)" }));
    expect(coarsePointer()).toBe(true);
    expect(autoStartTier(coarsePointer())).toBe("mobile");
  });

  it("a fine primary pointer (desktop, touchscreen laptop) starts at High", () => {
    withMatchMedia(() => ({ matches: false }));
    expect(coarsePointer()).toBe(false);
    expect(autoStartTier(coarsePointer())).toBe("high");
  });

  it("a throwing or missing matchMedia is a desktop", () => {
    withMatchMedia(() => {
      throw new Error("not supported");
    });
    expect(coarsePointer()).toBe(false);
    withMatchMedia(undefined);
    expect(coarsePointer()).toBe(false);
    vi.unstubAllGlobals();
    // No window at all (the node env itself): still a desktop.
    expect(coarsePointer()).toBe(false);
  });

  it("Auto started on Mobile stays Mobile under unbroken pressure", () => {
    let s = createAutoQuality(0, autoStartTier(true));
    expect(s.tier).toBe("mobile");
    const budget = tierBudgetMs("mobile");
    for (let now = 0; now <= 120_000; now += TICK_MS) {
      s = stepAutoQuality(s, 1, RESOLUTION_FLOOR, 0, now, budget);
      expect(s.tier).toBe("mobile");
    }
  });

  it("desktop Auto starts High and only steps down to Low, never to Mobile", () => {
    let s = createAutoQuality(0, autoStartTier(false));
    expect(s.tier).toBe("high");
    const seen: QualityTier[] = [s.tier];
    for (let now = 0; now <= 120_000; now += TICK_MS) {
      const next = stepAutoQuality(s, 1, RESOLUTION_FLOOR, 0, now);
      if (next.tier !== s.tier) seen.push(next.tier);
      s = next;
    }
    expect(seen).toEqual(["high", "medium", "low"]);
    // The first drop waits out the settle window plus unbroken pressure.
    let t = createAutoQuality(0);
    for (let now = 0; now < AUTO_SETTLE_MS + AUTO_PRESSURE_MS; now += TICK_MS) {
      t = stepAutoQuality(t, 1, RESOLUTION_FLOOR, 0, now);
    }
    expect(t.tier).toBe("high");
    t = stepAutoQuality(
      t,
      1,
      RESOLUTION_FLOOR,
      0,
      AUTO_SETTLE_MS + AUTO_PRESSURE_MS,
    );
    expect(t.tier).toBe("medium");
  });
});

describe("Mobile frame budget", () => {
  it("steers Mobile to 30 fps and every other tier to 60", () => {
    expect(tierBudgetMs("mobile")).toBe(MOBILE_FRAME_BUDGET_MS);
    expect(MOBILE_FRAME_BUDGET_MS).toBeCloseTo(1000 / 30, 9);
    for (const t of ["high", "medium", "low"] as const) {
      expect(tierBudgetMs(t)).toBe(FRAME_BUDGET_MS);
      expect(tierMissMs(t)).toBeCloseTo(MISS_MS, 9);
    }
    expect(tierMissMs("mobile")).toBeCloseTo(MOBILE_FRAME_BUDGET_MS * 1.5, 9);
  });
});

describe("thermal step-down", () => {
  /** Run unbroken pressure from 0 to `until` (inclusive) on the scaler's
   * cadence; returns the final state and the clock of every step. */
  function sustain(until: number, start = createThermal(0)) {
    let s = start;
    const steps: number[] = [];
    for (let now = 0; now <= until; now += TICK_MS) {
      const next = thermalTick(s, now, PRESSURE);
      if (next.level !== s.level) steps.push(now);
      s = next;
    }
    return { s, steps };
  }

  it("first steps only after the settle window plus unbroken pressure", () => {
    const edge = THERMAL_SETTLE_MS + THERMAL_PRESSURE_MS;
    expect(sustain(edge - TICK_MS).s.level).toBe(0);
    const { s, steps } = sustain(edge);
    expect(s.level).toBe(1);
    expect(steps).toEqual([edge]);
  });

  it("takes at most one step per window and caps at THERMAL_MAX_LEVEL", () => {
    const { s, steps } = sustain(30 * 60_000);
    expect(s.level).toBe(THERMAL_MAX_LEVEL);
    expect(steps).toHaveLength(THERMAL_MAX_LEVEL);
    for (let i = 1; i < steps.length; i++) {
      const gap = (steps[i] as number) - (steps[i - 1] as number);
      expect(gap).toBeGreaterThanOrEqual(
        THERMAL_SETTLE_MS + THERMAL_PRESSURE_MS,
      );
    }
  });

  it("never steps back up when the pressure lifts (no oscillation)", () => {
    let { s } = sustain(THERMAL_SETTLE_MS + THERMAL_PRESSURE_MS);
    expect(s.level).toBe(1);
    const start = THERMAL_SETTLE_MS + THERMAL_PRESSURE_MS + TICK_MS;
    for (let now = start; now < start + 10 * 60_000; now += TICK_MS) {
      s = thermalTick(s, now, CALM);
      expect(s.level).toBe(1);
    }
  });

  it("flapping pressure never steps: the run must be unbroken", () => {
    let s = createThermal(0);
    for (let now = 0; now <= 10 * 60_000; now += TICK_MS) {
      const bad = Math.floor(now / 5000) % 2 === 0; // 5 s on, 5 s off
      s = thermalTick(s, now, bad ? PRESSURE : CALM);
      expect(s.level).toBe(0);
    }
  });

  it("a transient (interrupt) restarts the pressure clock", () => {
    let s = createThermal(0);
    const settled = THERMAL_SETTLE_MS;
    for (
      let now = settled;
      now < settled + THERMAL_PRESSURE_MS - TICK_MS;
      now += TICK_MS
    ) {
      s = thermalTick(s, now, PRESSURE);
    }
    s = interruptThermal(s);
    expect(s.pressureSince).toBeNull();
    const resumed = settled + THERMAL_PRESSURE_MS;
    s = thermalTick(s, resumed, PRESSURE);
    expect(s.level).toBe(0);
    s = thermalTick(s, resumed + THERMAL_PRESSURE_MS, PRESSURE);
    expect(s.level).toBe(1);
  });

  it("misses are not pressure while pixels can still help", () => {
    let s = createThermal(0);
    for (let now = 0; now <= 10 * 60_000; now += TICK_MS) {
      s = stepThermal(s, 1, 1.25, 0, now);
    }
    expect(s.level).toBe(0);
  });

  it("judges CPU-bound against Mobile's 30 fps budget, not 60", () => {
    // 20 ms of JS is CPU-bound at 60 fps but not at 30: pixels can still help.
    let s = createThermal(0);
    for (let now = 0; now <= 10 * 60_000; now += TICK_MS) {
      s = stepThermal(s, 1, 2, 20, now);
    }
    expect(s.level).toBe(0);
    // ...while most of the 30 fps budget in JS is pressure at any ratio.
    let t = createThermal(0);
    for (
      let now = 0;
      now <= THERMAL_SETTLE_MS + THERMAL_PRESSURE_MS;
      now += TICK_MS
    ) {
      t = stepThermal(t, 1, 2, MOBILE_FRAME_BUDGET_MS * 0.9, now);
    }
    expect(t.level).toBe(1);
  });

  it("each level only makes things cheaper: bloom off, then a lower pixel cap", () => {
    expect(thermalCeiling(0)).toBe(Number.POSITIVE_INFINITY);
    expect(thermalCeiling(1)).toBe(1);
    expect(thermalCeiling(2)).toBe(RESOLUTION_FLOOR);
    // Out-of-range and fractional levels clamp/floor onto a real level.
    expect(thermalCeiling(-1)).toBe(thermalCeiling(0));
    expect(thermalCeiling(1.9)).toBe(thermalCeiling(1));
    expect(thermalCeiling(99)).toBe(thermalCeiling(THERMAL_MAX_LEVEL));

    expect(bloomOn("mobile", 0)).toBe(true);
    expect(bloomOn("mobile", 1)).toBe(false);
    expect(bloomOn("mobile", 2)).toBe(false);

    const dpr = 3; // a phone panel
    const ceilings = [0, 1, 2].map(
      (l) => qualityLimits(dpr, "mobile", l).ceiling,
    );
    expect(ceilings).toEqual([1, 1, RESOLUTION_FLOOR]);
    for (const l of [0, 1, 2]) {
      const lim = qualityLimits(dpr, "mobile", l);
      expect(lim.floor).toBeLessThanOrEqual(lim.ceiling);
    }
  });
});

describe("per-feature table — Mobile is defined and cheapest", () => {
  const RANK = { off: 0, reduced: 1, full: 2 } as const;

  it("every feature has a defined Mobile behaviour", () => {
    expect(FEATURE_TIERS.length).toBeGreaterThan(0);
    for (const row of FEATURE_TIERS) {
      expect(Object.keys(RANK)).toContain(row.mobile);
      expect(row.note.length).toBeGreaterThan(0);
    }
  });

  it("no feature gets richer as the tier gets cheaper", () => {
    for (const row of FEATURE_TIERS) {
      const ranks = TIERS.map((t) => RANK[row[t]]);
      for (let i = 1; i < ranks.length; i++) {
        expect(ranks[i], `${row.feature} @ ${TIERS[i]}`).toBeLessThanOrEqual(
          ranks[i - 1] as number,
        );
      }
    }
  });

  it("every profile knob is monotone High ≥ Medium ≥ Low ≥ Mobile", () => {
    const keys = Object.keys(QUALITY_PROFILES.high) as (keyof QualityProfile)[];
    for (const k of keys) {
      const vals = TIERS.map((t) => Number(QUALITY_PROFILES[t][k]));
      for (let i = 1; i < vals.length; i++) {
        expect(vals[i], `${k} @ ${TIERS[i]}`).toBeLessThanOrEqual(
          vals[i - 1] as number,
        );
      }
    }
  });

  it("Mobile is its own tier, strictly cheaper than Low somewhere", () => {
    expect(QUALITY_PROFILES.mobile).not.toEqual(QUALITY_PROFILES.low);
    expect(FEATURE_TIERS.some((r) => RANK[r.mobile] < RANK[r.low])).toBe(true);
  });

  it("the table agrees with the profile knobs it describes", () => {
    const full = QUALITY_PROFILES.high;
    /** Feature-name prefix → the knobs behind it. */
    const knobs: Record<string, (keyof QualityProfile)[]> = {
      "L1 reactive city — smoke": ["smokeColumns"],
      "L1 street life — pedestrians": ["crowdDensity"],
      "L1 street life — steam": ["steamDensity", "microRadius"],
      "L3 living windows": ["livingWindows"],
      "L4 rain streaks": ["rainDensity"],
      "L6 headlight cones": ["headlightCones"],
      "L7 signage animation": ["signAnimation"],
      "L7 sign light spill": ["signSpill"],
      "L8 rooftop string lights": ["rooftopLights"],
      "L9 tree sway": ["treeSway"],
      "L9 fountains": ["fountains"],
      "L9 birds": ["birds"],
      "L10 airliners": ["contrails"],
      "L13 facade detail": ["facadeDetail"],
      Bloom: ["bloom"],
      "Final grade": ["grade"],
      "Window interiors": ["windowInteriors"],
    };
    const behaviour = (t: QualityTier, ks: (keyof QualityProfile)[]) => {
      const shares = ks.map(
        (k) => Number(QUALITY_PROFILES[t][k]) / Number(full[k]),
      );
      if (shares.every((v) => v === 1)) return "full";
      if (shares.every((v) => v === 0)) return "off";
      return "reduced";
    };
    let matched = 0;
    for (const [prefix, ks] of Object.entries(knobs)) {
      const row = FEATURE_TIERS.find((r) => r.feature.startsWith(prefix));
      expect(row, prefix).toBeDefined();
      if (!row) continue;
      matched++;
      for (const t of TIERS) {
        expect(row[t], `${row.feature} @ ${t}`).toBe(behaviour(t, ks));
      }
    }
    expect(matched).toBe(Object.keys(knobs).length);
  });
});
