// D8 no skeletons: every per-building layer re-seats its dressing to what
// still stands. On the real seed city, each registered layer
// (render/standing-layers.ts) is driven through a felled tower (TOPPLE
// demolition), a pancaked one, a natural topple, a half-chewed facade, a
// building at the torus seam and a holed one — and nothing it keeps may sit
// outside the building's LIVE solids (grown by the facade/deck margin): an
// oracle on solids() itself, independent of the chunk-grid test the layers
// filter with. A source scan keeps the registry honest, and the roof
// structures (solid) are checked draw == collide.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Building,
  CUT_POS_Y,
  CUT_RUBBLE,
  CityDamage,
  type LocalBox,
  STAND_EPS,
  STAND_OUT,
  STAND_ROOF_RISE,
  chunkMask,
  generateCity,
  solids,
  standingProfile,
  tierGrids,
} from "@angels-bandits/common/city";
import { mulberry32 } from "@angels-bandits/common/city";
import {
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
  PANCAKE,
  TOPPLE,
  blankPose,
  buildCollapse,
  chunkAtCell,
  collapseWire,
  demolitionPlan,
  piecePose,
  planCollapses,
} from "@angels-bandits/common/city/collapse";
import { collideCity } from "@angels-bandits/common/collision";
import { CITY_SEED, WORLD_SIZE } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  FacadeGarnishRenderer,
  facadeGarnishFor,
} from "../src/render/facade-garnish";
import { drawnStructures } from "../src/render/roof-details";
import {
  STANDING_EXEMPT,
  STANDING_LAYERS,
} from "../src/render/standing-layers";
import {
  BakedHider,
  HIDE_DROP,
  StandingMask,
  attachStanding,
  keptBoxes,
} from "../src/render/standing-watch";
import { ImageCache } from "../src/render/wrapPlacement";

/** The layers this test must see — a new one is added here AND registered. */
const EXPECTED_LAYERS = [
  "atmosphere-fx",
  "citylife-render",
  "facade-detail",
  "facade-garnish",
  "facade-life",
  "hole-decor",
  "jumbotrons",
  "roofclutter",
  "rooftop-life",
  "searchlights",
  "signage",
  "steam",
];

const sampleAxis = (a0: number, a1: number): number[] => {
  const n = Math.max(1, Math.ceil((a1 - a0) / 4));
  return Array.from({ length: n + 1 }, (_, i) => a0 + ((a1 - a0) * i) / n);
};

/**
 * The oracle: is (x, y, z) (building frame) inside one of `b`'s live,
 * non-rubble solids grown by STAND_OUT sideways and STAND_EPS up and down —
 * or up to STAND_ROOF_RISE over an UNCUT top face (a deck as generated)?
 */
function onSolids(b: Building, x: number, y: number, z: number): boolean {
  for (const s of solids(b)) {
    if (s.cut & CUT_RUBBLE) continue;
    const inX = Math.abs(x - s.dx) <= s.width / 2 + STAND_OUT + 1e-6;
    const inZ = Math.abs(z - s.dz) <= s.depth / 2 + STAND_OUT + 1e-6;
    if (!inX || !inZ) continue;
    const top = s.baseY + s.height;
    if (y >= s.baseY - STAND_EPS - 1e-6 && y <= top + STAND_EPS + 1e-6)
      return true;
    if (!(s.cut & CUT_POS_Y) && y >= top && y <= top + STAND_ROOF_RISE + 1e-6)
      return true;
  }
  return false;
}

/** Every 4 m sample of `box` passes the oracle. */
function boxOnSolids(b: Building, box: LocalBox): boolean {
  for (const y of sampleAxis(box.y0, box.y1))
    for (const z of sampleAxis(box.z0, box.z1))
      for (const x of sampleAxis(box.x0, box.x1))
        if (!onSolids(b, x, y, z)) return false;
  return true;
}

/** A fresh city with `stage` applied through a bound CityDamage. */
function staged(stage: (city: Building[], damage: CityDamage) => number[]): {
  city: Building[];
  damage: CityDamage;
  hit: number[];
} {
  const city = generateCity(CITY_SEED);
  const damage = new CityDamage();
  damage.bind(city);
  const hit = stage(city, damage);
  return { city, damage, hit };
}

/** Every collapse building `i` now owes, applied (the server's step). */
function settle(city: Building[], damage: CityDamage, i: number): void {
  for (const plan of planCollapses(city[i] as Building, i)) {
    damage.collapse(plan.chunks);
  }
}

const base = generateCity(CITY_SEED);
const TOWER = 343;
const tall = (b: Building) => {
  const g = tierGrids(b)[0];
  return !!g && g.ny >= 3 && g.nx >= 2 && g.nz >= 2 && b.height >= 80;
};
const solidTall = base.findIndex((b, i) => i !== TOWER && tall(b) && !b.holes);
const holed = base.findIndex((b) => tall(b) && !!b.holes);
const seam = base.findIndex(
  (b) =>
    tall(b) && (b.x < b.width / 2 + 60 || b.x > WORLD_SIZE - b.width / 2 - 60),
);

interface Scenario {
  name: string;
  build: () => ReturnType<typeof staged>;
}

const fell = (
  i: number,
  style: typeof TOPPLE | typeof PANCAKE,
  dir = DIR_POS_X,
) =>
  staged((city, damage) => {
    const plan = demolitionPlan(city[i] as Building, i, style, dir);
    if (!plan) throw new Error(`nothing to fell on ${i}`);
    damage.collapse(plan.chunks);
    return [i];
  });

const SCENARIOS: Scenario[] = [
  { name: "felled (topple)", build: () => fell(TOWER, TOPPLE) },
  { name: "pancake", build: () => fell(TOWER, PANCAKE) },
  {
    name: "natural topple",
    build: () =>
      staged((city, damage) => {
        // Shoot out the −x half of tier 0's two bottom bands.
        const b = city[solidTall] as Building;
        const g = tierGrids(b)[0] as NonNullable<
          ReturnType<typeof tierGrids>[0]
        >;
        const ids: number[] = [];
        for (let iy = 0; iy < 2; iy++)
          for (let iz = 0; iz < g.nz; iz++)
            for (let ix = 0; ix < Math.ceil(g.nx / 2); ix++)
              ids.push(chunkAtCell(b, solidTall, 0, ix, iy, iz));
        damage.apply(ids);
        settle(city, damage, solidTall);
        return [solidTall];
      }),
  },
  {
    name: "half-chewed facade",
    build: () =>
      staged((city, damage) => {
        // A seeded half of every chunk on the +z face, all tiers.
        const b = city[solidTall] as Building;
        const rand = mulberry32(0xd8);
        const ids: number[] = [];
        tierGrids(b).forEach((g, k) => {
          const mask = chunkMask(b)[k] as Uint8Array;
          for (let iy = 0; iy < g.ny; iy++)
            for (let ix = 0; ix < g.nx; ix++) {
              const id = chunkAtCell(b, solidTall, k, ix, iy, g.nz - 1);
              const c = (iy * g.nz + (g.nz - 1)) * g.nx + ix;
              if (mask[c] && rand() < 0.5) ids.push(id);
            }
        });
        damage.apply(ids);
        settle(city, damage, solidTall);
        return [solidTall];
      }),
  },
  { name: "at the torus seam", build: () => fell(seam, TOPPLE, DIR_NEG_Z) },
  { name: "holed", build: () => fell(holed, TOPPLE, DIR_NEG_X) },
];

describe("D8 every per-building layer keeps only what stands on something", () => {
  it("registers exactly the expected layers", () => {
    expect(STANDING_LAYERS.map((p) => p.name).sort()).toEqual(
      [...EXPECTED_LAYERS].sort(),
    );
    expect(solidTall).toBeGreaterThanOrEqual(0);
    expect(holed).toBeGreaterThanOrEqual(0);
    expect(seam).toBeGreaterThanOrEqual(0);
  });

  it("fails on a building-reading render module that is neither registered nor exempt", () => {
    const dir = join(__dirname, "../src/render");
    const names = new Set([
      ...STANDING_LAYERS.map((p) => p.name),
      ...Object.keys(STANDING_EXEMPT),
    ]);
    const missing: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      const importsBuilding =
        /import[^;]*\bBuilding\b[^;]*from\s+"@angels-bandits\/common\/city"/.test(
          src,
        );
      const readsShape = /\.height\b|\.tiers\b|tierGrids|\.roof\b/.test(src);
      if (importsBuilding && readsShape && !names.has(f.slice(0, -3))) {
        missing.push(f);
      }
    }
    expect(
      missing,
      "a render module reads building geometry: register its StandingLayer in render/standing-layers.ts (STANDING_LAYERS) or exempt it there with the reason",
    ).toEqual([]);
    for (const [name, why] of Object.entries(STANDING_EXEMPT)) {
      expect(why.length, name).toBeGreaterThan(10);
    }
  });

  for (const sc of SCENARIOS) {
    it(`${sc.name}: nothing kept hangs off the live solids; a rebuild brings it all back`, () => {
      const { city, damage, hit } = sc.build();
      for (const probe of STANDING_LAYERS) {
        const layer = probe.layer(city, CITY_SEED);
        const mask = new StandingMask(city, layer);
        for (const i of hit) {
          const b = city[i] as Building;
          const kept = keptBoxes(mask, layer, i);
          const bad = kept.filter((box) => !boxOnSolids(b, box));
          expect(bad, `${probe.name} on building ${i}`).toEqual([]);
          if (sc.name.startsWith("felled") || sc.name === "pancake") {
            const ceiling = standingProfile(b).top + STAND_ROOF_RISE;
            for (const box of kept)
              expect(box.y1).toBeLessThanOrEqual(ceiling + 1e-6);
          }
        }
      }
      // Rebuilt: every item is back.
      for (const i of hit) damage.restoreBuilding(i);
      for (const probe of STANDING_LAYERS) {
        const layer = probe.layer(city, CITY_SEED);
        const mask = new StandingMask(city, layer);
        for (const i of hit) {
          expect(keptBoxes(mask, layer, i).length, probe.name).toBe(
            layer.boxes(i).length,
          );
        }
      }
    });
  }

  it("is not vacuous: pancaking each layer's busiest tower hides its items", () => {
    for (const probe of STANDING_LAYERS) {
      const layer = probe.layer(base, CITY_SEED);
      let pick = -1;
      let most = 0;
      base.forEach((b, i) => {
        const n = layer.boxes(i).length;
        if (tierGrids(b)[0] && n > most) {
          most = n;
          pick = i;
        }
      });
      expect(pick, `${probe.name} has items somewhere`).toBeGreaterThanOrEqual(
        0,
      );
      const { city } = fell(pick, PANCAKE);
      const flayer = probe.layer(city, CITY_SEED);
      const mask = new StandingMask(city, flayer);
      const kept = keptBoxes(mask, flayer, pick);
      expect(kept.length, probe.name).toBeLessThan(flayer.boxes(pick).length);
      const b = city[pick] as Building;
      for (const box of kept)
        expect(boxOnSolids(b, box), probe.name).toBe(true);
    }
  });
});

describe("D8 roof structures follow the stump (draw == collide)", () => {
  it("a felled tower's tanks and masts leave collision and the roof renderer together, and come back with it", () => {
    const withRoof = base.findIndex(
      (b) => tall(b) && (b.roof?.length ?? 0) > 0,
    );
    expect(withRoof).toBeGreaterThanOrEqual(0);
    const { city, damage } = fell(withRoof, TOPPLE);
    const b = city[withRoof] as Building;
    const gen = base[withRoof] as Building;
    expect(b.roof ?? []).toEqual([]);
    expect(drawnStructures(b)).toEqual(b.roof ?? []);
    // Where a tank stood at the old roof height there is only air now.
    for (const s of gen.roof ?? []) {
      const at = { x: b.x + s.dx, y: s.baseY + s.height / 2, z: b.z + s.dz };
      expect(collideCity(at, 1, city)).toBeNull();
    }
    damage.restoreBuilding(withRoof);
    expect(b.roof?.length).toBe(gen.roof?.length);
    expect(drawnStructures(b)).toEqual(b.roof);
    const s = (gen.roof ?? [])[0] as NonNullable<Building["roof"]>[number];
    expect(
      collideCity(
        { x: b.x + s.dx, y: s.baseY + s.height / 2, z: b.z + s.dz },
        1,
        city,
      ),
    ).toBe(b);
  });

  it("a chewed roof keeps exactly the structures whose deck stands, drawn and solid alike", () => {
    let checked = 0;
    for (const sc of SCENARIOS) {
      const { city, hit } = sc.build();
      for (const i of hit) {
        const b = city[i] as Building;
        expect(drawnStructures(b), sc.name).toEqual(b.roof ?? []);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("D8 demolition leaves a broken, held-up stump", () => {
  // One city, each tower felled and rebuilt in turn (restoreBuilding).
  const city = generateCity(CITY_SEED);
  const damage = new CityDamage();
  damage.bind(city);
  const eligible = city.map((b, i) => [b, i] as const).filter(([b]) => tall(b));

  it("owes no further collapse after any TOPPLE or PANCAKE demolition", () => {
    expect(eligible.length).toBeGreaterThan(30);
    for (const [b, i] of eligible) {
      for (const [style, dir] of [
        [TOPPLE, DIR_NEG_X],
        [TOPPLE, DIR_POS_X],
        [TOPPLE, DIR_NEG_Z],
        [TOPPLE, DIR_POS_Z],
        [PANCAKE, 0],
      ] as const) {
        const plan = demolitionPlan(b, i, style, dir);
        if (plan) damage.collapse(plan.chunks);
        expect(planCollapses(b, i), `${i}`).toEqual([]);
        damage.restoreBuilding(i);
      }
    }
  });

  it("is stepped (TOPPLE), and no piece swings through it or comes to rest on it", () => {
    let stepped = 0;
    let checked = 0;
    const pose = blankPose();
    for (const [b, i] of eligible) {
      for (const dir of [DIR_NEG_X, DIR_POS_X, DIR_NEG_Z, DIR_POS_Z]) {
        const plan = demolitionPlan(b, i, TOPPLE, dir);
        if (!plan) continue;
        damage.collapse(plan.chunks);
        if (new Set(standingProfile(b).stump).size > 1) stepped++;
        const stump = solids(b).filter((s) => !(s.cut & CUT_RUBBLE));
        // Every 4th tower gets the full swept-pose check (it is the slow part).
        const swept = checked++ % 4 === 0;
        const c = buildCollapse(city, collapseWire(plan, i, 1, 0));
        damage.restoreBuilding(i);
        if (!c) continue;
        let top = 0;
        for (const s of stump) top = Math.max(top, s.baseY + s.height);
        // The jagged part (above the bottom band): the bottom band's fall-side
        // edge is grazed as pieces break away over it, as it always was.
        const raised = stump.filter((s) => s.baseY > 0.5);
        const inside = (x: number, y: number, z: number) =>
          raised.some(
            (s) =>
              Math.abs(x - s.dx) < s.width / 2 - 0.5 &&
              Math.abs(z - s.dz) < s.depth / 2 - 0.5 &&
              y > s.baseY + 0.5 &&
              y < s.baseY + s.height - 0.5,
          );
        for (let p = 0; p < c.n && swept; p++) {
          for (let t = 0; t <= c.endMs; t += 50) {
            piecePose(c, p, t, pose);
            const reach = Math.hypot(pose.hx, pose.hy, pose.hz);
            if (pose.y - reach > top) continue;
            const ca = Math.cos(pose.phi);
            const sa = Math.sin(pose.phi);
            for (const u of [-1, 0, 1])
              for (const v of [-1, 0, 1])
                for (const w of [-1, 0, 1]) {
                  const lx = u * pose.hx;
                  const ly = v * pose.hy;
                  const lz = w * pose.hz;
                  // Rotation about x (axis 0) or z (axis 1), as collapse.ts.
                  const x = pose.axis === 1 ? lx * ca - ly * sa : lx;
                  const y =
                    pose.axis === 1 ? lx * sa + ly * ca : ly * ca - lz * sa;
                  const z = pose.axis === 1 ? lz : ly * sa + lz * ca;
                  if (inside(pose.x + x, pose.y + y, pose.z + z)) {
                    expect.fail(
                      `building ${i} dir ${dir} piece ${p} at ${t} ms`,
                    );
                  }
                }
          }
        }
        for (let p = 0; p < c.n; p++) {
          // At rest: on the ground, clear of the footprint it fell from.
          expect(c.ry[p] as number).toBeCloseTo(c.ay[p] as number, 6);
          const over = stump.some(
            (s) =>
              Math.min(
                (c.rx[p] as number) + (c.ax[p] as number),
                s.dx + s.width / 2,
              ) -
                Math.max(
                  (c.rx[p] as number) - (c.ax[p] as number),
                  s.dx - s.width / 2,
                ) >
                1e-6 &&
              Math.min(
                (c.rz[p] as number) + (c.az[p] as number),
                s.dz + s.depth / 2,
              ) -
                Math.max(
                  (c.rz[p] as number) - (c.az[p] as number),
                  s.dz - s.depth / 2,
                ) >
                1e-6,
          );
          if (over)
            expect.fail(
              `building ${i} dir ${dir} piece ${p} rests on the stump`,
            );
        }
      }
    }
    expect(stepped).toBeGreaterThan(20);
  });
});

describe("D8 the hide survives the GPU write paths", () => {
  it("ImageCache.dirty re-places one instance on the next update, even with no image change", () => {
    const cache = new ImageCache([10, 20, 30], [10, 20, 30]);
    const writes: number[] = [];
    cache.update({ x: 0, y: 0, z: 0 }, (i) => writes.push(i));
    expect(writes).toEqual([0, 1, 2]);
    writes.length = 0;
    cache.update({ x: 1, y: 0, z: 1 }, (i) => writes.push(i));
    expect(writes).toEqual([]);
    cache.dirty(2);
    cache.dirty(0);
    cache.update({ x: 2, y: 0, z: 2 }, (i) => writes.push(i));
    expect(writes).toEqual([0, 2]);
  });

  it("BakedHider drops an item below the far plane and restores it exactly", () => {
    const pos = new THREE.BufferAttribute(
      new Float32Array([0, 1.25, 0, 1, 2.5, 1, 2, 3.75, 2, 3, 5, 3]),
      3,
    );
    const hider = new BakedHider(pos, [0, 2, 4]);
    const before = Float32Array.from(pos.array as Float32Array);
    hider.setHidden(1, true);
    hider.flush();
    expect(pos.getY(2)).toBeCloseTo(3.75 - HIDE_DROP, 0);
    expect(pos.getY(0)).toBe(1.25);
    hider.setHidden(1, true);
    hider.setHidden(1, false);
    hider.flush();
    expect(Array.from(pos.array as Float32Array)).toEqual(Array.from(before));
  });

  it("FacadeGarnishRenderer hides a felled tower's parapets, through a torus flip, and shows them after the rebuild", () => {
    attachStanding(null);
    const city = generateCity(CITY_SEED);
    const damage = new CityDamage();
    damage.bind(city);
    const r = new FacadeGarnishRenderer(city);
    const first = city
      .slice(0, TOWER)
      .reduce((n, b) => n + facadeGarnishFor(b).parapets.length, 0);
    const count = facadeGarnishFor(city[TOWER] as Building).parapets.length;
    expect(count).toBeGreaterThan(0);
    const mesh = r.group.children[0] as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    const scaleY = (i: number) => {
      mesh.getMatrixAt(i, m);
      return Math.hypot(
        m.elements[4] as number,
        m.elements[5] as number,
        m.elements[6] as number,
      );
    };
    const b = city[TOWER] as Building;
    const cam = { x: b.x + 50, y: 80, z: b.z };
    r.update(cam);
    for (let k = 0; k < count; k++)
      expect(scaleY(first + k)).toBeGreaterThan(0);
    const plan = demolitionPlan(b, TOWER, TOPPLE, DIR_POS_X);
    damage.collapse((plan as NonNullable<typeof plan>).chunks);
    r.update(cam);
    const hiddenTop = () =>
      [...Array(count).keys()].filter((k) => scaleY(first + k) === 0).length;
    expect(hiddenTop()).toBeGreaterThan(0);
    // Across the half-world line and back: the image flips, the hide stays.
    r.update({ x: b.x + WORLD_SIZE / 2 + 5, y: 80, z: b.z });
    expect(hiddenTop()).toBeGreaterThan(0);
    r.update(cam);
    expect(hiddenTop()).toBeGreaterThan(0);
    damage.restoreBuilding(TOWER);
    r.update(cam);
    expect(hiddenTop()).toBe(0);
  });
});
