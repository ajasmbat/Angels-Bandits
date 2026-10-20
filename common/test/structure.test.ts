// DS1 the structural frame: every building as slabs, facade panels and
// columns that partition exactly the solids the renderer draws and
// collision tests (draw == collide with the standing building), and the
// column-load rule that decides which floor gives and which way the
// section above it goes.

import {
  type Building,
  baseSolids,
  chunkMask,
  generateCity,
  makeBuilding,
  tierGrids,
} from "@angels-bandits/common/city";
import { archetypeFor } from "@angels-bandits/common/city/archetype";
import {
  type LocalBox,
  cellIndex,
  cellSolids,
} from "@angels-bandits/common/city/destruction";

import {
  EL_COLUMN,
  EL_PANEL,
  EL_SLAB,
  FACE_NEG_X,
  FACE_NEG_Z,
  FACE_POS_X,
  FACE_POS_Z,
  MAT_CONCRETE,
  MAT_GLASS,
  MAT_MASONRY,
  MAT_STEEL,
  PANEL_THICK,
  bayResistance,
  buildingFrame,
  failingFloor,
  floorLoad,
  hingeLine,
  leanDir,
  volume,
} from "@angels-bandits/common/city/structure";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";

const CITY = generateCity(CITY_SEED);

const overlap = (a: LocalBox, b: LocalBox): number =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) *
  Math.max(0, Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0));

const inside = (a: LocalBox, b: LocalBox, eps = 1e-6): boolean =>
  a.x0 >= b.x0 - eps &&
  a.x1 <= b.x1 + eps &&
  a.y0 >= b.y0 - eps &&
  a.y1 <= b.y1 + eps &&
  a.z0 >= b.z0 - eps &&
  a.z1 <= b.z1 + eps;

const solidBox = (s: {
  dx: number;
  dz: number;
  baseY: number;
  width: number;
  height: number;
  depth: number;
}): LocalBox => ({
  x0: s.dx - s.width / 2,
  x1: s.dx + s.width / 2,
  y0: s.baseY,
  y1: s.baseY + s.height,
  z0: s.dz - s.depth / 2,
  z1: s.dz + s.depth / 2,
});

/** A plain 3 × 3-bay, 10-band tower of one tier. */
const TOWER = makeBuilding({
  x: 500,
  z: 500,
  width: 60,
  depth: 60,
  height: 120,
  tiers: [{ width: 60, depth: 60, height: 120 }],
});

/** Every bay of `b` standing. */
const allStanding = (b: Building): Uint8Array[] =>
  chunkMask(b).map((m) => m.slice());

describe("the frame covers the standing building", () => {
  it("every bay's slabs and panels tile exactly its generated solids", () => {
    // Plain checks into one list (an expect per element is ~10⁶ calls).
    const bad: string[] = [];
    let bays = 0;
    CITY.forEach((b, bi) => {
      const frame = buildingFrame(b);
      const masks = chunkMask(b);
      frame.tiers.forEach((tf, k) => {
        const mask = masks[k] as Uint8Array;
        for (let c = 0; c < mask.length; c++) {
          const at = `building ${bi} tier ${k} bay ${c}`;
          const list = tf.byCell[c] as number[];
          if (!mask[c]) {
            if (list.length > 0) bad.push(`${at}: elements in hole air`);
            continue;
          }
          bays++;
          const solids = cellSolids(b, k, c).map(solidBox);
          const want = solids.reduce((s, x) => s + volume(x), 0);
          let got = 0;
          for (const e of list) {
            const el = frame.elements[e];
            if (!el) throw new Error("missing element");
            if (el.kind !== EL_SLAB && el.kind !== EL_PANEL)
              bad.push(`${at}: kind ${el.kind}`);
            if (el.tier !== k || el.cell !== c) bad.push(`${at}: misfiled`);
            if (!(volume(el.box) > 0)) bad.push(`${at}: empty element`);
            // Inside the bay's solid it was cut from…
            if (!inside(el.box, solids[el.part] as LocalBox))
              bad.push(`${at}: element outside its solid`);
            got += volume(el.box);
          }
          // …and together exactly as much as they hold.
          if (!(Math.abs(got - want) < want * 1e-9 + 1e-6))
            bad.push(`${at}: volume ${got} ≠ ${want}`);
          // A partition: no two elements of a solid share volume. (Holed
          // tiers' solids overlap each other by H1's 5 cm seam, so only
          // elements cut from the same solid are compared.)
          for (let i = 0; i < list.length; i++) {
            const a = frame.elements[list[i] as number];
            for (let j = i + 1; j < list.length; j++) {
              const o = frame.elements[list[j] as number];
              if (!a || !o) throw new Error("missing element");
              if (a.part !== o.part) continue;
              if (!(overlap(a.box, o.box) < 1e-6))
                bad.push(`${at}: elements overlap`);
            }
          }
        }
      });
    });
    expect(bad.slice(0, 10)).toEqual([]);
    expect(bays).toBeGreaterThan(30_000);
  });

  it("the whole frame is the building's volume, tier by tier", () => {
    for (const b of CITY) {
      const frame = buildingFrame(b);
      const base = baseSolids(b);
      tierGrids(b).forEach((g, k) => {
        const want = base
          .filter((s) => s.tierIndex === k)
          .reduce((s, x) => s + volume(solidBox(x)), 0);
        let got = 0;
        let x0 = Number.POSITIVE_INFINITY;
        let x1 = Number.NEGATIVE_INFINITY;
        let y0 = Number.POSITIVE_INFINITY;
        let y1 = Number.NEGATIVE_INFINITY;
        for (const el of frame.elements) {
          if (el.tier !== k) continue;
          got += volume(el.box);
          x0 = Math.min(x0, el.box.x0);
          x1 = Math.max(x1, el.box.x1);
          y0 = Math.min(y0, el.box.y0);
          y1 = Math.max(y1, el.box.y1);
        }
        // Holed tiers' solids carry H1's seam overlap — counted in both.
        expect(Math.abs(got - want)).toBeLessThan(want * 1e-6 + 1e-3);
        expect(x0).toBeCloseTo(-g.width / 2, 6);
        expect(x1).toBeCloseTo(g.width / 2, 6);
        expect(y0).toBeCloseTo(g.baseY, 6);
        expect(y1).toBeCloseTo(g.baseY + g.height, 6);
      });
    }
  });

  it("facade panels clad the tier outline, of the building's material", () => {
    const bad: string[] = [];
    const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
    CITY.forEach((b, bi) => {
      if (b.holes) return;
      const frame = buildingFrame(b);
      const mat = archetypeFor(b);
      tierGrids(b).forEach((g, k) => {
        const at = `building ${bi} tier ${k}`;
        const area = [0, 0, 0, 0];
        for (const el of frame.elements) {
          if (el.tier !== k) continue;
          if (el.kind === EL_SLAB) {
            if (el.material !== MAT_CONCRETE) bad.push(`${at}: slab material`);
            continue;
          }
          if (el.material !== mat) bad.push(`${at}: panel material`);
          const bx = el.box;
          const thick =
            el.face === FACE_NEG_X || el.face === FACE_POS_X
              ? bx.x1 - bx.x0
              : bx.z1 - bx.z0;
          if (!close(thick, PANEL_THICK)) bad.push(`${at}: panel depth`);
          const onOutline =
            el.face === FACE_NEG_X
              ? close(bx.x0, -g.width / 2)
              : el.face === FACE_POS_X
                ? close(bx.x1, g.width / 2)
                : el.face === FACE_NEG_Z
                  ? close(bx.z0, -g.depth / 2)
                  : el.face === FACE_POS_Z && close(bx.z1, g.depth / 2);
          if (!onOutline) bad.push(`${at}: panel off the outline`);
          const along =
            el.face === FACE_NEG_X || el.face === FACE_POS_X
              ? bx.z1 - bx.z0
              : bx.x1 - bx.x0;
          area[el.face] = (area[el.face] as number) + along * (bx.y1 - bx.y0);
        }
        // Every face is clad wherever its bays leave room for a panel and
        // a slab behind it (the x-faces' panels run the full depth, the
        // z-faces' fit between them).
        const span = 2 * PANEL_THICK + 2;
        if (g.cd >= span) {
          for (const f of [FACE_NEG_X, FACE_POS_X]) {
            if (!close(area[f] as number, g.depth * g.height, 1e-3))
              bad.push(`${at}: face ${f} clad ${area[f]}`);
          }
        }
        if (g.cw >= span && g.cd >= span) {
          for (const f of [FACE_NEG_Z, FACE_POS_Z]) {
            const want = (g.width - 2 * PANEL_THICK) * g.height;
            if (!close(area[f] as number, want, 1e-3))
              bad.push(`${at}: face ${f} clad ${area[f]}`);
          }
        }
      });
    });
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("columns stand at the bay grid, inside the building, of steel", () => {
    const frame = buildingFrame(TOWER);
    const tf = frame.tiers[0];
    if (!tf) throw new Error("no tier");
    expect(tf.columns.length).toBe(10);
    for (const band of tf.columns) {
      // 4 × 4 intersections of a 3 × 3 bay grid.
      expect(band.length).toBe(16);
      for (const col of band) {
        expect(col.kind).toBe(EL_COLUMN);
        expect(col.material).toBe(MAT_STEEL);
        expect(col.box.x0).toBeGreaterThanOrEqual(-30 + PANEL_THICK - 1e-9);
        expect(col.box.x1).toBeLessThanOrEqual(30 - PANEL_THICK + 1e-9);
        const corner =
          (col.ix === 0 || col.ix === 3) && (col.iz === 0 || col.iz === 3);
        const edge =
          col.ix === 0 || col.ix === 3 || col.iz === 0 || col.iz === 3;
        expect(col.cells.length).toBe(corner ? 1 : edge ? 2 : 4);
      }
    }
  });

  it("glass gives and masonry resists a penetrating body", () => {
    let glass = 0;
    let gn = 0;
    let masonry = 0;
    let mn = 0;
    for (const b of CITY) {
      const mat = buildingFrame(b).material;
      if (mat !== MAT_GLASS && mat !== MAT_MASONRY) continue;
      if (b.height >= 400) continue;
      chunkMask(b).forEach((m, k) => {
        for (let c = 0; c < m.length; c++) {
          if (!m[c]) continue;
          const r = bayResistance(b, k, c);
          if (mat === MAT_GLASS) {
            glass += r;
            gn++;
          } else {
            masonry += r;
            mn++;
          }
        }
      });
    }
    expect(gn).toBeGreaterThan(0);
    expect(mn).toBeGreaterThan(0);
    expect(glass / gn).toBeLessThan(masonry / mn);
  });
});

describe("columns carry the load", () => {
  const g = tierGrids(TOWER)[0];
  if (!g) throw new Error("no grid");
  const band = 3;
  const cellAt = (ix: number, iz: number) => cellIndex(g, ix, band, iz);

  it("an intact tower holds; one bay shot out still holds", () => {
    const st = allStanding(TOWER);
    expect(failingFloor(TOWER, st, 0.5)).toBeNull();
    (st[0] as Uint8Array)[cellAt(1, 1)] = 0;
    expect(failingFloor(TOWER, st, 0.5)).toBeNull();
    // The centre bay's four columns are each still braced by three bays.
    expect(floorLoad(buildingFrame(TOWER), st, 0, band).up).toBe(16);
  });

  it("a floor stripped evenly fails and pancakes", () => {
    const st = allStanding(TOWER);
    for (let ix = 0; ix < 3; ix++) {
      for (let iz = 0; iz < 3; iz++) (st[0] as Uint8Array)[cellAt(ix, iz)] = 0;
    }
    expect(failingFloor(TOWER, st, 0.5)).toEqual({ tier: 0, band });
    const load = floorLoad(buildingFrame(TOWER), st, 0, band);
    expect(load.up).toBe(0);
    expect(leanDir(load, g, 0.12)).toBe(-1);
    expect(
      hingeLine(TOWER, st, g.baseY + (band + 1) * g.ch, FACE_POS_X),
    ).toBeNaN();
  });

  it("columns failing on one side lean the tower over the last line standing", () => {
    for (const [dir, gone] of [
      [FACE_POS_X, (ix: number, _iz: number) => ix >= 1],
      [FACE_NEG_X, (ix: number, _iz: number) => ix <= 1],
      [FACE_POS_Z, (_ix: number, iz: number) => iz >= 1],
      [FACE_NEG_Z, (_ix: number, iz: number) => iz <= 1],
    ] as const) {
      const st = allStanding(TOWER);
      for (let ix = 0; ix < 3; ix++) {
        for (let iz = 0; iz < 3; iz++) {
          if (gone(ix, iz)) (st[0] as Uint8Array)[cellAt(ix, iz)] = 0;
        }
      }
      // Two of three bay rows gone: half the columns (the line between
      // the last standing row and the next is still braced) — under 0.6.
      expect(failingFloor(TOWER, st, 0.6)).toEqual({ tier: 0, band });
      const load = floorLoad(buildingFrame(TOWER), st, 0, band);
      expect(load.up).toBe(8);
      expect(leanDir(load, g, 0.12)).toBe(dir);
      // The hinge is the surviving column line nearest the failed side —
      // inside the footprint, not its edge.
      const y = g.baseY + (band + 1) * g.ch;
      const h = hingeLine(TOWER, st, y, dir);
      expect(Number.isFinite(h)).toBe(true);
      expect(Math.abs(h)).toBeLessThan(30 - PANEL_THICK);
      if (dir === FACE_POS_X || dir === FACE_POS_Z) expect(h).toBeLessThan(0);
      else expect(h).toBeGreaterThan(0);
    }
  });

  it("a weaker frame fails sooner (the strength knob)", () => {
    const st = allStanding(TOWER);
    // Two of three bay rows gone on one side: 8 of 16 columns stand.
    for (let iz = 0; iz < 3; iz++) {
      (st[0] as Uint8Array)[cellAt(2, iz)] = 0;
      (st[0] as Uint8Array)[cellAt(1, iz)] = 0;
    }
    const up = floorLoad(buildingFrame(TOWER), st, 0, band).up;
    expect(up).toBe(8);
    expect(failingFloor(TOWER, st, 0.4)).toBeNull();
    expect(failingFloor(TOWER, st, 0.6)).toEqual({ tier: 0, band });
  });
});
