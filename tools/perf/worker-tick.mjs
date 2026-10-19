#!/usr/bin/env node
// SOLO: what does the simulation cost the PLAYER's machine? The game's host
// (server/src/host.ts) runs in the page's sim worker now, so its tick is
// measured there — per difficulty, at the air force that level fields, on
// this machine as it is and on an emulated "mobile tier".
//
// Per (tier, level): a fresh page of the STATIC build (`vite preview`, no
// game server), the level picked on the start screen, the host profiling its
// tick (`sim` AB_TICK_STATS:1, server/src/tickstats.ts) with the level's
// whole air force staged in the air at once (AB_AIRFORCE: the steady state a
// long fight reaches, without minutes of launches first) and the fleet up
// fast (AB_BOSS_FAST). The plane climbs to the squadrons with its guns hot
// (a real fight), a warm-up passes, the profile is reset, and after the
// window the tick's p50 / p95 / p99 / max and the ticks it actually managed
// (on the worker's own clock) are read back off the worker (`__ab.simTick`).
//
//   node tools/perf/worker-tick.mjs [--levels 0,1,2,3] [--tiers desktop,mobile]
//        [--warmup 10] [--seconds 20] [--json out.json] [--no-build]
//
// The MOBILE tier: Chrome's CPU throttle (`Emulation.setCPUThrottlingRate`)
// slows the page's main thread only — a worker is not a target it accepts
// ("Operation is only supported for pages, not workers"), and it does not
// follow its page — so it cannot emulate a phone's sim. Instead the browser
// runs in a systemd scope with its cgroup delegated, and for the warm-up and
// the window the sim worker's THREAD alone (Chrome names it
// "DedicatedWorker") moves into a threaded child cgroup with
// `cpu.max 2500 10000`: a quarter of a core, DevTools' "4x slowdown"
// mid-tier phone, in 2.5 ms slices every 10 ms (a busy loop measured 4.2x).
// The page renders as it would on the phone's GPU — unthrottled — since its
// SwiftShader rasterising here is no phone's cost. Linux and root only.
//
// The budget: the tick fits its TICK_DOWN_HZ slot (50 ms) with room left for
// the page — p99 ≤ 25 ms (half a slot), and the full 20 Hz delivered.
// Wall-clock numbers: read the load average printed beside them.

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { simValue } from "./local-game.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const LEVELS = arg("levels", "0,1,2,3").split(",").map(Number);
const TIERS = arg("tiers", "desktop,mobile").split(",");
const WARMUP_S = Number(arg("warmup", "10"));
const SECONDS = Number(arg("seconds", "20"));
const JSON_OUT = arg("json", "");
const BUILD = !process.argv.includes("--no-build");
/** E1's AIR_FORCE (common/src/waves.ts): each level's planes in the sky. */
const AIR_FORCE = [100, 200, 350, 500];
const NAMES = ["EASY", "NORMAL", "HARD", "INSANE"];
const TICK_HZ = 20;
const P99_BUDGET_MS = 25;
/** The mobile tier: the sim thread's cgroup quota (a quarter of a core)
 * and the systemd scope the browser runs in. */
const MOBILE_CPU_MAX = "2500 10000";
const MOBILE_SCOPE = `ab-mobile-${process.pid}`;

/** The mobile tier's sim-thread quota on (`true`) or off: every
 * DedicatedWorker thread of the scope's processes, in a threaded child
 * cgroup of the scope's own. */
function mobileQuota(on) {
  const scope = execFileSync("systemctl", [
    "show",
    "-p",
    "ControlGroup",
    "--value",
    `${MOBILE_SCOPE}.scope`,
  ])
    .toString()
    .trim();
  const root = `/sys/fs/cgroup${scope}`;
  const sim = `${root}/sim`;
  if (!existsSync(sim)) {
    mkdirSync(sim);
    writeFileSync(`${sim}/cgroup.type`, "threaded");
    writeFileSync(`${root}/cgroup.subtree_control`, "+cpu");
  }
  writeFileSync(`${sim}/cpu.max`, on ? MOBILE_CPU_MAX : "max 10000");
  if (!on) return 0;
  let moved = 0;
  for (const pid of readFileSync(`${root}/cgroup.procs`, "utf8").split("\n")) {
    if (!pid || !existsSync(`/proc/${pid}/task`)) continue;
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const comm = readFileSync(`/proc/${pid}/task/${tid}/comm`, "utf8");
      if (!comm.startsWith("DedicatedWorker")) continue;
      writeFileSync(`${sim}/cgroup.threads`, tid);
      moved++;
    }
  }
  if (moved === 0) throw new Error("mobile tier: no sim worker thread found");
  return moved;
}

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
    // vite's own entry, not `npx vite`: killing npx would orphan the server.
    process.execPath,
    [
      resolve(REPO, "node_modules/vite/bin/vite.js"),
      "preview",
      "--port",
      String(port),
      "--strictPort",
    ],
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

/** The browser for `tier`: as it is, or (mobile) inside the CPU scope. */
function launch(tier) {
  const base = process.env.AB_CHROME ?? chromium.executablePath();
  let executablePath = base;
  if (tier === "mobile") {
    executablePath = join(tmpdir(), `ab-chrome-mobile-${process.pid}.sh`);
    writeFileSync(
      executablePath,
      `#!/bin/sh\nexec systemd-run --scope --quiet --unit=${MOBILE_SCOPE} -p Delegate=yes -- "${base}" "$@"\n`,
    );
    chmodSync(executablePath, 0o755);
  }
  return chromium.launch({
    headless: true,
    executablePath,
    args: [
      ...(process.env.AB_CHROME_ARGS
        ? process.env.AB_CHROME_ARGS.split(" ").filter(Boolean)
        : ["--enable-unsafe-swiftshader"]),
      "--mute-audio",
    ],
  });
}

async function measure(browser, port, tier, level) {
  const mobile = tier === "mobile";
  const page = await browser.newPage({
    viewport: { width: 960, height: 540 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const sim = simValue({
    AB_TICK_STATS: "1",
    AB_BOSS_FAST: "1",
    AB_AIRFORCE: String(AIR_FORCE[level]),
    // A software-rendered (and, here, starved) page boots for minutes:
    // neither its boot nor a slow frame is a dead client.
    LIVENESS_TIMEOUT_MS: "600000",
    BOOT_TIMEOUT_MS: "600000",
  });
  await page.goto(
    `http://127.0.0.1:${port}/?quality=low&res=1&silence=600000&sim=${encodeURIComponent(sim)}`,
  );
  await page.click(`#join-difficulty [data-level="${level}"]`);
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => window.__ab?.combat().alive === true, null, {
    timeout: 900_000,
    polling: 1000,
  });
  // Up among the squadrons, guns hot: a real fight, not a parked plane.
  await page.evaluate(() => {
    const p = window.__ab.state().pos;
    window.__ab.teleport(p.x, p.z, 240);
    window.__ab.setFiring(true);
  });
  if (mobile) mobileQuota(true);
  let start;
  let report;
  try {
    await sleep(WARMUP_S * 1000);
    start = await page.evaluate(() => window.__ab.simTick(true));
    await sleep(SECONDS * 1000);
    report = await page.evaluate(() => window.__ab.simTick(false));
  } finally {
    if (mobile) mobileQuota(false);
  }
  const solo = await page.evaluate(() => window.__ab.solo());
  await page.close();
  const seconds = (report.at - start.at) / 1000;
  return {
    tier,
    level: NAMES[level],
    planes: AIR_FORCE[level],
    ticks: report.ticks,
    hz: +(report.ticks / seconds).toFixed(1),
    p50: report.p50,
    p95: report.p95,
    p99: report.p99,
    max: report.max,
    intensity: solo.intensity,
    errors: errors.length,
    phases: Object.fromEntries(
      Object.entries(report.phases).map(([k, v]) => [k, v.p50]),
    ),
  };
}

async function main() {
  if (BUILD) await run("npm", ["run", "build", "-w", "client"]);
  const port = await freePort();
  const preview = await startPreview(port);
  const rows = [];
  try {
    for (const tier of TIERS) {
      const browser = await launch(tier);
      try {
        for (const level of LEVELS) {
          const r = await measure(browser, port, tier, level);
          rows.push(r);
          const ok = r.p99 <= P99_BUDGET_MS && r.hz >= TICK_HZ * 0.95;
          console.log(
            `${tier.padEnd(7)} ${r.level.padEnd(6)} ${String(r.planes).padStart(3)} planes  tick p50 ${r.p50} ms  p95 ${r.p95}  p99 ${r.p99}  max ${r.max}  ${r.hz} Hz  ${ok ? "OK" : "OVER"}  load ${loadavg()[0].toFixed(1)}`,
          );
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    preview.kill();
  }
  console.log(
    `\nmachine: ${cpus().length}x ${cpus()[0]?.model ?? "?"}, load ${loadavg()
      .map((l) => l.toFixed(1))
      .join(" ")}`,
  );
  console.log(
    "\n| tier | level | planes | tick p50 | p95 | p99 | max | ticks/s |",
  );
  console.log("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    console.log(
      `| ${r.tier} | ${r.level} | ${r.planes} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.hz} |`,
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
