// D10 on the server: a tower that topples into a neighbour breaks the
// neighbour where it strikes — harder the more mass arrives and the faster
// — and can bring it down in turn, a chain across the block bounded by the
// D5 caps (impacts per collapse, chain depth); and a tick that has spent
// its collapse-build budget leaves the rest for the next one.

import {
  type Building,
  generateCity,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
  TOPPLE,
  chunkAtCell,
  demolitionPlan,
  planCollapses,
} from "@angels-bandits/common/city/collapse";
import {
  CHAIN_DEPTH_MAX,
  CHAIN_ENERGY_MAX,
  CHAIN_ENERGY_MIN,
  CHAIN_IMPACTS_MAX,
  CITY_SEED,
  COLLAPSE_BUILD_BUDGET_MS,
} from "@angels-bandits/common/constants";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type RoomCity,
  createRoomCity,
  stageCollapse,
  tickDestruction,
} from "../src/destruction";

const seedCity = generateCity(CITY_SEED);
const T0 = 1_000_000;

/** The first tall tower whose topple drives into a neighbour, and how. */
function toppleIntoNeighbour(): {
  rc: RoomCity;
  index: number;
  dir: number;
} {
  for (let index = 0; index < seedCity.length; index++) {
    const b = seedCity[index] as Building;
    if (b.holes || b.height < 120 || (tierGrids(b)[0]?.ny ?? 0) < 4) continue;
    for (const dir of [DIR_NEG_X, DIR_POS_X, DIR_NEG_Z, DIR_POS_Z]) {
      const rc = createRoomCity(seedCity);
      const plan = demolitionPlan(
        rc.buildings[index] as Building,
        index,
        TOPPLE,
        dir,
      );
      if (!plan) continue;
      stageCollapse(rc, plan, index, T0, "A");
      if (rc.impacts.length >= 3) return { rc, index, dir };
    }
  }
  throw new Error("no tower topples into a neighbour");
}

/** Chunks of building `i` gone (broken or fallen) in `rc`. */
function gone(rc: RoomCity, i: number): number {
  let n = 0;
  const b = rc.buildings[i] as Building;
  tierGrids(b).forEach((g, k) => {
    for (let c = 0; c < g.nx * g.ny * g.nz; c++) {
      const ix = c % g.nx;
      const iz = Math.floor(c / g.nx) % g.nz;
      const iy = Math.floor(c / (g.nx * g.nz));
      if (rc.damage.isGone(chunkAtCell(b, i, k, ix, iy, iz))) n++;
    }
  });
  return n;
}

describe("D10 building on building", () => {
  it("a toppling tower breaks its neighbour where it strikes, scaled by the energy it arrives with, inside the caps", () => {
    const { rc, index } = toppleIntoNeighbour();
    const impacts = [...rc.impacts];
    expect(impacts.length).toBeLessThanOrEqual(CHAIN_IMPACTS_MAX);
    for (const i of impacts) {
      expect(i.building).not.toBe(index);
      expect(i.e).toBeGreaterThanOrEqual(CHAIN_ENERGY_MIN);
      expect(i.e).toBeLessThanOrEqual(CHAIN_ENERGY_MAX);
      expect(i.depth).toBe(0);
      expect(i.by).toBe("A");
    }
    // Whole floors arriving at speed hit harder than the minimum.
    expect(Math.max(...impacts.map((i) => i.e))).toBeGreaterThan(1);
    const struck = [...new Set(impacts.map((i) => i.building))];
    const before = struck.map((i) => gone(rc, i));
    // Land every impact (and whatever collapses they set off).
    const last = Math.max(...impacts.map((i) => i.t));
    const chain: { b: number; depth: number }[] = [];
    for (let t = T0; t <= last + 20_000; t += 50) {
      const out = tickDestruction(rc, t);
      for (const w of out.collapses) {
        chain.push({ b: w.b, depth: rc.collapseDepth.get(w.id) ?? -1 });
      }
    }
    const after = struck.map((i) => gone(rc, i));
    expect(after.some((n, k) => n > (before[k] as number))).toBe(true);
    // Whatever came down because of it is a later link in the chain —
    // never past CHAIN_DEPTH_MAX — and is credited to the shooter.
    for (const link of chain) {
      expect(link.depth).toBeGreaterThanOrEqual(1);
      expect(link.depth).toBeLessThanOrEqual(CHAIN_DEPTH_MAX);
    }
    // Every struck building is left owing nothing.
    for (const i of struck) {
      expect(planCollapses(rc.buildings[i] as Building, i)).toEqual([]);
    }
  });

  it("the same strike breaks more with more energy", () => {
    const { rc } = toppleIntoNeighbour();
    const hit = rc.impacts[0];
    if (!hit) throw new Error("no impact");
    const breakWith = (e: number): number => {
      const room = createRoomCity(seedCity);
      room.impacts.push({ ...hit, e, t: T0 });
      const before = gone(room, hit.building);
      tickDestruction(room, T0);
      return gone(room, hit.building) - before;
    };
    const soft = breakWith(CHAIN_ENERGY_MIN);
    const hard = breakWith(CHAIN_ENERGY_MAX);
    expect(hard).toBeGreaterThan(soft);
    // Out of range is clamped, not trusted.
    expect(breakWith(50)).toBe(hard);
    expect(breakWith(0)).toBe(soft);
  });

  it("a collapse at the last link of a chain queues no impacts", () => {
    for (let index = 0; index < seedCity.length; index++) {
      const b = seedCity[index] as Building;
      if (b.holes || b.height < 120) continue;
      const rc = createRoomCity(seedCity);
      const plan = demolitionPlan(
        rc.buildings[index] as Building,
        index,
        TOPPLE,
        DIR_POS_X,
      );
      if (!plan) continue;
      stageCollapse(rc, plan, index, T0, null, CHAIN_DEPTH_MAX);
      expect(rc.impacts).toEqual([]);
      return;
    }
    throw new Error("no tower");
  });
});

describe("D10 the per-tick collapse build budget", () => {
  afterEach(() => vi.restoreAllMocks());

  it("past COLLAPSE_BUILD_BUDGET_MS a tick starts no more collapses; the next tick picks them up", () => {
    const rc = createRoomCity(seedCity);
    // Two towers with their base bands shot away.
    const towers = seedCity
      .map((b, i) => [b, i] as const)
      .filter(([b]) => !b.holes && (tierGrids(b)[0]?.ny ?? 0) >= 3)
      .slice(0, 2)
      .map(([, i]) => i);
    for (const i of towers) {
      const b = rc.buildings[i] as Building;
      const g = tierGrids(b)[0];
      if (!g) throw new Error("no grid");
      const ids: number[] = [];
      for (let iz = 0; iz < g.nz; iz++)
        for (let ix = 0; ix < g.nx; ix++)
          ids.push(chunkAtCell(b, i, 0, ix, 0, iz));
      rc.damage.apply(ids);
      rc.dirty.add(i); // what a shot's breakage queues
    }
    // Every look at the clock costs more than the whole budget.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      clock += COLLAPSE_BUILD_BUDGET_MS + 1;
      return clock;
    });
    const first = tickDestruction(rc, T0);
    expect(first.collapses.length).toBeGreaterThan(0);
    const buildings = new Set(first.collapses.map((w) => w.b));
    expect(buildings.size).toBe(1);
    const second = tickDestruction(rc, T0 + 50);
    const next = new Set(second.collapses.map((w) => w.b));
    expect(next.size).toBe(1);
    expect([...buildings, ...next].sort((a, b) => a - b)).toEqual(
      [...towers].sort((a, b) => a - b),
    );
  });
});
