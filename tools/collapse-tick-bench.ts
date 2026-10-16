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
// is the one-off staging of the three felled towers.
//
// C1: then the same room tick with the chaos maxed — the D5 director with
// its low-flying chaos round a human down in the canyons for the whole
// run (60 m, a staircase down the streets: an event every 2–4 s, the
// prefill warming topples, the falling cap, the recycling rule) and eleven
// bots low alongside it (every lethal pick checks each one's way out),
// for 120 s: director.tick + tickDestruction + the rebuild check, plus the
// bots' probes. A tick that simulates debris (the director's shape cache,
// a staged topple, a chained collapse) is a building tick, reported apart;
// the rest are held to the same steady p99. Exits 1 over either gate.

import {
  type Building,
  generateCity,
  tierGrids,
} from "@angels-bandits/common/city";
import { mulberry32 } from "@angels-bandits/common/city";
import {
  DIR_NEG_Z,
  DIR_POS_X,
  PANCAKE,
  TOPPLE,
  collideCollapses,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import { generateMovers } from "@angels-bandits/common/city/movers";
import {
  BLOCK_PITCH,
  CITY_SEED,
  PLAYER_RADIUS,
} from "@angels-bandits/common/constants";
import { canonicalize, wrapDeltaAxis } from "@angels-bandits/common/world";
import { applyGoneHold } from "../server/src/chaos";
import { DangerBudget } from "../server/src/danger";
import {
  type RoomCity,
  createRoomCity,
  stageCollapse,
  tickDestruction,
} from "../server/src/destruction";
import {
  DESTRUCTION_TUNING,
  DestructionDirector,
  type DestructionPlane,
} from "../server/src/director";

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

/** C1: plane `k` of the low run at `t` — a staircase down the streets at
 * 80 m/s, 60 m up (k 0 is the human; the bots fly their own, offset). */
function lowPlane(k: number, t: number): DestructionPlane {
  const s = ((t - T0) / 1000) * (80 - k);
  const leg = Math.floor(s / BLOCK_PITCH);
  const f = s - leg * BLOCK_PITCH;
  const alongZ = leg % 2 === 0;
  const pos = canonicalize({
    x: (1 + (k % 4) + Math.floor(leg / 2)) * BLOCK_PITCH + (alongZ ? 0 : f),
    y: 60 + 4 * k,
    z: (2 + (k >> 2) + Math.ceil(leg / 2)) * BLOCK_PITCH + (alongZ ? f : 0),
  });
  const v = 80 - k;
  return {
    id: k === 0 ? "human" : `bot:${k}`,
    pos,
    vel: alongZ ? { x: 0, y: 0, z: v } : { x: v, y: 0, z: 0 },
    human: k === 0,
    protected: false,
    ageMs: 0,
  };
}

const LOW_SPAN_MS = 120_000;

function runLow(): { steady: number[]; building: number[]; events: number } {
  const rc: RoomCity = createRoomCity(city, cranes, CITY_SEED, []);
  const director = new DestructionDirector(
    CITY_SEED,
    mulberry32(0xc1),
    DESTRUCTION_TUNING,
  );
  const budget = new DangerBudget();
  const world = { city: rc, cranes, budget };
  const steady: number[] = [];
  const building: number[] = [];
  let events = 0;
  const probe = { x: 0, y: 0, z: 0 };
  for (let t = T0; t <= T0 + LOW_SPAN_MS; t += TICK_MS) {
    const planes: DestructionPlane[] = [];
    for (let k = 0; k < BOTS; k++) planes.push(lowPlane(k, t));
    const sims = director.simulations;
    const began = performance.now();
    applyGoneHold(rc);
    const out = director.tick(t, planes, world);
    const d = tickDestruction(rc, t, planes);
    if (director.rebuildDue(t)) director.rebuild(t, planes, world);
    for (const p of planes) {
      probe.x = p.pos.x;
      probe.y = p.pos.y;
      probe.z = p.pos.z;
      collideCollapses(probe, PLAYER_RADIUS, rc.collapses.list, t, true);
    }
    const ms = performance.now() - began;
    events += out.warned.length;
    const built =
      director.simulations > sims ||
      d.collapses.length > 0 ||
      out.fired.some((f) => f.collapse !== null);
    (built ? building : steady).push(ms);
  }
  return { steady, building, events };
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
runLow(); // warm-up
const lowSteady: number[] = [];
const lowBuilding: number[] = [];
let lowEvents = 0;
for (let r = 1; r < RUNS; r++) {
  const res = runLow();
  lowSteady.push(...res.steady);
  lowBuilding.push(...res.building);
  lowEvents += res.events;
}
lowSteady.sort((a, b) => a - b);
lowBuilding.sort((a, b) => a - b);
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
  lowChaos: {
    ticks: lowSteady.length + lowBuilding.length,
    events: lowEvents,
    steady: {
      p50: pct(lowSteady, 0.5),
      p99: pct(lowSteady, 0.99),
      max: lowSteady.at(-1) ?? 0,
    },
    buildingTicks: {
      ticks: lowBuilding.length,
      p50: pct(lowBuilding, 0.5),
      max: lowBuilding.at(-1) ?? 0,
    },
  },
  gateP99Ms: GATE_P99_MS,
};
const ok =
  report.steady.p99 <= GATE_P99_MS && report.lowChaos.steady.p99 <= GATE_P99_MS;
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
  const lc = report.lowChaos;
  console.log(
    `C1 low chaos maxed, ${lc.ticks} ticks over ${RUNS - 1} runs, ${lc.events} events: steady tick   p50 ${f(lc.steady.p50)}   p99 ${f(lc.steady.p99)}   max ${f(lc.steady.max)}   (gate p99 ≤ ${GATE_P99_MS} ms: ${lc.steady.p99 <= GATE_P99_MS ? "ok" : "OVER"})`,
  );
  console.log(
    `C1 debris-building ticks ${lc.buildingTicks.ticks}   p50 ${f(lc.buildingTicks.p50)}   max ${f(lc.buildingTicks.max)}`,
  );
}
if (!ok) process.exit(1);
