// A3 release gate: do the W3 rooftop AA nests share a roof cleanly with
// everything else the Carrier War batch (and before it) put up there?
//
//   node --import tsx tools/roof-seams.ts [--json] [--seed=<n>] [--inflate=<m>]
//
// Every nest of the seed city's prop layout (common/src/aa.ts aaNestsOf) is
// checked, on its own building, against what is DRAWN there — not against
// the keep-out lists that are supposed to prevent a clash, so a part that
// ignores them is caught too:
//
//  - every roof part the client draws (render/roof-details.ts
//    roofDetailsFor: R2 structure bodies and dressing, HVAC, DT2 details),
//    except the nest's own dressing, by its drawn box (partBox);
//  - the rooftop life (party, pool, fans, flags) and every other keep-out
//    in roofKeepOuts — the one seam later roof dressing steps around;
//  - every other D9 prop on that building (tanks, masts, billboards, the
//    other structures' props), by its standing box;
//  - the nest must also stand wholly on its building's top roof.
//
// A clash is any plan-view intersection with the nest's collider disc whose
// height range meets the nest's (deck to collider top). Exit 0 with none,
// 1 listing each. The gun's barrel sweep (it overhangs the collider) is
// REPORTED, not failed: a tall part inside the sweep is a part the barrels
// would swing through.
//
// `--inflate=<m>` grows every nest's disc by m: the positive control (a
// checker that is blind reports 0 too) — at 3 m it must find clashes.

import { AA_PIVOT_Y, aaNestsOf } from "@angels-bandits/common/aa";
import { type Building, generateCity } from "@angels-bandits/common/city";
import { generateProps } from "@angels-bandits/common/city/props";
import type { RoofStructure } from "@angels-bandits/common/city/roof-structures";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import {
  type RoofPart,
  partBox,
  roofDetailsFor,
  roofKeepOuts,
} from "../client/src/render/roof-details";
import { structureRect } from "../client/src/render/roof-layout";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const seedArg = args.find((a) => a.startsWith("--seed="));
const SEED = seedArg ? Number(seedArg.slice(7)) : CITY_SEED;
const inflateArg = args.find((a) => a.startsWith("--inflate="));
const INFLATE = inflateArg ? Number(inflateArg.slice(10)) : 0;

/** The barrels' reach past the pivot, m (client/src/render/aa-nests.ts:
 * light 1.9 m from 0.4 m behind it, heavy 3.6 m + a 0.35 m brake from 0.4). */
const REACH = { light: 1.5, heavy: 3.95 };
/** A plan-view contact closer than this is a clash, m (float noise). */
const EPS = 1e-6;

/** Plan-view distance from (cx, cz) to the box [x0,x1]×[z0,z1]. */
function boxGap(
  cx: number,
  cz: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): number {
  const dx = Math.max(x0 - cx, 0, cx - x1);
  const dz = Math.max(z0 - cz, 0, cz - z1);
  return Math.hypot(dx, dz);
}

interface Clash {
  nest: number;
  building: number;
  heavy: boolean;
  what: string;
  /** How far inside the collider disc, m. */
  depth: number;
}

const city: Building[] = generateCity(SEED);
const layout = generateProps(SEED, city);
const nests = aaNestsOf(layout);
const clashes: Clash[] = [];
const sweeps: Clash[] = [];
let partsChecked = 0;

for (const n of nests) {
  const b = city[n.b] as Building;
  const nestS = (b.roof ?? []).find(
    (s: RoofStructure) => s.kind === "aaNest",
  ) as RoofStructure | undefined;
  const fail = (what: string, depth: number) =>
    clashes.push({ nest: n.id, building: n.b, heavy: n.heavy, what, depth });
  if (!nestS) {
    fail("no aaNest roof structure on its building", 0);
    continue;
  }
  // The nest in its building's frame (x/z from the centre, y from the ground).
  const cx = nestS.dx;
  const cz = nestS.dz;
  const r = nestS.width / 2 + INFLATE;
  const deck = b.height;
  const top = deck + nestS.height;
  const pivot =
    deck + (n.heavy ? (AA_PIVOT_Y[1] as number) : (AA_PIVOT_Y[0] as number));
  const reach = n.heavy ? REACH.heavy : REACH.light;

  // On its roof: the whole disc inside the top tier.
  const tier = b.tiers[b.tiers.length - 1];
  if (
    !tier ||
    Math.abs(cx) + r > tier.width / 2 + EPS ||
    Math.abs(cz) + r > tier.depth / 2 + EPS
  ) {
    fail("overhangs its top roof", 0);
  }

  // Every drawn roof part except the nest's own dressing.
  const d = roofDetailsFor(b);
  const parts: [RoofPart, boolean][] = [
    ...d.boxes.map((p): [RoofPart, boolean] => [p, false]),
    ...d.cylinders.map((p): [RoofPart, boolean] => [p, true]),
    ...d.lit.map((p): [RoofPart, boolean] => [p, false]),
  ];
  for (const [p, cyl] of parts) {
    if (p.structure === nestS) continue;
    partsChecked++;
    const box = partBox(b, p, cyl);
    const gap = boxGap(cx, cz, box.x0, box.x1, box.z0, box.z1);
    const kind = p.structure ? `${p.structure.kind} part` : "roof detail";
    if (gap < r - EPS && box.y1 > deck + EPS && box.y0 < top - EPS) {
      fail(`${kind} (drawn box)`, r - gap);
    } else if (gap < reach && box.y1 > pivot - 0.3) {
      sweeps.push({
        nest: n.id,
        building: n.b,
        heavy: n.heavy,
        what: `${kind} in the barrel sweep`,
        depth: reach - gap,
      });
    }
  }

  // Every keep-out but the nest's own rect (rooftop life, R2/DT2 claims).
  const own = structureRect(b, nestS);
  for (const k of roofKeepOuts(b)) {
    if (
      Math.abs(k.x - own.x) < EPS &&
      Math.abs(k.z - own.z) < EPS &&
      Math.abs(k.hw - own.hw) < EPS &&
      Math.abs(k.hd - own.hd) < EPS
    ) {
      continue;
    }
    const kx = wrapDeltaAxis(b.x, k.x);
    const kz = wrapDeltaAxis(b.z, k.z);
    const gap = boxGap(cx, cz, kx - k.hw, kx + k.hw, kz - k.hd, kz + k.hd);
    if (gap < r - EPS) fail("roof keep-out (life / detail claim)", r - gap);
  }

  // Every other D9 prop on this building.
  for (const q of layout.props) {
    if (q.b !== n.b || q.id === n.id) continue;
    const qx = wrapDeltaAxis(b.x, q.x);
    const qz = wrapDeltaAxis(b.z, q.z);
    const gap = boxGap(cx, cz, qx - q.hx, qx + q.hx, qz - q.hz, qz + q.hz);
    const y0 = q.y - q.hy;
    const y1 = q.y + q.hy;
    if (gap < r - EPS && y1 > deck + EPS && y0 < top - EPS) {
      fail(`D9 prop kind ${q.kind}`, r - gap);
    }
  }
}

const report = {
  seed: SEED,
  buildings: city.length,
  nests: nests.length,
  heavy: nests.filter((n) => n.heavy).length,
  partsChecked,
  clashes,
  sweeps,
};
if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `roof seams (seed ${SEED}): ${nests.length} AA nests (${report.heavy} heavy) on ${city.length} buildings; ${partsChecked} drawn roof parts checked`,
  );
  for (const c of clashes) {
    console.log(
      `  CLASH nest ${c.nest} (bldg ${c.building}, ${c.heavy ? "heavy" : "light"}): ${c.what}, ${c.depth.toFixed(2)} m inside`,
    );
  }
  for (const s of sweeps) {
    console.log(
      `  sweep nest ${s.nest} (bldg ${s.building}, ${s.heavy ? "heavy" : "light"}): ${s.what}, ${s.depth.toFixed(2)} m inside the reach`,
    );
  }
  console.log(
    clashes.length === 0
      ? `PASS: 0 clashes (${sweeps.length} barrel-sweep contacts, reported only)`
      : `FAIL: ${clashes.length} clash(es)`,
  );
}
process.exit(clashes.length === 0 ? 0 : 1);
