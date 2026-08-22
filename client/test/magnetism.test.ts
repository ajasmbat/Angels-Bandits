// Magnetism seam: own bullets bend toward the nearest target inside a tight
// aim cone, capped per second — connection help, not an aimbot. Worked
// examples pin the spec numbers: MAGNETISM_CONE_DEG = 4, MAGNETISM_MAX_DEG_PER_S = 2
// (constants.ts); angles below are literals derived from those by hand.

import type { Vec3 } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { magnetizeVelocity } from "../src/game/magnetism";

const DEG = Math.PI / 180;

/** Angle between two vectors, radians (test-side helper, plain acos). */
function angleBetween(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

/** A target `deg` degrees to the +X side of the −Z aim line, `dist` m out. */
function offsetTarget(pos: Vec3, deg: number, dist: number): { pos: Vec3 } {
  return {
    pos: {
      x: pos.x + Math.sin(deg * DEG) * dist,
      y: pos.y,
      z: pos.z - Math.cos(deg * DEG) * dist,
    },
  };
}

describe("magnetizeVelocity", () => {
  const pos: Vec3 = { x: 1000, y: 300, z: 1000 };
  const vel: Vec3 = { x: 0, y: 0, z: -400 }; // straight −Z, 400 m/s

  it("bends toward a target 3° off, by exactly the per-frame cap (2°/s × 0.1 s = 0.2°)", () => {
    const target = offsetTarget(pos, 3, 200);
    const out = magnetizeVelocity(pos, vel, [target], 0.1);
    // Bent by the cap: 0.2°, toward the target (aim error 3° → 2.8°).
    expect(angleBetween(vel, out)).toBeCloseTo(0.2 * DEG, 5);
    const toTarget = {
      x: target.pos.x - pos.x,
      y: 0,
      z: target.pos.z - pos.z,
    };
    expect(angleBetween(out, toTarget)).toBeCloseTo(2.8 * DEG, 5);
    // Speed is preserved — magnetism steers, never accelerates.
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(400, 6);
  });

  it("never oversteers past the target: 1° off with a whole second of cap available snaps to 0°, not −1°", () => {
    const target = offsetTarget(pos, 1, 200);
    const out = magnetizeVelocity(pos, vel, [target], 1);
    const toTarget = {
      x: target.pos.x - pos.x,
      y: 0,
      z: target.pos.z - pos.z,
    };
    expect(angleBetween(out, toTarget)).toBeCloseTo(0, 5);
  });

  it("gives zero bend to a target 10° off (outside the 4° cone)", () => {
    const target = offsetTarget(pos, 10, 200);
    const out = magnetizeVelocity(pos, vel, [target], 0.1);
    expect(out).toEqual(vel);
  });

  it("bends the short way across the torus seam", () => {
    // Bullet at x=1998 flying +X; target 10 m past the seam at x=8, nudged
    // 3° toward +Z. Raw subtraction would see it 1990 m BEHIND (no bend);
    // the torus sees it 10 m ahead inside the cone.
    const seamPos: Vec3 = { x: 1998, y: 300, z: 1000 };
    const seamVel: Vec3 = { x: 400, y: 0, z: 0 };
    const dist = 10;
    const target = {
      pos: {
        x: (1998 + Math.cos(3 * DEG) * dist) % 2000,
        y: 300,
        z: 1000 + Math.sin(3 * DEG) * dist,
      },
    };
    const out = magnetizeVelocity(seamPos, seamVel, [target], 0.1);
    // Bent (not the unchanged reference) and toward +Z (the short way).
    expect(angleBetween(seamVel, out)).toBeCloseTo(0.2 * DEG, 5);
    expect(out.z).toBeGreaterThan(0);
  });

  it("picks the nearest of several in-cone targets", () => {
    const near = offsetTarget(pos, 3, 100);
    // Far target on the OTHER side; if it won, the bend x-sign flips.
    const far = offsetTarget(pos, -3, 300);
    const out = magnetizeVelocity(pos, vel, [far, near], 0.1);
    expect(out.x).toBeGreaterThan(0); // bent toward `near` (+X side)
  });

  it("returns the velocity unchanged with no targets", () => {
    expect(magnetizeVelocity(pos, vel, [], 0.1)).toEqual(vel);
  });
});
