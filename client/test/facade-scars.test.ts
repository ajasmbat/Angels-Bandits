// D9 facade scars (client/src/render/facade-scars.ts): the broken-window
// rings and soot streaks are a pure function of the destroyed and sooted
// chunks, and the keeper re-writes them into the D1 atlas only when they
// changed or lost their slot — a steady view writes nothing.

import {
  type Building,
  CityDamage,
  chunkCell,
  chunkTier,
  chunksOf,
  generateCity,
  tierGrids,
} from "@angels-bandits/common/city";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { FacadeDamage } from "../src/render/damage-map";
import {
  FacadeScarKeeper,
  SCAR_HYSTERESIS_M,
  SCAR_KEEP_M,
  facadeScars,
} from "../src/render/facade-scars";

const buildings = generateCity(CITY_SEED);
const damage = new CityDamage();
damage.bind(buildings);
/** A plain multi-floor tower. */
const bi = buildings.findIndex((b) => {
  const g = tierGrids(b)[0];
  return !b.holes && b.tiers.length === 1 && !!g && g.ny >= 6 && g.nx >= 3;
});
const b = buildings[bi] as Building;
const g = tierGrids(b)[0] as NonNullable<ReturnType<typeof tierGrids>[number]>;
/** Outer chunks of its +x face, floor 2 and floor 3. */
const face: number[] = chunksOf(b, bi).filter((id) => {
  if (chunkTier(id) !== 0) return false;
  const cell = chunkCell(id);
  const ix = cell % g.nx;
  const iy = Math.floor(cell / (g.nx * g.nz));
  return ix === g.nx - 1 && (iy === 2 || iy === 3);
});

describe("D9 facade scars", () => {
  it("ring broken chunks with shattered panes and streak soot up from burnt ones", () => {
    damage.apply([face[0] as number]);
    const soot = [face[1] as number];
    const marks = facadeScars(b, bi, soot);
    expect(facadeScars(b, bi, soot)).toEqual(marks); // pure
    expect(marks.some((m) => m.shatter)).toBe(true);
    const soots = marks.filter((m) => !m.shatter);
    expect(soots.length).toBeGreaterThan(0);
    // The streak climbs above the chunk's own rows, fading as it goes.
    const rows = soots.map((m) => m.cy);
    const top = Math.max(...rows);
    const bottom = Math.min(...rows);
    expect(top).toBeGreaterThan(bottom + 2);
    const at = (cy: number) => soots.find((m) => m.cy === cy)?.scorch ?? 0;
    expect(at(top)).toBeLessThan(at(bottom));
    // A rebuilt building has none.
    damage.restoreBuilding(bi);
    expect(facadeScars(b, bi, [])).toEqual([]);
  });

  it("are written once in a steady view, again only after a slot is lost", () => {
    damage.apply([face[0] as number, face[2] as number]);
    const atlas = new FacadeDamage();
    const soot = new Set<number>([face[1] as number]);
    const keeper = new FacadeScarKeeper(atlas, buildings, soot);
    const eye = { x: b.x + 60, y: 20, z: b.z };
    let now = 0;
    const frames = (n: number, at = eye) => {
      for (let k = 0; k < n; k++) {
        keeper.update(at, now);
        now += 100;
      }
    };
    frames(20);
    expect(keeper.reapplies).toBe(1);
    frames(60);
    expect(keeper.reapplies).toBe(1); // steady: nothing re-written
    expect(atlas.slotOf(bi, 0, 0)).toBeGreaterThanOrEqual(0);
    // Fresh bullet marks on other buildings push its faces out of the atlas
    // (least recently hit first)...
    const flood = () => {
      for (let o = 0, n = 0; n < 60; o++) {
        if (o === bi) continue;
        atlas.bulletHole(o, 0, n % 4, 0, 0);
        n++;
      }
    };
    flood();
    expect(atlas.slotOf(bi, 0, 0)).toBe(-1);
    frames(10);
    expect(keeper.reapplies).toBe(2); // ...and it comes back
    expect(atlas.slotOf(bi, 0, 0)).toBeGreaterThanOrEqual(0);
    // Hysteresis: a kept building stays kept a little past the keep range.
    const off = (d: number) => ({ x: b.x + d, y: 20, z: b.z });
    frames(10, off(SCAR_KEEP_M + SCAR_HYSTERESIS_M / 2));
    flood();
    frames(10, off(SCAR_KEEP_M + SCAR_HYSTERESIS_M / 2));
    expect(keeper.reapplies).toBe(3);
    // Far beyond it, it is let go: no more writes.
    flood();
    frames(10, off(SCAR_KEEP_M + SCAR_HYSTERESIS_M + 60));
    expect(keeper.reapplies).toBe(3);
    damage.restoreBuilding(bi);
  });
});
