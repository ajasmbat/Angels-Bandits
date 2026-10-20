// DS1: the debris physics' two budgets, per quality tier.
//
//   node --import tsx tools/physics-bench.ts [--tier=high|medium|low|mobile]
//        [--runs=N] [--json]
//
// WORKER: the seed city's room with its DebrisPhysics (exactly what the sim
// worker builds), the tier's moving-body budget, the camera among the
// towers. Five towers are shot through a floor each, a second apart —
// pancakes and leans, their debris striking the neighbours — and the room
// ticks at 20 Hz for 40 s through tickDestruction (planner, chain impacts
// and the physics step: one fixed 1/20 s Rapier step a tick). The figure is
// the physics step per host tick (DebrisPhysics.lastStepMs) over every tick
// with anything moving. Budget: p99 <= PHYS_STEP_BUDGET_MS (4 ms).
//
// The world governs itself to that budget (DebrisPhysics.govern): over it,
// its moving-body budget shrinks below the tier's; well under it, it grows
// back. So a row also says how many bodies it ran — its peak, the lowest
// the governor held the budget to (the tier's own when it never had to),
// and the p99 over the ticks at >= FULL of the tier's budget, when it got
// there. A fast machine runs the tier's whole budget inside 4 ms; a slow or
// busy one runs fewer bodies, never a slower step.
//
// PAGE: the same frames ingested into a page-side PhysRegistry (what
// client/src/sim/poses.ts does with the worker's `poses`) and, per 60 Hz
// render frame, every physics piece posed and composed into its instance
// matrix — city.ts updateDebris's loop (posePieceNow → pieceMatrixAt) — so
// the figure is the main thread's pose upload. Budget: p99 <= 1 ms.
//
// Each tier runs three times (--runs=N); its row is the median run. Exits 1
// over either budget. Node, not the browser: Rapier's compat build runs the
// same WASM in both; three's matrices build without a GL context. Wall
// clock, with the process CPU alongside (it counts GC threads too). The
// machine matters — on a loaded, shared box the governor holds fewer
// bodies; the M3 numbers are the planner's.

import { chunkId, tierGrids } from "@angels-bandits/common/city";
import { generateCity } from "@angels-bandits/common/city";
import {
  type Collapse,
  KIND_BUILDING,
  blankPose,
  posePieceNow,
  setPoseClock,
} from "@angels-bandits/common/city/collapse";
import { cellIndex } from "@angels-bandits/common/city/destruction";
import { PhysRegistry } from "@angels-bandits/common/city/physpose";
import { CITY_SEED } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { pieceMatrixAt, pieceOrigin } from "../client/src/render/debris";
import {
  DebrisPhysics,
  PHYS_BUDGET,
  PHYS_STEP_BUDGET_MS,
  type PhysTier,
  initDebrisPhysics,
} from "../server/src/debris-physics";
import {
  createRoomCity,
  setRoomPhysics,
  tickDestruction,
} from "../server/src/destruction";

const args = process.argv.slice(2);
const json = args.includes("--json");
const only = args.find((a) => a.startsWith("--tier="))?.slice(7) as
  | PhysTier
  | undefined;

/** The page's budget, ms (the worker's is PHYS_STEP_BUDGET_MS). */
const PAGE_P99_MS = 1;
/** "At the max": at least this share of the budget moving. */
const FULL = 0.75;
const TICK_MS = 50;
const SECONDS = 40;

const pct = (sorted: readonly number[], q: number): number =>
  sorted.length === 0
    ? Number.NaN
    : (sorted[
        Math.min(sorted.length - 1, Math.floor(sorted.length * q))
      ] as number);

interface Row {
  tier: PhysTier;
  budget: number;
  peak: number;
  fullTicks: number;
  /** The physics step per tick at the max, ms (wall clock — the gate). */
  workerP50: number;
  workerP99: number;
  /** …and the process CPU it took (no preemption; GC threads included). */
  cpuP50: number;
  cpuP99: number;
  /** The step per busy tick (anything moving), ms — the gate. */
  busyP50: number;
  busyP99: number;
  /** The lowest the governor held the budget to (the tier's when it never
   * had to). */
  held: number;
  pageP50: number;
  pageP99: number;
  pieces: number;
}

await initDebrisPhysics();
const seedCity = generateCity(CITY_SEED);
// Five plain towers of the same block-ish neighbourhood: the first that
// qualifies and its four nearest that do.
const towers = seedCity
  .map((b, i) => ({ b, i }))
  .filter(({ b }) => {
    const g = tierGrids(b)[0];
    return !b.holes && !!g && g.nx >= 3 && g.nz >= 3 && b.height > 110;
  });
const first = towers[0];
if (!first) throw new Error("no towers");
const picked = towers
  .map((t) => ({ ...t, d: Math.hypot(t.b.x - first.b.x, t.b.z - first.b.z) }))
  .sort((a, b) => a.d - b.d)
  .slice(0, 5);
const camera = {
  x: picked.reduce((s, t) => s + t.b.x, 0) / picked.length,
  z: picked.reduce((s, t) => s + t.b.z, 0) / picked.length,
};

function run(tier: PhysTier): Row {
  const budget = PHYS_BUDGET[tier];
  const city = createRoomCity(seedCity);
  const physics = new DebrisPhysics(city, { ...camera, budget });
  // The step's CPU time (this thread's work, not the time a loaded box
  // spends running something else) alongside its wall time.
  let cpuMs = 0;
  const step = physics.step.bind(physics);
  physics.step = (now: number) => {
    const a = process.cpuUsage();
    step(now);
    const d = process.cpuUsage(a);
    cpuMs = (d.user + d.system) / 1000;
  };
  setRoomPhysics(city, physics);
  const page = new PhysRegistry();
  const pagePoses: Collapse[] = [];
  const pose = blankPose();
  const m = new THREE.Matrix4();
  let t = 1_000_000;
  const worker: number[] = [];
  const workerCpu: number[] = [];
  const busy: number[] = [];
  const pageMs: number[] = [];
  let peak = 0;
  /** The lowest the governor held the budget at while busy. */
  let held = Number.POSITIVE_INFINITY;
  let pieces = 0;
  for (let k = 0; k < (SECONDS * 1000) / TICK_MS; k++) {
    // A tower a second: a floor shot out — all of it (a pancake) or the
    // bays on one side (a lean), alternating.
    const shoot = picked[k / 20];
    if (k % 20 === 0 && shoot) {
      const g = tierGrids(shoot.b)[0];
      if (g) {
        const band = Math.min(g.ny - 2, 2);
        for (let ix = 0; ix < g.nx; ix++) {
          for (let iz = 0; iz < g.nz; iz++) {
            if (k % 40 === 0 || ix >= Math.ceil(g.nx / 3)) {
              city.damage.destroyChunk(
                chunkId(shoot.i, 0, cellIndex(g, ix, band, iz)),
              );
            }
          }
        }
      }
    }
    t += TICK_MS;
    tickDestruction(city, t);
    const active = physics.active;
    peak = Math.max(peak, active);
    if (active > 0) {
      busy.push(physics.lastStepMs);
      held = Math.min(held, physics.budget);
    }
    if (active >= FULL * budget) {
      worker.push(physics.lastStepMs);
      workerCpu.push(cpuMs);
    }
    const frame = physics.takeFrame();
    // The page: the frame as transferred, then three 60 Hz renders posing
    // every physics piece at a render clock ~100 ms behind.
    if (frame)
      page.ingest(
        frame.t,
        frame.epoch,
        frame.data.slice(),
        frame.heaps?.slice() ?? null,
      );
    pagePoses.length = 0;
    for (const c of city.collapses.list) {
      if (c.kind !== KIND_BUILDING || !c.phys) continue;
      const p = page.get(c.id, c.building);
      if (!p) continue;
      // The page's own Collapse with its poses (same pieces as the host's).
      pagePoses.push({ ...c, phys: p });
    }
    for (let r = 0; r < 3; r++) {
      const render = t - 100 + r * (TICK_MS / 3);
      const a = performance.now();
      let n = 0;
      setPoseClock(render);
      for (const c of pagePoses) {
        pieceOrigin.x = c.x;
        pieceOrigin.z = c.z;
        for (let i = 0; i < c.n; i++) {
          pieceMatrixAt(posePieceNow(c, i, pose), m);
          n++;
        }
      }
      if (n > 0) pageMs.push(performance.now() - a);
      pieces = Math.max(pieces, n);
    }
  }
  physics.dispose();
  worker.sort((a, b) => a - b);
  workerCpu.sort((a, b) => a - b);
  busy.sort((a, b) => a - b);
  pageMs.sort((a, b) => a - b);
  return {
    tier,
    budget,
    peak,
    fullTicks: worker.length,
    workerP50: pct(worker, 0.5),
    workerP99: pct(worker, 0.99),
    cpuP50: pct(workerCpu, 0.5),
    cpuP99: pct(workerCpu, 0.99),
    busyP50: pct(busy, 0.5),
    busyP99: pct(busy, 0.99),
    held: Number.isFinite(held) ? held : budget,
    pageP50: pct(pageMs, 0.5),
    pageP99: pct(pageMs, 0.99),
    pieces,
  };
}

const tiers: PhysTier[] = only ? [only] : ["high", "medium", "low", "mobile"];
/** Each tier `runs` times; a row is the run with the median step p99 (a
 * shared box's load spikes one run, not three). */
const runs = Math.max(
  1,
  Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? 3) || 3,
);
const median = (list: Row[], key: keyof Row): Row => {
  const sorted = [...list].sort(
    (a, b) => (a[key] as number) - (b[key] as number),
  );
  return sorted[Math.floor(sorted.length / 2)] as Row;
};
const rows = tiers.map((tier) => {
  const all: Row[] = [];
  for (let r = 0; r < runs; r++) all.push(run(tier));
  return {
    ...median(all, "busyP99"),
    pageP50: median(all, "pageP99").pageP50,
    pageP99: median(all, "pageP99").pageP99,
  };
});
const ms = (v: number, d = 2) => (Number.isNaN(v) ? "—" : v.toFixed(d));
let fail = false;
if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`median of ${runs} run(s) a tier; ms`);
  console.log(
    "tier    budget held peak  step p50 / p99  (cpu p99)  @max ticks / p99  page p50 / p99  pieces",
  );
  for (const r of rows) {
    console.log(
      `${r.tier.padEnd(7)} ${String(r.budget).padStart(6)} ${String(r.held).padStart(4)} ${String(r.peak).padStart(4)}  ${ms(r.busyP50).padStart(8)} / ${ms(r.busyP99).padEnd(5)}  (${ms(r.cpuP99).padStart(6)})  ${String(r.fullTicks).padStart(10)} / ${ms(r.workerP99).padEnd(5)}  ${ms(r.pageP50, 3).padStart(8)} / ${ms(r.pageP99, 3).padEnd(5)}  ${r.pieces}`,
    );
  }
}
for (const r of rows) {
  if (!(r.busyP99 <= PHYS_STEP_BUDGET_MS)) {
    console.error(
      `${r.tier}: worker step p99 ${ms(r.busyP99)} ms > ${PHYS_STEP_BUDGET_MS} ms`,
    );
    fail = true;
  }
  if (!(r.pageP99 <= PAGE_P99_MS)) {
    console.error(
      `${r.tier}: page p99 ${ms(r.pageP99, 3)} ms > ${PAGE_P99_MS} ms`,
    );
    fail = true;
  }
}
process.exit(fail ? 1 : 0);
