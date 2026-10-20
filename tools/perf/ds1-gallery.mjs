// DS1 gallery: the physical collapses, shot from the Destruction Lab.
//
//   npm run build -w client
//   node tools/perf/ds1-gallery.mjs <outDir> [--shots a,b] [--port 8243]
//
// gallery.mjs stages its collapse views on the page in closed form (they
// pin the world clock, and the closed form is a function of it): fine for
// multiplayer's collapses, but a physical collapse is simulated in the sim
// worker on its own clock. So these are shot the way a player would see
// them: in the lab (`?destructlab`), whose triggers go through the real
// host — the column planner and the Rapier world — and which keeps every
// pose frame, so once a collapse has played out its clock scrubs back to
// any instant of it. Each shot: a tower (drop-into-city), a trigger, a fixed
// camera (__ab.qaCamera), the collapse played out live, then the frames at
// its instants — and a time-lapse strip of the same.
//
// Same browser knobs as gallery.mjs (AB_CHROME / AB_CHROME_ARGS — e.g.
// SwiftShader on a GPU-less box). The city is quiet: the lab breaks what it
// is told to and nothing else.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { withSim } from "./local-game.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const OUT = resolve(
  argv[0] && !argv[0].startsWith("--") ? argv[0] : "ds1-gallery",
);
const PORT = Number(opt("port", 8243));

/**
 * A shot: the tower (seed-42 index, the closed-form gallery's 293 m tower
 * 159, so the two read side by side), the trigger and its options, the
 * camera (canonical eye and look-at — the closed-form views' own where they
 * have one), the instants to save (ms after the event) and a strip of
 * instants; `settled`: one frame once it is all at rest instead.
 */
const SHOTS = {
  "collapse-pancake-mid": {
    tower: 159,
    k: "pancake",
    eye: [850, 140, 200],
    look: [741, 92, 270],
    at: [4600],
    strip: [-600, 2000, 3500, 4600, 6000, 8000, 12000],
  },
  "collapse-lean-hinge": {
    tower: 159,
    // DS1's Lean trigger: floor 2 blown out on its +x side.
    k: "lean",
    opts: { floor: 2, dir: 1 },
    eye: [850, 140, 200],
    look: [741, 92, 270],
    at: [4000],
    strip: [-600, 1500, 3000, 4500, 6500, 9000, 14000],
  },
  "collapse-topple-impact": {
    tower: 159,
    k: "topple",
    opts: { dir: 1 },
    eye: [814, 180, 121],
    look: [814, 123, 271],
    at: [5100],
    strip: [-600, 1500, 3000, 4500, 6500, 9000, 14000],
  },
  "ruin-detail": {
    tower: 159,
    k: "pancake",
    eye: [803, 14, 301],
    look: [748, 6, 270],
    settled: true,
  },
  "rubble-heap": {
    tower: 159,
    k: "pancake",
    eye: [812, 48, 340],
    look: [746, 4, 272],
    settled: true,
  },
};
const ONLY = opt("shots", Object.keys(SHOTS).join(",")).split(",");

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST_ENV = {
  AB_WAVES: "0",
  AB_QUIET_CITY: "1",
  LIVENESS_TIMEOUT_MS: "600000",
};
const server = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), ...HOST_ENV },
  stdio: "ignore",
});
let browser = null;
const stop = async () => {
  await browser?.close().catch(() => {});
  server.kill();
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => stop().finally(() => process.exit(130)));
}
const until = (page, fn, arg, timeout = 900_000) =>
  page.waitForFunction(fn, arg, { polling: 500, timeout });

/** Wait for a few frames to land (a software rasteriser draws ~1 fps). */
const frames = (page, n = 3) =>
  page.evaluate(
    (k) =>
      new Promise((done) => {
        let i = 0;
        const tick = () => (++i >= k ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  browser = await chromium.launch({
    ...(process.env.AB_CHROME ? { executablePath: process.env.AB_CHROME } : {}),
    args: process.env.AB_CHROME_ARGS
      ? process.env.AB_CHROME_ARGS.split(" ").filter(Boolean)
      : [],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(
    withSim(`http://127.0.0.1:${PORT}/?destructlab&res=1`, HOST_ENV),
  );
  await page.fill("#join-name", "DS1");
  await page.click('#join button[type="submit"]');
  await until(page, () => !!window.__ab?.destructLab?.());
  await until(page, () => window.__ab.renderMs() !== null);
  // Clean frames: the panel folded away (the telemetry strip stays).
  await page.addStyleTag({
    content: ".dlab-panel { display: none !important; }",
  });
  const report = {};
  for (const name of ONLY) {
    const s = SHOTS[name];
    if (!s) continue;
    console.log(`shot ${name}`);
    await page.evaluate(() => window.__ab.destructLab().resetArena());
    await until(page, () => window.__ab.destructLab().debug().collapses === 0);
    await page.evaluate((sh) => {
      const l = window.__ab.destructLab();
      l.dropIntoCity(true);
      l.setTarget(sh.tower);
      for (const [k, v] of Object.entries(sh.opts ?? {}))
        l.panel.options[k] = v;
      const [ex, ey, ez] = sh.eye;
      const [ax, ay, az] = sh.look;
      window.__ab.qaCamera({
        eye: { x: ex, y: ey, z: ez },
        at: { x: ax, y: ay, z: az },
        fov: 70,
      });
    }, s);
    await sleep(3000);
    await page.evaluate((k) => window.__ab.destructLab().fire(k), s.k);
    await until(page, () => window.__ab.destructLab().debug().focus !== null);
    const focus = await page.evaluate(
      () => window.__ab.destructLab().debug().focus,
    );
    // Played out live: until its physics settles (or 60 s).
    await until(
      page,
      (t0) => {
        const l = window.__ab.destructLab();
        const c = l.focusCollapse();
        const now = window.__ab.renderMs() ?? 0;
        return (c?.phys?.settled ?? false) || now > t0 + 60_000;
      },
      focus.t0,
    );
    const info = await page.evaluate(() => {
      const c = window.__ab.destructLab().focusCollapse();
      return {
        id: c.id,
        building: c.building,
        pieces: c.n,
        physics: c.phys !== null,
        settledAfterMs: c.phys?.settled ? c.phys.settledAt - c.t0 : null,
        frames: c.phys?.frames ?? 0,
        heap: c.phys?.heap
          ? { top: c.phys.heap.top, nx: c.phys.heap.nx, nz: c.phys.heap.nz }
          : null,
        stats: window.__ab.destructLab().debug().stats,
      };
    });
    report[name] = info;
    console.log(name, JSON.stringify(info));
    const scrub = async (ms) => {
      await page.evaluate((t) => {
        const l = window.__ab.destructLab();
        l.clock.scrub(t, l.liveMs);
      }, focus.t0 + ms);
      await frames(page, 3);
    };
    if (s.settled) {
      // Everything at rest: the live view (the camera is the shot's).
      await page.evaluate(() => window.__ab.destructLab().clock.goLive());
      await frames(page, 4);
      await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 300_000 });
      continue;
    }
    for (const ms of s.at) {
      await scrub(ms);
      await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 300_000 });
    }
    // The strip: the same camera at each instant, saved one by one.
    for (const ms of s.strip ?? []) {
      await scrub(ms);
      await page.screenshot({
        path: `${OUT}/${name}-t${ms < 0 ? "before" : (ms / 1000).toFixed(1)}.png`,
        timeout: 300_000,
      });
    }
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  console.log(`wrote ${OUT}`);
} finally {
  await stop();
}
