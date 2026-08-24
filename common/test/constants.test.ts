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
  FIRE_BURST_SLACK,
  FIRE_INTERVAL_MS,
  FOG_DISTANCE,
  HEAT_PER_SHOT,
  HEAT_VALIDATION_SLACK,
  HIT_ORIGIN_SLACK,
  INTERP_DELAY_MAX_MS,
  INTERP_FLOOR_MS,
  LANDMARK_HEIGHT,
  MAX_SPEED,
  POSE_DISTANCE_SLACK,
  SNAPSHOT_INTERVAL_MS,
  SPEED_TOLERANCE,
  TICK_DOWN_HZ,
  TICK_UP_HZ,
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

// ANGE-4KO2W2 raised TICK_DOWN_HZ, which is the cadence every jitter-compensation
// constant in the file was originally tuned against. The range slack became a
// derivation (common/src/net.ts, proved in net.test.ts); the four below were
// reviewed and left alone — these pin WHY, so the next cadence change has to
// re-answer the question rather than assume the review still holds.
describe("jitter-compensation constants at the current cadence", () => {
  /** Fastest a legally-flying plane can be moving, m/s. */
  const topSpeed = MAX_SPEED * SPEED_TOLERANCE;
  /** How far it travels between two client → server pose updates, m. */
  const travelPerUpTick = (topSpeed * 1000) / TICK_UP_HZ / 1000;

  it("keeps the interpolation floor at or above one snapshot interval", () => {
    expect(INTERP_FLOOR_MS).toBeGreaterThanOrEqual(SNAPSHOT_INTERVAL_MS);
    expect(INTERP_DELAY_MAX_MS).toBeGreaterThan(INTERP_FLOOR_MS);
    expect(SNAPSHOT_INTERVAL_MS).toBeCloseTo(1000 / TICK_DOWN_HZ, 12);
  });

  it("HIT_ORIGIN_SLACK is a TICK_UP_HZ question, and still covers many up-ticks", () => {
    // It bounds how stale the SHOOTER's own pose can be. The shooter's plane
    // is never interpolated, so the snapshot cadence does not enter it — but
    // it must still cover several pose updates plus the trip to the server.
    expect(travelPerUpTick).toBeCloseTo(4.95, 6);
    expect(HIT_ORIGIN_SLACK).toBeGreaterThan(4 * travelPerUpTick);
  });

  it("POSE_DISTANCE_SLACK still covers a full up-tick of legal travel", () => {
    expect(POSE_DISTANCE_SLACK).toBeGreaterThan(travelPerUpTick);
  });

  it("FIRE_BURST_SLACK still covers the shots one up-tick can batch", () => {
    const shotsPerUpTick = 1000 / TICK_UP_HZ / FIRE_INTERVAL_MS;
    expect(FIRE_BURST_SLACK).toBeGreaterThan(shotsPerUpTick);
  });

  it("HEAT_VALIDATION_SLACK still covers a snapshot interval of clock skew", () => {
    // Heat is wall-clock driven on both sides, so no tick cadence enters it;
    // the slack only has to absorb skew, and one snapshot interval of it is
    // the generous bound.
    const heatPerSnapshotInterval =
      HEAT_PER_SHOT * (SNAPSHOT_INTERVAL_MS / FIRE_INTERVAL_MS);
    expect(HEAT_VALIDATION_SLACK).toBeGreaterThan(heatPerSnapshotInterval);
  });
});
