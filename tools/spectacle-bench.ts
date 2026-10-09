// S8: O5's allocation table, for the Spectacle batch — what every per-frame
// entry point of S1–S7 allocates while the perf harness's spectacle scenes
// are on screen. The same method as D6's tools/destruction-bench.ts.
//
//   node --import tsx tools/spectacle-bench.ts [--where] [--json]
//        [--only=<entry substring>]
//
// The scenes are the harness's own (tools/perf/segments.mjs), staged the same
// way (client/src/game/qa-spectacle.ts): the `boss` segment's raid crossing
// the held view with its flak schedule firing; a viewer gliding down S3's
// Canyon Run at 60 m/s with the staged record ghost racing ahead and the
// rings in race colours; twelve planes on kill streaks trailing S7 smoke;
// the jumbotrons, S5's fog banks, litter and heat shimmer, the S6 probe's
// face schedule and the S2 score's state machine on the same frames.
//
// Per entry point: 1200 warm frames (code optimised, pools filled), then
// five runs of 3000 frames under V8's sampling heap profiler (~every 32 B;
// objects a later GC collected are INCLUDED, so a collection mid-run hides
// nothing). The figure is bytes allocated per frame by the entry point's
// own code — a builtin's allocation is charged to its caller; the bench's
// frame loop is not. MEDIAN of five (a run can still catch V8 re-optimising).
// `--where` names the sites.
//
// Budget: "no per-frame allocations" — nothing BUILT per frame: no object,
// array, closure or iterator (one per shell, puff or scrap is kilobytes).
// What V8 still allocates is boxing, and it cannot be written away: in this
// V8 a plain object's number fields are tagged (`%DebugPrint` of a Vec3
// scratch or a shimmer slot shows `@ Any`), so every computed double stored
// into one — a scratch vector, a pose, a uniform's `.value` — is a fresh
// 16 B HeapNumber, as is a double handed to a call V8 declines to inline.
// O5's table carried the same residue (~9 B a collision query). The bar is
// D6's (tools/destruction-bench.ts): a judged entry passes at <= 1 KB a
// frame and all of them together at <= 4 KB — about one young-generation GC
// a minute at 60 fps. Exit 1 over either.
// The references (the bench's loop) and the S2 note scheduling are reported,
// not judged: the score builds WebAudio nodes per BAR by design (here there
// is no AudioContext, so its row is the per-frame state machine only).
//
// The bench also checks the tier table: every S1–S7 feature has a row in
// `FEATURE_TIERS` (client/src/render/quality.ts), and every such row is in
// the README's tier table (tools/perf/README.md), word for word. Exit 1 if
// not.
//
// Node, not the browser: three's objects build without a GL context. Shims:
// `document.createElement("canvas")` with no 2D context (the jumbotrons and
// the smoke sprite already handle that), `document.fonts`, and a renderer
// stub for the two entry points that hold one (the jumbotrons' LAST KILL
// pass, the reflection probe's faces): its `render` draws nothing, so their
// rows are the module's own work around three's draw call.

import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BossFlak } from "@angels-bandits/common/boss";
import { raidMaxHp } from "@angels-bandits/common/boss";
import { type Building, generateCity } from "@angels-bandits/common/city";
import { generateMovers } from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import {
  buildCityIndex,
  buildNatureIndex,
} from "@angels-bandits/common/collision";
import { BLOCK_PITCH, CITY_SEED } from "@angels-bandits/common/constants";
import { generateCourses } from "@angels-bandits/common/courses";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";

// Particle systems draw from Math.random: seeded, and reseeded every run.
let seed = 0x5e8;
const reseed = () => {
  seed = 0x5e8;
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

const { qaGhostTrack, qaShell, stageBoss } = await import(
  "../client/src/game/qa-spectacle"
);
const { Music } = await import("../client/src/audio/music");
const { AtmosphereFx } = await import("../client/src/render/atmosphere-fx");
const { BossRenderer } = await import("../client/src/render/boss");
const { CourseGhost } = await import("../client/src/render/ghost");
const { Impacts } = await import("../client/src/render/impacts");
const { Jumbotrons } = await import("../client/src/render/jumbotrons");
const { AbBloomPass, FinalPass, ShaftsPass } = await import(
  "../client/src/render/post"
);
const { FEATURE_TIERS } = await import("../client/src/render/quality");
const { ReflectionProbe } = await import("../client/src/render/reflections");
const { CourseRings } = await import("../client/src/render/rings");
const { SmokeTrails, STREAK_SMOKE_COLORS } = await import(
  "../client/src/render/smoke"
);
const { SEGMENTS, segmentWorldMs } = await import("./perf/segments.mjs");

const HERE = dirname(fileURLToPath(import.meta.url));

// --- The city and the staged scenes ------------------------------------------

const buildings = generateCity(CITY_SEED) as Building[];
const index = buildCityIndex(buildings);
const nature = buildNatureIndex(natureFor(CITY_SEED, buildings));
const movers = generateMovers(CITY_SEED, buildings);
const courses = generateCourses(CITY_SEED, {
  buildings,
  index,
  nature,
  movers,
});
const byBlock = new Map<number, Building[]>();
for (const b of buildings) {
  const key =
    Math.floor(b.x / BLOCK_PITCH) * 1000 + Math.floor(b.z / BLOCK_PITCH);
  const bucket = byBlock.get(key);
  if (bucket) bucket.push(b);
  else byBlock.set(key, [b]);
}

type Seg = (typeof SEGMENTS)[number];
const BOSS = SEGMENTS.find((s: Seg) => s.name === "boss");
const RINGS = SEGMENTS.find((s: Seg) => s.name === "rings");
const W = segmentWorldMs(SEGMENTS.indexOf(BOSS));
const stage = stageBoss({
  x: BOSS.x,
  y: BOSS.y,
  z: BOSS.z,
  yaw: BOSS.yaw,
  ahead: BOSS.boss.ahead,
  worldMs: W,
  crossMs: 3400,
  corridor: BOSS.boss.corridor,
});
/** The whole flak schedule, built before anything is measured: in the game
 * shells arrive off the wire, not out of the frame loop. */
const SHELLS: BossFlak[] = [];
for (let k = 0; k < 400; k++) SHELLS.push(qaShell(stage, k));
const canyon = courses.find((c) => c.theme === RINGS.course.theme);
if (!canyon) throw new Error("no Canyon Run in the seed city");
const ghostTrack = qaGhostTrack(canyon, RINGS.course.ghostSpeed);

/** Enough of a WebGLRenderer for the jumbotrons and the probe: nothing is
 * drawn, so their rows are their own work around three's draw. */
const renderTarget: { t: unknown } = { t: null };
const rendererStub = {
  info: { render: { calls: 0 }, programs: [] as unknown[] },
  extensions: { has: () => true },
  coordinateSystem: THREE.WebGLCoordinateSystem,
  getRenderTarget: () => renderTarget.t,
  setRenderTarget: (t: unknown) => {
    renderTarget.t = t;
  },
  getActiveCubeFace: () => 0,
  getActiveMipmapLevel: () => 0,
  getClearColor: (c: THREE.Color) => c,
  getClearAlpha: () => 1,
  setClearColor: () => {},
  render: () => {
    rendererStub.info.render.calls += 40;
  },
  getContext: () => ({
    FRAMEBUFFER: 0,
    FRAMEBUFFER_COMPLETE: 1,
    checkFramebufferStatus: () => 1,
  }),
} as unknown as THREE.WebGLRenderer;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.5, 3000);
scene.add(camera);

const jumbotrons = new Jumbotrons(buildings, rendererStub);
const rings = new CourseRings(courses);
const ghost = new CourseGhost();
const impacts = new Impacts();
const boss = new BossRenderer(
  impacts,
  () => {},
  () => {},
);
const bossSlot = { raid: stage.raid, down: null };
const bossHp = raidMaxHp(stage.raid);
const flak = new Map<number, BossFlak>();
let nextShell = 0;
const streak = new SmokeTrails({ tinted: true });
const shafts = new ShaftsPass();
const finalPass = new FinalPass(new AbBloomPass(1, 0.5, 0.7), true, shafts);
const atmosphere = new AtmosphereFx(
  CITY_SEED,
  buildings,
  byBlock,
  finalPass,
  shafts,
);
const probe = new ReflectionProbe(true, camera.far);
probe.tag(jumbotrons.mesh);
probe.tagLights(scene);
probe.setQuality("high");
const music = new Music({ mixBus: () => null }, CITY_SEED);

// --- Frames ---------------------------------------------------------------------

const FRAME_MS = 1000 / 60;
/** Frame `f`: the canyon viewer (60 m/s down x = 1400), the boss viewer
 * (held, a little sway), the world clock and the wall clock. One object. */
const clock = { ms: 0, now: 0 };
const viewer: Vec3 = { x: 1400, y: 29, z: 525 };
const held: Vec3 = { x: BOSS.x, y: BOSS.y, z: BOSS.z };
function frameAt(f: number): typeof clock {
  const s = f * FRAME_MS;
  viewer.x = 1400 + 2 * Math.sin(s / 900);
  viewer.z = 525 - ((0.06 * s) % 480);
  held.x = BOSS.x + 4 * Math.sin(s / 1300);
  clock.ms = W + s;
  clock.now = 100_000 + s;
  return clock;
}
/** Twelve planes in a loose box ahead of the boss viewer, all streaking. */
const planes: Vec3[] = [];
const PLANE_IDS: string[] = [];
const TINTS = [3, 5, 10].map(
  (k) => STREAK_SMOKE_COLORS[k as keyof typeof STREAK_SMOKE_COLORS],
);
for (let i = 0; i < 12; i++) {
  planes.push({ x: 0, y: 0, z: 0 });
  PLANE_IDS.push(`plane-${i}`);
}
function placePlanes(s: number): void {
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i] as Vec3;
    const ph = i * 2.399;
    p.x = BOSS.x + 9 * Math.sin(0.0008 * s + ph);
    p.y = 262 + 27 * (1 + Math.sin(0.0003 * s + ph));
    p.z = BOSS.z - 150 - 80 * Math.sin(0.0004 * s + ph);
  }
}
const noPasses: never[] = [];
const moonDir = [0.3, 0.4, -0.86];
const musicFrame = {
  nowMs: 0,
  threatDist: 120 as number | null,
  hp: 70,
  alive: true,
};

type Step = (f: number) => void;
const ENTRIES: { name: string; step: Step; reset?: () => void }[] = [
  {
    // The bench's own frame loop and nothing else: the floor every row
    // includes. Not judged.
    name: "(the bench's frame loop)",
    step: (f) => {
      sink += frameAt(f).ms;
    },
  },
  {
    name: "S1 jumbotrons.update",
    step: (f) => {
      const { ms } = frameAt(f);
      jumbotrons.update(viewer, ms);
    },
  },
  {
    name: "S3 rings.setRun + update",
    step: (f) => {
      const { now } = frameAt(f);
      rings.setRun(canyon.id, 1 + (Math.floor(f / 90) % 10));
      rings.update(viewer, now);
    },
  },
  {
    name: "S3 ghost.update",
    step: (f) => {
      const { now } = frameAt(f);
      ghost.update(viewer, now);
    },
    reset: () => ghost.play(ghostTrack, 100_000),
  },
  {
    name: "S4 boss.update (zeppelin + flak)",
    step: (f) => {
      const { ms, now } = frameAt(f);
      // Bench code: shells arrive the way the socket hands them over.
      while (nextShell < SHELLS.length) {
        const sh = SHELLS[nextShell] as BossFlak;
        if (sh.t0 > ms) break;
        flak.set(sh.id, sh);
        nextShell++;
      }
      boss.update(bossSlot, bossHp, flak, held, ms, now);
    },
    reset: () => {
      flak.clear();
      nextShell = 0;
    },
  },
  {
    name: "S7 streak smoke (12 planes)",
    step: (f) => {
      const { now } = frameAt(f);
      placePlanes(f * FRAME_MS);
      for (let i = 0; i < planes.length; i++) {
        streak.sync(
          PLANE_IDS[i] as string,
          planes[i] as Vec3,
          now,
          true,
          TINTS[i % 3],
        );
      }
      streak.update(held, now);
    },
  },
  {
    name: "S5 atmosphere.update",
    step: (f) => {
      const { ms, now } = frameAt(f);
      camera.position.set(viewer.x, viewer.y + 4, viewer.z + 14);
      camera.lookAt(viewer.x, viewer.y, viewer.z - 100);
      atmosphere.update({
        camera,
        cameraPos: viewer,
        worldMs: ms,
        now,
        planes,
        passes: noPasses,
        haze: 0.3,
        microK: 1,
        moonDir,
        moonVis: 1,
      });
    },
  },
  {
    name: "S6 reflections.update",
    step: (f) => {
      frameAt(f);
      camera.position.set(viewer.x, viewer.y + 4, viewer.z + 14);
      probe.update(rendererStub, scene, camera);
    },
  },
  {
    name: "S2 music.update (state; no WebAudio)",
    step: (f) => {
      const { now } = frameAt(f);
      musicFrame.nowMs = now;
      musicFrame.threatDist = 80 + (f % 400);
      if (f % 240 === 0) music.noteCombat(now);
      music.update(musicFrame);
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

/**
 * three's update-range list, reported beside the figure and not in it.
 * `uploadPrefix` queues each re-packed attribute's prefix through D6's
 * pooled ranges (render/update-range.ts) — the RANGE objects are reused —
 * but three's renderer empties `attr.updateRanges` after every upload with
 * `length = 0`, which frees the array's backing store, so the next frame's
 * push grows a fresh one (~150 B per attribute). That is three's list, not
 * the module's work; D6's table carries the same residue.
 */
const isRangeList = (file: string, fn: string): boolean =>
  file === "client/src/render/update-range.ts" ||
  // V8 may inline pushUpdateRange into its one caller; uploadPrefix itself
  // allocates nothing else (it loops a prebuilt list and sets flags).
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

/** Every S1–S7 feature has a FEATURE_TIERS row; every such row is in the
 * README's tier table word for word. */
function tierCoverage(): { missing: string[]; rows: number } {
  const readme = readFileSync(resolve(HERE, "perf/README.md"), "utf8");
  const tableRows = new Set(
    readme
      .split("\n")
      .filter((l) => l.startsWith("| "))
      .map((l) => (l.split("|")[1] ?? "").trim()),
  );
  const missing: string[] = [];
  const spectacle = FEATURE_TIERS.filter((r) => /^S[1-7] /.test(r.feature));
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    if (!spectacle.some((r) => r.feature.startsWith(`S${n} `))) {
      missing.push(`S${n}: no FEATURE_TIERS row`);
    }
  }
  for (const r of spectacle) {
    if (!tableRows.has(r.feature)) {
      missing.push(`README tier table has no row "${r.feature}"`);
    }
  }
  return { missing, rows: spectacle.length };
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
const REFERENCE = /^\(the bench|^S2 music/;
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
    `scenes: boss (raid ${stage.raid.id}, ${SHELLS.length} scheduled shells), Canyon Run glide (course ${canyon.id}, ghost ${ghostTrack.count} samples), 12 streaking planes`,
  );
  console.log(
    `bytes allocated per frame (V8 sampling heap profile), ${FRAMES} frames after ${WARM} warm, median of ${RUNS} runs (budget ${BUDGET_BYTES} B an entry point, ${TOTAL_BUDGET_BYTES} B in all)\n`,
  );
  console.log(
    "entry point                             B/frame   verdict   three's range list",
  );
  for (const r of rows) {
    console.log(
      `${r.entry.padEnd(38)} ${(Number.isNaN(r.bytesPerFrame) ? "n/a" : r.bytesPerFrame.toFixed(1)).padStart(8)}   ${(REFERENCE.test(r.entry) ? "—" : r.bytesPerFrame <= BUDGET_BYTES ? "ok" : "OVER").padEnd(7)}   ${r.rangeList > 0 ? `${r.rangeList.toFixed(1)} B` : ""}`,
    );
  }
  console.log(
    `${"judged, all together".padEnd(38)} ${total.toFixed(1).padStart(8)}   ${totalOver ? "OVER" : "ok"}`,
  );
  console.log(
    `\nalloc ${over.length === 0 && !totalOver ? "PASS" : `FAIL (${[...over.map((r) => r.entry), ...(totalOver ? ["the total"] : [])].join(", ")})`}`,
  );
  console.log(
    `tiers ${tiers.missing.length === 0 ? `PASS (${tiers.rows} S1–S7 rows, all in the README)` : `FAIL\n  ${tiers.missing.join("\n  ")}`}`,
  );
}
if (sink < 0) console.log(sink);
process.exit(
  over.length === 0 && !totalOver && tiers.missing.length === 0 ? 0 : 1,
);
