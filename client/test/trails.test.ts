// Wingtip-trail seam (ticket ANGE-L7F2OS): trail history is stored as
// wrapDelta offsets from the plane's CURRENT canonical position, never as
// world-space points — so a torus seam crossing yields ordinary short
// segments, not a 2 km streak. Worked examples use WORLD_SIZE = 2000 and the
// flight model's TURN_RATE = 0.9 rad/s (a full-deflection turn) as the
// independent sources of truth.

import { TURN_RATE, WORLD_SIZE } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  TRAIL_LIFETIME_MS,
  TrailHistory,
  turnHardness,
} from "../src/render/trails";

/** Quaternion for a rotation of `angle` about +Y (yaw), plain wire shape. */
const yawQuat = (angle: number) => ({
  x: 0,
  y: Math.sin(angle / 2),
  z: 0,
  w: Math.cos(angle / 2),
});

describe("TrailHistory across the torus seam", () => {
  it("a crossing x = WORLD_SIZE−ε → ε produces no segment longer than the true step", () => {
    const h = new TrailHistory();
    // Flying +x at 80 m/s, sampled every 100 ms → true steps of 8 m.
    h.push({ x: WORLD_SIZE - 12, y: 200, z: 500 }, 0, 0);
    h.push({ x: WORLD_SIZE - 4, y: 200, z: 500 }, 100, 0);
    h.push({ x: 4, y: 200, z: 500 }, 200, 0); // crossed the seam
    h.push({ x: 12, y: 200, z: 500 }, 300, 0);
    const pts = h.points(300);
    expect(pts.length).toBe(4);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as (typeof pts)[number];
      const b = pts[i] as (typeof pts)[number];
      const seg = Math.hypot(
        b.off.x - a.off.x,
        b.off.y - a.off.y,
        b.off.z - a.off.z,
      );
      expect(seg).toBeCloseTo(8, 6); // never ~WORLD_SIZE
    }
  });

  it("offsets are relative to the newest sample (the anchor), which stays canonical", () => {
    const h = new TrailHistory();
    h.push({ x: WORLD_SIZE - 4, y: 200, z: 500 }, 0, 0);
    h.push({ x: 4, y: 200, z: 500 }, 100, 0);
    expect(h.anchor).toEqual({ x: 4, y: 200, z: 500 });
    const pts = h.points(100);
    // Newest point sits AT the anchor; the older one 8 m behind on −x.
    expect(pts[1]?.off).toEqual({ x: 0, y: 0, z: 0 });
    expect(pts[0]?.off.x).toBeCloseTo(-8, 6);
  });

  it("prunes points older than TRAIL_LIFETIME_MS and reports age01 in [0, 1]", () => {
    const h = new TrailHistory();
    h.push({ x: 100, y: 200, z: 100 }, 0, 0.5);
    h.push({ x: 108, y: 200, z: 100 }, TRAIL_LIFETIME_MS, 0.5);
    h.push({ x: 116, y: 200, z: 100 }, TRAIL_LIFETIME_MS + 100, 0.5);
    const pts = h.points(TRAIL_LIFETIME_MS + 100);
    expect(pts.length).toBe(2); // the t=0 point aged out
    for (const p of pts) {
      expect(p.age01).toBeGreaterThanOrEqual(0);
      expect(p.age01).toBeLessThanOrEqual(1);
    }
    // Newest point has age 0.
    expect(pts[pts.length - 1]?.age01).toBe(0);
  });

  it("clear() empties the history", () => {
    const h = new TrailHistory();
    h.push({ x: 100, y: 200, z: 100 }, 0, 0);
    h.clear();
    expect(h.points(0)).toEqual([]);
    expect(h.anchor).toBeNull();
  });
});

describe("turnHardness", () => {
  it("is 0 in steady flight (identical orientations)", () => {
    const q = yawQuat(0.4);
    expect(turnHardness(q, q, 1 / 60)).toBe(0);
  });

  it("reaches 1 at the flight model's full-deflection turn rate", () => {
    // TURN_RATE rad/s over one 60 fps frame.
    const dt = 1 / 60;
    expect(turnHardness(yawQuat(0), yawQuat(TURN_RATE * dt), dt)).toBeCloseTo(
      1,
      5,
    );
  });

  it("scales linearly below full deflection: half the rate → 0.5", () => {
    const dt = 1 / 60;
    expect(
      turnHardness(yawQuat(0), yawQuat((TURN_RATE / 2) * dt), dt),
    ).toBeCloseTo(0.5, 5);
  });

  it("clamps rates above full deflection to 1", () => {
    const dt = 1 / 60;
    expect(turnHardness(yawQuat(0), yawQuat(TURN_RATE * 3 * dt), dt)).toBe(1);
  });
});
