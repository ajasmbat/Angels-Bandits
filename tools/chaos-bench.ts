// P4: O5's allocation table, for the Amazing batch — what every per-frame
// entry point of C2 (constant chaos), U4 (tunnels), U5 (underground life)
// and P4's own plane fleet allocates while the perf harness's chaos scenes
// are on screen. The same method as D6's tools/destruction-bench.ts and
// S8's tools/spectacle-bench.ts.
//
//   node --import tsx tools/chaos-bench.ts [--where] [--json]
//        [--only=<entry substring>]
//
// The scenes are the harness's own (tools/perf/segments.mjs), staged the
// same way (client/src/game/qa-chaos.ts): the `chaos` segment's missile
// schedule, meteors, quake and fires round the held view; a
// viewer gliding down Crosstown's deep bore at 60 m/s past the metro hall
// (`tunnel`); twelve planes weaving ahead of the view, drawn by the fleet.
//
// Per entry point: 1200 warm frames, then five runs of 3000 frames under
// V8's sampling heap profiler (objects a later GC collected INCLUDED); the
// figure is bytes allocated per frame by the entry point's own code, the
// MEDIAN of the five. `--where` names the sites. The bar is D6's and S8's:
// nothing BUILT per frame (no object, array, closure or iterator); what is
// left is V8 boxing doubles stored into tagged fields or handed to calls it
// does not inline — a judged entry passes at <= 1 KB a frame and all of them
// together at <= 4 KB. Exit 1 over either.
//
// Strikes ARRIVE: in the game they come off the wire (or out of the
// harness's stage) as objects; here the whole schedule is planned before
// anything is measured and handed over the way the socket would.
//
// The bench also checks the tier table: every C2 / U4 / U5 / P3 / P4
// feature has a row in `FEATURE_TIERS` (client/src/render/quality.ts), and
// every such row is in the README's tier table (tools/perf/README.md), word
// for word. Exit 1 if not.
//
// Node, not the browser: three's objects build without a GL context. Shims:
// `document.createElement("canvas")` with no 2D context (the biplane's
// textures, the tag atlas and the smoke sprite already handle that).

import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BossLaunch } from "@angels-bandits/common/boss";
import type { QuakeEvent } from "@angels-bandits/common/chaos";
import { type Building, generateCity } from "@angels-bandits/common/city";
import { emptyCaveInSlot } from "@angels-bandits/common/city/caveins";
import { buildCityIndex } from "@angels-bandits/common/collision";
import { CITY_SEED } from "@angels-bandits/common/constants";
import type { SnapshotMsg } from "@angels-bandits/common/protocol";
import type { MissileStrike } from "@angels-bandits/common/strike";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";

// Particle systems draw from Math.random: seeded, and reseeded every run.
let seed = 0xc4a05;
const reseed = () => {
  seed = 0xc4a05;
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
  fonts: { ready: new Promise(() => {}) },
  hidden: false,
};

const { stageChaos, qaChaosFrame } = await import(
  "../client/src/game/qa-chaos"
);
const { MissileFeed } = await import("../client/src/game/missile-feed");
const { quakeShakeAmount } = await import("../client/src/game/quake");
const { collapseShakeOffsetInto } = await import("../client/src/game/camera");
const { GameSocket } = await import("../client/src/net/socket");
const { FireRenderer } = await import("../client/src/render/fires");
const { Explosions, Sparks } = await import("../client/src/render/fx");
const { Impacts } = await import("../client/src/render/impacts");
const { MissileRenderer } = await import("../client/src/render/missiles");
const { SmokeTrails } = await import("../client/src/render/smoke");
const { TunnelRenderer } = await import("../client/src/render/tunnels");
const { UndergroundLife } = await import("../client/src/render/underground");
const { PlaneFleet } = await import("../client/src/render/fleet");
const { NameTagBatch } = await import("../client/src/render/nametags");
const { RemotePlanes } = await import("../client/src/render/remotes");
const { PlaneLights } = await import("../client/src/render/planelights");
const { PlaneTrails } = await import("../client/src/render/trails");
const { buildPlaneMesh } = await import("../client/src/render/plane");
const { FEATURE_TIERS } = await import("../client/src/render/quality");
const { TUNNELS, guideY, tunnelPointInto } = await import(
  "@angels-bandits/common/city/tunnels"
);
const { SEGMENTS, segmentWorldMs } = await import("./perf/segments.mjs");

const HERE = dirname(fileURLToPath(import.meta.url));

// --- The city and the staged scenes ------------------------------------------

const buildings = generateCity(CITY_SEED) as Building[];
const index = buildCityIndex(buildings);

type Seg = (typeof SEGMENTS)[number];
const CHAOS = SEGMENTS.find((s: Seg) => s.name === "chaos");
const TUNNEL = SEGMENTS.find((s: Seg) => s.name === "tunnel");
const W = segmentWorldMs(SEGMENTS.indexOf(CHAOS));
const stage = stageChaos(
  {
    x: CHAOS.x,
    y: CHAOS.y,
    z: CHAOS.z,
    yaw: CHAOS.yaw,
    worldMs: W,
    ...CHAOS.chaos,
  },
  index,
  buildings,
);
/** The schedule in launch order, handed over as the frames reach it. */
const STRIKES: readonly MissileStrike[] = stage.strikes;
const held = {
  missiles: new Map<number, MissileStrike>(),
  quakes: new Map<number, QuakeEvent>(),
  fires: new Set<number>(),
  // A3: what pruneChaos reads since U6 (cave-ins) and S9 (launches) — the
  // bench crashed on them before it measured anything.
  caveIns: emptyCaveInSlot(),
  boss: { launches: [] as BossLaunch[] },
};
const held2 = {
  missiles: new Map<number, MissileStrike>(),
  quakes: new Map<number, QuakeEvent>(),
  fires: new Set<number>(),
};

const impacts = new Impacts();
const smoke = new SmokeTrails();
const fires = new FireRenderer(impacts, buildings);
const missiles = new MissileRenderer(smoke, impacts);
const feed = new MissileFeed();
const explosions = new Explosions();
const sparks = new Sparks();
const tunnels = new TunnelRenderer();
const underground = new UndergroundLife();
const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.5, 3000);
const scene = new THREE.Scene();
scene.add(camera);
const fleet = new PlaneFleet();
const tags = new NameTagBatch();
const lights = new PlaneLights();
const trails = new PlaneTrails();
const remotes = new RemotePlanes(scene, "self", lights, trails, fleet, tags);
const own = buildPlaneMesh();
/** Eleven placed planes for the fleet's own row (posed once). */
const placed: THREE.Object3D[] = [];
scene.add(own, fleet.group, tags.mesh);
fleet.adopt(own);

// --- Frames ---------------------------------------------------------------------

const FRAME_MS = 1000 / 60;
/** Frame `f`: the held chaos view (a little sway), the tunnel glider, the
 * world clock and the wall clock. One object. */
const clock = { ms: 0, now: 0 };
const held3: Vec3 = { x: CHAOS.x, y: CHAOS.y, z: CHAOS.z };
const glider: Vec3 = { x: 0, y: 0, z: 0 };
const tpt = { x: 0, z: 0, th: 0 };
const crosstown = TUNNELS[TUNNEL.tunnel.id] as (typeof TUNNELS)[number];
/** The glide down Crosstown, frame by frame, planned before anything is
 * measured (the bench's path, not the renderers' work). */
const GLIDE_FRAMES = Math.round((330 / TUNNEL.tunnel.speed) * 60);
const GLIDE = new Float64Array(GLIDE_FRAMES * 3);
for (let k = 0; k < GLIDE_FRAMES; k++) {
  const along = TUNNEL.tunnel.s + (TUNNEL.tunnel.speed * k * FRAME_MS) / 1000;
  tunnelPointInto(crosstown, along, tpt);
  GLIDE[k * 3] = ((tpt.x % 2000) + 2000) % 2000;
  GLIDE[k * 3 + 1] = guideY(crosstown, along);
  GLIDE[k * 3 + 2] = ((tpt.z % 2000) + 2000) % 2000;
}
function frameAt(f: number): typeof clock {
  const s = f * FRAME_MS;
  held3.x = CHAOS.x + 3 * Math.sin(s / 1300);
  clock.ms = W + (s % 20_000);
  clock.now = 100_000 + s;
  const k = (f % GLIDE_FRAMES) * 3;
  glider.x = GLIDE[k] as number;
  glider.y = GLIDE[k + 1] as number;
  glider.z = GLIDE[k + 2] as number;
  return clock;
}
let nextStrike = 0;
/** Bench code: strikes land in `held.missiles` the way the socket does. */
function arrive(ms: number): void {
  while (nextStrike < STRIKES.length) {
    const m = STRIKES[nextStrike] as MissileStrike;
    if (m.t0 > ms) break;
    held.missiles.set(m.id, m);
    nextStrike++;
  }
}
const jolt: Vec3 = { x: 0, y: 0, z: 0 };

/** Eleven remotes weaving ahead of the view: two snapshots an hour apart,
 * fed once, so the frames interpolate between them with no wire traffic. */
const REMOTES = 11;
function snapshot(time: number, shift: number): SnapshotMsg {
  const players = [];
  for (let i = 0; i < REMOTES; i++) {
    players.push({
      id: `pilot-${i}`,
      pose: {
        pos: {
          x: CHAOS.x - 9 + (i % 3) * 9 + shift,
          y: 130 + i * 6,
          z: CHAOS.z - 80 - i * 14,
        },
        quat: { x: 0, y: Math.sin(i * 0.3), z: 0, w: Math.cos(i * 0.3) },
        speed: 60,
      },
      hp: i % 2 === 0 ? 100 : 40,
      prot: i === 3,
    });
  }
  return { type: "snapshot", time, players };
}
const frameClock = { frameMs: 0, time: 0, target: 0, serverNow: 0 };

type Step = (f: number) => void;
const ENTRIES: { name: string; step: Step; reset?: () => void }[] = [
  {
    name: "(the bench's frame loop)",
    step: (f) => {
      sink += frameAt(f).ms;
    },
  },
  {
    name: "C2 fires.update (12 chunks)",
    step: (f) => {
      const { now } = frameAt(f);
      fires.update(held.fires, held3, now);
    },
    reset: () => {
      for (const id of stage.fires) held.fires.add(id);
    },
  },
  {
    name: "X1/C2 missile feed + missiles.update",
    step: (f) => {
      const { ms, now } = frameAt(f);
      arrive(ms);
      const mf = feed.poll(held.missiles, ms, held3);
      for (let i = 0; i < mf.impacts.length; i++) {
        missiles.impact(mf.impacts[i] as MissileStrike, now);
      }
      missiles.update(mf.flying, held3, ms, now);
    },
    reset: () => {
      held.missiles.clear();
      nextStrike = 0;
    },
  },
  {
    name: "C2 quake shake",
    step: (f) => {
      const { ms, now } = frameAt(f);
      collapseShakeOffsetInto(
        jolt,
        quakeShakeAmount(held.quakes, held3, ms),
        now,
      );
      sink += jolt.x;
    },
    reset: () => {
      if (stage.quake) held.quakes.set(stage.quake.id, stage.quake);
    },
  },
  {
    name: "C2 pruneChaos",
    step: (f) => {
      const { ms } = frameAt(f);
      GameSocket.prototype.pruneChaos.call(held as never, ms);
    },
    reset: () => {
      if (stage.quake) held.quakes.set(stage.quake.id, stage.quake);
    },
  },
  {
    name: "P4 explosions + sparks (blast / 20 frames)",
    step: (f) => {
      const { now } = frameAt(f);
      // Bench code: the impacts' bursts arrive as events.
      if (f % 20 === 0) {
        explosions.explode(held3, now);
        sparks.burst(held3, now);
      }
      explosions.update(held3, now, FRAME_MS / 1000);
      sparks.update(held3, now);
    },
  },
  {
    name: "U4 tunnels.update (Crosstown glide)",
    step: (f) => {
      frameAt(f);
      tunnels.update(glider);
    },
  },
  {
    name: "U5 underground.update (Crosstown glide)",
    step: (f) => {
      const { ms } = frameAt(f);
      underground.update(glider, ms);
    },
  },
  {
    // The remote-plane pipeline P4 rewired: sample, surfaces, prop, lights,
    // trails, and the hand-off to the fleet and tag batch.
    name: "remote planes: remotes.update + trails (11)",
    step: (f) => {
      const { now } = frameAt(f);
      frameClock.frameMs = now;
      frameClock.time = 1_000_000 + f * FRAME_MS;
      frameClock.target = frameClock.time;
      frameClock.serverNow = frameClock.time;
      lights.begin();
      fleet.begin();
      tags.begin();
      remotes.update(frameClock, held3, FRAME_MS / 1000, now);
      lights.commit();
      trails.update(held3, now);
    },
    reset: () => {
      remotes.ingest(snapshot(990_000, 0));
      remotes.ingest(snapshot(5_000_000, 60));
    },
  },
  {
    // The fleet's own work: every plane's LOD, matrices and instances.
    name: "P4 fleet.commit + tags (12 planes)",
    step: (f) => {
      frameAt(f);
      fleet.begin();
      tags.begin();
      for (let i = 0; i < placed.length; i++) {
        fleet.add(placed[i] as THREE.Object3D);
        tags.place(i, (placed[i] as THREE.Object3D).position);
      }
      own.position.set(held3.x, held3.y, held3.z);
      fleet.add(own);
      fleet.commit(camera);
      tags.commit();
    },
    reset: () => {
      camera.position.set(CHAOS.x, CHAOS.y + 4, CHAOS.z + 14);
      camera.lookAt(CHAOS.x, CHAOS.y, CHAOS.z - 100);
      if (placed.length > 0) return;
      for (let i = 0; i < REMOTES; i++) {
        const p = buildPlaneMesh();
        p.position.set(
          CHAOS.x - 9 + (i % 3) * 9,
          130 + i * 6,
          CHAOS.z - 80 - i * 14,
        );
        scene.add(p);
        fleet.adopt(p);
        placed.push(p);
      }
    },
  },
  {
    // The harness's own staging, re-applied each frame: QA code, reported
    // beside the table and not judged.
    name: "(P4 qaChaosFrame — the harness's stage)",
    step: (f) => {
      const { ms } = frameAt(f);
      qaChaosFrame(stage, ms, held2);
    },
    reset: () => {
      stage.next = 0;
      held2.missiles.clear();
    },
  },
];
let sink = 0;

// --- Measuring --------------------------------------------------------------------

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
const fileOf = (url: string): string =>
  url.replace(/^.*\/(client|common|tools|node_modules)\//, "$1/");
const isBench = (file: string): boolean =>
  file.startsWith("tools/") || file.startsWith("node:");
/** three's update-range list (see tools/spectacle-bench.ts): reported
 * beside the figure, not in it. */
const isRangeList = (file: string, fn: string): boolean =>
  file === "client/src/render/update-range.ts" ||
  (file === "client/src/render/wrapPlacement.ts" && fn === "uploadPrefix");

async function profileRun(e: (typeof ENTRIES)[number]): Promise<{
  perFrame: number;
  rangeList: number;
  sites: [string, number][];
}> {
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
  for (let f = WARM; f < WARM + FRAMES; f++) e.step(f);
  const { profile } = await session.post("HeapProfiler.stopSampling");
  session.disconnect();
  const sites = new Map<string, number>();
  let total = 0;
  let rangeList = 0;
  const walk = (n: ProfileNode, owner: string, ownerFn: string) => {
    const file = fileOf(n.callFrame.url);
    const here = file === "" ? owner : file;
    const hereFn = file === "" ? ownerFn : n.callFrame.functionName;
    if (n.selfSize > 0 && isRangeList(here, hereFn)) {
      rangeList += n.selfSize;
    } else if (n.selfSize > 0 && !isBench(here)) {
      total += n.selfSize;
      const key = `${n.callFrame.functionName || "(anonymous)"} ${file ? `${file}:${n.callFrame.lineNumber + 1}` : `(builtin, from ${here})`}`;
      sites.set(key, (sites.get(key) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c, here, hereFn);
  };
  walk(profile.head as ProfileNode, "node:", "");
  return {
    perFrame: total / FRAMES,
    rangeList: rangeList / FRAMES,
    sites: [...sites].sort((a, b) => b[1] - a[1]),
  };
}

async function bytesPerFrame(
  e: (typeof ENTRIES)[number],
): Promise<Awaited<ReturnType<typeof profileRun>>> {
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(await profileRun(e));
  runs.sort((a, b) => a.perFrame - b.perFrame);
  return runs[Math.floor(RUNS / 2)] as Awaited<ReturnType<typeof profileRun>>;
}

// --- The tier table ---------------------------------------------------------------

/** The batch's features: each prefix has a FEATURE_TIERS row, and every
 * such row is in the README's tier table word for word. */
const PREFIXES = ["C2", "U4", "U5", "P3", "P4"];
function tierCoverage(): { missing: string[]; rows: number } {
  const readme = readFileSync(resolve(HERE, "perf/README.md"), "utf8");
  const tableRows = new Set(
    readme
      .split("\n")
      .filter((l) => l.startsWith("| "))
      .map((l) => (l.split("|")[1] ?? "").trim()),
  );
  const missing: string[] = [];
  const batch = FEATURE_TIERS.filter((r) =>
    PREFIXES.some((p) => r.feature.startsWith(`${p} `)),
  );
  for (const p of PREFIXES) {
    if (!batch.some((r) => r.feature.startsWith(`${p} `))) {
      missing.push(`${p}: no FEATURE_TIERS row`);
    }
  }
  for (const r of batch) {
    if (!tableRows.has(r.feature)) {
      missing.push(`README tier table has no row "${r.feature}"`);
    }
  }
  return { missing, rows: batch.length };
}

const rows: { entry: string; bytesPerFrame: number; rangeList: number }[] = [];
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
    rangeList: m.rangeList,
  });
}
/** Rows reported but never judged. */
const REFERENCE = /^\(/;
const over = rows.filter(
  (r) => !REFERENCE.test(r.entry) && !(r.bytesPerFrame <= BUDGET_BYTES),
);
const judged = rows.filter((r) => !REFERENCE.test(r.entry));
const total = judged.reduce((n, r) => n + r.bytesPerFrame, 0);
const totalOver = !(total <= TOTAL_BUDGET_BYTES);
const tiers = tierCoverage();
if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        budgetBytes: BUDGET_BYTES,
        totalBudgetBytes: TOTAL_BUDGET_BYTES,
        total,
        rows,
        tiers,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `scenes: chaos (${STRIKES.length} staged strikes, run ${stage.run?.id ?? "none"}, ${stage.fires.length} fires, quake ${stage.quake ? "on" : "off"}), Crosstown glide (tunnel ${crosstown.id}), ${REMOTES + 1} planes in the fleet`,
  );
  console.log(
    `bytes allocated per frame (V8 sampling heap profile), ${FRAMES} frames after ${WARM} warm, median of ${RUNS} runs (budget ${BUDGET_BYTES} B an entry point, ${TOTAL_BUDGET_BYTES} B in all)\n`,
  );
  console.log(
    "entry point                                    B/frame   verdict   three's range list",
  );
  for (const r of rows) {
    console.log(
      `${r.entry.padEnd(45)} ${(Number.isNaN(r.bytesPerFrame) ? "n/a" : r.bytesPerFrame.toFixed(1)).padStart(8)}   ${(REFERENCE.test(r.entry) ? "—" : r.bytesPerFrame <= BUDGET_BYTES ? "ok" : "OVER").padEnd(7)}   ${r.rangeList > 0 ? `${r.rangeList.toFixed(1)} B` : ""}`,
    );
  }
  console.log(
    `${"judged, all together".padEnd(45)} ${total.toFixed(1).padStart(8)}   ${totalOver ? "OVER" : "ok"}`,
  );
  console.log(
    `\nalloc ${over.length === 0 && !totalOver ? "PASS" : `FAIL (${[...over.map((r) => r.entry), ...(totalOver ? ["the total"] : [])].join(", ")})`}`,
  );
  console.log(
    `tiers ${tiers.missing.length === 0 ? `PASS (${tiers.rows} ${PREFIXES.join("/")} rows, all in the README)` : `FAIL\n  ${tiers.missing.join("\n  ")}`}`,
  );
}
if (sink < 0) console.log(sink);
process.exit(
  over.length === 0 && !totalOver && tiers.missing.length === 0 ? 0 : 1,
);
