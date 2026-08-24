import {
  LANDMARK_BLOCKS,
  PLAZA_BLOCKS,
  generateCity,
} from "@angels-bandits/common/city";
import {
  LOT_LINE,
  SIDEWALK_DEPTH,
  isInRoadway,
} from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  BUILDING_MAX_HEIGHT,
  BUILDING_MIN_HEIGHT,
  LANDMARK_HEIGHT,
  LOT_MIN_WIDTH,
  STREET_WIDTH,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { describe, expect, it, vi } from "vitest";

// The map is a 10×10 grid of 200 m blocks (2000/200). Hand-placed layout per
// PLAN.md: a handful of landmark supertalls and 2–3 empty plaza blocks. Every
// other block is subdivided into irregular lots that build out to the lot line
// (C1), so the city is a streetwall rather than free-standing towers.
// These literals are the spec for the generated city, independent of the
// generator's internals.
const EXPECTED_LANDMARK_COUNT = 4;

/** FNV-1a over a string — a stable, dependency-free 32-bit content digest. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

describe("generateCity determinism", () => {
  it("produces byte-identical output across two invocations of the same seed", () => {
    expect(JSON.stringify(generateCity(42))).toBe(
      JSON.stringify(generateCity(42)),
    );
  });

  it("matches the committed fingerprint for seed 42 (client and server must agree exactly)", () => {
    // A fingerprint rather than the whole city: at ~650 buildings a literal
    // snapshot is ~150 KB of unreviewable diff, while any change to the PRNG,
    // the draw order, or the subdivision flips this hash just the same. The
    // first and last buildings are pinned alongside it so a mismatch says
    // WHAT moved, not just that something did.
    const city = generateCity(42);
    expect({
      count: city.length,
      digest: fnv1a(JSON.stringify(city)),
      first: city[0],
      last: city[city.length - 1],
    }).toMatchSnapshot();
  });

  it("produces different cities for different seeds", () => {
    expect(JSON.stringify(generateCity(1))).not.toBe(
      JSON.stringify(generateCity(2)),
    );
  });
});

describe("generateCity layout", () => {
  const city = generateCity(42);

  it("keeps every building fully inside [0, WORLD_SIZE)", () => {
    for (const b of city) {
      expect(b.x - b.width / 2).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width / 2).toBeLessThan(WORLD_SIZE);
      expect(b.z - b.depth / 2).toBeGreaterThanOrEqual(0);
      expect(b.z + b.depth / 2).toBeLessThan(WORLD_SIZE);
    }
  });

  it("keeps every footprint inside one block: no lot spans a street", () => {
    // The constraint the old BUILDING_MAX_FOOTPRINT encoded, now binding the
    // block extent rather than a single centered building.
    for (const b of city) {
      expect(b.width).toBeLessThanOrEqual(BLOCK_PITCH - STREET_WIDTH);
      expect(b.depth).toBeLessThanOrEqual(BLOCK_PITCH - STREET_WIDTH);
      expect(Math.floor((b.x - b.width / 2) / BLOCK_PITCH)).toBe(
        Math.floor((b.x + b.width / 2) / BLOCK_PITCH),
      );
      expect(Math.floor((b.z - b.depth / 2) / BLOCK_PITCH)).toBe(
        Math.floor((b.z + b.depth / 2) / BLOCK_PITCH),
      );
    }
  });

  it("leaves the three hand-placed plaza blocks completely empty", () => {
    for (const [bx, bz] of PLAZA_BLOCKS) {
      const inBlock = city.filter(
        (b) =>
          Math.floor(b.x / BLOCK_PITCH) === bx &&
          Math.floor(b.z / BLOCK_PITCH) === bz,
      );
      expect(inBlock).toHaveLength(0);
    }
  });

  it("has 4 landmark supertalls at LANDMARK_HEIGHT and all other heights in [min, max]", () => {
    const landmarks = city.filter((b) => b.height === LANDMARK_HEIGHT);
    expect(landmarks).toHaveLength(EXPECTED_LANDMARK_COUNT);
    for (const b of city) {
      if (b.height === LANDMARK_HEIGHT) continue;
      expect(b.height).toBeGreaterThanOrEqual(BUILDING_MIN_HEIGHT);
      expect(b.height).toBeLessThanOrEqual(BUILDING_MAX_HEIGHT);
    }
  });

  it("stacks 1–3 tiers per building: heights sum to the total, tier 1 keeps the footprint", () => {
    for (const b of city) {
      expect(b.tiers.length).toBeGreaterThanOrEqual(1);
      expect(b.tiers.length).toBeLessThanOrEqual(3);
      // Tier 1 IS the building's footprint — streets and minimap unchanged.
      expect(b.tiers[0]?.width).toBe(b.width);
      expect(b.tiers[0]?.depth).toBe(b.depth);
      // The stack reaches exactly the building's total height.
      const sum = b.tiers.reduce((h, t) => h + t.height, 0);
      expect(sum).toBe(b.height);
      for (const t of b.tiers) expect(t.height).toBeGreaterThan(0);
    }
  });

  it("sets every upper tier strictly back inside the tier below (wedding-cake silhouette)", () => {
    for (const b of city) {
      for (let i = 1; i < b.tiers.length; i++) {
        const below = b.tiers[i - 1];
        const t = b.tiers[i];
        if (!below || !t) throw new Error("tier missing");
        expect(t.width).toBeLessThan(below.width);
        expect(t.depth).toBeLessThan(below.depth);
        // Centered stack ⇒ shrinking sides keep every tier inside tier 1.
        expect(t.width).toBeGreaterThan(0);
        expect(t.depth).toBeGreaterThan(0);
      }
    }
  });

  it("gives every landmark the fixed slim-shaft-and-crown profile (spec literals)", () => {
    const landmarks = city.filter((b) => b.height === LANDMARK_HEIGHT);
    for (const b of landmarks) {
      expect(b.tiers).toEqual([
        { width: 90, depth: 90, height: 60 },
        { width: 62, depth: 62, height: 150 },
        { width: 34, depth: 34, height: 40 },
      ]);
    }
  });

  it("varies the skyline: seed 42 has slabs, 2-tier and 3-tier towers", () => {
    const counts = [0, 0, 0];
    for (const b of city) {
      if (b.height === LANDMARK_HEIGHT) continue;
      const i = b.tiers.length - 1;
      counts[i] = (counts[i] ?? 0) + 1;
    }
    expect(counts[0]).toBeGreaterThanOrEqual(10);
    expect(counts[1]).toBeGreaterThanOrEqual(10);
    expect(counts[2]).toBeGreaterThanOrEqual(5);
  });

  it("hand-places landmarks and plazas seed-independently (orientation must survive reseeds)", () => {
    const other = generateCity(7);
    const landmarkSpots = (bs: typeof city) =>
      bs
        .filter((b) => b.height === LANDMARK_HEIGHT)
        .map((b) => `${b.x},${b.z}`)
        .sort();
    expect(landmarkSpots(other)).toEqual(landmarkSpots(city));

    // Lots differ per seed, but which blocks are BUILT does not.
    const builtBlocks = (bs: typeof city) =>
      new Set(
        bs.map(
          (b) =>
            `${Math.floor(b.x / BLOCK_PITCH)},${Math.floor(b.z / BLOCK_PITCH)}`,
        ),
      );
    expect([...builtBlocks(other)].sort()).toEqual(
      [...builtBlocks(city)].sort(),
    );
  });
});

// --- C1: BSP lot subdivision into a continuous streetwall ---------------
// Blocks are subdivided into irregular lots that build out to the lot line,
// so the city is a streetwall rather than free-standing towers. The oracle
// for "did a lot spill into the street" is the S1 contract isInRoadway() —
// never a curb offset re-derived here (mirrors the S1 lamp test).

describe("generateCity BSP lots", () => {
  const city = generateCity(42);

  /** The four ground corners of a building's tier-1 footprint. */
  const corners = (b: {
    x: number;
    z: number;
    width: number;
    depth: number;
  }) => [
    { x: b.x - b.width / 2, y: 0, z: b.z - b.depth / 2 },
    { x: b.x + b.width / 2, y: 0, z: b.z - b.depth / 2 },
    { x: b.x - b.width / 2, y: 0, z: b.z + b.depth / 2 },
    { x: b.x + b.width / 2, y: 0, z: b.z + b.depth / 2 },
  ];

  it("subdivides blocks into many lots: a dense city, not 97 towers", () => {
    expect(city.length).toBeGreaterThanOrEqual(600);
    expect(city.length).toBeLessThanOrEqual(750);
  });

  it("never lets a lot corner reach the roadway (S1 street contract)", () => {
    for (const b of city) {
      for (const c of corners(b)) {
        expect(isInRoadway(c)).toBe(false);
      }
    }
  });

  it("never overlaps two lots", () => {
    // Brute-force O(n²) so the check carries no spatial assumption of its
    // own; violations are collected and asserted once (200k expect() calls
    // would take longer than the whole suite).
    const overlaps: string[] = [];
    for (let i = 0; i < city.length; i++) {
      for (let j = i + 1; j < city.length; j++) {
        const a = city[i];
        const b = city[j];
        if (!a || !b) throw new Error("building missing");
        const gapX = Math.abs(a.x - b.x) - (a.width + b.width) / 2;
        const gapZ = Math.abs(a.z - b.z) - (a.depth + b.depth) / 2;
        // Touching (gap === 0) is the party wall we want; overlap is not.
        if (Math.max(gapX, gapZ) < 0) {
          overlaps.push(`(${a.x},${a.z}) vs (${b.x},${b.z})`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });
});

describe("generateCity streetwall", () => {
  const city = generateCity(42);
  /** Buildable span of a block along one axis: the block inset by the sidewalk. */
  const spanOf = (b: number) =>
    [b * BLOCK_PITCH + LOT_LINE, (b + 1) * BLOCK_PITCH - LOT_LINE] as const;

  /** Every block index that carries at least one building. */
  const builtBlocks = () => {
    const blocks = new Map<string, typeof city>();
    for (const b of city) {
      const key = `${Math.floor(b.x / BLOCK_PITCH)},${Math.floor(b.z / BLOCK_PITCH)}`;
      const list = blocks.get(key) ?? [];
      list.push(b);
      blocks.set(key, list);
    }
    return blocks;
  };

  it("fronts every block edge along its full length — an unbroken streetwall", () => {
    // The property the whole ticket exists for: standing on any street and
    // looking at the block opposite, there is no gap you can see ground
    // through. Stated as interval coverage of each block edge by the
    // facades that sit ON it.
    const gaps: string[] = [];
    for (const [key, lots] of builtBlocks()) {
      const [bxs, bzs] = key.split(",");
      const bx = Number(bxs);
      const bz = Number(bzs);
      const [x0, x1] = spanOf(bx);
      const [z0, z1] = spanOf(bz);
      if (lots.length === 1) continue; // landmark block: one slim tower, by design

      const edges = [
        {
          name: "west",
          at: x0,
          along: [z0, z1] as const,
          on: (b: (typeof city)[number]) => b.x - b.width / 2,
          from: (b: (typeof city)[number]) =>
            [b.z - b.depth / 2, b.z + b.depth / 2] as const,
        },
        {
          name: "east",
          at: x1,
          along: [z0, z1] as const,
          on: (b: (typeof city)[number]) => b.x + b.width / 2,
          from: (b: (typeof city)[number]) =>
            [b.z - b.depth / 2, b.z + b.depth / 2] as const,
        },
        {
          name: "south",
          at: z0,
          along: [x0, x1] as const,
          on: (b: (typeof city)[number]) => b.z - b.depth / 2,
          from: (b: (typeof city)[number]) =>
            [b.x - b.width / 2, b.x + b.width / 2] as const,
        },
        {
          name: "north",
          at: z1,
          along: [x0, x1] as const,
          on: (b: (typeof city)[number]) => b.z + b.depth / 2,
          from: (b: (typeof city)[number]) =>
            [b.x - b.width / 2, b.x + b.width / 2] as const,
        },
      ];

      for (const edge of edges) {
        const spans = lots
          .filter((b) => edge.on(b) === edge.at)
          .map(edge.from)
          .sort((a, b) => a[0] - b[0]);
        let covered = edge.along[0];
        for (const [lo, hi] of spans) {
          if (lo > covered) break;
          covered = Math.max(covered, hi);
        }
        if (covered < edge.along[1]) {
          gaps.push(
            `block ${key} ${edge.name}: covered to ${covered}, needs ${edge.along[1]}`,
          );
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it("puts facing buildings exactly 2 × LOT_LINE apart across a street", () => {
    // STREET_WIDTH of roadway plus one sidewalk each side. Independently:
    // 30 + 2 × 5 = 40 m, and nothing may be closer than that.
    expect(2 * LOT_LINE).toBe(STREET_WIDTH + 2 * SIDEWALK_DEPTH);

    let minGap = Number.POSITIVE_INFINITY;
    for (const b of city) {
      for (const [near, far] of [
        [b.x - b.width / 2, b.x + b.width / 2],
        [b.z - b.depth / 2, b.z + b.depth / 2],
      ] as const) {
        // Distance from each facade plane to the block boundary it faces.
        minGap = Math.min(
          minGap,
          near % BLOCK_PITCH,
          BLOCK_PITCH - (far % BLOCK_PITCH),
        );
      }
    }
    // The closest any facade gets to a street centerline is the lot line, so
    // two facing facades are exactly 2 × LOT_LINE apart.
    expect(minGap).toBe(LOT_LINE);
  });
});

describe("generateCity lot variance and skyline", () => {
  const city = generateCity(42);
  const lots = city.filter((b) => b.height !== LANDMARK_HEIGHT);

  it("gives lots genuinely irregular widths — a spread, not one modal width", () => {
    // What separates BSP from a fixed n×n grid: a fixed 4×2 grid of the
    // 160 m buildable span would put every lot at one of 2 widths. Assert a
    // real distribution instead: many distinct widths, and no single width
    // owning a large share of the city.
    const widths = lots.map((b) => b.width);
    const distinct = new Set(widths);
    expect(distinct.size).toBeGreaterThan(50);

    const counts = new Map<number, number>();
    for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1);
    const modal = Math.max(...counts.values());
    expect(modal / widths.length).toBeLessThan(0.1);

    // And the spread reaches both ends of what subdivision can produce.
    expect(Math.min(...widths)).toBeLessThanOrEqual(40);
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(100);
  });

  it("never leaves a lot narrower than a lot can legally be", () => {
    // LOT_MIN_WIDTH bounds every SPLIT; the rear-yard inset may then pull a
    // side in, but never past half of it.
    for (const b of lots) {
      expect(Math.min(b.width, b.depth)).toBeGreaterThanOrEqual(
        LOT_MIN_WIDTH / 2,
      );
    }
  });

  it("shapes the skyline as a low streetwall with a thin tower tail", () => {
    // The spec is HEIGHT_BANDS: 70% under 60 m, 90% under 120 m, 2% above
    // 190 m. Bounds are loose enough to be a distribution check, not a
    // restatement of the table.
    const heights = lots.map((b) => b.height);
    const share = (max: number) =>
      heights.filter((h) => h <= max).length / heights.length;
    expect(share(60)).toBeGreaterThan(0.6);
    expect(share(60)).toBeLessThan(0.8);
    expect(share(120)).toBeGreaterThan(0.85);
    expect(share(190)).toBeGreaterThan(0.95);
    expect(share(190)).toBeLessThan(0.995);
  });

  it("keeps every lot strictly shorter than a landmark, so height still identifies one", () => {
    // minimap, roof beacons, facade archetypes and the city's neon tint all
    // test `b.height >= LANDMARK_HEIGHT`. That stays a valid landmark test
    // only while no ordinary lot can reach it.
    for (const b of lots) {
      expect(b.height).toBeLessThan(LANDMARK_HEIGHT);
      expect(b.height).toBeGreaterThanOrEqual(BUILDING_MIN_HEIGHT);
      expect(b.height).toBeLessThanOrEqual(BUILDING_MAX_HEIGHT);
    }
  });
});

describe("generateCity block independence", () => {
  /**
   * Build a city with a DIFFERENT hand-placed layout by swapping the module
   * that owns the two lists. The generator is still reached through its own
   * public entry point — only the fixed orientation data changes.
   */
  async function cityWithLayout(
    landmarks: ReadonlyArray<readonly [number, number]>,
    plazas: ReadonlyArray<readonly [number, number]>,
  ) {
    vi.resetModules();
    vi.doMock("@angels-bandits/common/city/layout", () => ({
      LANDMARK_BLOCKS: landmarks,
      PLAZA_BLOCKS: plazas,
    }));
    const mod = await import("@angels-bandits/common/city");
    const city = mod.generateCity(42);
    vi.doUnmock("@angels-bandits/common/city/layout");
    return city;
  }

  /** Buildings of one block, keyed so two cities can be compared block by block. */
  const byBlock = (city: ReturnType<typeof generateCity>) => {
    const out = new Map<string, string>();
    for (const b of city) {
      const key = `${Math.floor(b.x / BLOCK_PITCH)},${Math.floor(b.z / BLOCK_PITCH)}`;
      out.set(key, (out.get(key) ?? "") + JSON.stringify(b));
    }
    return out;
  };

  it("leaves every other block byte-identical when the plaza list changes", async () => {
    // The rule the old generator needed a "draw the randoms anyway" hack for.
    // Per-block PRNG streams make it structural: a block's lots are a pure
    // function of (seed, bx, bz).
    const base = byBlock(await cityWithLayout(LANDMARK_BLOCKS, PLAZA_BLOCKS));
    const moved = byBlock(
      await cityWithLayout(LANDMARK_BLOCKS, [...PLAZA_BLOCKS, [0, 0], [3, 6]]),
    );

    const changed = [...base.keys()].filter(
      (key) => base.get(key) !== moved.get(key),
    );
    expect(changed.sort()).toEqual(["0,0", "3,6"]);
  });

  it("leaves every other block byte-identical when the landmark list changes", async () => {
    const base = byBlock(await cityWithLayout(LANDMARK_BLOCKS, PLAZA_BLOCKS));
    const moved = byBlock(
      await cityWithLayout([...LANDMARK_BLOCKS, [1, 1]], PLAZA_BLOCKS),
    );

    const changed = [...base.keys()].filter(
      (key) => base.get(key) !== moved.get(key),
    );
    expect(changed).toEqual(["1,1"]);
  });
});
