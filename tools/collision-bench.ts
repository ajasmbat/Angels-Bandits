// What D2 breakable buildings cost the shared collision path — the seam every
// bot probe, crash check and sight line goes through.
//
//   npx tsx tools/collision-bench.ts [--json]
//
// A fixed probe set (seeded) over the seed city, three ways:
//   "intact"     — the seed city as generated (compare with main by running
//                  this file against main's common/: only this scenario
//                  exists there);
//   "damaged-5"  — a room clone with 5% of its chunks destroyed;
//   "damaged-20" — 20%: most buildings fragmented, rubble everywhere.
// Each scenario reports ns per collideCity (indexed, the bots' and the
// client's path), ns per losClear (the bot brain's sight line), and heap
// growth per call — both must stay allocation-free (O5). Three runs, MEDIAN
// reported. These are reported numbers, not gates.

import {
  type Building,
  CityDamage,
  chunksOf,
  generateCity,
  makeBuilding,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  buildCityIndex,
  collideCity,
  losClear,
} from "@angels-bandits/common/collision";
import { CITY_SEED, WORLD_SIZE } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";

const seed = generateCity(CITY_SEED);

function damagedCity(share: number): Building[] {
  const copy = seed.map((b) => makeBuilding({ ...b, damage: undefined }));
  const damage = new CityDamage();
  damage.bind(copy);
  const rand = mulberry32(2026);
  copy.forEach((b, i) => {
    for (const id of chunksOf(b, i))
      if (rand() < share) damage.destroyChunk(id);
  });
  return copy;
}

// Probes where bots live: street canyons and rooftops, 10–150 m up.
const rand = mulberry32(7);
const probes: Vec3[] = Array.from({ length: 4096 }, () => ({
  x: rand() * WORLD_SIZE,
  y: 10 + rand() * 140,
  z: rand() * WORLD_SIZE,
}));
// Sight lines up to ~300 m (inside BOT_DETECT_RANGE).
const sights: [Vec3, Vec3][] = Array.from({ length: 1024 }, (_, i) => {
  const a = probes[i] as Vec3;
  const ang = rand() * Math.PI * 2;
  const r = 50 + rand() * 250;
  return [
    a,
    {
      x: a.x + Math.cos(ang) * r,
      y: 10 + rand() * 140,
      z: a.z + Math.sin(ang) * r,
    },
  ];
});

interface Row {
  scenario: string;
  collideNs: number;
  losNs: number;
  collideBytes: number;
  losBytes: number;
}

function measure(scenario: string, buildings: Building[]): Row {
  const index = buildCityIndex(buildings);
  let sink = 0;
  const collide = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (collideCity(probes[k & 4095] as Vec3, 2, buildings, index)) sink++;
    }
  };
  const los = (n: number) => {
    for (let k = 0; k < n; k++) {
      const [a, b] = sights[k & 1023] as [Vec3, Vec3];
      if (losClear(a, b, buildings)) sink++;
    }
  };
  const time = (f: (n: number) => void, n: number) => {
    f(n); // warm: caches built, code optimised
    const runs: { ns: number; bytes: number }[] = [];
    for (let r = 0; r < 3; r++) {
      const heap = process.memoryUsage().heapUsed;
      const t0 = process.hrtime.bigint();
      f(n);
      const ns = Number(process.hrtime.bigint() - t0) / n;
      runs.push({ ns, bytes: (process.memoryUsage().heapUsed - heap) / n });
    }
    runs.sort((p, q) => p.ns - q.ns);
    return runs[1] as { ns: number; bytes: number };
  };
  const c = time(collide, 400_000);
  const l = time(los, 40_000);
  if (sink < 0) console.log(sink);
  return {
    scenario,
    collideNs: c.ns,
    losNs: l.ns,
    collideBytes: c.bytes,
    losBytes: l.bytes,
  };
}

const rows = [
  measure("intact", seed),
  measure("damaged-5", damagedCity(0.05)),
  measure("damaged-20", damagedCity(0.2)),
];
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log("scenario     collideCity ns  losClear ns  B/collide  B/los");
  for (const r of rows) {
    console.log(
      `${r.scenario.padEnd(12)} ${r.collideNs.toFixed(0).padStart(14)} ${r.losNs.toFixed(0).padStart(12)} ${r.collideBytes.toFixed(1).padStart(10)} ${r.losBytes.toFixed(1).padStart(6)}`,
    );
  }
}
