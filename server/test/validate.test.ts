// validatePose seam: the server's clamp on client-authoritative movement.
// Expected values are worked examples from the spec numbers: MAX_SPEED 90,
// SPEED_TOLERANCE 1.1 → 99 m/s cap; displacement bound at dt=0.05 is
// (99 + 25 sink) × 0.05 + 15 m slack ≈ 21.2 m.

import { MAX_SPEED } from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  flightAxes,
  stepFlight,
} from "@angels-bandits/common/flight";
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

  it("rejects a malformed claim instead of throwing, keeping the last pose (S1)", () => {
    const prev = pose(1000, 300, 1000);
    const { pos, speed } = pose(1001, 300, 1000);
    for (const claim of [
      {},
      1,
      null,
      undefined,
      { pos: null, quat: IDENTITY, speed },
      { pos, speed },
      { pos, quat: null, speed },
      { pos: { x: "a", y: 300, z: 1000 }, quat: IDENTITY, speed },
    ]) {
      const verdict = validatePose(prev, claim, DT);
      expect(verdict.ok).toBe(false);
      expect(verdict.pose).toBe(prev);
    }
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

// F7b (ANGE-EGBXX6): a whole aerobatic sortie, as the client streams it.
// stepFlight at 60 Hz, every third frame sent (20 Hz, DT), the quaternion
// built the way main.ts builds it: Three.js setFromEuler of an
// Euler(pitch, yaw, roll, "YXZ"), written out here (no Three.js on the server).

/** The wire quaternion for a flight state (Three.js YXZ setFromEuler). */
function wireQuat(f: FlightState): Pose["quat"] {
  const c1 = Math.cos(f.pitch / 2);
  const s1 = Math.sin(f.pitch / 2);
  const c2 = Math.cos(f.yaw / 2);
  const s2 = Math.sin(f.yaw / 2);
  const c3 = Math.cos(f.roll / 2);
  const s3 = Math.sin(f.roll / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3,
  };
}

/** Loop, 360° roll, Immelmann, split-S at full throttle: the poses sent,
 * and whether the airframe was inverted at each. */
function sortie(): { poses: Pose[]; inverted: boolean[] } {
  const N: FlightInput = { pitch: 0, turn: 0, roll: 0, throttle: 1 };
  const pull = { ...N, pitch: 1 };
  const roll = { ...N, roll: 1 };
  // Frames of each input at 60 Hz: a loop is ~6.3 s of full pull (PITCH_RATE
  // 1 rad/s), a half roll 1.25 s (ROLL_RATE 2.5 rad/s).
  const script: [FlightInput, number][] = [
    [N, 30],
    [pull, 378], // loop
    [roll, 151], // 360° roll
    [pull, 189], // Immelmann: half loop up…
    [roll, 75], //  …half roll upright
    [N, 30],
    [roll, 75], // split-S: half roll inverted…
    [pull, 189], // …half loop down
    [N, 30],
  ];
  let f: FlightState = {
    pos: { x: 1000, y: 300, z: 1000 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    bank: 0,
    rollRate: 0,
    speed: MAX_SPEED,
    targetSpeed: MAX_SPEED,
  };
  const axes = { right: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 0 } };
  const poses: Pose[] = [];
  const inverted: boolean[] = [];
  let frame = 0;
  for (const [input, frames] of script) {
    for (let i = 0; i < frames; i++) {
      f = stepFlight(f, input, 1 / 60);
      if (++frame % 3 !== 0) continue;
      poses.push({ pos: { ...f.pos }, quat: wireQuat(f), speed: f.speed });
      inverted.push(flightAxes(f, axes).up.y < -0.9);
    }
  }
  return { poses, inverted };
}

describe("validatePose: F7 aerobatics", () => {
  it("accepts every tick of a loop, a roll, an Immelmann and a split-S, unaltered", () => {
    const { poses, inverted } = sortie();
    expect(inverted.filter(Boolean).length).toBeGreaterThan(20); // really aerobatic
    let prev = poses[0];
    for (const claim of poses.slice(1)) {
      const verdict = validatePose(prev, claim, DT);
      expect(verdict.ok).toBe(true);
      expect(verdict.pose.pos).toEqual(claim.pos);
      expect(verdict.pose.speed).toBe(claim.speed);
      const q = verdict.pose.quat;
      const c = claim.quat;
      expect(
        Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z, q.w - c.w),
      ).toBeLessThan(1e-12);
      prev = verdict.pose;
    }
  });

  it("still rejects a teleport in the middle of the loop, inverted, and resumes after it", () => {
    const { poses, inverted } = sortie();
    const k = inverted.findIndex(Boolean);
    expect(k).toBeGreaterThan(0);
    const bad: Pose = {
      ...poses[k],
      pos: { ...poses[k].pos, x: poses[k].pos.x + 100 },
    };
    const prev = poses[k - 1];
    const verdict = validatePose(prev, bad, DT);
    expect(verdict.ok).toBe(false);
    expect(verdict.pose).toBe(prev);
    // The honest next tick is two ticks from the pose on record: accepted.
    expect(validatePose(verdict.pose, poses[k + 1], 2 * DT).ok).toBe(true);
  });
});
