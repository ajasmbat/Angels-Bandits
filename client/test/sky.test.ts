import {
  EMISSIVE_TRACER,
  FOG_DISTANCE,
  LANDMARK_HEIGHT,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  EXPOSURE,
  FOG_NEAR,
  MOON_DIR,
  MOON_PEAK,
  SKY_FOG_STOP,
  STAR_PEAK,
} from "../src/render/sky";

const BLOOM_THRESHOLD = 0.72;

describe("VO1 blue-hour sky", () => {
  it("is fog-coloured everywhere a fully fogged landmark could stand", () => {
    // The gradient's canvas fraction maps to polar angle; 0.5 is the horizon.
    const fogFromElevation = (0.5 - SKY_FOG_STOP) * Math.PI;
    // Worst case: a landmark at the fog limit, seen from the pavement.
    const tallest = Math.atan(LANDMARK_HEIGHT / FOG_DISTANCE);
    expect(fogFromElevation).toBeGreaterThan(tallest);
  });

  it("keeps the linear fog reaching 1 before the torus half-world", () => {
    expect(FOG_NEAR).toBeLessThan(FOG_DISTANCE);
    expect(FOG_NEAR).toBeGreaterThan(0);
  });

  it("puts the moon on the ladder: a soft halo, never a tracer", () => {
    expect(MOON_PEAK).toBeGreaterThan(BLOOM_THRESHOLD);
    expect(MOON_PEAK).toBeLessThan(EMISSIVE_TRACER);
    expect(STAR_PEAK).toBeLessThan(BLOOM_THRESHOLD);
  });

  it("hangs the moon low enough for a chase camera to see it", () => {
    const elevation = Math.asin(MOON_DIR.y);
    expect(elevation).toBeGreaterThan(0.25); // clear of the glow band
    expect(elevation).toBeLessThan(0.6); // inside a level FOV-70 frame
  });

  it("lifts exposure modestly — the ladder, not exposure, carries the night", () => {
    expect(EXPOSURE).toBeGreaterThanOrEqual(1);
    expect(EXPOSURE).toBeLessThan(1.5);
  });
});
