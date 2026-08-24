// Free-look seam (B2): the pure math behind hold-E look-around. Expected
// values are worked examples from the ticket spec, not recomputed formulas:
// steering authority decays 1→0 over 0.3 s of E-held (linear ⇒ 0.5 at
// 0.15 s), release restores full authority in ONE step, and shaping scales
// turn/pitch/roll while throttle passes through untouched.

import { describe, expect, it } from "vitest";
import {
  createFreeLook,
  orbitOffset,
  shapeInput,
  stepFreeLook,
} from "../src/game/freelook";
import { zoomSteer } from "../src/game/zoom";

const DT = 1 / 60;

/** Advance `seconds` of E-held (or released) time in 60 fps steps. */
function advance(
  state: ReturnType<typeof createFreeLook>,
  held: boolean,
  seconds: number,
  dx = 0,
  dy = 0,
) {
  let s = state;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) s = stepFreeLook(s, held, dx, dy, DT);
  return s;
}

describe("steering authority decay", () => {
  it("starts at full authority", () => {
    expect(createFreeLook().steer).toBe(1);
  });

  it("reaches neutral within 0.3 s of E-down", () => {
    const s = advance(createFreeLook(), true, 0.3);
    expect(s.steer).toBe(0);
  });

  it("is about halfway gone at 0.15 s (linear ramp, spec: ~0.3 s to neutral)", () => {
    const s = advance(createFreeLook(), true, 0.15);
    expect(s.steer).toBeCloseTo(0.5, 1);
  });

  it("restores live steering immediately on release — one frame, no residue", () => {
    const held = advance(createFreeLook(), true, 0.3);
    expect(held.steer).toBe(0);
    const released = stepFreeLook(held, false, 0, 0, DT);
    expect(released.steer).toBe(1);
  });
});

describe("orbit offset easing", () => {
  it("mouse delta while held drives a yaw offset in the delta's direction", () => {
    const s = stepFreeLook(createFreeLook(), true, 120, 0, DT);
    expect(s.targetYaw).toBeGreaterThan(0);
  });

  it("enters within 0.15 s: applied offset settles to ≥95% of the commanded orbit", () => {
    // One flick of the mouse on the first frame, then hold steady.
    let s = stepFreeLook(createFreeLook(), true, 400, 0, DT);
    s = advance(s, true, 0.15 - DT);
    expect(s.targetYaw).toBeGreaterThan(0);
    expect(s.yaw / s.targetYaw).toBeGreaterThanOrEqual(0.95);
  });

  it("exits over ~0.25 s: released offsets decay to ≤5% and then snap to zero", () => {
    let s = stepFreeLook(createFreeLook(), true, 400, -200, DT);
    s = advance(s, true, 0.2);
    const atRelease = s.yaw;
    expect(atRelease).toBeGreaterThan(0);

    s = advance(s, false, 0.25);
    expect(Math.abs(s.yaw / atRelease)).toBeLessThanOrEqual(0.05);

    s = advance(s, false, 0.6);
    expect(s.yaw).toBe(0);
    expect(s.pitch).toBe(0);
  });
});

describe("pitch clamp and orbitOffset", () => {
  const DEG80 = (80 * Math.PI) / 180;

  it("clamps commanded pitch to +80° under a huge upward drag, yaw stays unbounded", () => {
    // 100 frames of violent dragging: pitch must clamp, yaw must not.
    let s = createFreeLook();
    for (let i = 0; i < 100; i++) s = stepFreeLook(s, true, 5000, 5000, DT);
    expect(s.targetPitch).toBe(DEG80);
    expect(s.pitch).toBeLessThanOrEqual(DEG80);
    expect(s.targetYaw).toBeGreaterThan(2 * Math.PI); // wrapped past a full turn
    expect(Number.isFinite(s.yaw)).toBe(true);
  });

  it("clamps commanded pitch to −80° under a huge downward drag", () => {
    let s = createFreeLook();
    for (let i = 0; i < 100; i++) s = stepFreeLook(s, true, 0, -5000, DT);
    expect(s.targetPitch).toBe(-DEG80);
    expect(s.pitch).toBeGreaterThanOrEqual(-DEG80);
  });

  it("orbitOffset is the identity at zero offsets", () => {
    const o = { x: 3, y: 6, z: 21 };
    const r = orbitOffset(o, 0, 0);
    expect(r.x).toBeCloseTo(3, 6);
    expect(r.y).toBeCloseTo(6, 6);
    expect(r.z).toBeCloseTo(21, 6);
  });

  it("orbitOffset preserves the camera distance for any orbit", () => {
    const o = { x: 0, y: 6, z: 22 };
    const len = Math.hypot(o.x, o.y, o.z);
    for (const [yaw, pitch] of [
      [Math.PI / 2, 0],
      [Math.PI, DEG80],
      [-3 * Math.PI, -DEG80],
    ]) {
      const r = orbitOffset(o, yaw as number, pitch as number);
      expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(len, 6);
    }
  });

  it("orbitOffset yaws a quarter turn: behind (+Z) moves to the side, height kept", () => {
    // Worked example: offset (0, 0, 22) yawed 90° lands on the ±X axis.
    const r = orbitOffset({ x: 0, y: 0, z: 22 }, Math.PI / 2, 0);
    expect(Math.abs(r.x)).toBeCloseTo(22, 6);
    expect(r.y).toBeCloseTo(0, 6);
    expect(r.z).toBeCloseTo(0, 6);
  });

  it("orbitOffset never produces NaN at the ±80° pitch extremes", () => {
    for (const pitch of [DEG80, -DEG80]) {
      const r = orbitOffset({ x: 0, y: 6, z: 22 }, 1.234, pitch);
      expect(Number.isFinite(r.x)).toBe(true);
      expect(Number.isFinite(r.y)).toBe(true);
      expect(Number.isFinite(r.z)).toBe(true);
    }
    // Degenerate offsets must not divide by zero either.
    const zero = orbitOffset({ x: 0, y: 0, z: 0 }, 1, 1);
    expect(Number.isFinite(zero.x)).toBe(true);
    // Straight-overhead base offset: elevation math is at its asin edge.
    const overhead = orbitOffset({ x: 0, y: 10, z: 0 }, 0.5, DEG80);
    expect(Number.isFinite(overhead.y)).toBe(true);
  });
});

describe("shapeInput", () => {
  const input = { turn: 1, pitch: -0.5, roll: 1, throttle: 1 };

  it("passes input through untouched at full authority", () => {
    expect(shapeInput(input, createFreeLook())).toEqual(input);
  });

  it("zeroes turn/pitch/roll at zero authority but keeps throttle live", () => {
    const s = advance(createFreeLook(), true, 0.3);
    expect(shapeInput(input, s)).toEqual({
      turn: 0,
      pitch: 0,
      roll: 0,
      throttle: 1,
    });
  });

  it("scales steering axes by the current authority", () => {
    const half = { ...createFreeLook(), steer: 0.5 };
    const shaped = shapeInput(input, half);
    expect(shaped.turn).toBeCloseTo(0.5, 6);
    expect(shaped.pitch).toBeCloseTo(-0.25, 6);
    expect(shaped.roll).toBeCloseTo(0.5, 6);
    expect(shaped.throttle).toBe(1);
  });

  // ANGE-G9CPCV: the aim zoom pays for its steady sight picture in turn rate,
  // and it spends it through this same seam rather than reaching into flight
  // state. Authority is the PRODUCT of both costs — during the beat where E
  // interrupts a zoom, both are below 1 at once.
  it("takes any authority carrier, not just a FreeLookState", () => {
    expect(shapeInput(input, { steer: zoomSteer(0) })).toEqual(input);
  });

  it("costs 40% of turn/pitch/roll at full zoom, throttle untouched", () => {
    const shaped = shapeInput(input, { steer: zoomSteer(1) });
    expect(shaped.turn).toBeCloseTo(0.6, 6);
    expect(shaped.pitch).toBeCloseTo(-0.3, 6);
    expect(shaped.roll).toBeCloseTo(0.6, 6);
    expect(shaped.throttle).toBe(1);
  });

  it("is bit-identical to un-zoomed flight at z=0 (regression guard)", () => {
    const authority = createFreeLook().steer * zoomSteer(0);
    expect(shapeInput(input, { steer: authority })).toEqual(input);
  });

  it("multiplies the free-look and zoom costs while a zoom eases out", () => {
    // Half-decayed free-look (0.5) under a full zoom (0.6) ⇒ 0.30 authority.
    const authority = 0.5 * zoomSteer(1);
    const shaped = shapeInput(input, { steer: authority });
    expect(shaped.turn).toBeCloseTo(0.3, 6);
    expect(shaped.roll).toBeCloseTo(0.3, 6);
  });
});
