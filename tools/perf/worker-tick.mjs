#!/usr/bin/env node
// SOLO: what does the simulation cost the PLAYER's machine? The game's host
// (server/src/host.ts) runs in the page's sim worker now, so its tick is
// measured there — per difficulty, at the air force that level fields, on
// this machine as it is and on a CPU-throttled "mobile tier".
//
// Per (tier, level): a fresh page of the STATIC build (`vite preview`, no
// game server), the level picked on the start screen, the host profiling its
// tick (`sim` AB_TICK_STATS:1, server/src/tickstats.ts) with the level's
// whole air force staged in the air at once (AB_AIRFORCE: the steady state a
// long fight reaches, without minutes of launches first) and the fleet up
// fast (AB_BOSS_FAST). The plane flies the street at altitude (guns hot, so
// the fight is real), a warm-up passes, the profile is reset, and after the
// window the tick's p50 / p95 / p99 / max and the ticks it actually managed
// are read back off the worker (`__ab.simTick`).
//
//   node tools/perf/worker-tick.mjs [--levels 0,1,2,3] [--throttle 1,4]
//        [--warmup 10] [--seconds 20] [--json out.json] [--no-build]
//
// The budget: the tick fits its TICK_DOWN_HZ slot (50 ms) with room for the
// page beside it — p99 ≤ 25 ms (half a slot) on the tier. The mobile tier is
// headless Chrome with `Emulation.setCPUThrottlingRate` on the page AND its
// worker (the worker is its own CDP target). Wall-clock numbers: read the
// load average printed beside them, and compare runs from one session.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { simValue } from "./local-game.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const LEVELS = arg("levels", "0,1,2,3").split(",").map(Number);
const THROTTLES = arg("throttle", "1,4").split(",").map(Number);
const WARMUP_S = Number(arg("warmup", "10"));
const SECONDS = Number(arg("seconds", "20"));
const JSON_OUT = arg("json", "");
const BUILD = !process.argv.includes("--no-build");
/** E1's AIR_FORCE (common/src/waves.ts): each level's planes in the sky. */
const AIR_FORCE = [100, 200, 350, 500];
const NAMES = ["EASY", "NORMAL", "HARD", "INSANE"];
const TICK_HZ = 20;
const P99_BUDGET_MS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: REPO, stdio: "inherit", ...opts });
    p.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`)),
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

async function startPreview(port) {
  const proc = spawn(
    "npx",
    ["vite", "preview", "--port", String(port), "--strictPort"],
    { cwd: resolve(REPO, "client"), stdio: "ignore" },
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error("vite preview never answered");
}

/** Throttle the page and every worker it starts by `rate` (CDP). */
async function throttle(browser, page, rate) {
  if (rate <= 1) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  // The sim worker is a target of its own: attach to it through the
  // browser session and throttle it too.
  const bs = await browser.newBrowserCDPSession();
  const attach = async () => {
    const { targetInfos } = await bs.send("Target.getTargets");
    for (const t of targetInfos) {
      if (t.type !== "worker") continue;
      const { sessionId } = await bs.send("Target.attachToTarget", {
        targetId: t.targetId,
        flatten: false,
      });
      await bs.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({
          id: 1,
          method: "Emulation.setCPUThrottlingRate",
          params: { rate },
        }),
      });
    }
  };
  return attach;
}

async function measure(browser, port, level, rate) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const sim = simValue({
    AB_TICK_STATS: "1",
    AB_BOSS_FAST: "1",
    AB_AIRFORCE: String(AIR_FORCE[level]),
    LIVENESS_TIMEOUT_MS: "600000",
  });
  const attachWorker = await throttle(browser, page, rate);
  await page.goto(
    `http://127.0.0.1:${port}/?quality=low&res=1&silence=600000&sim=${encodeURIComponent(sim)}`,
  );
  await attachWorker?.();
  await page.click(`#join-difficulty [data-level="${level}"]`);
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => window.__ab?.combat().alive === true, null, {
    timeout: 600_000,
    polling: 1000,
  });
  // Up at the squadrons' height, guns hot: a real fight, not a parked plane.
  await page.evaluate(() => {
    const p = window.__ab.state().pos;
    window.__ab.teleport(p.x, p.z, 240);
    window.__ab.setFiring(true);
  });
  await sleep(WARMUP_S * 1000);
  await page.evaluate(() => window.__ab.simTick(true));
  const t0 = Date.now();
  await sleep(SECONDS * 1000);
  const report = await page.evaluate(() => window.__ab.simTick(false));
  const seconds = (Date.now() - t0) / 1000;
  const solo = await page.evaluate(() => window.__ab.solo());
  const fps = await page.evaluate(() => window.__ab.perf().fps);
  await page.close();
  return {
    level: NAMES[level],
    planes: AIR_FORCE[level],
    throttle: rate,
    ticks: report?.ticks ?? 0,
    hz: +((report?.ticks ?? 0) / seconds).toFixed(1),
    p50: report?.p50,
    p95: report?.p95,
    p99: report?.p99,
    max: report?.max,
    pageFps: +fps.toFixed(1),
    intensity: solo.intensity,
    errors: errors.length,
    phases: report?.phases,
  };
}

async function main() {
  if (BUILD) await run("npm", ["run", "build", "-w", "client"]);
  const port = await freePort();
  const preview = await startPreview(port);
  const browser = await chromium.launch({
    headless: true,
    args: [
      ...(process.env.AB_CHROME_ARGS
        ? process.env.AB_CHROME_ARGS.split(" ").filter(Boolean)
        : ["--enable-unsafe-swiftshader"]),
      "--mute-audio",
    ],
    ...(process.env.AB_CHROME ? { executablePath: process.env.AB_CHROME } : {}),
  });
  const rows = [];
  try {
    for (const rate of THROTTLES) {
      for (const level of LEVELS) {
        const r = await measure(browser, port, level, rate);
        rows.push(r);
        const ok = r.p99 <= P99_BUDGET_MS && r.hz >= TICK_HZ * 0.9;
        console.log(
          `${rate === 1 ? "desktop" : `${rate}x throttle`}  ${r.level.padEnd(6)} ${String(r.planes).padStart(3)} planes  tick p50 ${r.p50} ms  p95 ${r.p95}  p99 ${r.p99}  max ${r.max}  ${r.hz} Hz  page ${r.pageFps} fps  ${ok ? "OK" : "OVER"}`,
        );
      }
    }
  } finally {
    await browser.close();
    preview.kill();
  }
  console.log(
    `\nmachine: ${cpus().length}x ${cpus()[0]?.model ?? "?"}, load ${loadavg()
      .map((l) => l.toFixed(1))
      .join(" ")}`,
  );
  console.log("\n| tier | level | planes | tick p50 | p95 | p99 | max | Hz |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    console.log(
      `| ${r.throttle === 1 ? "desktop" : `${r.throttle}× CPU`} | ${r.level} | ${r.planes} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.hz} |`,
    );
  }
  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      `${JSON.stringify({ rows, loadavg: loadavg(), cpus: cpus().length }, null, 2)}\n`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
