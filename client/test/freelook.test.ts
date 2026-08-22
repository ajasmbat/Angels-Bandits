// Free-look seam (B2): the pure math behind hold-E look-around. Expected
// values are worked examples from the ticket spec, not recomputed formulas:
// steering authority decays 1→0 over 0.3 s of E-held (linear ⇒ 0.5 at
// 0.15 s), release restores full authority in ONE step, and shaping scales
// turn/pitch/roll while throttle passes through untouched.

import { describe, expect, it } from "vitest";
import {
  createFreeLook,
  shapeInput,
  stepFreeLook,
} from "../src/game/freelook";

const DT = 1 / 60;

/** Advance `seconds` of E-held (or released) time in 60 fps steps. */
function advance(
  state = createFreeLook(),
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
});
