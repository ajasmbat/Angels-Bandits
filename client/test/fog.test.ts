// The haze layer's pure seam: what the GLSL computes, mirrored in TS.
//
// The contract that matters is the torus one: the haze may only ever ADD to
// the linear fog, and the linear fog still reaches 1 at FOG_DISTANCE, so
// nothing is visible past the half-world limit at any altitude.

import { FOG_DISTANCE } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  AB_FOG_GLSL,
  HAZE_DENSITY,
  HAZE_SCALE_HEIGHT,
  combinedFog,
  hazeAmount,
} from "../src/render/fog";

/** three's linear fog factor, as fog_fragment computes it. */
const linear = (near: number, far: number, d: number) => {
  const t = Math.min(1, Math.max(0, (d - near) / (far - near)));
  return t * t * (3 - 2 * t);
};

describe("hazeAmount", () => {
  it("is zero at zero distance and grows with distance", () => {
    expect(hazeAmount(50, 50, 0)).toBe(0);
    let prev = 0;
    for (let d = 10; d <= 1000; d += 10) {
      const h = hazeAmount(50, 50, d);
      expect(h).toBeGreaterThan(prev);
      expect(h).toBeLessThanOrEqual(1);
      prev = h;
    }
  });

  it("is thickest at street level and thins with altitude", () => {
    const street = hazeAmount(20, 20, 300);
    const canyon = hazeAmount(150, 150, 300);
    const high = hazeAmount(400, 400, 300);
    expect(street).toBeGreaterThan(canyon);
    expect(canyon).toBeGreaterThan(high);
    // The look: a canyon at 300 m is noticeably hazed, the sky band is not.
    expect(street).toBeGreaterThan(0.4);
    expect(high).toBeLessThan(0.05);
  });

  it("matches the level-ray formula at street level", () => {
    // Camera and fragment both at y = 0: density is HAZE_DENSITY throughout.
    const d = 250;
    expect(hazeAmount(0, 0, d)).toBeCloseTo(1 - Math.exp(-d * HAZE_DENSITY), 9);
  });

  it("is symmetric in the endpoints (the integral does not care which way)", () => {
    expect(hazeAmount(20, 300, 400)).toBeCloseTo(hazeAmount(300, 20, 400), 9);
  });

  it("is continuous across the level-ray branch", () => {
    const a = hazeAmount(100, 100.4, 300);
    const b = hazeAmount(100, 100.6, 300);
    expect(Math.abs(a - b)).toBeLessThan(1e-3);
  });

  it("clamps altitudes below the ground instead of blowing up", () => {
    expect(hazeAmount(-50, -10, 300)).toBeCloseTo(hazeAmount(0, 0, 300), 9);
    expect(Number.isFinite(hazeAmount(-1e6, 5, 300))).toBe(true);
  });
});

describe("combinedFog: the torus occlusion guarantee", () => {
  it("still dissolves everything at FOG_DISTANCE at every altitude", () => {
    for (const camY of [0, 60, 150, 300, 480]) {
      for (const fragY of [0, 100, 250, 400]) {
        const lin = linear(60, FOG_DISTANCE, FOG_DISTANCE);
        const haze = hazeAmount(camY, fragY, FOG_DISTANCE);
        expect(combinedFog(lin, haze)).toBe(1);
      }
    }
  });

  it("never fogs LESS than the linear fog alone", () => {
    for (let d = 0; d <= FOG_DISTANCE; d += 25) {
      const lin = linear(60, FOG_DISTANCE, d);
      expect(combinedFog(lin, hazeAmount(120, 80, d))).toBeGreaterThanOrEqual(
        lin,
      );
    }
  });
});

describe("the GLSL mirror", () => {
  it("bakes the same constants the TS seam uses", () => {
    expect(AB_FOG_GLSL).toContain(
      `AB_HAZE_H = ${HAZE_SCALE_HEIGHT.toFixed(1)}`,
    );
    expect(AB_FOG_GLSL).toContain(
      `AB_HAZE_DENSITY = ${HAZE_DENSITY.toFixed(5)}`,
    );
    expect(AB_FOG_GLSL).toContain("float abHazeAmount(");
  });
});
