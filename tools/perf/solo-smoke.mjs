#!/usr/bin/env node
// SOLO smoke: the single-player game from the STATIC build alone — `vite
// preview` serves client/dist, no game server runs — played headless for a
// few minutes. It fails on any console error or page error, and on any of
// the solo game's milestones not happening:
//
//   spawn (alive, on the local host), enemies in the air (snapshots), a wave
//   on, the airship fleet up, the city breaking, a death and its respawn
//   (forced by flying into the street), pause (Esc: the world clock stands
//   still, the sim worker sends nothing), resume and RESTART (a fresh game
//   at the chosen difficulty, straight past the start screen).
//
//   node tools/perf/solo-smoke.mjs [--minutes 3] [--difficulty 3] [--no-build]
//
// Needs Playwright's Chromium (`npm run perf:setup`). On a box with no GPU it
// renders on SwiftShader — slow frames, but the simulation is the worker's,
// so every milestone still lands on time. AB_CHROME / AB_CHROME_ARGS pick
// another browser, as in run.mjs.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const MINUTES = Number(arg("minutes", "3"));
const DIFFICULTY = Number(arg("difficulty", "3"));
const BUILD = !process.argv.includes("--no-build");
const BOOT_WAIT_MS = 240_000;

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

/** `vite preview` of client/dist on `port` — statics only. */
async function startPreview(port) {
  const proc = spawn(
    "npx",
    ["vite", "preview", "--port", String(port), "--strictPort"],
    { cwd: resolve(REPO, "client"), stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = [];
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error(`preview died:\n${log}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error(`vite preview never answered:\n${log.join("")}`);
}

const CHROME_ARGS = [
  ...(process.env.AB_CHROME_ARGS
    ? process.env.AB_CHROME_ARGS.split(" ").filter(Boolean)
    : ["--enable-unsafe-swiftshader"]),
  "--mute-audio",
  "--autoplay-policy=no-user-gesture-required",
];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** Wait until `fn` (in the page) is truthy; false on timeout. */
async function until(page, fn, arg, timeout) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 500 });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (BUILD) await run("npm", ["run", "build", "-w", "client"]);
  const port = await freePort();
  const preview = await startPreview(port);
  const browser = await chromium.launch({
    headless: true,
    args: CHROME_ARGS,
    ...(process.env.AB_CHROME
      ? { executablePath: process.env.AB_CHROME }
      : {}),
  });
  const errors = [];
  try {
    const page = await browser.newPage({
      viewport: { width: 960, height: 540 },
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    // The worker's own errors and logs surface as the page's console too.
    page.on("worker", (w) =>
      w.on("console", (m) => {
        if (m.type() === "error") errors.push(`worker: ${m.text()}`);
      }),
    );
    const url = `http://127.0.0.1:${port}/?quality=low`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // The start screen: a difficulty pick, then PLAY.
    await page.click(`#join-difficulty [data-level="${DIFFICULTY}"]`);
    await page.click('#join button[type="submit"]');
    const booted = await until(
      page,
      () => typeof window.__ab !== "undefined" && window.__ab.combat().alive,
      null,
      BOOT_WAIT_MS,
    );
    check("spawn: booted on the local host and alive", booted);
    if (!booted) throw new Error("never booted");
    const local = await until(
      page,
      () => window.__ab.solo().local && window.__ab.solo().snapshots > 0,
      null,
      30_000,
    );
    check("local mode: no server, the sim worker answers", local);
    await until(
      page,
      (want) => window.__ab.solo().intensity === want,
      DIFFICULTY,
      30_000,
    );
    const level = await page.evaluate(() => window.__ab.solo());
    check(
      "difficulty reached the host",
      level.intensity === DIFFICULTY,
      JSON.stringify(level),
    );

    // Play: guns on, nose on the nearest enemy, for the run's length.
    const endAt = Date.now() + MINUTES * 60_000;
    const seen = {
      enemies: 0,
      wave: false,
      ships: 0,
      destroyed: 0,
      died: false,
      respawned: false,
    };
    let crashed = false;
    while (Date.now() < endAt) {
      const s = await page.evaluate(() => {
        const ab = window.__ab;
        const c = ab.combat();
        const me = ab.state().pos;
        let best = null;
        for (const t of c.targets) {
          const d = Math.hypot(t.pos.x - me.x, t.pos.z - me.z);
          if (!best || d < best.d) best = { d, t };
        }
        if (c.alive && best) {
          ab.aimAt(best.t.pos.x, best.t.pos.z, best.t.pos.y);
          ab.setFiring(true);
        }
        const solo = ab.solo();
        return {
          alive: c.alive,
          enemies: c.targets.length,
          deaths: (c.scores.find((r) => r.id === ab.net().selfId) ?? {})
            .deaths,
          wave: solo.wave,
          ships: ab.fleet().up,
          destroyed: ab.destruction().destroyed,
          me,
        };
      });
      seen.enemies = Math.max(seen.enemies, s.enemies);
      seen.wave ||= s.wave > 0;
      seen.ships = Math.max(seen.ships, s.ships);
      seen.destroyed = Math.max(seen.destroyed, s.destroyed);
      if (!s.alive) seen.died = true;
      if (seen.died && s.alive) seen.respawned = true;
      // Halfway: fly into the street to see a death and its respawn.
      if (!crashed && Date.now() > endAt - (MINUTES * 60_000) / 2) {
        crashed = true;
        if (!seen.died) {
          await page.evaluate(() => {
            const p = window.__ab.state().pos;
            window.__ab.teleport(p.x, p.z, 0.5);
          });
        }
      }
      await sleep(2000);
    }
    check("fight: enemy planes in the air", seen.enemies > 0, `${seen.enemies} in range at most`);
    check("waves: a wave came on", seen.wave);
    check("airships: the fleet flew", seen.ships > 0, `${seen.ships} at most`);
    check("destruction: the city broke", seen.destroyed > 0, `${seen.destroyed} chunks`);
    check("death", seen.died);
    if (seen.died && !seen.respawned) {
      seen.respawned = await until(
        page,
        () => window.__ab.combat().alive,
        null,
        30_000,
      );
    }
    check("respawn", seen.respawned);

    // Pause: Esc opens the pause menu and the worker stops.
    await page.evaluate(() => window.__ab.setFiring(false));
    await page.keyboard.press("Escape");
    await sleep(500);
    const p0 = await page.evaluate(() => window.__ab.solo());
    await sleep(3000);
    const p1 = await page.evaluate(() => window.__ab.solo());
    check(
      "pause: Esc pauses the host (no snapshots, the clock stands)",
      p0.paused && p1.paused && p1.snapshots === p0.snapshots,
      `${p0.snapshots} → ${p1.snapshots} snapshots over 3 s`,
    );
    await page.click("#pause-resume");
    await sleep(3000);
    const p2 = await page.evaluate(() => window.__ab.solo());
    check(
      "resume: the host ticks again",
      !p2.paused && p2.snapshots > p1.snapshots,
      `${p1.snapshots} → ${p2.snapshots}`,
    );

    // Restart: a fresh game at the same difficulty, past the start screen.
    await page.keyboard.press("Escape");
    await sleep(500);
    await Promise.all([
      page.waitForEvent("load", { timeout: BOOT_WAIT_MS }),
      page.click("#pause-restart"),
    ]);
    const again = await until(
      page,
      () => typeof window.__ab !== "undefined" && window.__ab.combat().alive,
      null,
      BOOT_WAIT_MS,
    );
    const after = again
      ? await page.evaluate(() => window.__ab.solo())
      : { intensity: -1 };
    check(
      "restart: a fresh game at the same difficulty",
      again && after.intensity === DIFFICULTY,
      JSON.stringify(after),
    );
  } finally {
    await browser.close();
    preview.kill();
  }
  check(
    "no console or page errors",
    errors.length === 0,
    errors.slice(0, 5).join(" | "),
  );
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\nsolo smoke: ${results.length - failed.length}/${results.length} passed`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
