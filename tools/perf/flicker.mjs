#!/usr/bin/env node
// Temporal flicker metric (O1's, committed by O3 so it can be re-run).
//
//     node tools/perf/flicker.mjs [--ref <git-ref>] [--frames 30] [--no-build]
//                                 [--shots <dir>] [--out <file>] [--repeat N]
//                                 [--grid] [--only name,name]
//                                 [--ablate [all|name,name]] [--hide name,name]
//                                 [--breathe]
//
// Captures FRAMES consecutive frames on a FIXED 16 ms clock and scores the
// mean per-pixel frame-to-frame luminance change (0–255 units; lower is
// calmer). Two scenes:
//
//  - `frozen` — the camera pinned, the world advancing 16 ms a frame. With
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
// `--ablate` (O6, with --grid) attributes a view's frozen score to the
// scene's systems: after the normal captures it re-shoots the SAME frozen
// capture (same world instant, same steps) once with nothing hidden, once
// per system with only that system hidden (`__ab.qaHide`, re-applied every
// frame so streamed children stay hidden), and once with every named
// system hidden — what is left is "everything else". A system's share is
// how far the score falls without it. Shares are not additive: hiding an
// opaque mesh reveals what was behind it.
//
// `--hide` (O6, with --grid) keeps the named systems out of EVERY capture
// (and every ablation row): a view's score without, say, the train that
// happens to cross it, to see what else moves there.
//
// `--breathe` (O6, with --grid) ramps the held airspeed through every
// capture (BREATHE: +0.06 m/s a frame from 70 m/s), so the speed-driven FOV
// widens ~0.005° a frame — what the harness did by accident before O6, now
// on purpose and identical in every arm. A truly frozen camera cannot see
// anything that is stable while still but re-rolls under ANY change of
// projection (O6's facade speckle); a breathing one can.
//
// `FLICKER_WEATHER=<phase>` (R3) pins the middle of that weather phase
// instead of clear-and-dry, e.g. `downpour` to score the rain against the
// same views in clear weather — run it against the SAME build twice, never a
// ref older than L4.
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
/**
 * Frame step, ms — the fake clock ticks exactly this per captured frame.
 * 16, not 1000/60 (O6): Playwright's fake clock fires requestAnimationFrame
 * on a 16 ms grid, so a 16.67 ms step crossed TWO frame boundaries once
 * every 24 steps. That step rendered two frames, the world moved twice as
 * far, and a third of all captures carried one step ~1.6x its neighbours
 * (pose-19: 0.75 → 1.24 → 0.75, on a different step every run).
 */
const STEP_MS = 16;
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
/** The held plane's airspeed, m/s: MAX_SPEED, full-throttle cruise (O6 —
 * any one value works; what matters is that it never changes). */
const PIN_SPEED = 90;
/** --breathe: the held airspeed at a capture's first frame, and its rise
 * per frame, m/s — a plane spooling up toward cruise. */
const BREATHE = { from: 70, step: 0.06 };
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
const GRID_PAN_FRAMES = 8;
/** --grid: frames with camera AND world frozen. */
const GRID_STILL_FRAMES = 4;
/** --grid: steps on a new view before the first captured frame — time for
 * the streamed detail around a teleported camera to land. */
const GRID_SETTLE = 30;
/** --ablate: steps before each re-shot capture (the view is already
 * streamed in; these only let a hidden system's last frame clear). */
const ABLATE_SETTLE = 4;
/** A pixel whose luma moved more than this in one step is `hot`. */
const HOT_DELTA = 8;
/**
 * `jitter`: the share of pixels whose step changes SIGN at least twice in
 * a capture (brighter, darker, brighter …), counting steps over this many
 * luma units. A thing moving through a pixel at 60 fps brightens it then
 * darkens it — one reversal; shimmer, z-fighting, a popping LOD or a
 * strobing light keep reversing. It separates flicker from the city's own
 * motion (traffic, trains, sweeps), which `score` and `hot` cannot.
 */
const JITTER_DELTA = 2;
/**
 * --grid: the verdict's absolute ceiling for a frozen view, O1's merged
 * threshold: the O3 gate's limit for the midtown frozen view against main
 * (0.041, tools/perf/README.md "Shimmer") — the calmest any frozen view
 * of the game has been required to be.
 */
export const GRID_CEILING = 0.041;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** FLICKER_WEATHER: a phase to pin instead of clear-and-dry (null: clear). */
const WEATHER = process.env.FLICKER_WEATHER || null;

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
    ablate: null,
    hide: [],
    breathe: false,
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
    else if (a === "--hide") opts.hide = argv[++i].split(",");
    else if (a === "--breathe") opts.breathe = true;
    else if (a === "--ablate") {
      const next = argv[i + 1];
      opts.ablate =
        next === undefined || next.startsWith("--") || next === "all"
          ? "all"
          : next.split(",");
      if (next !== undefined && !next.startsWith("--")) i++;
    } else throw new Error(`unknown flag ${a}`);
  }
  if (!(opts.frames >= 3)) throw new Error("--frames must be >= 3");
  if (opts.ablate && !opts.grid) throw new Error("--ablate needs --grid");
  if (opts.breathe && !opts.grid) throw new Error("--breathe needs --grid");
  if (opts.hide.length > 0 && !opts.grid)
    throw new Error("--hide needs --grid");
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
        // W1: no carrier war — an empty sky is the only reproducible one.
        AB_WAVES: "0",
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
    ({ spec, panM, breathe }) => {
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
      window.__flickerHeat?.fill(0);
      // --breathe: every view's ramp starts here, so its settle steps hold
      // `from` and a re-shot (--ablate) breathes exactly like the original.
      if (window.__flickerBreathe) {
        window.__flickerBreatheN = 0;
        window.__flickerSpeed = breathe.from;
      }
      window.__flickerPin = spec.plane ?? { x: spec.eye.x, z: spec.eye.z };
      window.__ab.qaCamera(window.__flickerView(0));
    },
    { spec, panM, breathe: BREATHE },
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
  return page.evaluate(
    ([hotDelta, jitterDelta]) => {
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
        // Per-pixel |Δ| summed over the capture: the --shots heat map.
        let heat = window.__flickerHeat;
        if (!heat || heat.length !== lum.length) {
          heat = new Float32Array(lum.length);
          window.__flickerHeat = heat;
        }
        // Jitter: per-pixel sign reversals of the step (see JITTER_DELTA).
        let jit = window.__flickerJit;
        if (!jit || jit.sign.length !== lum.length) {
          jit = {
            sign: new Int8Array(lum.length),
            rev: new Uint8Array(lum.length),
          };
          window.__flickerJit = jit;
        }
        for (let j = 0; j < lum.length; j++) {
          const s = lum[j] - prev[j];
          const d = Math.abs(s);
          sum += d;
          heat[j] += d;
          if (d > hotDelta) n++;
          if (d > jitterDelta) {
            const sg = s > 0 ? 1 : -1;
            if (jit.sign[j] === -sg && jit.rev[j] < 255) jit.rev[j]++;
            jit.sign[j] = sg;
          }
        }
        delta = sum / lum.length;
        hot = n / lum.length;
      }
      window.__flickerPrev = lum;
      return { delta, hot, mean: mean / lum.length };
    },
    [HOT_DELTA, JITTER_DELTA],
  );
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
  // Each capture's heat map and jitter count are its own.
  await page.evaluate(() => {
    window.__flickerHeat?.fill(0);
    window.__flickerJit?.sign.fill(0);
    window.__flickerJit?.rev.fill(0);
  });
  for (let i = 0; i < frames; i++) {
    await page.evaluate(
      ([i, breathe]) => {
        window.__ab.qaCamera(window.__flickerView(i));
        if (window.__flickerHide) window.__ab.qaHide(window.__flickerHide);
        if (window.__flickerStill != null)
          window.__ab.pinWorld(window.__flickerStill);
        // --breathe: one more step up the ramp aimView started (the pin
        // applies it from the next frame, so frame 0 draws at `from`).
        if (window.__flickerBreathe) {
          window.__flickerBreatheN += 1;
          window.__flickerSpeed =
            breathe.from + breathe.step * window.__flickerBreatheN;
        }
      },
      [i, BREATHE],
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
    // --shots: where it moved — the summed |Δ| of the whole capture over a
    // dimmed copy of the last frame (red = moved), to find what flickers.
    if (shots && i === frames - 1) {
      const png = await page.evaluate(() => {
        const c = window.__flickerCanvas;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const heat = window.__flickerHeat;
        for (let j = 0, k = 0; j < heat.length; j++, k += 4) {
          const h = Math.min(255, heat[j] * 8);
          img.data[k] = Math.max(img.data[k] * 0.35, h);
          img.data[k + 1] *= 0.35;
          img.data[k + 2] *= 0.35;
        }
        const out = document.createElement("canvas");
        out.width = c.width;
        out.height = c.height;
        out.getContext("2d").putImageData(img, 0, 0);
        return out.toDataURL("image/png");
      });
      writeFileSync(
        resolve(shots, `${tag.replace(/\W+/g, "-")}-heat.png`),
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
  const jitter = await page.evaluate(() => {
    const rev = window.__flickerJit?.rev;
    if (!rev) return 0;
    let n = 0;
    for (let j = 0; j < rev.length; j++) if (rev[j] >= 2) n++;
    return n / rev.length;
  });
  // Relative to the view's own typical step: a pan moves ~6 a step by
  // itself, a frozen view ~0.1, and a flash jumps far above either.
  const typical = [...deltas].sort((x, y) => x - y)[
    Math.floor(deltas.length / 2)
  ];
  return {
    score: Math.round(avg(deltas) * 1000) / 1000,
    hot: Math.round(avg(hots) * 1e5) / 1e5,
    jitter: Math.round(jitter * 1e5) / 1e5,
    deltas: deltas.map((d) => Math.round(d * 1000) / 1000),
    meanLuma: Math.round(avg(means) * 10) / 10,
    flash: deltas.some((d) => d > Math.max(FLASH_DELTA, 3 * typical)),
  };
}

/**
 * --ablate: the view's frozen capture again, from the same world instant,
 * with `hide` taken out of the scene (re-applied every step), then back to
 * hiding only `--hide`'s `base`.
 */
async function ablatedFrozen(page, v, hide, base, shots, tag) {
  await page.evaluate(
    ({ v, hide, lead }) => {
      window.__flickerHide = hide;
      window.__ab.qaHide(hide);
      // The frozen capture's own first instant, a few steps early: the
      // camera is already here, so nothing has to stream in again.
      window.__ab.pinWorld(v.timeMs + lead);
    },
    { v, hide, lead: (GRID_SETTLE - ABLATE_SETTLE) * STEP_MS },
  );
  await aimView(page, { eye: v.eye, at: v.at, right: null, plane: v.plane });
  for (let i = 0; i < ABLATE_SETTLE; i++) {
    await page.evaluate(() => window.__ab.qaHide(window.__flickerHide));
    await page.clock.runFor(STEP_MS);
  }
  const r = await captureFrames(page, GRID_FRAMES, shots, tag);
  await page.evaluate((base) => {
    window.__flickerHide = base;
    window.__ab.qaHide(base);
  }, base);
  return r;
}

async function measureBuild(
  browser,
  label,
  cwd,
  frames,
  shots,
  grid,
  ablate,
  hide,
  breathe,
) {
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
    // Hold the plane still right above the scene's eye, so it can neither
    // die nor drift and the city streams around the view; the view itself
    // comes from qaCamera. 330 m: crash-proof (over every roof) and well
    // under the cloud deck — the atmosphere is computed from the PLANE's
    // altitude, and inside the deck its fog hides the whole city.
    // And at ONE airspeed (O6): the view's FOV widens with airspeed, and
    // teleport keeps whatever speed the plane had, so a plane still spooling
    // up toward cruise zoomed every "frozen" frame a hair wider than the
    // last — moiré crawling over any fine facade near the eye (intersection
    // read 1.26 with the WORLD pinned too), and a score that swung with how
    // far the spool-up had got (the same view 1.46 one run, 4.6 the next).
    // Set on the state rather than passed to teleport, so a --ref build
    // from before O6 is held the same way.
    await page.evaluate((speed) => {
      window.__flickerPin = { x: 1000, z: 1500 };
      const pin = () => {
        const p = window.__flickerPin;
        window.__ab.teleport(p.x, p.z, p.y ?? 330, 0);
        window.__ab.state().speed = window.__flickerSpeed ?? speed;
        requestAnimationFrame(pin);
      };
      pin();
    }, PIN_SPEED);
    await page.waitForFunction(
      () =>
        window.__ab.net().renderTime !== null &&
        window.__ab.combat().targets.length === 0,
      null,
      { timeout: 120_000, polling: 500 },
    );
    // Clear AND dry (wetness lags rain and dries through the first 60 % of
    // the clear phase): 90 s past mid-clear is past that on any cycle.
    const weather = await page.evaluate((pin) => {
      const ab = window.__ab;
      if (typeof ab.weather !== "function")
        return { phase: "none", wetness: 0 };
      if (pin) return ab.weather(pin);
      const mid = ab.weather("clear");
      return ab.weather(mid.timeMs + 90_000);
    }, WEATHER);
    if (WEATHER && weather.phase !== WEATHER) {
      throw new Error(`could not pin ${WEATHER}: ${JSON.stringify(weather)}`);
    }
    if (
      !WEATHER &&
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
      if (breathe) {
        await page.evaluate(() => {
          window.__flickerBreathe = true;
        });
      }
      if (hide.length > 0) {
        const all = await page.evaluate(
          () => window.__ab.qaSystems?.() ?? null,
        );
        if (all === null) throw new Error(`${label} has no __ab.qaHide`);
        const unknown = hide.filter((n) => !all.includes(n));
        if (unknown.length > 0)
          throw new Error(`--hide: no system ${unknown.join(", ")}`);
        // captureFrames re-applies it every step.
        await page.evaluate((hide) => {
          window.__flickerHide = hide;
          window.__ab.qaHide(hide);
        }, hide);
      }
      for (const v of grid) {
        // Its own world instant, sky phase and clear-dry weather, then the
        // plane over its eye (the city streams around the plane).
        const wx = await page.evaluate(
          ({ v, pin }) => {
            const ab = window.__ab;
            ab.pinWorld(v.timeMs);
            ab.sky(v.sky);
            if (typeof ab.weather !== "function") return { phase: "none" };
            if (pin) return ab.weather(pin);
            const mid = ab.weather("clear");
            return ab.weather(mid.timeMs + 90_000);
          },
          { v, pin: WEATHER },
        );
        // DT1: pose the view's planes (or clear the last view's); a build
        // without the hook just shows the empty sky.
        await page.evaluate(
          (list) => window.__ab.planeShowcase?.(list),
          v.showcase ?? null,
        );
        const still = { eye: v.eye, at: v.at, right: null, plane: v.plane };
        await aimView(page, still, PAN_M);
        for (let i = 0; i < GRID_SETTLE; i++) await page.clock.runFor(STEP_MS);
        const frozen = await captureFrames(
          page,
          GRID_FRAMES,
          shots,
          `${label}-${v.name}-frozen`,
        );
        // STILL: camera AND world frozen (the world re-pinned to one instant
        // every frame), so anything that still moves is not animation at
        // all — per-frame noise, a scaler step, a frame-time-driven state.
        const stillAt = await page.evaluate(() => window.__ab.net().renderTime);
        const stillMs = v.timeMs + (GRID_SETTLE + GRID_FRAMES) * STEP_MS;
        await page.evaluate((t) => {
          window.__flickerStill = t;
        }, stillMs);
        const frozenWorld = await captureFrames(
          page,
          GRID_STILL_FRAMES,
          shots,
          `${label}-${v.name}-still`,
        );
        await page.evaluate(() => {
          window.__flickerStill = null;
        });
        await aimView(
          page,
          { eye: v.eye, at: v.at, right: v.right, plane: v.plane },
          PAN_M,
        );
        for (let i = 0; i < 2; i++) await page.clock.runFor(STEP_MS);
        const pan = await captureFrames(
          page,
          GRID_PAN_FRAMES,
          shots,
          `${label}-${v.name}-pan`,
        );
        let ablation = null;
        if (ablate) {
          const all = await page.evaluate(() =>
            typeof window.__ab.qaSystems === "function"
              ? window.__ab.qaSystems()
              : null,
          );
          if (all === null) throw new Error(`${label} has no __ab.qaHide`);
          const named = all.filter((n) => !n.startsWith("other:"));
          const systems = ablate === "all" ? all : ablate;
          const unknown = systems.filter((n) => !all.includes(n));
          if (unknown.length > 0)
            throw new Error(`--ablate: no system ${unknown.join(", ")}`);
          const tag = (n) => `${label}-${v.name}-ablate-${n}`;
          const base = await ablatedFrozen(
            page,
            v,
            hide,
            hide,
            shots,
            tag("none"),
          );
          ablation = { none: base.score, deltas: base.deltas, systems: [] };
          for (const n of systems.filter((n) => !hide.includes(n))) {
            const r = await ablatedFrozen(
              page,
              v,
              [...hide, n],
              hide,
              shots,
              tag(n),
            );
            ablation.systems.push({
              name: n,
              score: r.score,
              jitter: r.jitter,
              deltas: r.deltas,
              share: Math.round((base.score - r.score) * 1000) / 1000,
            });
          }
          const rest = await ablatedFrozen(
            page,
            v,
            [...new Set([...hide, ...named])],
            hide,
            shots,
            tag("rest"),
          );
          ablation.everythingElse = rest.score;
          ablation.systems.sort((a, b) => b.share - a.share);
          console.log(
            `  ${label} ${v.name} ablation: none ${base.score.toFixed(3)}, everything else ${rest.score.toFixed(3)}; top: ${ablation.systems
              .slice(0, 6)
              .map((s) => `${s.name} ${s.share.toFixed(3)}`)
              .join(", ")}`,
          );
        }
        const alive = await page.evaluate(() => window.__ab.combat().alive);
        result.views.push({
          ablation,
          name: v.name,
          timeMs: v.timeMs,
          weather: { phase: wx.phase, wetness: wx.wetness ?? 0 },
          alive,
          frozen,
          still: frozenWorld,
          pan,
          rt: stillAt,
        });
        console.log(
          `  ${label} ${v.name.padEnd(18)} frozen ${frozen.score.toFixed(3)} hot ${(frozen.hot * 100).toFixed(2)}% jitter ${(frozen.jitter * 100).toFixed(3)}% (pan ${(pan.jitter * 100).toFixed(2)}%)  still ${frozenWorld.score.toFixed(3)}  pan ${pan.score.toFixed(3)}${frozen.flash || pan.flash ? "  FLASH" : ""}${frozen.meanLuma < 2 ? "  BLACK" : ""}`,
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

/** A run's frozen score: the classic view's, or the grid's sum. */
const runScore = (r) =>
  r.views ? r.views.reduce((a, v) => a + v.frozen.score, 0) : r.frozen.score;

/** The run whose frozen score is the median (a whole run, never a mix). */
function medianRun(runs) {
  const sorted = [...runs].sort((a, b) => runScore(a) - runScore(b));
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The O5 per-view verdict, frozen camera: a view that shimmered before
 * (ref above the tool's own resolution, TOLERANCE.abs) must at least halve;
 * a calm one must stay calm (verdict() — not worse). Every view must also
 * sit under GRID_CEILING. A view whose capture caught a flash or came back
 * black is not judged (and fails the run: it measured nothing).
 */
export function gridViewVerdict(head, ref) {
  const halved = ref > TOLERANCE.abs ? head <= ref * 0.5 : true;
  const notWorse = verdict(head, ref).pass;
  const ceiling = head <= GRID_CEILING;
  return { pass: halved && notWorse && ceiling, halved, notWorse, ceiling };
}

/** --ablate: each view's per-system table, largest share first. */
function printAblation(report) {
  for (const h of report.head.views) {
    const a = h.ablation;
    if (!a) continue;
    console.log(
      `\nablation — ${h.name}: frozen ${a.none.toFixed(3)} with everything drawn; ${a.everythingElse.toFixed(3)} with every named system hidden ("everything else")`,
    );
    console.log(
      `${"system".padEnd(20)} ${"hidden".padStart(7)} ${"share".padStart(7)} ${"jitter".padStart(7)}`,
    );
    for (const s of a.systems) {
      if (s.share < TOLERANCE.abs && a.systems.indexOf(s) >= 8) continue;
      console.log(
        `${s.name.padEnd(20)} ${s.score.toFixed(3).padStart(7)} ${s.share.toFixed(3).padStart(7)} ${`${(s.jitter * 100).toFixed(2)}%`.padStart(7)}`,
      );
    }
  }
}

function printGrid(report) {
  const head = report.head;
  const ref = report.ref ?? null;
  const pct = (h) => `${(h * 100).toFixed(2)}%`.padStart(7);
  console.log(
    `\nflicker grid — mean |Δluma| per pixel per 16 ms step (hot = share of pixels moving > ${HOT_DELTA}), ${VIEWPORT.width}x${VIEWPORT.height}`,
  );
  console.log(
    ref
      ? `${"view".padEnd(18)} ${"frozen ref".padStart(10)} ${"→ HEAD".padStart(7)}  ${"hot ref".padStart(7)} ${"→ HEAD".padStart(7)}  ${"jit ref".padStart(7)} ${"→ HEAD".padStart(7)}  ${"panjit".padStart(7)} ${"→ HEAD".padStart(7)}  ${"still ref".padStart(9)} ${"→ HEAD".padStart(7)}  ${"pan ref".padStart(7)} ${"→ HEAD".padStart(7)}  verdict`
      : `${"view".padEnd(18)} ${"frozen".padStart(7)} ${"hot".padStart(7)} ${"jitter".padStart(7)} ${"panjit".padStart(7)} ${"still".padStart(7)} ${"pan".padStart(7)}`,
  );
  let pass = true;
  const rows = [];
  for (const h of head.views) {
    const r = ref?.views.find((v) => v.name === h.name) ?? null;
    const bad = (v) =>
      v.frozen.flash || v.pan.flash || v.frozen.meanLuma < 2 || !v.alive;
    if (!r) {
      console.log(
        `${h.name.padEnd(18)} ${h.frozen.score.toFixed(3).padStart(7)} ${pct(h.frozen.hot)} ${pct(h.frozen.jitter ?? 0)} ${pct(h.pan.jitter ?? 0)} ${h.still.score.toFixed(3).padStart(7)} ${h.pan.score.toFixed(3).padStart(7)}${bad(h) ? "  INVALID" : ""}`,
      );
      continue;
    }
    const v = gridViewVerdict(h.frozen.score, r.frozen.score);
    const invalid = bad(h) || bad(r);
    if (invalid || !v.pass) pass = false;
    rows.push({ name: h.name, ...v, invalid });
    const why = invalid
      ? "INVALID (flash/black/dead)"
      : v.pass
        ? "PASS"
        : `FAIL${v.halved ? "" : " (not halved)"}${v.notWorse ? "" : " (worse)"}${v.ceiling ? "" : " (over ceiling)"}`;
    console.log(
      `${h.name.padEnd(18)} ${r.frozen.score.toFixed(3).padStart(10)} ${h.frozen.score.toFixed(3).padStart(7)}  ${pct(r.frozen.hot)} ${pct(h.frozen.hot)}  ${pct(r.frozen.jitter ?? 0)} ${pct(h.frozen.jitter ?? 0)}  ${pct(r.pan.jitter ?? 0)} ${pct(h.pan.jitter ?? 0)}  ${r.still.score.toFixed(3).padStart(9)} ${h.still.score.toFixed(3).padStart(7)}  ${r.pan.score.toFixed(3).padStart(7)} ${h.pan.score.toFixed(3).padStart(7)}  ${why}`,
    );
  }
  if (ref) {
    report.gridVerdict = { pass, rows };
    console.log(
      `\ngrid: ${rows.filter((r) => r.pass && !r.invalid).length}/${rows.length} views pass — ${pass ? "PASS" : "FAIL"} (frozen: halve any view over ${TOLERANCE.abs}, never worse, none over ${GRID_CEILING}; pan is indicative)`,
    );
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
    // Interleaved (HEAD, ref, HEAD, ref, …) so any drift on the box lands
    // in both builds; the verdict is taken on the medians.
    const runs = { head: [], ref: [] };
    // --grid: the views and their world instants, identical for both builds.
    let grid = null;
    if (opts.grid) {
      const { gridViews } = await import("./flicker-grid.mjs");
      grid = gridViews(EPOCH_MS + CAPTURE_AT_MS + 60_000).filter(
        (v) => opts.only === null || opts.only.includes(v.name),
      );
      report.grid = grid;
    }
    for (let r = 0; r < opts.repeat; r++) {
      runs.head.push(
        await measureBuild(
          browser,
          "HEAD",
          REPO,
          opts.frames,
          opts.shots,
          grid,
          opts.ablate,
          opts.hide,
          opts.breathe,
        ),
      );
      if (ref !== null) {
        runs.ref.push(
          await measureBuild(
            browser,
            ref.label,
            ref.dir,
            opts.frames,
            opts.shots,
            grid,
            opts.ablate,
            opts.hide,
            opts.breathe,
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
  if (opts.grid) {
    printGrid(report);
    printAblation(report);
    const out = opts.out ?? resolve(HERE, "flicker-grid-last.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${out}`);
    if (report.gridVerdict && !report.gridVerdict.pass) process.exitCode = 1;
    return;
  }

  const line = (r) =>
    `${r.label.padEnd(12)} frozen ${r.frozen.score.toFixed(3).padStart(7)}   pan ${r.pan.score.toFixed(3).padStart(7)}   ` +
    `(luma ${r.frozen.meanLuma}/${r.pan.meanLuma}, alive ${r.alive ? "yes" : "NO"})`;
  console.log(
    `\nflicker — mean |Δluma| per pixel per 16 ms step, ${opts.frames} frames, ${VIEWPORT.width}x${VIEWPORT.height}`,
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
