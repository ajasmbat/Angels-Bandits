// Lead-indicator seam: the pure torus-aware intercept solver. Given the
// shooter, the bullet speed, and a target with velocity, find where a bullet
// fired NOW meets the target. Expected values are hand-worked quadratic
// solutions (t from |d + v·t| = s·t), not recomputed via the implementation.

import { describe, expect, it } from "vitest";
import { leadPoint } from "../src/ui/lead";

describe("leadPoint", () => {
  it("aims straight at a stationary target: 400 m ahead at bullet speed 400 → the target itself", () => {
    const p = leadPoint({ x: 1000, y: 300, z: 1000 }, 400, {
      pos: { x: 1000, y: 300, z: 600 },
      vel: { x: 0, y: 0, z: 0 },
    });
    expect(p?.x).toBeCloseTo(1000);
    expect(p?.y).toBeCloseTo(300);
    expect(p?.z).toBeCloseTo(600);
  });

  it("leads a crossing target: 300 m ahead, crossing at 300 m/s, bullet 500 m/s → t = 0.75 s", () => {
    // d = (0,0,−300), v = (300,0,0), s = 500. d·v = 0, so t = 300/√(s²−v²)
    // = 300/400 = 0.75 s; intercept = target + v·t = 225 m east of it.
    const p = leadPoint({ x: 1000, y: 300, z: 1000 }, 500, {
      pos: { x: 1000, y: 300, z: 700 },
      vel: { x: 300, y: 0, z: 0 },
    });
    expect(p?.x).toBeCloseTo(1225);
    expect(p?.y).toBeCloseTo(300);
    expect(p?.z).toBeCloseTo(700);
  });

  it("works across the seam and canonicalizes: fleeing target 200 m past the x edge", () => {
    // Shooter x=1950, target x=150 (d.x = +200 through the seam), fleeing
    // east at 100 m/s, bullet 400 m/s: 15t² − 4t − 4 = 0 → t = 2/3 s.
    // Intercept x = 150 + 100·(2/3) = 216.67 — canonical, no 2000s anywhere.
    const p = leadPoint({ x: 1950, y: 300, z: 100 }, 400, {
      pos: { x: 150, y: 300, z: 100 },
      vel: { x: 100, y: 0, z: 0 },
    });
    expect(p?.x).toBeCloseTo(216.666, 2);
    expect(p?.y).toBeCloseTo(300);
    expect(p?.z).toBeCloseTo(100);
  });

  it("returns null when the target outruns the bullet away from the shooter", () => {
    const p = leadPoint({ x: 1000, y: 300, z: 1000 }, 400, {
      pos: { x: 1000, y: 300, z: 900 },
      vel: { x: 0, y: 0, z: -500 },
    });
    expect(p).toBeNull();
  });
});
