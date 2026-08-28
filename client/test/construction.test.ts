// The L1 construction seam: the site list (built and ordered ONCE, never at
// draw time) and the ballistic spark arcs. The welders share the L2 macro
// tier's CONSTRUCTION_BLOCKS, so a crew is always under a crane.

import { CONSTRUCTION_BLOCKS } from "@angels-bandits/common/city";
import { isInRoadway } from "@angels-bandits/common/city/street";
import {
  EMISSIVE_BEACON,
  EMISSIVE_TRACER,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  BURST_DUTY,
  SPARKS_PER_BURST,
  constructionSites,
  sparkBurst,
  sparkPose,
} from "../src/render/construction";

const SEED = 42;

describe("constructionSites", () => {
  const sites = constructionSites(SEED);

  it("is deterministic and seed-dependent", () => {
    expect(JSON.stringify(constructionSites(SEED))).toBe(JSON.stringify(sites));
    expect(JSON.stringify(constructionSites(SEED + 1))).not.toBe(
      JSON.stringify(sites),
    );
  });

  it("puts a crew on every construction block, and only on those blocks", () => {
    expect(sites.length).toBeGreaterThan(0);
    // The single source of truth the L2 cranes also stand on — a private roll
    // here would scatter welders onto blocks with no crane above them.
    const blocks = new Set(sites.map((s) => `${s.bx},${s.bz}`));
    expect(blocks).toEqual(
      new Set(CONSTRUCTION_BLOCKS.map(([bx, bz]) => `${bx},${bz}`)),
    );
  });

  it("stands every welder on the pavement, never in the roadway", () => {
    for (const s of sites) {
      expect(isInRoadway({ x: s.x, y: 0, z: s.z })).toBe(false);
    }
  });

  it("keeps crews on a block apart, and gives each a sane burst period", () => {
    // Two welders standing on the same paving slab would read as one.
    const spots = sites.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`);
    expect(new Set(spots).size).toBe(sites.length);
    for (const s of sites) {
      expect(s.period).toBeGreaterThanOrEqual(3);
      expect(s.period).toBeLessThanOrEqual(7);
      expect(s.phase).toBeGreaterThanOrEqual(0);
      expect(s.phase).toBeLessThan(1);
    }
  });
});

describe("sparkBurst", () => {
  const site = constructionSites(SEED)[0];

  it("has a site to test", () => {
    expect(site).toBeDefined();
  });

  it("strikes for the intended duty fraction of the period", () => {
    if (!site) return;
    let active = 0;
    let samples = 0;
    for (let t = 0; t < 600; t += 0.01) {
      samples++;
      if (sparkBurst(site, t).active) active++;
    }
    expect(active / samples).toBeCloseTo(BURST_DUTY, 2);
  });

  it("reports an age inside the burst window, and 0 outside it", () => {
    if (!site) return;
    for (let t = 0; t < 60; t += 0.017) {
      const b = sparkBurst(site, t);
      if (b.active) {
        expect(b.age).toBeGreaterThanOrEqual(0);
        expect(b.age).toBeLessThanOrEqual(BURST_DUTY * site.period + 1e-9);
      } else {
        expect(b.age).toBe(0);
      }
    }
  });

  it("repeats exactly one period later, and survives a negative clock", () => {
    if (!site) return;
    for (const t of [0.05, 1.4, 2.9]) {
      const now = sparkBurst(site, t);
      const next = sparkBurst(site, t + site.period);
      expect(next.active).toBe(now.active);
      expect(next.age).toBeCloseTo(now.age, 9);
    }
    expect(sparkBurst(site, -1).active).toBe(
      sparkBurst(site, site.period - 1).active,
    );
  });
});

describe("sparkPose", () => {
  const site = constructionSites(SEED)[0];

  it("is deterministic within a burst", () => {
    if (!site) return;
    const t = site.period * 4 + 0.01;
    const a = Array.from({ length: SPARKS_PER_BURST }, (_, i) =>
      sparkPose(site, i, 0.1, t),
    );
    const b = Array.from({ length: SPARKS_PER_BURST }, (_, i) =>
      sparkPose(site, i, 0.1, t),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts every spark at the arc and throws it outward", () => {
    if (!site) return;
    for (let i = 0; i < SPARKS_PER_BURST; i++) {
      const at0 = sparkPose(site, i, 0, 1);
      expect(at0.pos.x).toBeCloseTo(site.x, 9);
      expect(at0.pos.z).toBeCloseTo(site.z, 9);
      expect(at0.pos.y).toBeCloseTo(site.y, 9);
      expect(at0.life).toBe(0);
      const later = sparkPose(site, i, 0.15, 1);
      expect(
        Math.hypot(later.pos.x - site.x, later.pos.z - site.z),
      ).toBeGreaterThan(0);
      expect(later.life).toBeGreaterThan(0);
    }
  });

  it("never sinks a spark through the pavement", () => {
    if (!site) return;
    for (let i = 0; i < SPARKS_PER_BURST; i++) {
      for (let age = 0; age < 1; age += 0.01) {
        expect(sparkPose(site, i, age, 1).pos.y).toBeGreaterThan(0);
      }
    }
  });

  it("throws a different fan each burst", () => {
    if (!site) return;
    const first = sparkPose(site, 0, 0.1, 0.01);
    const later = sparkPose(site, 0, 0.1, site.period * 3 + 0.01);
    expect(first.pos.x).not.toBeCloseTo(later.pos.x, 6);
  });
});

describe("the emissive ladder", () => {
  it("keeps the welding arc on the beacon rung, under tracers", () => {
    expect(EMISSIVE_BEACON).toBeLessThan(EMISSIVE_TRACER);
  });
});
