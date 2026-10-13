// D11: dust and smoke stay soft at every distance — never a frame flattened
// to one grey, never a hard black silhouette over the sky. The collapse dust
// keeps its whole cloud under DUST_COVERAGE_MAX of the frame with the camera
// anywhere in it, and its colour under the bloom threshold; the inferno's
// smoke columns fade as the camera nears a puff (on its true size), fall
// off softly to the card's edge, cap their core under opaque, and keep the
// columns under SMOKE_COVERAGE_MAX of the frame.

import { type Building, generateCity } from "@angels-bandits/common/city";
import {
  CollapseField,
  PANCAKE,
  TOPPLE,
  collapseWire,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import { CITY_SEED } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  DUST_COVERAGE_MAX,
  DUST_FOG_LINE,
  DUST_RGB_MAX,
  DustClouds,
} from "../src/render/dust";
import { installHeightFog } from "../src/render/fog";
import {
  SMOKE_ALPHA_MAX,
  SMOKE_COVERAGE_MAX,
  SMOKE_NEAR_FULL,
  SMOKE_NEAR_GONE,
  smokeCoverageScale,
  smokeNearFade,
  smokeShape,
} from "../src/render/inferno";

/** The bloom threshold (post.ts): nothing soft may pass it. */
const BLOOM_THRESHOLD = 0.72;
const CITY = generateCity(CITY_SEED);
const TALLEST = CITY.reduce(
  (best, b, i) =>
    b.height > (CITY[best] as Building).height && !b.holes ? i : best,
  0,
);

describe("D11 collapse dust: a cloud, never a flat frame", () => {
  it("covers at most DUST_COVERAGE_MAX of the frame from anywhere in or around it, all through its life", () => {
    vi.stubGlobal("document", {
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    });
    try {
      for (const style of [PANCAKE, TOPPLE]) {
        const field = new CollapseField();
        field.bind(generateCity(CITY_SEED));
        const b = CITY[TALLEST] as Building;
        const plan = demolitionPlan(b, TALLEST, style, 0);
        if (!plan) throw new Error("nothing to fell");
        const c = field.add(collapseWire(plan, TALLEST, 1, 0));
        if (!c) throw new Error("no collapse");
        const dust = new DustClouds();
        let worst = 0;
        let seen = 0;
        // Eyes inside the cloud, in the street beside it, a block off, far.
        const eyes = [
          { x: b.x, y: 6, z: b.z },
          { x: b.x + b.width / 2 + 15, y: 10, z: b.z },
          { x: b.x + 120, y: 40, z: b.z + 30 },
          { x: b.x - 460, y: 200, z: b.z + 230 },
        ];
        for (const eye of eyes) {
          for (let t = 0; t <= 30_000; t += 500) {
            dust.update([c], eye, t);
            worst = Math.max(worst, dust.coverage.share);
            if (dust.puffCount > 0) seen++;
          }
        }
        expect(seen).toBeGreaterThan(20); // the cloud is really there
        expect(worst).toBeLessThanOrEqual(DUST_COVERAGE_MAX + 1e-9);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads through the distance haze: its fog line is the one the fog chunk computes", () => {
    installHeightFog();
    // The dust squares THIS line's factor; if fog.ts ever renames it the
    // dust would silently fog like everything else.
    expect(THREE.ShaderChunk.fog_fragment).toContain(DUST_FOG_LINE);
  });

  it("is clamped under the bloom threshold, however many puffs stack", () => {
    expect(DUST_RGB_MAX).toBeLessThan(BLOOM_THRESHOLD);
  });
});

describe("D11 smoke columns: soft at every distance", () => {
  it("fades out as the camera comes into a puff, on its true size", () => {
    for (const size of [18, 40, 75, 150]) {
      expect(smokeNearFade(size, 0)).toBe(0);
      expect(smokeNearFade(size, SMOKE_NEAR_GONE * size)).toBe(0);
      expect(smokeNearFade(size, SMOKE_NEAR_FULL * size)).toBe(1);
      // The puff the old clamp left at ~97 % (0.9 × its distance across).
      expect(smokeNearFade(size, size / 0.9)).toBeLessThan(0.5);
    }
  });

  it("falls off softly to nothing at the card's edge, its core under opaque", () => {
    let prev = smokeShape(0, 1);
    expect(prev).toBeLessThanOrEqual(SMOKE_ALPHA_MAX);
    for (let r2 = 0.01; r2 <= 1.0001; r2 += 0.01) {
      const a = smokeShape(r2, 1);
      // Monotone, and no step anywhere: a rim, not a hard silhouette.
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      expect(prev - a).toBeLessThan(0.05);
      prev = a;
    }
    expect(smokeShape(1, 1)).toBe(0);
  });

  it("one puff right beside the camera never covers the sky", () => {
    // Its drawn size is min(size, 0.9 × dist), its alpha the near fade × the
    // core: the share of a 70° × 16:9 frame it can darken, at any distance.
    const t = Math.tan((70 * Math.PI) / 360);
    for (const size of [18, 75, 150]) {
      for (let d = 1; d < 600; d += 1) {
        const drawn = Math.min(size, 0.9 * d);
        const frame = (drawn * drawn) / (4 * d * d * t * t * (16 / 9));
        const dark = frame * smokeNearFade(size, d) * SMOKE_ALPHA_MAX;
        expect(dark).toBeLessThan(0.12);
      }
    }
  });

  it("the columns are held under SMOKE_COVERAGE_MAX of the frame", () => {
    for (const cov of [0, 0.2, 0.5, 0.9, 3, 40]) {
      expect(cov * smokeCoverageScale(cov)).toBeLessThanOrEqual(
        SMOKE_COVERAGE_MAX + 1e-9,
      );
    }
    expect(smokeCoverageScale(0.1)).toBe(1);
  });
});
