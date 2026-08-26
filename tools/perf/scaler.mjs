#!/usr/bin/env node
// Adaptive-resolution QA (P1, win B).
//
//     node tools/perf/scaler.mjs
//
// The unit test in client/test/resolution.test.ts proves the controller's
// arithmetic converges. This proves the WIRING: that a real browser, given a
// workload it genuinely cannot hold at 60 fps, backs the pixel ratio off,
// settles, and then stays settled — and that aim-zoom still works while it
// is doing so (both write to the same camera/renderer every frame).
//
// Vsync stays ON here, unlike tools/perf/run.mjs. That is deliberate: the
// controller's whole decision metric is "did we MISS a vsync", so measuring
// it with vsync disabled would test a situation it never runs in.
//
// The workload comes from an oversized viewport: 2560x1440 CSS at a device
// ratio of 2 is 4x the pixels of the harness's normal frame, which no
// laptop GPU holds at 60 fps under this bloom chain.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deliberately more pixels than the GPU can hold at 60 fps. */
const VIEWPORT = { width: 2560, height: 1440 };
const DEVICE_SCALE_FACTOR = 2;
/** How long to watch it settle, and how often to sample the ratio. */
const WATCH_MS = 30_000;
const POLL_MS = 250;
/** A settled tail: no ratio change at all over the last this-many ms. */
const SETTLED_TAIL_MS = 8000;

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

async function main() {
  const port = await freePort();
  console.log(`starting server on :${port}…`);
  const server = await startServer(port);
  const browser = await chromium.launch({
    headless: true,
    // No --disable-gpu-vsync: this test needs the vsync the controller reads.
    args: [
      "--use-angle=metal",
      "--enable-gpu",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  let failed = false;
  try {
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });
    await page.goto(`http://127.0.0.1:${port}/?res=auto&perf=1`);
    await page.fill("#join-name", "SCALER");
    await page.click('#join button[type="submit"]');
    await page.waitForFunction(() => typeof window.__ab !== "undefined", null, {
      timeout: 60_000,
    });
    await page.evaluate(() => window.__ab.setBots(0));
    // A low, dense viewpoint — the heaviest thing the path measures.
    await page.evaluate(() => window.__ab.teleport(200, 1200, 45, 0));

    console.log(
      `watching for ${WATCH_MS / 1000}s at ${VIEWPORT.width}x${VIEWPORT.height} ` +
        `(device ratio ${DEVICE_SCALE_FACTOR}) …`,
    );
    const trace = [];
    const t0 = Date.now();
    let zoomChecked = null;
    while (Date.now() - t0 < WATCH_MS) {
      const sample = await page.evaluate(() => {
        const r = window.__ab.render();
        const s = window.__ab.perfStats();
        return {
          ratio: r.pixelRatio,
          auto: r.auto,
          hotRatio: r.hotRatio,
          buffer: `${r.drawingBuffer.width}x${r.drawingBuffer.height}`,
          p50: s.p50,
          fov: window.__ab.zoom().fov,
        };
      });
      trace.push({ t: Date.now() - t0, ...sample });

      // Aim-zoom, held across the scaler's busiest stretch. Both the zoom
      // and the scaler write to the same camera and renderer every frame;
      // this is the interaction the ticket asked to see checked.
      if (zoomChecked === null && Date.now() - t0 > 6000) {
        const before = trace.at(-1);
        await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
        await page.mouse.down({ button: "right" });
        await sleep(2500);
        const zoomed = await page.evaluate(() => ({
          ...window.__ab.zoom(),
          ratio: window.__ab.render().pixelRatio,
        }));
        await page.mouse.up({ button: "right" });
        await sleep(2500);
        const released = await page.evaluate(() => window.__ab.zoom());
        zoomChecked = { before: before.fov, zoomed, released };
      }
      await sleep(POLL_MS);
    }
    await page.close();

    const ratios = trace.map((s) => s.ratio);
    const changes = [];
    for (let i = 1; i < trace.length; i++) {
      if (trace[i].ratio !== trace[i - 1].ratio) {
        changes.push({
          t: trace[i].t,
          from: trace[i - 1].ratio,
          to: trace[i].ratio,
        });
      }
    }
    const last = trace.at(-1);
    const settledAt = changes.length === 0 ? 0 : changes.at(-1).t;
    const settledFor = last.t - settledAt;
    const ups = changes.filter((c) => c.to > c.from).length;
    const downs = changes.filter((c) => c.to < c.from).length;

    console.log("\nratio changes:");
    for (const c of changes) {
      console.log(
        `  ${(c.t / 1000).toFixed(1)}s  ${c.from.toFixed(3)} -> ${c.to.toFixed(3)}` +
          `  (${c.to > c.from ? "up" : "down"} ${(Math.abs(c.to / c.from - 1) * 100).toFixed(1)}%)`,
      );
    }
    console.log(
      `\nstart ${ratios[0].toFixed(3)}  final ${last.ratio.toFixed(3)}  ` +
        `buffer ${last.buffer}  hotRatio ${last.hotRatio}`,
    );
    console.log(
      `${changes.length} changes (${downs} down, ${ups} up); ` +
        `unchanged for the last ${(settledFor / 1000).toFixed(1)}s`,
    );
    if (zoomChecked) {
      console.log(
        `\naim-zoom while scaling: fov ${zoomChecked.before.toFixed(1)} -> ` +
          `${zoomChecked.zoomed.fov.toFixed(1)} (held, z=${zoomChecked.zoomed.z.toFixed(2)}, ` +
          `ratio ${zoomChecked.zoomed.ratio.toFixed(3)}) -> ` +
          `${zoomChecked.released.fov.toFixed(1)} (released)`,
      );
    }

    // --- Verdicts -------------------------------------------------------
    const verdicts = [
      ["backed off under a load it cannot hold", downs > 0],
      ["settled and stayed settled", settledFor >= SETTLED_TAIL_MS],
      ["did not pump (no up/down/up cycling)", ups <= 1],
      ["stayed at or above the floor", last.ratio >= 0.75 - 1e-9],
      [
        "aim-zoom narrowed the FOV while the scaler was live",
        zoomChecked !== null && zoomChecked.zoomed.fov < zoomChecked.before - 5,
      ],
      [
        "aim-zoom released cleanly",
        zoomChecked !== null &&
          zoomChecked.released.fov > zoomChecked.zoomed.fov,
      ],
    ];
    console.log("");
    for (const [what, ok] of verdicts) {
      console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
      if (!ok) failed = true;
    }
  } finally {
    await browser.close();
    server.kill();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
