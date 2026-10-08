#!/usr/bin/env node
// Temporal flicker metric (O1's, committed by O3 so it can be re-run).
//
//     node tools/perf/flicker.mjs [--ref <git-ref>] [--frames 30] [--no-build]
//                                 [--shots <dir>] [--out <file>] [--repeat N]
//                                 [--grid] [--only name,name]
//
// Captures FRAMES consecutive frames on a FIXED 1/60 s clock and scores the
// mean per-pixel frame-to-frame luminance change (0–255 units; lower is
// calmer). Two scenes:
//
//  - `frozen` — the camera pinned, the world advancing 1/60 s a frame. With
//    nothing moving on screen beyond 16 ms of animation, what changes from
//    frame to frame is shimmer: aliasing patterns, popping LODs, resolution
//    steps, z-fighting. THIS is the pass/fail number.
//  - `pan` — the camera sliding 1.5 m a frame at 300 m over midtown, the O1
//    pan. No motion compensation, so most of this score is the motion
//    itself; it is reported as indicative, for trend, never as a verdict.
//
// `--ref` measures another build the same way, right after this one (same
// views, same clock steps, same weather), and prints the verdict: this
// build's frozen score must not be worse than the ref's (within TOLERANCE).
// Against O1's merge commit (`--ref 0b90284`) that is O3's "the flicker
// metric is not worse than O1's merged number": the same tool on both
// builds, rather than a new number against a figure measured another way.
//
// Same world instant: every server starts on one fixed epoch
// (fixed-epoch.mjs) and every capture waits for the same server time, so
// both builds frame the same searchlight sweep, helicopters and aircraft —
// otherwise those moving lights, not shimmer, dominate a frozen view.
//
// Fixed clock: Playwright's fake clock is installed BEFORE the page loads
// (installing it later sends performance.now() backwards and the sim goes
// NaN), the network is held once the clock is synced (otherwise the
// snapshot clock estimator chases real server time between frames), and
// the WebGL context keeps its drawing buffer so a frame can be read back
// after the fake clock drove it. No storm strike may land inside the
// capture (its sky flash would dominate the score). Weather is pinned clear
// AND dry (late in
// the clear phase, wetness 0): a ref older than L4 has no weather at all,
// so anything else would score rain streaks as flicker.
//
// `--grid` (O5) scores a GRID instead of the one midtown pair: every static
// gallery view plus 20 seeded poses at 10–300 m (flicker-grid.mjs), each at
// its own world instant (`__ab.pinWorld`, in a storm gap), FROZEN and then
// PANNING sideways. Per view it reports the mean |Δluma| and `hot`, the
// share of pixels whose luma moved more than HOT_DELTA in a step: shimmer
// that a mean over a mostly-dark frame would average away. `--ref` then
// prints the per-view before/after table. `--only` restricts it to named
// views (e.g. to re-shoot one with --shots).
//
// Same browser knobs as run.mjs: AB_CHROME / AB_CHROME_ARGS.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { prepareRefBuild } from "./refbuild.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const VIEWPORT = { width: 640, height: 360 };
/**
 * "Not worse": the frozen score may exceed the ref's by at most the larger
 * of these. A frozen city scores ~0.035 (the animation in 16 ms), and the
 * same build repeats to ~0.005 — so 0.01 is a resolution, not slack; a
 * strike flash or a shimmering pattern lands in whole units.
 */
export const TOLERANCE = { pct: 5, abs: 0.01 };
/** Frame step, ms — the fake clock ticks exactly this per captured frame. */
const STEP_MS = 1000 / 60;
/**
 * A step this large — and over 3x the scene's own median step — is a storm
 * strike's full-sky flash, not shimmer (a frozen city moves ~0.1 a step, a
 * pan ~6; a flash adds several units on top).
 * A capture that contains one fails loudly rather than score the flash: the
 * strike schedule is a pure function of (seed, time), so move CAPTURE_AT_MS.
 */
const FLASH_DELTA = 1;
/** How far before the capture instant the page clock is frozen and stepped. */
const ALIGN_LEAD_MS = 2500;
/**
 * Every server this tool starts runs on this epoch (fixed-epoch.mjs), and
 * every capture starts at the same server time after it, so every build
 * frames the SAME world instant: the same searchlight sweep, the same
 * helicopters and aircraft, the same storm schedule. Without it a frozen
 * view's score swung 2x between runs of one build, on whichever moving
 * lights happened to be in frame.
 */
const EPOCH_MS = 1_800_000_000_000;
/**
 * Server time after EPOCH_MS at which every capture starts. The storm
 * schedule (common/src/storm.ts, a pure function of seed and time) strikes
 * at +113.6 s and +128.3 s around here, and a strike's flash takes ~4 s to
 * fade, so +120 s gives the ~1.1 s capture clean air on both sides.
 * FLASH_DELTA catches it if the schedule ever changes.
 */
const CAPTURE_AT_MS = 120_000;
const FIXED_EPOCH = resolve(HERE, "fixed-epoch.mjs");
/** Pan speed, metres per frame (90 m/s, a slow cruise). */
const PAN_M = 1.5;
/** Where the scenes look: midtown from 300 m, toward the dense core. */
const SCENES = {
  frozen: {
    eye: { x: 1000, y: 300, z: 1500 },
    at: { x: 1000, y: 40, z: 1150 },
  },
  pan: { eye: { x: 900, y: 300, z: 1500 }, at: { x: 900, y: 40, z: 1150 } },
};

/** --grid: frames per view (frozen) and pan frames per view. */
const GRID_FRAMES = 10;
const GRID_PAN_FRAMES = 6;
/** --grid: steps on a new view before the first captured frame — time for
 * the streamed detail around a teleported camera to land. */
const GRID_SETTLE = 30;
/** A pixel whose luma moved more than this in one step is `hot`. */
const HOT_DELTA = 8;
/**
 * --grid: the verdict's absolute ceiling for a frozen view, O1's merged
 * threshold: the O3 gate's limit for the midtown frozen view against main
 * (0.041, tools/perf/README.md "Shimmer") — the calmest any frozen view
 * of the game has been required to be.
 */
export const GRID_CEILING = 0.041;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = {
    ref: null,
    frames: 30,
    build: true,
    out: null,
    shots: null,
    repeat: 1,
    grid: false,
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref") opts.ref = argv[++i];
    else if (a === "--frames") opts.frames = Number(argv[++i]);
    else if (a === "--no-build") opts.build = false;
    else if (a === "--out") opts.out = resolve(process.cwd(), argv[++i]);
    else if (a === "--shots") opts.shots = resolve(process.cwd(), argv[++i]);
    else if (a === "--repeat") opts.repeat = Number(argv[++i]);
    else if (a === "--grid") opts.grid = true;
    else if (a === "--only") opts.only = argv[++i].split(",");
    else throw new Error(`unknown flag ${a}`);
  }
  if (!(opts.frames >= 3)) throw new Error("--frames must be >= 3");
  return opts;
}

function run(cmd, args, cwd) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit" });
    p.on("exit", (c) =>
      c === 0 ? ok() : fail(new Error(`${cmd} exited ${c}`)),
    );
  });
}

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

async function startServer(cwd) {
  const port = await freePort();
  const proc = spawn(
    "node",
    ["--import", FIXED_EPOCH, "--import", "tsx", "server/src/index.ts"],
    {
      cwd,
      env: {
        ...process.env,
        PORT: String(port),
        AB_EPOCH_MS: String(EPOCH_MS),
      },
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 120; i++) {
    // A bind failure exits the process — never measure someone else's server.
    if (proc.exitCode !== null) throw new Error("server died on startup");
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) {
        return { proc, port };
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error("server never answered /healthz");
}

/** Runs in the page before any game code: readable frames, holdable net. */
function initScript() {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === "webgl2" || type === "webgl") {
      // The 3D view. NOT `querySelector("canvas")`: the minimap and other
      // HUD canvases come first in the document, and scoring the minimap
      // reads a calm ~0 for any build.
      window.__flickerGls = [...(window.__flickerGls ?? []), this];
      return getContext.call(this, type, {
        ...(attrs ?? {}),
        preserveDrawingBuffer: true,
      });
    }
    return getContext.call(this, type, attrs);
  };
  window.__flickerHoldNet = false;
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener(
        "message",
        (e) => {
          if (window.__flickerHoldNet) e.stopImmediatePropagation();
        },
        { capture: true },
      );
    }
  };
}

/**
 * Point the page at one view: frame `i` looks from `eye` at `at`, slid
 * `i × panM` metres along `right` (horizontal) when `right` is given.
 * The plane is held 330 m over the eye (see measureBuild).
 */
function aimView(page, spec, panM) {
  return page.evaluate(
    ({ spec, panM }) => {
      window.__flickerView = (i) => {
        const k = spec.right ? i * panM : 0;
        const dx = spec.right ? spec.right.x * k : 0;
        const dz = spec.right ? spec.right.z * k : 0;
        return {
          eye: { x: spec.eye.x + dx, y: spec.eye.y, z: spec.eye.z + dz },
          at: { x: spec.at.x + dx, y: spec.at.y, z: spec.at.z + dz },
        };
      };
      window.__flickerPrev = null;
      window.__flickerPin = { x: spec.eye.x, z: spec.eye.z };
      window.__ab.qaCamera(window.__flickerView(0));
    },
    { spec, panM },
  );
}

/** The classic pair as aimView specs (the pan slides +X, O1's). */
const sceneSpec = (scene) => ({
  eye: SCENES[scene].eye,
  at: SCENES[scene].at,
  right: scene === "pan" ? { x: 1, z: 0 } : null,
});

/** Read the canvas, luminance it, diff against the previous frame. */
function readFrame(page) {
  return page.evaluate((hotDelta) => {
    // The renderer's canvas: a WebGL one that is in the page (a capability
    // probe's detached canvas never is), the largest if several are.
    const src = (window.__flickerGls ?? [])
      .filter((c) => c.isConnected)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const w = src.width;
    const h = src.height;
    let c = window.__flickerCanvas;
    if (!c || c.width !== w || c.height !== h) {
      c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      window.__flickerCanvas = c;
    }
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    let mean = 0;
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) {
      // Rec. 709 luma on the display-referred (sRGB) bytes — what the eye
      // sees change, which is what flicker is.
      lum[j] = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      mean += lum[j];
    }
    const prev = window.__flickerPrev;
    let delta = null;
    let hot = null;
    if (prev) {
      let sum = 0;
      let n = 0;
      for (let j = 0; j < lum.length; j++) {
        const d = Math.abs(lum[j] - prev[j]);
        sum += d;
        if (d > hotDelta) n++;
      }
      delta = sum / lum.length;
      hot = n / lum.length;
    }
    window.__flickerPrev = lum;
    return { delta, hot, mean: mean / lum.length };
  }, HOT_DELTA);
}

/**
 * Step and read `frames` frames of the aimed view (`__flickerView(i)`).
 * `flash`: a step far above the view's own typical step — a storm strike's
 * sky flash, which must never be scored as shimmer.
 */
async function captureFrames(page, frames, shots, tag) {
  const deltas = [];
  const hots = [];
  const means = [];
  for (let i = 0; i < frames; i++) {
    await page.evaluate(
      (i) => window.__ab.qaCamera(window.__flickerView(i)),
      i,
    );
    await page.clock.runFor(STEP_MS);
    const f = await readFrame(page);
    // --shots: the first and last captured frame, to look at before
    // trusting a score (a wrong view scores as well as a right one).
    // Written after the read, so it never perturbs the clock.
    if (shots && (i === 0 || i === frames - 1)) {
      const png = await page.evaluate(() =>
        window.__flickerCanvas.toDataURL("image/png"),
      );
      mkdirSync(shots, { recursive: true });
      writeFileSync(
        resolve(shots, `${tag.replace(/\W+/g, "-")}-${i}.png`),
        Buffer.from(png.split(",")[1], "base64"),
      );
    }
    means.push(f.mean);
    if (f.delta !== null) {
      deltas.push(f.delta);
      hots.push(f.hot);
    }
  }
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  // Relative to the view's own typical step: a pan moves ~6 a step by
  // itself, a frozen view ~0.1, and a flash jumps far above either.
  const typical = [...deltas].sort((x, y) => x - y)[
    Math.floor(deltas.length / 2)
  ];
  return {
    score: Math.round(avg(deltas) * 1000) / 1000,
    hot: Math.round(avg(hots) * 1e5) / 1e5,
    deltas: deltas.map((d) => Math.round(d * 1000) / 1000),
    meanLuma: Math.round(avg(means) * 10) / 10,
    flash: deltas.some((d) => d > Math.max(FLASH_DELTA, 3 * typical)),
  };
}

async function measureBuild(browser, label, cwd, frames, shots, grid) {
  const { proc, port } = await startServer(cwd);
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  try {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(initScript);
    await page.addInitScript((s) => {
      window.__flickerScenes = s;
    }, SCENES);
    // BEFORE goto: see the header.
    await page.clock.install();
    await page.goto(
      `http://127.0.0.1:${port}/?res=1&sky=night&quality=high&gputime=0`,
    );
    await page.fill("#join-name", "FLICKER");
    await page.click('#join button[type="submit"]');
    await page.waitForFunction(() => typeof window.__ab !== "undefined", null, {
      timeout: 120_000,
    });
    await page.evaluate(() => window.__ab.setBots(0));
    // Hold the plane still right above the scene's eye, so it can neither
    // die nor drift and the city streams around the view; the view itself
    // comes from qaCamera. 330 m: crash-proof (over every roof) and well
    // under the cloud deck — the atmosphere is computed from the PLANE's
    // altitude, and inside the deck its fog hides the whole city.
    await page.evaluate(() => {
      window.__flickerPin = { x: 1000, z: 1500 };
      const pin = () => {
        const p = window.__flickerPin;
        window.__ab.teleport(p.x, p.z, 330, 0);
        requestAnimationFrame(pin);
      };
      pin();
    });
    await page.waitForFunction(
      () =>
        window.__ab.net().renderTime !== null &&
        window.__ab.combat().targets.length === 0,
      null,
      { timeout: 120_000, polling: 500 },
    );
    // Clear AND dry (wetness lags rain and dries through the first 60 % of
    // the clear phase): 90 s past mid-clear is past that on any cycle.
    const weather = await page.evaluate(() => {
      const ab = window.__ab;
      if (typeof ab.weather !== "function")
        return { phase: "none", wetness: 0 };
      const mid = ab.weather("clear");
      return ab.weather(mid.timeMs + 90_000);
    });
    if (
      weather.phase !== "none" &&
      (weather.phase !== "clear" || weather.wetness > 0)
    ) {
      throw new Error(
        `could not pin clear, dry weather: ${JSON.stringify(weather)}`,
      );
    }
    // Let streaming and first-sight compiles land on the real clock, then
    // freeze it: from here on time only moves when a frame is stepped.
    await sleep(3000);
    // Land on the shared capture instant (see EPOCH_MS) EXACTLY: wait on
    // the real clock until it is ALIGN_LEAD_MS away, freeze the page clock
    // and hold the network, then step the fake clock the rest of the way —
    // to within one frame of CAPTURE_AT on every build, where waiting on the
    // real clock alone landed up to 2 s apart and framed different lights.
    const target = EPOCH_MS + CAPTURE_AT_MS;
    const at = await page.evaluate(() => window.__ab.net().renderTime);
    if (at !== null && at > target - ALIGN_LEAD_MS) {
      throw new Error(
        `${label} joined after the capture instant (server time +${Math.round((at - EPOCH_MS) / 1000)} s): raise CAPTURE_AT_MS`,
      );
    }
    for (let i = 0; i < 3000; i++) {
      const rt = await page.evaluate(() => window.__ab.net().renderTime);
      if (rt !== null && rt >= target - ALIGN_LEAD_MS) break;
      await sleep(100);
    }
    await page.evaluate(() => {
      window.__flickerHoldNet = true;
    });
    // pauseAt must name a moment still ahead of the page clock, and a slow
    // frame can pass between reading it and pausing: a second of margin.
    const pageNow = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(pageNow + 1000);
    const rtPaused = await page.evaluate(() => window.__ab.net().renderTime);
    if (rtPaused !== null && rtPaused < target) {
      await page.clock.runFor(target - rtPaused);
    }

    const result = {
      label,
      weather,
      errors,
      capturedAt: await page.evaluate(() => window.__ab.net().renderTime),
    };
    if (grid) {
      result.views = [];
      for (const v of grid) {
        // Its own world instant, sky phase and clear-dry weather, then the
        // plane over its eye (the city streams around the plane).
        const wx = await page.evaluate((v) => {
          const ab = window.__ab;
          ab.pinWorld(v.timeMs);
          ab.sky(v.sky);
          if (typeof ab.weather !== "function") return { phase: "none" };
          const mid = ab.weather("clear");
          return ab.weather(mid.timeMs + 90_000);
        }, v);
        await aimView(page, { eye: v.eye, at: v.at, right: null }, PAN_M);
        for (let i = 0; i < GRID_SETTLE; i++) await page.clock.runFor(STEP_MS);
        const frozen = await captureFrames(
          page,
          GRID_FRAMES,
          shots,
          `${label}-${v.name}-frozen`,
        );
        await aimView(page, { eye: v.eye, at: v.at, right: v.right }, PAN_M);
        for (let i = 0; i < 2; i++) await page.clock.runFor(STEP_MS);
        const pan = await captureFrames(
          page,
          GRID_PAN_FRAMES,
          shots,
          `${label}-${v.name}-pan`,
        );
        const alive = await page.evaluate(() => window.__ab.combat().alive);
        result.views.push({
          name: v.name,
          timeMs: v.timeMs,
          weather: { phase: wx.phase, wetness: wx.wetness ?? 0 },
          alive,
          frozen,
          pan,
        });
        console.log(
          `  ${label} ${v.name.padEnd(18)} frozen ${frozen.score.toFixed(3)} hot ${(frozen.hot * 100).toFixed(2)}%  pan ${pan.score.toFixed(3)}${frozen.flash || pan.flash ? "  FLASH" : ""}${frozen.meanLuma < 2 ? "  BLACK" : ""}`,
        );
      }
    } else {
      for (const scene of Object.keys(SCENES)) {
        await aimView(page, sceneSpec(scene), PAN_M);
        // Two settle steps on the new view before the first captured frame.
        for (let i = 0; i < 2; i++) await page.clock.runFor(STEP_MS);
        result[scene] = await captureFrames(
          page,
          frames,
          shots,
          `${label}-${scene}`,
        );
        if (result[scene].flash) {
          throw new Error(
            `${label} ${scene}: a storm flash landed in the capture (max step ${Math.max(...result[scene].deltas).toFixed(2)}) — move CAPTURE_AT_MS`,
          );
        }
        // A black or blank capture scores 0 — the calmest possible — and
        // would pass any verdict. Refuse it instead.
        if (result[scene].meanLuma < 2) {
          throw new Error(
            `${label} ${scene}: frames are black (mean luma ${result[scene].meanLuma})`,
          );
        }
      }
    }
    result.alive = await page.evaluate(() => window.__ab.combat().alive);
    return result;
  } finally {
    await page.close().catch(() => {});
    proc.kill();
  }
}

/** The run whose frozen score is the median (a whole run, never a mix). */
function medianRun(runs) {
  const sorted = [...runs].sort((a, b) => a.frozen.score - b.frozen.score);
  return sorted[Math.floor(sorted.length / 2)];
}

export function verdict(head, ref) {
  const limit = Math.max(ref * (1 + TOLERANCE.pct / 100), ref + TOLERANCE.abs);
  return { pass: head <= limit, limit: Math.round(limit * 1000) / 1000 };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.build) await run("npm", ["run", "build", "-w", "client"], REPO);
  const ref = opts.ref === null ? null : await prepareRefBuild(opts.ref);
  const browser = await chromium.launch({
    args: [
      ...(process.env.AB_CHROME_ARGS
        ? process.env.AB_CHROME_ARGS.split(" ").filter(Boolean)
        : ["--use-angle=metal", "--enable-gpu"]),
      "--mute-audio",
    ],
    ...(process.env.AB_CHROME ? { executablePath: process.env.AB_CHROME } : {}),
  });
  const report = { frames: opts.frames, stepMs: STEP_MS, viewport: VIEWPORT };
  try {
    const gpu = await (async () => {
      const p = await browser.newPage();
      const r = await p.evaluate(() => {
        const gl = document.createElement("canvas").getContext("webgl2");
        const d = gl?.getExtension("WEBGL_debug_renderer_info");
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
      });
      await p.close();
      return r;
    })();
    report.gpu = gpu;
    console.log(`GPU: ${gpu}`);
    // Interleaved (HEAD, ref, HEAD, ref, …) so any drift on the box lands
    // in both builds; the verdict is taken on the medians.
    const runs = { head: [], ref: [] };
    for (let r = 0; r < opts.repeat; r++) {
      runs.head.push(
        await measureBuild(browser, "HEAD", REPO, opts.frames, opts.shots),
      );
      if (ref !== null) {
        runs.ref.push(
          await measureBuild(
            browser,
            ref.label,
            ref.dir,
            opts.frames,
            opts.shots,
          ),
        );
      }
    }
    report.runs = runs;
    report.head = medianRun(runs.head);
    if (ref !== null) report.ref = medianRun(runs.ref);
  } finally {
    await browser.close().catch(() => {});
  }

  const line = (r) =>
    `${r.label.padEnd(12)} frozen ${r.frozen.score.toFixed(3).padStart(7)}   pan ${r.pan.score.toFixed(3).padStart(7)}   ` +
    `(luma ${r.frozen.meanLuma}/${r.pan.meanLuma}, alive ${r.alive ? "yes" : "NO"})`;
  console.log(
    `\nflicker — mean |Δluma| per pixel per 1/60 s step, ${opts.frames} frames, ${VIEWPORT.width}x${VIEWPORT.height}`,
  );
  if (opts.repeat > 1) {
    for (const r of report.runs.head) console.log(`  run  ${line(r)}`);
    for (const r of report.runs.ref) console.log(`  run  ${line(r)}`);
    console.log("median:");
  }
  console.log(line(report.head));
  if (report.ref) {
    console.log(line(report.ref));
    const v = verdict(report.head.frozen.score, report.ref.frozen.score);
    report.verdict = v;
    console.log(
      `\nfrozen: HEAD ${report.head.frozen.score.toFixed(3)} vs ${report.ref.label} ${report.ref.frozen.score.toFixed(3)} (limit ${v.limit}) — ${v.pass ? "PASS: not worse" : "FAIL: worse"}\n(pan is indicative only — it is mostly the camera's own motion)`,
    );
  }
  const out = opts.out ?? resolve(HERE, "flicker-last.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${out}`);
  if (report.verdict && !report.verdict.pass) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
