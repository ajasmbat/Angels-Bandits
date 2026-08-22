import {
  BLOCK_PITCH,
  BUILDING_MAX_HEIGHT,
  BUILDING_MIN_HEIGHT,
  EMISSIVE_BEACON,
  EMISSIVE_LAMP,
  EMISSIVE_SIGN,
  EMISSIVE_TRACER,
  EMISSIVE_WINDOW,
  FOG_DISTANCE,
  LANDMARK_HEIGHT,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";

describe("world constants invariants", () => {
  it("BLOCK_PITCH divides WORLD_SIZE evenly, so the street grid tiles across the torus seam", () => {
    expect(WORLD_SIZE % BLOCK_PITCH).toBe(0);
  });

  it("fog distance stays under half the world size, so two torus images of one object are never both visible", () => {
    expect(FOG_DISTANCE).toBeLessThan(WORLD_SIZE / 2);
  });

  it("pins the spec's map values (PLAN.md: 2 km world, 200 m block pitch)", () => {
    expect(WORLD_SIZE).toBe(2000);
    expect(BLOCK_PITCH).toBe(200);
  });

  it("orders building heights: min < max < landmark", () => {
    expect(BUILDING_MIN_HEIGHT).toBeLessThan(BUILDING_MAX_HEIGHT);
    expect(BUILDING_MAX_HEIGHT).toBeLessThan(LANDMARK_HEIGHT);
  });
});

describe("emissive ladder", () => {
  it("is strictly increasing: window < sign < lamp < beacon < tracer", () => {
    expect(EMISSIVE_WINDOW).toBeLessThan(EMISSIVE_SIGN);
    expect(EMISSIVE_SIGN).toBeLessThan(EMISSIVE_LAMP);
    expect(EMISSIVE_LAMP).toBeLessThan(EMISSIVE_BEACON);
    expect(EMISSIVE_BEACON).toBeLessThan(EMISSIVE_TRACER);
  });

  it("keeps every rung above the V1 bloom threshold (0.72) — these are the things that bloom", () => {
    expect(EMISSIVE_WINDOW).toBeGreaterThan(0.72);
  });
});
