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
//
// A2 widened the soak to the whole room (each client its own browser, so one
// rasteriser cannot starve the others):
//  * --peers N  N more desktop clients (640×360) flying the same room, one
//               of them running the scripted spectacle: tunnel glides, a
//               staged cave-in, a staged carrier launch and break-up.
//  * --phone    a touch phone-profile client (844×390, DPR 3) as well.
//  * --lab      a Flight Lab visit (`?lab`) at minutes 10 and 20 (--lab-at); after,
//               every per-room map in the server's /debug/rooms must have
//               dropped the lab room.
//  * --parity   at minutes 11 and 21 (--parity-at) a late joiner compares its destruction,
//               collapses, boss, cave-ins and chaos with the first client's
//               and the server's — a field that disagrees on every retry is
//               a desync.
// Every client is held to the same limits; the server too: it must stay up,
// write nothing to stderr, keep its heap (forced GC) within +20 % of minute
// 5, and its RSS trend (median step) under 1 MB/min over the last 15 min. The report has one verdict per client, the server, the
// lab and parity, and PASSes only if all of them do.

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
/** --course: the overlap probe also checks the race readout state. */
const COURSE = flag("course");
/** --repo: serve another checkout (its own built client/dist) — the BEFORE
 * arm runs from a git worktree of the earlier commit. */
const SERVE_REPO = resolve(opt("repo", REPO));
/** --ref: with --ttff, a second checkout booted in alternation with the
 * served one (ref, served, ref, served…) — on a shared, loaded box only an
 * interleaved pair compares two builds fairly. */
const REF_REPO = opt("ref", null) ? resolve(opt("ref")) : null;
const OVERLAP = flag("overlap");
const PEERS = Number(opt("peers", "0"));
const SOAK_PHONE = flag("phone");
const SOAK_LAB = flag("lab");
const PARITY = flag("parity");
/** The minutes the lab visits and parity checks happen (comma lists). */
const minutesOpt = (name, fallback) =>
  opt(name, fallback).split(",").map(Number);
const LAB_AT = minutesOpt("lab-at", "10,20");
const PARITY_AT = minutesOpt("parity-at", "11,21");
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
const PEER = {
  viewport: { width: 640, height: 360 },
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

const liveServers = [];
let liveBrowser = null;
/** A2: the soak's extra browsers, one per client. */
const extraBrowsers = [];
async function killEverything() {
  const browsers = [liveBrowser, ...extraBrowsers.splice(0)];
  liveBrowser = null;
  for (const server of liveServers.splice(0)) server.kill();
  for (const b of browsers) if (b !== null) await b.close().catch(() => {});
}
function launchBrowser() {
  return chromium.launch({
    args: [
      ...CHROME_ARGS,
      // A2: several pages share the box; none may be parked as background.
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
    ],
    ...(process.env.AB_CHROME ? { executablePath: process.env.AB_CHROME } : {}),
  });
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void killEverything().then(() => process.exit(130));
  });
}

async function startServer(port, cwd = SERVE_REPO) {
  const log = [];
  /** A2: stderr on its own — the soak fails on any line of it. */
  const errLog = [];
  const proc = spawn(
    "node",
    ["--expose-gc", "--import", "tsx", "server/src/index.ts"],
    {
      cwd,
      env: {
        ...process.env,
        PORT: String(port),
        // A2: /debug/rooms — per-room maps, memory and damage for the soak.
        AB_DEBUG_ROOMS: "1",
        // A software-rendered page can go seconds between frames: the
        // production 4 s liveness bound would drop it and resume mid-soak.
        LIVENESS_TIMEOUT_MS: "30000",
        BOOT_TIMEOUT_MS: "180000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  liveServers.push(proc);
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => {
    log.push(String(d));
    errLog.push(String(d));
  });
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
        return { proc, log, errLog, port };
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

/** --reduced-motion: the page as a reduced-motion user sees it. */
const REDUCED = flag("reduced-motion");

async function openPage(browser, device) {
  const context = await browser.newContext({
    ...device,
    ...(REDUCED ? { reducedMotion: "reduce" } : {}),
  });
  const page = await context.newPage();
  await page.addInitScript(INIT_PROBES);
  return { context, page };
}

/** Load, wait for the join card, FLY, wait for the first game frame. */
async function boot(page, url, { onCard, onLoading, name = "QA" } = {}) {
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForSelector("#join.open #join-name:not([disabled])", {
    timeout: 120000,
  });
  await page.evaluate(() => {
    const p = window.__polish;
    if (p.joinReady === null) p.joinReady = performance.now();
  });
  if (onCard) await onCard();
  await page.fill("#join-name", name);
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

async function bootOnce(browser, url) {
  const { context, page } = await openPage(browser, DESKTOP);
  try {
    const p = await boot(page, url);
    return {
      fcpMs: p.fcp,
      joinReadyMs: p.joinReady,
      flyToFirstFrameMs: p.firstFrame - p.fly,
    };
  } finally {
    await context.close();
  }
}

function summarise(runs) {
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

/** TTFF_RUNS cold boots of `url`, alternated with `refUrl`'s when given. */
async function runTtff(browser, url, refUrl) {
  const runs = [];
  const refRuns = [];
  for (let i = 0; i < TTFF_RUNS; i++) {
    if (refUrl) {
      refRuns.push(await bootOnce(browser, refUrl));
      console.log(
        `  ttff ref ${i + 1}/${TTFF_RUNS}: ${JSON.stringify(refRuns.at(-1))}`,
      );
    }
    runs.push(await bootOnce(browser, url));
    console.log(
      `  ttff run ${i + 1}/${TTFF_RUNS}: ${JSON.stringify(runs.at(-1))}`,
    );
  }
  const out = summarise(runs);
  if (refUrl) out.ref = { repo: REF_REPO, ...summarise(refRuns) };
  return out;
}

/** Settings open (Esc on desktop, the gear on touch), then closed. */
// A2: a click waits for two animation frames of a stable box, and the DPR-3
// phone on a software rasteriser can take seconds per frame under a shared
// soak — 5 s timed out there with nothing wrong in the page.
const UI_TIMEOUT_MS = 30000;
async function openSettings(page, touch) {
  if (touch) await page.click("#settings-btn", { timeout: UI_TIMEOUT_MS });
  else await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => window.__ab?.settings().open === true,
    null,
    { timeout: UI_TIMEOUT_MS },
  );
}
async function closeSettings(page) {
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => window.__ab?.settings().open === false,
    null,
    { timeout: UI_TIMEOUT_MS },
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
      // Freeze the moment at its peak: at seconds per software frame the
      // CSS animations would otherwise be on their first (invisible) frame.
      // Entrances jump to their end; the kill's edge glow holds at its
      // brightest (18 % of 550 ms). Released right after the shot.
      await page.evaluate(() => {
        for (const a of document.getAnimations()) {
          const name = a.animationName ?? "";
          if (name === "ab-kill-pulse") {
            a.pause();
            a.currentTime = 100;
          } else if (Number.isFinite(a.effect?.getTiming().iterations)) {
            a.finish();
          }
        }
      });
      await snap(page, `kill-${suffix}`);
      await page.evaluate(() => {
        for (const a of document.getAnimations()) {
          if (a.playState === "paused") a.play();
        }
      });
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
      // The busiest top band: a stunt course's readout under the gauges,
      // the boss bar, a medal and a full killfeed at once (--course: the
      // P3 build's qaMoment("course"); an older build has no such kind).
      let course = null;
      if (COURSE) {
        await page.evaluate(() => window.__ab.qaMoment("course"));
        await page.waitForSelector("#race.open", { timeout: 30000 });
        for (let k = 0; k < 3; k++) {
          await page.evaluate(() => window.__ab.qaMoment("medal"));
        }
        await sleep(700);
        course = await page.evaluate(OVERLAP_PROBE, OVERLAP_EXEMPT);
      }
      results.push({ name, idle, moment, course });
      console.log(
        `  overlap ${name}: idle ${idle.overlaps.length} overlaps / ${idle.offscreen.length} off; medal ${moment.overlaps.length} / ${moment.offscreen.length}${course ? `; course ${course.overlaps.length} / ${course.offscreen.length}` : ""}`,
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
    fps: ab.perf ? Math.round(ab.perf().fps * 10) / 10 : null,
  };
};

/** A2: what a client must agree with the room about (a late joiner against
 * the long-lived client, both against the server). */
const PARITY_SAMPLE = (serverNow) => {
  const ab = window.__ab;
  // Cave-ins are pruned once per FRAME, so a page drawing 0.1 fps holds
  // settled ones for seconds: compare the ids still live at one server
  // instant, leaving out any within 1.5 s of their end.
  const held = ab.caveIns().held;
  const liveIds = (list) =>
    list
      .filter(([, end]) => end > serverNow + 1500)
      .map(([id]) => id)
      .sort((a, b) => a - b)
      .join(",");
  const d = ab.destruction();
  const b = ab.boss();
  const ch = ab.chaos();
  return {
    room: ab.net().roomId,
    destroyed: d.destroyed,
    fallen: d.fallen,
    collapses: ab
      .recentCollapses(1000)
      .map((c) => `${c.b}@${c.t}`)
      .join(","),
    bossRaid: b.staged ? "staged" : (b.raid?.id ?? null),
    bossDown: b.down !== null && b.down !== undefined,
    bossHp: b.hp.join(","),
    caveIns: held ? liveIds(held) : ab.caveIns().live,
    // Quakes are pruned per frame too: ids live at one instant.
    quakes: ch.held ? liveIds(ch.held.quakes) : ch.quakes.length,
    fires: ch.fires,
  };
};

const SERVER_WARN_ALLOW = [
  // tools/perf/run.mjs's switch; never set by the soak, but harmless.
  /AB_QUIET_CITY/,
];

/** Warnings and errors a page logs, sorted into the soak's buckets. */
function watchConsole(page, c) {
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") c.errors.push(text);
    else if (msg.type() === "warning") {
      const allowed = WARN_ALLOW.find((re) => re.test(text));
      if (allowed) {
        c.allowed.set(
          String(allowed),
          (c.allowed.get(String(allowed)) ?? 0) + 1,
        );
      } else c.warnings.push(text);
    }
  });
  page.on("pageerror", (err) => c.errors.push(`pageerror: ${err.message}`));
}

async function openClient(url, role, device, name) {
  const browser = await launchBrowser();
  extraBrowsers.push(browser);
  const { context, page } = await openPage(browser, device);
  const c = {
    role,
    browser,
    context,
    page,
    touch: Boolean(device.hasTouch),
    cdp: await context.newCDPSession(page),
    errors: [],
    warnings: [],
    allowed: new Map(),
    samples: [],
    stuck: [],
    since: {},
    held: new Set(),
    killcams: 0,
    wasKillcam: false,
    expectSettings: false,
    settingsCycles: 0,
    forcedCrashes: 0,
    moments: 0,
    nextInput: 0,
  };
  watchConsole(page, c);
  await boot(page, url, { name });
  return c;
}

async function closeClient(c) {
  await c.context.close().catch(() => {});
  await c.browser.close().catch(() => {});
  const i = extraBrowsers.indexOf(c.browser);
  if (i >= 0) extraBrowsers.splice(i, 1);
}

/** Hand-flown noise: steer, throttle, fire and boost at random. */
async function noise(c, now) {
  if (now < c.nextInput) return;
  const { page } = c;
  for (const k of c.held) await page.keyboard.up(k);
  c.held.clear();
  const keys = ["KeyA", "KeyD", "KeyW", "KeyS"];
  const k = keys[Math.floor(Math.random() * keys.length)];
  await page.keyboard.down(k);
  c.held.add(k);
  if (c.touch || c.keysOnly) {
    // The phone fires through its trigger and taps the screen now and then;
    // the lab pilot fires the same way and never clicks (a random click on
    // the lab panel's EXIT link is a real navigation away).
    await page.evaluate((on) => window.__ab.setFiring(on), Math.random() < 0.5);
    if (c.touch && Math.random() < 0.3) await page.touchscreen.tap(422, 195);
  } else {
    const vp = page.viewportSize();
    await page.mouse.move(
      vp.width * (0.15 + Math.random() * 0.7),
      vp.height * (0.2 + Math.random() * 0.6),
    );
    if (Math.random() < 0.5) await page.mouse.down();
    else await page.mouse.up();
  }
  if (Math.random() < 0.15) await page.keyboard.press("Space");
  c.nextInput = now + 1500 + Math.random() * 1500;
}

async function releaseInput(c) {
  if (!c.touch && !c.keysOnly) await c.page.mouse.up();
  else await c.page.evaluate(() => window.__ab.setFiring(false));
  for (const k of c.held) await c.page.keyboard.up(k);
  c.held.clear();
}

async function probeUi(c, now, start) {
  const s = await c.page.evaluate(SOAK_SAMPLE);
  // A UI state that clears on a frame (the death fade: two rAFs) cannot be
  // judged stuck in under three frames — at 0.1 fps that is 30 s.
  const frameFloorS = s.fps > 0 ? 3 / s.fps : 0;
  if (s.signalLost)
    c.stuck.push({ at: (now - start) / 1000, state: "signalLost" });
  for (const key of Object.keys(STUCK_S)) {
    const on =
      key === "settings" ? s.settingsOpen && !c.expectSettings : s[key];
    if (on) {
      c.since[key] ??= now;
      if (
        (now - c.since[key]) / 1000 > Math.max(STUCK_S[key], frameFloorS) &&
        !c.since[`${key}Reported`]
      ) {
        c.since[`${key}Reported`] = true;
        c.stuck.push({ at: (now - start) / 1000, state: key });
      }
    } else {
      c.since[key] = undefined;
      c.since[`${key}Reported`] = false;
    }
  }
  if (s.killcam && !c.wasKillcam) c.killcams++;
  c.wasKillcam = s.killcam;
}

async function settingsCycle(c, at) {
  if (
    await c.page.evaluate(() =>
      document.getElementById("killcam")?.classList.contains("open"),
    )
  ) {
    return;
  }
  c.expectSettings = true;
  try {
    await openSettings(c.page, c.touch);
    await sleep(1500);
    await closeSettings(c.page);
    c.settingsCycles++;
  } catch (err) {
    c.stuck.push({ at, state: `settings-cycle: ${err.message}` });
  }
  c.expectSettings = false;
}

/** Fly into the street: a real crash, kill-cam and respawn. */
async function forceCrash(c) {
  await c.page.evaluate(() => {
    const p = window.__ab.state().pos;
    window.__ab.teleport(p.x, p.z, 1);
  });
  c.forcedCrashes++;
}

/** Glide `metres` down tunnel `id` from arc length `s0` at ~60 m/s. */
async function tunnelGlide(c, id, s0, metres) {
  for (let d = 0; d <= metres; d += 12) {
    await c.page.evaluate(
      ([id, s0, d]) => {
        const p = window.__ab.tunnelPose(id, s0, d, 0);
        window.__ab.teleport(p.x, p.z, p.y, p.yaw);
      },
      [id, s0, d],
    );
    await sleep(200);
  }
}

/** The scripted spectacle, one beat a minute on the spectacle client: what a
 * random stick alone would rarely reach. Staged on THIS client only. */
async function spectacle(c, minute) {
  const beat = minute % 5;
  if (beat === 1) {
    await tunnelGlide(c, 0, 330, 300);
  } else if (beat === 2) {
    await c.page.evaluate(() => {
      const t = window.__ab.net().worldTime ?? 0;
      window.__ab.qaCaveIn([{ tunnel: 1, s: 380, gap: 2, t0: t + 1500 }]);
    });
    await tunnelGlide(c, 1, 300, 160);
  } else if (beat === 3) {
    await c.page.evaluate(() => {
      window.__ab.qaCaveIn(null);
      const ab = window.__ab;
      const t = ab.net().worldTime ?? 0;
      ab.teleport(1000, 1400, 290, 0);
      ab.qaBoss({
        x: 1000,
        y: 290,
        z: 1400,
        yaw: 0,
        ahead: 520,
        worldMs: t,
        crossMs: 8000,
        corridor: { near: 70, far: 230, lateral: 25, yLo: 262, yHi: 317 },
      });
      ab.qaBossLaunch(0, 0);
      ab.qaBossLaunch(1, 1500);
    });
  } else if (beat === 4) {
    await c.page.evaluate(() => window.__ab.qaBossDown(0));
  } else if (beat === 0) {
    await c.page.evaluate(() => window.__ab.qaBoss(null));
  }
}

async function debugRooms(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/debug/rooms`);
    return await res.json();
  } catch {
    return null;
  }
}

async function sampleClient(c, minute) {
  await c.cdp.send("HeapProfiler.collectGarbage");
  const heap = await c.cdp.send("Runtime.getHeapUsage");
  const s = await c.page.evaluate(SOAK_SAMPLE);
  const m = {
    minute,
    heapMB: +(heap.usedSize / 1048576).toFixed(2),
    dom: s.dom,
    deaths: s.deaths,
    killcams: c.killcams,
    fps: s.fps,
    ...(s.ui ?? {}),
  };
  c.samples.push(m);
  return m;
}

function verdictsOf(c) {
  const base = c.samples.find((m) => m.minute === 5) ?? c.samples[0];
  const last = c.samples.at(-1);
  const growth = (k) =>
    base && last && base[k] ? (last[k] - base[k]) / base[k] : null;
  const rel = (k) =>
    !base?.renderer ||
    Math.abs((last.renderer[k] - base.renderer[k]) / base.renderer[k]) <= 0.1;
  const verdicts = {
    consoleErrors: c.errors.length === 0,
    warnings: c.warnings.length === 0,
    heap: growth("heapMB") !== null && growth("heapMB") <= 0.15,
    dom: growth("dom") !== null && Math.abs(growth("dom")) <= 0.05,
    programs:
      !base?.renderer || last.renderer.programs <= base.renderer.programs,
    geometries: rel("geometries"),
    textures: rel("textures"),
    stuck: c.stuck.length === 0,
  };
  return {
    role: c.role,
    pass: Object.values(verdicts).every(Boolean),
    verdicts,
    heapGrowthVsMinute5: growth("heapMB"),
    domGrowthVsMinute5: growth("dom"),
    errors: [...new Set(c.errors)].slice(0, 50),
    errorCount: c.errors.length,
    warnings: [...new Set(c.warnings)].slice(0, 50),
    warningCount: c.warnings.length,
    allowedWarnings: Object.fromEntries(c.allowed),
    stuck: c.stuck,
    settingsCycles: c.settingsCycles,
    forcedCrashes: c.forcedCrashes,
    moments: c.moments,
    killcams: c.killcams,
    samples: c.samples,
  };
}

/** A2: the Flight Lab, visited in a page of its own; afterwards the lab room
 * must be gone from every per-room map the server keeps. */
async function labVisit(url, port) {
  const c = await openClient(`${url}?lab`, "lab", PEER, "Lab");
  c.keysOnly = true;
  const labRoom = await c.page.evaluate(() => window.__ab.net().roomId);
  const endAt = Date.now() + 45000;
  while (Date.now() < endAt) {
    await noise(c, Date.now());
    await sleep(200);
  }
  await releaseInput(c);
  const lab = await c.page.evaluate(() => window.__ab.lab() !== null);
  await closeClient(c);
  // The lab room dies with its pilot's socket (liveness at worst).
  let leftover = null;
  for (let i = 0; i < 40; i++) {
    const d = await debugRooms(port);
    leftover = d
      ? Object.entries(d)
          .filter(([, v]) => Array.isArray(v) && v.includes(labRoom))
          .map(([k]) => k)
      : ["/debug/rooms unreachable"];
    if (leftover.length === 0) break;
    await sleep(1000);
  }
  return {
    labRoom,
    labPanel: lab,
    errors: [...new Set(c.errors)],
    warnings: [...new Set(c.warnings)],
    leftover,
    pass:
      lab &&
      c.errors.length === 0 &&
      c.warnings.length === 0 &&
      leftover.length === 0,
  };
}

/** A2: a late joiner against the long-lived client and the server. A field
 * counts as a desync only if it disagrees on every one of the retries. */
async function parityCheck(url, port, main) {
  const c = await openClient(url, "parity", PEER, "Late");
  await sleep(5000);
  const tries = [];
  for (let i = 0; i < 5; i++) {
    // Same machine, same clock: the harness's now is the server's.
    const serverNow = Date.now();
    const [a, b, srv] = await Promise.all([
      main.page.evaluate(PARITY_SAMPLE, serverNow),
      c.page.evaluate(PARITY_SAMPLE, serverNow),
      debugRooms(port),
    ]);
    const room = srv?.damage?.[a.room] ?? null;
    tries.push({ main: a, late: b, server: room });
    await sleep(1000);
  }
  const errors = [...new Set(c.errors)];
  await closeClient(c);
  const sameRoom = tries.every((t) => t.main.room === t.late.room);
  const fields = Object.keys(tries[0].main).filter((k) => k !== "room");
  const desync = [];
  if (sameRoom) {
    for (const k of fields) {
      if (k === "bossRaid" && tries.some((t) => t.main[k] === "staged"))
        continue;
      if (tries.every((t) => t.main[k] !== t.late[k])) {
        desync.push({
          field: k,
          main: tries.at(-1).main[k],
          late: tries.at(-1).late[k],
        });
      }
    }
  }
  // The server holds the truth for the damage counts.
  for (const k of ["destroyed", "fallen"]) {
    if (tries.every((t) => t.server && t.server[k] !== t.main[k])) {
      desync.push({
        field: `server.${k}`,
        server: tries.at(-1).server?.[k],
        main: tries.at(-1).main[k],
      });
    }
  }
  return {
    sameRoom,
    desync,
    errors,
    tries,
    pass: desync.length === 0 && errors.length === 0,
  };
}

async function runSoak(url, server) {
  const clients = [];
  const report = { clients: [], labVisits: [], parity: [], server: null };
  const serverSamples = [];
  try {
    clients.push(await openClient(url, "desktop", DESKTOP, "QA"));
    for (let i = 0; i < PEERS; i++) {
      clients.push(await openClient(url, `peer${i + 1}`, PEER, `Peer${i + 1}`));
    }
    if (SOAK_PHONE)
      clients.push(await openClient(url, "phone", PHONE, "Phone"));
    console.log(`  soak: ${clients.map((c) => c.role).join(", ")} joined`);
    // Every client opens its settings once before anything is sampled: the
    // panel is built on first open, and a baseline taken before that reads
    // the build as DOM growth.
    for (const c of clients) await settingsCycle(c, 0);
    const main = clients[0];
    const show = clients.find((c) => c.role === "peer1") ?? main;
    const start = Date.now();
    const endAt = start + SOAK_MIN * 60000;
    let nextMinute = start + 60000;
    let nextProbe = start;
    let minute = 0;
    while (Date.now() < endAt) {
      const now = Date.now();
      for (const c of clients) await noise(c, now);
      if (now >= nextProbe) {
        for (const c of clients) await probeUi(c, now, start);
        nextProbe = now + 2000;
      }
      if (now >= nextMinute) {
        minute++;
        const at = (now - start) / 1000;
        for (const c of clients) await releaseInput(c);
        // The minute's scripted moments on the first client.
        await main.page.evaluate(() => window.__ab.qaMoment?.("kill"));
        await sleep(1500);
        await main.page.evaluate(() => window.__ab.qaMoment?.("medal"));
        main.moments += 2;
        for (const [i, c] of clients.entries()) {
          // Staggered real crashes and respawns, every third minute each.
          if ((minute + i) % 3 === 0) await forceCrash(c);
        }
        await sleep(1000);
        await settingsCycle(main, at);
        const phone = clients.find((c) => c.role === "phone");
        if (phone && minute % 5 === 0) await settingsCycle(phone, at);
        if (show !== main || PEERS === 0) await spectacle(show, minute);
        if (SOAK_LAB && LAB_AT.includes(minute)) {
          const v = await labVisit(url, server.port);
          report.labVisits.push({ minute, ...v });
          console.log(
            `  lab ${JSON.stringify({ minute, pass: v.pass, leftover: v.leftover, errors: v.errors.length })}`,
          );
        }
        if (PARITY && PARITY_AT.includes(minute)) {
          const v = await parityCheck(url, server.port, main);
          report.parity.push({ minute, ...v });
          console.log(
            `  parity ${JSON.stringify({ minute, pass: v.pass, desync: v.desync })}`,
          );
        }
        const line = [];
        for (const c of clients) {
          const m = await sampleClient(c, minute);
          line.push(
            `${c.role} heap ${m.heapMB} dom ${m.dom} geo ${m.renderer?.geometries} tex ${m.renderer?.textures} prog ${m.renderer?.programs} deaths ${m.deaths} fps ${m.fps}`,
          );
        }
        const d = await debugRooms(server.port);
        const mem = d?.memory;
        serverSamples.push({
          minute,
          heapMB: mem ? +(mem.heapUsed / 1048576).toFixed(2) : null,
          rssMB: mem ? +(mem.rss / 1048576).toFixed(2) : null,
          rooms: d?.rooms?.length ?? null,
        });
        console.log(
          `  soak m${minute}: ${line.join(" | ")} | server heap ${serverSamples.at(-1).heapMB} rss ${serverSamples.at(-1).rssMB}`,
        );
        nextMinute += 60000;
      }
      await sleep(200);
    }
  } finally {
    for (const c of clients) await closeClient(c);
  }
  report.clients = clients.map(verdictsOf);
  const base = serverSamples.find((m) => m.minute === 5) ?? serverSamples[0];
  const last = serverSamples.at(-1);
  const grow = (k) =>
    base?.[k] && last?.[k] ? (last[k] - base[k]) / base[k] : null;
  const stderr = server.errLog
    .join("")
    .split("\n")
    .filter(
      (l) => l.trim() !== "" && !SERVER_WARN_ALLOW.some((re) => re.test(l)),
    );
  // The MEDIAN minute-to-minute step: a leak climbs every minute, while V8
  // reserving a new high-water mark (a lab room's city clone, a GC that
  // grew the heap) is one step it never hands back — not a trend.
  const tail = serverSamples.filter((m) => m.rssMB !== null).slice(-16);
  const steps = tail
    .slice(1)
    .map((m, i) => m.rssMB - tail[i].rssMB)
    .sort((a, b) => a - b);
  const rssSlope =
    steps.length > 0 ? steps[Math.floor((steps.length - 1) / 2)] : null;
  const sv = {
    alive: server.proc.exitCode === null,
    stderr: stderr.length === 0,
    heap: grow("heapMB") !== null && grow("heapMB") <= 0.2,
    // RSS is what V8 has RESERVED, which steps up and is not handed back;
    // the leak signal is heapUsed after a forced GC (above). RSS is held to
    // its trend: a median step under 1 MB/min over the last 15 minutes.
    // (a trend needs a window: under 10 steps there is none to judge)
    rss: steps.length < 10 || rssSlope < 1,
  };
  report.server = {
    pass: Object.values(sv).every(Boolean),
    verdicts: sv,
    heapGrowthVsMinute5: grow("heapMB"),
    rssGrowthVsMinute5: grow("rssMB"),
    rssMedianStepMBLast15: rssSlope,
    stderr: stderr.slice(0, 100),
    samples: serverSamples,
  };
  report.minutes = SOAK_MIN;
  report.pass =
    report.clients.every((c) => c.pass) &&
    report.server.pass &&
    report.labVisits.every((v) => v.pass) &&
    report.parity.every((v) => v.pass);
  report.verdicts = {
    ...Object.fromEntries(report.clients.map((c) => [c.role, c.pass])),
    server: report.server.pass,
    lab: report.labVisits.every((v) => v.pass),
    parity: report.parity.every((v) => v.pass),
  };
  return report;
}

async function main() {
  const port = await freePort();
  const server = await startServer(port);
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
    let refUrl = null;
    if (REF_REPO) {
      const refPort = await freePort();
      await startServer(refPort, REF_REPO);
      refUrl = `http://127.0.0.1:${refPort}/`;
    }
    report.ttff = await runTtff(liveBrowser, url, refUrl);
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
    report.soak = await runSoak(url, server);
  }
  const path = resolve(OUT, `${LABEL}-report.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${path}`);
  if (report.ttff)
    console.log(`ttff median: ${JSON.stringify(report.ttff.median)}`);
  if (report.ttff?.ref) {
    console.log(`ttff ref median: ${JSON.stringify(report.ttff.ref.median)}`);
  }
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
