// hitdetect seam: the shooter-side bullet test — one frame's bullet segment
// vs a remote plane's hit sphere, all through wrapDelta so a duel across the
// torus seam behaves exactly like one in the middle of the map.
// HIT_RADIUS is 6 m (constants.ts); worked examples use that literal.

import { describe, expect, it } from "vitest";
import { bulletHitsSphere } from "../src/game/hitdetect";

describe("bulletHitsSphere", () => {
  it("hits when the segment passes through the sphere, misses at 8 m lateral offset", () => {
    const center = { x: 100, y: 300, z: 50 };
    // Straight through the center.
    expect(
      bulletHitsSphere(
        { x: 100, y: 300, z: 60 },
        { x: 100, y: 300, z: 40 },
        center,
      ),
    ).toBe(true);
    // 5 m abeam — inside the 6 m sphere.
    expect(
      bulletHitsSphere(
        { x: 95, y: 300, z: 60 },
        { x: 95, y: 300, z: 40 },
        center,
      ),
    ).toBe(true);
    // 8 m abeam — outside.
    expect(
      bulletHitsSphere(
        { x: 92, y: 300, z: 60 },
        { x: 92, y: 300, z: 40 },
        center,
      ),
    ).toBe(false);
  });

  it("does not extrapolate beyond the segment (closest approach at an endpoint)", () => {
    const center = { x: 100, y: 300, z: 50 };
    // The bullet stops 20 m short of the target this frame.
    expect(
      bulletHitsSphere(
        { x: 100, y: 300, z: 80 },
        { x: 100, y: 300, z: 70 },
        center,
      ),
    ).toBe(false);
  });

  it("hits across the torus seam: bullet 1998→8 (wrapped 10 m step) meets a target at x=3", () => {
    // Raw x-difference between segment ends is −1990; on the torus the bullet
    // travels +10 through the seam and sweeps right past x=3.
    const center = { x: 3, y: 300, z: 100 };
    expect(
      bulletHitsSphere(
        { x: 1998, y: 300, z: 100 },
        { x: 8, y: 300, z: 100 },
        center,
      ),
    ).toBe(true);
  });

  it("accounts for altitude: 10 m above the target is a miss, 4 m is a hit", () => {
    const center = { x: 100, y: 300, z: 50 };
    expect(
      bulletHitsSphere(
        { x: 100, y: 310, z: 60 },
        { x: 100, y: 310, z: 40 },
        center,
      ),
    ).toBe(false);
    expect(
      bulletHitsSphere(
        { x: 100, y: 304, z: 60 },
        { x: 100, y: 304, z: 40 },
        center,
      ),
    ).toBe(true);
  });
});
