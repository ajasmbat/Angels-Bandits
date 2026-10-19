// D10 realistic collapse, the shared model: which way a building fails
// (pancake, topple, or a wing shearing off) and how (a creep, then a crush
// front driving down faster and faster), what it breaks into (storey slabs,
// facade sheets, columns — never one 20 m cube), how the rubble lies
// (slumped oriented boxes it collides as), that the swept zone bots avoid
// covers every pose, that the whole of it is a pure function of the wire,
// and what it costs to build.

import {
  type Building,
  CUT_RUBBLE,
  CUT_STEEL,
  CityDamage,
  type TierGrid,
  chunkMask,
  generateCity,
  makeBuilding,
  mulberry32,
  solids,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  BEAT_CRUSH,
  BEAT_GIVE,
  type Collapse,
  type CollapseWire,
  DIR_POS_X,
  MODE_DROP,
  MODE_HINGE,
  PANCAKE,
  ROLE_COLUMN,
  ROLE_SHEET,
  ROLE_SLAB,
  TOPPLE,
  blankPose,
  buildCollapse,
  chunkAtCell,
  collapseFloorEvents,
  collapseWire,
  collapseZoneHit,
  collidePiece,
  demolitionPlan,
  impactScale,
  piecePose,
  planCollapses,
  standingOf,
  supportedOf,
  toppleThreshold,
} from "@angels-bandits/common/city/collapse";
import {
  CHAIN_ENERGY_MAX,
  CHAIN_ENERGY_MIN,
  CITY_SEED,
  COLLAPSE_CREEP_MS,
  COLLAPSE_FLOOR_EVENTS_MAX,
  COLLAPSE_LEAD_MS,
  COLLAPSE_PIECES_PER_SOLID,
  COLLAPSE_SHEET_THICK,
  COLLAPSE_SLAB_STOREY,
  COLLAPSE_SYMMETRY,
  COLLAPSE_TOPPLE_MAX_SPAN,
  STREET_WIDTH,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";

const SEED_CITY = generateCity(CITY_SEED);

function freshCity(): { city: Building[]; damage: CityDamage } {
  const city = SEED_CITY.map((b) => makeBuilding({ ...b, damage: undefined }));
  const damage = new CityDamage();
  damage.bind(city);
  return { city, damage };
}

const grid0 = (b: Building): TierGrid => {
  const g = tierGrids(b)[0];
  if (!g) throw new Error("no grid");
  return g;
};

/** The tallest plain towers of the seed city (no holes), tallest first. */
const TALL = SEED_CITY.map((b, i) => [b, i] as const)
  .filter(([b]) => !b.holes && grid0(b).ny >= 3)
  .sort((a, b) => b[0].height - a[0].height)
  .map(([, i]) => i);
/** T1: ...of them, the ones short enough to topple (a supertall's section,
 * over COLLAPSE_TOPPLE_MAX_SPAN, always pancakes). */
const TOPPLERS = TALL.filter(
  (i) => (SEED_CITY[i] as Building).height <= COLLAPSE_TOPPLE_MAX_SPAN,
);

/** A building whose whole tier-0 band `band` is shot away, settled. */
function cutBand(
  index: number,
  band: number,
): { city: Building[]; damage: CityDamage; b: Building } {
  const { city, damage } = freshCity();
  const b = city[index] as Building;
  const g = grid0(b);
  const ids: number[] = [];
  for (let iz = 0; iz < g.nz; iz++)
    for (let ix = 0; ix < g.nx; ix++)
      ids.push(chunkAtCell(b, index, 0, ix, band, iz));
  damage.apply(ids);
  return { city, damage, b };
}

/** The single-tier building whose +x wing a vertical slot one column in
 * (plus the wing's base) leaves hanging: it shears off. */
function shearCase(): {
  city: Building[];
  damage: CityDamage;
  b: Building;
  index: number;
} {
  for (const index of SEED_CITY.keys()) {
    const s = SEED_CITY[index] as Building;
    const g = tierGrids(s)[0];
    if (!g || s.holes || tierGrids(s).length !== 1) continue;
    // T1: a wing a supertall's height pancakes; only a shorter one shears.
    if (s.height > COLLAPSE_TOPPLE_MAX_SPAN) continue;
    if (g.nx < 4 || g.ny < 4 || g.nz < 3) continue;
    const { city, damage } = freshCity();
    const b = city[index] as Building;
    const ids: number[] = [];
    for (let iy = 0; iy < g.ny; iy++)
      for (let iz = 0; iz < g.nz; iz++)
        ids.push(chunkAtCell(b, index, 0, g.nx - 2, iy, iz));
    for (let iz = 0; iz < g.nz; iz++)
      ids.push(chunkAtCell(b, index, 0, g.nx - 1, 0, iz));
    damage.apply(ids);
    return { city, damage, b, index };
  }
  throw new Error("no shear candidate in the seed city");
}

const wireOf = (
  plan: NonNullable<ReturnType<typeof demolitionPlan>>,
  i: number,
  id = 7,
  t = 50_000,
): CollapseWire => collapseWire(plan, i, id, t);

describe("D10 structural failure: which way a building goes", () => {
  it("slenderness scales the topple threshold (clamp(3 / s, 0.5, 1.5))", () => {
    const g = { width: 20, depth: 30 } as TierGrid;
    expect(toppleThreshold(g, 60)).toBeCloseTo(COLLAPSE_SYMMETRY, 12); // s = 3
    expect(toppleThreshold(g, 120)).toBeCloseTo(COLLAPSE_SYMMETRY * 0.5, 12);
    expect(toppleThreshold(g, 600)).toBeCloseTo(COLLAPSE_SYMMETRY * 0.5, 12);
    expect(toppleThreshold(g, 20)).toBeCloseTo(COLLAPSE_SYMMETRY * 1.5, 12);
    expect(toppleThreshold(g, 30)).toBeCloseTo(COLLAPSE_SYMMETRY * 1.5, 12);
  });

  it("a band shot away mid-height pancakes from there: the wire carries the failure height", () => {
    const index = TOPPLERS[0] as number;
    const g = grid0(SEED_CITY[index] as Building);
    const band = Math.floor(g.ny / 2);
    const { b } = cutBand(index, band);
    const plan = planCollapses(b, index)[0];
    if (!plan) throw new Error("no plan");
    expect(plan.style).toBe(PANCAKE);
    // The section above the shot-out band let go at that band's top…
    expect(plan.fail).toBeCloseTo(g.baseY + (band + 1) * g.ch, 6);
    const wire = wireOf(plan, index);
    expect(wire.f).toBe(Math.round(plan.fail * 10));
    // …and a topple pivots on its base: no failure height on the wire.
    const t = demolitionPlan(b, index, TOPPLE, DIR_POS_X);
    if (!t) throw new Error("no topple");
    expect(wireOf(t, index).f).toBeUndefined();
    // D5 demolitions go through the same planner and carry it too.
    const d = demolitionPlan(b, index, PANCAKE, 0);
    if (!d) throw new Error("no demolition");
    expect(d.fail).toBeCloseTo(g.baseY + g.ch, 6);
  });

  it("a wing with open air outside it shears off; the rest stands and owes nothing", () => {
    const { city, damage, b, index } = shearCase();
    const plans = planCollapses(b, index);
    const shear = plans.find((p) => p.style === TOPPLE);
    if (!shear) throw new Error(`no shear on ${index}`);
    expect(shear.dir).toBe(DIR_POS_X);
    for (const p of plans) damage.collapse(p.chunks);
    // What stays is held up, and owes no further collapse.
    expect(planCollapses(b, index)).toEqual([]);
    const standing = standingOf(b);
    const S = supportedOf(b, standing);
    standing.forEach((st, k) => {
      for (let c = 0; c < st.length; c++) if (st[c]) expect(S[k]?.[c]).toBe(1);
    });
    expect(standing.some((st) => st.includes(1))).toBe(true);
    // Its debris never passes through what still stands, and rests out in
    // the street past the face it sheared off.
    const c = buildCollapse(city, wireOf(shear, index));
    if (!c) throw new Error("no debris");
    // What still stands — not the rubble piles its broken base left on the
    // street (T1: this seed's case has some where its wing lands).
    const stump = solids(b).filter(
      (s) => s.baseY < b.height && s.cut !== CUT_RUBBLE,
    );
    const pose = blankPose();
    for (let i = 0; i < c.n; i++) {
      for (let t = 0; t <= c.endMs; t += 50) {
        piecePose(c, i, c.t0 + t, pose);
        for (const s of stump) {
          // The piece's centre never enters a standing solid (shrunk 0.5 m).
          const inside =
            Math.abs(pose.x - s.dx) < s.width / 2 - 0.5 &&
            Math.abs(pose.z - s.dz) < s.depth / 2 - 0.5 &&
            pose.y > s.baseY + 0.5 &&
            pose.y < s.baseY + s.height - 0.5;
          if (inside) expect.fail(`piece ${i} at ${t} ms is inside a stump`);
        }
      }
      expect((c.rx[i] as number) - (c.ax[i] as number)).toBeGreaterThan(
        c.px - 1e-6,
      );
      expect((c.ry[i] as number) - (c.ay[i] as number)).toBeCloseTo(0, 9);
    }
  });
});

/** A pancake from a mid-height band of the tallest tower. */
function midPancake(): Collapse {
  const index = TALL[0] as number;
  const g = grid0(SEED_CITY[index] as Building);
  const { city, b } = cutBand(index, Math.floor(g.ny / 2));
  const plan = planCollapses(b, index)[0];
  if (!plan) throw new Error("no plan");
  const c = buildCollapse(city, wireOf(plan, index));
  if (!c) throw new Error("no debris");
  return c;
}

describe("D10 progressive collapse: a creep, then a crush front", () => {
  it("nothing moves through the lead and the creep; then the upper block lets go together", () => {
    const c = midPancake();
    const release = (COLLAPSE_LEAD_MS + COLLAPSE_CREEP_MS) / 1000;
    const pose = blankPose();
    for (const t of [0, COLLAPSE_LEAD_MS, COLLAPSE_LEAD_MS + 400]) {
      for (let i = 0; i < c.n; i++) {
        piecePose(c, i, c.t0 + t, pose);
        expect([pose.x, pose.y, pose.z, pose.phi]).toEqual([
          c.ox[i],
          c.oy[i],
          c.oz[i],
          0,
        ]);
      }
    }
    let upper = 0;
    for (let i = 0; i < c.n; i++) {
      const bottom = (c.oy[i] as number) - (c.hy[i] as number);
      if (bottom >= c.fail - 1e-6) {
        upper++;
        expect(c.start[i]).toBeCloseTo(release, 12);
        expect(c.v0[i]).toBe(0);
      } else {
        expect(c.start[i] as number).toBeGreaterThanOrEqual(release);
      }
    }
    expect(upper).toBeGreaterThan(0);
  });

  it("the storeys under the failure give way one after another, faster and faster", () => {
    const c = midPancake();
    // The start of each crushed storey (by its top height), top-down.
    const byTop = new Map<number, number>();
    for (let i = 0; i < c.n; i++) {
      if (c.role[i] !== ROLE_SLAB) continue;
      const top = (c.oy[i] as number) + (c.hy[i] as number);
      if (top > c.fail + 1e-6) continue;
      const key = Math.round(top * 100);
      const was = byTop.get(key);
      if (was !== undefined) expect(c.start[i]).toBeCloseTo(was, 9);
      else byTop.set(key, c.start[i] as number);
    }
    const storeys = [...byTop].sort((a, b) => b[0] - a[0]);
    expect(storeys.length).toBeGreaterThan(5);
    let gap = Number.POSITIVE_INFINITY;
    for (let k = 1; k < storeys.length; k++) {
      const [topA, tA] = storeys[k - 1] as [number, number];
      const [topB, tB] = storeys[k] as [number, number];
      expect(topB).toBeLessThan(topA);
      expect(tB).toBeGreaterThan(tA); // lower storeys go later…
      const perMetre = (tB - tA) / ((topA - topB) / 100);
      expect(perMetre).toBeLessThan(gap + 1e-9); // …at a quickening pace
      gap = perMetre;
    }
  });

  it("the column never passes through itself: each crushed storey's top rides the slab above it down", () => {
    const c = midPancake();
    const a = blankPose();
    const b = blankPose();
    let pairs = 0;
    for (let j = 0; j < c.n; j++) {
      if (c.role[j] !== ROLE_SLAB || (c.crush[j] as number) <= 0) continue;
      // The slab right above it in its column (a sheet-shed slab is 2 m
      // narrower: over it, not centred on it).
      let up = -1;
      for (let i = 0; i < c.n; i++) {
        if (c.role[i] !== ROLE_SLAB || i === j) continue;
        if ((c.oy[i] as number) <= (c.oy[j] as number)) continue;
        if (
          Math.abs((c.ox[i] as number) - (c.ox[j] as number)) >=
            (c.hx[i] as number) + (c.hx[j] as number) - 1e-6 ||
          Math.abs((c.oz[i] as number) - (c.oz[j] as number)) >=
            (c.hz[i] as number) + (c.hz[j] as number) - 1e-6
        )
          continue;
        if (up < 0 || (c.oy[i] as number) < (c.oy[up] as number)) up = i;
      }
      if (up < 0) continue;
      pairs++;
      const from = c.t0 + (c.start[j] as number) * 1000;
      const to =
        c.t0 +
        Math.min(
          (c.start[j] as number) + (c.land[j] as number),
          (c.start[up] as number) + (c.land[up] as number),
        ) *
          1000;
      // Before the block reaches it: the slab above never dips into it…
      for (let t = c.t0; t < from; t += 131) {
        piecePose(c, j, t, a);
        piecePose(c, up, t, b);
        expect(b.y - b.hy).toBeGreaterThanOrEqual(a.y + a.hy - 1e-6);
      }
      // …and from then on they move as one: contact, never overlap.
      for (let t = from; t < to; t += 37) {
        piecePose(c, j, t, a);
        piecePose(c, up, t, b);
        expect(b.y - b.hy).toBeCloseTo(a.y + a.hy, 6);
      }
      // Crushed flat before it hits the floor (the storey on the ground is
      // crushed where it stands, in the squash).
      if ((c.land[j] as number) > 0) {
        piecePose(c, j, to - 1, a);
        expect(a.hy).toBeCloseTo(c.chy[j] as number, 6);
      }
    }
    expect(pairs).toBeGreaterThan(10);
  });

  it("the tallest tower comes down in 8–14 s, pancaked or toppled; beats stay within the cap", () => {
    const index = TALL[0] as number;
    const { city } = freshCity();
    const b = city[index] as Building;
    for (const style of [PANCAKE, TOPPLE] as const) {
      const plan = demolitionPlan(b, index, style, DIR_POS_X);
      if (!plan) throw new Error("no plan");
      const c = buildCollapse(city, wireOf(plan, index));
      if (!c) throw new Error("no debris");
      expect(b.height).toBeGreaterThanOrEqual(220);
      expect(c.endMs).toBeGreaterThan(8000);
      expect(c.endMs).toBeLessThan(14_000);
      const beats = collapseFloorEvents(c);
      expect(beats.length).toBeGreaterThan(2);
      expect(beats.length).toBeLessThanOrEqual(COLLAPSE_FLOOR_EVENTS_MAX);
      for (let k = 1; k < beats.length; k++) {
        expect((beats[k] as { t: number }).t).toBeGreaterThanOrEqual(
          (beats[k - 1] as { t: number }).t,
        );
      }
      expect(Math.max(...beats.map((e) => e.size))).toBe(1);
      if (style === PANCAKE) {
        expect(beats[0]?.kind).toBe(BEAT_GIVE);
      }
    }
    // A failure high up crushes storey after storey: those are its beats.
    const mid = collapseFloorEvents(midPancake());
    expect(mid.filter((e) => e.kind === BEAT_CRUSH).length).toBeGreaterThan(2);
  });

  it("a topple bends as it swings: its top breaks off first, its base at the D3 angle", () => {
    const index = TOPPLERS[0] as number;
    const { city, b } = cutBand(index, 0);
    const plan = demolitionPlan(b, index, TOPPLE, DIR_POS_X);
    if (!plan) throw new Error("no plan");
    const c = buildCollapse(city, wireOf(plan, index));
    if (!c) throw new Error("no debris");
    let low = -1;
    let high = -1;
    for (let i = 0; i < c.n; i++) {
      expect(c.mode[i]).toBe(MODE_HINGE);
      if (low < 0 || (c.oy[i] as number) < (c.oy[low] as number)) low = i;
      if (high < 0 || (c.oy[i] as number) > (c.oy[high] as number)) high = i;
    }
    expect(c.hbreak[high] as number).toBeLessThan(c.hbreak[low] as number);
    expect(c.tBreak).toBeCloseTo(Math.max(...Array.from(c.hbreak)), 12);
  });
});

describe("D10 fragments: slabs, sheets and columns, not cubes", () => {
  const index = TALL[1] as number;
  const { city, b } = cutBand(index, 0);
  const plan = demolitionPlan(b, index, PANCAKE, 0);
  if (!plan) throw new Error("no plan");
  const c = buildCollapse(city, wireOf(plan, index)) as Collapse;

  it("every chunk breaks into storey slabs (3–5 m), maybe a sheet and a column — at most 5 per solid", () => {
    const perChunk = new Map<number, number>();
    for (let i = 0; i < c.n; i++) {
      perChunk.set(
        c.chunk[i] as number,
        (perChunk.get(c.chunk[i] as number) ?? 0) + 1,
      );
      if (c.role[i] === ROLE_SLAB) {
        const h = 2 * (c.hy[i] as number);
        expect(h).toBeGreaterThan(COLLAPSE_SLAB_STOREY * 0.6);
        expect(h).toBeLessThan(COLLAPSE_SLAB_STOREY * 1.5);
      }
    }
    for (const n of perChunk.values()) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(COLLAPSE_PIECES_PER_SOLID);
    }
    // Nothing falls as a whole 12 m chunk any more.
    let biggest = 0;
    for (let i = 0; i < c.n; i++) {
      if (c.role[i] === ROLE_SLAB)
        biggest = Math.max(biggest, c.hy[i] as number);
    }
    expect(2 * biggest).toBeLessThan(12);
    const roles = new Set(Array.from(c.role));
    expect(roles).toEqual(new Set([ROLE_SLAB, ROLE_SHEET, ROLE_COLUMN]));
  });

  it("sheets come off the building's outline, 2 m thick, and land in the street — never across it", () => {
    const g = grid0(b);
    let sheets = 0;
    for (let i = 0; i < c.n; i++) {
      if (c.role[i] !== ROLE_SHEET) continue;
      sheets++;
      const hx = c.hx[i] as number;
      const hz = c.hz[i] as number;
      expect(Math.min(hx, hz) * 2).toBeCloseTo(COLLAPSE_SHEET_THICK, 9);
      const onX = hx < hz;
      const face = onX
        ? Math.abs(c.ox[i] as number) + hx
        : Math.abs(c.oz[i] as number) + hz;
      expect(face).toBeCloseTo(onX ? g.width / 2 : g.depth / 2, 6);
      // At rest: out past the face, inside the street.
      const out = onX
        ? Math.abs(c.rx[i] as number) - (c.ax[i] as number)
        : Math.abs(c.rz[i] as number) - (c.az[i] as number);
      const far = onX
        ? Math.abs(c.rx[i] as number) + (c.ax[i] as number)
        : Math.abs(c.rz[i] as number) + (c.az[i] as number);
      expect(out).toBeGreaterThanOrEqual(face - 1e-6);
      expect(far).toBeLessThanOrEqual(face + STREET_WIDTH);
    }
    expect(sheets).toBeGreaterThan(0);
  });

  it("columns are steel, and stand proud of the pile as leaning stubs", () => {
    let columns = 0;
    for (let i = 0; i < c.n; i++) {
      if (c.role[i] !== ROLE_COLUMN) continue;
      columns++;
      expect((c.cut[i] as number) & CUT_STEEL).toBe(CUT_STEEL);
      expect(c.mode[i]).toBe(MODE_DROP);
      const lean = Math.abs(c.rphi[i] as number);
      expect(lean).toBeGreaterThan(0.1);
      expect(c.rhy[i] as number).toBeGreaterThan(2);
    }
    expect(columns).toBeGreaterThan(0);
  });

  it("each piece's chip key (its own offset in its tier frame) is unique in the collapse", () => {
    const keys = new Set<string>();
    for (let i = 0; i < c.n; i++) {
      keys.add(
        `${c.tier[i]}|${c.ox[i]}|${(c.oy[i] as number) - (c.hy[i] as number)}|${c.oz[i]}`,
      );
    }
    expect(keys.size).toBe(c.n);
  });
});

describe("D10 ruins: slumped rubble that collides as it is drawn", () => {
  it("every rest piece is an oriented box: just inside collides, just outside does not", () => {
    const c = midPancake();
    const rand = mulberry32(0xd10);
    let slumped = 0;
    for (let n = 0; n < 200; n++) {
      const i = Math.floor(rand() * c.n);
      const axis = c.axis[i] as number;
      const phi = c.rphi[i] as number;
      if (Math.abs(phi % (Math.PI / 2)) > 1e-3) slumped++;
      const h = [c.rhx[i], c.rhy[i], c.rhz[i]] as number[];
      for (const scale of [0.97, 1.03]) {
        // A point on a local face (each axis in turn), rotated as the piece.
        for (let a = 0; a < 3; a++) {
          const l = [0, 0, 0];
          l[a] = (h[a] as number) * scale * (rand() < 0.5 ? -1 : 1);
          const cs = Math.cos(phi);
          const sn = Math.sin(phi);
          const [lx, ly, lz] = l as [number, number, number];
          const wx = axis === 1 ? lx * cs - ly * sn : lx;
          const wy = axis === 1 ? lx * sn + ly * cs : ly * cs - lz * sn;
          const wz = axis === 1 ? lz : ly * sn + lz * cs;
          const at = {
            x: c.x + (c.rx[i] as number) + wx,
            y: (c.ry[i] as number) + wy,
            z: c.z + (c.rz[i] as number) + wz,
          };
          expect(
            collidePiece(c, i, at, 0.001, Number.POSITIVE_INFINITY),
            `piece ${i} axis ${a} × ${scale}`,
          ).toBe(scale < 1);
        }
      }
    }
    expect(slumped).toBeGreaterThan(100);
  });

  it("seeded fuzz: every collapse's rubble rests on its floor, inside its AABB, and nothing is left floating", () => {
    const { city, damage } = freshCity();
    const rand = mulberry32(0xd10f);
    let built = 0;
    for (let trial = 0; trial < 30; trial++) {
      const i = Math.floor(rand() * city.length);
      const b = city[i] as Building;
      const share = 0.15 + 0.5 * rand();
      chunkMask(b).forEach((mask, k) => {
        for (let cell = 0; cell < mask.length; cell++) {
          if (mask[cell] && rand() < share) {
            damage.destroyChunk(chunkAtCellId(b, i, k, cell));
          }
        }
      });
      for (const plan of planCollapses(b, i)) {
        damage.collapse(plan.chunks);
        const c = buildCollapse(city, wireOf(plan, i, trial));
        if (!c) continue;
        built++;
        for (let p = 0; p < c.n; p++) {
          const bottom = (c.ry[p] as number) - (c.ay[p] as number);
          expect(bottom).toBeGreaterThanOrEqual(-1e-9);
          // A topple's rubble (and a sheet) rests on the ground.
          if (c.style === TOPPLE || c.role[p] === ROLE_SHEET) {
            expect(bottom).toBeCloseTo(0, 9);
          }
          const r = c.restBounds;
          expect(c.rx[p] as number).toBeGreaterThanOrEqual(r.x0);
          expect(c.rx[p] as number).toBeLessThanOrEqual(r.x1);
        }
      }
      expect(planCollapses(b, i)).toEqual([]);
    }
    expect(built).toBeGreaterThan(10);
  });
});

/** chunkId by (tier, cell) — the grid helper takes (ix, iy, iz). */
function chunkAtCellId(b: Building, i: number, k: number, cell: number) {
  const g = tierGrids(b)[k] as TierGrid;
  const ix = cell % g.nx;
  const iz = Math.floor(cell / g.nx) % g.nz;
  const iy = Math.floor(cell / (g.nx * g.nz));
  return chunkAtCell(b, i, k, ix, iy, iz);
}

describe("D10 the zone bots avoid covers every pose of the debris", () => {
  for (const style of [PANCAKE, TOPPLE] as const) {
    it(`${style === PANCAKE ? "pancake" : "topple"}: every corner of every piece, every 50 ms, is in its swept bounds`, () => {
      const index = TALL[2] as number;
      const { city, b } = cutBand(index, 0);
      const plan = demolitionPlan(b, index, style, DIR_POS_X);
      if (!plan) throw new Error("no plan");
      const c = buildCollapse(city, wireOf(plan, index)) as Collapse;
      const pose = blankPose();
      const box = c.bounds;
      for (let i = 0; i < c.n; i += 2) {
        for (let t = 0; t <= c.endMs + 100; t += 50) {
          piecePose(c, i, c.t0 + t, pose);
          const r = Math.hypot(pose.hx, pose.hy, pose.hz);
          expect(pose.x - r).toBeGreaterThanOrEqual(box.x0 - 1e-6);
          expect(pose.x + r).toBeLessThanOrEqual(box.x1 + 1e-6);
          expect(pose.y + r).toBeLessThanOrEqual(box.y1 + 1e-6);
          expect(pose.z - r).toBeGreaterThanOrEqual(box.z0 - 1e-6);
          expect(pose.z + r).toBeLessThanOrEqual(box.z1 + 1e-6);
          const at = { x: c.x + pose.x, y: pose.y, z: c.z + pose.z };
          expect(collapseZoneHit(at, 0, [c], c.t0 + t)).toBe(true);
        }
      }
    });
  }
});

describe("D10 chain energy", () => {
  it("scales with the striking mass and speed, clamped to [MIN, MAX]", () => {
    expect(impactScale(0, 0)).toBe(CHAIN_ENERGY_MIN);
    expect(impactScale(1600, 1)).toBe(CHAIN_ENERGY_MIN);
    expect(impactScale(4800, 1e4)).toBe(CHAIN_ENERGY_MAX);
    let last = 0;
    for (const v of [5, 10, 15, 20, 25]) {
      const e = impactScale(1600, v);
      expect(e).toBeGreaterThanOrEqual(last);
      last = e;
    }
    expect(impactScale(1600, 30)).toBeCloseTo(1, 6); // √1600 · 30 = REF
  });
});

describe("D10 determinism and cost", () => {
  /** FNV-1a over every number a Collapse holds. */
  function digest(c: Collapse): string {
    let h = 0x811c9dc5;
    const feed = (v: number) => {
      const s = v.toString();
      for (let k = 0; k < s.length; k++) {
        h ^= s.charCodeAt(k);
        h = Math.imul(h, 0x01000193);
      }
    };
    for (const [k, v] of Object.entries(c)) {
      feed(k.length);
      if (typeof v === "number") feed(v);
      else if (ArrayBuffer.isView(v)) {
        for (const x of Array.from(v as unknown as ArrayLike<number>)) {
          feed(x);
        }
      } else if (Array.isArray(v)) for (const x of v) feed(x as number);
      else if (v && typeof v === "object") {
        for (const x of Object.values(v)) feed(x as number);
      }
    }
    return (h >>> 0).toString(16);
  }

  it("a wire builds the same debris on every side, from a JSON round trip, in any order", () => {
    const index = TALL[3] as number;
    const { city, b } = cutBand(index, 0);
    const plans = [
      demolitionPlan(b, index, PANCAKE, 0),
      demolitionPlan(b, index, TOPPLE, DIR_POS_X),
    ];
    for (const plan of plans) {
      if (!plan) throw new Error("no plan");
      const wire = wireOf(plan, index);
      // "server" and "client": separate cities, separate builds.
      const server = buildCollapse(city, wire) as Collapse;
      const client = buildCollapse(
        freshCity().city,
        JSON.parse(JSON.stringify(wire)),
      ) as Collapse;
      expect(digest(client)).toBe(digest(server));
      expect(collapseFloorEvents(client)).toEqual(collapseFloorEvents(server));
    }
  });

  it("the tallest tower's debris builds inside a server tick's budget", () => {
    const { city } = freshCity();
    for (const index of TALL.slice(0, 3)) {
      const b = city[index] as Building;
      for (const style of [PANCAKE, TOPPLE] as const) {
        const plan = demolitionPlan(b, index, style, DIR_POS_X);
        if (!plan) throw new Error("no plan");
        const wire = wireOf(plan, index);
        buildCollapse(city, wire); // warm
        const t0 = performance.now();
        buildCollapse(city, wire);
        // ~10–25 ms on a loaded runner; the bound catches an order of
        // magnitude, not noise.
        expect(performance.now() - t0).toBeLessThan(250);
      }
    }
  });
});
