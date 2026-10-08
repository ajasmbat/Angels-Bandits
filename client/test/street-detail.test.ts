// G1 street-level detail: the pure layout seam (street-detail.ts) — the
// seed-free curb plan, the seeded furniture and parked cars — against the
// street contract and the live seed-42 city (its real holes, trains, vents
// and A1's street stations).

import {
  type Building,
  CITY_GRID,
  cityHoles,
  generateCity,
} from "@angels-bandits/common/city";
import { natureFor } from "@angels-bandits/common/city/nature";
import { overChannel } from "@angels-bandits/common/city/river";
import {
  CURB_LINE,
  INTERSECTION_HALF,
  LANE_CENTERS,
  ROADWAY_HALF,
  isInIntersection,
  isInRoadway,
} from "@angels-bandits/common/city/street";
import { generateTrains } from "@angels-bandits/common/city/train";
import { BLOCK_PITCH, CROSSWALK_DEPTH } from "@angels-bandits/common/constants";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { blockStations } from "../src/render/citylife";
import {
  BIKE_LANE_OUT,
  CORNER_CLEAR,
  DOUBLE_PARK_BIKE_MARGIN,
  DOUBLE_PARK_LANE_MARGIN,
  DOUBLE_PARK_OFF,
  type DetailBox,
  type Footprint,
  ITEM_MAX_HEIGHT,
  MAX_CART_VENTS_PER_BLOCK,
  MAX_FURNITURE_PER_BLOCK,
  MAX_PARKED_PER_SIDE,
  MOVING_EDGE,
  MOVING_HALF_WIDTH,
  PARKED_DIMS,
  PARKING_LINE,
  PED_HEAD,
  type ParkedVehicle,
  STRIP_IN,
  STRIP_OUT,
  type StreetDetailContext,
  type StreetItem,
  allSides,
  blockParking,
  blockSides,
  cartVents,
  curbPlanFor,
  curbPlanWords,
  holeCorridor,
  itemBoxes,
  lampStations,
  overlaps,
  parkingFor,
  sideIndex,
  sideOwner,
  streetFurnitureFor,
  treePits,
  vehicleBoxes,
  vetoesStreet,
} from "../src/render/street-detail";
import { buildStreetDetailContext } from "../src/render/street-furniture";
import { VEHICLES } from "../src/render/traffic";

const SEED = 42;
const city = generateCity(SEED);
const holes = cityHoles(city);
const trains = generateTrains(SEED, city);
const byBlock = (() => {
  const map = new Map<number, Building[]>();
  for (const b of city) {
    const key =
      Math.floor(b.x / BLOCK_PITCH) * 1000 + Math.floor(b.z / BLOCK_PITCH);
    const list = map.get(key);
    if (list) list.push(b);
    else map.set(key, [b]);
  }
  return map;
})();
const ctx: StreetDetailContext = buildStreetDetailContext(
  SEED,
  byBlock,
  holes,
  trains,
);

const blocks: [number, number][] = [];
for (let bx = 0; bx < CITY_GRID; bx++) {
  for (let bz = 0; bz < CITY_GRID; bz++) blocks.push([bx, bz]);
}
const furniture = new Map<string, StreetItem[]>();
const parked = new Map<string, ParkedVehicle[]>();
for (const [bx, bz] of blocks) {
  furniture.set(`${bx},${bz}`, streetFurnitureFor(SEED, bx, bz, ctx));
  parked.set(`${bx},${bz}`, blockParking(SEED, bx, bz, ctx));
}
const allItems = [...furniture.values()].flat();
const allParked = [...parked.values()].flat();

/** Signed offset of v from its nearest street centreline (wrap-safe). */
const lineDelta = (v: number) => v - Math.round(v / BLOCK_PITCH) * BLOCK_PITCH;

/** Plan-view AABB of a (possibly yawed / rolled) box. */
function boxFootprint(b: DetailBox): Footprint {
  const c = Math.abs(Math.cos(b.yaw));
  const s = Math.abs(Math.sin(b.yaw));
  // A roll about local Z widens the local-X extent by the height.
  const rx =
    Math.abs(Math.cos(b.roll)) * b.sx + Math.abs(Math.sin(b.roll)) * b.sy;
  return {
    x: b.x,
    z: b.z,
    hx: (c * rx + s * b.sz) / 2,
    hz: (s * rx + c * b.sz) / 2,
  };
}

/** The across-street offset band [min, max] a footprint occupies, measured
 * off the centreline of the street it stands beside (|lineDelta| of the
 * coordinate that is CLOSER to a centreline). */
function acrossBand(f: Footprint): [number, number] {
  const dx = Math.abs(lineDelta(f.x));
  const dz = Math.abs(lineDelta(f.z));
  return dx <= dz ? [dx - f.hx, dx + f.hx] : [dz - f.hz, dz + f.hz];
}

describe("the seed-free curb plan", () => {
  it("indexes every side exactly once and packs it losslessly", () => {
    const sides = allSides();
    const idx = sides.map(sideIndex).sort((a, b) => a - b);
    expect(idx).toEqual(sides.map((_, i) => i));
    const words = curbPlanWords();
    for (const w of words) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(2 ** 28);
    }
  });

  it("each block's four sides are its own, and every side has one owner", () => {
    const owners = new Map<number, string>();
    for (const [bx, bz] of blocks) {
      for (const s of blockSides(bx, bz)) {
        expect(sideOwner(s)).toEqual({ bx, bz });
        expect(owners.has(sideIndex(s))).toBe(false);
        owners.set(sideIndex(s), `${bx},${bz}`);
      }
    }
    expect(owners.size).toBe(allSides().length);
  });

  it("puts bus shelters and hydrants where lamps and tree pits leave room", () => {
    for (const s of allSides()) {
      const p = curbPlanFor(s);
      const clear = (a: number, half: number) => {
        for (const l of lampStations(s.side)) {
          expect(Math.abs(a - l)).toBeGreaterThan(half + 0.5);
        }
        for (const t of treePits(s.side)) {
          expect(Math.abs(a - t)).toBeGreaterThan(half + 0.5);
        }
      };
      if (p.bus !== null) clear(p.bus, 2.4);
      if (p.hydrant !== null) clear(p.hydrant, 0.25);
    }
  });

  it("keeps parking and stops off the river bridges", () => {
    for (const s of allSides()) {
      if (s.axis !== "z") continue;
      const p = curbPlanFor(s);
      let bridge = false;
      for (let a = 0; a <= BLOCK_PITCH; a += 10) {
        if (overChannel(s.seg * BLOCK_PITCH + a)) bridge = true;
      }
      if (bridge)
        expect(p).toEqual({ parking: false, bus: null, hydrant: null });
    }
  });

  it("matches nature.ts: every street tree stands on a candidate pit", () => {
    const pits = new Set<string>();
    for (const s of allSides()) {
      for (const a of treePits(s.side)) {
        const along = s.seg * BLOCK_PITCH + a;
        const off = s.line * BLOCK_PITCH + s.side * 16;
        const x = s.axis === "z" ? off : along;
        const z = s.axis === "z" ? along : off;
        pits.add(
          `${Math.round(((x % 2000) + 2000) % 2000)},${Math.round(((z % 2000) + 2000) % 2000)}`,
        );
      }
    }
    const trees = natureFor(SEED, city).trees.filter(
      (t) => t.kind === "street",
    );
    expect(trees.length).toBeGreaterThan(100);
    for (const t of trees) {
      expect(pits.has(`${Math.round(t.x)},${Math.round(t.z)}`)).toBe(true);
    }
  });
});

describe("streetFurnitureFor", () => {
  it("is deterministic and seed-sensitive", () => {
    const a = streetFurnitureFor(SEED, 3, 7, ctx);
    const b = streetFurnitureFor(SEED, 3, 7, ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(
      JSON.stringify(streetFurnitureFor(SEED + 1, 3, 7, ctx)),
    );
    expect(allItems.length).toBeGreaterThan(1500);
    const kinds = new Set(allItems.map((i) => i.kind));
    for (const k of [
      "bench",
      "bin",
      "hydrant",
      "newsbox",
      "shelter",
      "bikerack",
      "bollards",
      "planter",
      "booth",
    ]) {
      expect(kinds.has(k as StreetItem["kind"]), k).toBe(true);
    }
  });

  it("caps every block inside the pure function", () => {
    for (const [key, items] of furniture) {
      const [bx, bz] = key.split(",").map(Number) as [number, number];
      expect(items.length).toBeLessThanOrEqual(MAX_FURNITURE_PER_BLOCK);
      expect(cartVents(bx, bz, ctx).length).toBeLessThanOrEqual(
        MAX_CART_VENTS_PER_BLOCK,
      );
    }
  });

  it("puts A1's bus-stop waiters under a G1 shelter, and steams A1's carts", () => {
    let stops = 0;
    let steamed = 0;
    const shelters = allItems.filter((it) => it.kind === "shelter");
    for (const [bx, bz] of blocks) {
      for (const stop of blockStations(bx, bz, SEED).busStops) {
        stops++;
        const near = shelters.some(
          (sh) =>
            Math.abs(wrapDeltaAxis(sh.x, stop.x)) < 0.01 &&
            Math.abs(wrapDeltaAxis(sh.z, stop.z)) < 0.01,
        );
        // A stop whose shelter a hole corridor, a pillar or a gutter steam
        // vent vetoed is the one allowed exception (paint and waiters, no
        // roof).
        if (!near) {
          const f = { x: stop.x, z: stop.z, hx: 2.4, hz: 2.4 };
          const vetoed =
            holes.some(
              (h) => vetoesStreet(h) && overlaps(f, holeCorridor(h)),
            ) ||
            ctx.keepOut.some((k) => overlaps(f, k, 1)) ||
            ctx
              .ventsFor(bx, bz)
              .some((v) => overlaps(f, { x: v.x, z: v.z, hx: 2, hz: 2 }));
          expect(vetoed, `stop at ${stop.x},${stop.z}`).toBe(true);
        }
      }
      steamed += cartVents(bx, bz, ctx).length;
    }
    expect(stops).toBeGreaterThan(20);
    expect(steamed).toBeGreaterThan(20);
  });

  it("stands every box on the furniture strip, ≤ 3 m, never on a roadway", () => {
    const bad: string[] = [];
    for (const it of allItems) {
      for (const b of itemBoxes(it)) {
        const f = boxFootprint(b);
        const [lo, hi] = acrossBand(f);
        const below = b.y - b.sy / 2 < PED_HEAD;
        const corners = [
          [f.x - f.hx, f.z - f.hz],
          [f.x + f.hx, f.z + f.hz],
          [f.x - f.hx, f.z + f.hz],
          [f.x + f.hx, f.z - f.hz],
        ] as const;
        if (
          b.y - b.sy / 2 < 0 ||
          b.y + b.sy / 2 > ITEM_MAX_HEIGHT ||
          b.x < 0 ||
          b.x >= 2000 ||
          b.z < 0 ||
          b.z >= 2000 ||
          lo < STRIP_IN ||
          // Below head height a pedestrian could walk into it: inside the
          // strip. Canopies and shelter roofs may overhang the walkers.
          (below && hi > STRIP_OUT) ||
          corners.some(([cx, cz]) => isInRoadway({ x: cx, y: 0, z: cz }))
        ) {
          bad.push(
            `${it.kind} @ ${it.x.toFixed(1)},${it.z.toFixed(1)} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`,
          );
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps clear of corners and crosswalks", () => {
    const bad = allItems.filter(
      (it) =>
        Math.abs(lineDelta(it.axis === "z" ? it.z : it.x)) <
        Math.max(INTERSECTION_HALF + CROSSWALK_DEPTH, CORNER_CLEAR - 2.5),
    );
    expect(bad).toEqual([]);
  });

  it("never overlaps another item, a lamp, a tree pit, a gutter vent or an A1 cart", () => {
    const bad: string[] = [];
    for (const [key, items] of furniture) {
      const [bx, bz] = key.split(",").map(Number) as [number, number];
      const fps = items.map((it) =>
        itemBoxes(it)
          .filter((b) => b.y - b.sy / 2 < PED_HEAD)
          .map(boxFootprint),
      );
      for (let i = 0; i < fps.length; i++) {
        for (let j = i + 1; j < fps.length; j++) {
          const a0 = items[i] as StreetItem;
          const b0 = items[j] as StreetItem;
          // Only near neighbours can touch: skip the quadratic box loop.
          if (
            Math.abs(wrapDeltaAxis(a0.x, b0.x)) +
              Math.abs(wrapDeltaAxis(a0.z, b0.z)) >
            8
          )
            continue;
          for (const a of fps[i] as Footprint[]) {
            for (const b of fps[j] as Footprint[]) {
              if (overlaps(a, b)) bad.push(`${a0.kind}/${b0.kind} in ${key}`);
            }
          }
        }
      }
      const fixed: Footprint[] = [];
      for (const s of blockSides(bx, bz)) {
        for (const a of [...lampStations(s.side), ...treePits(s.side)]) {
          const along = s.seg * BLOCK_PITCH + a;
          const off = s.line * BLOCK_PITCH + s.side * 16;
          const x = s.axis === "z" ? off : along;
          const z = s.axis === "z" ? along : off;
          fixed.push({
            x: ((x % 2000) + 2000) % 2000,
            z: ((z % 2000) + 2000) % 2000,
            hx: 0.5,
            hz: 0.5,
          });
        }
      }
      for (const v of ctx.ventsFor(bx, bz)) {
        fixed.push({ x: v.x, z: v.z, hx: 0.6, hz: 0.6 });
      }
      // A1's carts (with the vendor beside them).
      for (const c of ctx.stationsFor(bx, bz).carts) {
        fixed.push({ x: c.x, z: c.z, hx: 1.2, hz: 1.2 });
      }
      for (const list of fps) {
        for (const a of list) {
          for (const f of fixed) {
            if (overlaps(a, f)) bad.push(`item on a lamp/pit/vent in ${key}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("parkingFor", () => {
  it("is deterministic, seed-sensitive and capped per side", () => {
    const s = allSides().find((x) => curbPlanFor(x).parking);
    expect(s).toBeDefined();
    if (!s) return;
    const a = parkingFor(SEED, s, ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(parkingFor(SEED, s, ctx)));
    expect(JSON.stringify(a)).not.toBe(
      JSON.stringify(parkingFor(SEED + 1, s, ctx)),
    );
    for (const s2 of allSides()) {
      expect(parkingFor(SEED, s2, ctx).length).toBeLessThanOrEqual(
        MAX_PARKED_PER_SIDE,
      );
      if (!curbPlanFor(s2).parking) {
        expect(parkingFor(SEED, s2, ctx)).toEqual([]);
      }
    }
    expect(allParked.length).toBeGreaterThan(1000);
    expect(allParked.some((p) => p.double)).toBe(true);
  });

  it("parks in the curb lane, never in a moving lane, crosswalk or box", () => {
    // MOVING_HALF_WIDTH mirrors the widest L6 vehicle.
    const widest = Math.max(...Object.values(VEHICLES).map((v) => v.width));
    expect(MOVING_HALF_WIDTH).toBe(widest / 2);
    expect(MOVING_EDGE).toBe((LANE_CENTERS[1] as number) + widest / 2);
    const bad: string[] = [];
    for (const p of allParked) {
      for (const b of vehicleBoxes(p)) {
        const f = boxFootprint(b);
        const [lo, hi] = acrossBand(f);
        const inner = p.double
          ? lo < MOVING_EDGE + DOUBLE_PARK_LANE_MARGIN ||
            lo < BIKE_LANE_OUT + DOUBLE_PARK_BIKE_MARGIN - 0.05
          : lo < PARKING_LINE;
        const corners = [
          [f.x - f.hx, f.z - f.hz],
          [f.x + f.hx, f.z + f.hz],
        ] as const;
        if (
          inner ||
          hi > CURB_LINE ||
          hi > ROADWAY_HALF ||
          b.y + b.sy / 2 > ITEM_MAX_HEIGHT ||
          b.y - b.sy / 2 < 0 ||
          corners.some(
            ([cx, cz]) =>
              !isInRoadway({ x: cx, y: 0, z: cz }) ||
              isInIntersection({ x: cx, y: 0, z: cz }),
          )
        ) {
          bad.push(
            `${p.kind}${p.double ? " (double)" : ""} [${lo.toFixed(2)}, ${hi.toFixed(2)}]`,
          );
        }
      }
      const along = Math.abs(lineDelta(p.axis === "z" ? p.z : p.x));
      const [len] = PARKED_DIMS[p.kind];
      if (along - len / 2 - 0.2 < INTERSECTION_HALF + CROSSWALK_DEPTH) {
        bad.push(`${p.kind} in a crosswalk`);
      }
    }
    expect(bad).toEqual([]);
    expect(DOUBLE_PARK_OFF - (PARKED_DIMS.van[1] as number) / 2).toBeCloseTo(
      BIKE_LANE_OUT + DOUBLE_PARK_BIKE_MARGIN,
    );
  });

  it("faces the traffic of its own lane (right-hand traffic)", () => {
    for (const p of allParked) {
      const side = Math.sign(lineDelta(p.axis === "z" ? p.x : p.z));
      const expected = p.axis === "z" ? side : -side;
      expect(p.heading).toBe(expected);
    }
  });
});

describe("the live city's vetoes", () => {
  const everything: { f: Footprint; what: string }[] = [
    ...allItems.flatMap((it) =>
      itemBoxes(it).map((b) => ({ f: boxFootprint(b), what: it.kind })),
    ),
    ...allParked.flatMap((p) =>
      vehicleBoxes(p).map((b) => ({ f: boxFootprint(b), what: p.kind })),
    ),
  ];

  it("leaves every low hole's mouth and its run-out corridor empty", () => {
    expect(holes.filter(vetoesStreet).length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const h of holes.filter(vetoesStreet)) {
      const c = holeCorridor(h);
      for (const { f, what } of everything) {
        if (overlaps(f, c)) bad.push(`${what} in a hole corridor`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("H2: drops no more street items to hole corridors than main did (216 on seed 42)", () => {
    // Main (0868c79) vetoed every hole's corridor; H2 vetoes only the holes
    // low enough for a street item to matter (vetoesStreet), so 3× the holes
    // must not strip G1's streets. Items lost to new mouths on facades are a
    // different count (furniture never stood in a facade).
    const open = buildStreetDetailContext(SEED, byBlock, [], trains);
    let all = 0;
    for (const [bx, bz] of blocks) {
      all +=
        streetFurnitureFor(SEED, bx, bz, open).length +
        blockParking(SEED, bx, bz, open).length;
    }
    const dropped = all - allItems.length - allParked.length;
    expect(dropped).toBeGreaterThan(0); // the arches still clear their run-in
    expect(dropped).toBeLessThanOrEqual(216);
  });

  it("stays clear of the train's pillars", () => {
    expect(trains.length).toBeGreaterThan(0);
    expect(ctx.keepOut.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const k of ctx.keepOut) {
      for (const { f, what } of everything) {
        if (overlaps(f, k)) bad.push(`${what} on a pillar`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("places blocks on both sides of the seam canonically", () => {
    for (const key of ["0,0", "9,9", "0,9", "9,0"]) {
      for (const it of furniture.get(key) ?? []) {
        for (const b of itemBoxes(it)) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x).toBeLessThan(2000);
          expect(b.z).toBeGreaterThanOrEqual(0);
          expect(b.z).toBeLessThan(2000);
        }
      }
    }
    // A block-(0,0) item sits within one block of its block, wrap-correct.
    for (const it of furniture.get("0,0") ?? []) {
      expect(Math.abs(wrapDeltaAxis(100, it.x))).toBeLessThan(
        BLOCK_PITCH / 2 + 1,
      );
      expect(Math.abs(wrapDeltaAxis(100, it.z))).toBeLessThan(
        BLOCK_PITCH / 2 + 1,
      );
    }
  });
});
