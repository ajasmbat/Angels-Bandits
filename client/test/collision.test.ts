// Crash-detection adapter seam: detectCrash is the client's only collision
// consumer, so the tier-aware silhouette must hold here too — a plane hovering
// over a setback ledge (inside the pre-tier full box) must NOT crash, and one
// inside an upper tier must. Worked-example tower matches the common
// collision tests: 100×100 base to y=80, 60×60 middle to y=120.

import { createFlightState } from "@angels-bandits/common/flight";
import { describe, expect, it } from "vitest";
import { detectCrash } from "../src/game/collision";

const TIERED = {
  x: 500,
  z: 500,
  width: 100,
  depth: 100,
  height: 150,
  tiers: [
    { width: 100, depth: 100, height: 80 },
    { width: 60, depth: 60, height: 40 },
    { width: 30, depth: 30, height: 30 },
  ],
};

const at = (x: number, y: number, z: number) =>
  createFlightState({ x, y, z }, 0);

describe("detectCrash over a tiered tower", () => {
  it("does not crash above the setback ledge (no invisible wall)", () => {
    expect(detectCrash(at(540, 100, 500), [TIERED])).toBe(false);
  });

  it("crashes inside the middle tier", () => {
    expect(detectCrash(at(520, 100, 500), [TIERED])).toBe(true);
  });

  it("still crashes into the base tier and on the ground", () => {
    expect(detectCrash(at(540, 40, 500), [TIERED])).toBe(true);
    expect(detectCrash(at(0, 1, 0), [])).toBe(true);
  });
});
