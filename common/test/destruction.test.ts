// D2 breakable buildings (common/src/city/destruction.ts) on the real seed
// city: the chunk grid is deterministic and tiles every tier exactly; solids()
// subtracts exactly the destroyed chunks (and collision, sight lines and the
// index agree with it); rubble stays on open ground; bullet rays and blasts
// break chunks deterministically, across the seam too; the cap holds; the
// destroyed set replays to a late joiner bit-for-bit; and the shared
// collision path stays allocation-free on damaged buildings.

import {
  type Building,
  CUT_RUBBLE,
  CityDamage,
  type LocalBox,
  type SolidBox,
  baseSolids,
  cellBox,
  chunkAt,
  chunkBuilding,
  chunkCell,
  chunkId,
  chunkMask,
  chunkTier,
  chunksOf,
  decodeChunkIds,
  encodeChunkIds,
  generateCity,
  makeBuilding,
  raycastChunk,
  solids,
  supportGraph,
  tierGrids,
} from "@angels-bandits/common/city";
import { mulberry32 } from "@angels-bandits/common/city";
import { MAX_CELLS, MAX_TIERS } from "@angels-bandits/common/city/destruction";
import {
  buildCityIndex,
  collideCity,
  losClear,
} from "@angels-bandits/common/collision";
import {
  BULLET_DAMAGE,
  CHUNK_HP,
  CITY_SEED,
  DESTROY_CAP,
  HOLE_CORRIDOR_MARGIN,
  RUBBLE_REACH,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type Vec3,
  wrapDelta,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const city = generateCity(CITY_SEED);

/** A fresh, damage-free copy of the seed city (one per test that damages). */
const freshCity = (): Building[] => city.map((b) => makeBuilding(b));

const inside = (p: Vec3, s: SolidBox, eps = 0) =>
  p.y >= s.baseY - eps &&
  p.y <= s.baseY + s.height + eps &&
  Math.abs(p.x - s.dx) <= s.width / 2 + eps &&
  Math.abs(p.z - s.dz) <= s.depth / 2 + eps;

const inBox = (p: Vec3, b: LocalBox) =>
  p.x >= b.x0 &&
  p.x <= b.x1 &&
  p.y >= b.y0 &&
  p.y <= b.y1 &&
  p.z >= b.z0 &&
  p.z <= b.z1;

/** Destroy a seeded random `share` of every building's chunks. */
function chew(buildings: Building[], share: number, seed: number): CityDamage {
  const dmg = new CityDamage();
  dmg.bind(buildings);
  const rand = mulberry32(seed);
  buildings.forEach((b, i) => {
    for (const id of chunksOf(b, i)) if (rand() < share) dmg.destroyChunk(id);
  });
  return dmg;
}

describe("D2 chunk grid", () => {
  it("is deterministic: two generations give the same chunk ids", () => {
    const again = generateCity(CITY_SEED);
    const ids = (c: Building[]) => c.flatMap((b, i) => chunksOf(b, i));
    expect(ids(again)).toEqual(ids(city));
  });

  it("fits the id layout and round-trips (building, tier, cell)", () => {
    let total = 0;
    city.forEach((b, i) => {
      expect(b.tiers.length).toBeLessThanOrEqual(MAX_TIERS);
      for (const g of tierGrids(b)) {
        expect(g.nx * g.ny * g.nz).toBeLessThanOrEqual(MAX_CELLS);
      }
      for (const id of chunksOf(b, i)) {
        expect(chunkBuilding(id)).toBe(i);
        expect(chunkId(i, chunkTier(id), chunkCell(id))).toBe(id);
        total++;
      }
    });
    // The planner's count for the seed city (26,731 cells; hole air removed).
    expect(total).toBeGreaterThan(26000);
    expect(total).toBeLessThanOrEqual(26731);
  });

  it("tiles every tier exactly: cells sum to the tier volume, never overlap", () => {
    for (const b of city) {
      tierGrids(b).forEach((g, k) => {
        const tier = b.tiers[k] as Building["tiers"][number];
        let volume = 0;
        const boxes: LocalBox[] = [];
        for (let c = 0; c < g.nx * g.ny * g.nz; c++) {
          const box = cellBox(g, c);
          volume += (box.x1 - box.x0) * (box.y1 - box.y0) * (box.z1 - box.z0);
          boxes.push(box);
        }
        expect(volume).toBeCloseTo(tier.width * tier.depth * tier.height, 3);
        // Neighbouring cells share faces exactly (no gap, no overlap).
        for (let c = 1; c < boxes.length; c++) {
          const a = boxes[c - 1] as LocalBox;
          const n = boxes[c] as LocalBox;
          if (c % g.nx !== 0) expect(n.x0).toBe(a.x1);
        }
      });
    }
  });

  it("makes no chunk of pure hole air, and every solid point lies in a chunk", () => {
    const rand = mulberry32(7);
    const holed = city.filter((b) => b.holes);
    expect(holed.length).toBeGreaterThan(20);
    let airCells = 0;
    for (const b of holed) {
      const masks = chunkMask(b);
      for (const m of masks) {
        for (const v of m) if (!v) airCells++;
      }
      for (let n = 0; n < 200; n++) {
        const s = baseSolids(b)[
          Math.floor(rand() * baseSolids(b).length)
        ] as SolidBox;
        const p = {
          x: s.dx + (rand() - 0.5) * s.width,
          y: s.baseY + rand() * s.height,
          z: s.dz + (rand() - 0.5) * s.depth,
        };
        const at = chunkAt(b, p);
        expect(at).not.toBeNull();
        if (at) expect(masks[at.tier]?.[at.cell]).toBe(1);
      }
    }
    // Tunnels and arches really do leave air cells out.
    expect(airCells).toBeGreaterThan(0);
  });

  it("supportGraph: ground under the street tier, lower tiers under upper, walls under lintels", () => {
    const tower = city.findIndex((b) => b.tiers.length === 3);
    const b = city[tower] as Building;
    const graph = supportGraph(b, tower);
    expect(graph.length).toBe(chunksOf(b, tower).length);
    for (const s of graph) {
      const tier = chunkTier(s.id);
      const g = tierGrids(b)[tier];
      const iy = g ? Math.floor(chunkCell(s.id) / (g.nx * g.nz)) : -1;
      if (tier === 0 && iy === 0) expect(s.ground).toBe(true);
      else expect(s.ground).toBe(false);
      if (tier > 0 && iy === 0) {
        expect(s.on.length).toBeGreaterThan(0);
        for (const id of s.on) expect(chunkTier(id)).toBe(tier - 1);
      }
    }
    // Over hole air (an arch, a gate, a wide sky hole): a cell rests on its
    // same-band neighbours — the lintel is carried by its walls.
    let lintels = 0;
    city.forEach((host, hostIndex) => {
      const hole = host.holes?.[0];
      if (!hole) return;
      const g = tierGrids(host)[hole.tierIndex];
      const mask = chunkMask(host)[hole.tierIndex];
      if (!g || !mask) return;
      const band = g.nx * g.nz;
      for (const s of supportGraph(host, hostIndex)) {
        if (chunkTier(s.id) !== hole.tierIndex) continue;
        const cell = chunkCell(s.id);
        if (cell < band || mask[cell - band]) continue;
        lintels++;
        expect(s.on.length).toBeGreaterThan(0);
        for (const id of s.on) {
          expect(chunkTier(id)).toBe(hole.tierIndex);
          expect(Math.floor(chunkCell(id) / band)).toBe(
            Math.floor(cell / band),
          );
        }
      }
    });
    expect(lintels).toBeGreaterThan(0);
  });
});

describe("D2 solids() subtract destroyed chunks", () => {
  const damaged = freshCity();
  const dmg = chew(damaged, 0.2, 99);
  const index = buildCityIndex(damaged);

  it("destroyed 20% of the chunks and touched most buildings", () => {
    expect(dmg.destroyedCount / dmg.chunkCount).toBeGreaterThan(0.18);
    expect(dmg.destroyedCount / dmg.chunkCount).toBeLessThanOrEqual(
      DESTROY_CAP,
    );
    expect(damaged.filter((b) => b.damage).length).toBeGreaterThan(400);
  });

  it("subtraction property: in damaged solids ⇔ in base solids and not in a destroyed chunk", () => {
    const rand = mulberry32(3);
    // Holed tiers and landmarks included: every building, 60 points each.
    for (const b of damaged) {
      const base = baseSolids(b);
      const now = solids(b).filter((s) => (s.cut & CUT_RUBBLE) === 0);
      const cells = b.damage?.cells;
      for (let n = 0; n < 60; n++) {
        const p = {
          x: (rand() - 0.5) * b.width,
          y: rand() * b.height,
          z: (rand() - 0.5) * b.depth,
        };
        const at = chunkAt(b, p);
        const gone = !!at && cells?.[at.tier]?.[at.cell] === 1;
        const expected = base.some((s) => inside(p, s)) && !gone;
        expect(now.some((s) => inside(p, s))).toBe(expected);
      }
    }
  });

  it("draw == collide: collideCity hits exactly the damaged solids (and rubble)", () => {
    const rand = mulberry32(5);
    const r = 1.5;
    for (const b of damaged.slice(0, 200)) {
      const boxes = solids(b);
      for (let n = 0; n < 40; n++) {
        // Below the roof (roof structures have their own tests).
        const p = {
          x: b.x + (rand() - 0.5) * (b.width + 2 * RUBBLE_REACH + 4),
          y: rand() * Math.max(1, b.height - r - 0.1),
          z: b.z + (rand() - 0.5) * (b.depth + 2 * RUBBLE_REACH + 4),
        };
        const d = wrapDelta({ x: b.x, y: 0, z: b.z }, p);
        const local = { x: d.x, y: p.y, z: d.z };
        const expected = boxes.some((s) => inside(local, s, r));
        expect(collideCity(p, r, [b]) !== null).toBe(expected);
      }
    }
  });

  it("indexed and linear collision agree on the damaged city (rubble included)", () => {
    const rand = mulberry32(11);
    for (let n = 0; n < 20000; n++) {
      const p = {
        x: rand() * WORLD_SIZE,
        y: rand() * 40,
        z: rand() * WORLD_SIZE,
      };
      const r = 0.5 + rand() * 4;
      expect(collideCity(p, r, damaged, index)).toBe(
        collideCity(p, r, damaged),
      );
    }
  });

  it("a destroyed run of cells opens a sight line and a flight path through the building", () => {
    const fresh = freshCity();
    const d = new CityDamage();
    d.bind(fresh);
    const i = fresh.findIndex(
      (b) => !b.holes && b.tiers.length === 1 && b.width >= 50,
    );
    const b = fresh[i] as Building;
    const g = tierGrids(b)[0];
    if (!g) throw new Error("no tier");
    const iy = Math.min(1, g.ny - 1);
    const iz = 0;
    const row = Array.from({ length: g.nx }, (_, ix) =>
      chunkId(i, 0, (iy * g.nz + iz) * g.nx + ix),
    );
    const box = cellBox(g, (iy * g.nz + iz) * g.nx);
    const y = (box.y0 + box.y1) / 2;
    const z = b.z + (box.z0 + box.z1) / 2;
    const a = { x: b.x - b.width / 2 + 0.5, y, z };
    const c = { x: b.x + b.width / 2 - 0.5, y, z };
    const mid = { x: b.x + (box.x0 + box.x1) / 2, y, z };
    expect(losClear(a, c, fresh)).toBe(false);
    expect(collideCity(mid, 1, fresh)).toBe(b);
    for (const id of row) d.destroyChunk(id);
    expect(losClear(a, c, fresh)).toBe(true);
    expect(collideCity(mid, 1, fresh)).toBeNull();
  });

  it("rubble stays on open ground: never in another footprint or a hole mouth, within RUBBLE_REACH", () => {
    let piles = 0;
    // Each building's neighbours: anything whose footprint could reach a
    // pile (within a block's pitch), so the overlap test stays cheap.
    const near = damaged.map((b, i) =>
      damaged.flatMap((o, j) =>
        j !== i &&
        Math.abs(wrapDeltaAxis(b.x, o.x)) < 200 &&
        Math.abs(wrapDeltaAxis(b.z, o.z)) < 200
          ? [j]
          : [],
      ),
    );
    damaged.forEach((b, i) => {
      for (const s of solids(b)) {
        if ((s.cut & CUT_RUBBLE) === 0) continue;
        piles++;
        expect(s.baseY).toBe(0);
        expect(Math.abs(s.dx) + s.width / 2).toBeLessThanOrEqual(
          b.width / 2 + RUBBLE_REACH + 1e-9,
        );
        expect(Math.abs(s.dz) + s.depth / 2).toBeLessThanOrEqual(
          b.depth / 2 + RUBBLE_REACH + 1e-9,
        );
        for (const j of near[i] as number[]) {
          const o = damaged[j] as Building;
          const t = o.tiers[0];
          if (!t) continue;
          const dx = wrapDeltaAxis(b.x, o.x);
          const dz = wrapDeltaAxis(b.z, o.z);
          const ox =
            Math.min(s.dx + s.width / 2, dx + t.width / 2) -
            Math.max(s.dx - s.width / 2, dx - t.width / 2);
          const oz =
            Math.min(s.dz + s.depth / 2, dz + t.depth / 2) -
            Math.max(s.dz - s.depth / 2, dz - t.depth / 2);
          expect(ox > 1e-6 && oz > 1e-6).toBe(false);
        }
        const mouth = b.holes?.find((h) => h.tierIndex === 0);
        if (mouth) {
          const onMouthFace =
            mouth.axis === "x"
              ? Math.abs(s.dx) > b.width / 2
              : Math.abs(s.dz) > b.depth / 2;
          if (onMouthFace) {
            const c = mouth.axis === "x" ? s.dz : s.dx;
            const half = (mouth.axis === "x" ? s.depth : s.width) / 2;
            const keep = mouth.width / 2 + HOLE_CORRIDOR_MARGIN;
            expect(
              c + half <= mouth.offset - keep + 1e-9 ||
                c - half >= mouth.offset + keep - 1e-9,
            ).toBe(true);
          }
        }
      }
    });
    expect(piles).toBeGreaterThan(100);
  });
});

describe("D2 damage", () => {
  it("bullet rays are deterministic and break a chunk on the 9th round", () => {
    const run = () => {
      const c = freshCity();
      const d = new CityDamage();
      d.bind(c);
      const b = c.findIndex((x) => !x.holes && x.width >= 40);
      const t = c[b] as Building;
      const from = { x: t.x - t.width / 2 - 60, y: 6, z: t.z };
      const dir = { x: 1, y: 0, z: 0 };
      const hits: number[] = [];
      for (let n = 0; n < 30; n++) {
        const hit = raycastChunk(c, from, dir, 350);
        if (hit && hit.chunk >= 0) {
          hits.push(hit.chunk);
          d.damageChunk(hit.chunk, BULLET_DAMAGE);
        }
      }
      return { hits, destroyed: d.destroyedIds(), d };
    };
    const a = run();
    const b = run();
    expect(a.hits).toEqual(b.hits);
    expect(a.destroyed).toEqual(b.destroyed);
    // Rounds needed to break the first chunk: ceil(CHUNK_HP / BULLET_DAMAGE).
    const first = a.hits[0] as number;
    const toBreak = Math.ceil(CHUNK_HP / BULLET_DAMAGE);
    expect(a.hits.slice(0, toBreak).every((h) => h === first)).toBe(true);
    expect(a.hits[toBreak]).not.toBe(first);
    expect(a.d.isDestroyed(first)).toBe(true);
    // One round short of breaking: still standing, HP accounted exactly.
    const c = freshCity();
    const d = new CityDamage();
    d.bind(c);
    for (let n = 0; n < toBreak - 1; n++) d.damageChunk(first, BULLET_DAMAGE);
    expect(d.isDestroyed(first)).toBe(false);
    expect(d.hpOf(first)).toBe(CHUNK_HP - (toBreak - 1) * BULLET_DAMAGE);
  });

  it("rays cross the torus seam", () => {
    const c = freshCity();
    // A building whose −x face stands on the lot line just east of x = 0.
    const i = c.findIndex(
      (b) => Math.abs(b.x - b.width / 2 - 20) < 1e-6 && b.height > 20,
    );
    const b = c[i] as Building;
    expect(b).toBeDefined();
    const hit = raycastChunk(
      c,
      { x: WORLD_SIZE - 10, y: 8, z: b.z },
      { x: 1, y: 0, z: 0 },
      350,
    );
    expect(hit?.building).toBe(i);
    expect(hit?.t).toBeCloseTo(30, 6);
    expect(hit && chunkBuilding(hit.chunk)).toBe(i);
  });

  it("a blast on any facade breaks at least one chunk", () => {
    const c = freshCity();
    c.forEach((b, i) => {
      if (i % 5 !== 0) return; // a fifth of the city keeps this quick
      const d = new CityDamage();
      d.bind(c);
      const broke = d.damageAt(
        { x: b.x - b.width / 2, y: 5, z: b.z + b.depth / 4 },
        14,
        220,
      );
      expect(broke.some((id) => chunkBuilding(id) === i)).toBe(true);
      d.reset([]);
    });
  });

  it("stops at DESTROY_CAP: no more breaks, HP bottoms out at 1", () => {
    const c = freshCity();
    const d = new CityDamage();
    d.bind(c);
    const all = c.flatMap((b, i) => chunksOf(b, i));
    const limit = Math.floor(d.chunkCount * DESTROY_CAP);
    for (const id of all.slice(0, limit)) expect(d.destroyChunk(id)).toBe(true);
    const next = all[limit] as number;
    expect(d.destroyChunk(next)).toBe(false);
    expect(d.damageChunk(next, 1000)).toBe(false);
    expect(d.hpOf(next)).toBe(1);
    expect(d.destroyedCount).toBe(limit);
  });
});

describe("D2 replay", () => {
  it("a late joiner's welcome reproduces the exact destroyed set and solids()", () => {
    const server = freshCity();
    const s = chew(server, 0.1, 4242);
    const wire = JSON.parse(JSON.stringify(encodeChunkIds(s.destroyedIds())));
    // The client holds the ids before its city exists, then binds.
    const client = generateCity(CITY_SEED);
    const c = new CityDamage();
    c.reset(decodeChunkIds(wire));
    c.bind(client);
    expect(c.destroyedIds()).toEqual(s.destroyedIds());
    server.forEach((b, i) => {
      expect(solids(client[i] as Building)).toEqual(solids(b));
    });
  });

  it("reset to a subset restores the buildings it no longer names", () => {
    const c = freshCity();
    const d = chew(c, 0.1, 1);
    const keep = d.destroyedIds().filter((id) => chunkBuilding(id) < 100);
    d.reset(keep);
    c.forEach((b, i) => {
      if (i >= 100) {
        expect(b.damage).toBeUndefined();
        expect(solids(b)).toBe(baseSolids(b));
      }
    });
    expect(d.destroyedIds()).toEqual(keep);
    d.reset([]);
    expect(c.every((b) => b.damage === undefined)).toBe(true);
  });

  it("drops ids that name no chunk, and delta-decodes malformed lists to nothing", () => {
    const c = freshCity();
    const d = new CityDamage();
    d.bind(c);
    d.apply([chunkId(c.length + 5, 0, 0), chunkId(0, 3, 0), -1, 1.5]);
    expect(d.destroyedCount).toBe(0);
    expect(decodeChunkIds([1, "x"])).toEqual([]);
    expect(decodeChunkIds({})).toEqual([]);
    expect(decodeChunkIds(encodeChunkIds([30, 10, 20]))).toEqual([10, 20, 30]);
  });

  it("takeDestroyed drains each batch once, ascending", () => {
    const c = freshCity();
    const d = new CityDamage();
    d.bind(c);
    const ids = chunksOf(c[3] as Building, 3)
      .slice(0, 3)
      .reverse();
    for (const id of ids) d.destroyChunk(id);
    expect(d.takeDestroyed()).toEqual([...ids].sort((a, b) => a - b));
    expect(d.takeDestroyed()).toEqual([]);
  });
});

describe("D2 collision stays allocation-free", () => {
  it("collideCity and losClear allocate nothing on seed, cloned and damaged buildings", () => {
    const damaged = freshCity();
    chew(damaged, 0.2, 77);
    const idx = buildCityIndex(damaged);
    const seedIdx = buildCityIndex(city);
    const rand = mulberry32(13);
    const points = Array.from({ length: 512 }, () => ({
      x: rand() * WORLD_SIZE,
      y: rand() * 120,
      z: rand() * WORLD_SIZE,
    }));
    const run = (n: number) => {
      let hits = 0;
      for (let k = 0; k < n; k++) {
        const p = points[k % points.length] as Vec3;
        const q = points[(k * 7 + 3) % points.length] as Vec3;
        if (collideCity(p, 2, damaged, idx)) hits++;
        if (collideCity(p, 2, city, seedIdx)) hits++;
        if (
          k % 64 === 0 &&
          losClear(p, { x: p.x + 40, y: q.y, z: p.z + 30 }, damaged)
        )
          hits++;
      }
      return hits;
    };
    run(20000); // warm: caches built, code optimised
    const before = process.memoryUsage().heapUsed;
    run(100000);
    const grown = process.memoryUsage().heapUsed - before;
    // A 56 B/call regression would show as ~11 MB here.
    expect(grown).toBeLessThan(1024 * 1024);
  });
});
