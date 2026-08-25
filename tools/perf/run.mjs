#!/usr/bin/env node
// The headless perf harness (P1). One command, from a clean checkout:
//
//     npm run perf
//
// It builds the client, boots the real server on a free port, joins headless
// in GPU-backed Chromium, flies the fixed path in ./segments.mjs, and reports
// p50 / p95 / p99 / worst frame and draw calls PER SEGMENT — machine-readable
// JSON plus a human table. See README.md for the full flag list and for why
// each design choice is the way it is.
//
// Two decisions worth knowing before you read any number it prints:
//
//  * VSYNC IS DISABLED. With vsync on, an M3 renders this scene in ~10 ms and
//    reports 16.7 ms, because that is when the next frame is allowed to
//    start. Every optimisation would measure as zero. `--disable-gpu-vsync
//    --disable-frame-rate-limit` makes rAF free-run, so the frame time is the
//    frame's actual cost. Numbers here are therefore COSTS, not the fps a
//    player sees — a p50 of 8 ms means "60 fps with 2x headroom".
//  * THE PIXEL RATIO IS PINNED (default 2, i.e. Retina). The adaptive scaler
//    would otherwise change the workload mid-measurement and quietly turn
//    every comparison into a comparison of two different resolutions.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, loadavg, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  SAMPLE_MS,
  SEGMENTS,
  SETTLE_MS,
  STRIKE_LEAD_MS,
  WARMUP_MS,
} from "./segments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

/** Report format version — bump when a field's meaning changes. */
const REPORT_VERSION = 1;
const VIEWPORT = { width: 1280, height: 720 };
const DEVICE_SCALE_FACTOR = 2;
/** The pixel ratio measurements are taken at unless --res says otherwise. */
const DEFAULT_PINNED_RATIO = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    label: "run",
    aa: null, // null = whatever the client ships as its default
    res: String(DEFAULT_PINNED_RATIO),
    runs: 1,
    out: resolve(HERE, "last.json"),
    baseline: false,
    compare: null,
    ab: null,
    build: true,
    port: 0,
    headed: false,
    quiet: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--label":
        opts.label = next();
        break;
      case "--aa":
        opts.aa = next();
        break;
      case "--res":
        opts.res = next();
        break;
      case "--runs":
        opts.runs = Number(next());
        break;
      case "--out":
        opts.out = resolve(process.cwd(), next());
        break;
      case "--baseline":
        opts.baseline = true;
        break;
      case "--compare":
        opts.compare = resolve(process.cwd(), next());
        break;
      case "--ab":
        opts.ab = next();
        break;
      case "--no-build":
        opts.build = false;
        break;
      case "--port":
        opts.port = Number(next());
        break;
      case "--headed":
        opts.headed = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--strict":
        opts.strict = true;
        break;
      case "--help":
      case "-h":
        console.log(readFileSync(resolve(HERE, "README.md"), "utf8"));
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag ${arg} (try --help)`);
    }
  }
  return opts;
}

// --- Process plumbing -----------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: REPO, stdio: "inherit", ...opts });
    p.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`)),
    );
  });
}

/** A port nothing is listening on. Dev-server zombies from other sessions
 * squat 8080/5173 on this machine, so the harness never assumes a port. */
function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

async function startServer(port) {
  const log = [];
  const proc = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`server died:\n${log.join("")}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error(`server never answered /healthz:\n${log.join("")}`);
}

// --- The measured pass ----------------------------------------------------

/** Chromium flags. The vsync pair is the whole reason this tool measures
 * anything; ANGLE/Metal is the difference between the real GPU and
 * SwiftShader, which collapses to ~9 fps under the bloom chain. */
const CHROME_ARGS = [
  "--use-angle=metal",
  "--enable-gpu",
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
  "--mute-audio",
  "--autoplay-policy=no-user-gesture-required",
];

async function joinGame(page, url) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.fill("#join-name", "PERFBOT");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => typeof window.__ab !== "undefined", null, {
    timeout: 60_000,
  });
  // Bots fly a live sim and shoot back — deterministic per room, but their
  // POSES depend on wall-clock timing, so they would smear every segment.
  // An empty room is the only reproducible room.
  await page.evaluate(() => window.__ab.setBots(0));
  await page.waitForFunction(
    () => window.__ab.combat().targets.length === 0,
    null,
    { timeout: 30_000 },
  );
  return errors;
}

/**
 * Fly one segment and return its FrameStats plus where it was flown.
 *
 * The ENTIRE segment runs inside one page.evaluate, and its waits are driven
 * by the page's own rAF clock. That is not stylistic: with vsync off the
 * render thread is saturated, so a CDP round-trip can sit queued for
 * *seconds*. Timing the window from Node let segments run 8 s instead of 5,
 * flying the plane a block and a half past where the path said it would be —
 * which is exactly the kind of silent drift a determinism claim has to not
 * have.
 */
async function flySegment(page, seg, sampleMs) {
  const stats = await page.evaluate(
    async (s) => {
      const ab = window.__ab;
      /** Wait `ms` of in-page time, ticking on the frame loop itself. */
      const waitMs = (ms) =>
        new Promise((resolve) => {
          const t0 = performance.now();
          const tick = () =>
            performance.now() - t0 >= ms
              ? resolve()
              : requestAnimationFrame(tick);
          requestAnimationFrame(tick);
        });

      ab.teleport(s.x, s.z, s.y, s.yaw);
      await waitMs(s.settleMs);

      if (s.storm) {
        // Line the window up so a scheduled strike lands `strikeLeadMs` in.
        // Strike times are on the SERVER clock; renderTime() is this client's
        // estimate of it.
        const next = ab.storm().nextStrike;
        const rt = ab.net().renderTime;
        const lead = next === null || rt === null ? null : next.timeMs - rt;
        if (lead !== null && lead > s.strikeLeadMs) {
          await waitMs(lead - s.strikeLeadMs);
        }
      }

      ab.perfReset();
      await waitMs(s.sampleMs);
      // The GPU-clock cost of the same window. THIS is the number to read
      // for a render change: contention from everything else on the machine
      // cannot move it, and with vsync off the CPU runs several frames ahead
      // of the GPU, so wall-clock deltas understate the GPU's real load.
      const gpu = ab.gpuStats();
      return {
        ...ab.perfStats(),
        gpuP50: gpu === null ? null : gpu.p50,
        gpuP95: gpu === null ? null : gpu.p95,
        gpuWorst: gpu === null ? null : gpu.worst,
        gpuFrames: gpu === null ? null : gpu.count,
        alive: ab.combat().alive,
        pos: ab.state().pos,
        strikes: ab.storm().strikes.length,
      };
    },
    { ...seg, sampleMs, settleMs: SETTLE_MS, strikeLeadMs: STRIKE_LEAD_MS },
  );
  return { name: seg.name, what: seg.what, ...stats };
}

/**
 * One unmeasured lap of the whole path: first sight of a segment pays for
 * shader compiles, texture uploads and instance-buffer growth, none of which
 * recur. Every page flies this before anything is captured.
 */
function flyWarmupLap(page) {
  return page.evaluate(
    async ([segs, ms]) => {
      for (const s of segs) {
        window.__ab.teleport(s.x, s.z, s.y, s.yaw);
        await new Promise((resolve) => {
          const t0 = performance.now();
          const tick = () =>
            performance.now() - t0 >= ms
              ? resolve()
              : requestAnimationFrame(tick);
          requestAnimationFrame(tick);
        });
      }
    },
    [SEGMENTS.map(({ x, z, y, yaw }) => ({ x, z, y, yaw })), WARMUP_MS],
  );
}

/**
 * Warm the ARM: fly one COMPLETE, IDENTICAL pass and throw the numbers away.
 *
 * Two separate costs make the first pass a liar, and only the second one
 * needs a pass this long.
 *
 * 1. Browser-level caches. ANGLE's translated shaders and Metal's compiled
 *    pipeline states live in the GPU process and survive the page, so the
 *    first measured pass paid for them and every later pass inherited them
 *    free. It showed up hard on `--aa legacy`, whose multisampled default
 *    framebuffer needs its own pipeline variants: 3 passes spread 140 % on
 *    GPU p50 (core 23.4 → 11.7 → 17.0 ms) while the draw calls stayed
 *    identical — i.e. the same scene, three prices. A short lap fixes this.
 *
 * 2. The GPU's own clock. This one a short lap does NOT fix, which is why
 *    the warm-up is a whole pass. With the caches warmed by a 3.5 s lap, a
 *    3-pass run still read pass 1 high on EVERY segment and then settled:
 *    core 10.24 → 7.49 → 7.64, plaza 8.63 → 6.83 → 6.68, canyon 7.99 →
 *    7.53 → 7.48. Uniform across segments, monotone, draw calls identical —
 *    that is Apple's DVFS ramping under sustained load, not the scene. Once
 *    pass 1 is discarded the survivors agree to ~6 %, inside the tolerance.
 *
 * So the rule the harness holds is simply: every COUNTED pass has an
 * identical full-length pass in front of it. That leaves nothing to tune —
 * a shorter ramp would just be a guess at how long an M3 takes to clock up.
 * It costs one extra pass per arm, which is the cheapest honest option.
 */
async function warmArm(browser, url) {
  await measure(browser, url);
}

async function measure(browser, url) {
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  const errors = await joinGame(page, url);
  await flyWarmupLap(page);

  const config = await page.evaluate(() => ({
    ...window.__ab.render(),
    seed: window.__ab.storm().seed,
    roomId: window.__ab.net().roomId,
    city: window.__ab.cityStats(),
    signage: window.__ab.signage(),
  }));

  const segments = [];
  for (const seg of SEGMENTS)
    segments.push(await flySegment(page, seg, SAMPLE_MS));
  const env = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown",
      devicePixelRatio: window.devicePixelRatio,
      userAgent: navigator.userAgent,
    };
  });
  await page.close();
  return { segments, config, env, errors };
}

// --- Reporting ------------------------------------------------------------

const pct = (sorted, p) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

/** Pool every segment's summary into one headline (p50 of p50s, worst worst). */
function overall(segments) {
  const p50s = segments.map((s) => s.p50).sort((a, b) => a - b);
  const p95s = segments.map((s) => s.p95).sort((a, b) => a - b);
  const gpuP50s = segments.map((s) => s.gpuP50 ?? 0).sort((a, b) => a - b);
  return {
    p50: pct(p50s, 0.5),
    p95: Math.max(...p95s),
    worst: Math.max(...segments.map((s) => s.worst)),
    gpuP50: pct(gpuP50s, 0.5),
    gpuP95: Math.max(...segments.map((s) => s.gpuP95 ?? 0)),
    gpuWorst: Math.max(...segments.map((s) => s.gpuWorst ?? 0)),
    drawCallsMax: Math.max(...segments.map((s) => s.drawCallsMax)),
    frames: segments.reduce((n, s) => n + s.count, 0),
  };
}

const f1 = (v) => v.toFixed(1).padStart(6);

function printTable(report) {
  const c = report.config;
  console.log(
    `\n${report.label} — aa=${c.aa} pixelRatio=${c.pixelRatio}${c.auto ? " (auto)" : ""} ` +
      `buffer=${c.drawingBuffer.width}x${c.drawingBuffer.height}`,
  );
  console.log(`GPU: ${report.env.gpu}`);
  // Printed, not just stored: on a shared laptop this is the single most
  // common reason two runs of the same build disagree.
  console.log(
    `machine: ${report.env.cpus} cpus, load ${report.env.loadavg.join(" ")}`,
  );
  console.log(
    "\n           ---------- wall clock ----------   ------ GPU ------",
  );
  console.log(
    "segment       p50     p95   worst  draws     p50     p95   worst  alive",
  );
  console.log("".padEnd(72, "-"));
  for (const s of report.segments) {
    console.log(
      `${s.name.padEnd(8)}${f1(s.p50)}  ${f1(s.p95)}  ${f1(s.worst)}  ` +
        `${String(s.drawCalls).padStart(5)}  ${f1(s.gpuP50 ?? 0)}  ` +
        `${f1(s.gpuP95 ?? 0)}  ${f1(s.gpuWorst ?? 0)}  ${s.alive ? "yes" : "NO "}`,
    );
  }
  const o = report.overall;
  console.log("".padEnd(72, "-"));
  console.log(
    `overall ${f1(o.p50)}  ${f1(o.p95)}  ${f1(o.worst)}  ` +
      `${String(o.drawCallsMax).padStart(5)}  ${f1(o.gpuP50)}  ${f1(o.gpuP95)}  ${f1(o.gpuWorst)}`,
  );
  console.log(
    "\n(frame times are COSTS — vsync is disabled; lower is better.\n" +
      " Read the GPU columns for render changes: they are far more\n" +
      " contention-resistant than wall clock, but not immune — check the\n" +
      " machine line above before trusting a small delta.)",
  );
}

/**
 * The harness's own acceptance check — the tolerance is DECLARED here so a
 * reader never has to guess what "the runs agree" meant, and `--strict`
 * turns it into an exit code.
 *
 * Two numbers, and only two, because only two are actually pinned:
 *
 *  - DRAW CALLS must be identical per segment. This is the scene-identity
 *    check and it is exact, not approximate: an integer count of what was
 *    submitted cannot drift for timing reasons. If it moves, the harness
 *    stopped pinning the scene and NOTHING measured against it is trustworthy.
 *    (`storm` is exempt — a strike's position is a function of absolute time.
 *    See the tolerance note in README.md.)
 *  - GPU p50 must agree within 10 % OR 1.0 ms, whichever is LOOSER. This is
 *    the render cost, the number every optimisation claim in a PR rests on.
 *
 * The "or 1 ms" half is not a fudge factor, it is the shape the tolerance
 * has to have. A pure percentage band is a moving target that gets stricter
 * the faster the scene renders: the same 0.9 ms of run-to-run drift reads as
 * 5 % against an 18 ms legacy frame and as 12 % against the 7.4 ms frame
 * that replaced it, so shipping win A would have "broken" determinism by
 * making the game faster. What the harness can honestly claim is a
 * RESOLUTION — it can tell two configurations apart when they differ by more
 * than about a millisecond — and that is what this states. For scale, win A
 * measured 5.0 ms; the band it has to clear is 1.0.
 *
 * The band also implies a FLOOR on what this harness can measure at all,
 * and it is worth knowing where that floor is before reading a delta as
 * gospel. Pinned to `--res 1` the scene costs ~2-4 ms of GPU, and there the
 * per-pass scatter is as large as the measurement: 3 passes read core 1.98 →
 * 3.90 → 3.12 ms with draw calls identical every time. Below roughly 4 ms
 * the timer query is measuring its own overhead and the queue depth as much
 * as the scene, so treat an ABSOLUTE number from a cheap config as
 * indicative only. The paired `--ab` delta survives it — both arms sit in
 * the same state — but quote the conservative end of it.
 *
 * Wall-clock p50 is reported but deliberately NOT asserted. It includes the
 * sim, the socket, JS GC and whatever else the machine is running. Measured
 * here on a box at load average ~100 (parallel agent worktrees), one pass ran
 * a uniform ~30 % slower in wall clock across EVERY segment while its GPU
 * cost and draw calls held — an unmistakable signature of the machine rather
 * than the build. Asserting it would make the harness fail for reasons that
 * have nothing to do with the code under test, and a flaky check gets
 * disabled and then ignored. Read the GPU columns for render work.
 */
export const TOLERANCE = { gpuP50Pct: 10, gpuP50Ms: 1.0 };

/**
 * Segments whose scene the harness does NOT fully pin, and therefore does not
 * assert timing on. Both for the same reason: their content is driven by the
 * synced SERVER clock, which cannot be pinned without a server change.
 *
 *  - `storm` — which cell the next strike hits is a function of absolute time.
 *  - `canyon` — at y=45 the camera is at street level, where instanced traffic
 *    and its headlights fill more of the frame than anywhere else on the path,
 *    and traffic pose is a pure function of the server clock.
 *
 * This is a statement about what is pinned, not a way to make the check pass.
 * The evidence that canyon belongs here rather than in the "machine was busy"
 * bucket: across every multi-pass run its GPU p50 swings while its WALL p50
 * falls monotonically and its draw calls stay fixed at 107 (10.15 → 13.99 →
 * 9.92 GPU against 7.6 → 7.4 → 7.2 wall). Contention raises wall and GPU
 * together; more GPU work at constant draw calls is a fuller frame.
 *
 * For scale, on the committed baseline the three PINNED segments agree to
 * 0.79 / 0.18 / 0.32 ms and canyon alone spreads 1.38 ms. Both exempt
 * segments are still measured, still printed, and still worth reading as a
 * paired `--ab` delta — they are simply not evidence about the harness.
 */
export const UNPINNED_SEGMENTS = new Set(["storm", "canyon"]);

/** Per-segment agreement between the runs of one invocation. */
function determinism(runs) {
  if (runs.length < 2) return null;
  const spreadPct = (xs) =>
    ((Math.max(...xs) - Math.min(...xs)) / Math.min(...xs)) * 100;
  const spreadMs = (xs) => Math.max(...xs) - Math.min(...xs);
  const perSegment = SEGMENTS.map((seg, i) => {
    const p50s = runs.map((r) => r.segments[i].p50);
    const gpuP50s = runs.map((r) => r.segments[i].gpuP50 ?? 0);
    const draws = runs.map((r) => r.segments[i].drawCalls);
    return {
      name: seg.name,
      p50s,
      p50SpreadPct: spreadPct(p50s),
      gpuP50s,
      gpuP50SpreadPct: spreadPct(gpuP50s),
      gpuP50SpreadMs: spreadMs(gpuP50s),
      drawCalls: draws,
      drawCallsAgree: new Set(draws).size === 1,
      pinned: !UNPINNED_SEGMENTS.has(seg.name),
    };
  });
  // The verdict is taken over the segments the harness actually pins; the
  // rest are measured and printed but prove nothing about the harness.
  const pinned = perSegment.filter((s) => s.pinned);
  const worstGpuP50SpreadPct = Math.max(
    ...pinned.map((s) => s.gpuP50SpreadPct),
  );
  const worstGpuP50SpreadMs = Math.max(...pinned.map((s) => s.gpuP50SpreadMs));
  const drawCallsAgreeEverywhere = perSegment.every(
    (s) => s.drawCallsAgree || s.name === "storm",
  );
  // A driver with no timer-query extension reports `null`, which lands here
  // as a column of zeros — a MISSING measurement, not a passing one. Require
  // real numbers before the verdict can be based on them.
  const gpuMeasured = pinned.every((s) => s.gpuP50s.every((v) => v > 0));
  // Whichever band is looser — see TOLERANCE for why it takes both forms.
  const gpuAgrees =
    gpuMeasured &&
    (worstGpuP50SpreadPct <= TOLERANCE.gpuP50Pct ||
      worstGpuP50SpreadMs <= TOLERANCE.gpuP50Ms);
  return {
    worstGpuP50SpreadPct,
    worstGpuP50SpreadMs,
    worstP50SpreadPct: Math.max(...pinned.map((s) => s.p50SpreadPct)),
    assertedOver: pinned.map((s) => s.name),
    notAsserted: perSegment.filter((s) => !s.pinned).map((s) => s.name),
    drawCallsAgreeEverywhere,
    tolerance: TOLERANCE,
    pass: drawCallsAgreeEverywhere && gpuAgrees,
    perSegment,
  };
}

function printDelta(report, baseline) {
  console.log(`\n${report.label}  vs  ${baseline.label}`);
  console.log("segment    GPU p50 Δ      GPU p95 Δ     wall p50 Δ    draws Δ");
  console.log("".padEnd(64, "-"));
  const row = (name, a, b) => {
    const d = (x, y) => {
      const pctChange = y === 0 ? 0 : ((x - y) / y) * 100;
      return `${(x - y).toFixed(1).padStart(6)} (${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}%)`.padStart(
        15,
      );
    };
    console.log(
      `${name.padEnd(8)}${d(a.gpuP50 ?? 0, b.gpuP50 ?? 0)}` +
        `${d(a.gpuP95 ?? 0, b.gpuP95 ?? 0)}${d(a.p50, b.p50)}` +
        `${String(a.drawCalls - b.drawCalls).padStart(9)}`,
    );
  };
  for (const seg of report.segments) {
    const base = baseline.segments.find((s) => s.name === seg.name);
    if (base) row(seg.name, seg, base);
  }
  row(
    "overall",
    { ...report.overall, drawCalls: report.overall.drawCallsMax },
    { ...baseline.overall, drawCalls: baseline.overall.drawCallsMax },
  );
  console.log(
    "\n(negative = the first configuration is cheaper. With --ab the two\n" +
      " arms are interleaved, so this delta is paired and GPU-clock drift\n" +
      " lands in both arms equally.)",
  );
}

/** Fold N passes of one configuration into a single report. */
function buildReport(label, runs, opts) {
  const primary = runs[0];
  // With several passes the reported number is the MEDIAN pass per segment,
  // not the best one — a harness that reports its luckiest run is a harness
  // that reports noise.
  const segments = SEGMENTS.map((seg, i) => {
    const all = runs.map((r) => r.segments[i]);
    const byP50 = [...all].sort((a, b) => a.p50 - b.p50);
    return byP50[Math.floor((byP50.length - 1) / 2)];
  });
  return {
    version: REPORT_VERSION,
    label,
    createdAt: new Date().toISOString(),
    harness: {
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      vsync: "disabled",
      sampleMs: SAMPLE_MS,
      settleMs: SETTLE_MS,
      warmupMs: WARMUP_MS,
      runs: opts.runs,
      paired: opts.ab !== null,
    },
    env: {
      ...primary.env,
      platform: `${platform()} ${release()}`,
      cpus: cpus().length,
      node: process.version,
      // Recorded because it matters: this is a shared laptop, and a 1-minute
      // load average in the double digits inflates the wall-clock tail (p95,
      // worst) badly. A report read without it is a report misread.
      loadavg: loadavg().map((n) => Math.round(n * 10) / 10),
    },
    config: { ...primary.config, bots: 0 },
    segments,
    overall: overall(segments),
    determinism: determinism(runs),
    pageErrors: primary.errors,
  };
}

// --- Main -----------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.build) {
    console.log("building client…");
    await run("npm", ["run", "build", "-w", "client"], {
      stdio: opts.quiet ? "ignore" : "inherit",
    });
  }

  const port = opts.port || (await freePort());
  console.log(`starting server on :${port}…`);
  const server = await startServer(port);

  const urlFor = (overrides) => {
    const params = new URLSearchParams();
    if (opts.aa) params.set("aa", opts.aa);
    params.set("res", opts.res);
    params.set("gputime", "1");
    for (const [k, v] of new URLSearchParams(overrides ?? "")) params.set(k, v);
    return `http://127.0.0.1:${port}/?${params}`;
  };

  const browser = await chromium.launch({
    headless: !opts.headed,
    args: CHROME_ARGS,
  });

  let report;
  let abReport = null;
  try {
    const runs = [];
    const abRuns = [];
    // Per URL: a different `aa` mode compiles different pipelines, so each
    // arm has to warm its own or the interleave measures cache state.
    console.log("warm-up pass (discarded — caches and GPU clock)…");
    await warmArm(browser, urlFor(null));
    if (opts.ab !== null) await warmArm(browser, urlFor(opts.ab));
    for (let i = 0; i < opts.runs; i++) {
      console.log(`measuring pass ${i + 1}/${opts.runs}…`);
      runs.push(await measure(browser, urlFor(null)));
      if (opts.ab !== null) {
        // INTERLEAVED, not "all of A then all of B". The GPU's clock state
        // drifts as the machine warms: a straight A-then-B run showed pass 2
        // reading ~40 % slower than pass 1 on identical work. Alternating
        // puts that drift into both arms equally, which is the only way the
        // A/B delta means anything.
        console.log(`measuring pass ${i + 1}/${opts.runs} (${opts.ab})…`);
        abRuns.push(await measure(browser, urlFor(opts.ab)));
      }
    }
    report = buildReport(opts.label, runs, opts);
    if (opts.ab !== null) abReport = buildReport(opts.ab, abRuns, opts);
  } finally {
    await browser.close();
    server.kill();
  }

  printTable(report);
  if (abReport) {
    printTable(abReport);
    printDelta(report, abReport);
    report.ab = abReport;
  }
  const dead = report.segments.filter((s) => !s.alive);
  if (dead.length > 0) {
    console.error(
      `\n!! plane was dead during: ${dead.map((s) => s.name).join(", ")} — that segment measured a kill-cam, not the scene. Fix the path.`,
    );
  }
  if (report.pageErrors.length > 0) {
    console.error(`\n!! page errors:\n${report.pageErrors.join("\n")}`);
  }
  if (report.determinism) {
    const d = report.determinism;
    console.log(
      `\ndeterminism over ${opts.runs} passes: worst GPU p50 spread ` +
        `${d.worstGpuP50SpreadMs.toFixed(2)} ms (${d.worstGpuP50SpreadPct.toFixed(1)}%), ` +
        `worst wall p50 spread ${d.worstP50SpreadPct.toFixed(1)}%, draw calls ` +
        `${d.drawCallsAgreeEverywhere ? "identical" : "DIFFER"} per segment`,
    );
    console.log(
      `  asserted over ${d.assertedOver.join(", ")}; ` +
        `${d.notAsserted.join(" and ")} measured but not asserted ` +
        "(server-clock content — see UNPINNED_SEGMENTS)",
    );
    console.log(
      `  tolerance: draw calls identical + GPU p50 within ${TOLERANCE.gpuP50Pct}% or ${TOLERANCE.gpuP50Ms.toFixed(1)} ms, whichever is looser (wall p50 reported, not asserted) — ${d.pass ? "PASS" : "FAIL"}`,
    );
    if (!d.pass) {
      console.error(
        "  !! the harness is not pinning something; fix that before " +
          "trusting any optimisation measured against it.",
      );
    }
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${opts.out}`);
  if (opts.baseline) {
    const path = resolve(HERE, "baseline.json");
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${path}`);
  }
  if (opts.compare) {
    printDelta(report, JSON.parse(readFileSync(opts.compare, "utf8")));
  }
  // Only --strict turns a failure into an exit code. The default stays
  // "report, don't gate": the baseline needs a few PRs of trust first, and
  // a check that fails on a busy laptop gets disabled and then ignored.
  if (opts.strict && report.determinism && !report.determinism.pass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
