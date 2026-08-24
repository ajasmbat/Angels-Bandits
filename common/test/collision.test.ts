import { generateCity } from "@angels-bandits/common/city";
import {
  collideCity,
  hitsGround,
  losClear,
} from "@angels-bandits/common/collision";
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

// Line of sight (ANGE-SINI5F): the same tier boxes, but asked "can A see B?"
// instead of "is A inside a box?". Expected values are worked by hand from the
// fixtures above — TOWER spans x 450..550, z 470..530, y 0..120; TIERED stacks
// 100×100 to y=80, 60×60 to y=120, 30×30 to y=150.

describe("losClear: sight line vs the tier stack", () => {
  it("is blocked by a tower straight across the sight line", () => {
    expect(
      losClear({ x: 400, y: 60, z: 500 }, { x: 600, y: 60, z: 500 }, [TOWER]),
    ).toBe(false);
  });

  it("clears the same line flown over the roof (top y=120)", () => {
    expect(
      losClear({ x: 400, y: 130, z: 500 }, { x: 600, y: 130, z: 500 }, [TOWER]),
    ).toBe(true);
  });

  it("respects depth: the z face sits at 530, so 531 sees past and 529 does not", () => {
    expect(
      losClear({ x: 400, y: 60, z: 531 }, { x: 600, y: 60, z: 531 }, [TOWER]),
    ).toBe(true);
    expect(
      losClear({ x: 400, y: 60, z: 529 }, { x: 600, y: 60, z: 529 }, [TOWER]),
    ).toBe(false);
  });

  it("is a SEGMENT, not a ray: both ends short of the near face still see", () => {
    expect(
      losClear({ x: 400, y: 60, z: 500 }, { x: 440, y: 60, z: 500 }, [TOWER]),
    ).toBe(true);
  });

  it("catches a climbing diagonal that clips the box on the way up", () => {
    // Crosses the near face x=450 a quarter of the way along, at y=95 < 120.
    expect(
      losClear({ x: 400, y: 60, z: 500 }, { x: 600, y: 200, z: 500 }, [TOWER]),
    ).toBe(false);
  });

  it("sees over a setback ledge: above tier 1, outside the 60 m middle tier", () => {
    // x=540 is inside the 100 m base footprint but outside the 60 m tier at
    // y=100 — the same silhouette rule collideCity uses, so no invisible wall.
    expect(
      losClear({ x: 540, y: 100, z: 400 }, { x: 540, y: 100, z: 600 }, [
        TIERED,
      ]),
    ).toBe(true);
    expect(
      losClear({ x: 500, y: 100, z: 400 }, { x: 500, y: 100, z: 600 }, [
        TIERED,
      ]),
    ).toBe(false);
  });

  it("is blocked by the crown and clear beside it (30 m wide, y 120..150)", () => {
    expect(
      losClear({ x: 500, y: 140, z: 400 }, { x: 500, y: 140, z: 600 }, [
        TIERED,
      ]),
    ).toBe(false);
    expect(
      losClear({ x: 520, y: 140, z: 400 }, { x: 520, y: 140, z: 600 }, [
        TIERED,
      ]),
    ).toBe(true);
  });

  it("is torus-aware: a footprint on the seam blocks a line through the seam", () => {
    // Spans x in [1950, 2000) ∪ [0, 50). The two planes are 200 m apart the
    // short way; raw subtraction would call them 1800 m apart and see clear.
    const seamTower = {
      x: 0,
      z: 500,
      width: 100,
      depth: 100,
      height: 120,
      tiers: [{ width: 100, depth: 100, height: 120 }],
    };
    expect(
      losClear({ x: 1900, y: 60, z: 500 }, { x: 100, y: 60, z: 500 }, [
        seamTower,
      ]),
    ).toBe(false);
    // Symmetric, and clear above the roof.
    expect(
      losClear({ x: 100, y: 60, z: 500 }, { x: 1900, y: 60, z: 500 }, [
        seamTower,
      ]),
    ).toBe(false);
    expect(
      losClear({ x: 1900, y: 200, z: 500 }, { x: 100, y: 200, z: 500 }, [
        seamTower,
      ]),
    ).toBe(true);
    // The same box parked mid-map is never on the short way round.
    const midTower = { ...seamTower, x: 1000 };
    expect(
      losClear({ x: 1900, y: 60, z: 500 }, { x: 100, y: 60, z: 500 }, [
        midTower,
      ]),
    ).toBe(true);
  });

  it("treats an empty city and a zero-length line as clear", () => {
    expect(losClear({ x: 1, y: 2, z: 3 }, { x: 900, y: 400, z: 700 })).toBe(
      true,
    );
    expect(
      losClear({ x: 500, y: 60, z: 500 }, { x: 500, y: 60, z: 500 }, [TOWER]),
    ).toBe(true);
  });

  it("agrees with collideCity: any point the sphere hits means no sight line", () => {
    // Independent source of truth: march the segment with the EXISTING
    // primitive. Every hit must imply a blocked line (not the converse — a
    // hairline sight line can thread a gap the 2 m sphere cannot).
    const from = { x: 380, y: 70, z: 470 };
    const to = { x: 620, y: 110, z: 545 };
    let sphereHit = false;
    for (let i = 0; i <= 400; i++) {
      const t = i / 400;
      const p = {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: from.z + (to.z - from.z) * t,
      };
      if (collideCity(p, R, [TIERED])) sphereHit = true;
    }
    expect(sphereHit).toBe(true);
    expect(losClear(from, to, [TIERED])).toBe(false);
  });
});

describe("losClear against real generateCity() output", () => {
  const city = generateCity(42);

  it("is blocked by the landmark shaft at (500, 700) and clear above it", () => {
    // Landmark tiers are seed-independent: 90 m podium to y=60, 62 m shaft to
    // y=210, 34 m crown to y=250. At y=150 the shaft spans x 469..531.
    expect(
      losClear({ x: 300, y: 150, z: 700 }, { x: 700, y: 150, z: 700 }, city),
    ).toBe(false);
    // Nothing in the city reaches 250 m, so 300 m sees clean across.
    expect(
      losClear({ x: 300, y: 300, z: 700 }, { x: 700, y: 300, z: 700 }, city),
    ).toBe(true);
  });

  it("sees clean across the fixed plaza block (4,4), center (900, 900)", () => {
    expect(
      losClear({ x: 900, y: 60, z: 860 }, { x: 900, y: 60, z: 940 }, city),
    ).toBe(true);
  });
});
