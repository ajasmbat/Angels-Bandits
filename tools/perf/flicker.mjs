#!/usr/bin/env node
// Temporal flicker metric (O1's, committed by O3 so it can be re-run).
//
//     node tools/perf/flicker.mjs [--ref <git-ref>] [--frames 30] [--no-build]
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
// Fixed clock: Playwright's fake clock is installed BEFORE the page loads
// (installing it later sends performance.now() backwards and the sim goes
// NaN), the network is held once the clock is synced (otherwise the
// snapshot clock estimator chases real server time between frames), and
// the WebGL context keeps its drawing buffer so a frame can be read back
// after the fake clock drove it. Weather is pinned clear AND dry (late in
// the clear phase, wetness 0): a ref older than L4 has no weather at all,
// so anything else would score rain streaks as flicker.
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
/** "Not worse": the frozen score may exceed the ref's by at most this much. */
export const TOLERANCE = { pct: 5, abs: 0.05 };
/** Frame step, ms — the fake clock ticks exactly this per captured frame. */
const STEP_MS = 1000 / 60;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { ref: null, frames: 30, build: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref") opts.ref = argv[++i];
    else if (a === "--frames") opts.frames = Number(argv[++i]);
    else if (a === "--no-build") opts.build = false;
    else if (a === "--out") opts.out = resolve(process.cwd(), argv[++i]);
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
  const proc = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
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

/** Point the page at one scene: frame `i`'s view is `__flickerView(i)`. */
function aimScene(page, scene) {
  return page.evaluate(
    ({ scene, panM }) => {
      const s = window.__flickerScenes[scene];
      window.__flickerView = (i) => {
        const dx = scene === "pan" ? i * panM : 0;
        return {
          eye: { x: s.eye.x + dx, y: s.eye.y, z: s.eye.z },
          at: { x: s.at.x + dx, y: s.at.y, z: s.at.z },
        };
      };
      window.__flickerPrev = null;
      window.__ab.qaCamera(window.__flickerView(0));
    },
    { scene, panM: PAN_M },
  );
}

/** Read the canvas, luminance it, diff against the previous frame. */
function readFrame(page) {
  return page.evaluate(() => {
    const src = document.querySelector("canvas");
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
    if (prev) {
      let sum = 0;
      for (let j = 0; j < lum.length; j++) sum += Math.abs(lum[j] - prev[j]);
      delta = sum / lum.length;
    }
    window.__flickerPrev = lum;
    return { delta, mean: mean / lum.length };
  });
}

async function measureBuild(browser, label, cwd, frames) {
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
    // Hold the plane high and still, so it can neither die nor drift; the
    // view itself comes from qaCamera.
    await page.evaluate(() => {
      const pin = () => {
        window.__ab.teleport(1000, 1300, 520, 0);
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
    await page.evaluate(() => {
      window.__flickerHoldNet = true;
    });
    await page.clock.pauseAt(Date.now() + 1000);

    const result = { label, weather, errors };
    for (const scene of Object.keys(SCENES)) {
      await aimScene(page, scene);
      // Two settle steps on the new view before the first captured frame.
      for (let i = 0; i < 2; i++) await page.clock.runFor(STEP_MS);
      const deltas = [];
      const means = [];
      for (let i = 0; i < frames; i++) {
        await page.evaluate(
          (i) => window.__ab.qaCamera(window.__flickerView(i)),
          i,
        );
        await page.clock.runFor(STEP_MS);
        const f = await readFrame(page);
        means.push(f.mean);
        if (f.delta !== null) deltas.push(f.delta);
      }
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      result[scene] = {
        score: Math.round(mean * 1000) / 1000,
        deltas: deltas.map((d) => Math.round(d * 1000) / 1000),
        meanLuma:
          Math.round((means.reduce((a, b) => a + b, 0) / means.length) * 10) /
          10,
      };
      // A black or blank capture scores 0 — the calmest possible — and would
      // pass any verdict. Refuse it instead.
      if (result[scene].meanLuma < 2) {
        throw new Error(
          `${label} ${scene}: frames are black (mean luma ${result[scene].meanLuma})`,
        );
      }
    }
    result.alive = await page.evaluate(() => window.__ab.combat().alive);
    return result;
  } finally {
    await page.close().catch(() => {});
    proc.kill();
  }
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
    report.head = await measureBuild(browser, "HEAD", REPO, opts.frames);
    if (ref !== null) {
      report.ref = await measureBuild(browser, ref.label, ref.dir, opts.frames);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const line = (r) =>
    `${r.label.padEnd(12)} frozen ${r.frozen.score.toFixed(3).padStart(7)}   pan ${r.pan.score.toFixed(3).padStart(7)}   ` +
    `(luma ${r.frozen.meanLuma}/${r.pan.meanLuma}, alive ${r.alive ? "yes" : "NO"})`;
  console.log(
    `\nflicker — mean |Δluma| per pixel per 1/60 s step, ${opts.frames} frames, ${VIEWPORT.width}x${VIEWPORT.height}`,
  );
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
