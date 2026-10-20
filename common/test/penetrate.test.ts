// P1 penetrating impacts (common/src/city/penetrate.ts) on the real seed
// city: the sweep is deterministic; faster or heavier goes deeper; it comes
// to rest at zero speed; with energy to spare it carries out of one
// building into the next; it never breaks more than its cap (nor a gone
// chunk); it is bounded in cost; the body's timeline runs origin → stop;
// the impact record round-trips the wire to the same sweep; and a bench
// holds p99 to 0.2 ms per sweep.

import {
  type Building,
  CityDamage,
  type TierGrid,
  chunkBuilding,
  chunkTier,
  generateCity,
  makeBuilding,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  IMPACTORS,
  IMPACT_COMET,
  IMPACT_METEOR,
  IMPACT_PLANE,
  type Impactor,
  SWEEP_COST_PER_M3,
  SWEEP_END_CAP,
  SWEEP_END_ENERGY,
  SWEEP_END_GROUND,
  SWEEP_END_NONE,
  SWEEP_LANDMARK_HARDNESS,
  SWEEP_MAX_DIST,
  SWEEP_STEP_M,
  chunkCentre,
  decodeImpact,
  encodeImpact,
  makeImpact,
  sweepDistAt,
  sweepImpact,
  sweepPosAt,
  sweepRecord,
  sweepSpeedAt,
} from "@angels-bandits/common/city/penetrate";
import {
  CITY_SEED,
  LANDMARK_HEIGHT,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const city = generateCity(CITY_SEED);
const freshCity = (): Building[] => city.map((b) => makeBuilding(b));

/** Mid-height towers, 120–300 m: room for a horizontal tunnel. */
const towers = city
  .map((b, i) => ({ b, i }))
  .filter(({ b }) => b.height > 120 && b.height < 300)
  .slice(0, 12);

/** A plane flying into tower `b`'s −x facade at `speed`, from 3 m out. */
const intoFacade = (b: Building, speed: number, mass = 5): Impactor => ({
  origin: { x: b.x - b.width / 2 - 3, y: Math.min(60, b.height / 2), z: b.z },
  velocity: { x: speed, y: -0.08 * speed, z: 0 },
  mass,
  radius: 3,
});

describe("P1 sweepImpact", () => {
  it("has towers to test against", () => {
    expect(towers.length).toBeGreaterThanOrEqual(8);
  });

  it("is deterministic: the same impactor against the same city gives the same tunnel", () => {
    for (const { b } of towers) {
      const imp = intoFacade(b, 85);
      const a = sweepImpact(imp, city);
      const again = sweepImpact(imp, freshCity());
      expect(again).toEqual(a);
      expect(a.chunks.length).toBeGreaterThan(0);
    }
  });

  it("goes deeper the faster or heavier it hits", () => {
    let strictly = 0;
    for (const { b } of towers) {
      const slow = sweepImpact(intoFacade(b, 50), city);
      const fast = sweepImpact(intoFacade(b, 95), city);
      const heavy = sweepImpact(intoFacade(b, 50, 15), city);
      expect(fast.chunks.length).toBeGreaterThanOrEqual(slow.chunks.length);
      expect(fast.stopDist).toBeGreaterThanOrEqual(slow.stopDist);
      expect(heavy.chunks.length).toBeGreaterThanOrEqual(slow.chunks.length);
      expect(heavy.stopDist).toBeGreaterThanOrEqual(slow.stopDist);
      if (fast.chunks.length > slow.chunks.length) strictly++;
    }
    expect(strictly).toBeGreaterThan(towers.length / 2);
  });

  it("comes to rest at zero speed, having spent no more than it carried", () => {
    for (const { b } of towers) {
      const imp = intoFacade(b, 80);
      const res = sweepImpact(imp, city);
      expect(res.end).toBe(SWEEP_END_ENERGY);
      expect(sweepSpeedAt(res, res.stopT)).toBe(0);
      expect(res.knots.at(-1)).toBeCloseTo(0, 6);
      // Every chunk it broke was paid for out of ½·m·v².
      const e0 = 0.5 * imp.mass * 80 * 80;
      let spent = 0;
      for (const id of res.chunks) {
        const t = city[chunkBuilding(id)] as Building;
        const g = tierGrids(t)[chunkTier(id)] as TierGrid;
        const hard = t.height >= LANDMARK_HEIGHT ? SWEEP_LANDMARK_HARDNESS : 1;
        spent += g.cw * g.ch * g.cd * SWEEP_COST_PER_M3 * hard;
        expect(chunkCentre(city, id, { x: 0, y: 0, z: 0 })).not.toBeNull();
      }
      expect(spent).toBeLessThanOrEqual(e0 + 1e-6);
      // It decelerates: the speed never rises along the timeline.
      for (let k = 5; k < res.knots.length; k += 3) {
        expect(res.knots[k] as number).toBeLessThanOrEqual(
          (res.knots[k - 3] as number) + 1e-9,
        );
      }
    }
  });

  it("carries out of one building into the next when the energy allows", () => {
    let through = 0;
    for (const { b } of towers) {
      const spec = IMPACTORS[IMPACT_COMET];
      const res = sweepImpact(
        {
          origin: {
            x: b.x - b.width / 2 - 3,
            y: Math.min(60, b.height / 2),
            z: b.z,
          },
          velocity: { x: 230, y: -20, z: 0 },
          mass: spec?.mass ?? 1,
          radius: spec?.radius ?? 1,
        },
        city,
        { maxChunks: spec?.maxChunks },
      );
      const hit = new Set(res.chunks.map(chunkBuilding));
      if (hit.size >= 2) through++;
      // In path order: entry distances and times never go backwards.
      for (let k = 1; k < res.chunks.length; k++) {
        expect(res.dists[k] as number).toBeGreaterThanOrEqual(
          res.dists[k - 1] as number,
        );
        expect(res.times[k] as number).toBeGreaterThanOrEqual(
          res.times[k - 1] as number,
        );
      }
    }
    expect(through).toBeGreaterThan(towers.length / 2);
  });

  it("never breaks more than its cap, nor a chunk already gone", () => {
    const { b } = towers[0] as { b: Building };
    const capped = sweepImpact(intoFacade(b, 200, 50), city, { maxChunks: 3 });
    expect(capped.chunks.length).toBe(3);
    expect(capped.end).toBe(SWEEP_END_CAP);
    for (const { b: t } of towers) {
      const res = sweepImpact(intoFacade(t, 200, 50), city, { maxChunks: 8 });
      expect(res.chunks.length).toBeLessThanOrEqual(8);
      expect(new Set(res.chunks).size).toBe(res.chunks.length);
    }
    // Gone chunks are air: blow out the first chunk the tunnel names and
    // the same impact skips it and reaches further.
    const fresh = freshCity();
    const dmg = new CityDamage();
    dmg.bind(fresh);
    // Mid-band, so the body meets one chunk first, not the two either side
    // of a floor seam (T1: seed 42's first tower has one at 60 m).
    const g = tierGrids(b)[0] as TierGrid;
    const o = intoFacade(b, 70);
    const imp = {
      ...o,
      origin: {
        ...o.origin,
        y: g.baseY + (Math.floor(o.origin.y / g.ch) + 0.5) * g.ch,
      },
    };
    const before = sweepImpact(imp, fresh);
    const first = before.chunks[0] as number;
    expect(dmg.destroyChunk(first)).toBe(true);
    const after = sweepImpact(imp, fresh);
    expect(after.chunks).not.toContain(first);
    expect(after.stopDist).toBeGreaterThan(before.stopDist);
  });

  it("is bounded: open air sweeps nothing, every tunnel stays inside SWEEP_MAX_DIST", () => {
    const air = sweepImpact(
      {
        origin: { x: 500, y: 900, z: 500 },
        velocity: { x: 200, y: 0, z: 0 },
        mass: 5,
        radius: 3,
      },
      city,
    );
    expect(air.end).toBe(SWEEP_END_NONE);
    expect(air.chunks).toEqual([]);
    expect(air.stopDist).toBe(0);
    const huge = sweepImpact(
      intoFacade(towers[1]?.b as Building, 900, 500),
      city,
    );
    expect(huge.stopDist).toBeLessThanOrEqual(SWEEP_MAX_DIST);
    expect(huge.knots.length / 3).toBeLessThan(
      SWEEP_MAX_DIST / SWEEP_STEP_M + 64,
    );
    // Straight down onto the street: it stops there.
    const street = sweepImpact(
      {
        origin: { x: 10, y: 30, z: 10 },
        velocity: { x: 0, y: -80, z: 0 },
        mass: 5,
        radius: 1,
      },
      [],
    );
    expect(street.end).toBe(SWEEP_END_GROUND);
    expect(street.stop.y).toBe(0);
    expect(street.stopDist).toBeCloseTo(30, 6);
  });

  it("is torus-correct: the same impact across the seam lands the same chunks", () => {
    const { b } = towers[2] as { b: Building };
    const imp = intoFacade(b, 85);
    const a = sweepImpact(imp, city);
    const shifted = sweepImpact(
      {
        ...imp,
        origin: {
          x: imp.origin.x + WORLD_SIZE,
          y: imp.origin.y,
          z: imp.origin.z - WORLD_SIZE,
        },
      },
      city,
    );
    expect(shifted.chunks).toEqual(a.chunks);
    expect(shifted.times).toEqual(a.times);
  });

  it("times the body from the origin to the stop, slowing all the way", () => {
    for (const { b } of towers) {
      const res = sweepImpact(intoFacade(b, 90), city);
      const p = { x: 0, y: 0, z: 0 };
      sweepPosAt(res, 0, p);
      expect(wrapDistance(p, res.origin)).toBeLessThan(1e-6);
      sweepPosAt(res, res.stopT + 1, p);
      expect(wrapDistance(p, res.stop)).toBeLessThan(1e-6);
      let last = -1;
      for (let s = 0; s <= res.stopT; s += res.stopT / 40) {
        const d = sweepDistAt(res, s);
        expect(d).toBeGreaterThanOrEqual(last - 1e-9);
        last = d;
      }
      // Each chunk is reached at its stamped time.
      res.chunks.forEach((_, k) => {
        expect(sweepDistAt(res, res.times[k] as number)).toBeCloseTo(
          res.dists[k] as number,
          3,
        );
      });
    }
  });
});

describe("P1 impact record", () => {
  it("round-trips the wire to the same sweep", () => {
    const { b } = towers[3] as { b: Building };
    const rec = makeImpact(
      IMPACT_PLANE,
      123456.7,
      { x: b.x - b.width / 2 - 2.34, y: 48.88, z: b.z + 0.05 },
      { x: 77.77, y: -6.66, z: 3.33 },
      9,
    );
    const back = decodeImpact(JSON.parse(JSON.stringify(encodeImpact(rec))));
    expect(back).toEqual(rec);
    expect(sweepRecord(back as NonNullable<typeof back>, city)).toEqual(
      sweepRecord(rec, city),
    );
    expect(sweepRecord(rec, city).chunks.length).toBeGreaterThan(0);
  });

  it("rejects malformed records", () => {
    expect(decodeImpact(null)).toBeNull();
    expect(decodeImpact([0, 1, 2])).toBeNull();
    expect(decodeImpact([9, 0, 0, 0, 0, 0, 0, 0, 10, 10, 0])).toBeNull();
    expect(decodeImpact([0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0])).toBeNull();
    expect(decodeImpact([0, 0, 0.5, 0, 0, 0, 0, 0, 10, 10, 0])).toBeNull();
  });
});

describe("P1 sweep cost", () => {
  it("holds p99 to 0.2 ms per sweep (every kind, warm city)", () => {
    const kinds = [IMPACT_PLANE, IMPACT_METEOR, IMPACT_COMET] as const;
    const imps: { imp: Impactor; cap: number }[] = [];
    for (let k = 0; k < 300; k++) {
      const b = city[(k * 7) % city.length] as Building;
      const kind = kinds[k % 3] as (typeof kinds)[number];
      const spec = IMPACTORS[kind];
      const steep = kind === IMPACT_METEOR;
      imps.push({
        imp: {
          origin: steep
            ? { x: b.x, y: b.height + 2, z: b.z }
            : {
                x: b.x - b.width / 2 - 3,
                y: Math.min(60, b.height / 2),
                z: b.z,
              },
          velocity: steep
            ? { x: 60, y: -230, z: 30 }
            : { x: kind === IMPACT_COMET ? 230 : 90, y: -15, z: 10 },
          mass: spec?.mass ?? 1,
          radius: spec?.radius ?? 1,
        },
        cap: spec?.maxChunks ?? 8,
      });
    }
    // Warm: the chunk grids and masks are cached per building (a bound
    // CityDamage has already built them in a live room).
    for (const { imp, cap } of imps) sweepImpact(imp, city, { maxChunks: cap });
    // Best of five rounds: the suite shares the box with every other
    // test file, and one round can land on a GC pause or a busy core.
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round++) {
      const ts: number[] = [];
      for (const { imp, cap } of imps) {
        const t0 = performance.now();
        sweepImpact(imp, city, { maxChunks: cap });
        ts.push(performance.now() - t0);
      }
      ts.sort((a, b) => a - b);
      best = Math.min(best, ts[Math.floor(ts.length * 0.99)] as number);
    }
    expect(best).toBeLessThanOrEqual(0.2);
  });
});
