// C1 low-flying chaos, the pure half (common/src/lowchaos.ts): who is low
// (below the local roofline, under LOW_ENTER_ALT, among towers — with
// hysteresis), when the low slots come (2–4 s apart, pure in seed and time)
// and what counts as a fair event (a way out: straight on, a normal turn or
// a gentle climb).

import {
  type Building,
  CityDamage,
  chunksOf,
  generateCity,
  makeBuilding,
} from "@angels-bandits/common/city";
import { BLOCK_PITCH, CITY_SEED } from "@angels-bandits/common/constants";
import type { DangerZone } from "@angels-bandits/common/director";
import {
  ESCAPE_CLIMB,
  ESCAPE_LEFT,
  ESCAPE_RIGHT,
  ESCAPE_STRAIGHT,
  LOW_ENTER_ALT,
  LOW_EXIT_ALT,
  LOW_INTERVAL_MAX_MS,
  LOW_INTERVAL_MIN_MS,
  LOW_ROOF_MARGIN,
  LOW_TOWERS_MIN,
  clearOf,
  escapeFrom,
  localRoofline,
  lowChaosLevel,
  lowSlotsInWindow,
} from "@angels-bandits/common/lowchaos";
import type { Vec3 } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const CITY = generateCity(CITY_SEED);

/** Street intersections, by local roofline. */
const SPOTS = (() => {
  const out: { pos: Vec3; roof: number }[] = [];
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      const pos = { x: i * BLOCK_PITCH, y: 0, z: j * BLOCK_PITCH };
      out.push({ pos, roof: localRoofline(CITY, pos) });
    }
  }
  return out.sort((a, b) => b.roof - a.roof);
})();
const CANYON = SPOTS.find((s) => s.roof >= LOW_EXIT_ALT + 30) as {
  pos: Vec3;
  roof: number;
};

const at = (p: Vec3, y: number): Vec3 => ({ x: p.x, y, z: p.z });

describe("lowChaosLevel", () => {
  it("is low down among the towers, deeper the lower, and never up high", () => {
    expect(CANYON).toBeDefined();
    const city = { buildings: CITY };
    const levels = [5, 30, 60, 90, 115].map((y) =>
      lowChaosLevel({ pos: at(CANYON.pos, y) }, city),
    );
    for (const l of levels) expect(l).toBeGreaterThan(0);
    for (let k = 1; k < levels.length; k++) {
      expect(levels[k]).toBeLessThan(levels[k - 1] as number);
    }
    for (const y of [LOW_ENTER_ALT, 200, 400]) {
      expect(lowChaosLevel({ pos: at(CANYON.pos, y) }, city)).toBe(0);
    }
    // Under the street (a tunnel) belongs to the cave-ins.
    expect(lowChaosLevel({ pos: at(CANYON.pos, -6) }, city)).toBe(0);
  });

  it("needs towers: over open ground or low-rise it is never low", () => {
    // The seed city has towers round every intersection; flatten it to a
    // low-rise streetwall on the same footprints (T1: its edges start at
    // 55 m, so it has no low-rise of its own any more) — and then nothing
    // at all.
    const h = LOW_TOWERS_MIN - 5;
    const lowRise = CITY.map((b) =>
      makeBuilding({
        x: b.x,
        z: b.z,
        width: b.width,
        depth: b.depth,
        height: h,
        tiers: [{ width: b.width, depth: b.depth, height: h }],
      }),
    );
    expect(lowRise.length).toBeGreaterThan(10);
    for (const s of SPOTS) {
      for (const buildings of [lowRise, []]) {
        expect(lowChaosLevel({ pos: at(s.pos, 20) }, { buildings })).toBe(0);
      }
    }
    // ...while the same spots with the towers back are mostly canyons.
    const low = SPOTS.filter(
      (s) => lowChaosLevel({ pos: at(s.pos, 20) }, { buildings: CITY }) > 0,
    );
    expect(low.length).toBeGreaterThan(SPOTS.length / 2);
  });

  it("only counts what still stands of the roofline (D8)", () => {
    // A lone tower: low beside it whole, not once it is gone.
    const i = CITY.findIndex((b) => b.height >= 150 && !b.holes);
    const b = CITY[i] as Building;
    const lone = [makeBuilding({ ...b, damage: undefined })];
    const pos = { x: b.x + b.width / 2 + 20, y: 50, z: b.z };
    expect(lowChaosLevel({ pos }, { buildings: lone })).toBeGreaterThan(0);
    const damage = new CityDamage();
    damage.bind(lone);
    damage.collapse(chunksOf(lone[0] as Building, 0));
    expect(localRoofline(lone, pos)).toBe(0);
    expect(lowChaosLevel({ pos }, { buildings: lone })).toBe(0);
  });

  it("has hysteresis: a low plane stays low a little higher than it entered", () => {
    const city = { buildings: CITY };
    const exit = Math.min(LOW_EXIT_ALT, CANYON.roof + LOW_ROOF_MARGIN);
    const band = (LOW_ENTER_ALT + exit) / 2;
    expect(lowChaosLevel({ pos: at(CANYON.pos, band) }, city)).toBe(0);
    expect(
      lowChaosLevel({ pos: at(CANYON.pos, band), wasLow: true }, city),
    ).toBeGreaterThan(0);
    expect(
      lowChaosLevel({ pos: at(CANYON.pos, exit + 1), wasLow: true }, city),
    ).toBe(0);
    // A climb out and a dive back, sampled every 2 m: low from the start,
    // out only over the exit, back in only under LOW_ENTER_ALT.
    let low = true;
    const flips: number[] = [];
    const ys = [
      ...Array.from({ length: 90 }, (_, k) => 40 + 2 * k),
      ...Array.from({ length: 90 }, (_, k) => 220 - 2 * k),
    ];
    for (const y of ys) {
      const now: boolean =
        lowChaosLevel({ pos: at(CANYON.pos, y), wasLow: low }, city) > 0;
      if (now !== low) flips.push(y);
      low = now;
    }
    expect(flips.length).toBe(2);
    expect(flips[0]).toBeGreaterThanOrEqual(exit);
    expect(flips[0]).toBeLessThan(exit + 2);
    expect(flips[1]).toBeLessThan(LOW_ENTER_ALT);
    expect(flips[1]).toBeGreaterThanOrEqual(LOW_ENTER_ALT - 2);
  });

  it("is pure", () => {
    const city = { buildings: CITY };
    const p = { pos: at(CANYON.pos, 70), wasLow: false };
    expect(lowChaosLevel(p, city)).toBe(lowChaosLevel(p, city));
  });
});

describe("lowSlotsInWindow", () => {
  it("is pure, partitions the timeline and keeps 2–4 s between slots", () => {
    const a = lowSlotsInWindow(42, 0, 600_000);
    expect(lowSlotsInWindow(42, 0, 600_000)).toEqual(a);
    const split = [
      ...lowSlotsInWindow(42, 0, 250_123),
      ...lowSlotsInWindow(42, 250_123, 600_000),
    ];
    expect(split).toEqual(a);
    expect(a.length).toBeGreaterThan(140);
    for (let k = 1; k < a.length; k++) {
      const gap = (a[k] as number) - (a[k - 1] as number);
      expect(gap).toBeGreaterThanOrEqual(LOW_INTERVAL_MIN_MS);
      expect(gap).toBeLessThanOrEqual(LOW_INTERVAL_MAX_MS);
    }
    expect(lowSlotsInWindow(43, 0, 600_000)).not.toEqual(a);
  });
});

describe("escapeFrom (fairness)", () => {
  const pos = { x: 1000, y: 60, z: 1000 };
  const vel = { x: 85, y: 0, z: 0 };
  /** A 40 × 40 m block of danger `ahead` m down the path, to `top`. */
  const box = (ahead: number, side = 0, top = 200): DangerZone => ({
    x0: ahead - 20,
    x1: ahead + 20,
    z0: side - 20,
    z1: side + 20,
    top,
  });

  it("straight on when the danger is beside the path or already passed", () => {
    expect(escapeFrom(box(255, 60), 1000, 1000, pos, vel, 3, 6)).toBe(
      ESCAPE_STRAIGHT,
    );
    // Right in the path, but live only once the plane is long past.
    expect(escapeFrom(box(100), 1000, 1000, pos, vel, 3, 6)).toBe(
      ESCAPE_STRAIGHT,
    );
  });

  it("a normal turn or a gentle climb when it lands on the path ahead", () => {
    // 300 m ahead (3.5 s), live from 3 s: straight on flies into it.
    const z = box(300);
    expect(clearOf(z, 1000, 1000, pos, vel, 3, 6, ESCAPE_STRAIGHT)).toBe(false);
    expect([ESCAPE_LEFT, ESCAPE_RIGHT]).toContain(
      escapeFrom(z, 1000, 1000, pos, vel, 3, 6),
    );
    // Low, and too wide and deep to turn away from: the climb gets over it.
    const wide: DangerZone = { x0: 240, x1: 600, z0: -400, z1: 400, top: 70 };
    expect(escapeFrom(wide, 1000, 1000, pos, vel, 3, 6)).toBe(ESCAPE_CLIMB);
  });

  it("none when the danger is all round the plane: unfair", () => {
    const all: DangerZone = { x0: -900, x1: 900, z0: -900, z1: 900, top: 900 };
    expect(escapeFrom(all, 1000, 1000, pos, vel, 1, 4)).toBe(-1);
  });

  it("measures across the seam", () => {
    const seam = { x: 1990, y: 60, z: 1000 };
    // 300 m ahead of a plane at x 1990 is x 290 once wrapped.
    expect(clearOf(box(0), 290, 1000, seam, vel, 3, 6, ESCAPE_STRAIGHT)).toBe(
      false,
    );
    expect(clearOf(box(0), 290, 1000, seam, vel, 5, 6, ESCAPE_STRAIGHT)).toBe(
      true,
    );
  });
});
