// D6: O5's allocation table, for the destruction modules — what every
// per-frame entry point of D1–D5 (and X1's missiles) allocates while a
// broken, burning, collapsing block is on screen.
//
//   node --import tsx tools/destruction-bench.ts [--where] [--digest]
//        [--json] [--only=<entry substring>]
//
// The scene is the perf harness's `ruins` (tools/perf/segments.mjs), staged
// the same way (client/src/game/qa-destruction.ts) on a CityRenderer of the
// seed city: 18 buildings 30 % shot away, 21 collapses from 14 s before the
// instant to 6 s after it (dust, falling and landed debris), the burning
// blasts, a landed wreck — plus a falling wreck, a director warning, C1's
// low-flying chaos at full tilt (a facade, a roof faller, a span, a car
// chain and a gas main, each warned and going off every 3 s) and a
// cruise missile in the air, so every path that draws has work to do. A
// viewer glides through it at 42 m/s, weaving, so torus images flip.
//
// Per entry point: 1200 warm frames (code optimised, pools filled), then
// five runs of 3000 frames over the SAME frames under V8's sampling heap
// profiler (~every 32 B; objects a GC later collected are INCLUDED, so a
// collection mid-run hides nothing). The figure is bytes allocated per
// frame by the entry point's own code — a builtin's allocation (Math.hypot
// boxing its result, push growing an array) is charged to its caller; the
// bench's frame loop is not. MEDIAN of five (a run can still catch V8
// re-optimising). `--where` names the sites.
//
// Budget: 0 is the target. What is left is V8 boxing doubles handed to
// calls it declines to inline (three's Matrix4/Quaternion setters per
// falling piece, the D1 particle pool's spawn), and three's update-range
// list reallocating once it is cleared. A judged entry passes at <= 1 KB a
// frame and all of them together at <= 4 KB — in the densest staged scene,
// about one young-generation GC a minute at 60 fps. Exits 1 over either.
// The reference rows (the intact city, the bench's own loop) and X1's
// missiles (whose trail is the shared pre-D smoke.ts) are reported, not
// judged.
//
// DS1: `city.updateDebris, physics` is the same ruins as a solo page sees
// them — every collapse posed from physics frames streamed at 20 Hz through
// the page's PhysRegistry. It is judged like any row; the total counts it
// as the closed-form row's alternative (only what it costs over it).
//
// --digest hashes everything each entry point wrote over one seeded pass
// (instance matrices and attributes, dust and particle buffers): a change
// that removes an allocation must leave it byte-identical (D6's did: run
// this file against the commit before them and compare the column).
//
// Node, not the browser: three's objects build without a GL context. The
// one shim is `document.createElement("canvas")` — dust.ts and impacts.ts
// paint their sprite textures on one; here it has no 2D context, which both
// already handle (the texture stays blank; nothing measured reads it).

import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { type Building, CityDamage } from "@angels-bandits/common/city";
import { CollapseField, TOPPLE } from "@angels-bandits/common/city/collapse";
import { generateMovers } from "@angels-bandits/common/city/movers";
import { CITY_SEED, PLAYER_RADIUS } from "@angels-bandits/common/constants";
import {
  type DirectorEvent,
  EVENT_CARS,
  EVENT_COLLAPSE,
  EVENT_FACADE,
  EVENT_GAS,
  EVENT_ROOF,
  EVENT_SPAN,
} from "@angels-bandits/common/director";
import type { MissileStrike } from "@angels-bandits/common/strike";
import type { Vec3 } from "@angels-bandits/common/world";
import { wreckImpact } from "@angels-bandits/common/wreck";
import type * as THREE from "three";

// Particle systems draw from Math.random: seeded here, and reseeded before
// every run and digest (three's object uuids draw from it too, so how many
// objects a build creates must not shift what the particles get).
let seed = 0x0d6;
const reseed = () => {
  seed = 0x0d6;
};
Math.random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const g = globalThis as { document?: unknown };
g.document ??= {
  createElement: () => ({ width: 0, height: 0, getContext: () => null }),
};

const camera = await import("../client/src/game/camera");
const { collapseShakeAmount } = camera;
// A pre-D6 checkout (for --digest comparisons) has only the allocating form.
const collapseShakeOffsetInto =
  "collapseShakeOffsetInto" in camera
    ? camera.collapseShakeOffsetInto
    : (out: Vec3, amount: number, now: number) =>
        Object.assign(out, camera.collapseShakeOffset(amount, now));
const { touchesSolid } = await import("../client/src/game/collision");
const { stageDestruction, QA_ID_BASE } = await import(
  "../client/src/game/qa-destruction"
);
const { CityRenderer } = await import("../client/src/render/city");
// DL1: the collapse detail and the ruins' smoke (absent before D10 / D8 in
// an older checkout: those rows are skipped).
const collapseFx = await import("../client/src/render/collapse-fx").catch(
  () => null,
);
const ruinsMod = await import("../client/src/render/ruins").catch(() => null);
const { DirectorFx } = await import("../client/src/render/director-fx");
const { DustClouds, dustHaze } = await import("../client/src/render/dust");
const { Explosions } = await import("../client/src/render/fx");
const { BlastLedger, Impacts } = await import("../client/src/render/impacts");
const { MissileRenderer } = await import("../client/src/render/missiles");
const { ScaffoldRenderer } = await import("../client/src/render/scaffold");
const { SmokeTrails } = await import("../client/src/render/smoke");
const { Wrecks } = await import("../client/src/render/wrecks");
const { SEGMENTS } = await import("./perf/segments.mjs");

// --- The `ruins` scene ------------------------------------------------------

const RUINS = SEGMENTS.find((s: { name: string }) => s.name === "ruins");
const T = 2_000_000_000_000; // the instant every `t` is an offset from
const at = <V>(spec: V): V =>
  JSON.parse(JSON.stringify(spec), (k, v) =>
    k === "t" && typeof v === "number" ? T + v : v,
  );
const stage = at(RUINS.stage);

const city = new CityRenderer(CITY_SEED);
const intact = new CityRenderer(CITY_SEED);
const buildings = city.cityBuildings as Building[];
const damage = new CityDamage();
const field = new CollapseField();
city.attachDamage(damage);
city.attachCollapses(field);
const staged = stageDestruction(buildings, damage, field, stage, {
  next: QA_ID_BASE,
});
const movers = { ...generateMovers(CITY_SEED, buildings), collapses: field };

// DS1: the same ruins as a solo page sees them — every staged collapse
// posed from physics frames, which arrive at 20 Hz through the page's
// PhysRegistry (client/src/sim/poses.ts). The frames are built here from the
// closed form's own poses (a quaternion for its axis and angle, a squash for
// its height), so the row measures the page's path — ingest, interpolate,
// pose, matrix — on the same pieces. Absent before DS1: the row is skipped.
const physMod = await import("@angels-bandits/common/city/physpose").catch(
  () => null,
);
const collapseMod = await import("@angels-bandits/common/city/collapse");
const physCity = physMod ? new CityRenderer(CITY_SEED) : null;
const physFeed = ((): ((ms: number) => void) | null => {
  if (!physMod || !physCity) return null;
  const pDamage = new CityDamage();
  const pField = new CollapseField();
  physCity.attachDamage(pDamage);
  physCity.attachCollapses(pField);
  const registry = new physMod.PhysRegistry();
  pField.attachPhysics(registry);
  stageDestruction(
    physCity.cityBuildings as Building[],
    pDamage,
    pField,
    stage,
    {
      next: QA_ID_BASE,
    },
  );
  const S = physMod.PIECE_STRIDE;
  const H = physMod.RECORD_HEAD;
  let size = 0;
  for (const c of field.list) size += H + c.n * S;
  const data = new Float32Array(size);
  const pose = collapseMod.blankPose();
  let last = Number.NaN;
  return (ms: number) => {
    const tick = Math.floor(ms / 50) * 50;
    if (tick === last) return;
    last = tick;
    let o = 0;
    for (const c of field.list) {
      data[o] = c.id;
      data[o + 1] = c.building;
      data[o + 2] = c.n;
      data[o + 3] = 0;
      o += H;
      collapseMod.setPoseClock(tick);
      for (let i = 0; i < c.n; i++) {
        collapseMod.posePieceNow(c, i, pose);
        const half = pose.phi / 2;
        const sn = Math.sin(half);
        data[o] = pose.x;
        data[o + 1] = pose.y;
        data[o + 2] = pose.z;
        data[o + 3] = pose.axis === 0 ? sn : 0;
        data[o + 4] = 0;
        data[o + 5] = pose.axis === 0 ? 0 : sn;
        data[o + 6] = Math.cos(half);
        data[o + 7] = pose.rest ? 2 : 1;
        data[o + 8] = pose.hy / (c.hy[i] as number);
        o += S;
      }
    }
    registry.ingest(tick, 1, data, null);
  };
})();

const impacts = new Impacts();
const explosions = new Explosions();
const ledger = new BlastLedger(city.damage, buildings, city.cityIndex);
ledger.ingest(
  stage.blasts.map((b: Vec3 & { t: number }) => ({ kind: "death", ...b })),
);
const wrecks = new Wrecks(impacts, () => {});
const wreckList = [
  ...stage.wrecks.map((w: { p: Vec3; v: Vec3; t: number; spin: 1 | -1 }) => ({
    p: w.p,
    v: w.v,
    t: w.t,
    spin: w.spin,
  })),
  // A second one, still falling through the frames (its trail burns).
  { p: { x: 380, y: 160, z: 600 }, v: { x: 0, y: -2, z: 30 }, t: T, spin: -1 },
].map((path, i) => {
  const hit = wreckImpact(path, {
    buildings,
    index: city.cityIndex,
    movers,
  });
  return { id: QA_ID_BASE + 1000 + i, ...path, end: hit.end, hit: hit.hit };
});
const scaffold = new ScaffoldRenderer(buildings, "high");
const detailImpacts = new Impacts();
const collapseDetail = collapseFx
  ? new collapseFx.CollapseDetail(detailImpacts, buildings)
  : null;
const ruinSmoke = ruinsMod
  ? new ruinsMod.RuinSmoke(detailImpacts, buildings)
  : null;
const directorFx = new DirectorFx(impacts, explosions, buildings, []);
const target = buildings[staged.touched[2] as number] as Building;
const warning: DirectorEvent = {
  id: 1,
  k: EVENT_COLLAPSE,
  b: staged.touched[2] as number,
  x: target.x,
  y: 0,
  z: target.z,
  s: TOPPLE,
  d: 0,
  w: T - 2000,
  at: T + 60_000,
  zone: { x0: -60, x1: 0, z0: -20, z1: 20, top: 40 },
};
const warnings = [warning];
/** C1: one low event of each street kind round the viewer's path, every
 * LOW_PERIOD_MS — warned, swelling, going off (each re-warned once it has
 * gone, in place: lowChaos below). */
const LOW_PERIOD_MS = 3000;
const lowEvent = (
  id: number,
  k: number,
  x: number,
  y: number,
  z: number,
  d = 0,
): DirectorEvent => ({
  id,
  k,
  b: 0,
  x,
  y,
  z,
  s: 0,
  d,
  w: T - 1000 + 400 * id,
  at: T - 1000 + 400 * id + LOW_PERIOD_MS,
  zone: { x0: -8, x1: 8, z0: -8, z1: 8, top: 30 },
});
const lowWarnings = [
  lowEvent(2, EVENT_FACADE, target.x + target.width / 2 + 0.5, 30, target.z, 1),
  lowEvent(3, EVENT_ROOF, 420, 90, 900),
  lowEvent(4, EVENT_SPAN, 380, -2, 820),
  lowEvent(5, EVENT_CARS, 405, 0.8, 760),
  lowEvent(6, EVENT_GAS, 395, 0, 680),
];
/** Re-warn every low event that has gone off (its fields, in place). */
function lowChaos(ms: number): void {
  for (const e of lowWarnings) {
    if (ms <= e.at + 200 && ms >= e.w) continue;
    e.w = ms;
    e.at = ms + LOW_PERIOD_MS;
  }
}
const missiles = new MissileRenderer(new SmokeTrails(), impacts);
const flying: MissileStrike[] = [
  {
    id: 1,
    kind: "cruise",
    from: { x: 400, y: 300, z: 300 },
    to: { x: 420, y: 40, z: 760 },
    t0: T - 1000,
  },
];

// --- Frames -------------------------------------------------------------------

const FRAME_MS = 1000 / 60;
const viewer = { x: 400, y: 34, z: 1000 };
/** Frame `f`'s server clock and wall clock (one object, reused). */
const clock = { ms: 0, now: 0 };
/** Frame `f`: the viewer, the server clock and the wall clock. */
function frameAt(f: number): typeof clock {
  const s = f * FRAME_MS;
  viewer.x = 400 + 9 * Math.sin(s / 700);
  viewer.y = 34 + 20 * Math.sin(s / 1900);
  viewer.z = 1000 - ((0.042 * s) % 700); // 42 m/s north, wrapping back
  clock.ms = T - 1000 + s;
  clock.now = 100_000 + s;
  return clock;
}

const shake = { x: 0, y: 0, z: 0 };
const joltOut = { x: 0, y: 0, z: 0 };
type Step = (f: number) => void;
const ENTRIES: { name: string; step: Step; reset?: () => void }[] = [
  {
    // The bench's own frame loop and nothing else: what every row below
    // includes. Not judged against the budget, reported as the floor.
    name: "(the bench's frame loop)",
    step: (f) => {
      sink += frameAt(f).ms;
    },
  },
  {
    // The same call on an intact city: the base city's torus placement,
    // which is not destruction. "city.update (damaged mesh)" minus this is
    // what D2's damaged mesh adds.
    name: "city.update, intact (reference)",
    step: (f) => {
      frameAt(f);
      intact.update(viewer);
    },
  },
  {
    name: "city.update (damaged mesh)",
    step: (f) => {
      frameAt(f);
      city.update(viewer);
    },
  },
  {
    name: "city.updateDebris",
    step: (f) => {
      const { ms } = frameAt(f);
      city.updateDebris(viewer, ms);
    },
  },
  ...(physCity && physFeed
    ? [
        {
          name: "city.updateDebris, physics (DS1)",
          step: (f: number) => {
            const { ms } = frameAt(f);
            physFeed(ms);
            physCity.updateDebris(viewer, ms);
          },
        },
      ]
    : []),
  {
    name: "dust.update",
    step: (f) => {
      const { ms } = frameAt(f);
      dust.update(field.list, viewer, ms);
    },
  },
  {
    name: "dustHaze",
    step: (f) => {
      const { ms } = frameAt(f);
      sink += dustHaze(field.list, viewer, ms);
    },
  },
  {
    name: "collapse shake",
    step: (f) => {
      const { ms, now } = frameAt(f);
      const jolt = collapseShakeOffsetInto(
        joltOut,
        collapseShakeAmount(field.list, viewer, ms),
        now,
      );
      shake.x += jolt.x;
      shake.y += jolt.y;
      shake.z += jolt.z;
    },
  },
  {
    name: "crash check (touchesSolid)",
    step: (f) => {
      const { ms } = frameAt(f);
      if (
        touchesSolid(
          viewer,
          PLAYER_RADIUS,
          buildings,
          city.cityIndex,
          movers,
          ms,
        )
      ) {
        sink++;
      }
    },
  },
  {
    name: "wrecks.update + touching",
    step: (f) => {
      const { ms, now } = frameAt(f);
      wrecks.update(viewer, ms, now);
      if (wrecks.touching(viewer, PLAYER_RADIUS, ms) !== null) sink++;
    },
    reset: () => wrecks.reset(wreckList),
  },
  ...(collapseDetail
    ? [
        {
          // DL1: the collapse detail's trails, bursts and crush front into
          // its own pool (sprayed and aged — the pool's update included).
          name: "collapseDetail.update",
          step: (f: number) => {
            const { ms, now } = frameAt(f);
            collapseDetail.update(field.list, viewer, ms, now);
            detailImpacts.update(viewer, now);
          },
        },
      ]
    : []),
  ...(ruinSmoke
    ? [
        {
          name: "ruinSmoke.update",
          step: (f: number) => {
            const { ms, now } = frameAt(f);
            ruinSmoke.update(field.list, viewer, ms, now);
          },
        },
      ]
    : []),
  {
    name: "impacts.burn + update",
    step: (f) => {
      const { ms, now } = frameAt(f);
      impacts.burn(ledger.burns, ms, now);
      impacts.update(viewer, now);
    },
  },
  {
    name: "directorFx.update",
    step: (f) => {
      const { ms, now } = frameAt(f);
      directorFx.update(warnings, ms, now, FRAME_MS / 1000);
    },
  },
  {
    name: "directorFx.update, C1 chaos",
    step: (f) => {
      const { ms, now } = frameAt(f);
      lowChaos(ms);
      directorFx.update(lowWarnings, ms, now, FRAME_MS / 1000);
    },
  },
  {
    name: "scaffold.update",
    step: (f) => {
      frameAt(f);
      scaffold.update(viewer, damage.version);
    },
  },
  {
    name: "missiles.update (X1, not judged)",
    step: (f) => {
      const { ms, now } = frameAt(f);
      missiles.update(flying, viewer, ms, now);
    },
  },
];
const dust = new DustClouds();
let sink = 0;

// --- Measuring ------------------------------------------------------------------

const WARM = 1200;
const FRAMES = 3000;
const RUNS = 5;
const BUDGET_BYTES = 1024;
const TOTAL_BUDGET_BYTES = 4096;

type ProfileNode = {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: ProfileNode[];
};
/** Where a frame's code lives, repo-relative ("" for a builtin). */
const fileOf = (url: string): string =>
  url.replace(/^.*\/(client|common|tools|node_modules)\//, "$1/");
/** Allocations that are the bench's own (its frame loop, the inspector). */
const isBench = (file: string): boolean =>
  file.startsWith("tools/") || file.startsWith("node:");

/**
 * One run of `e` under V8's sampling heap profiler (every ~32 B sampled,
 * objects later collected INCLUDED — so a GC inside the run hides nothing):
 * bytes per frame the entry point allocated, and by site. A builtin's
 * allocation (Math.hypot boxing its result, Array.push growing) is charged
 * to its nearest caller with a file; the bench's own frame loop and the
 * inspector are left out.
 */
async function profileRun(
  e: (typeof ENTRIES)[number],
): Promise<{ perFrame: number; sites: [string, number][] }> {
  const session = new Session();
  session.connect();
  reseed();
  e.reset?.();
  for (let f = 0; f < WARM; f++) e.step(f);
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 32,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let f = 0; f < FRAMES; f++) e.step(f);
  const { profile } = await session.post("HeapProfiler.stopSampling");
  session.disconnect();
  const sites = new Map<string, number>();
  let total = 0;
  const walk = (n: ProfileNode, owner: string) => {
    const file = fileOf(n.callFrame.url);
    const here = file === "" ? owner : file;
    if (n.selfSize > 0 && !isBench(here)) {
      total += n.selfSize;
      const key = `${n.callFrame.functionName || "(anonymous)"} ${file || `(builtin, from ${here})`}`;
      sites.set(key, (sites.get(key) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c, here);
  };
  walk(profile.head as ProfileNode, "node:");
  return {
    perFrame: total / FRAMES,
    sites: [...sites].sort((a, b) => b[1] - a[1]),
  };
}

/** Median of RUNS profiled runs, and the median run's top sites. */
async function bytesPerFrame(
  e: (typeof ENTRIES)[number],
): Promise<{ perFrame: number; sites: [string, number][] }> {
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(await profileRun(e));
  runs.sort((a, b) => a.perFrame - b.perFrame);
  return runs[1] as { perFrame: number; sites: [string, number][] };
}

/** sha1 of every buffer the entry point writes, after one seeded pass. */
function digest(e: (typeof ENTRIES)[number]): string {
  reseed();
  e.reset?.();
  for (let f = 0; f < WARM; f++) e.step(f);
  const h = createHash("sha1");
  const add = (a: { array: ArrayLike<number> } | null | undefined) => {
    if (!a) return;
    const v = a.array as Float32Array;
    h.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
  };
  const geo = (o: THREE.Object3D | null | undefined) => {
    if (!o) return;
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.geometry) return;
      for (const name of Object.keys(m.geometry.attributes).sort()) {
        add(m.geometry.attributes[name] as THREE.BufferAttribute);
      }
      const im = c as THREE.InstancedMesh;
      if (im.isInstancedMesh) add(im.instanceMatrix);
    });
  };
  geo(city.damagedSlots(staged.touched[0] as number).mesh);
  geo(city.debrisSlots(staged.wires[0]?.id ?? -1).mesh);
  geo(dust.points);
  geo(impacts.points);
  geo(wrecks.group);
  geo(scaffold.mesh);
  geo(missiles.group);
  // DL1: the collapse detail's own pool, on its own rows only (so every
  // other row's digest still compares with a checkout before it).
  if (e.name === "collapseDetail.update" || e.name === "ruinSmoke.update") {
    geo(detailImpacts.points);
  }
  h.update(`${shake.x},${shake.y},${shake.z},${sink}`);
  return h.digest("hex").slice(0, 16);
}

const rows: { entry: string; bytesPerFrame: number; digest?: string }[] = [];
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
for (const e of ENTRIES) {
  if (only && !e.name.includes(only)) continue;
  const m = await bytesPerFrame(e);
  if (process.argv.includes("--where")) {
    console.log(`${e.name}:`);
    for (const [site, bytes] of m.sites.slice(0, 6)) {
      console.log(
        `  ${(bytes / FRAMES).toFixed(1).padStart(8)} B/frame  ${site}`,
      );
    }
  }
  rows.push({
    entry: e.name,
    bytesPerFrame: m.perFrame,
    ...(process.argv.includes("--digest") ? { digest: digest(e) } : {}),
  });
}
/** Rows reported but never judged: references, and X1's shared smoke. */
const REFERENCE = /\((reference|the bench|X1, not judged)/;
const over = rows.filter(
  (r) => !REFERENCE.test(r.entry) && !(r.bytesPerFrame <= BUDGET_BYTES), // NaN (never GC-free) fails too
);
const judged = rows.filter((r) => !REFERENCE.test(r.entry));
/** DS1: a row that is another's alternative (a solo page poses a collapse
 * one way or the other, never both): the total counts the larger. */
const ALTERNATIVE: Record<string, string> = {
  "city.updateDebris, physics (DS1)": "city.updateDebris",
};
const bytesOf = (name: string) =>
  rows.find((r) => r.entry === name)?.bytesPerFrame ?? 0;
const total = judged.reduce((n, r) => {
  const of = ALTERNATIVE[r.entry];
  // The alternative adds only what it costs over the row it replaces.
  return (
    n + (of ? Math.max(0, r.bytesPerFrame - bytesOf(of)) : r.bytesPerFrame)
  );
}, 0);
const totalOver = !(total <= TOTAL_BUDGET_BYTES);
if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        budgetBytes: BUDGET_BYTES,
        totalBudgetBytes: TOTAL_BUDGET_BYTES,
        total,
        rows,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `scene: ruins — ${staged.touched.length} buildings, ${staged.broken} chunks broken, ${staged.wires.length} collapses, ${ledger.burns.length} burns, ${wreckList.length} wrecks, 1 warning, 1 missile`,
  );
  console.log(
    `bytes allocated per frame (V8 sampling heap profile), ${FRAMES} frames after ${WARM} warm, median of ${RUNS} runs (budget ${BUDGET_BYTES} B an entry point, ${TOTAL_BUDGET_BYTES} B in all)\n`,
  );
  console.log("entry point                       B/frame   verdict");
  for (const r of rows) {
    console.log(
      `${r.entry.padEnd(32)} ${(Number.isNaN(r.bytesPerFrame) ? "n/a" : r.bytesPerFrame.toFixed(1)).padStart(8)}   ${REFERENCE.test(r.entry) ? "—" : r.bytesPerFrame <= BUDGET_BYTES ? "ok" : "OVER"}${r.digest ? `   ${r.digest}` : ""}`,
    );
  }
  console.log(
    `${"judged, all together".padEnd(32)} ${total.toFixed(1).padStart(8)}   ${totalOver ? "OVER" : "ok"} (budget ${TOTAL_BUDGET_BYTES} B)`,
  );
  console.log(
    `\nalloc ${over.length === 0 && !totalOver ? "PASS" : `FAIL (${[...over.map((r) => r.entry), ...(totalOver ? ["the total"] : [])].join(", ")})`}`,
  );
}
if (sink < 0) console.log(sink);
process.exit(over.length === 0 && !totalOver ? 0 : 1);
