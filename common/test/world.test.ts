import { WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  canonicalize,
  wrapDelta,
  wrapDistance,
  wrapLerp,
} from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

// Expected values are worked examples from the ticket plan / PLAN.md,
// not recomputed via the implementation.

describe("canonicalize", () => {
  it("maps x/z into [0, WORLD_SIZE): -5 → 1995 and 2005 → 5", () => {
    expect(canonicalize({ x: -5, y: 100, z: 0 })).toEqual({
      x: 1995,
      y: 100,
      z: 0,
    });
    expect(canonicalize({ x: 2005, y: 100, z: 0 })).toEqual({
      x: 5,
      y: 100,
      z: 0,
    });
  });

  it("wraps z the same way and leaves in-range coordinates untouched", () => {
    expect(canonicalize({ x: 300, y: 50, z: -1 })).toEqual({
      x: 300,
      y: 50,
      z: 1999,
    });
    expect(canonicalize({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("does not wrap y (altitude is linear)", () => {
    expect(canonicalize({ x: 10, y: -20, z: 10 }).y).toBe(-20);
    expect(canonicalize({ x: 10, y: WORLD_SIZE + 500, z: 10 }).y).toBe(
      WORLD_SIZE + 500,
    );
  });

  it("handles multi-wrap inputs: x = -4005 → 1995", () => {
    expect(canonicalize({ x: -4005, y: 0, z: 0 }).x).toBe(1995);
  });
});

describe("wrapDelta", () => {
  // Sign convention: the delta points FROM `from` TOWARD `to` —
  // canonicalize(from + wrapDelta(from, to)) === canonicalize(to).
  it("crosses the seam when that is shorter: from x=1990 to x=10 is +20, not -1980", () => {
    expect(wrapDelta({ x: 1990, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }).x).toBe(
      20,
    );
  });

  it("is antisymmetric across the seam: from x=10 back to x=1990 is -20", () => {
    expect(wrapDelta({ x: 10, y: 0, z: 0 }, { x: 1990, y: 0, z: 0 }).x).toBe(
      -20,
    );
  });

  it("stays direct when not crossing the seam is shorter", () => {
    expect(
      wrapDelta({ x: 100, y: 0, z: 300 }, { x: 700, y: 0, z: 200 }),
    ).toEqual({
      x: 600,
      y: 0,
      z: -100,
    });
  });

  it("wraps z independently of x", () => {
    expect(
      wrapDelta({ x: 500, y: 0, z: 1950 }, { x: 480, y: 0, z: 30 }),
    ).toEqual({
      x: -20,
      y: 0,
      z: 80,
    });
  });

  it("treats y linearly: altitude difference is a plain subtraction", () => {
    expect(wrapDelta({ x: 0, y: 550, z: 0 }, { x: 0, y: 100, z: 0 }).y).toBe(
      -450,
    );
  });

  it("never returns a component larger than half the world", () => {
    const d = wrapDelta({ x: 0, y: 0, z: 0 }, { x: 1000, y: 0, z: 999 });
    expect(Math.abs(d.x)).toBeLessThanOrEqual(WORLD_SIZE / 2);
    expect(Math.abs(d.z)).toBeLessThanOrEqual(WORLD_SIZE / 2);
  });

  it("accepts non-canonical inputs: x=-10 to x=15 is +25", () => {
    expect(wrapDelta({ x: -10, y: 0, z: 0 }, { x: 15, y: 0, z: 0 }).x).toBe(25);
  });
});

describe("wrapDistance", () => {
  it("measures across the seam: x=1990 and x=10 are 20 m apart, not 1980", () => {
    expect(wrapDistance({ x: 1990, y: 0, z: 0 }, { x: 10, y: 0, z: 0 })).toBe(
      20,
    );
  });

  it("includes altitude linearly: 3-4-5 triangle across the seam", () => {
    // seam-wrapped dx = 30 (1990 → 20), dy = 40 → distance 50
    expect(wrapDistance({ x: 1990, y: 0, z: 0 }, { x: 20, y: 40, z: 0 })).toBe(
      50,
    );
  });

  it("is symmetric", () => {
    const a = { x: 1995, y: 120, z: 40 };
    const b = { x: 25, y: 80, z: 1990 };
    expect(wrapDistance(a, b)).toBe(wrapDistance(b, a));
  });
});

describe("wrapLerp", () => {
  it("interpolates across the seam: x=1990 → x=10 at t=0.5 lands on x=0, never ~1000", () => {
    const mid = wrapLerp({ x: 1990, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0.5);
    expect(mid.x).toBe(0);
  });

  it("returns canonical coordinates just past the seam: t=0.25 from x=1990 gives x=1995", () => {
    expect(
      wrapLerp({ x: 1990, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0.25).x,
    ).toBe(1995);
  });

  it("matches the endpoints (canonicalized) at t=0 and t=1", () => {
    const a = { x: 1990, y: 100, z: 50 };
    const b = { x: 10, y: 200, z: 1990 };
    expect(wrapLerp(a, b, 0)).toEqual(canonicalize(a));
    expect(wrapLerp(a, b, 1)).toEqual(canonicalize(b));
  });

  it("interpolates without wrapping when the direct path is shorter", () => {
    expect(
      wrapLerp({ x: 100, y: 0, z: 400 }, { x: 300, y: 0, z: 600 }, 0.5),
    ).toEqual({
      x: 200,
      y: 0,
      z: 500,
    });
  });

  it("lerps altitude linearly", () => {
    expect(
      wrapLerp({ x: 0, y: 100, z: 0 }, { x: 0, y: 300, z: 0 }, 0.75).y,
    ).toBe(250);
  });
});
