// D4 wreck model: the fall is a pure, deterministic function of the death
// event, and the server's sweep ends it on the FIRST solid below — a facade,
// a roof, the street, the river, the train viaduct, a mover.

import { type Building, generateCity } from "@angels-bandits/common/city";
import {
  aircraftBox,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import type { MoverBox } from "@angels-bandits/common/city/movers";
import { RIVER_CENTER_Z, overChannel } from "@angels-bandits/common/city/river";
import {
  buildCityIndex,
  collideCity,
  hitsGround,
} from "@angels-bandits/common/collision";
import {
  CITY_SEED,
  WORLD_SIZE,
  WRECK_MAX_MS,
  WRECK_RADIUS,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import {
  type WreckPath,
  type WreckWorld,
  isWreckParams,
  wreckImpact,
  wreckNear,
  wreckPosAt,
  wreckTouches,
  wreckVelAt,
} from "@angels-bandits/common/wreck";
import { describe, expect, it } from "vitest";

const city = generateCity(CITY_SEED);
const index = buildCityIndex(city);
const movers = generateMovers(CITY_SEED, city);
const pos = (w: WreckPath, ms: number): Vec3 =>
  wreckPosAt(w, ms, { x: 0, y: 0, z: 0 });

const path: WreckPath = {
  p: { x: 1990, y: 300, z: 15 },
  v: { x: 60, y: 10, z: -25 },
  t: 1_000_000,
  spin: -1,
  end: 9000,
};

/** A plain tall tower: no holes, no roof structures. */
const tower = city.find(
  (b) => !b.holes && !b.roof && b.height >= 60 && b.tiers.length === 1,
) as Building;

describe("wreck path", () => {
  it("is pure and deterministic: same event, same fall; inputs untouched", () => {
    const copy = structuredClone(path);
    for (let ms = path.t - 500; ms <= path.t + path.end + 500; ms += 137) {
      expect(pos(path, ms)).toEqual(pos(structuredClone(path), ms));
    }
    expect(path).toEqual(copy);
  });

  it("starts at the death point, holds it before, and stops at `end`", () => {
    const at0 = pos(path, path.t);
    expect(wrapDistance(at0, path.p)).toBeLessThan(1e-9);
    expect(pos(path, path.t - 2000)).toEqual(at0);
    expect(pos(path, path.t + path.end + 5000)).toEqual(
      pos(path, path.t + path.end),
    );
  });

  it("stays canonical across the seam and its velocity is the derivative", () => {
    const v = { x: 0, y: 0, z: 0 };
    for (let ms = path.t; ms < path.t + path.end; ms += 250) {
      const a = pos(path, ms);
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThan(WORLD_SIZE);
      expect(a.z).toBeGreaterThanOrEqual(0);
      expect(a.z).toBeLessThan(WORLD_SIZE);
      const b = pos(path, ms + 1);
      wreckVelAt(path, ms, v);
      const fd = wrapDistance(a, b) * 1000;
      expect(Math.abs(Math.hypot(v.x, v.y, v.z) - fd)).toBeLessThan(0.5);
    }
    // Starts at the death velocity, then sinks toward the terminal rate.
    wreckVelAt(path, path.t, v);
    expect(v.x).toBeCloseTo(path.v.x, 6);
    expect(v.y).toBeCloseTo(path.v.y, 6);
    expect(v.z).toBeCloseTo(path.v.z, 6);
    wreckVelAt(path, path.t + 8000, v);
    expect(v.y).toBeLessThan(-60);
  });

  it("spirals: the horizontal track turns more than a full circle", () => {
    const v = { x: 0, y: 0, z: 0 };
    let turned = 0;
    let prev: number | null = null;
    for (let ms = path.t + 3000; ms < path.t + 8000; ms += 50) {
      wreckVelAt(path, ms, v);
      const a = Math.atan2(v.z, v.x);
      if (prev !== null) {
        let d = a - prev;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        turned += d;
      }
      prev = a;
    }
    expect(Math.abs(turned)).toBeGreaterThan(2 * Math.PI);
    expect(Math.sign(turned)).toBe(path.spin);
  });
});

describe("wreck sweep (first solid)", () => {
  /** The sweep's answer, re-checked against the solids: clear just before
   * `end`, touching at it. */
  const sweep = (
    start: Omit<WreckPath, "end">,
    world: WreckWorld = { buildings: city, index, movers },
  ) => {
    const impact = wreckImpact(start, world);
    const full = { ...start, end: WRECK_MAX_MS };
    return {
      impact,
      at: pos(full, start.t + impact.end),
      before: pos(full, start.t + impact.end - 1),
    };
  };

  it("is deterministic", () => {
    const start = {
      p: { x: tower.x, y: tower.height + 60, z: tower.z },
      v: { x: 0, y: 0, z: 0 },
      t: 5000,
      spin: 1 as const,
    };
    expect(wreckImpact(start, { buildings: city, index, movers })).toEqual(
      wreckImpact(structuredClone(start), { buildings: city, index, movers }),
    );
  });

  it("lands on a roof, not the street under it", () => {
    const { impact, at, before } = sweep({
      p: { x: tower.x, y: tower.height + 30, z: tower.z },
      v: { x: 0, y: 0, z: 0 },
      t: 0,
      spin: 1,
    });
    expect(impact.hit).toBe("city");
    expect(at.y).toBeGreaterThan(tower.height - 1);
    expect(collideCity(at, WRECK_RADIUS, city, index)).not.toBeNull();
    expect(collideCity(before, WRECK_RADIUS, city, index)).toBeNull();
  });

  it("hits a facade it is flying at, high above the street", () => {
    const y = tower.height / 2;
    const { impact, at } = sweep({
      p: { x: tower.x - tower.width / 2 - 25, y, z: tower.z },
      v: { x: 90, y: 0, z: 0 },
      t: 0,
      spin: -1,
    });
    expect(impact.hit).toBe("city");
    expect(at.y).toBeGreaterThan(y - 10);
    expect(collideCity(at, WRECK_RADIUS, [tower])).not.toBeNull();
    expect(impact.end).toBeLessThan(1000);
  });

  it("hits the street where nothing stands", () => {
    const { impact, at, before } = sweep(
      {
        p: { x: 500, y: 200, z: 500 },
        v: { x: 20, y: 0, z: 0 },
        t: 0,
        spin: 1,
      },
      { buildings: [] },
    );
    expect(impact.hit).toBe("ground");
    expect(at.y).toBeLessThanOrEqual(WRECK_RADIUS + 1e-6);
    expect(hitsGround(before, WRECK_RADIUS)).toBe(false);
  });

  it("splashes into the river over the channel", () => {
    // Mid-span between two bridges: x at a block's middle.
    const x = 100 + 7 * 200;
    expect(overChannel(RIVER_CENTER_Z)).toBe(true);
    const { impact, at } = sweep(
      {
        p: { x, y: 120, z: RIVER_CENTER_Z },
        v: { x: 0, y: 0, z: 0 },
        t: 0,
        spin: 1,
      },
      { buildings: [] },
    );
    expect(impact.hit).toBe("river");
    expect(at.y).toBeLessThan(0);
  });

  it("stops on the train viaduct", () => {
    const line = movers.trains?.[0];
    if (!line) throw new Error("no train line in the seed city");
    const deck = line.viaduct.reduce((a: MoverBox, b: MoverBox) =>
      b.hx * b.hz > a.hx * a.hz ? b : a,
    );
    const { impact, at } = sweep({
      p: { x: deck.x, y: deck.y + deck.hy + 8, z: deck.z },
      v: { x: 0, y: 0, z: 0 },
      t: 0,
      spin: 1,
    });
    expect(impact.hit).toBe("mover");
    expect(["viaduct", "train"]).toContain(impact.mover);
    expect(at.y).toBeGreaterThan(deck.y - deck.hy);
  });

  it("stops on a moving mover at its future time (the blimp), and only with movers", () => {
    const blimp = movers.aircraft.find((a) => a.kind === "blimp");
    if (!blimp) throw new Error("no blimp");
    const t = 123_456;
    const box = aircraftBox(blimp, t);
    const start = {
      p: { x: box.x, y: box.y + box.hy + 12, z: box.z },
      v: { x: 0, y: 0, z: 0 },
      t,
      spin: 1 as const,
    };
    const { impact } = sweep(start);
    expect(impact.hit).toBe("mover");
    expect(impact.mover).toBe("blimp");
    expect(wreckImpact(start, { buildings: city, index }).hit).not.toBe(
      "mover",
    );
  });

  it("explodes in the air at WRECK_MAX_MS when nothing is there", () => {
    const far = wreckImpact(
      { p: { x: 0, y: 1e5, z: 0 }, v: { x: 0, y: 0, z: 0 }, t: 0, spin: 1 },
      { buildings: [] },
    );
    expect(far).toEqual({ end: WRECK_MAX_MS, hit: "air" });
  });
});

describe("wreck contact", () => {
  it("is solid only while falling, within WRECK_RADIUS + radius", () => {
    const at = pos(path, path.t + 2000);
    expect(wreckTouches(path, at, 2, path.t + 2000)).toBe(true);
    const off = { ...at, y: at.y + WRECK_RADIUS + 2.5 };
    expect(wreckTouches(path, off, 2, path.t + 2000)).toBe(false);
    expect(wreckTouches(path, path.p, 2, path.t - 1)).toBe(false);
    const rest = pos(path, path.t + path.end);
    expect(wreckTouches(path, rest, 2, path.t + path.end + 1)).toBe(false);
  });

  it("wreckNear sees a pass anywhere inside the window, not outside it", () => {
    const at = pos(path, path.t + 3000);
    expect(wreckNear(path, at, 1, path.t + 2500, path.t + 3500)).toBe(true);
    expect(wreckNear(path, at, 1, path.t + 4000, path.t + 5000)).toBe(false);
  });

  it("rejects malformed wire wrecks", () => {
    const ok = { ...path, id: 3, hit: "city" };
    expect(isWreckParams(ok)).toBe(true);
    expect(isWreckParams({ ...ok, end: WRECK_MAX_MS + 1 })).toBe(false);
    expect(isWreckParams({ ...ok, end: -1 })).toBe(false);
    expect(isWreckParams({ ...ok, t: Number.NaN })).toBe(false);
    expect(isWreckParams({ ...ok, p: { x: 1, y: 2 } })).toBe(false);
    expect(isWreckParams({ ...ok, spin: 0 })).toBe(false);
    expect(isWreckParams({ ...ok, hit: "moon" })).toBe(false);
    expect(isWreckParams(null)).toBe(false);
  });
});
