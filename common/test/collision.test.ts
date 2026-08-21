import { generateCity } from "@angels-bandits/common/city";
import { collideCity, hitsGround } from "@angels-bandits/common/collision";
import { describe, expect, it } from "vitest";

// Hand-built buildings with worked-example geometry; the last block consumes
// real generateCity() output at independently-known fixed blocks (plaza list).

const TOWER = { x: 500, z: 500, width: 100, depth: 60, height: 120 };
const R = 2; // player sphere radius, meters

describe("collideCity: sphere vs building box", () => {
  it("hits when the sphere touches a side face (x face at 550, sphere at 551)", () => {
    expect(collideCity({ x: 551, y: 60, z: 500 }, R, [TOWER])).toBe(TOWER);
  });

  it("misses when clearly beside the building", () => {
    expect(collideCity({ x: 560, y: 60, z: 500 }, R, [TOWER])).toBeNull();
  });

  it("misses when flying just above the roof, hits just below it", () => {
    expect(collideCity({ x: 500, y: 125, z: 500 }, R, [TOWER])).toBeNull();
    expect(collideCity({ x: 500, y: 121, z: 500 }, R, [TOWER])).toBe(TOWER);
  });

  it("respects depth independently of width (z face at 530)", () => {
    expect(collideCity({ x: 500, y: 60, z: 531 }, R, [TOWER])).toBe(TOWER);
    expect(collideCity({ x: 500, y: 60, z: 535 }, R, [TOWER])).toBeNull();
  });

  it("is torus-aware: a footprint straddling the seam hits a plane on the far side", () => {
    // Spans x in [-10, 30], i.e. wraps to [1990, 2000) ∪ [0, 30].
    const seamTower = { x: 10, z: 500, width: 40, depth: 40, height: 100 };
    expect(collideCity({ x: 1995, y: 50, z: 500 }, R, [seamTower])).toBe(
      seamTower,
    );
    expect(collideCity({ x: 1980, y: 50, z: 500 }, R, [seamTower])).toBeNull();
  });
});

describe("hitsGround", () => {
  it("hits when the sphere touches y=0, not before", () => {
    expect(hitsGround({ x: 0, y: 1.5, z: 0 }, R)).toBe(true);
    expect(hitsGround({ x: 0, y: 2.5, z: 0 }, R)).toBe(false);
  });
});

describe("collideCity against real generateCity() output", () => {
  const city = generateCity(42);

  it("hits the building centered in block (0,0) at low altitude", () => {
    // Every non-plaza block has a building centered at bx·200+100; footprints
    // are ≥ 100 m wide, so the block center at low altitude is always inside.
    expect(collideCity({ x: 100, y: 20, z: 100 }, R, city)).not.toBeNull();
  });

  it("finds only air over the fixed plaza block (4,4) — center (900, 900)", () => {
    expect(collideCity({ x: 900, y: 20, z: 900 }, R, city)).toBeNull();
  });
});
