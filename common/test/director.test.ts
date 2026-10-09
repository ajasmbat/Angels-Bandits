// D5 destruction director, the shared model: the slot schedule (pure in
// seed and time, 2–4 min apart), the event wire, the topple footprint a
// plane's path is scored against, gas mains on the street grid — and the
// shared halves of the rebuild (exact intact geometry, draw == collide),
// crane falls (continuity with the standing crane, collision hand-over)
// and chain reactions (collapseImpacts).

import {
  type Building,
  CityDamage,
  baseSolids,
  chunkId,
  chunksOf,
  generateCity,
  makeBuilding,
  solids,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  CollapseField,
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
  KIND_CRANE,
  PANCAKE,
  TOPPLE,
  blankPose,
  buildCollapse,
  buildCraneCollapse,
  collapseChunks,
  collapseImpacts,
  collapseWire,
  collideCollapses,
  craneAlignAfter,
  craneFallDir,
  demolitionPlan,
  piecePose,
  planCollapses,
} from "@angels-bandits/common/city/collapse";
import {
  type CraneSite,
  collideMovers,
  craneBoxes,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import { isInRoadway } from "@angels-bandits/common/city/street";
import { buildCityIndex, collideCity } from "@angels-bandits/common/collision";
import { CITY_SEED, WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  DIRECTOR_INTERVAL_MAX_MS,
  DIRECTOR_INTERVAL_MIN_MS,
  type DirectorEvent,
  EVENT_COLLAPSE,
  decodeDirectorEvent,
  directorSlotsInWindow,
  encodeDirectorEvent,
  fallFootprint,
  gasDamage,
  gasMainNear,
  inDangerZone,
  pathCrossing,
} from "@angels-bandits/common/director";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const SEED_CITY = generateCity(CITY_SEED);
const T0 = 1_790_000_000_000;

/** A fresh, bound clone of the seed city (as a server room makes). */
function freshCity(): { city: Building[]; damage: CityDamage } {
  const city = SEED_CITY.map((b) => makeBuilding({ ...b, damage: undefined }));
  const damage = new CityDamage();
  damage.bind(city);
  return { city, damage };
}

/** A plain multi-band tower, street tier at least 2 × 2 chunks. */
const TOWER = SEED_CITY.findIndex((b) => {
  const g = tierGrids(b)[0];
  return (
    !b.holes && !!g && g.nx >= 2 && g.nz >= 2 && g.ny >= 3 && b.height >= 80
  );
});

describe("director slots (the storm idiom)", () => {
  it("are a pure function of (seed, time), 2–4 min apart", () => {
    const a = directorSlotsInWindow(CITY_SEED, T0, T0 + 6 * 3_600_000);
    const b = directorSlotsInWindow(CITY_SEED, T0, T0 + 6 * 3_600_000);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(80);
    for (let i = 1; i < a.length; i++) {
      const gap = (a[i] as number) - (a[i - 1] as number);
      expect(gap).toBeGreaterThanOrEqual(DIRECTOR_INTERVAL_MIN_MS);
      expect(gap).toBeLessThanOrEqual(DIRECTOR_INTERVAL_MAX_MS);
    }
    // Another seed is another schedule.
    expect(
      directorSlotsInWindow(CITY_SEED + 1, T0, T0 + 3_600_000),
    ).not.toEqual(directorSlotsInWindow(CITY_SEED, T0, T0 + 3_600_000));
  });

  it("abutting windows partition the timeline (a 50 ms tick loop sees each slot once)", () => {
    const whole = directorSlotsInWindow(CITY_SEED, T0, T0 + 3_600_000);
    const ticked: number[] = [];
    for (let t = T0; t < T0 + 3_600_000; t += 50) {
      ticked.push(...directorSlotsInWindow(CITY_SEED, t, t + 50));
    }
    expect(ticked).toEqual(whole);
  });
});

describe("director event wire", () => {
  it("round-trips exactly through integers", () => {
    const e: DirectorEvent = {
      id: 7,
      k: EVENT_COLLAPSE,
      b: 123,
      x: 1234.5,
      y: 0,
      z: 7.1,
      s: TOPPLE,
      d: DIR_POS_Z,
      w: T0,
      at: T0 + 3500,
      zone: { x0: -40, x1: 160, z0: -30, z1: 30, top: 140 },
    };
    const wire = encodeDirectorEvent(e);
    expect(wire.every(Number.isInteger)).toBe(true);
    expect(decodeDirectorEvent(JSON.parse(JSON.stringify(wire)))).toEqual(e);
    expect(decodeDirectorEvent([1, 2])).toBeNull();
    expect(decodeDirectorEvent(wire.map(String))).toBeNull();
  });

  it("the danger zone test is torus-correct", () => {
    const e = {
      x: 5,
      z: 5,
      zone: { x0: -20, x1: 20, z0: -20, z1: 20, top: 50 },
    };
    expect(inDangerZone(e, { x: WORLD_SIZE - 10, y: 10, z: 10 })).toBe(true);
    expect(inDangerZone(e, { x: 40, y: 10, z: 10 })).toBe(false);
    expect(inDangerZone(e, { x: 40, y: 10, z: 10 }, 20)).toBe(true);
    expect(inDangerZone(e, { x: 5, y: 60, z: 5 })).toBe(false);
  });
});

describe("a topple's footprint against a plane's path", () => {
  const b = SEED_CITY[TOWER] as Building;

  it("lies on the fall side, from the face out to where the debris rests", () => {
    for (const dir of [DIR_NEG_X, DIR_POS_X, DIR_NEG_Z, DIR_POS_Z]) {
      const plan = demolitionPlan(b, TOWER, TOPPLE, dir);
      expect(plan).not.toBeNull();
      const c = buildCollapse(
        SEED_CITY,
        collapseWire(plan as NonNullable<typeof plan>, TOWER, 1, T0),
      );
      const fp = c && fallFootprint(c, b);
      expect(fp).not.toBeNull();
      const z = fp as NonNullable<typeof fp>;
      const g = tierGrids(b)[0] as NonNullable<ReturnType<typeof tierGrids>[0]>;
      if (dir === DIR_POS_X) expect(z.x0).toBeCloseTo(g.width / 2);
      if (dir === DIR_NEG_X) expect(z.x1).toBeCloseTo(-g.width / 2);
      if (dir === DIR_POS_Z) expect(z.z0).toBeCloseTo(g.depth / 2);
      if (dir === DIR_NEG_Z) expect(z.z1).toBeCloseTo(-g.depth / 2);
      // A tower 80 m+ tall throws its debris well out across the street.
      const reach = Math.max(
        Math.abs(z.x1 - z.x0) * (dir < 2 ? 1 : 0),
        Math.abs(z.z1 - z.z0) * (dir >= 2 ? 1 : 0),
      );
      expect(reach).toBeGreaterThan(30);
    }
    const pancake = demolitionPlan(b, TOWER, PANCAKE, 0);
    const pc = buildCollapse(
      SEED_CITY,
      collapseWire(pancake as NonNullable<typeof pancake>, TOWER, 2, T0),
    );
    expect(pc && fallFootprint(pc, b)).toBeNull();
  });

  it("pathCrossing measures the projected straight path inside a rect", () => {
    const rect = { x0: 10, x1: 30, z0: -5, z1: 5, top: 100 };
    // From x = 0 heading +x at 10 m/s for 3 s: 10 m of the 30 m inside.
    const pos = { x: 100, y: 50, z: 200 };
    expect(
      pathCrossing(rect, 100, 200, pos, { x: 10, y: 0, z: 0 }, 3),
    ).toBeCloseTo(20);
    expect(pathCrossing(rect, 100, 200, pos, { x: -10, y: 0, z: 0 }, 3)).toBe(
      0,
    );
    // Across the torus seam: from −10 to +20 relative, [10, 20] inside.
    expect(
      pathCrossing(
        rect,
        5,
        200,
        { x: WORLD_SIZE - 5, y: 50, z: 200 },
        { x: 10, y: 0, z: 0 },
        3,
      ),
    ).toBeCloseTo(10);
  });
});

describe("gas mains", () => {
  it("sit on the street grid, seeded from grid ids, never in the river", () => {
    let found = 0;
    for (let i = 0; i < 400; i++) {
      const p = {
        x: ((i * 137) % 2000) + 0.5,
        y: 0,
        z: ((i * 311) % 2000) + 0.5,
      };
      const site = gasMainNear(CITY_SEED, p);
      if (!site) continue;
      found++;
      expect(isInRoadway(site)).toBe(true);
      expect(gasMainNear(CITY_SEED, p)).toEqual(site);
      // Asking from the site itself finds the same main.
      expect(gasMainNear(CITY_SEED, site)).toEqual(site);
    }
    expect(found).toBeGreaterThan(300);
  });

  it("is lethal at the column and harmless past the blast radius", () => {
    expect(gasDamage(0)).toBeGreaterThanOrEqual(100);
    expect(gasDamage(20)).toBeGreaterThan(0);
    expect(gasDamage(36)).toBe(0);
    expect(gasDamage(Number.NaN)).toBe(0);
  });
});

describe("the rebuild restores the exact intact geometry (draw == collide)", () => {
  it("after shots, a collapse and a demolition, solids and collision are the pristine city's", () => {
    const { city, damage } = freshCity();
    const field = new CollapseField();
    field.bind(city);
    const b = city[TOWER] as Building;
    const g = tierGrids(b)[0] as NonNullable<ReturnType<typeof tierGrids>[0]>;
    // Shoot out the base band but one cell: a D3 collapse.
    for (let c = 1; c < g.nx * g.nz; c++) {
      damage.destroyChunk(chunkId(TOWER, 0, c));
    }
    damage.takeDestroyed();
    let id = 1;
    for (const plan of planCollapses(b, TOWER)) {
      const w = collapseWire(plan, TOWER, id++, T0);
      damage.collapse(collapseChunks(w));
      field.add(w);
    }
    // And a demolition of a neighbour, and partial HP somewhere.
    const other = city.findIndex(
      (o, i) =>
        i !== TOWER && o.height >= 60 && (tierGrids(o)[0]?.ny ?? 0) >= 3,
    );
    const plan = demolitionPlan(
      city[other] as Building,
      other,
      TOPPLE,
      DIR_POS_X,
    );
    const dw = collapseWire(plan as NonNullable<typeof plan>, other, id++, T0);
    damage.collapse(collapseChunks(dw));
    field.add(dw);
    damage.damageChunk(chunkId(TOWER, 0, 0), 10);
    expect(b.damage).toBeDefined();
    expect(field.list.length).toBeGreaterThanOrEqual(2);

    const restored = [
      ...damage.restoreBuilding(TOWER),
      ...damage.restoreBuilding(other),
    ];
    field.removeBuilding(TOWER);
    field.removeBuilding(other);
    expect(restored.length).toBeGreaterThan(g.nx * g.nz);
    expect(damage.destroyedCount + damage.fallenCount).toBe(0);
    expect(damage.hpOf(chunkId(TOWER, 0, 0))).toBe(60);
    expect(field.list).toHaveLength(0);
    for (const i of [TOWER, other]) {
      const rb = city[i] as Building;
      expect(rb.damage).toBeUndefined();
      // What the renderer draws and collision tests: the generated boxes.
      expect(solids(rb)).toEqual(baseSolids(SEED_CITY[i] as Building));
    }
    // Collision agrees with the pristine city everywhere near both.
    const index = buildCityIndex(city);
    const pristine = buildCityIndex(SEED_CITY);
    for (const i of [TOWER, other]) {
      const rb = city[i] as Building;
      for (let k = 0; k < 400; k++) {
        const p = {
          x: rb.x + ((k % 20) - 9.5) * (rb.width / 12),
          y: 2 + Math.floor(k / 20) * (rb.height / 18),
          z: rb.z + (((k * 7) % 20) - 9.5) * (rb.depth / 12),
        };
        expect(collideCity(p, 4, city, index) !== null).toBe(
          collideCity(p, 4, SEED_CITY, pristine) !== null,
        );
        expect(
          collideCollapses(p, 4, field.list, Number.POSITIVE_INFINITY),
        ).toBeNull();
      }
    }
  });

  it("restoreBuilding leaves every other building alone", () => {
    const { city, damage } = freshCity();
    const a = chunksOf(city[TOWER] as Building, TOWER)[0] as number;
    const other = TOWER + 1;
    const b = chunksOf(city[other] as Building, other)[0] as number;
    damage.destroyChunk(a);
    damage.destroyChunk(b);
    expect(damage.restoreBuilding(TOWER)).toEqual([a]);
    expect(damage.isDestroyed(b)).toBe(true);
    expect(damage.takeDestroyed()).toEqual([b]);
  });
});

describe("crane falls", () => {
  const cranes = generateMovers(CITY_SEED, SEED_CITY).cranes;
  const site = cranes[0] as CraneSite;

  it("start exactly where the standing crane is, jib first, and hand collision over", () => {
    expect(site).toBeDefined();
    const t = craneAlignAfter(site, T0);
    expect(t).toBeGreaterThanOrEqual(T0);
    const wire = {
      id: 3,
      b: site.id,
      t,
      s: TOPPLE,
      d: craneFallDir(site, t),
      c: [],
      k: KIND_CRANE,
    };
    const c = buildCraneCollapse(site, wire);
    expect(c).not.toBeNull();
    const debris = c as NonNullable<typeof c>;
    expect(debris.dir).toBe(wire.d);
    // Every piece at t0 lies inside one of the crane's own boxes then.
    const boxes = craneBoxes(site, t);
    const pose = blankPose();
    for (let i = 0; i < debris.n; i++) {
      piecePose(debris, i, t, pose);
      const x = debris.x + pose.x;
      const z = debris.z + pose.z;
      const inside = boxes.some((bx) => {
        const dx = Math.abs(wrapDeltaAxis(bx.x, x));
        const dz = Math.abs(wrapDeltaAxis(bx.z, z));
        const ext = Math.max(bx.hx, bx.hz) + 0.05;
        return (
          dx <= ext && dz <= ext && Math.abs(pose.y - bx.y) <= bx.hy + 0.05
        );
      });
      expect(inside).toBe(true);
    }
    // The field: before t0 the crane is a crane; from t0 it is debris.
    const field = new CollapseField();
    field.bind(SEED_CITY);
    field.bindCranes(cranes);
    field.add(wire);
    expect(field.list).toHaveLength(1);
    const movers = { cranes, aircraft: [], collapses: field };
    const hub = { x: site.x, y: site.hubY * 0.5, z: site.z };
    expect(collideMovers(hub, 2, movers, t - 500)?.kind).toBe("mast");
    const after = collideMovers(hub, 2, movers, t + 100);
    expect(after?.kind).toBe("debris");
    // Long after, the mast is no longer there at all.
    expect(collideMovers(hub, 2, movers, t + 60_000)).toBeNull();
    // A rebuild stands it back up.
    field.removeCrane(site.id);
    expect(collideMovers(hub, 2, movers, t + 60_000)?.kind).toBe("mast");
  });
});

describe("chain reactions", () => {
  it("a topple into a neighbour reports where its debris drives in; a pancake does not", () => {
    const { city } = freshCity();
    // A tower with a neighbour within its height on one axis.
    let found = false;
    for (let i = 0; i < city.length && !found; i++) {
      const b = city[i] as Building;
      if (b.height < 90 || (tierGrids(b)[0]?.ny ?? 0) < 3) continue;
      for (const dir of [DIR_NEG_X, DIR_POS_X, DIR_NEG_Z, DIR_POS_Z]) {
        const plan = demolitionPlan(b, i, TOPPLE, dir);
        if (!plan) continue;
        const c = buildCollapse(city, collapseWire(plan, i, 1, T0));
        if (!c) continue;
        const impacts = collapseImpacts(c, city);
        if (impacts.length === 0) continue;
        found = true;
        for (const hit of impacts) {
          expect(hit.building).not.toBe(i);
          expect(hit.t).toBeGreaterThan(T0);
          expect(hit.t).toBeLessThanOrEqual(T0 + c.endMs);
        }
        // Sorted, coalesced, capped.
        for (let k = 1; k < impacts.length; k++) {
          expect((impacts[k] as { t: number }).t).toBeGreaterThanOrEqual(
            (impacts[k - 1] as { t: number }).t,
          );
        }
        expect(impacts.length).toBeLessThanOrEqual(16);
        // Pure.
        expect(collapseImpacts(c, city)).toEqual(impacts);
        const pancake = demolitionPlan(b, i, PANCAKE, 0);
        const pc = buildCollapse(
          city,
          collapseWire(pancake as NonNullable<typeof pancake>, i, 2, T0),
        );
        expect(collapseImpacts(pc as NonNullable<typeof pc>, city)).toEqual([]);
        break;
      }
    }
    expect(found).toBe(true);
  });
});
