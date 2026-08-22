import {
  BLOCK_PITCH,
  BUILDING_MAX_HEIGHT,
  BUILDING_MIN_HEIGHT,
  EMISSIVE_BEACON,
  EMISSIVE_EXHAUST,
  EMISSIVE_LAMP,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_SIGN,
  EMISSIVE_STROBE,
  EMISSIVE_TRACER,
  EMISSIVE_TRAIL,
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
  it("is strictly increasing: window < trail < sign < exhaust < lamp < navlight < beacon < strobe < tracer", () => {
    expect(EMISSIVE_WINDOW).toBeLessThan(EMISSIVE_TRAIL);
    expect(EMISSIVE_TRAIL).toBeLessThan(EMISSIVE_SIGN);
    expect(EMISSIVE_SIGN).toBeLessThan(EMISSIVE_EXHAUST);
    expect(EMISSIVE_EXHAUST).toBeLessThan(EMISSIVE_LAMP);
    expect(EMISSIVE_LAMP).toBeLessThan(EMISSIVE_NAVLIGHT);
    expect(EMISSIVE_NAVLIGHT).toBeLessThan(EMISSIVE_BEACON);
    expect(EMISSIVE_BEACON).toBeLessThan(EMISSIVE_STROBE);
    expect(EMISSIVE_STROBE).toBeLessThan(EMISSIVE_TRACER);
  });

  it("pins the ticket's plane-visibility bounds: trails ≤ 0.9, exhaust ≤ 0.95, strobe peak 1.1, tracers stay maximal", () => {
    expect(EMISSIVE_TRAIL).toBeLessThanOrEqual(0.9);
    expect(EMISSIVE_EXHAUST).toBeLessThanOrEqual(0.95);
    expect(EMISSIVE_STROBE).toBe(1.1);
    expect(EMISSIVE_TRACER).toBe(1.5);
  });

  it("keeps every rung above the V1 bloom threshold (0.72) — these are the things that bloom", () => {
    expect(EMISSIVE_WINDOW).toBeGreaterThan(0.72);
  });
});
