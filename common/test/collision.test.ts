import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import {
  buildCityIndex,
  collideCity,
  hitsGround,
} from "@angels-bandits/common/collision";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";

// Hand-built buildings with worked-example geometry; the last block consumes
// real generateCity() output at independently-known fixed blocks (plaza list).

const TOWER = {
  x: 500,
  z: 500,
  width: 100,
  depth: 60,
  height: 120,
  tiers: [{ width: 100, depth: 60, height: 120 }],
};
const R = 2; // player sphere radius, meters

// Wedding-cake tower: 100×100 base to y=80, 60×60 middle to y=120,
// 30×30 crown to y=150 — worked-example geometry for the setback tests.
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

  it("flies clean over a setback ledge: inside the old full box, outside every tier", () => {
    // Above the 100×100 base (top y=80), beside the 60×60 middle tier: the
    // pre-tier full box would have collided here — that wall must be gone.
    expect(collideCity({ x: 540, y: 100, z: 500 }, R, [TIERED])).toBeNull();
    expect(collideCity({ x: 500, y: 100, z: 540 }, R, [TIERED])).toBeNull();
  });

  it("still hits inside the upper tiers", () => {
    expect(collideCity({ x: 520, y: 100, z: 500 }, R, [TIERED])).toBe(TIERED); // middle
    expect(collideCity({ x: 510, y: 135, z: 500 }, R, [TIERED])).toBe(TIERED); // crown
    expect(collideCity({ x: 520, y: 135, z: 500 }, R, [TIERED])).toBeNull(); // beside crown
  });

  it("clips the base tier's roof ledge when skimming it, torus of tiers intact", () => {
    // 1 m above the base tier's roof, sphere radius 2 → touching the ledge.
    expect(collideCity({ x: 540, y: 81, z: 500 }, R, [TIERED])).toBe(TIERED);
    // Clear of the whole stack above the crown.
    expect(collideCity({ x: 500, y: 155, z: 500 }, R, [TIERED])).toBeNull();
  });

  it("is torus-aware: a footprint straddling the seam hits a plane on the far side", () => {
    // Spans x in [-10, 30], i.e. wraps to [1990, 2000) ∪ [0, 30].
    const seamTower = {
      x: 10,
      z: 500,
      width: 40,
      depth: 40,
      height: 100,
      tiers: [{ width: 40, depth: 40, height: 100 }],
    };
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

// --- C1: block-indexed collision ----------------------------------------
// At ~650 buildings the linear scan is the server's hot loop (11 bots × 4
// nose probes at 5 Hz, plus a physics probe per bot per tick). The index
// buckets buildings by the block lattice they already live on. Its contract
// is PARITY: for any probe it must return the very same Building the linear
// scan returns — including when a probe is inside two expanded footprints at
// once, where "first in array order" is the tie-break both must agree on.

// Each case runs the LINEAR scan over all ~650 buildings once per probe —
// deliberately, since that is the oracle — so these are the slowest tests in
// the suite (see the testTimeout note in vitest.config.ts).
describe("buildCityIndex parity with the linear scan", () => {
  const city = generateCity(42);
  const index = buildCityIndex(city);

  /** Deterministic probe stream — same points every run, no Math.random. */
  function* probes(count: number, radius: number) {
    const rand = mulberry32(0xc1c1);
    for (let i = 0; i < count; i++) {
      yield {
        pos: {
          x: rand() * WORLD_SIZE,
          y: rand() * 260,
          z: rand() * WORLD_SIZE,
        },
        radius,
      };
    }
  }

  it("returns the identical building for 3000 probes across the city", () => {
    const mismatches: string[] = [];
    for (const { pos, radius } of probes(3000, R)) {
      const linear = collideCity(pos, radius, city);
      const indexed = collideCity(pos, radius, city, index);
      if (linear !== indexed) {
        mismatches.push(`${pos.x},${pos.y},${pos.z}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees at the torus seam, where a probe straddles x=0 and z=0", () => {
    const mismatches: string[] = [];
    const rand = mulberry32(0x5ea3);
    for (let i = 0; i < 3000; i++) {
      // Hug both seams: a few meters either side of 0 / WORLD_SIZE.
      const near = () =>
        rand() < 0.5 ? rand() * 30 : WORLD_SIZE - rand() * 30;
      const pos = { x: near(), y: rand() * 120, z: near() };
      const linear = collideCity(pos, R, city);
      const indexed = collideCity(pos, R, city, index);
      if (linear !== indexed) {
        mismatches.push(`${pos.x},${pos.y},${pos.z}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees at a bot's probe radius, which straddles several blocks", () => {
    // BOT_PROBE_RADIUS × BOT_RECOVER_CLEAR = the widest sphere in the game.
    const mismatches: string[] = [];
    for (const { pos, radius } of probes(3000, 24)) {
      const linear = collideCity(pos, radius, city);
      const indexed = collideCity(pos, radius, city, index);
      if (linear !== indexed) {
        mismatches.push(`${pos.x},${pos.y},${pos.z}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("indexes hand-built buildings that straddle the seam, not just city lots", () => {
    // The index must be correct for ANY Building[], not only lattice-aligned
    // lots — collision's contract takes a plain array.
    const seamTower = {
      x: 10,
      z: 500,
      width: 40,
      depth: 40,
      height: 100,
      tiers: [{ width: 40, depth: 40, height: 100 }],
    };
    const seamIndex = buildCityIndex([seamTower]);
    expect(
      collideCity({ x: 1995, y: 50, z: 500 }, R, [seamTower], seamIndex),
    ).toBe(seamTower);
    expect(
      collideCity({ x: 1980, y: 50, z: 500 }, R, [seamTower], seamIndex),
    ).toBeNull();
  });

  it("falls back to the linear scan when handed an index for another array", () => {
    // A stale index must degrade to correct-and-slow, never to silently wrong.
    const other = generateCity(7);
    const stale = buildCityIndex(other);
    const mismatches: string[] = [];
    for (const { pos, radius } of probes(3000, R)) {
      const withStale = collideCity(pos, radius, city, stale);
      const linear = collideCity(pos, radius, city);
      if (withStale !== linear) {
        mismatches.push(`${pos.x},${pos.y},${pos.z}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
