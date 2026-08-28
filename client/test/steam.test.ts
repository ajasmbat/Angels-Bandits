// The L1 steam seam: vent layout (hard-capped in the PURE function, so the
// cap can never depend on where the camera stands) and puff pose.

import { generateCity } from "@angels-bandits/common/city";
import type { Building } from "@angels-bandits/common/city";
import { isInRoadway } from "@angels-bandits/common/city/street";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { roofClutterFor } from "../src/render/roofclutter";
import {
  MAX_VENTS_PER_BLOCK,
  PUFFS_PER_VENT,
  puffPose,
  steamVentsForBlock,
} from "../src/render/steam";

const SEED = 42;

const bucketed = (() => {
  const map = new Map<number, Building[]>();
  for (const b of generateCity(SEED)) {
    const key =
      Math.floor(b.x / BLOCK_PITCH) * 1000 + Math.floor(b.z / BLOCK_PITCH);
    const list = map.get(key);
    if (list) list.push(b);
    else map.set(key, [b]);
  }
  return map;
})();

const blockOf = (bx: number, bz: number) => bucketed.get(bx * 1000 + bz) ?? [];

describe("steamVentsForBlock", () => {
  it("is deterministic: same (seed, block, buildings) ⇒ identical vents", () => {
    const a = steamVentsForBlock(4, 6, blockOf(4, 6), SEED);
    const b = steamVentsForBlock(4, 6, blockOf(4, 6), SEED);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(
      JSON.stringify(steamVentsForBlock(4, 6, blockOf(4, 6), SEED + 1)),
    );
  });

  it("NEVER exceeds the hard cap, on any block", () => {
    for (let bx = 0; bx < 10; bx++) {
      for (let bz = 0; bz < 10; bz++) {
        expect(
          steamVentsForBlock(bx, bz, blockOf(bx, bz), SEED).length,
        ).toBeLessThanOrEqual(MAX_VENTS_PER_BLOCK);
      }
    }
  });

  it("truncates POSITION-INDEPENDENTLY — the two-tab determinism trap", () => {
    // Overflow dropped in window-iteration order would be dropped by camera
    // position, so two tabs would draw different steam. Feeding the block's
    // buildings in a different order must not change which vents survive.
    for (const [bx, bz] of [
      [4, 6],
      [7, 2],
      [1, 9],
    ] as const) {
      const forward = steamVentsForBlock(bx, bz, blockOf(bx, bz), SEED);
      const reversed = steamVentsForBlock(
        bx,
        bz,
        [...blockOf(bx, bz)].reverse(),
        SEED,
      );
      expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    }
  });

  it("keeps every street vent out of the roadway", () => {
    for (let bx = 0; bx < 10; bx++) {
      for (let bz = 0; bz < 10; bz++) {
        for (const v of steamVentsForBlock(bx, bz, blockOf(bx, bz), SEED)) {
          if (v.roof) continue;
          expect(isInRoadway({ x: v.x, y: 0, z: v.z })).toBe(false);
        }
      }
    }
  });

  it("anchors every roof vent on a real AC unit of a real building of that block", () => {
    let roofVents = 0;
    for (let bx = 0; bx < 10; bx++) {
      for (let bz = 0; bz < 10; bz++) {
        const buildings = blockOf(bx, bz);
        for (const v of steamVentsForBlock(bx, bz, buildings, SEED)) {
          if (!v.roof) continue;
          roofVents++;
          const onABox = buildings.some((b) =>
            roofClutterFor(b).acBoxes.some(
              (box) =>
                Math.abs(box.x - v.x) < 1e-6 &&
                Math.abs(box.z - v.z) < 1e-6 &&
                Math.abs(box.y + box.height - v.y) < 1e-6,
            ),
          );
          expect(onABox).toBe(true);
        }
      }
    }
    // Guard against the assertion passing vacuously.
    expect(roofVents).toBeGreaterThan(0);
  });
});

describe("puffPose", () => {
  const vent = steamVentsForBlock(4, 6, blockOf(4, 6), SEED)[0];

  it("has vents to test at all", () => {
    expect(vent).toBeDefined();
  });

  it("is deterministic at a pinned server time", () => {
    if (!vent) return;
    const at = 987.654;
    expect(
      JSON.stringify(
        Array.from({ length: PUFFS_PER_VENT }, (_, j) => puffPose(vent, j, at)),
      ),
    ).toBe(
      JSON.stringify(
        Array.from({ length: PUFFS_PER_VENT }, (_, j) => puffPose(vent, j, at)),
      ),
    );
  });

  it("rises monotonically with age and never dips below its vent", () => {
    if (!vent) return;
    let prev = -1;
    let prevAge = -1;
    for (let t = 0; t < 5; t += 0.05) {
      const p = puffPose(vent, 0, t);
      // Within a single life the plume climbs; the wrap back to age 0 resets.
      if (p.age > prevAge) expect(p.pos.y).toBeGreaterThanOrEqual(prev);
      expect(p.pos.y).toBeGreaterThanOrEqual(vent.y);
      expect(p.pos.y).toBeLessThanOrEqual(vent.y + vent.rise + 1e-9);
      prev = p.pos.y;
      prevAge = p.age;
    }
  });

  it("spreads its puffs evenly through the life cycle", () => {
    if (!vent) return;
    const ages = Array.from(
      { length: PUFFS_PER_VENT },
      (_, j) => puffPose(vent, j, 0).age,
    ).sort((a, b) => a - b);
    for (let i = 1; i < ages.length; i++) {
      expect((ages[i] as number) - (ages[i - 1] as number)).toBeCloseTo(
        1 / PUFFS_PER_VENT,
        6,
      );
    }
  });

  it("grows then collapses, so a constant-opacity material still fades out", () => {
    if (!vent) return;
    // Sample sizes across one life by driving `age` through the phase.
    const sizes: { age: number; size: number }[] = [];
    for (let t = 0; t < 5.5; t += 0.05) {
      const p = puffPose(vent, 0, t);
      sizes.push({ age: p.age, size: p.size });
    }
    const young = sizes.filter((s) => s.age > 0.1 && s.age < 0.2);
    const mid = sizes.filter((s) => s.age > 0.6 && s.age < 0.7);
    const dying = sizes.filter((s) => s.age > 0.97);
    expect(Math.max(...mid.map((s) => s.size))).toBeGreaterThan(
      Math.max(...young.map((s) => s.size)),
    );
    expect(Math.max(...dying.map((s) => s.size))).toBeLessThan(
      Math.min(...mid.map((s) => s.size)),
    );
  });
});
