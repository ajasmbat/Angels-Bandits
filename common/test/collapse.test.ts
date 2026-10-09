// D3 collapses, the shared model: what triggers a collapse (D2's support
// graph + the band rule), that every collapse leaves nothing floating, and
// that the debris is a pure, continuous function of (event, time) that ends
// at rest as rubble boxes on the ground inside the world.

import {
  type Building,
  CityDamage,
  chunkId,
  chunkMask,
  generateCity,
  makeBuilding,
  mulberry32,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  type CollapseWire,
  DIR_NEG_X,
  DIR_POS_X,
  PANCAKE,
  TOPPLE,
  blankPose,
  buildCollapse,
  collapseChunks,
  collapseWire,
  collideCollapses,
  piecePose,
  planCollapses,
  standingOf,
  supportedOf,
} from "@angels-bandits/common/city/collapse";
import {
  CITY_SEED,
  COLLAPSE_BAND_MIN,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { canonicalize } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const SEED_CITY = generateCity(CITY_SEED);

/** A fresh, bound city to break: a clone of the seed city (new Building
 * objects sharing the immutable shape, as a server room makes). */
function freshCity(): { city: Building[]; damage: CityDamage } {
  const city = SEED_CITY.map((b) => makeBuilding({ ...b, damage: undefined }));
  const damage = new CityDamage();
  damage.bind(city);
  return { city, damage };
}

/** A plain multi-band tower whose street tier is at least 2 × 2 chunks. */
function pickTower(city: readonly Building[]): number {
  const i = city.findIndex((b) => {
    const g = tierGrids(b)[0];
    return (
      !b.holes && !!g && g.nx >= 2 && g.nz >= 2 && g.ny >= 3 && b.height >= 80
    );
  });
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
}

/** The base-band cell midway along the −x face of `b`'s street tier. */
function midWest(b: Building): number {
  const g = tierGrids(b)[0];
  if (!g) throw new Error("no grid");
  return Math.floor(g.nz / 2) * g.nx;
}

/** Destroy every chunk of tier 0 band 0 of `index`, except `keep` cells. */
function cutBase(
  damage: CityDamage,
  b: Building,
  index: number,
  keep: readonly number[] = [],
): void {
  const g = tierGrids(b)[0];
  if (!g) throw new Error("no grid");
  for (let c = 0; c < g.nx * g.nz; c++) {
    if (!keep.includes(c)) damage.destroyChunk(chunkId(index, 0, c));
  }
}

/** Apply every plan the way the server does (mark fallen). */
function applyPlans(damage: CityDamage, b: Building, index: number) {
  const plans = planCollapses(b, index);
  for (const p of plans) damage.collapse(p.chunks);
  return plans;
}

/** Nothing standing is unsupported, and no band is under the band rule
 * with anything standing above it. */
function assertStable(b: Building): void {
  const standing = standingOf(b);
  const S = supportedOf(b, standing);
  standing.forEach((st, k) => {
    for (let c = 0; c < st.length; c++) {
      if (st[c]) expect(S[k]?.[c], `tier ${k} cell ${c} floats`).toBe(1);
    }
  });
  const grids = tierGrids(b);
  const masks = chunkMask(b);
  let above = false;
  for (let k = grids.length - 1; k >= 0; k--) {
    const g = grids[k];
    const st = standing[k];
    const mask = masks[k];
    if (!g || !st || !mask) continue;
    for (let iy = g.ny - 1; iy >= 0; iy--) {
      let exist = 0;
      let up = 0;
      for (let c = iy * g.nx * g.nz; c < (iy + 1) * g.nx * g.nz; c++) {
        exist += mask[c] as number;
        up += st[c] as number;
      }
      if (above && exist > 0) {
        expect(
          up,
          `tier ${k} band ${iy} carries a load it cannot`,
        ).toBeGreaterThanOrEqual(COLLAPSE_BAND_MIN * exist);
      }
      if (up > 0) above = true;
    }
  }
}

describe("D3 collapse trigger — D2's support graph", () => {
  it("an intact building owes nothing", () => {
    const { city } = freshCity();
    for (let i = 0; i < city.length; i += 7) {
      expect(planCollapses(city[i] as Building, i)).toEqual([]);
    }
  });

  it("one shot-out chunk at the base is spanned, not a collapse", () => {
    const { city, damage } = freshCity();
    const i = pickTower(city);
    const b = city[i] as Building;
    damage.destroyChunk(chunkId(i, 0, 0));
    expect(planCollapses(b, i)).toEqual([]);
  });

  it("the whole base band gone: everything above pancakes", () => {
    const { city, damage } = freshCity();
    const i = pickTower(city);
    const b = city[i] as Building;
    const standingBefore = standingOf(b);
    cutBase(damage, b, i);
    const plans = planCollapses(b, i);
    expect(plans.length).toBe(1);
    expect(plans[0]?.style).toBe(PANCAKE);
    // Everything that still stood falls: the section above the band.
    let stood = 0;
    for (const st of standingBefore) for (const v of st) stood += v;
    const g0 = tierGrids(b)[0];
    expect(plans[0]?.chunks.length).toBe(stood - (g0 ? g0.nx * g0.nz : 0));
    for (const p of plans) damage.collapse(p.chunks);
    assertStable(b);
    expect(damage.fallenCount).toBe(plans[0]?.chunks.length);
    // Fallen chunks never count toward the cap or the `chunks` replay.
    expect(
      damage.destroyedIds().every((id) => !plans[0]?.chunks.includes(id)),
    ).toBe(true);
  });

  it("survivors on one side: the section topples toward the missing side", () => {
    const { city, damage } = freshCity();
    const i = pickTower(city);
    const b = city[i] as Building;
    const g = tierGrids(b)[0];
    if (!g) throw new Error("no grid");
    // Keep one chunk midway along the −x face: the +x side is gone.
    const keep = [midWest(b)];
    expect(keep.length).toBeLessThan(COLLAPSE_BAND_MIN * g.nx * g.nz);
    cutBase(damage, b, i, keep);
    const plans = applyPlans(damage, b, i);
    expect(plans[0]?.style).toBe(TOPPLE);
    expect(plans[0]?.dir).toBe(DIR_POS_X);
    assertStable(b);
    // The mirror image topples the other way.
    const other = freshCity();
    const b2 = other.city[i] as Building;
    cutBase(
      other.damage,
      b2,
      i,
      keep.map((c) => c + g.nx - 1),
    );
    expect(planCollapses(b2, i)[0]?.dir).toBe(DIR_NEG_X);
  });

  it("seeded fuzz: any damage settles to a city with nothing floating", () => {
    const { city, damage } = freshCity();
    const rand = mulberry32(0xd3);
    let collapses = 0;
    for (let trial = 0; trial < 40; trial++) {
      const i = Math.floor(rand() * city.length);
      const b = city[i] as Building;
      const share = 0.1 + 0.5 * rand();
      chunkMask(b).forEach((mask, k) => {
        for (let c = 0; c < mask.length; c++) {
          if (mask[c] && rand() < share) damage.destroyChunk(chunkId(i, k, c));
        }
      });
      const plans = applyPlans(damage, b, i);
      collapses += plans.length;
      assertStable(b);
      // Settled: planning again owes nothing.
      expect(planCollapses(b, i)).toEqual([]);
    }
    expect(collapses).toBeGreaterThan(0);
  });
});

/** A collapse of `style` on the picked tower, as the server would build it. */
function sampleCollapse(style: "pancake" | "topple"): {
  city: Building[];
  wire: CollapseWire;
  c: Collapse;
} {
  const { city, damage } = freshCity();
  const i = pickTower(city);
  const b = city[i] as Building;
  const g = tierGrids(b)[0];
  if (!g) throw new Error("no grid");
  cutBase(damage, b, i, style === "topple" ? [midWest(b)] : []);
  const plan = planCollapses(b, i)[0];
  if (!plan) throw new Error("no plan");
  const wire = collapseWire(plan, i, 7, 50_000);
  const c = buildCollapse(city, wire);
  if (!c) throw new Error("no debris");
  return { city, wire, c };
}

describe("D3 debris trajectories", () => {
  for (const style of ["pancake", "topple"] as const) {
    it(`${style}: pure in (event, time), continuous, and at rest as rubble inside the world`, () => {
      const { city, wire, c } = sampleCollapse(style);
      // Pure: rebuilding from the same wire gives the same poses, in any
      // order of queries.
      const again = buildCollapse(city, JSON.parse(JSON.stringify(wire)));
      if (!again) throw new Error("no rebuild");
      const a = blankPose();
      const b = blankPose();
      for (const t of [1e9, 3000, -500, 1200, 0, 7777]) {
        for (let i = 0; i < c.n; i += 3) {
          expect(piecePose(again, i, c.t0 + t, b)).toEqual({
            ...piecePose(c, i, c.t0 + t, a),
          });
        }
      }
      // Before the event (a trailing render clock) and through the lead
      // beat: the piece stands exactly where its chunk stood.
      for (const t of [-1e6, -1, 0, 300]) {
        for (let i = 0; i < c.n; i++) {
          const p = piecePose(c, i, c.t0 + t, a);
          expect([p.x, p.y, p.z, p.phi]).toEqual([
            c.ox[i],
            c.oy[i],
            c.oz[i],
            0,
          ]);
          expect([p.hx, p.hy, p.hz]).toEqual([c.hx[i], c.hy[i], c.hz[i]]);
        }
      }
      // Continuous: 5 ms apart, nothing jumps further than the fastest
      // debris moves in 5 ms (plus the squash's interpolation).
      const step = 5;
      for (let i = 0; i < c.n; i++) {
        piecePose(c, i, c.t0, a);
        for (let t = step; t <= c.endMs + 200; t += step) {
          piecePose(c, i, c.t0 + t, b);
          const jump = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
          expect(jump, `piece ${i} at ${t} ms`).toBeLessThan(0.6);
          expect(Math.abs(b.phi - a.phi)).toBeLessThan(0.05);
          expect(Math.abs(b.hy - a.hy)).toBeLessThan(0.3);
          Object.assign(a, b);
        }
      }
      // At rest: flat slabs on the ground (or on the slab under them),
      // inside the world, never above the building they fell from.
      const bld = city[c.building] as Building;
      for (let i = 0; i < c.n; i++) {
        const p = piecePose(c, i, Number.POSITIVE_INFINITY, a);
        expect(p.rest).toBe(true);
        const bottom = (c.ry[i] as number) - (c.ay[i] as number);
        expect(bottom).toBeGreaterThanOrEqual(-1e-9);
        if (style === "topple") expect(bottom).toBeCloseTo(0, 9);
        expect((c.ry[i] as number) + (c.ay[i] as number)).toBeLessThan(
          bld.height,
        );
        expect(c.ay[i] as number).toBeLessThan(2);
        const w = canonicalize({ x: c.x + p.x, y: p.y, z: c.z + p.z });
        expect(w.x).toBeGreaterThanOrEqual(0);
        expect(w.x).toBeLessThan(WORLD_SIZE);
        expect(w.z).toBeGreaterThanOrEqual(0);
        expect(w.z).toBeLessThan(WORLD_SIZE);
        expect(Number.isFinite(p.y)).toBe(true);
      }
      // Something actually fell: the debris reaches the ground.
      expect(c.restBounds.y0).toBeCloseTo(0, 6);
      expect(c.endMs).toBeGreaterThan(1000);
    });
  }

  it("a topple lands across the street on its weak side; a pancake inside its footprint", () => {
    const t = sampleCollapse("topple");
    const b = t.city[t.c.building] as Building;
    // Base kept midway along −x: it falls toward +x, past its own face.
    expect(t.c.dir).toBe(DIR_POS_X);
    expect(t.c.restBounds.x1).toBeGreaterThan(b.width / 2 + 10);
    const p = sampleCollapse("pancake");
    const pb = p.city[p.c.building] as Building;
    expect(p.c.restBounds.x0).toBeGreaterThanOrEqual(-pb.width / 2 - 1e-6);
    expect(p.c.restBounds.x1).toBeLessThanOrEqual(pb.width / 2 + 1e-6);
  });

  it("falling debris is solid, and lethal only while it falls", () => {
    const { c } = sampleCollapse("topple");
    const a = blankPose();
    const mid = c.t0 + 600 + c.tBreak * 1000 + 400;
    const i = c.n - 1;
    piecePose(c, i, mid, a);
    const at = { x: c.x + a.x, y: a.y, z: c.z + a.z };
    const hit = collideCollapses(at, 1, [c], mid);
    expect(hit?.falling).toBe(true);
    expect(collideCollapses(at, 1, [c], mid, true)).not.toBeNull();
    // Landed: still solid (rubble), but no longer "falling".
    piecePose(c, i, Number.POSITIVE_INFINITY, a);
    const rest = { x: c.x + a.x, y: a.y, z: c.z + a.z };
    const late = c.t0 + c.endMs + 10;
    expect(collideCollapses(rest, 0.5, [c], late)?.falling).toBe(false);
    expect(collideCollapses(rest, 0.5, [c], late, true)).toBeNull();
    // Far away: nothing.
    expect(
      collideCollapses({ x: c.x + 500, y: 50, z: c.z }, 5, [c], mid),
    ).toBeNull();
  });

  it("a record naming nothing real builds nothing", () => {
    const { city } = freshCity();
    const bogus = { id: 1, b: 99999, t: 0, s: 0, d: 0, c: [5] };
    expect(buildCollapse(city, bogus)).toBeNull();
    expect(collapseChunks({ ...bogus, c: [-1] })).toEqual([]);
  });
});
