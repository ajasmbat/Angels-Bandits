// Minimap seam: the pure torus projection behind the wrapping minimap.
// The map shows the whole WORLD_SIZE (2000 m) square centered on the player,
// north (−Z) up — so every wrapDelta lands inside the canvas and the map can
// never show an edge. Worked examples use WORLD_SIZE = 2000 and a 200 px map
// (scale 0.1 px/m) so expected pixels are hand-computable.

import { describe, expect, it } from "vitest";
import { minimapPatternOffset, minimapPoint } from "../src/ui/minimap";

const SIZE = 200; // px; world scale 0.1

describe("minimapPoint", () => {
  it("places a target 300 m east / 200 m north of the player at (130, 80)", () => {
    // East = +x (right), north = −z (up): d = (300, −200) → center + d·0.1.
    const p = minimapPoint(
      { x: 1000, y: 300, z: 1000 },
      { x: 1300, y: 250, z: 800 },
      SIZE,
    );
    expect(p.x).toBeCloseTo(130);
    expect(p.y).toBeCloseTo(80);
  });

  it("keeps a dot continuous across the x seam: 100 m apart across it → 10 px", () => {
    // Player near the east edge, target just across it: true separation is
    // 100 m east, never 1900 m west.
    const p = minimapPoint(
      { x: 1950, y: 300, z: 100 },
      { x: 50, y: 300, z: 100 },
      SIZE,
    );
    expect(p.x).toBeCloseTo(110);
    expect(p.y).toBeCloseTo(100);
  });

  it("keeps a dot continuous across the z seam the same way", () => {
    const p = minimapPoint(
      { x: 100, y: 300, z: 1990 },
      { x: 100, y: 300, z: 10 },
      SIZE,
    );
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(102);
  });

  it("puts the player itself at the exact center", () => {
    const p = minimapPoint(
      { x: 123, y: 300, z: 456 },
      { x: 123, y: 10, z: 456 },
      SIZE,
    );
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(100);
  });
});

describe("minimapPatternOffset", () => {
  // The city texture tiles at exactly the map size (one tile = one world).
  // The offset is the canvas position of the wrapped tile's top-left corner,
  // in [−size, 0), so tiles at o and o+size always cover the whole canvas.
  it("centers world origin for a player at (0, 0): tile corner at (−100, −100)", () => {
    const o = minimapPatternOffset({ x: 0, y: 300, z: 0 }, SIZE);
    expect(o.x).toBeCloseTo(-100);
    expect(o.y).toBeCloseTo(-100);
    // World (0,0) then lands at o + size = (100, 100) — the canvas center.
  });

  it("shifts by the player's canonical position: player (500, 1000) → (−150, −200)", () => {
    const o = minimapPatternOffset({ x: 500, y: 300, z: 1000 }, SIZE);
    expect(o.x).toBeCloseTo(-150);
    expect(o.y).toBeCloseTo(-200);
  });

  it("is periodic in WORLD_SIZE: x = 2100 offsets the same as x = 100", () => {
    const a = minimapPatternOffset({ x: 2100, y: 300, z: 0 }, SIZE);
    const b = minimapPatternOffset({ x: 100, y: 300, z: 0 }, SIZE);
    expect(a.x).toBeCloseTo(b.x);
    expect(a.y).toBeCloseTo(b.y);
  });
});
