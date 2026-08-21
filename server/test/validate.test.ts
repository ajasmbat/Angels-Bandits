// validatePose seam: the server's clamp on client-authoritative movement.
// Expected values are worked examples from the spec numbers: MAX_SPEED 90,
// SPEED_TOLERANCE 1.1 → 99 m/s cap; displacement bound at dt=0.05 is
// (99 + 25 sink) × 0.05 + 15 m slack ≈ 21.2 m.

import type { Pose } from "@angels-bandits/common/protocol";
import { describe, expect, it } from "vitest";
import { validatePose } from "../src/validate";

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const pose = (x: number, y: number, z: number, speed = 65): Pose => ({
  pos: { x, y, z },
  quat: { ...IDENTITY },
  speed,
});

const DT = 0.05; // one 20 Hz tick

describe("validatePose", () => {
  it("snap-rejects an impossible teleport (500 m in one tick), keeping the last accepted pose", () => {
    const prev = pose(1000, 300, 1000);
    const verdict = validatePose(prev, pose(1500, 300, 1000), DT);
    expect(verdict.ok).toBe(false);
    expect(verdict.pose).toEqual(prev);
  });

  it("accepts a legal max-speed dive (90 m/s straight down → 4.5 m in one tick)", () => {
    const prev = pose(1000, 300, 1000, 90);
    const claim = pose(1000, 295.5, 1000, 90);
    const verdict = validatePose(prev, claim, DT);
    expect(verdict.ok).toBe(true);
    expect(verdict.pose.pos).toEqual(claim.pos);
  });

  it("accepts a legal move across the torus seam (raw distance 1996 m, wrapped 4 m)", () => {
    const prev = pose(1999.5, 300, 1000);
    const verdict = validatePose(prev, pose(3.5, 300, 1000), DT);
    expect(verdict.ok).toBe(true);
    expect(verdict.pose.pos.x).toBe(3.5);
  });

  it("rejects a claimed speed above MAX_SPEED × 1.1", () => {
    const prev = pose(1000, 300, 1000);
    expect(validatePose(prev, pose(1001, 300, 1000, 100), DT).ok).toBe(false);
    expect(validatePose(prev, pose(1001, 300, 1000, 95), DT).ok).toBe(true);
  });

  it("rejects non-finite claims", () => {
    const prev = pose(1000, 300, 1000);
    const claim = pose(Number.NaN, 300, 1000);
    expect(validatePose(prev, claim, DT).ok).toBe(false);
  });

  it("rejects a garbage quaternion and renormalizes a slightly drifted one", () => {
    const prev = pose(1000, 300, 1000);
    const garbage = pose(1001, 300, 1000);
    garbage.quat = { x: 3, y: 4, z: 0, w: 0 }; // norm 5 — not an attitude
    expect(validatePose(prev, garbage, DT).ok).toBe(false);

    const drifted = pose(1001, 300, 1000);
    drifted.quat = { x: 0, y: 0, z: 0, w: 1.05 }; // norm 1.05 — float drift
    const verdict = validatePose(prev, drifted, DT);
    expect(verdict.ok).toBe(true);
    const q = verdict.pose.quat;
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 6);
  });

  it("clamps claimed altitude to MAX_ALTITUDE (800 m)", () => {
    const prev = pose(1000, 795, 1000);
    const verdict = validatePose(prev, pose(1000, 810, 1000), DT);
    expect(verdict.ok).toBe(true);
    expect(verdict.pose.pos.y).toBe(800);
  });

  it("canonicalizes an accepted position back into [0, WORLD_SIZE)", () => {
    const prev = pose(1999.5, 300, 1000);
    const verdict = validatePose(prev, pose(2003.5, 300, 1000), DT);
    expect(verdict.ok).toBe(true);
    expect(verdict.pose.pos.x).toBe(3.5);
  });
});
