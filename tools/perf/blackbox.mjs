#!/usr/bin/env node
// O7 black-box detector: transient black rectangles, anywhere, on any device.
//
//     node tools/perf/blackbox.mjs [--device desktop|retina|phone|all]
//                                  [--sky night,dusk] [--paths a,b]
//                                  [--frames N] [--repeat N] [--shots <dir>]
//                                  [--attribute] [--no-build] [--out <file>]
//                                  [--list]
//
// What players reported (2026-10-09) are black squares that flash for a
// frame or a few — in the tunnels, the sky and clouds, near buildings, on a
// phone. flicker.mjs cannot see them: it holds a FROZEN camera and scores
// mean |Δluma|, and one 40 px square for two frames is noise in a mean.
// This tool flies a MOVING plane and camera along scripted paths (the perf
// harness's segments, every tunnel bore end to end, a climb through the
// cloud deck), at night and at dusk, and judges EVERY frame two ways:
//
//  1. The NaN/Inf probe (`?nanprobe`, client/src/render/nanprobe.ts): every
//     HDR scene pixel classified by its float bits right after the scene
//     render, before bloom. A non-finite pixel is what a black box is made
//     of (the bloom chain smears it into a square that grows with the mip),
//     so ANY count is a failure. Negative pixels are reported, never failed.
//  2. The image itself (what the player sees, after bloom, tone map and the
//     grade), in CELL_CSS_PX cells of mean luma: a cell is DROPPED on frame t
//     when it is near-black (≤ DARK) AND at least DROP darker than the
//     brightest it was over the BEFORE frames before and the AFTER frames
//     after — a flash of black that came and went within three frames. A
//     BOX is a 4-connected group of ≥ MIN_CELLS dropped cells filling ≥ FILL
//     of its bounding rectangle: blocky and axis-aligned, which a dark
//     object passing through never is for long.
//
// Positive control (every profile × sky, first): `__ab.nanInject()` writes a
// 48×48 HDR-1.0 patch for 7 frames with a 16×16 NaN core on the middle one.
// The probe must count exactly 256 NaN pixels there AND the detector must
// flag a box on that frame, or the run fails: a detector that is blind
// reports 0 boxes too. The control's frame is never counted as a finding.
//
// Determinism: the server runs on one fixed epoch (fixed-epoch.mjs) with the
// quiet city (staged destruction only), the page's clock is Playwright's
// fake clock stepped exactly STEP_MS per frame, every path pins the world
// clock (`__ab.pinWorld`), its weather and its sky moment, and every frame's
// pose is a pure function of its index. Two runs of one build fly the same
// frames; `--repeat` says whether they also SEE the same frames.
//
// Profiles (`--device`), all on the shipped `aa=off`:
//   desktop  640×360 CSS at ratio 1 (High)
//   retina   640×360 CSS at ratio 2 (High) — the bloom's density > 1 path
//            (AbBloomPass box-filters its bright pass), the M3's
//   phone    844×390 CSS, touch, Mobile tier at ratio 1 — the phone's tier
//            (half-float targets like every profile: the composer's scene
//            target is RGBA16F everywhere)
//
// `--attribute`: for the first probe hit in a path, re-pose that exact frame
// (same pose, world clock pinned to its instant, same weather and sky) and
// hide each `__ab.qaHide` system in turn: the systems whose absence clears
// the hit are its source. A hit that does not reproduce with nothing hidden
// is reported as such (an RNG- or dt-driven particle) and not attributed.
//
// Exit 1 on any box or non-finite pixel, or a failed positive control.
// Same browser knobs as run.mjs: AB_CHROME / AB_CHROME_ARGS. On the M3:
// `node tools/perf/blackbox.mjs --device all --repeat 3` (Metal is
// run.mjs's default). On a GPU-less Linux box:
// AB_CHROME_ARGS="--use-angle=swiftshader --enable-unsafe-swiftshader".

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SEGMENTS } from "./segments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const FIXED_EPOCH = resolve(HERE, "fixed-epoch.mjs");

/** The fixed server epoch, and the world instant the first path starts at. */
const EPOCH_MS = 1_900_000_000_000;
/** Each path's own world instant: EPOCH + WORLD_START + index × WORLD_STEP. */
const WORLD_START_MS = 60_000;
const WORLD_STEP_MS = 40_000;
/** Fake-clock step per frame, ms (16, not 16.67: see flicker.mjs STEP_MS). */
const STEP_MS = 16;
/** Frames on a path's first pose before judging starts (streaming lands). */
const SETTLE = 24;
/** Frames judged per path unless --frames says otherwise. */
const DEFAULT_FRAMES = 150;
/** A held path's camera pans this much yaw per frame (rad): a moving view. */
const PAN_RAD = 0.003;
/** The held plane's airspeed, m/s (the FOV follows it; never let it drift). */
const PIN_SPEED = 90;

// --- The detector (named so a reader can argue with every number) --------
/** Cell edge in CSS px (× the pixel ratio in drawing-buffer px). */
export const CELL_CSS_PX = 4;
/** Near-black: cell mean luma (0–255, sRGB bytes) at or below this. The
 * grade's lifted floor is ~5; a NaN pixel reads 0 or the floor. */
export const DARK = 12;
/** A dropped cell is at least this much darker than the brightest of the
 * frames around it, on both sides. */
export const DROP = 24;
/** Frames compared on each side of the judged frame. */
export const BEFORE = 3;
export const AFTER = 3;
/** A box: at least this many connected dropped cells … */
export const MIN_CELLS = 4;
/** … filling at least this share of their bounding rectangle. */
export const FILL = 0.5;

const PROFILES = {
  desktop: {
    page: {
      viewport: { width: 640, height: 360 },
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
    },
    query: "res=1&quality=high",
  },
  retina: {
    page: {
      viewport: { width: 640, height: 360 },
      deviceScaleFactor: 2,
      hasTouch: false,
      isMobile: false,
    },
    query: "res=2&quality=high",
  },
  phone: {
    page: {
      viewport: { width: 844, height: 390 },
      deviceScaleFactor: 3,
      hasTouch: true,
      isMobile: true,
    },
    query: "res=1&quality=mobile",
  },
};
const SKIES = ["night", "dusk"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Paths -----------------------------------------------------------------

/**
 * Every path the tool flies. A path is a perf segment (segments.mjs: its
 * spot, staging and weather) flown frame-indexed, a tunnel bore glided end
 * to end, or the cloud-deck climb. `pose(i)` is evaluated IN THE PAGE (it is
 * serialised), so it may only use its argument and `window.__ab`.
 */
function buildPaths(tunnelCount) {
  const paths = [];
  // Fake pilots are a live sim (never the same frame twice); the boss and
  // the ruins are staged without them.
  const segs = SEGMENTS.filter((s) => s.name !== "furball");
  for (const s of segs) {
    let kind = "flown";
    if (s.tunnel) kind = "tunnel";
    else if (s.glide) kind = "glide";
    else if (s.hold) kind = "hold";
    paths.push({ name: s.name, what: s.what, kind, seg: s });
  }
  for (let id = 0; id < tunnelCount; id++) {
    paths.push({
      name: `bore${id}`,
      what: `U4/U5: tunnel ${id} glided end to end — portals, caverns, gardens, water`,
      kind: "bore",
      seg: { tunnelId: id },
    });
  }
  paths.push({
    name: "deck",
    what: "climbing through the cloud deck (base 500 m) toward the storm ceiling",
    kind: "climb",
    seg: { x: 700, z: 1300, yaw: 0.6, from: 380, to: 590 },
  });
  return paths;
}

// --- Page side -------------------------------------------------------------

/** Runs in the page before any game code: readable frames. */
function initScript() {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === "webgl2" || type === "webgl") {
      window.__bbGls = [...(window.__bbGls ?? []), this];
      return getContext.call(this, type, {
        ...(attrs ?? {}),
        preserveDrawingBuffer: true,
      });
    }
    return getContext.call(this, type, attrs);
  };
}

/**
 * The in-page analyzer, installed once after join. Every frame (through
 * `__ab.qaAfterRender`) it reads the canvas into a grid of cell lumas, keeps
 * a ring of BEFORE + 1 + AFTER grids, judges the middle one, and reads the
 * probe. Only the ring is kept — never a whole frame — so memory is bounded.
 */
function installAnalyzer(cfg) {
  const ab = window.__ab;
  const ring = [];
  const st = {
    path: null,
    frame: -1,
    judging: false,
    boxes: [],
    hits: [],
    negMax: 0,
    frames: 0,
    control: null,
  };
  window.__bb = st;
  const canvas = () =>
    (window.__bbGls ?? [])
      .filter((c) => c.isConnected)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  let scratch = null;
  const grid = () => {
    const src = canvas();
    const w = src.width;
    const h = src.height;
    if (!scratch || scratch.width !== w || scratch.height !== h) {
      scratch = document.createElement("canvas");
      scratch.width = w;
      scratch.height = h;
    }
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    const cell = Math.max(1, Math.round(cfg.cellCss * window.devicePixelRatio));
    const gw = Math.floor(w / cell);
    const gh = Math.floor(h / cell);
    const lum = new Float32Array(gw * gh);
    for (let y = 0; y < gh * cell; y++) {
      const row = Math.floor(y / cell) * gw;
      for (let x = 0; x < gw * cell; x++) {
        const i = (y * w + x) * 4;
        lum[row + Math.floor(x / cell)] +=
          0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      }
    }
    const n = cell * cell;
    for (let j = 0; j < lum.length; j++) lum[j] /= n;
    return { gw, gh, cell, lum, w, h };
  };
  /** Boxes on the middle grid of a full ring (cell coords → CSS px). */
  const judge = () => {
    const mid = ring[cfg.before];
    const { gw, gh, lum } = mid.g;
    const dropped = new Uint8Array(lum.length);
    for (let j = 0; j < lum.length; j++) {
      const l = lum[j];
      if (l > cfg.dark) continue;
      let pre = 0;
      for (let k = 0; k < cfg.before; k++)
        pre = Math.max(pre, ring[k].g.lum[j]);
      if (pre - l < cfg.drop) continue;
      let post = 0;
      for (let k = cfg.before + 1; k < ring.length; k++) {
        post = Math.max(post, ring[k].g.lum[j]);
      }
      if (post - l >= cfg.drop) dropped[j] = 1;
    }
    const out = [];
    const stack = [];
    for (let j = 0; j < dropped.length; j++) {
      if (dropped[j] !== 1) continue;
      dropped[j] = 2;
      stack.push(j);
      let n = 0;
      let x0 = gw;
      let y0 = gh;
      let x1 = -1;
      let y1 = -1;
      while (stack.length > 0) {
        const c = stack.pop();
        n++;
        const x = c % gw;
        const y = (c - x) / gw;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        const nb = [
          x > 0 ? c - 1 : -1,
          x < gw - 1 ? c + 1 : -1,
          y > 0 ? c - gw : -1,
          y < gh - 1 ? c + gw : -1,
        ];
        for (const q of nb) {
          if (q >= 0 && dropped[q] === 1) {
            dropped[q] = 2;
            stack.push(q);
          }
        }
      }
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (n >= cfg.minCells && n / area >= cfg.fill) {
        const css = cfg.cellCss;
        out.push({
          cells: n,
          x: x0 * css,
          y: y0 * css,
          w: (x1 - x0 + 1) * css,
          h: (y1 - y0 + 1) * css,
        });
      }
    }
    return out;
  };
  st.reset = (path) => {
    ring.length = 0;
    st.path = path;
    st.frame = -1;
    st.judging = false;
    st.boxes = [];
    st.hits = [];
    st.negMax = 0;
    st.frames = 0;
    st.shots = [];
  };
  /** Frame index the harness is about to draw (-1: settling, not judged). */
  st.at = (frame, judging) => {
    st.frame = frame;
    st.judging = judging;
  };
  ab.qaAfterRender(() => {
    if (st.path === null) return;
    const probe = ab.nanProbe();
    const g = grid();
    const png = cfg.shots ? scratch.toDataURL() : null;
    ring.push({ frame: st.frame, judging: st.judging, g, png });
    if (ring.length > cfg.before + 1 + cfg.after) ring.shift();
    if (st.judging && probe) {
      st.frames++;
      st.negMax = Math.max(st.negMax, probe.neg);
      if (probe.nan + probe.inf > 0) {
        const f = ab.state();
        st.hits.push({
          frame: st.frame,
          nan: probe.nan,
          inf: probe.inf,
          box: probe.box,
          world: ab.renderMs(),
          pose: { x: f.pos.x, y: f.pos.y, z: f.pos.z, yaw: f.yaw },
        });
        if (cfg.shots && st.shots.length < cfg.maxShots) {
          st.shots.push({ frame: st.frame, kind: "nan", png });
        }
      }
    }
    if (ring.length === cfg.before + 1 + cfg.after) {
      const mid = ring[cfg.before];
      if (mid.judging) {
        const boxes = judge();
        for (const b of boxes) st.boxes.push({ frame: mid.frame, ...b });
        if (boxes.length > 0 && cfg.shots && st.shots.length < cfg.maxShots) {
          st.shots.push({ frame: mid.frame, kind: "box", png: mid.png });
        }
      }
    }
  });
}

// --- Server ----------------------------------------------------------------

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
        // Staged destruction only (run.mjs's quiet city), and a liveness a
        // page stepping a fake clock on a software rasteriser can keep.
        AB_QUIET_CITY: "1",
        LIVENESS_TIMEOUT_MS: "3600000",
      },
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 120; i++) {
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

function run(cmd, args) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: REPO, stdio: "inherit" });
    p.on("exit", (c) =>
      c === 0 ? ok() : fail(new Error(`${cmd} exited ${c}`)),
    );
  });
}

// --- One profile -----------------------------------------------------------

async function joinProfile(browser, port, profile) {
  const page = await browser.newPage(profile.page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(initScript);
  // BEFORE goto: installing the fake clock later sends performance.now()
  // backwards and the sim goes NaN (flicker.mjs).
  await page.clock.install();
  await page.goto(
    `http://127.0.0.1:${port}/?nanprobe&gputime=0&${profile.query}`,
  );
  await page.fill("#join-name", "BLACKBOX");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => typeof window.__ab !== "undefined", null, {
    timeout: 180_000,
  });
  if ((await page.evaluate(() => window.__ab.nanProbe())) === null) {
    throw new Error("this build has no ?nanprobe (render/nanprobe.ts)");
  }
  await page.evaluate(() => window.__ab.setBots(0));
  await page.waitForFunction(
    () => window.__ab.combat().targets.length === 0,
    null,
    { timeout: 60_000, polling: 250 },
  );
  // Attitude hold (run.mjs joinGame): the cursor parked on Join would steer.
  await page.evaluate(() =>
    window.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null })),
  );
  // Streaming and first-sight compiles on the real clock, then freeze it:
  // from here on time only moves when a frame is stepped.
  await sleep(3000);
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1000);
  await page.clock.runFor(1000);
  return { page, errors };
}

const step = (page) => page.clock.runFor(STEP_MS);

/** Set a path up in the page (world, sky, weather, staging); its frame-0 pose. */
function setupPath(page, path, worldMs, sky, frames) {
  return page.evaluate(
    ({ path, worldMs, sky, frames, settle, stepMs, speed }) => {
      const ab = window.__ab;
      const s = path.seg;
      ab.pinWorld(worldMs);
      if (s.storm) {
        const next = ab.storm().nextStrike;
        // The scheduled strike lands a third of the way into the judged frames.
        if (next !== null) {
          ab.pinWorld(next.timeMs - (settle + frames / 3) * stepMs);
        }
      }
      ab.sky(sky);
      ab.weather(s.weather ?? "clear");
      const t0 = ab.net().worldTime ?? worldMs;
      const stageAt = (spec, base) =>
        JSON.parse(JSON.stringify(spec), (k, v) =>
          k === "t" && typeof v === "number" ? base + v : v,
        );
      const staged = { destruction: false, boss: false, chaos: false };
      if (s.stage) {
        ab.qaDestruction({ ...stageAt(s.stage, t0), keep: false });
        staged.destruction = true;
      }
      if (s.stageAtWindow) {
        // Mid-fall a third of the way into the judged frames.
        ab.qaDestruction({
          ...stageAt(s.stageAtWindow, t0 + (settle + frames / 3) * stepMs),
          keep: s.stage !== undefined,
        });
        staged.destruction = true;
      }
      if (s.boss) {
        staged.boss =
          ab.qaBoss({
            x: s.x,
            y: s.y,
            z: s.z,
            yaw: s.yaw,
            ahead: s.boss.ahead,
            worldMs: t0,
            crossMs: (settle + frames / 2) * stepMs,
            corridor: s.boss.corridor,
          }) !== null;
      }
      if (s.chaos) {
        staged.chaos =
          ab.qaChaos({
            x: s.x,
            y: s.y,
            z: s.z,
            yaw: s.yaw,
            worldMs: t0,
            ...s.chaos,
          }) !== null;
      }
      ab.state().speed = speed;
      return { staged, t0 };
    },
    {
      path,
      worldMs,
      sky,
      frames,
      settle: SETTLE,
      stepMs: STEP_MS,
      speed: PIN_SPEED,
    },
  );
}

/**
 * Pose frame `i` (negative while settling) of a path: teleport the plane
 * (the chase camera snaps behind it), or for a `flown` path only on its
 * first settle frame — after that the plane flies itself on the fake clock,
 * the same flight every run.
 */
function poseFrame(page, path, i, frames) {
  return page.evaluate(
    ({ path, i, frames, settle, stepMs, pan, speed }) => {
      const ab = window.__ab;
      const s = path.seg;
      const t = ((i + settle) * stepMs) / 1000; // s since the path's start
      const tp = (x, z, y, yaw) => {
        ab.teleport(x, z, y, yaw);
        ab.state().speed = speed;
      };
      if (path.kind === "flown") {
        if (i === -settle) tp(s.x, s.z, s.y, s.yaw);
      } else if (path.kind === "tunnel") {
        const d = Math.min(s.tunnel.maxM, s.tunnel.speed * t);
        const p = ab.tunnelPose(
          s.tunnel.id,
          s.tunnel.s,
          d,
          s.tunnel.climb ?? 0,
        );
        tp(p.x, p.z, p.y, p.yaw);
      } else if (path.kind === "glide") {
        const d = Math.min(s.glide.maxM, s.glide.speed * t);
        tp(s.x - Math.sin(s.yaw) * d, s.z - Math.cos(s.yaw) * d, s.y, s.yaw);
      } else if (path.kind === "hold") {
        tp(s.x, s.z, s.y, s.yaw + pan * (Math.max(0, i) - frames / 2));
      } else if (path.kind === "bore") {
        // The whole bore in `frames` judged frames, portal to portal.
        const len = ab.tunnels()[s.tunnelId].length;
        const d = (Math.max(0, i) / Math.max(1, frames - 1)) * len;
        const p = ab.tunnelPose(s.tunnelId, 0, d, 0);
        tp(p.x, p.z, p.y, p.yaw);
      } else if (path.kind === "climb") {
        const k = Math.max(0, i) / Math.max(1, frames - 1);
        tp(s.x, s.z, s.from + (s.to - s.from) * k, s.yaw);
      }
      window.__bb.at(i, i >= 0);
    },
    {
      path,
      i,
      frames,
      settle: SETTLE,
      stepMs: STEP_MS,
      pan: PAN_RAD,
      speed: PIN_SPEED,
    },
  );
}

function teardownPath(page) {
  return page.evaluate(() => {
    const ab = window.__ab;
    ab.qaDestruction(null);
    ab.qaBoss(null);
    ab.qaChaos(null);
    window.__bb.path = null;
  });
}

/** The positive control (see the header): the probe count and the box. */
async function positiveControl(page) {
  await page.evaluate(() => {
    window.__ab.teleport(1000, 1500, 300, 0);
    window.__bb.reset("control");
  });
  // A held view, then the control's 7 frames, then AFTER more to judge it.
  for (let i = 0; i < 10; i++) {
    await page.evaluate((i) => window.__bb.at(i, true), i);
    await step(page);
  }
  await page.evaluate(() => window.__ab.nanInject());
  for (let i = 10; i < 24; i++) {
    await page.evaluate((i) => window.__bb.at(i, true), i);
    await step(page);
  }
  const r = await page.evaluate(() => ({
    hits: window.__bb.hits,
    boxes: window.__bb.boxes,
  }));
  await page.evaluate(() => {
    window.__bb.path = null;
  });
  const core = r.hits.find((h) => h.nan >= 256);
  const coreFrame = core?.frame ?? null;
  const boxed =
    coreFrame !== null &&
    r.boxes.some((b) => Math.abs(b.frame - coreFrame) <= 1);
  return {
    ok: core !== undefined && core.nan === 256 && boxed,
    nan: core?.nan ?? 0,
    frame: coreFrame,
    boxed,
    boxes: r.boxes,
  };
}

/** --attribute: re-pose a probe hit and hide each system in turn. */
async function attribute(page, path, hit, frames, sky, worldMs) {
  await page.evaluate(() => window.__bb.reset("attribute"));
  await setupPath(page, path, worldMs, sky, frames);
  const reproduce = async (hide) => {
    await page.evaluate(
      ({ hide, world }) => {
        window.__ab.qaHide(hide);
        window.__ab.pinWorld(world - 2 * 16);
      },
      { hide, world: hit.world },
    );
    for (let k = 0; k < 3; k++) {
      await page.evaluate(
        ({ hide, p, speed }) => {
          window.__ab.teleport(p.x, p.z, p.y, p.yaw);
          window.__ab.state().speed = speed;
          window.__ab.qaHide(hide);
        },
        { hide, p: hit.pose, speed: PIN_SPEED },
      );
      await step(page);
    }
    const p = await page.evaluate(() => window.__ab.nanProbe());
    return p.nan + p.inf;
  };
  const base = await reproduce([]);
  const out = { frame: hit.frame, base, sources: [] };
  if (base === 0) {
    await page.evaluate(() => window.__ab.qaHide([]));
    await teardownPath(page);
    return out;
  }
  const systems = await page.evaluate(() => window.__ab.qaSystems());
  for (const name of systems) {
    const n = await reproduce([name]);
    if (n < base) out.sources.push({ name, left: n });
  }
  await page.evaluate(() => window.__ab.qaHide([]));
  await teardownPath(page);
  return out;
}

async function flyProfile(browser, port, name, opts, resolvePaths) {
  const profile = PROFILES[name];
  const { page, errors } = await joinProfile(browser, port, profile);
  const paths = await resolvePaths(page);
  await page.evaluate(installAnalyzer, {
    cellCss: CELL_CSS_PX,
    dark: DARK,
    drop: DROP,
    before: BEFORE,
    after: AFTER,
    minCells: MIN_CELLS,
    fill: FILL,
    shots: opts.shots !== null,
    maxShots: 4,
  });
  const out = [];
  try {
    for (const sky of opts.skies) {
      const control = await positiveControl(page);
      console.log(
        `  ${name}/${sky} control: probe ${control.nan}/256 NaN, box ${control.boxed ? "flagged" : "MISSED"} → ${control.ok ? "ok" : "FAIL"}`,
      );
      const rows = [];
      for (const path of paths) {
        const idx = paths.indexOf(path);
        const worldMs = EPOCH_MS + WORLD_START_MS + idx * WORLD_STEP_MS;
        const frames = opts.frames;
        await page.evaluate((p) => window.__bb.reset(p), path.name);
        const setup = await setupPath(page, path, worldMs, sky, frames);
        const t0 = Date.now();
        for (let i = -SETTLE; i < frames; i++) {
          await poseFrame(page, path, i, frames);
          await step(page);
        }
        // AFTER more frames so the last judged frames have their future.
        for (let i = 0; i < AFTER; i++) {
          await page.evaluate(() => window.__bb.at(-1, false));
          await step(page);
        }
        const r = await page.evaluate(() => ({
          frames: window.__bb.frames,
          boxes: window.__bb.boxes,
          hits: window.__bb.hits,
          negMax: window.__bb.negMax,
          shots: window.__bb.shots,
          alive: window.__ab.combat().alive,
        }));
        await teardownPath(page);
        const row = {
          path: path.name,
          frames: r.frames,
          boxes: r.boxes.length,
          boxList: r.boxes.slice(0, 8),
          nanFrames: r.hits.filter((h) => h.nan > 0).length,
          infFrames: r.hits.filter((h) => h.inf > 0).length,
          nanMax: Math.max(0, ...r.hits.map((h) => h.nan)),
          infMax: Math.max(0, ...r.hits.map((h) => h.inf)),
          negMax: r.negMax,
          hits: r.hits.slice(0, 8),
          staged: setup.staged,
          alive: r.alive,
          secs: Math.round((Date.now() - t0) / 100) / 10,
        };
        if (opts.shots) {
          mkdirSync(opts.shots, { recursive: true });
          for (const s of r.shots) {
            writeFileSync(
              resolve(
                opts.shots,
                `${name}-${sky}-${path.name}-${s.frame}-${s.kind}.png`,
              ),
              Buffer.from(s.png.split(",")[1], "base64"),
            );
          }
        }
        if (opts.attribute && r.hits.length > 0) {
          row.attribution = await attribute(
            page,
            path,
            r.hits[0],
            frames,
            sky,
            worldMs,
          );
        }
        console.log(
          `  ${name}/${sky} ${path.name.padEnd(9)} ${String(row.frames).padStart(4)} fr  boxes ${row.boxes}  NaN frames ${row.nanFrames} (max ${row.nanMax} px)  Inf frames ${row.infFrames} (max ${row.infMax} px)  neg ≤ ${row.negMax}  ${row.secs}s${row.attribution ? `  ← ${row.attribution.sources.map((s) => s.name).join(", ") || `(base ${row.attribution.base}: not reproduced)`}` : ""}`,
        );
        rows.push(row);
      }
      out.push({ sky, control, rows });
    }
  } finally {
    await page.evaluate(() => window.__ab.sky(null)).catch(() => {});
    await page.close();
  }
  return { device: name, errors, skies: out };
}

// --- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    devices: ["desktop", "phone"],
    skies: SKIES,
    paths: null,
    frames: DEFAULT_FRAMES,
    repeat: 1,
    shots: null,
    attribute: false,
    build: true,
    out: resolve(HERE, "blackbox-last.json"),
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--device") {
      const v = argv[++i];
      opts.devices = v === "all" ? Object.keys(PROFILES) : v.split(",");
    } else if (a === "--sky") opts.skies = argv[++i].split(",");
    else if (a === "--paths") opts.paths = argv[++i].split(",");
    else if (a === "--frames") opts.frames = Number(argv[++i]);
    else if (a === "--repeat") opts.repeat = Number(argv[++i]);
    else if (a === "--shots") opts.shots = resolve(process.cwd(), argv[++i]);
    else if (a === "--attribute") opts.attribute = true;
    else if (a === "--no-build") opts.build = false;
    else if (a === "--out") opts.out = resolve(process.cwd(), argv[++i]);
    else if (a === "--list") opts.list = true;
    else throw new Error(`unknown flag ${a}`);
  }
  for (const d of opts.devices) {
    if (!PROFILES[d]) throw new Error(`--device: no profile ${d}`);
  }
  for (const s of opts.skies) {
    if (!SKIES.includes(s)) throw new Error(`--sky: ${s} (night, dusk)`);
  }
  if (!(opts.frames >= 8)) throw new Error("--frames must be >= 8");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    for (const p of buildPaths(0)) console.log(`${p.name.padEnd(9)} ${p.what}`);
    console.log("bore<k>   every tunnel bore of the build, end to end");
    return;
  }
  if (opts.build) {
    console.log("building client…");
    await run("npm", ["run", "build", "-w", "client"]);
  }
  const { proc, port } = await startServer(REPO);
  const browser = await chromium.launch({
    headless: true,
    args: [
      ...(process.env.AB_CHROME_ARGS
        ? process.env.AB_CHROME_ARGS.split(" ").filter(Boolean)
        : ["--use-angle=metal", "--enable-gpu"]),
      "--mute-audio",
    ],
    ...(process.env.AB_CHROME ? { executablePath: process.env.AB_CHROME } : {}),
  });
  const report = {
    tool: "blackbox",
    detector: { CELL_CSS_PX, DARK, DROP, BEFORE, AFTER, MIN_CELLS, FILL },
    frames: opts.frames,
    runs: [],
  };
  /** Every path this build has (one per bore), chosen by --paths. */
  const resolvePaths = async (page) => {
    const all = buildPaths(await page.evaluate(() => window.__ab.tunnels()));
    if (!opts.paths) return all;
    const unknown = opts.paths.filter((n) => !all.some((p) => p.name === n));
    if (unknown.length > 0) {
      throw new Error(`--paths: no path ${unknown.join(", ")}`);
    }
    return all.filter((p) => opts.paths.includes(p.name));
  };
  try {
    for (let r = 0; r < opts.repeat; r++) {
      const run = { pass: r + 1, devices: [] };
      for (const device of opts.devices) {
        console.log(`pass ${r + 1}: ${device}`);
        run.devices.push(
          await flyProfile(browser, port, device, opts, resolvePaths),
        );
      }
      report.runs.push(run);
    }
  } finally {
    await browser.close().catch(() => {});
    proc.kill();
  }
  writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  // Verdict.
  let boxes = 0;
  let nan = 0;
  let controlFails = 0;
  for (const run of report.runs) {
    for (const d of run.devices) {
      for (const s of d.skies) {
        if (!s.control.ok) controlFails++;
        for (const row of s.rows) {
          boxes += row.boxes;
          nan += row.nanFrames + row.infFrames;
        }
      }
    }
  }
  console.log(
    `\nblack boxes: ${boxes}   frames with non-finite pixels: ${nan}   positive controls failed: ${controlFails}`,
  );
  console.log(`report: ${opts.out}`);
  const pass = boxes === 0 && nan === 0 && controlFails === 0;
  console.log(pass ? "PASS" : "FAIL");
  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
