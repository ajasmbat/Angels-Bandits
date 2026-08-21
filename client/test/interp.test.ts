// InterpolationBuffer seam: the module that makes remote planes glide across
// the torus seam instead of teleporting (acceptance check 1 — the raw-lerp
// catcher). Expected values are worked examples: wrapLerp(1990 → 10, t=0.5)
// crosses the seam to land at canonical 0; a raw lerp would say 1000.

import type { Pose } from "@angels-bandits/common/protocol";
import { describe, expect, it } from "vitest";
import { InterpolationBuffer } from "../src/net/interp";

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const pose = (x: number, y: number, z: number, speed = 65): Pose => ({
  pos: { x, y, z },
  quat: { ...IDENTITY },
  speed,
});

describe("InterpolationBuffer", () => {
  it("glides across the torus seam: halfway between x=1990 and x=10 is 0, never 1000", () => {
    const buf = new InterpolationBuffer();
    buf.push(1000, pose(1990, 300, 500));
    buf.push(1100, pose(10, 300, 500));
    const p = buf.sample(1050);
    expect(p?.pos.x).toBeCloseTo(0, 6);
    expect(p?.pos.y).toBe(300);
    expect(p?.pos.z).toBe(500);
  });

  it("interpolates position and speed linearly between samples", () => {
    const buf = new InterpolationBuffer();
    buf.push(1000, pose(100, 300, 500, 60));
    buf.push(1100, pose(110, 320, 500, 70));
    const p = buf.sample(1050);
    expect(p?.pos.x).toBeCloseTo(105, 6);
    expect(p?.pos.y).toBeCloseTo(310, 6);
    expect(p?.speed).toBeCloseTo(65, 6);
  });

  it("slerps the attitude: halfway from yaw 0 to yaw 90° is yaw 45°", () => {
    const buf = new InterpolationBuffer();
    const a = pose(100, 300, 500);
    const b = pose(104, 300, 500);
    // Quaternions for a pure yaw about +Y: {0, sin(yaw/2), 0, cos(yaw/2)}.
    b.quat = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }; // yaw 90°
    buf.push(1000, a);
    buf.push(1100, b);
    const q = buf.sample(1050)?.quat;
    expect(q?.y).toBeCloseTo(0.3826834, 5); // sin(22.5°)
    expect(q?.w).toBeCloseTo(0.9238795, 5); // cos(22.5°)
    expect(q?.x).toBeCloseTo(0, 6);
  });

  it("clamps to the ends — no extrapolation past the newest or oldest sample", () => {
    const buf = new InterpolationBuffer();
    buf.push(1000, pose(100, 300, 500));
    buf.push(1100, pose(110, 300, 500));
    expect(buf.sample(900)?.pos.x).toBe(100);
    expect(buf.sample(1200)?.pos.x).toBe(110);
  });

  it("returns null with no samples", () => {
    expect(new InterpolationBuffer().sample(1000)).toBeNull();
  });

  it("prunes samples much older than the newest, so a long-lived buffer stays small", () => {
    const buf = new InterpolationBuffer();
    buf.push(0, pose(100, 300, 500));
    buf.push(5000, pose(200, 300, 500));
    // The t=0 sample is gone: sampling far in the past clamps to what remains.
    expect(buf.sample(0)?.pos.x).toBe(200);
  });

  it("exposes the newest sample time for clock bookkeeping", () => {
    const buf = new InterpolationBuffer();
    expect(buf.latestTime).toBeNull();
    buf.push(1000, pose(100, 300, 500));
    expect(buf.latestTime).toBe(1000);
  });
});

describe("InterpolationBuffer.latestVelocity", () => {
  it("derives velocity from the two newest samples: 20 m in 0.5 s → 40 m/s", () => {
    const buf = new InterpolationBuffer();
    buf.push(1000, pose(100, 300, 100));
    buf.push(1500, pose(120, 290, 80));
    const v = buf.latestVelocity();
    expect(v?.x).toBeCloseTo(40);
    expect(v?.y).toBeCloseTo(-20);
    expect(v?.z).toBeCloseTo(-40);
  });

  it("is seam-safe: x=1990 → x=10 over 0.5 s is +40 m/s east, never −3960", () => {
    const buf = new InterpolationBuffer();
    buf.push(0, pose(1990, 300, 100));
    buf.push(500, pose(10, 300, 100));
    const v = buf.latestVelocity();
    expect(v?.x).toBeCloseTo(40);
    expect(v?.z).toBeCloseTo(0);
  });

  it("returns null with fewer than two samples", () => {
    const buf = new InterpolationBuffer();
    expect(buf.latestVelocity()).toBeNull();
    buf.push(1000, pose(100, 300, 100));
    expect(buf.latestVelocity()).toBeNull();
  });
});
