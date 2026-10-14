// DL1: the server's collapse tick with three tower collapses in flight at
// once — what a room pays every TICK_DOWN_HZ tick while big debris falls.
//
//   node --import tsx tools/collapse-tick-bench.ts [--json]
//
// A room city of the seed city WITH its props (cars, lamps, roof tanks…:
// what debris crushes as it lands): the three tallest plain towers are
// felled at t0 — a topple, a pancake and a topple — through the director's
// path (demolitionPlan → stageCollapse: debris, chain impacts and prop
// crushes queued). Then the room ticks at 20 Hz for 40 s: tickDestruction
// (impacts landing as D2 blasts, the planner on what they break, chained
// collapses built, props crushed, felled and repaired) plus a bot's
// collision probe per tick per bot (collideCollapses, 12 bots) sampled
// round the falling debris. Each tick is timed; four runs on fresh rooms,
// the first a warm-up (JIT), the rest pooled.
//
// The gate: the STEADY tick — every tick that does not build a new collapse
// — at p99 ≤ 1 ms. A tick that builds a chained collapse (a neighbour
// brought down by debris) carries that build — tens of ms for a tower,
// bounded per tick by COLLAPSE_BUILD_BUDGET_MS — and is reported apart, as
// is the one-off staging of the three felled towers. Exits 1 over the gate.

import {
  type Building,
  generateCity,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  DIR_NEG_Z,
  DIR_POS_X,
  PANCAKE,
  TOPPLE,
  collideCollapses,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import { generateMovers } from "@angels-bandits/common/city/movers";
import { CITY_SEED, PLAYER_RADIUS } from "@angels-bandits/common/constants";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import {
  type RoomCity,
  createRoomCity,
  stageCollapse,
  tickDestruction,
} from "../server/src/destruction";

const city = generateCity(CITY_SEED);
const { cranes } = generateMovers(CITY_SEED, city);
const T0 = 5_000_000;
const TICK_MS = 50;
const SPAN_MS = 40_000;
const BOTS = 12;
const RUNS = 4;
const GATE_P99_MS = 1;

/** The three tallest plain towers at least 300 m apart. */
const TOWERS: number[] = [];
for (const [b, i] of city
  .map((b, i) => [b, i] as const)
  .filter(([b]) => !b.holes && (tierGrids(b)[0]?.ny ?? 0) >= 4)
  .sort((a, b) => b[0].height - a[0].height)) {
  if (TOWERS.length === 3) break;
  const far = TOWERS.every((j) => {
    const o = city[j] as Building;
    return Math.hypot(wrapDeltaAxis(o.x, b.x), wrapDeltaAxis(o.z, b.z)) > 300;
  });
  if (far) TOWERS.push(i);
}
const STYLES = [
  [TOPPLE, DIR_POS_X],
  [PANCAKE, 0],
  [TOPPLE, DIR_NEG_Z],
] as const;

const pct = (sorted: number[], q: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0);

function run(): {
  stageMs: number;
  steady: number[];
  building: number[];
  chained: number;
} {
  const rc: RoomCity = createRoomCity(city, cranes, CITY_SEED, []);
  let began = performance.now();
  TOWERS.forEach((b, k) => {
    const [style, dir] = STYLES[k] as (typeof STYLES)[number];
    const plan = demolitionPlan(rc.buildings[b] as Building, b, style, dir);
    if (plan) stageCollapse(rc, plan, b, T0, null);
  });
  const stageMs = performance.now() - began;
  const steady: number[] = [];
  const building: number[] = [];
  let chained = 0;
  const probe = { x: 0, y: 0, z: 0 };
  for (let t = T0; t <= T0 + SPAN_MS; t += TICK_MS) {
    began = performance.now();
    const out = tickDestruction(rc, t);
    // Each bot's collision probe against the falling debris, round the
    // felled towers (where bots dodge — the expensive near case).
    for (let k = 0; k < BOTS; k++) {
      const b = rc.buildings[TOWERS[k % TOWERS.length] as number] as Building;
      const a = (k / BOTS) * Math.PI * 2 + t / 3000;
      probe.x = b.x + Math.cos(a) * (b.height * 0.6);
      probe.y = 20 + ((k * 37) % 160);
      probe.z = b.z + Math.sin(a) * (b.height * 0.6);
      collideCollapses(probe, PLAYER_RADIUS, rc.collapses.list, t, true);
    }
    const ms = performance.now() - began;
    if (out.collapses.length > 0) {
      building.push(ms);
      chained += out.collapses.length;
    } else steady.push(ms);
  }
  return { stageMs, steady, building, chained };
}

run(); // warm-up: the JIT, the props layout, the link caches
const steady: number[] = [];
const building: number[] = [];
const stage: number[] = [];
let chained = 0;
for (let r = 1; r < RUNS; r++) {
  const res = run();
  steady.push(...res.steady);
  building.push(...res.building);
  stage.push(res.stageMs);
  chained += res.chained;
}
steady.sort((a, b) => a - b);
building.sort((a, b) => a - b);
const report = {
  towers: TOWERS.map((i) => ({
    index: i,
    height: Math.round((city[i] as Building).height),
  })),
  ticks: steady.length + building.length,
  steady: {
    p50: pct(steady, 0.5),
    p99: pct(steady, 0.99),
    max: steady.at(-1) ?? 0,
  },
  chainedBuilds: {
    ticks: building.length,
    collapses: chained,
    p50: pct(building, 0.5),
    max: building.at(-1) ?? 0,
  },
  stagingMs: stage.reduce((a, b) => a + b, 0) / Math.max(1, stage.length),
  gateP99Ms: GATE_P99_MS,
};
const ok = report.steady.p99 <= GATE_P99_MS;
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...report, ok }, null, 2));
} else {
  const f = (v: number) => `${v.toFixed(3)} ms`;
  console.log(
    `three tower collapses at once (${report.towers.map((t) => `#${t.index} ${t.height} m`).join(", ")}), ${report.ticks} ticks over ${RUNS - 1} runs`,
  );
  console.log(
    `steady tick   p50 ${f(report.steady.p50)}   p99 ${f(report.steady.p99)}   max ${f(report.steady.max)}   (gate p99 ≤ ${GATE_P99_MS} ms: ${ok ? "ok" : "OVER"})`,
  );
  console.log(
    `chained-build ticks ${report.chainedBuilds.ticks} (${report.chainedBuilds.collapses} collapses)   p50 ${f(report.chainedBuilds.p50)}   max ${f(report.chainedBuilds.max)}`,
  );
  console.log(`staging the three felled towers: ${f(report.stagingMs)}`);
}
if (!ok) process.exit(1);
