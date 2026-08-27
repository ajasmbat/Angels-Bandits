// Server tick cost of the L2 mover probe — the ticket's named server risk.
//
//   npx tsx tools/mover-bench.ts [--json]
//
// Bot probes were the one place this ticket could plausibly hurt: blockedAlong
// runs up to ~177 collideCity samples per bot per decision in the worst case,
// and every one of them now also asks the mover field a question. So measure
// it rather than reason about it.
//
// Two scenarios, because the honest answer is different for each:
//   "spread"  — a full roster scattered over the map, which is what a real
//               room looks like. The mover broad phase rejects on two scalar
//               wrapDeltaAxis calls and the cost is nearly unmeasurable.
//   "at-site" — the whole roster dogfighting inside one crane's neighbourhood,
//               i.e. every probe sample surviving the broad phase into the
//               sphere-vs-OBB narrow phase. This is the worst case that can
//               exist, not a typical one.
//
// Each scenario is run with and without the mover field, three times, and the
// MEDIAN is reported — one run is noise on a laptop with other work on it.

import { generateCity } from "@angels-bandits/common/city";
import {
  type MoverField,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import {
  BOT_TARGET_MAX,
  CITY_SEED,
  RESPAWN_SPEED,
  TICK_DOWN_HZ,
} from "@angels-bandits/common/constants";
import type { SpawnState } from "@angels-bandits/common/protocol";
import { canonicalize } from "@angels-bandits/common/world";
import { type BotContact, RoomBots } from "../server/src/bots";

const city = generateCity(CITY_SEED);
const field = generateMovers(CITY_SEED, city);
const EMPTY: MoverField = { cranes: [], aircraft: [] };

const SECONDS = 120;
const WARMUP_TICKS = 200;
const TICKS = Math.round(SECONDS * TICK_DOWN_HZ);
const TICK_MS = 1000 / TICK_DOWN_HZ;

type Scenario = "spread" | "at-site";

function spawner(scenario: Scenario): () => SpawnState {
  let n = 0;
  if (scenario === "spread") {
    return () => {
      n++;
      return {
        pos: canonicalize({ x: (n * 137) % 2000, y: 300, z: (n * 311) % 2000 }),
        yaw: n,
        speed: RESPAWN_SPEED,
      };
    };
  }
  const site = field.cranes[0];
  if (!site) throw new Error("no crane sites to bench against");
  return () => {
    const a = (n++ / BOT_TARGET_MAX) * Math.PI * 2;
    const p = canonicalize({
      x: site.x + Math.cos(a) * 200,
      y: 0,
      z: site.z + Math.sin(a) * 200,
    });
    return {
      pos: { x: p.x, y: site.hubY, z: p.z },
      yaw: Math.atan2(Math.cos(a), Math.sin(a)),
      speed: RESPAWN_SPEED,
    };
  };
}

/** One timed run: ms per tick, excluding warm-up. */
function run(scenario: Scenario, movers: MoverField): number {
  const spawn = spawner(scenario);
  const bots = new RoomBots("room-0", 1234, city, movers);
  bots.syncTo(BOT_TARGET_MAX, spawn);

  // Every living bot is a contact for every other one, so the brain takes the
  // ENGAGE path (and therefore fanAround, the expensive probe consumer).
  const contacts = (): BotContact[] => {
    const out: BotContact[] = [];
    for (const id of bots.ids()) {
      const pose = bots.poseOf(id);
      if (pose) {
        out.push({ id, pos: pose.pos, vel: { x: 0, y: 0, z: 0 }, prot: false });
      }
    }
    return out;
  };
  const step = (i: number): void => {
    // Crashed bots MUST be respawned: a dead bot is skipped by tick(), so a
    // bench that lets the roster die measures an empty loop.
    for (const id of bots.tick(i * TICK_MS, contacts()).crashes) {
      bots.respawn(id, spawn());
    }
  };

  for (let i = 1; i <= WARMUP_TICKS; i++) step(i);
  const t0 = process.hrtime.bigint();
  for (let i = WARMUP_TICKS + 1; i <= TICKS; i++) step(i);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6 / (TICKS - WARMUP_TICKS);
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const results = [];
for (const scenario of ["spread", "at-site"] as const) {
  const without = median([0, 1, 2].map(() => run(scenario, EMPTY)));
  const withMovers = median([0, 1, 2].map(() => run(scenario, field)));
  results.push({
    scenario,
    bots: BOT_TARGET_MAX,
    withoutMoversMs: Number(without.toFixed(5)),
    withMoversMs: Number(withMovers.toFixed(5)),
    deltaMs: Number((withMovers - without).toFixed(5)),
    deltaPct: Number(((100 * (withMovers - without)) / without).toFixed(1)),
    tickBudgetMs: TICK_MS,
    budgetUsedPct: Number(((100 * withMovers) / TICK_MS).toFixed(3)),
  });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(
    `Bot tick cost, ${BOT_TARGET_MAX} bots, ${SECONDS} s sim, median of 3\n`,
  );
  for (const r of results) {
    console.log(
      `${r.scenario.padEnd(9)} without ${r.withoutMoversMs.toFixed(4)} ms/tick` +
        `  with ${r.withMoversMs.toFixed(4)} ms/tick` +
        `  delta +${r.deltaMs.toFixed(4)} ms (+${r.deltaPct}%)` +
        `  = ${r.budgetUsedPct}% of the ${r.tickBudgetMs} ms budget`,
    );
  }
}
