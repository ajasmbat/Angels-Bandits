// Street cross-section contract seam: the ONE source of street geometry for
// lamps, traffic, and the painted ground. Worked examples use the shipped
// constants (WORLD_SIZE = 2000, BLOCK_PITCH = 200, STREET_WIDTH = 30): streets
// are 30 m bands centered on every block-boundary line, so the curb sits 15 m
// out, the furniture (lamp) line 16 m, lane centers ±5 m — and street line 0
// puts its negative-side curb at 1985, which is the wrap case under test.

import {
  CROSSWALK_DEPTH,
  CURB_LINE,
  FURNITURE_LINE,
  INTERSECTION_HALF,
  LANE_CENTERS,
  ROADWAY_HALF,
  isInIntersection,
  isInRoadway,
  nearestStreet,
  nextIntersection,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import { wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

describe("street cross-section constants", () => {
  it("pins the spec's cross-section (30 m street: curb 15, furniture 16, lanes ±5, crosswalk 4)", () => {
    expect(ROADWAY_HALF).toBe(15);
    expect(CURB_LINE).toBe(15);
    expect(FURNITURE_LINE).toBe(16);
    expect(LANE_CENTERS).toEqual([-5, 5]);
    expect(CROSSWALK_DEPTH).toBe(4);
    expect(INTERSECTION_HALF).toBe(15);
  });

  it("keeps lane centers inside the roadway and the furniture line outside it", () => {
    for (const lane of LANE_CENTERS) {
      expect(Math.abs(lane)).toBeLessThan(ROADWAY_HALF);
    }
    expect(FURNITURE_LINE).toBeGreaterThan(ROADWAY_HALF);
  });
});

describe("isInRoadway", () => {
  it("is true inside a street band, false at a block center", () => {
    expect(isInRoadway({ x: 7, y: 0, z: 60 })).toBe(true); // 7 m off line x = 0
    expect(isInRoadway({ x: 60, y: 0, z: 207 })).toBe(true); // off line z = 200
    expect(isInRoadway({ x: 100, y: 0, z: 100 })).toBe(false); // block center
  });

  it("includes the curb line itself and excludes just beyond it", () => {
    expect(isInRoadway({ x: 215, y: 0, z: 60 })).toBe(true); // exactly on the curb of line 200
    expect(isInRoadway({ x: 215.5, y: 0, z: 60 })).toBe(false); // 0.5 m onto the sidewalk
  });

  it("wraps at street line 0: the negative-side curb sits at 1985", () => {
    expect(isInRoadway({ x: 1985, y: 0, z: 60 })).toBe(true); // 2000 − 15, curb of line 0
    expect(isInRoadway({ x: 1984.9, y: 0, z: 60 })).toBe(false); // just behind that curb
  });

  it("accepts non-canonical input (canonicalizes first)", () => {
    expect(isInRoadway({ x: -7, y: 0, z: 60 })).toBe(true); // same point as x = 1993
  });
});

describe("isInIntersection", () => {
  it("is true only where two street bands overlap (30×30 square on block corners)", () => {
    expect(isInIntersection({ x: 10, y: 0, z: 12 })).toBe(true); // corner (0, 0)
    expect(isInIntersection({ x: 10, y: 0, z: 30 })).toBe(false); // roadway, past the square
    expect(isInIntersection({ x: 100, y: 0, z: 100 })).toBe(false); // block center
  });

  it("wraps across the seam: the corner at (0, 0) extends to (1990, 1990)", () => {
    expect(isInIntersection({ x: 1990, y: 0, z: 1995 })).toBe(true);
    expect(isInIntersection({ x: 1990, y: 0, z: 1980 })).toBe(false); // z 20 m off the corner
  });
});

describe("nearestStreet", () => {
  it("names the nearest street by travel axis, centerline, and side", () => {
    // 2 m west of line x = 200: a north–south street (travel axis z).
    expect(nearestStreet({ x: 198, y: 0, z: 60 })).toEqual({
      axis: "z",
      centerline: 200,
      side: -1,
    });
    // 3 m north (+z) of line z = 200: an east–west street (travel axis x).
    expect(nearestStreet({ x: 60, y: 0, z: 203 })).toEqual({
      axis: "x",
      centerline: 200,
      side: 1,
    });
  });

  it("wraps at the seam: 1990 is 10 m on the negative side of line 0", () => {
    expect(nearestStreet({ x: 1990, y: 0, z: 777 })).toEqual({
      axis: "z",
      centerline: 0,
      side: -1,
    });
  });

  it("returns a canonical centerline for every grid line", () => {
    for (let line = 0; line < 2000; line += 200) {
      const s = nearestStreet({ x: line + 4, y: 0, z: 90 });
      expect(s.centerline).toBe(line);
      expect(s.side).toBe(1);
    }
  });
});

describe("nextIntersection", () => {
  // Intersections sit on every (BLOCK_PITCH, BLOCK_PITCH) lattice point, and
  // NearestStreet.axis is the direction of TRAVEL — a north–south street on a
  // line of constant x has axis "z", so `centerline` is that x.
  const NS = { axis: "z", centerline: 0 } as const; // street on the x = 0 line
  const EW = { axis: "x", centerline: 600 } as const; // street on the z = 600 line

  it("takes the next lattice point ahead along the travel axis", () => {
    expect(nextIntersection({ x: 0, y: 40, z: 250 }, NS, 1)).toEqual({
      x: 0,
      y: 0,
      z: 400,
    });
    expect(nextIntersection({ x: 0, y: 40, z: 250 }, NS, -1)).toEqual({
      x: 0,
      y: 0,
      z: 200,
    });
  });

  it("keeps the cross-axis coordinate on the street's own centerline", () => {
    // Travelling east along the z = 600 street, drifted 9 m off the line.
    expect(nextIntersection({ x: 1370, y: 40, z: 609 }, EW, 1)).toEqual({
      x: 1400,
      y: 0,
      z: 600,
    });
  });

  it("is strictly ahead: standing on an intersection returns the NEXT one", () => {
    expect(nextIntersection({ x: 0, y: 40, z: 200 }, NS, 1)).toEqual({
      x: 0,
      y: 0,
      z: 400,
    });
    expect(nextIntersection({ x: 0, y: 40, z: 200 }, NS, -1)).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
  });

  it("wraps across the seam instead of running off the end of the world", () => {
    // 1950 + 50 = 2000, which is canonical 0 — one block ahead, not 10 back.
    const wrapped = nextIntersection({ x: 0, y: 40, z: 1950 }, NS, 1);
    expect(wrapped).toEqual({ x: 0, y: 0, z: 0 });
    expect(wrapDistance({ x: 0, y: 0, z: 1950 }, wrapped)).toBeCloseTo(50);
    // And backwards off the low end.
    expect(nextIntersection({ x: 0, y: 40, z: 50 }, NS, -1)).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
    expect(nextIntersection({ x: 0, y: 40, z: -50 }, NS, -1)).toEqual({
      x: 0,
      y: 0,
      z: 1800,
    });
  });

  it("lands on a real intersection, one block from the next one, all the way round", () => {
    let p = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 12; i++) {
      const next = nextIntersection(p, NS, 1);
      expect(isInIntersection(next)).toBe(true);
      expect(wrapDistance(p, next)).toBeCloseTo(BLOCK_PITCH);
      p = next;
    }
    // Twelve 200 m steps around a 2000 m torus land two blocks past the start.
    expect(p).toEqual({ x: 0, y: 0, z: 400 });
  });

  it("composes with nearestStreet from an arbitrary point in a canyon", () => {
    // 4 m off the x = 1400 line, mid-block in z: the nearest street is the
    // north–south one on x = 1400, so travel runs along z.
    const street = nearestStreet({ x: 1404, y: 40, z: 930 });
    expect(street.axis).toBe("z");
    expect(street.centerline).toBe(1400);
    expect(nextIntersection({ x: 1404, y: 40, z: 930 }, street, 1)).toEqual({
      x: 1400,
      y: 0,
      z: 1000,
    });
  });
});
