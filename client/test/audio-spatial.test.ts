// Audio spatialization seam: pure pan/gain math over wrapDelta, plus the
// closest-approach distance behind the near-miss whoosh. Conventions under
// test: yaw 0 faces −Z (north) and a right turn decreases yaw, so east of a
// north-facing listener is hard right (pan +1). Gain reference distance is
// 30 m (full volume), inverse falloff, silent beyond FOG_DISTANCE (800 m).

import { describe, expect, it } from "vitest";
import { closestApproach, spatialize } from "../src/audio/spatial";

const LISTENER = { x: 1000, y: 300, z: 1000 };

describe("spatialize", () => {
  it("pans a source 100 m east of a north-facing listener hard right at gain 0.3", () => {
    const s = spatialize(LISTENER, 0, { x: 1100, y: 300, z: 1000 });
    expect(s.pan).toBeCloseTo(1);
    expect(s.gain).toBeCloseTo(0.3);
  });

  it("keeps a source dead ahead centered", () => {
    const s = spatialize(LISTENER, 0, { x: 1000, y: 300, z: 900 });
    expect(s.pan).toBeCloseTo(0);
  });

  it("follows the listener's yaw: facing east (yaw −π/2), a source south is hard right", () => {
    const s = spatialize(LISTENER, -Math.PI / 2, { x: 1000, y: 300, z: 1100 });
    expect(s.pan).toBeCloseTo(1);
  });

  it("is seam-safe: 100 m east across the x edge pans right, never left", () => {
    const s = spatialize({ x: 1950, y: 300, z: 100 }, 0, {
      x: 50,
      y: 300,
      z: 100,
    });
    expect(s.pan).toBeCloseTo(1);
    expect(s.gain).toBeCloseTo(0.3);
  });

  it("clamps gain to 1 up close and to 0 beyond the fog distance", () => {
    expect(spatialize(LISTENER, 0, { x: 1010, y: 300, z: 1000 }).gain).toBe(1);
    expect(spatialize(LISTENER, 0, { x: 1000, y: 300, z: 100 }).gain).toBe(0);
  });
});

describe("closestApproach", () => {
  it("measures a bullet passing 5 m abeam", () => {
    const d = closestApproach(
      { x: 995, y: 300, z: 900 },
      { x: 995, y: 300, z: 1100 },
      LISTENER,
    );
    expect(d).toBeCloseTo(5);
  });

  it("does not extrapolate: a bullet stopping 50 m short reads 50 m", () => {
    const d = closestApproach(
      { x: 1000, y: 300, z: 900 },
      { x: 1000, y: 300, z: 950 },
      LISTENER,
    );
    expect(d).toBeCloseTo(50);
  });

  it("sweeps across the seam: a pass 8 m abeam at the x edge reads 8 m", () => {
    const d = closestApproach(
      { x: 1990, y: 300, z: 100 },
      { x: 10, y: 300, z: 100 },
      { x: 0, y: 300, z: 108 },
    );
    expect(d).toBeCloseTo(8);
  });
});
