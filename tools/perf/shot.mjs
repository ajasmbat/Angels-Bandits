#!/usr/bin/env node
// Edge-quality evidence for P1's antialiasing decision.
//
//     node tools/perf/shot.mjs
//
// Captures the SAME fixed viewpoint once per `?aa=` mode, measures how many
// pixels actually differ between them, and writes a magnified side-by-side
// comparison page as a PNG. That is the whole point: the claim behind win A
// is that `WebGLRenderer({antialias: true})` never reached the scene, and
// the way to prove a change is not a silent downgrade is to show that
// `legacy` and `off` are the *same image* — not to assert it.
//
// The pixel comparison runs in the browser (canvas + getImageData) so this
// script needs no image library.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `off` FIRST, so the temporal control captured right after it sits one
// capture apart — the same gap as `off` to `legacy`. Comparing a control
// taken four captures later against a pair taken one apart flatters the pair.
const MODES = ["off", "legacy", "smaa", "msaa"];
const VIEWPORT = { width: 1280, height: 720 };
const DEVICE_SCALE_FACTOR = 2;
/** Rooftop edges against the sky at close range — the worst case for aliasing. */
const VIEW = { x: 200, z: 1000, y: 120, yaw: 0 };
/**
 * The crop the comparison page magnifies, in CSS pixels.
 *
 * It must land on a HIGH-CONTRAST SILHOUETTE AGAINST THE SKY — that is the
 * only thing in this scene where antialiasing is visible at all. The first
 * version of this file picked a crop off an older frame and, once the city
 * changed under it, magnified 240x135 of empty night sky four times over: a
 * perfectly reproducible comparison of nothing. `cropEnergy` below now
 * measures the crop and refuses to let that happen quietly.
 *
 * This one is the near-right tower's stepped roofline: sky above, a lit
 * window grid below, and both a shallow step and a sloped edge between them.
 */
const CROP = { x: 1035, y: 30, width: 240, height: 135 };
/** Long enough for the city to stream in and the scene to settle. */
const SETTLE_MS = 2500;

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

// Exactly one owner for the child processes, reachable from the happy path,
// the error path and a signal alike. Spawning the server outside the try that
// owns cleanup is how this family of scripts orphaned a node process that was
// still holding a port nine hours later.
let liveServer = null;
let liveBrowser = null;

async function killEverything() {
  const server = liveServer;
  const browser = liveBrowser;
  liveServer = null;
  liveBrowser = null;
  // Server first: nothing else will ever reap it, while Playwright reaps its
  // own browser on exit. A hung close() must not strand the kill.
  if (server !== null) server.kill();
  if (browser !== null) await browser.close().catch(() => {});
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    killEverything().finally(() => process.exit(130));
  });
}

async function startServer(port) {
  const proc = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error("server never answered /healthz");
}

/** One PNG of VIEW rendered in `mode`, as a base64 data URI. */
async function capture(browser, baseUrl, mode) {
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  await page.goto(`${baseUrl}?aa=${mode}&res=2`);
  await page.fill("#join-name", "SHOT");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => typeof window.__ab !== "undefined", null, {
    timeout: 60_000,
  });
  await page.evaluate(() => window.__ab.setBots(0));
  // HUD chrome is DOM, identical in every mode, and sits right where the
  // interesting edges are. Hide it so the crop shows only rendered pixels.
  await page.addStyleTag({
    content:
      "#crosshair,#lead,#hud,#minimap,#gauges,#comms,#killfeed,#perfhud{display:none!important}",
  });
  // PIN the plane. The flight model never stops, and a CDP screenshot queues
  // behind a saturated render loop for an unbounded time — so "teleport,
  // wait, shoot" framed each mode from a different place and the comparison
  // measured parallax, not antialiasing. Re-teleporting every frame holds
  // the viewpoint (and, via snapTo, the chase camera) exactly still.
  await page.evaluate((v) => {
    setInterval(() => window.__ab.teleport(v.x, v.z, v.y, v.yaw), 16);
  }, VIEW);
  await sleep(SETTLE_MS);
  const full = await page.screenshot({ type: "png" });
  const crop = await page.screenshot({ type: "png", clip: CROP });
  // The receipt for win A, straight out of the GL state: how many samples
  // the default framebuffer carries versus how many the target the scene is
  // actually drawn into carries.
  const gl = await page.evaluate(() => {
    const r = window.__ab.render();
    return {
      antialiasAttribute: r.antialiasAttribute,
      defaultFramebufferSamples: r.defaultFramebufferSamples,
      sceneTargetSamples: r.sceneTargetSamples,
    };
  });
  await page.close();
  return {
    mode,
    gl,
    full: `data:image/png;base64,${full.toString("base64")}`,
    crop: `data:image/png;base64,${crop.toString("base64")}`,
  };
}

/**
 * How much EDGE there is in the crop, as the share of pixels whose luminance
 * differs from the neighbour to their right or below by more than a step.
 *
 * This exists because the failure it guards against is invisible in every
 * number the rest of this script prints: a crop of empty sky produces a
 * perfectly valid, perfectly reproducible, perfectly useless comparison, and
 * the pixel-diff table beside it looks exactly as convincing as a good one.
 */
async function cropEnergy(browser, src) {
  const page = await browser.newPage();
  await page.goto("about:blank");
  const share = await page.evaluate(async (source) => {
    const img = await new Promise((ok) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.src = source;
    });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const lum = (i) =>
      0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    let edges = 0;
    let total = 0;
    for (let y = 0; y < c.height - 1; y++) {
      for (let x = 0; x < c.width - 1; x++) {
        const i = (y * c.width + x) * 4;
        const here = lum(i);
        const dx = Math.abs(here - lum(i + 4));
        const dy = Math.abs(here - lum(i + c.width * 4));
        if (Math.max(dx, dy) > 24) edges++;
        total++;
      }
    }
    return total === 0 ? 0 : edges / total;
  }, src);
  await page.close();
  return share;
}

/** Below this the crop is not showing an edge, whatever the table says. */
const MIN_CROP_EDGE_SHARE = 0.03;

/** Pixels that differ between two data-URI PNGs, measured in a blank page. */
async function diff(browser, a, b) {
  const page = await browser.newPage();
  await page.goto("about:blank");
  const result = await page.evaluate(
    async ([srcA, srcB]) => {
      const load = (src) =>
        new Promise((ok) => {
          const img = new Image();
          img.onload = () => ok(img);
          img.src = src;
        });
      const [ia, ib] = await Promise.all([load(srcA), load(srcB)]);
      const pixels = (img) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        c.getContext("2d").drawImage(img, 0, 0);
        return c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      };
      const pa = pixels(ia);
      const pb = pixels(ib);
      let differing = 0;
      let maxDelta = 0;
      let sum = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const d = Math.max(
          Math.abs(pa[i] - pb[i]),
          Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2]),
        );
        if (d > 0) differing++;
        if (d > maxDelta) maxDelta = d;
        sum += d;
      }
      const total = pa.length / 4;
      return {
        total,
        differing,
        differingPct: (differing / total) * 100,
        maxDelta,
        meanDelta: sum / total,
      };
    },
    [a, b],
  );
  await page.close();
  return result;
}

function comparisonPage(shots, diffs) {
  const glRows = shots
    .map(
      (s) =>
        `<tr><td>${s.mode}</td><td>${s.gl.antialiasAttribute}</td>` +
        `<td>${s.gl.defaultFramebufferSamples}</td>` +
        `<td>${s.gl.sceneTargetSamples}</td></tr>`,
    )
    .join("");
  const cards = shots
    .map(
      (s) => `
      <figure>
        <figcaption>aa=${s.mode}</figcaption>
        <div class="zoom"><img src="${s.crop}" alt="aa=${s.mode}"></div>
      </figure>`,
    )
    .join("");
  const rows = diffs
    .map(
      (d) =>
        `<tr><td>${d.pair}</td><td>${d.differing.toLocaleString()}</td>` +
        `<td>${d.differingPct.toFixed(3)}%</td><td>${d.maxDelta}</td>` +
        `<td>${d.meanDelta.toFixed(3)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 20px; background: #141225; color: #e8f6fa;
           font: 13px ui-monospace, Menlo, monospace; }
    h1 { font-size: 15px; letter-spacing: .1em; margin: 0 0 4px; color: #9fd8e8; }
    p.sub { margin: 0 0 18px; color: #9fd8e8aa; }
    .row { display: flex; gap: 14px; }
    figure { margin: 0; }
    figcaption { color: #27e0c0; margin-bottom: 6px; letter-spacing: .1em; }
    .zoom { width: 480px; height: 270px; overflow: hidden; border: 1px solid #27e0c055; }
    .zoom img { width: 960px; image-rendering: pixelated;
                transform: translate(-240px, -135px); }
    table { margin-top: 20px; border-collapse: collapse; }
    th, td { padding: 4px 14px 4px 0; text-align: left; }
    th { color: #9fd8e8; font-weight: normal; letter-spacing: .1em; }
    td:first-child { color: #ffc46b; }
  </style>
  <h1>P1 — ANTIALIASING EDGE QUALITY</h1>
  <p class="sub">Same seed, same viewpoint (${VIEW.x}, ${VIEW.z}) at ${VIEW.y} m,
  pixelRatio 2. Crop ${CROP.width}x${CROP.height} CSS px, magnified 4x, nearest-neighbour.</p>
  <div class="row">${cards}</div>
  <table>
    <tr><th>mode</th><th>antialias attribute</th><th>default fb samples</th><th>scene target samples</th></tr>
    ${glRows}
  </table>
  <p class="sub">aa=legacy multisamples a framebuffer the scene never renders
  into: 4 samples on the default framebuffer, 0 on the composer target the
  city is actually drawn to. That is the bug — paid for, never received.</p>
  <table>
    <tr><th>pair</th><th>differing px</th><th>share</th><th>max channel Δ</th><th>mean Δ</th></tr>
    ${rows}
  </table>
  <p class="sub">"off vs off (again)" is the control: two captures of the same
  build, differing only because the scene animates. Read every other row
  against it.</p>`;
}

/** The crop image for one mode, by name. */
function byModeSource(shots, mode) {
  const found = shots.find((s) => s.mode === mode);
  if (found === undefined) throw new Error(`no capture for aa=${mode}`);
  return found.crop;
}

async function main() {
  const port = await freePort();
  console.log(`starting server on :${port}…`);
  const server = await startServer(port);
  liveServer = server;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-angle=metal",
      "--enable-gpu",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  liveBrowser = browser;
  try {
    const baseUrl = `http://127.0.0.1:${port}/`;
    const shots = [];
    let control = null;
    for (const mode of MODES) {
      console.log(`capturing aa=${mode}…`);
      shots.push(await capture(browser, baseUrl, mode));
      if (mode === "off") {
        // The control, taken IMMEDIATELY after `off`. Two captures of the
        // same build differ only because the scene animates between them —
        // traffic drives, neon pulses, beacons blink, the cloud deck drifts.
        // Every cross-mode number below is read against this floor, or a
        // moving car reads as an antialiasing change.
        console.log("capturing aa=off again (temporal control)…");
        control = await capture(browser, baseUrl, "off");
      }
    }
    // Before any pixel-diff number is believed: is the crop even looking at
    // an edge? `off` is the shipping mode, so it is the one to judge.
    const energy = await cropEnergy(browser, byModeSource(shots, "off"));
    console.log(`crop edge share: ${(energy * 100).toFixed(1)}%`);
    if (energy < MIN_CROP_EDGE_SHARE) {
      console.error(
        `\n!! the crop at (${CROP.x}, ${CROP.y}) is ${(energy * 100).toFixed(1)}% edge — it is` +
          " magnifying flat sky, so the panels below prove nothing by eye." +
          " Move CROP onto a silhouette (open tools/perf/aa-frame.png and pick one).",
      );
    }
    const byMode = Object.fromEntries(shots.map((s) => [s.mode, s]));
    byMode["off (again)"] = control;
    const pairs = [
      ["off", "off (again)"],
      ["off (again)", "legacy"],
      ["off (again)", "smaa"],
      ["off (again)", "msaa"],
    ];
    /**
     * A lightning strike between two captures re-lights the WHOLE frame, so
     * a run that catches one produces a control near 100 % and proves
     * nothing. That is a property of the run, not of the build.
     */
    const STORM_FLASH_SHARE = 0.6;
    const diffs = [];
    for (const [a, b] of pairs) {
      const d = await diff(browser, byMode[a].full, byMode[b].full);
      diffs.push({ pair: `${a} vs ${b}`, ...d });
      console.log(
        `${a} vs ${b}: ${d.differing} / ${d.total} px differ ` +
          `(${d.differingPct.toFixed(3)}%), max Δ ${d.maxDelta}, mean Δ ${d.meanDelta.toFixed(3)}`,
      );
    }
    const controlDiff = diffs[0];
    if (controlDiff.differingPct / 100 > STORM_FLASH_SHARE) {
      console.error(
        `\n!! the control differs by ${controlDiff.differingPct.toFixed(1)}% — a lightning strike re-lit the` +
          " whole frame between two captures, so every row below is measured against" +
          " a floor that is not the animation floor. Re-run; this says nothing about the build.",
      );
    }

    // The shipped mode's untouched frame, so a reviewer can see the whole
    // scene the crop was taken from (and pick a different crop).
    writeFileSync(
      resolve(HERE, "aa-frame.png"),
      Buffer.from(byMode.off.full.split(",")[1], "base64"),
    );

    const html = comparisonPage(shots, diffs);
    const htmlPath = resolve(HERE, "aa-comparison.html");
    writeFileSync(htmlPath, html);
    const page = await browser.newPage({
      viewport: { width: 2020, height: 560 },
      deviceScaleFactor: 2,
    });
    await page.goto(`file://${htmlPath}`);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: resolve(HERE, "aa-comparison.png"),
      fullPage: true,
    });
    await page.close();
    console.log(`\nwrote ${resolve(HERE, "aa-comparison.png")}`);
  } finally {
    await killEverything();
  }
}

main().catch(async (err) => {
  console.error(err);
  await killEverything();
  process.exit(1);
});
