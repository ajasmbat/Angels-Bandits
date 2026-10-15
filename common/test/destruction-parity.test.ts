// DL1: the collapse model reads every tunable from a DestructionTuning now —
// and with DEFAULT_DESTRUCTION_TUNING it must build EXACTLY what main did.
// fixtures/collapse-legacy.ts is main's collapse.ts frozen at the commit
// DL1 branched from; these build the same wires through both and demand
// bit-equal debris (Object.is on every field of every piece), the same
// floor events, chain impacts, poses and plans — with the tuning omitted
// (as the server and every normal client call it), with the frozen
// defaults passed, and with a fresh copy of them (which takes the
// tuning-swap path). The cases walk every branch of the builder: pancakes
// with and without a crush front, topples in all four directions (the bent
// break-up, the D8 stepped stump), a shear-off, a crane, and plans off
// chewed buildings.

import {
  type Building,
  CityDamage,
  chunksOf,
  generateCity,
  makeBuilding,
  mulberry32,
} from "@angels-bandits/common/city";
import * as live from "@angels-bandits/common/city/collapse";
import { generateMovers } from "@angels-bandits/common/city/movers";
import { CITY_SEED } from "@angels-bandits/common/constants";
import {
  DEFAULT_DESTRUCTION_TUNING,
  buildStamp,
  sanitizeDestructionTuning,
} from "@angels-bandits/common/destruction-tuning";
import { describe, expect, it } from "vitest";
import * as legacy from "./fixtures/collapse-legacy";

const SEED_CITY = generateCity(CITY_SEED);
const fresh = (): Building[] =>
  SEED_CITY.map((b) => makeBuilding({ ...b, damage: undefined }));

/** A spread of the seed city: the tallest, a mid tower, small blocks, a
 * holed one, multi-tier setbacks. */
const PICKS = (() => {
  const by = SEED_CITY.map((b, i) => [b, i] as const).sort(
    (a, b) => b[0].height - a[0].height,
  );
  const out = new Set<number>();
  for (const k of [0, 1, 2, 5, 12, 30, 60, 120, 200]) {
    const e = by[Math.min(by.length - 1, k)];
    if (e) out.add(e[1]);
  }
  const holed = SEED_CITY.findIndex((b) => !!b.holes);
  if (holed >= 0) out.add(holed);
  const tiered = SEED_CITY.findIndex((b) => b.tiers.length >= 3);
  if (tiered >= 0) out.add(tiered);
  return [...out];
})();

const STYLES = [
  [live.PANCAKE, 0],
  [live.TOPPLE, live.DIR_NEG_X],
  [live.TOPPLE, live.DIR_POS_X],
  [live.TOPPLE, live.DIR_NEG_Z],
  [live.TOPPLE, live.DIR_POS_Z],
] as const;

/** Every field the frozen model has, compared bit for bit. */
function expectSame(
  a: legacy.Collapse | null,
  b: live.Collapse | null,
  at: string,
): void {
  expect(b === null, `${at}: null`).toBe(a === null);
  if (!a || !b) return;
  for (const key of Object.keys(a) as (keyof legacy.Collapse)[]) {
    const x = a[key] as unknown;
    const y: unknown = (b as unknown as Record<string, unknown>)[key];
    if (ArrayBuffer.isView(x)) {
      const xa = x as unknown as ArrayLike<number>;
      const ya = y as ArrayLike<number>;
      expect(ya.length, `${at}: ${key}.length`).toBe(xa.length);
      for (let i = 0; i < xa.length; i++) {
        if (!Object.is(xa[i], ya[i])) {
          expect.fail(`${at}: ${key}[${i}] ${ya[i]} !== ${xa[i]}`);
        }
      }
    } else if (x && typeof x === "object") {
      expect(y, `${at}: ${key}`).toEqual(x);
    } else if (!Object.is(x, y)) {
      expect.fail(`${at}: ${key} ${String(y)} !== ${String(x)}`);
    }
  }
}

/** Poses over the whole fall, both models, bit for bit. */
function expectSamePoses(
  a: legacy.Collapse,
  b: live.Collapse,
  at: string,
): void {
  const pa = legacy.blankPose();
  const pb = live.blankPose();
  const end = a.t0 + a.endMs + 200;
  for (let t = a.t0 - 100; t <= end; t += 137) {
    for (let i = 0; i < a.n; i += 3) {
      legacy.piecePose(a, i, t, pa);
      live.piecePose(b, i, t, pb);
      for (const k of Object.keys(pa) as (keyof legacy.PiecePose)[]) {
        if (!Object.is(pa[k], pb[k])) {
          expect.fail(`${at}: piece ${i} at ${t} ms: ${k}`);
        }
      }
    }
  }
}

const TUNINGS = [
  ["omitted", undefined],
  ["DEFAULT_DESTRUCTION_TUNING", DEFAULT_DESTRUCTION_TUNING],
  ["a fresh copy of the defaults", sanitizeDestructionTuning({})],
] as const;

describe("DL1 parity: the default tuning is today's collapse model", () => {
  it("covers a spread of the seed city", () => {
    expect(PICKS.length).toBeGreaterThanOrEqual(8);
  });

  it("demolitions: every pick felled every way builds bit-identical debris, events, impacts and poses", () => {
    const city = fresh();
    let built = 0;
    for (const i of PICKS) {
      const b = city[i] as Building;
      for (const [style, dir] of STYLES) {
        const pl = legacy.demolitionPlan(b, i, style, dir);
        for (const [name, t] of TUNINGS) {
          const pn = live.demolitionPlan(b, i, style, dir, t);
          expect(pn, `plan ${i}/${style}/${dir} (${name})`).toEqual(pl);
        }
        if (!pl) continue;
        const wire = legacy.collapseWire(pl, i, 7 + built, 12_345);
        const a = legacy.buildCollapse(city, wire);
        for (const [name, t] of TUNINGS) {
          const at = `building ${i} style ${style} dir ${dir} (${name})`;
          const c = live.buildCollapse(city, wire, t);
          expectSame(a, c, at);
          if (!a || !c) continue;
          expect(live.collapseFloorEvents(c), at).toEqual(
            legacy.collapseFloorEvents(a),
          );
          expect(live.collapseImpacts(c, city, t), at).toEqual(
            legacy.collapseImpacts(a, city),
          );
        }
        const c = live.buildCollapse(city, wire);
        if (a && c) expectSamePoses(a, c, `building ${i} style ${style}`);
        built++;
      }
    }
    expect(built).toBeGreaterThan(30);
  });

  it("plans off chewed buildings (pancakes with a crush front, shears, topples) match, and so does their debris", () => {
    const rnd = mulberry32(0xd11);
    let plans = 0;
    for (const i of PICKS) {
      for (const share of [0.15, 0.35, 0.6]) {
        const city = fresh();
        const damage = new CityDamage();
        damage.bind(city);
        const b = city[i] as Building;
        const ids = chunksOf(b, i).filter(() => rnd() < share);
        damage.apply(ids);
        const pl = legacy.planCollapses(b, i);
        for (const [name, t] of TUNINGS) {
          expect(
            live.planCollapses(b, i, t),
            `${i}@${share} (${name})`,
          ).toEqual(pl);
        }
        for (const [k, plan] of pl.entries()) {
          const wire = legacy.collapseWire(plan, i, 100 + k, 5_000 + k);
          expectSame(
            legacy.buildCollapse(city, wire),
            live.buildCollapse(city, wire),
            `chewed ${i}@${share} plan ${k}`,
          );
          plans++;
        }
      }
    }
    expect(plans).toBeGreaterThan(5);
  });

  it("a crane's fall builds the same lattice", () => {
    const { cranes } = generateMovers(CITY_SEED, SEED_CITY);
    expect(cranes.length).toBeGreaterThan(0);
    for (const site of cranes) {
      for (const t of [0, 4_000, 9_000]) {
        const wire = {
          id: 3,
          b: site.id,
          t,
          s: live.TOPPLE,
          d: live.craneFallDir(site, t),
          c: [],
          k: live.KIND_CRANE,
        };
        expectSame(
          legacy.buildCraneCollapse(site, wire),
          live.buildCraneCollapse(site, wire),
          `crane ${site.id} at ${t}`,
        );
      }
    }
  });

  it("a normal CollapseField ignores a stamped wire; a lab field builds from it", () => {
    const city = fresh();
    const i = PICKS[0] as number;
    const plan = live.demolitionPlan(city[i] as Building, i, live.TOPPLE, 1);
    expect(plan).not.toBeNull();
    if (!plan) return;
    const lab = sanitizeDestructionTuning({ gravity: 18, slabStorey: 8 });
    const wire = { ...live.collapseWire(plan, i, 1, 0), dt: buildStamp(lab) };
    const normal = new live.CollapseField();
    normal.bind(city);
    const plain = normal.add(wire);
    const reference = legacy.buildCollapse(city, wire);
    expectSame(reference, plain, "normal field, stamped wire");
    const labField = new live.CollapseField();
    labField.lab = true;
    labField.bind(city);
    const tuned = labField.add(wire);
    expect(tuned?.g).toBe(18);
    expect(tuned?.n).not.toBe(plain?.n);
    expect(tuned).toEqual(live.buildCollapse(city, wire, lab));
  });
});
