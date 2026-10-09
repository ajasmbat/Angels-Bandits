#!/usr/bin/env node
// P3 polish evidence: time-to-first-frame, before/after screenshots, a HUD
// overlap probe and the long soak — one headless harness, run against a
// built client (`npm run build -w client`) served by the real server with
// its default bots and C2's constant chaos.
//
//     node tools/perf/polish.mjs --out <dir> [--label before] \
//       [--ttff 5] [--shots] [--overlap] [--soak 30]
//
// Like gallery.mjs it runs anywhere: AB_CHROME / AB_CHROME_ARGS point it at
// another headless shell; the default args are SwiftShader's, so on a
// GPU-less box every TIME it prints is the CPU rasterising — compare two
// builds measured here, never quote one as what a player sees.
//
// What each mode decides:
//  * --ttff N   N cold boots (fresh context each): first contentful paint,
//               the join card interactive, and FLY → first game frame (the
//               moment the loading card comes down). Medians reported.
//  * --shots    join, loading, HUD, settings, kill and medal moments on a
//               1280×720 desktop and an 844×390 touch phone (DPR 3), plus
//               the phone held upright.
//  * --overlap  every visible fixed HUD box at 1920×1080, 1280×720 and the
//               phone must not intersect another or leave the viewport.
//               World-anchored markers and full-screen overlays are exempt.
//  * --soak M   M minutes in one session: hand-flown random input with
//               fire and boost, one kill + medal moment and one settings
//               open/close a minute, real deaths and respawns along the
//               way. Fails on any console error / page error, a warning
//               outside WARN_ALLOW, heap growth > 15 % over the minute-5
//               baseline (forced GC), GPU programs growing after minute 5,
//               geometries/textures beyond ±10 %, DOM nodes beyond ±5 %, or
//               a stuck UI state (STUCK_S).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const OUT = resolve(opt("out", "polish-out"));
const LABEL = opt("label", "run");
const TTFF_RUNS = Number(opt("ttff", "0"));
const SOAK_MIN = Number(opt("soak", "0"));
const SHOTS = flag("shots");
/** --repo: serve another checkout (its own built client/dist) — the BEFORE
 * arm runs from a git worktree of the earlier commit. */
const SERVE_REPO = resolve(opt("repo", REPO));
const OVERLAP = flag("overlap");
mkdirSync(OUT, { recursive: true });

const CHROME_ARGS = process.env.AB_CHROME_ARGS
  ? process.env.AB_CHROME_ARGS.split(" ")
  : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
// The audio checks need a running AudioContext without a real gesture.
CHROME_ARGS.push("--autoplay-policy=no-user-gesture-required");

const DESKTOP = {
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
};
const DESKTOP_HD = {
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
};
const PHONE = {
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

/** Warnings the soak tolerates — the software rasteriser's own notices
 * about itself, never anything the game logs. */
const WARN_ALLOW = [
  /GPU stall due to ReadPixels/i,
  /Automatic fallback to software WebGL/i,
  // three.js noting the rasteriser lacks an optional extension.
  /KHR_parallel_shader_compile extension not supported/i,
  // ANGLE's own performance notes about its command queue.
  /GL Driver Message \(OpenGL, Performance/i,
];

/** Seconds a UI state may stay up before the soak calls it stuck. */
const STUCK_S = {
  join: 90,
  killcam: 15,
  reconnecting: 20,
  fadeDead: 15,
  settings: 2,
};

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

let liveServer = null;
let liveBrowser = null;
async function killEverything() {
  const server = liveServer;
  const browser = liveBrowser;
  liveServer = null;
  liveBrowser = null;
  if (server !== null) server.kill();
  if (browser !== null) await browser.close().catch(() => {});
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void killEverything().then(() => process.exit(130));
  });
}

async function startServer(port) {
  const log = [];
  const proc = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
    cwd: SERVE_REPO,
    env: {
      ...process.env,
      PORT: String(port),
      // A software-rendered page can go seconds between frames: the
      // production 4 s liveness bound would drop it and resume mid-soak.
      LIVENESS_TIMEOUT_MS: "30000",
      BOOT_TIMEOUT_MS: "180000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveServer = proc;
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null)
      throw new Error(`server died:\n${log.join("")}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) {
        const page = await fetch(`http://127.0.0.1:${port}/`);
        if (!page.ok) {
          throw new Error("no client/dist — run `npm run build -w client`");
        }
        return { proc, log };
      }
    } catch (err) {
      if (String(err).includes("client/dist")) throw err;
    }
    await sleep(250);
  }
  throw new Error(`server never answered:\n${log.join("")}`);
}

/**
 * In-page probes installed before any game code: first contentful paint,
 * when FLY was pressed, and when the loading card came down (the first
 * frame — main.ts closes `#join` from the rAF after the first render).
 * Build-agnostic on purpose: the BEFORE build has no marks of its own.
 */
const INIT_PROBES = () => {
  const probe = {
    fcp: null,
    joinReady: null,
    fly: null,
    firstFrame: null,
  };
  window.__polish = probe;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === "first-contentful-paint" && probe.fcp === null) {
          probe.fcp = e.startTime;
        }
      }
    }).observe({ type: "paint", buffered: true });
  } catch {}
  document.addEventListener(
    "submit",
    () => {
      if (probe.fly === null) probe.fly = performance.now();
    },
    true,
  );
  const watch = () => {
    const join = document.getElementById("join");
    if (!join) return false;
    new MutationObserver(() => {
      const open = join.classList.contains("open");
      const input = document.getElementById("join-name");
      if (open && probe.joinReady === null && input && !input.disabled) {
        probe.joinReady = performance.now();
      }
      if (!open && probe.fly !== null && probe.firstFrame === null) {
        probe.firstFrame = performance.now();
      }
    }).observe(join, { attributes: true, attributeFilter: ["class"] });
    return true;
  };
  if (!watch()) document.addEventListener("DOMContentLoaded", watch);
};

async function openPage(browser, device) {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  await page.addInitScript(INIT_PROBES);
  return { context, page };
}

/** Load, wait for the join card, FLY, wait for the first game frame. */
async function boot(page, url, { onCard, onLoading } = {}) {
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForSelector("#join.open #join-name:not([disabled])", {
    timeout: 120000,
  });
  await page.evaluate(() => {
    const p = window.__polish;
    if (p.joinReady === null) p.joinReady = performance.now();
  });
  if (onCard) await onCard();
  await page.fill("#join-name", "QA");
  await page.press("#join-name", "Enter");
  if (onLoading) await onLoading();
  await page.waitForFunction(() => window.__polish.firstFrame !== null, null, {
    timeout: 240000,
    polling: 250,
  });
  return page.evaluate(() => ({ ...window.__polish }));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)];
};

async function runTtff(browser, url) {
  const runs = [];
  for (let i = 0; i < TTFF_RUNS; i++) {
    const { context, page } = await openPage(browser, DESKTOP);
    try {
      const p = await boot(page, url);
      runs.push({
        fcpMs: p.fcp,
        joinReadyMs: p.joinReady,
        flyToFirstFrameMs: p.firstFrame - p.fly,
      });
      console.log(
        `  ttff run ${i + 1}/${TTFF_RUNS}: ${JSON.stringify(runs.at(-1))}`,
      );
    } finally {
      await context.close();
    }
  }
  const pick = (k) => median(runs.map((r) => r[k]).filter((v) => v !== null));
  return {
    runs,
    median: {
      fcpMs: pick("fcpMs"),
      joinReadyMs: pick("joinReadyMs"),
      flyToFirstFrameMs: pick("flyToFirstFrameMs"),
    },
  };
}

/** Settings open (Esc on desktop, the gear on touch), then closed. */
async function openSettings(page, touch) {
  if (touch) await page.click("#settings-btn", { timeout: 5000 });
  else await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => window.__ab?.settings().open === true,
    null,
    {
      timeout: 5000,
    },
  );
}
async function closeSettings(page) {
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => window.__ab?.settings().open === false,
    null,
    {
      timeout: 5000,
    },
  );
}

async function runShots(browser, url) {
  const shots = [];
  // Generous: on a loaded software rasteriser one frame can take seconds,
  // and a screenshot waits for a fresh one.
  // `settle`: finish CSS entrance animations first — at a software frame
  // rate a 0.2 s fade can still be on its first frame when the shot lands.
  const snap = async (page, name, timeout = 180000, settle = false) => {
    const path = resolve(OUT, `${LABEL}-${name}.png`);
    await page.screenshot({
      path,
      timeout,
      ...(settle ? { animations: "disabled" } : {}),
    });
    shots.push(path);
    console.log(`  shot ${name}`);
  };
  for (const [suffix, device] of [
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ]) {
    const touch = device === PHONE;
    const { context, page } = await openPage(browser, device);
    try {
      await boot(page, url, {
        onCard: async () => {
          await sleep(1500);
          await snap(page, `join-${suffix}`);
        },
        // Straight after FLY: the city build that follows is synchronous,
        // and a screenshot cannot be taken while it holds the main thread.
        onLoading: async () => {
          try {
            await snap(page, `loading-${suffix}`, 8000);
          } catch {
            console.log(`  shot loading-${suffix}: main thread blocked`);
          }
        },
      });
      await sleep(8000);
      await snap(page, `hud-${suffix}`);
      await openSettings(page, touch);
      await sleep(700);
      await snap(page, `settings-${suffix}`, undefined, true);
      await closeSettings(page);
      await sleep(800);
      await page.evaluate(() => window.__ab.qaMoment("kill"));
      await sleep(250);
      await snap(page, `kill-${suffix}`);
      await sleep(4500);
      await page.evaluate(() => window.__ab.qaMoment("medal"));
      // Long enough for the pop-in to settle at a software frame rate.
      await sleep(1500);
      await snap(page, `medal-${suffix}`, undefined, true);
      if (touch) {
        // The join tap took the phone fullscreen (M5): leave it to rotate.
        await page.evaluate(() => document.exitFullscreen?.().catch(() => {}));
        await sleep(300);
        await page.setViewportSize({ width: 390, height: 844 });
        await sleep(1200);
        await snap(page, "portrait-phone");
      }
    } finally {
      await context.close();
    }
  }
  return shots;
}

/** Fixed HUD elements whose overlap is by design: world-anchored markers. */
const OVERLAP_EXEMPT = [
  "crosshair",
  "lead",
  "hitmarker",
  "aim-cursor",
  "damage-flash",
  "damage-arcs",
  "speedlines",
  "fade",
  "touch-layer",
  "touch-ui",
  "touch-coach",
];

/** Runs in the page: visible fixed boxes, and which pairs collide. */
const OVERLAP_PROBE = (exempt) => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const boxes = [];
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed") continue;
    if (el.id && exempt.includes(el.id)) continue;
    if (el.classList.contains("edge-marker")) continue;
    if (el.tagName === "CANVAS" && el.id !== "minimap") continue;
    let hidden = false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (
        s.display === "none" ||
        s.visibility === "hidden" ||
        Number(s.opacity) < 0.05
      ) {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // A full-screen overlay (join card, kill-cam, settings) owns the screen.
    if (r.width * r.height > 0.6 * vw * vh) continue;
    const name = el.id
      ? `#${el.id}`
      : `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`;
    boxes.push({ name, x: r.left, y: r.top, w: r.width, h: r.height });
  }
  // A fixed box nested in another fixed box is one HUD element.
  const outer = boxes.filter(
    (b) =>
      !boxes.some(
        (o) =>
          o !== b &&
          b.x >= o.x &&
          b.y >= o.y &&
          b.x + b.w <= o.x + o.w &&
          b.y + b.h <= o.y + o.h &&
          document
            .querySelector(o.name)
            ?.contains(document.querySelector(b.name)),
      ),
  );
  const overlaps = [];
  for (let i = 0; i < outer.length; i++) {
    for (let j = i + 1; j < outer.length; j++) {
      const a = outer[i];
      const b = outer[j];
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix > 1 && iy > 1)
        overlaps.push({ a: a.name, b: b.name, w: ix, h: iy });
    }
  }
  const offscreen = outer
    .filter(
      (b) => b.x < -1 || b.y < -1 || b.x + b.w > vw + 1 || b.y + b.h > vh + 1,
    )
    .map((b) => b.name);
  return { viewport: { w: vw, h: vh }, boxes: outer, overlaps, offscreen };
};

async function runOverlap(browser, url) {
  const results = [];
  for (const [name, device] of [
    ["desktop-1920", DESKTOP_HD],
    ["desktop-1280", DESKTOP],
    ["phone-844", PHONE],
  ]) {
    const { context, page } = await openPage(browser, device);
    try {
      await boot(page, url);
      await sleep(6000);
      const idle = await page.evaluate(OVERLAP_PROBE, OVERLAP_EXEMPT);
      await page.evaluate(() => window.__ab.qaMoment("medal"));
      await sleep(700);
      const moment = await page.evaluate(OVERLAP_PROBE, OVERLAP_EXEMPT);
      results.push({ name, idle, moment });
      console.log(
        `  overlap ${name}: idle ${idle.overlaps.length} overlaps / ${idle.offscreen.length} off; medal ${moment.overlaps.length} / ${moment.offscreen.length}`,
      );
    } finally {
      await context.close();
    }
  }
  return results;
}

/** Runs in the page: what the soak samples, cheaply. */
const SOAK_SAMPLE = () => {
  const vis = (id, cls) => {
    const el = document.getElementById(id);
    if (!el) return false;
    if (cls) return el.classList.contains(cls);
    const s = getComputedStyle(el);
    return (
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      Number(s.opacity) > 0.05
    );
  };
  const ab = window.__ab;
  const combat = ab.combat();
  return {
    join: vis("join", "open"),
    killcam: vis("killcam", "open"),
    reconnecting: vis("reconnecting"),
    fadeDead: vis("fade", "dead"),
    signalLost: vis("signal-lost", "open"),
    settingsOpen: ab.settings().open,
    alive: combat.alive,
    deaths: combat.scores.find((s) => s.id === ab.net().selfId)?.deaths ?? 0,
    dom: document.getElementsByTagName("*").length,
    ui: ab.qaUi ? ab.qaUi() : null,
  };
};

async function runSoak(browser, url) {
  const { context, page } = await openPage(browser, DESKTOP);
  const cdp = await context.newCDPSession(page);
  const errors = [];
  const warnings = [];
  const allowedWarnings = new Map();
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") errors.push(text);
    else if (msg.type() === "warning") {
      const allowed = WARN_ALLOW.find((re) => re.test(text));
      if (allowed) {
        allowedWarnings.set(
          String(allowed),
          (allowedWarnings.get(String(allowed)) ?? 0) + 1,
        );
      } else warnings.push(text);
    }
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  const minutes = [];
  const stuck = [];
  const since = {};
  let settingsCycles = 0;
  let forcedCrashes = 0;
  let moments = 0;
  let killcams = 0;
  let wasKillcam = false;
  let expectSettings = false;
  try {
    await boot(page, url);
    console.log("  soak: joined");
    const start = Date.now();
    const endAt = start + SOAK_MIN * 60000;
    let nextMinute = start + 60000;
    let nextInput = start;
    let nextProbe = start;
    const keys = ["KeyA", "KeyD", "KeyW", "KeyS"];
    const held = new Set();
    while (Date.now() < endAt) {
      const now = Date.now();
      if (now >= nextInput) {
        // Hand-flown noise: steer, throttle, fire and boost at random.
        for (const k of held) await page.keyboard.up(k);
        held.clear();
        const k = keys[Math.floor(Math.random() * keys.length)];
        await page.keyboard.down(k);
        held.add(k);
        await page.mouse.move(
          200 + Math.random() * 880,
          150 + Math.random() * 420,
        );
        if (Math.random() < 0.5) await page.mouse.down();
        else await page.mouse.up();
        if (Math.random() < 0.15) await page.keyboard.press("Space");
        nextInput = now + 1500 + Math.random() * 1500;
      }
      if (now >= nextProbe) {
        const s = await page.evaluate(SOAK_SAMPLE);
        if (s.signalLost)
          stuck.push({ at: (now - start) / 1000, state: "signalLost" });
        for (const key of Object.keys(STUCK_S)) {
          const on =
            key === "settings" ? s.settingsOpen && !expectSettings : s[key];
          if (on) {
            since[key] ??= now;
            if (
              (now - since[key]) / 1000 > STUCK_S[key] &&
              !since[`${key}Reported`]
            ) {
              since[`${key}Reported`] = true;
              stuck.push({ at: (now - start) / 1000, state: key });
            }
          } else {
            since[key] = undefined;
            since[`${key}Reported`] = false;
          }
        }
        if (s.killcam && !wasKillcam) killcams++;
        wasKillcam = s.killcam;
        nextProbe = now + 2000;
      }
      if (now >= nextMinute) {
        await page.mouse.up();
        for (const k of held) await page.keyboard.up(k);
        held.clear();
        // The minute's scripted moments: a kill, a medal, a settings cycle.
        await page.evaluate(() => window.__ab.qaMoment?.("kill"));
        await sleep(1500);
        await page.evaluate(() => window.__ab.qaMoment?.("medal"));
        moments += 2;
        // Every third minute, fly into the street: a real crash, kill-cam
        // and respawn, whatever the random stick did meanwhile.
        if ((minutes.length + 1) % 3 === 0) {
          await page.evaluate(() => {
            const p = window.__ab.state().pos;
            window.__ab.teleport(p.x, p.z, 1);
          });
          forcedCrashes++;
          await sleep(1000);
        }
        if (
          !(await page.evaluate(() =>
            document.getElementById("killcam")?.classList.contains("open"),
          ))
        ) {
          expectSettings = true;
          try {
            await openSettings(page, false);
            await sleep(1500);
            await closeSettings(page);
            settingsCycles++;
          } catch (err) {
            stuck.push({
              at: (now - start) / 1000,
              state: `settings-cycle: ${err.message}`,
            });
          }
          expectSettings = false;
        }
        await cdp.send("HeapProfiler.collectGarbage");
        const heap = await cdp.send("Runtime.getHeapUsage");
        const s = await page.evaluate(SOAK_SAMPLE);
        const m = {
          minute: minutes.length + 1,
          heapMB: +(heap.usedSize / 1048576).toFixed(2),
          dom: s.dom,
          deaths: s.deaths,
          killcams,
          ...(s.ui ?? {}),
        };
        minutes.push(m);
        console.log(`  soak ${JSON.stringify(m)}`);
        nextMinute += 60000;
      }
      await sleep(200);
    }
  } finally {
    await context.close();
  }
  const base = minutes.find((m) => m.minute === 5) ?? minutes[0];
  const last = minutes.at(-1);
  const growth = (k) =>
    base && last && base[k] ? (last[k] - base[k]) / base[k] : null;
  const verdicts = {
    consoleErrors: errors.length === 0,
    warnings: warnings.length === 0,
    heap: growth("heapMB") !== null && growth("heapMB") <= 0.15,
    dom: growth("dom") !== null && Math.abs(growth("dom")) <= 0.05,
    programs:
      !base?.renderer || last.renderer.programs <= base.renderer.programs,
    geometries:
      !base?.renderer ||
      Math.abs(
        (last.renderer.geometries - base.renderer.geometries) /
          base.renderer.geometries,
      ) <= 0.1,
    textures:
      !base?.renderer ||
      Math.abs(
        (last.renderer.textures - base.renderer.textures) /
          base.renderer.textures,
      ) <= 0.1,
    stuck: stuck.length === 0,
  };
  return {
    minutes: SOAK_MIN,
    pass: Object.values(verdicts).every(Boolean),
    verdicts,
    heapGrowthVsMinute5: growth("heapMB"),
    domGrowthVsMinute5: growth("dom"),
    errors: [...new Set(errors)].slice(0, 50),
    errorCount: errors.length,
    warnings: [...new Set(warnings)].slice(0, 50),
    warningCount: warnings.length,
    allowedWarnings: Object.fromEntries(allowedWarnings),
    stuck,
    settingsCycles,
    forcedCrashes,
    moments,
    killcams,
    samples: minutes,
  };
}

async function main() {
  const port = await freePort();
  await startServer(port);
  liveBrowser = await chromium.launch({
    args: CHROME_ARGS,
    ...(process.env.AB_CHROME ? { executablePath: process.env.AB_CHROME } : {}),
  });
  const url = `http://127.0.0.1:${port}/`;
  const report = {
    label: LABEL,
    chromeArgs: CHROME_ARGS,
    at: new Date().toISOString(),
  };
  if (TTFF_RUNS > 0) {
    console.log(`ttff × ${TTFF_RUNS}`);
    report.ttff = await runTtff(liveBrowser, url);
  }
  if (SHOTS) {
    console.log("shots");
    report.shots = await runShots(liveBrowser, url);
  }
  if (OVERLAP) {
    console.log("overlap");
    report.overlap = await runOverlap(liveBrowser, url);
  }
  if (SOAK_MIN > 0) {
    console.log(`soak ${SOAK_MIN} min`);
    report.soak = await runSoak(liveBrowser, url);
  }
  const path = resolve(OUT, `${LABEL}-report.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${path}`);
  if (report.ttff)
    console.log(`ttff median: ${JSON.stringify(report.ttff.median)}`);
  if (report.soak) {
    console.log(
      `soak: ${report.soak.pass ? "PASS" : "FAIL"} ${JSON.stringify(report.soak.verdicts)}`,
    );
  }
  return report.soak && !report.soak.pass ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(err);
} finally {
  await killEverything();
}
process.exit(code);
