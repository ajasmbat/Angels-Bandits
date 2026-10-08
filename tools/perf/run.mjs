#!/usr/bin/env node
// The headless perf harness (P1). One command, from a clean checkout:
//
//     npm run perf
//
// It builds the client, boots the real server on a free port, joins headless
// in GPU-backed Chromium, flies the fixed path in ./segments.mjs, and reports
// p50 / p95 / p99 / worst frame and draw calls PER SEGMENT — machine-readable
// JSON plus a human table. See README.md for the full flag list and for why
// each design choice is the way it is.
//
// Two decisions worth knowing before you read any number it prints:
//
//  * VSYNC IS DISABLED. With vsync on, an M3 renders this scene in ~10 ms and
//    reports 16.7 ms, because that is when the next frame is allowed to
//    start. Every optimisation would measure as zero. `--disable-gpu-vsync
//    --disable-frame-rate-limit` makes rAF free-run, so the frame time is the
//    frame's actual cost. Numbers here are therefore COSTS, not the fps a
//    player sees — a p50 of 8 ms means "60 fps with 2x headroom".
//  * THE PIXEL RATIO IS PINNED (default 2, i.e. Retina). The adaptive scaler
//    would otherwise change the workload mid-measurement and quietly turn
//    every comparison into a comparison of two different resolutions.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, loadavg, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startPilots } from "./pilots.mjs";
import { prepareRefBuild } from "./refbuild.mjs";
import {
  BUDGETS,
  DEFAULT_WEATHER,
  PILOT_SETTLE_MS,
  SAMPLE_MS,
  SEGMENTS,
  SETTLE_MS,
  STRIKE_LEAD_MS,
  TRAINS_SLIDE_MAX_MS,
  WARMUP_MS,
  segmentWorldMs,
  warmupWorldMs,
} from "./segments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

/**
 * Report format version — bump when a field's meaning changes, or when
 * fields are added that a reader diffing two reports would otherwise take
 * for corruption.
 *
 * 2: per-segment `spikes` / `gpuSpikes`, `requestedPixelRatio` and
 *    `pixelRatioHonoured`, and the raw `samples` / `gpuSamples` arrays under
 *    `--samples`. No existing field changed meaning and nothing reads this
 *    version to compare, so a version-1 baseline is still comparable.
 * 3: O3 — the `street` and `furball` segments (appended, so the first five
 *    still line up by index), per-segment `tier`, `weather`,
 *    `weatherPinned`, `planes` and `verdicts`, and `config.quality` /
 *    `config.ref`. `overall` now pools seven segments, so compare an older
 *    report segment by segment rather than on its overall row.
 * 4: M3 — `harness.device` / `cpuThrottle` / `segments`, per-segment
 *    `jsP50`, and `config.fragmentProxy`. With `--segments`, `segments`
 *    holds only the named ones, so match them by name, not index.
 */
const REPORT_VERSION = 4;
const VIEWPORT = { width: 1280, height: 720 };
const DEVICE_SCALE_FACTOR = 2;

/**
 * M3 `--device`: the page each arm is measured in. `desktop` is what every
 * earlier report used. `phone` is a landscape iPhone 12-class screen — 844×390
 * CSS px at a device ratio of 3, touch, mobile viewport — so a pinned
 * `--res 2` and Mobile's 1.25 ceiling both really apply, and the pixel counts
 * are a phone's rather than a laptop's.
 */
export const DEVICES = {
  desktop: {
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    hasTouch: false,
    isMobile: false,
  },
  phone: {
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  },
};
/** The device every page of this invocation opens as (set from --device). */
let device = DEVICES.desktop;
/** CDP CPU throttling rate for every page (1 = none; set from --cpu-throttle). */
let cpuThrottle = 1;
/** --segments: the names to fly, or null for all of SEGMENTS. */
let segmentFilter = null;

/** The segments this invocation flies, in SEGMENTS order. Every per-index
 * structure (passes, determinism, the report) is built over this list. */
export const activeSegments = () =>
  segmentFilter === null
    ? SEGMENTS
    : SEGMENTS.filter((s) => segmentFilter.has(s.name));

/**
 * Open a measured page as `device`, CPU-throttled if asked. Throttling is a
 * CDP emulation on the page's renderer: the page's JS (and only its JS) runs
 * `cpuThrottle` times slower — the runner's stand-in for a phone's CPU.
 */
async function openPage(browser) {
  const page = await browser.newPage(device);
  if (cpuThrottle !== 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
  }
  return page;
}
/** The pixel ratio measurements are taken at unless --res says otherwise. */
const DEFAULT_PINNED_RATIO = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    label: "run",
    aa: null, // null = whatever the client ships as its default
    res: String(DEFAULT_PINNED_RATIO),
    runs: 1,
    out: resolve(HERE, "last.json"),
    baseline: false,
    compare: null,
    ab: null,
    build: true,
    port: 0,
    headed: false,
    quiet: false,
    strict: false,
    samples: false,
    quality: "high",
    abRef: null,
    soak: null,
    device: "desktop",
    cpuThrottle: 1,
    segments: null,
  };
  const finish = () => {
    // There is no determinism check with a single pass, so --strict would
    // exit 0 having asserted nothing at all — the most dangerous shape a
    // gate can have.
    if (opts.strict && !(opts.runs >= 2)) {
      throw new Error("--strict needs at least two passes: add --runs 3");
    }
    if (!Number.isFinite(opts.runs) || opts.runs < 1) {
      throw new Error(`--runs must be a positive number (got ${opts.runs})`);
    }
    if (opts.ab !== null && opts.abRef !== null) {
      throw new Error("--ab and --ab-ref both name the second arm: pick one");
    }
    if (!(opts.device in DEVICES)) {
      throw new Error(
        `--device must be one of ${Object.keys(DEVICES).join(", ")} (got ${opts.device})`,
      );
    }
    if (!Number.isFinite(opts.cpuThrottle) || opts.cpuThrottle < 1) {
      throw new Error(
        `--cpu-throttle must be a rate >= 1 (got ${opts.cpuThrottle})`,
      );
    }
    if (opts.segments !== null) {
      const known = new Set(SEGMENTS.map((s) => s.name));
      const bad = opts.segments.filter((n) => !known.has(n));
      if (bad.length > 0 || opts.segments.length === 0) {
        throw new Error(
          `--segments takes names from: ${[...known].join(", ")} (got ${opts.segments.join(",")})`,
        );
      }
    }
    return opts;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--label":
        opts.label = next();
        break;
      case "--aa":
        opts.aa = next();
        break;
      case "--res":
        opts.res = next();
        break;
      case "--runs":
        opts.runs = Number(next());
        break;
      case "--out":
        opts.out = resolve(process.cwd(), next());
        break;
      case "--baseline":
        opts.baseline = true;
        break;
      case "--compare":
        opts.compare = resolve(process.cwd(), next());
        break;
      case "--ab":
        opts.ab = abQuery(next());
        break;
      case "--ab-ref":
        opts.abRef = next();
        break;
      case "--quality":
        opts.quality = next();
        break;
      case "--no-build":
        opts.build = false;
        break;
      case "--port":
        opts.port = Number(next());
        break;
      case "--headed":
        opts.headed = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--strict":
        opts.strict = true;
        break;
      case "--samples":
        opts.samples = true;
        break;
      case "--soak":
        opts.soak = Number(next());
        break;
      case "--device":
        opts.device = next();
        break;
      case "--cpu-throttle":
        opts.cpuThrottle = Number(next());
        break;
      case "--segments":
        opts.segments = String(next())
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        break;
      case "--help":
      case "-h":
        console.log(readFileSync(resolve(HERE, "README.md"), "utf8"));
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag ${arg} (try --help)`);
    }
  }
  return finish();
}

// --- Process plumbing -----------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: REPO, stdio: "inherit", ...opts });
    p.on("exit", (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}`)),
    );
  });
}

/** A port nothing is listening on. Dev-server zombies from other sessions
 * squat 8080/5173 on this machine, so the harness never assumes a port. */
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

async function startServer(port, cwd = REPO) {
  const log = [];
  const proc = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`server died:\n${log.join("")}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error(`server never answered /healthz:\n${log.join("")}`);
}

// --- The measured pass ----------------------------------------------------

/** Chromium flags. The vsync pair is the whole reason this tool measures
 * anything; ANGLE/Metal is the difference between the real GPU and
 * SwiftShader, which collapses to ~9 fps under the bloom chain. */
const CHROME_ARGS = [
  ...(process.env.AB_CHROME_ARGS
    ? process.env.AB_CHROME_ARGS.split(" ").filter(Boolean)
    : ["--use-angle=metal", "--enable-gpu"]),
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
  "--mute-audio",
  "--autoplay-policy=no-user-gesture-required",
];

/**
 * `--ab` is a URL QUERY for a second arm of the SAME build. A bare commit
 * hash there used to be silently read as the query `86e5982=` — an arm
 * identical to the first, reported as a paired comparison. Fail instead,
 * and name the flag that does build another commit.
 */
export function abQuery(value) {
  if (value === undefined) throw new Error("--ab needs a query string");
  if (/^[0-9a-f]{7,40}$/i.test(value)) {
    throw new Error(
      `--ab takes a URL query (e.g. "quality=low"), not a commit.\nTo measure another build, use:  --ab-ref ${value}`,
    );
  }
  return value;
}

async function joinGame(page, url) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.fill("#join-name", "PERFBOT");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => typeof window.__ab !== "undefined", null, {
    timeout: 60_000,
  });
  // Bots fly a live sim and shoot back — deterministic per room, but their
  // POSES depend on wall-clock timing, so they would smear every segment.
  // An empty room is the only reproducible room.
  await page.evaluate(() => window.__ab.setBots(0));
  await page.waitForFunction(
    () => window.__ab.combat().targets.length === 0,
    null,
    { timeout: 30_000 },
  );
  // P2: the click on Join leaves the cursor parked on the button, and the
  // mouse-aim instructor flies the pipper onto the cursor — so every flown
  // segment dived toward it (core lost 7 m, canyon 7 m, and `street` sank
  // onto T2's x = 600 viaduct and crashed once F6 made the response crisp).
  // A pointer that has left the window is attitude hold (flight-input.ts
  // presence fade), which is what an unpiloted fixed path means: level
  // flight from each teleport, as P1's path was laid out for.
  await page.evaluate(() =>
    window.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null })),
  );
  return errors;
}

/**
 * Fly one segment and return its FrameStats plus where it was flown.
 *
 * The ENTIRE segment runs inside one page.evaluate, and its waits are driven
 * by the page's own rAF clock. That is not stylistic: with vsync off the
 * render thread is saturated, so a CDP round-trip can sit queued for
 * *seconds*. Timing the window from Node let segments run 8 s instead of 5,
 * flying the plane a block and a half past where the path said it would be —
 * which is exactly the kind of silent drift a determinism claim has to not
 * have.
 */
async function flySegment(page, seg, sampleMs, worldMs) {
  const stats = await page.evaluate(
    async (s) => {
      const ab = window.__ab;
      /** Wait `ms` of in-page time, ticking on the frame loop itself. */
      const waitMs = (ms) =>
        new Promise((resolve) => {
          const t0 = performance.now();
          const tick = () =>
            performance.now() - t0 >= ms
              ? resolve()
              : requestAnimationFrame(tick);
          requestAnimationFrame(tick);
        });

      // O4: pin the WORLD clock (segments.mjs WORLD_EPOCH_MS) so traffic,
      // signage, movers, the storm and every other time-driven system draw
      // the same scene on every pass. An --ab-ref build from before O4 has
      // no hook: it flies on the live clock and is reported NOT PINNED.
      const worldPinned = typeof ab.pinWorld === "function";
      if (worldPinned) {
        ab.pinWorld(s.worldMs);
        if (s.storm) {
          // Slide the pin so the next scheduled strike lands strikeLeadMs
          // into the window. No more flying unpiloted for up to 15 s while
          // waiting for the live clock to reach a strike.
          const next = ab.storm().nextStrike;
          if (next !== null) {
            ab.pinWorld(next.timeMs - s.settleMs - s.strikeLeadMs);
          }
        }
      }
      // P2: a train-station segment slides its world clock forward to the
      // first moment two trains on opposite tracks both stand inside the
      // station — searched on the pure schedule (`__ab.train(t)`), so every
      // pass finds the same moment. Null when the build has no hook or the
      // moment is further than slideMaxMs away (reported, never guessed).
      let trains = null;
      if (s.trainsAt && worldPinned && typeof ab.train === "function") {
        const { line, station, withinM } = s.trainsAt;
        // Optional chaining throughout: an --ab-ref build from before T2
        // has no `lines` / `trains` read-back, and simply finds no moment.
        const st = ab.train(s.worldMs)?.lines?.[line]?.stations?.[station];
        const wrap = (d) => d - Math.round(d / 2000) * 2000;
        trains = { offsetMs: null, tracks: null };
        for (let dt = 0; st && dt <= s.slideMaxMs; dt += 250) {
          const inside = (ab.train(s.worldMs + dt)?.trains ?? []).filter(
            (tr) =>
              tr.line === line &&
              Math.hypot(wrap(tr.x - st.x), wrap(tr.z - st.z)) <= withinM,
          );
          if (new Set(inside.map((tr) => tr.track)).size >= 2) {
            ab.pinWorld(s.worldMs + dt);
            trains = {
              offsetMs: dt,
              tracks: inside.map((tr) => `${tr.track}#${tr.train}`),
            };
            break;
          }
        }
      }
      // O3: pin the segment's weather (O4: every segment — a named phase,
      // else clear). After the world pin: the weather pin is an offset from
      // the world clock. An --ab-ref build from before L4 has no weather
      // hook at all: the segment still flies, and is reported as having no
      // baseline rather than as a delta.
      const weatherName = s.weather ?? s.defaultWeather;
      const weatherPinned = typeof ab.weather === "function";
      if (weatherPinned) ab.weather(weatherName);
      ab.teleport(s.x, s.z, s.y, s.yaw);
      // O3: a HELD view re-teleports every frame instead of flying the
      // street — the furball's fake pilots weave ahead of a fixed point, so
      // the camera has to stay on it.
      // P2: a GLIDE re-teleports every frame too, but along the nose at a
      // fixed speed of WALL time from the teleport, so the path is the same
      // on a 3 fps software renderer as on a GPU (the sim's step is clamped,
      // so a flown plane would cover a fraction of it there).
      let holding = s.hold === true || s.glide !== undefined;
      const glideFrom = performance.now();
      const hold = () => {
        if (!holding) return;
        if (s.glide) {
          const d = Math.min(
            s.glide.maxM,
            (s.glide.speed * (performance.now() - glideFrom)) / 1000,
          );
          ab.teleport(
            s.x - Math.sin(s.yaw) * d,
            s.z - Math.cos(s.yaw) * d,
            s.y,
            s.yaw,
          );
        } else {
          ab.teleport(s.x, s.z, s.y, s.yaw);
        }
        requestAnimationFrame(hold);
      };
      if (holding) requestAnimationFrame(hold);
      // O4 first-sight probe (an init script counts GL allocations): what
      // the settle and the window each had to compile or allocate.
      const gl = () => (window.__abGl ? { ...window.__abGl } : null);
      const glAtSettle = gl();
      await waitMs(s.settleMs);

      if (s.storm && !worldPinned) {
        // Line the window up so a scheduled strike lands `strikeLeadMs` in.
        // Strike times are on the SERVER clock; renderTime() is this client's
        // estimate of it.
        const next = ab.storm().nextStrike;
        const rt = ab.net().renderTime;
        const lead = next === null || rt === null ? null : next.timeMs - rt;
        if (lead !== null && lead > s.strikeLeadMs) {
          await waitMs(lead - s.strikeLeadMs);
        }
      }

      // O4: the workload must not change under the window — a ratio step
      // reallocates every full-res and bloom target, a tier step changes
      // the scene. Read at both ends.
      const workload = () =>
        `${ab.render().pixelRatio}/${ab.quality?.().tier ?? "-"}`;
      const workloadBefore = workload();
      const aliveBefore = ab.combat().alive;
      const glAtWindow = gl();
      // Where the window starts on the world clock (null on an older build).
      const worldAtWindow = worldPinned ? (ab.net().worldTime ?? null) : null;
      // Planes in the room (self + live remotes), at both ends of the window
      // rather than per frame — a per-frame read would cost JS inside the
      // very window being measured.
      const planesNow = () => (ab.combat().targets?.length ?? 0) + 1;
      const planesBefore = planesNow();
      ab.perfReset();
      await waitMs(s.sampleMs);
      const planes = Math.min(planesBefore, planesNow());
      const glAtEnd = gl();
      const workloadStable = workload() === workloadBefore;
      holding = false;
      if (weatherPinned) ab.weather(null);
      const diff = (a, b) =>
        a === null || b === null
          ? null
          : {
              programs: b.programs - a.programs,
              textures: b.textures - a.textures,
              buffers: b.buffers - a.buffers,
            };
      const combat = ab.combat();
      const selfId = ab.net().selfId;
      // The GPU-clock cost of the same window. THIS is the number to read
      // for a render change: contention from everything else on the machine
      // cannot move it, and with vsync off the CPU runs several frames ahead
      // of the GPU, so wall-clock deltas understate the GPU's real load.
      const gpu = ab.gpuStats();
      return {
        ...ab.perfStats(),
        // Every frame time in the window, oldest first. The percentiles
        // above are a summary and a summary cannot say WHERE in the window
        // a 150 ms frame landed — which is the whole question about the
        // `worst` column. Optional so an OLDER client build still measures.
        samples: ab.perfSamples?.() ?? [],
        // Frames the GPU timer could not open a query for. Non-zero means
        // its p95/worst below are missing their tail — the pool empties on
        // exactly the frames those percentiles are made of.
        // Optional so the harness can still measure an OLDER client build
        // (checked out to compare against), which has no such hook.
        gpuStarved: ab.gpuStarved?.() ?? null,
        // The same window as `samples`, measured on the GPU clock. The PAIR
        // is the instrument: a JS pause (GC, a long script) lands in the
        // wall samples and NOT here, because the GPU sat idle through it,
        // while a driver or compositor stall lands in both.
        gpuSamples: ab.gpuSamples?.() ?? [],
        gpuP50: gpu === null ? null : gpu.p50,
        gpuP95: gpu === null ? null : gpu.p95,
        gpuWorst: gpu === null ? null : gpu.worst,
        gpuFrames: gpu === null ? null : gpu.count,
        alive: combat.alive,
        aliveBefore,
        // Why the plane died, if it did (an older build has no cause).
        death:
          combat.lastDeath && combat.lastDeath.victimId === selfId
            ? {
                cause: combat.lastDeath.cause ?? null,
                killerId: combat.lastDeath.killerId,
              }
            : null,
        pos: ab.state().pos,
        strikes: ab.storm().strikes.length,
        // O3. Optional so an older build (--ab-ref) still measures.
        tier: ab.quality?.().tier ?? null,
        // M3: the window's pre-render JS cost per frame (sim, streaming,
        // instance packing). Optional for an older build.
        jsP50: ab.jsStats?.().p50 ?? null,
        weather: weatherName,
        weatherPinned,
        // O4.
        worldPinned,
        worldMs: worldAtWindow,
        workloadStable,
        firstSight: {
          settle: diff(glAtSettle, glAtWindow),
          window: diff(glAtWindow, glAtEnd),
        },
        planes,
        // P2: the train moment a `trainsAt` segment slid to (null otherwise).
        trains,
      };
    },
    {
      ...seg,
      sampleMs,
      settleMs: SETTLE_MS,
      strikeLeadMs: STRIKE_LEAD_MS,
      slideMaxMs: TRAINS_SLIDE_MAX_MS,
      worldMs,
      defaultWeather: DEFAULT_WEATHER,
    },
  );
  return {
    name: seg.name,
    what: seg.what,
    ...stats,
    spikes: summariseSpikes(stats.samples, stats.p50),
    // Positions here are fractions of the GPU window, not of the wall
    // window; the two windows cover the same wall time but not the same
    // sample count (a query resolves late, a starved frame never resolves).
    gpuSpikes: summariseSpikes(stats.gpuSamples, stats.gpuP50 ?? 0),
    verdicts: segmentVerdicts(seg.name, stats),
  };
}

/**
 * O3's per-segment contract (BUDGETS in segments.mjs), judged on one
 * segment's stats. Each verdict is true, false, or null when this run could
 * not measure it (no GPU timer; no budget defined for the segment).
 *
 *  - `fps60`   — GPU p50 within BUDGETS.gpuP50Ms. GPU, not wall: with vsync
 *                off the wall clock is the CPU's pace, and the GPU number is
 *                the one a frame at ratio 2 has to fit in.
 *  - `hitches` — wall p99 <= BUDGETS.hitchRatio x wall p50.
 *  - `draws`   — median draw calls within the segment's own budget, if any.
 *  - `room`    — a segment that asks for fake pilots really had the full
 *                room in view for the whole window.
 */
export function segmentVerdicts(name, stats) {
  const draws = BUDGETS.drawCalls[name];
  const seg = SEGMENTS.find((s) => s.name === name);
  return {
    fps60:
      typeof stats.gpuP50 === "number" && stats.gpuP50 > 0
        ? stats.gpuP50 <= BUDGETS.gpuP50Ms
        : null,
    hitches: stats.p50 > 0 ? stats.p99 <= BUDGETS.hitchRatio * stats.p50 : null,
    draws: draws === undefined ? null : stats.drawCalls <= draws,
    room:
      seg?.pilots === undefined
        ? null
        : typeof stats.planes === "number" && stats.planes >= seg.pilots + 1,
  };
}

/**
 * O4 first-sight probe, harness-only (no client change): count the GL calls
 * that ALLOCATE — a program link, a texture's storage, a buffer's storage —
 * so the report can say what a segment had to compile or upload while it
 * was being measured. Those are exactly the first-sight hitches the warm-up
 * and the boot pre-warm exist to absorb; per-frame UPDATES (texSubImage2D,
 * bufferSubData) are not counted. Blind to what the driver does lazily on
 * top (ANGLE/Metal pipeline states): that is what the real-draw pre-warm in
 * client/src/render/prewarm.ts covers.
 */
function installGlProbe() {
  const counts = { programs: 0, textures: 0, buffers: 0 };
  window.__abGl = counts;
  const wrap = (proto, name, key) => {
    const original = proto[name];
    proto[name] = function (...args) {
      counts[key]++;
      return original.apply(this, args);
    };
  };
  for (const proto of [
    window.WebGL2RenderingContext?.prototype,
    window.WebGLRenderingContext?.prototype,
  ]) {
    if (!proto) continue;
    wrap(proto, "linkProgram", "programs");
    wrap(proto, "texImage2D", "textures");
    wrap(proto, "texImage3D", "textures");
    wrap(proto, "texStorage2D", "textures");
    wrap(proto, "texStorage3D", "textures");
    wrap(proto, "bufferData", "buffers");
  }
}

async function newProbedPage(browser) {
  const page = await openPage(browser);
  await page.addInitScript(installGlProbe);
  return page;
}

/**
 * One unmeasured lap of the whole path: first sight of a segment pays for
 * shader compiles, texture uploads and instance-buffer growth, none of which
 * recur. Every page flies this before anything is captured.
 */
function flyWarmupLap(page) {
  return page.evaluate(
    async ([segs, ms]) => {
      const ab = window.__ab;
      for (const s of segs) {
        // O4: the same world pin and weather the measured segment will use,
        // earlier on the world clock — so first sight of the segment's
        // weather (the downpour) and world state is paid for here.
        ab.pinWorld?.(s.worldMs);
        if (typeof ab.weather === "function") ab.weather(s.weather);
        ab.teleport(s.x, s.z, s.y, s.yaw);
        await new Promise((resolve) => {
          const t0 = performance.now();
          const tick = () =>
            performance.now() - t0 >= ms
              ? resolve()
              : requestAnimationFrame(tick);
          requestAnimationFrame(tick);
        });
      }
      if (typeof ab.weather === "function") ab.weather(null);
    },
    [
      // World times key on the segment's place in SEGMENTS, not in the
      // --segments selection, so a filtered run pins the same instants.
      activeSegments().map(({ name, x, z, y, yaw, weather }) => ({
        x,
        z,
        y,
        yaw,
        weather: weather ?? DEFAULT_WEATHER,
        worldMs: warmupWorldMs(SEGMENTS.findIndex((s) => s.name === name)),
      })),
      WARMUP_MS,
    ],
  );
}

/**
 * Warm the ARM: fly one COMPLETE, IDENTICAL pass and throw the numbers away.
 *
 * Two separate costs make the first pass a liar, and only the second one
 * needs a pass this long.
 *
 * 1. Browser-level caches. ANGLE's translated shaders and Metal's compiled
 *    pipeline states live in the GPU process and survive the page, so the
 *    first measured pass paid for them and every later pass inherited them
 *    free. It showed up hard on `--aa legacy`, whose multisampled default
 *    framebuffer needs its own pipeline variants: 3 passes spread 140 % on
 *    GPU p50 (core 23.4 → 11.7 → 17.0 ms) while the draw calls stayed
 *    identical — i.e. the same scene, three prices. A short lap fixes this.
 *
 * 2. The GPU's own clock. This one a short lap does NOT fix, which is why
 *    the warm-up is a whole pass. With the caches warmed by a 3.5 s lap, a
 *    3-pass run still read pass 1 high on EVERY segment and then settled:
 *    core 10.24 → 7.49 → 7.64, plaza 8.63 → 6.83 → 6.68, canyon 7.99 →
 *    7.53 → 7.48. Uniform across segments, monotone, draw calls identical —
 *    that is Apple's DVFS ramping under sustained load, not the scene. Once
 *    pass 1 is discarded the survivors agree to ~6 %, inside the tolerance.
 *
 * So the rule the harness holds is simply: every COUNTED pass has an
 * identical full-length pass in front of it. That leaves nothing to tune —
 * a shorter ramp would just be a guess at how long an M3 takes to clock up.
 * It costs one extra pass per arm, which is the cheapest honest option.
 */
async function warmArm(browser, url) {
  await measure(browser, url);
}

/**
 * `--soak <seconds>`: hold the full-room `furball` for that long and report
 * the graphics tier at the end — the "Auto never forces a lower tier on this
 * machine" check (`--quality auto --res auto`). One window, no warm-up arm:
 * this asks what Auto DECIDES under sustained load, not what a frame costs.
 */
async function soak(browser, url, seconds) {
  const seg = SEGMENTS.find((s) => s.name === "furball");
  const page = await newProbedPage(browser);
  const errors = await joinGame(page, url);
  await flyWarmupLap(page);
  const pilots = await startPilots(Number(new URL(url).port), seg.pilots, {
    x: seg.x,
    z: seg.z,
  });
  let s;
  try {
    await sleep(PILOT_SETTLE_MS);
    console.log(`soaking the furball for ${seconds} s…`);
    s = await flySegment(
      page,
      seg,
      seconds * 1000,
      segmentWorldMs(SEGMENTS.indexOf(seg)),
    );
  } finally {
    pilots.stop();
  }
  const q = await page.evaluate(() => window.__ab.quality?.() ?? null);
  await page.close();
  console.log(
    `\nsoak ${seconds} s: wall p50 ${s.p50.toFixed(1)} p99 ${s.p99.toFixed(1)} ms, ` +
      `${s.planes} planes, alive ${s.alive ? "yes" : "NO"}`,
  );
  console.log(
    q === null
      ? "this build has no quality tiers"
      : `quality: setting ${q.setting}, tier ${q.tier} (Auto ${q.auto.tier}), scaler ceiling ${q.ceiling}`,
  );
  if (errors.length > 0) console.error(`page errors:\n${errors.join("\n")}`);
  if (q !== null && q.setting === "auto" && q.tier !== "high") {
    console.error(`!! Auto stepped down to ${q.tier} during the soak.`);
    process.exitCode = 1;
  }
}

/**
 * Did the client draw at the ratio the URL asked for? `--res auto` hands the
 * ratio to the adaptive controller on purpose, so it is honoured by
 * definition; a pinned request is honoured only if the applied ratio matches.
 */
export function ratioHonoured(config) {
  const requested = config.requestedPixelRatio;
  if (requested === null || requested === "auto") return true;
  const n = Number(requested);
  if (!Number.isFinite(n)) return true; // junk falls back to the scaler
  return Math.abs(n - config.pixelRatio) < 1e-6;
}

/**
 * UnrealBloomPass in full-screen-pass equivalents, area-weighted: the bright
 * pass at half resolution (0.25), five mips of a horizontal + vertical blur
 * from half resolution down (2 × 0.25 × (1 + 1/4 + … + 1/256)), the
 * composite at half resolution (0.25) and the additive blend back over the
 * full frame (1). ≈ 2.17.
 */
export const BLOOM_PASS_EQUIV =
  0.25 + 2 * 0.25 * (1 + 1 / 4 + 1 / 16 + 1 / 64 + 1 / 256) + 0.25 + 1;
/** SMAA's three passes (edges, weights, blend), each full-frame. */
const SMAA_PASS_EQUIV = 3;

/**
 * O4's fused chain (`render/post.ts`), same units: the bright pass, the blur
 * mips and the composite all at half the CSS resolution — so divided by the
 * square of the buffer's density over CSS pixels — and no additive blend
 * back over the frame (FinalPass adds the bloom while it tone-maps).
 */
export const fusedBloomPassEquiv = (density) =>
  (BLOOM_PASS_EQUIV - 1) / (density * density);

/**
 * M3's fragment-cost proxy: drawing-buffer pixels × full-screen-pass
 * equivalents (scene 1 + bloom + output 1 + grade + SMAA). A CONFIGURATION
 * check, not a measurement — it says how much fill the enabled passes ask
 * for, which a GPU-less runner can state honestly where it cannot time it.
 * Scene overdraw is not in it (counted as one pass on every tier).
 * Bloom/grade come from `__ab.quality()`; a build without M3 reports
 * neither and is taken to run both, as every build before M3 did.
 *
 * O4: on the fused chain (`config.post === "fused"`) the grade costs no pass
 * of its own (it runs inside the output pass) and the bloom is
 * `fusedBloomPassEquiv`. A build without O4 reports no `post` and is priced
 * as the legacy chain it runs.
 */
export function fragmentProxy(config) {
  const { width, height } = config.drawingBuffer;
  const q = config.quality ?? {};
  const bloom = q.bloom ?? true;
  const grade = q.grade ?? true;
  const fused = config.post === "fused";
  const bloomEquiv = fused
    ? fusedBloomPassEquiv(config.bloomDensity ?? 1)
    : BLOOM_PASS_EQUIV;
  const passes =
    1 +
    (bloom ? bloomEquiv : 0) +
    1 +
    (grade && !fused ? 1 : 0) +
    (config.aa === "smaa" ? SMAA_PASS_EQUIV : 0);
  const pixels = width * height;
  return {
    pixels,
    passes: Math.round(passes * 1000) / 1000,
    cost: Math.round(pixels * passes),
    bloom,
    grade,
    post: fused ? "fused" : "legacy",
  };
}

/**
 * M3: B's cost as a share of A's, by the three numbers a GPU-less runner can
 * defend. `fragment` is the fragment proxy; `drawsXPixels` is each segment's
 * median draw calls × drawing-buffer pixels; `jsP50` the pre-render JS cost
 * (null where either build lacks the hook).
 */
export function costRatios(a, b) {
  const ratio = (x, y) =>
    typeof x === "number" && typeof y === "number" && x > 0 ? y / x : null;
  const pa = a.config.fragmentProxy ?? fragmentProxy(a.config);
  const pb = b.config.fragmentProxy ?? fragmentProxy(b.config);
  return {
    fragment: ratio(pa.cost, pb.cost),
    segments: a.segments
      .map((sa) => {
        const sb = b.segments.find((s) => s.name === sa.name);
        if (!sb) return null;
        return {
          name: sa.name,
          draws: [sa.drawCalls, sb.drawCalls],
          drawsXPixels: ratio(
            sa.drawCalls * pa.pixels,
            sb.drawCalls * pb.pixels,
          ),
          jsP50: [sa.jsP50 ?? null, sb.jsP50 ?? null],
        };
      })
      .filter((s) => s !== null),
  };
}

function printCostRatios(a, b) {
  const r = costRatios(a, b);
  const x = (v) => (v === null ? "n/a" : `${(1 / v).toFixed(2)}x cheaper`);
  const pa = a.config.fragmentProxy;
  const pb = b.config.fragmentProxy;
  console.log(`
cost: ${b.label} vs ${a.label} (GPU-independent proxies)`);
  if (pa && pb) {
    console.log(
      `  fragment proxy: ${(pa.cost / 1e6).toFixed(2)} → ${(pb.cost / 1e6).toFixed(2)} Mpx·passes ` +
        `(${pa.pixels} px × ${pa.passes} → ${pb.pixels} px × ${pb.passes}) = ${x(r.fragment)}`,
    );
  }
  for (const s of r.segments) {
    const js = s.jsP50.map((v) => (v === null ? "n/a" : v.toFixed(2)));
    console.log(
      `  ${s.name.padEnd(8)} draws ${s.draws[0]} → ${s.draws[1]}, draws × pixels ${x(s.drawsXPixels)}, JS p50 ${js[0]} → ${js[1]} ms`,
    );
  }
}

async function measure(browser, url) {
  const page = await newProbedPage(browser);
  const errors = await joinGame(page, url);
  await flyWarmupLap(page);

  const config = await page.evaluate(() => ({
    ...window.__ab.render(),
    seed: window.__ab.storm().seed,
    roomId: window.__ab.net().roomId,
    // Optional so an older build (--ab-ref) still measures.
    city: window.__ab.cityStats?.() ?? null,
    signage: window.__ab.signage?.() ?? null,
    quality: window.__ab.quality?.() ?? null,
  }));
  // What the URL ASKED for, beside what the client APPLIED. The client
  // clamps a pinned `?res=` to the panel's own limits, so on a display below
  // the ceiling `--res 2` is silently honoured as something else — and a
  // pixel count is the workload, so a run whose ratio was quietly changed is
  // not comparable to one whose was not. Storing both is what makes that
  // visible instead of a mystery in a delta table.
  config.requestedPixelRatio = new URL(url).searchParams.get("res");
  config.pixelRatioHonoured = ratioHonoured(config);
  config.fragmentProxy = fragmentProxy(config);

  const segments = [];
  const port = Number(new URL(url).port);
  for (const seg of activeSegments()) {
    // O3 furball: fake pilots join for this segment only, and get time to
    // re-sync on the server and fill the page's interpolation buffer before
    // the segment's own settle starts.
    const pilots =
      seg.pilots === undefined
        ? null
        : await startPilots(port, seg.pilots, { x: seg.x, z: seg.z });
    try {
      if (pilots) await sleep(PILOT_SETTLE_MS);
      segments.push(
        await flySegment(
          page,
          seg,
          SAMPLE_MS,
          segmentWorldMs(SEGMENTS.indexOf(seg)),
        ),
      );
    } finally {
      pilots?.stop();
    }
    // P2: the furball's aftermath must not leak into the next segment. Its
    // pilots' last bursts leave ~200 bullets in flight, and a bullet ages by
    // the sim step (clamped at 50 ms a frame), so on a slow renderer their
    // tracers crossed the next view for tens of seconds and moved its draw
    // count by up to +7. Wait for the room and the sky to empty. An older
    // build has no `bullets` read-back and only waits for the room.
    if (pilots) {
      await page.waitForFunction(
        () =>
          window.__ab.combat().targets.length === 0 &&
          (window.__ab.combat().bullets ?? 0) === 0,
        null,
        { timeout: 120_000, polling: 250 },
      );
    }
  }
  const env = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown",
      devicePixelRatio: window.devicePixelRatio,
      userAgent: navigator.userAgent,
    };
  });
  await page.close();
  return { segments, config, env, errors };
}

// --- Reporting ------------------------------------------------------------

/**
 * A frame this many times its own segment's p50 is a SPIKE — a different
 * kind of event, not a slow frame.
 *
 * 4x, not 2x or 10x. Under vsync-off rendering this scene, p95 sits around
 * 1.6x p50 and p99 around 1.8x, so 2x would sweep in the ordinary top of the
 * distribution and count noise. 10x would only ever see the one catastrophic
 * frame and miss the 30-50 ms ones that are the interesting middle. 4x is
 * comfortably outside the shoulder and still catches everything a player
 * would feel as a hitch.
 */
export const SPIKE_FACTOR = 4;
/**
 * How many individual spikes a report lists per segment. The COUNT is always
 * exact; this caps only the itemised positions, so a pathological window
 * cannot turn baseline.json into a megabyte of coordinates.
 */
export const SPIKE_LIST_MAX = 24;
/**
 * "Early" means the first tenth of the measured window. This is the
 * discriminator the worst-frame question actually turns on: shader
 * compilation, pipeline-state creation and texture upload are FIRST-SIGHT
 * costs, so if they were what `worst` is made of, the spikes would cluster
 * here and nowhere else. Anything spread through the window is not
 * first-sight anything.
 */
export const SPIKE_EARLY_FRACTION = 0.1;

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Locate the spikes in one segment's raw per-frame samples.
 *
 * The report has always carried `worst`, and `worst` alone cannot answer the
 * only question anybody asks about it: is this the scene, or is this the
 * machine? A single number says a 150 ms frame happened; it does not say
 * whether it happened once at frame 3 (first sight of the segment — shader
 * compilation, texture upload) or eleven times spread evenly through the
 * window (sustained garbage), and those want opposite fixes.
 *
 * Position is measured in ELAPSED TIME, not frame index. Index would be the
 * same thing at a uniform frame rate, and a window with a 150 ms frame in it
 * is by definition not uniform — a spike at "frame 300 of 600" is not
 * halfway through the window if the first 300 frames were the cheap ones.
 */
export function summariseSpikes(samples, p50) {
  const frames = samples.length;
  let windowMs = 0;
  for (const ms of samples) windowMs += ms;
  const threshold = p50 * SPIKE_FACTOR;
  const at = [];
  let count = 0;
  let early = 0;
  let costMs = 0;
  let worst = 0;
  let worstAt = 0;
  let elapsed = 0;
  for (let i = 0; i < frames; i++) {
    const ms = samples[i];
    // Where this frame STARTS, as a fraction of the window.
    const frac = windowMs === 0 ? 0 : elapsed / windowMs;
    if (ms > worst) {
      worst = ms;
      worstAt = frac;
    }
    // p50 of 0 means nothing was measured — never a window of pure spikes.
    if (p50 > 0 && ms > threshold) {
      count++;
      costMs += ms - p50;
      if (frac < SPIKE_EARLY_FRACTION) early++;
      if (at.length < SPIKE_LIST_MAX) {
        at.push({ frame: i, at: r3(frac), ms: r2(ms) });
      }
    }
    elapsed += ms;
  }
  return {
    factor: SPIKE_FACTOR,
    threshold: r2(threshold),
    frames,
    windowMs: r2(windowMs),
    count,
    /**
     * How much wall time the spikes account for, over and above what those
     * frames would have cost at p50. Against `windowMs` this is the honest
     * scale of the problem: a number in the tens of ms out of 5000 is a
     * rounding error the `worst` column makes look like a catastrophe.
     */
    costMs: r2(costMs),
    /** Spikes inside the first SPIKE_EARLY_FRACTION of the window. */
    early,
    worst: r2(worst),
    /** Where the single worst frame landed, 0..1 through the window. */
    worstAt: r3(worstAt),
    at,
    truncated: count > at.length,
  };
}

const pct = (sorted, p) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

/** Pool every segment's summary into one headline (p50 of p50s, worst worst). */
function overall(segments) {
  const p50s = segments.map((s) => s.p50).sort((a, b) => a - b);
  const p95s = segments.map((s) => s.p95).sort((a, b) => a - b);
  const p99s = segments.map((s) => s.p99).sort((a, b) => a - b);
  const gpuP50s = segments.map((s) => s.gpuP50 ?? 0).sort((a, b) => a - b);
  return {
    p50: pct(p50s, 0.5),
    p95: Math.max(...p95s),
    p99: Math.max(...p99s),
    worst: Math.max(...segments.map((s) => s.worst)),
    gpuP50: pct(gpuP50s, 0.5),
    gpuP95: Math.max(...segments.map((s) => s.gpuP95 ?? 0)),
    gpuWorst: Math.max(...segments.map((s) => s.gpuWorst ?? 0)),
    drawCallsMax: Math.max(...segments.map((s) => s.drawCallsMax)),
    frames: segments.reduce((n, s) => n + s.count, 0),
  };
}

const f1 = (v) => v.toFixed(1).padStart(6);

function printTable(report) {
  const c = report.config;
  const asked =
    c.requestedPixelRatio == null || c.pixelRatioHonoured
      ? ""
      : ` (asked for ${c.requestedPixelRatio})`;
  console.log(
    `\n${report.label} — aa=${c.aa} pixelRatio=${c.pixelRatio}${asked}${c.auto ? " (auto)" : ""} buffer=${c.drawingBuffer.width}x${c.drawingBuffer.height} quality=${c.quality ? c.quality.setting : "n/a"}${c.ref ? ` build=${c.ref}` : ""}`,
  );
  console.log(`GPU: ${report.env.gpu}`);
  const h = report.harness;
  if (h?.device || h?.cpuThrottle > 1 || c.fragmentProxy) {
    console.log(
      `device: ${h?.device ?? "desktop"} ${h?.viewport?.width}x${h?.viewport?.height}@${h?.deviceScaleFactor}` +
        `${h?.cpuThrottle > 1 ? `, CPU throttled ${h.cpuThrottle}x` : ""}` +
        `${c.fragmentProxy ? `, fragment proxy ${c.fragmentProxy.pixels} px × ${c.fragmentProxy.passes} passes (bloom ${c.fragmentProxy.bloom ? "on" : "off"}, grade ${c.fragmentProxy.grade ? "on" : "off"})` : ""}`,
    );
  }
  // Printed, not just stored: on a shared laptop this is the single most
  // common reason two runs of the same build disagree.
  console.log(
    `machine: ${report.env.cpus} cpus, load ${report.env.loadavg.join(" ")}`,
  );
  console.log(
    "\n           ------------- wall clock -------------   ------ GPU ------",
  );
  console.log(
    "segment       p50     p95     p99   worst  draws     p50     p95   worst  alive",
  );
  console.log("".padEnd(80, "-"));
  for (const s of report.segments) {
    console.log(
      `${s.name.padEnd(8)}${f1(s.p50)}  ${f1(s.p95)}  ${f1(s.p99)}  ${f1(s.worst)}  ` +
        `${String(s.drawCalls).padStart(5)}  ${f1(s.gpuP50 ?? 0)}  ` +
        `${f1(s.gpuP95 ?? 0)}  ${f1(s.gpuWorst ?? 0)}  ${s.alive ? "yes" : "NO "}`,
    );
  }
  const o = report.overall;
  console.log("".padEnd(80, "-"));
  console.log(
    `overall ${f1(o.p50)}  ${f1(o.p95)}  ${f1(o.p99)}  ${f1(o.worst)}  ` +
      `${String(o.drawCallsMax).padStart(5)}  ${f1(o.gpuP50)}  ${f1(o.gpuP95)}  ${f1(o.gpuWorst)}`,
  );
  // The GPU query pool empties on the frames that cost the most, so any skip
  // count at all means the GPU tail above is missing its worst samples.
  const starved = report.segments.reduce((n, s) => n + (s.gpuStarved ?? 0), 0);
  if (starved > 0) {
    console.log(
      `\n!! the GPU timer could not measure ${starved} frame(s) — its p95/worst columns are missing their tail and must not be quoted.`,
    );
  }
  // A pinned ratio the client did not honour means this run measured a
  // different workload than the flag names, and a pixel count IS the
  // workload — so it cannot be compared to a run that was honoured.
  if (c.requestedPixelRatio != null && !c.pixelRatioHonoured) {
    console.error(
      `\n!! --res ${c.requestedPixelRatio} was NOT applied: the client drew at ${c.pixelRatio}, clamped to this panel's own limits (devicePixelRatio ${report.env.devicePixelRatio}). This run measured a different pixel count than the flag says and is not comparable to one recorded at ${c.requestedPixelRatio}.`,
    );
  }
  printVerdicts(report);
  printFirstSight(report);
  printSpikes(report);
  console.log(
    "\n(frame times are COSTS — vsync is disabled; lower is better.\n" +
      " Read the GPU columns for render changes: they are far more\n" +
      " contention-resistant than wall clock, but not immune — check the\n" +
      " machine line above before trusting a small delta.)",
  );
}

const mark = (v) => (v === null ? " n/a" : v ? "  ok" : "FAIL");

/** O3: the per-segment budgets, one row per segment (see segmentVerdicts). */
function printVerdicts(report) {
  const drawBudgets = Object.entries(BUDGETS.drawCalls)
    .map(([n, b]) => `${n} <= ${b}`)
    .join(", ");
  console.log(
    `\nbudgets: GPU p50 <= ${BUDGETS.gpuP50Ms} ms (60 fps at this ratio) · ` +
      `wall p99 <= ${BUDGETS.hitchRatio}x p50 · draw calls ${drawBudgets}`,
  );
  console.log(
    "segment   60fps   p99/p50  hitch  draws  room    tier    weather",
  );
  for (const s of report.segments) {
    const v = s.verdicts ?? segmentVerdicts(s.name, s);
    const ratio = s.p50 > 0 ? (s.p99 / s.p50).toFixed(2) : "—";
    const weather =
      s.weather == null
        ? "—"
        : s.weatherPinned
          ? s.weather
          : `${s.weather} NOT PINNED`;
    const room =
      v.room === null ? " n/a" : `${v.room ? "  ok" : "FAIL"} ${s.planes}`;
    console.log(
      `${s.name.padEnd(8)}  ${mark(v.fps60)}  ${ratio.padStart(8)}  ${mark(v.hitches)}  ` +
        `${mark(v.draws)}  ${room.padEnd(8)}${String(s.tier ?? "—").padEnd(8)}${weather}`,
    );
  }
  const failed = report.segments.filter((s) => s.verdicts?.room === false);
  for (const s of failed) {
    console.error(
      `!! ${s.name}: only ${s.planes} plane(s) in the room during the window — the fake pilots did not all make it, so this is not the full-room scene.`,
    );
  }
  // P2: where a `trainsAt` segment slid its world clock, and which trains
  // stood in the station — or a loud line if the schedule had no such moment.
  for (const s of report.segments) {
    if (!s.trains) continue;
    if (s.trains.offsetMs === null) {
      console.error(
        `!! ${s.name}: no moment with two trains in the station within ${TRAINS_SLIDE_MAX_MS / 1000} s — the window shows whatever the schedule had.`,
      );
    } else {
      console.log(
        `${s.name}: trains ${s.trains.tracks.join(", ")} in the station at +${(s.trains.offsetMs / 1000).toFixed(2)} s`,
      );
    }
  }
}

/**
 * O4: what each segment had to compile or allocate on the GPU while it was
 * flown — the GPU-independent half of "no first-sight freezes", measured by
 * the init-script probe (installGlProbe). The window column must read 0/0:
 * a program linked or a texture allocated inside the measured window is a
 * hitch the boot pre-warm and the warm-up lap both missed. Also printed: the
 * world clock each segment was pinned to, and whether the ratio and tier
 * held through the window.
 */
function printFirstSight(report) {
  const fmt = (d) =>
    d == null
      ? "   n/a   "
      : `${d.programs}p ${d.textures}t ${d.buffers}b`.padEnd(9);
  console.log(
    "\nfirst sight (GL allocations: p = programs linked, t = textures, b = buffers)",
  );
  console.log("segment   settle     window     world clock        workload");
  for (const s of report.segments) {
    const f = s.firstSight ?? {};
    const world = s.worldPinned
      ? `pinned ${s.worldMs === null || s.worldMs === undefined ? "?" : Math.round(s.worldMs)}`
      : "NOT PINNED";
    console.log(
      `${s.name.padEnd(8)}  ${fmt(f.settle)}  ${fmt(f.window)}  ${world.padEnd(18)} ` +
        `${s.workloadStable === false ? "CHANGED in the window" : "held"}`,
    );
  }
  const late = report.segments.filter(
    (s) =>
      s.firstSight?.window &&
      (s.firstSight.window.programs > 0 || s.firstSight.window.textures > 0),
  );
  if (late.length > 0) {
    console.error(
      `!! first sight inside the measured window: ${late.map((s) => s.name).join(", ")} — a program or texture the pre-warm and warm-up lap missed.`,
    );
  }
  const changed = report.segments.filter((s) => s.workloadStable === false);
  if (changed.length > 0) {
    console.error(
      `!! the pixel ratio or quality tier changed inside: ${changed.map((s) => s.name).join(", ")} — those windows measured two workloads.`,
    );
  }
}

/**
 * Where the `worst` column came from. Printed under every table because
 * `worst` is the one number in the report a reader routinely over-reads: it
 * is a single sample, and this says whether that sample was alone, where it
 * sat, and what the whole tail actually cost.
 */
function printSpikes(report) {
  const withSpikes = report.segments.filter(
    (s) => (s.spikes?.count ?? 0) > 0 || (s.gpuSpikes?.count ?? 0) > 0,
  );
  if (withSpikes.length === 0) {
    console.log(
      `\nspikes (frames over ${SPIKE_FACTOR}x their segment's own p50): none, in any segment.`,
    );
    return;
  }
  console.log(
    `\nspikes (frames over ${SPIKE_FACTOR}x their segment's own p50):`,
  );
  for (const s of withSpikes) {
    const k = s.spikes;
    const g = s.gpuSpikes;
    console.log(
      `  ${s.name.padEnd(8)}wall ${String(k.count).padStart(3)} of ${k.frames}  ` +
        `worst ${k.worst.toFixed(1)} ms at ${(k.worstAt * 100).toFixed(0)}%  ` +
        `${k.early} in the first ${(SPIKE_EARLY_FRACTION * 100).toFixed(0)}%  ` +
        `+${k.costMs.toFixed(0)} ms of ${k.windowMs.toFixed(0)}`,
    );
    // The GPU line under the wall line is the diagnosis, not a second
    // reading of the same thing: see the legend below.
    if (g) {
      console.log(
        `  ${" ".repeat(8)} gpu ${String(g.count).padStart(3)} of ${g.frames}  ` +
          `worst ${g.worst.toFixed(1)} ms at ${(g.worstAt * 100).toFixed(0)}%`,
      );
    }
  }
  const early = (SPIKE_EARLY_FRACTION * 100).toFixed(0);
  console.log(
    [
      `  (WHERE: clustered in the first ${early}% = first-sight cost the warm-up`,
      "   lap missed; spread at a steady rate = something per-frame; one or two",
      "   anywhere, moving run to run = the machine.",
      "   WHICH CLOCK: a spike in the wall row and NOT the gpu row is a pause on",
      "   this thread — GC, a long script — with the GPU idle through it. A spike",
      "   in BOTH is the GPU or the compositor actually stalling, which no",
      "   JavaScript change can fix. Re-run --samples for every frame time.)",
    ].join("\n"),
  );
}

/**
 * The harness's own acceptance check — the tolerance is DECLARED here so a
 * reader never has to guess what "the runs agree" meant, and `--strict`
 * turns it into an exit code.
 *
 * Two numbers, and only two, because only two are actually pinned:
 *
 *  - DRAW CALLS must be identical per segment. This is the scene-identity
 *    check and it is exact, not approximate: an integer count of what was
 *    submitted cannot drift for timing reasons. If it moves, the harness
 *    stopped pinning the scene and NOTHING measured against it is trustworthy.
 *    (`storm` is exempt — a strike's position is a function of absolute time.
 *    See the tolerance note in README.md.)
 *  - GPU p50 must agree within 10 % OR 1.0 ms, whichever is LOOSER. This is
 *    the render cost, the number every optimisation claim in a PR rests on.
 *
 * The "or 1 ms" half is not a fudge factor, it is the shape the tolerance
 * has to have. A pure percentage band is a moving target that gets stricter
 * the faster the scene renders: the same 0.9 ms of run-to-run drift reads as
 * 5 % against an 18 ms legacy frame and as 12 % against the 7.4 ms frame
 * that replaced it, so shipping win A would have "broken" determinism by
 * making the game faster. What the harness can honestly claim is a
 * RESOLUTION — it can tell two configurations apart when they differ by more
 * than about a millisecond — and that is what this states. For scale, win A
 * measured 5.0 ms; the band it has to clear is 1.0.
 *
 * The band also implies a FLOOR on what this harness can measure at all,
 * and it is worth knowing where that floor is before reading a delta as
 * gospel. Pinned to `--res 1` the scene costs ~2-4 ms of GPU, and there the
 * per-pass scatter is as large as the measurement: 3 passes read core 1.98 →
 * 3.90 → 3.12 ms with draw calls identical every time. Below roughly 4 ms
 * the timer query is measuring its own overhead and the queue depth as much
 * as the scene, so treat an ABSOLUTE number from a cheap config as
 * indicative only. The paired `--ab` delta survives it — both arms sit in
 * the same state — but quote the conservative end of it.
 *
 * Wall-clock p50 is reported but deliberately NOT asserted. It includes the
 * sim, the socket, JS GC and whatever else the machine is running. Measured
 * here on a box at load average ~100 (parallel agent worktrees), one pass ran
 * a uniform ~30 % slower in wall clock across EVERY segment while its GPU
 * cost and draw calls held — an unmistakable signature of the machine rather
 * than the build. Asserting it would make the harness fail for reasons that
 * have nothing to do with the code under test, and a flaky check gets
 * disabled and then ignored. Read the GPU columns for render work.
 */
export const TOLERANCE = { gpuP50Pct: 10, gpuP50Ms: 1.0 };

/**
 * Segments whose scene the harness does NOT fully pin, and therefore does not
 * assert timing on. Both for the same reason: their content is driven by the
 * synced SERVER clock, which cannot be pinned without a server change.
 *
 *  - `storm` — which cell the next strike hits is a function of absolute time.
 *  - `canyon` — at y=45 the camera is at street level, where instanced traffic
 *    and its headlights fill more of the frame than anywhere else on the path,
 *    and traffic pose is a pure function of the server clock.
 *
 * This is a statement about what is pinned, not a way to make the check pass.
 * The evidence that canyon belongs here rather than in the "machine was busy"
 * bucket: across every multi-pass run its GPU p50 swings while its WALL p50
 * falls monotonically and its draw calls stay fixed at 107 (10.15 → 13.99 →
 * 9.92 GPU against 7.6 → 7.4 → 7.2 wall). Contention raises wall and GPU
 * together; more GPU work at constant draw calls is a fuller frame.
 *
 * For scale, on the committed baseline the three PINNED segments agree to
 * 0.79 / 0.18 / 0.32 ms and canyon alone spreads 1.38 ms. Both exempt
 * segments are still measured, still printed, and still worth reading as a
 * paired `--ab` delta — they are simply not evidence about the harness.
 */
export const UNPINNED_SEGMENTS = new Set([
  "storm",
  "canyon",
  // O3: rain and the crowd on the synced clock, traffic as for canyon.
  "street",
  // O3: fake pilots fly on THEIR wall clock (tools/perf/pilots.mjs).
  "furball",
]);
/** Segments whose draw count may legitimately move between passes. */
export const DRAWS_FLOAT = new Set(["storm", "street", "furball"]);

/**
 * O4: with the WORLD clock pinned (`__ab.pinWorld`, segments.mjs
 * WORLD_EPOCH_MS) the server-clock content above — the strike cell, the
 * traffic, the rain and the crowd — is the same on every pass, so only the
 * furball stays exempt: its 11 fake pilots fly, weave and fire on their own
 * wall clock. These apply only when EVERY pass of the arm reports its world
 * pinned; an older build (an --ab-ref from before O4) keeps the sets above.
 */
export const UNPINNED_WORLD_PINNED = new Set(["furball"]);
export const DRAWS_FLOAT_WORLD_PINNED = new Set(["furball"]);

/** Per-segment agreement between the runs of one invocation. */
export function determinism(runs) {
  if (runs.length < 2) return null;
  // A driver with no timer query gives a column of zeros; dividing by the
  // minimum would print `Infinity %` for a measurement that never happened.
  const spreadPct = (xs) => {
    const lo = Math.min(...xs);
    return lo === 0 ? 0 : ((Math.max(...xs) - lo) / lo) * 100;
  };
  const spreadMs = (xs) => Math.max(...xs) - Math.min(...xs);
  // Only the segments every pass actually flew: a report recorded before a
  // segment was appended simply does not have it.
  const flown = activeSegments().filter((_, i) =>
    runs.every((r) => r.segments[i]),
  );
  // O4: an arm whose every segment flew on the pinned world clock is held to
  // the stricter sets.
  const worldPinned = runs.every((r) =>
    r.segments.every((s) => s.worldPinned === true),
  );
  const unpinned = worldPinned ? UNPINNED_WORLD_PINNED : UNPINNED_SEGMENTS;
  const drawsFloat = worldPinned ? DRAWS_FLOAT_WORLD_PINNED : DRAWS_FLOAT;
  const perSegment = flown.map((seg, i) => {
    const p50s = runs.map((r) => r.segments[i].p50);
    const gpuP50s = runs.map((r) => r.segments[i].gpuP50 ?? 0);
    const draws = runs.map((r) => r.segments[i].drawCalls);
    return {
      name: seg.name,
      p50s,
      p50SpreadPct: spreadPct(p50s),
      gpuP50s,
      gpuP50SpreadPct: spreadPct(gpuP50s),
      gpuP50SpreadMs: spreadMs(gpuP50s),
      drawCalls: draws,
      drawCallsAgree: new Set(draws).size === 1,
      pinned: !unpinned.has(seg.name),
    };
  });
  // The verdict is taken over the segments the harness actually pins; the
  // rest are measured and printed but prove nothing about the harness.
  const pinned = perSegment.filter((s) => s.pinned);
  const worstGpuP50SpreadPct = Math.max(
    ...pinned.map((s) => s.gpuP50SpreadPct),
  );
  const worstGpuP50SpreadMs = Math.max(...pinned.map((s) => s.gpuP50SpreadMs));
  // Only `storm` moves its draw calls between runs (its strike CELL is a
  // function of absolute time). `canyon` is unpinned for TIMING — traffic
  // fills more of its frame — but it submits the same draws every run, so it
  // is still held to the identity check. Naming storm explicitly, rather
  // than reusing UNPINNED_SEGMENTS, keeps those two claims separate.
  // O3's two street-level segments are exempt for the same kind of reason:
  // `street` sits in the server-clock traffic with headlight cones that come
  // and go with it, and `furball` draws fake pilots' tracer bursts whose
  // timing is wall-clock. Their draw counts are reported, not asserted.
  const drawCallsAgreeEverywhere = perSegment.every(
    (s) => s.drawCallsAgree || drawsFloat.has(s.name),
  );
  // A driver with no timer-query extension reports `null`, which lands here
  // as a column of zeros — a MISSING measurement, not a passing one. Require
  // real numbers before the verdict can be based on them.
  const gpuMeasured = pinned.every((s) => s.gpuP50s.every((v) => v > 0));
  // Whichever band is looser — see TOLERANCE for why it takes both forms.
  // PER SEGMENT, not max-of-pct OR max-of-ms across all of them. Taking the
  // two maxima independently and then OR-ing lets a run FAIL when every
  // single segment passed: segment A at 20 %/0.9 ms and B at 9 %/5.0 ms both
  // satisfy "10 % or 1 ms", but the aggregate reads 20 % and 5 ms.
  const gpuAgrees =
    gpuMeasured &&
    pinned.every(
      (s) =>
        s.gpuP50SpreadPct <= TOLERANCE.gpuP50Pct ||
        s.gpuP50SpreadMs <= TOLERANCE.gpuP50Ms,
    );
  return {
    worstGpuP50SpreadPct,
    worstGpuP50SpreadMs,
    worstP50SpreadPct: Math.max(...pinned.map((s) => s.p50SpreadPct)),
    assertedOver: pinned.map((s) => s.name),
    notAsserted: perSegment.filter((s) => !s.pinned).map((s) => s.name),
    drawCallsAgreeEverywhere,
    worldPinned,
    tolerance: TOLERANCE,
    pass: drawCallsAgreeEverywhere && gpuAgrees,
    perSegment,
  };
}

function printDelta(report, baseline) {
  console.log(`\n${report.label}  vs  ${baseline.label}`);
  console.log("segment    GPU p50 Δ      GPU p95 Δ     wall p50 Δ    draws Δ");
  console.log("".padEnd(64, "-"));
  const row = (name, a, b) => {
    const d = (x, y) => {
      const pctChange = y === 0 ? 0 : ((x - y) / y) * 100;
      return `${(x - y).toFixed(1).padStart(6)} (${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}%)`.padStart(
        15,
      );
    };
    console.log(
      `${name.padEnd(8)}${d(a.gpuP50 ?? 0, b.gpuP50 ?? 0)}` +
        `${d(a.gpuP95 ?? 0, b.gpuP95 ?? 0)}${d(a.p50, b.p50)}` +
        `${String(a.drawCalls - b.drawCalls).padStart(9)}`,
    );
  };
  for (const seg of report.segments) {
    const base = baseline.segments.find((s) => s.name === seg.name);
    // P2: an arm that could not fly the scene — an older build with no
    // two-train read-back, or one that died in the window (a build from
    // before H2 has no tunnel to glide through) — is not a baseline.
    const unreproduced = (s) =>
      s.alive === false ||
      (SEGMENTS.find((g) => g.name === s.name)?.trainsAt !== undefined &&
        typeof s.trains?.offsetMs !== "number");
    if (!base) {
      console.log(`${seg.name.padEnd(8)}  no baseline (segment absent)`);
    } else if (unreproduced(seg) || unreproduced(base)) {
      const which = unreproduced(seg) ? report.label : baseline.label;
      console.log(
        `${seg.name.padEnd(8)}  no baseline (${which} could not fly this scene: dead, or no two-train moment)`,
      );
    } else if (
      seg.weather != null &&
      (seg.weatherPinned === false || base.weatherPinned !== true)
    ) {
      // An older build (before L4) has no weather hook, so its arm flew this
      // segment DRY: a delta would compare a downpour against clear skies.
      const dry = seg.weatherPinned === false ? report.label : baseline.label;
      console.log(
        `${seg.name.padEnd(8)}  no baseline (${dry} could not pin the ${seg.weather})`,
      );
    } else {
      row(seg.name, seg, base);
    }
  }
  row(
    "overall",
    { ...report.overall, drawCalls: report.overall.drawCallsMax },
    { ...baseline.overall, drawCalls: baseline.overall.drawCallsMax },
  );
  console.log(
    "\n(negative = the first configuration is cheaper. With --ab the two\n" +
      " arms are interleaved, so this delta is paired and GPU-clock drift\n" +
      " lands in both arms equally.)",
  );
}

/**
 * Fold N passes of one configuration into a single report.
 *
 * The reported segment is the MEDIAN PASS — the whole row from one real
 * pass, never a per-column mix. A row assembled column-by-column can publish
 * a gpuP95 below its own gpuP50, or a `worst` beside draw calls from a
 * different pass, and an impossible row is worse than a noisy one in a
 * harness whose whole claim is that its numbers are trustworthy.
 *
 * Two things here were wrong and both made numbers wrong:
 *   - `floor((n - 1) / 2)` is the LOWER median, i.e. index 0 for n = 2 — the
 *     fastest of two, which is exactly the "reports its luckiest run"
 *     failure the old comment here warned about. Every README recipe used
 *     `--runs 2`.
 *   - the pass was chosen by WALL p50, and that pass's GPU columns were then
 *     reported. The README spends two paragraphs explaining that wall clock
 *     is contention and the GPU columns are the evidence, so the headline
 *     GPU number was being picked by the one metric it says not to trust.
 * Prefer an odd `--runs` regardless: with an even count "the median" is a
 * choice between two passes rather than a reading.
 */
export function pickMedianPass(all) {
  // Rank by GPU cost where we have it, and fall back to wall clock only on a
  // driver with no timer query at all.
  const key = all.every((s) => typeof s.gpuP50 === "number")
    ? (s) => s.gpuP50
    : (s) => s.p50;
  const ranked = [...all].sort((a, b) => key(a) - key(b));
  return ranked[Math.floor(ranked.length / 2)];
}

function buildReport(label, runs, opts) {
  const primary = runs[0];
  const segments = activeSegments()
    .map((seg, i) => pickMedianPass(runs.map((r) => r.segments[i])))
    .map((seg) => {
      // Raw per-frame samples are ~650 numbers a segment, and baseline.json is
      // a committed file a human reads in a diff. The SPIKE SUMMARY derived
      // from them always ships (it is a dozen fields and it is the part that
      // answers a question); the samples themselves only on --samples, which
      // is what you pass when you want to plot a histogram yourself.
      if (opts.samples) return seg;
      const { samples: _wall, gpuSamples: _gpu, ...rest } = seg;
      return rest;
    });
  return {
    version: REPORT_VERSION,
    label,
    createdAt: new Date().toISOString(),
    harness: {
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      device: opts.device,
      cpuThrottle,
      segments: activeSegments().map((s) => s.name),
      vsync: "disabled",
      sampleMs: SAMPLE_MS,
      settleMs: SETTLE_MS,
      warmupMs: WARMUP_MS,
      runs: opts.runs,
      paired: opts.ab !== null || opts.abRef !== null,
      /** Whether the raw per-frame arrays are in this file (--samples). */
      samples: opts.samples,
      spikeFactor: SPIKE_FACTOR,
    },
    env: {
      ...primary.env,
      platform: `${platform()} ${release()}`,
      cpus: cpus().length,
      node: process.version,
      // Recorded because it matters: this is a shared laptop, and a 1-minute
      // load average in the double digits inflates the wall-clock tail (p95,
      // worst) badly. A report read without it is a report misread.
      loadavg: loadavg().map((n) => Math.round(n * 10) / 10),
    },
    config: { ...primary.config, bots: 0 },
    segments,
    overall: overall(segments),
    determinism: determinism(runs),
    pageErrors: runs.flatMap((r) => r.errors),
  };
}

// --- Main -----------------------------------------------------------------

// --- Child-process ownership -----------------------------------------------
//
// Exactly one place kills the server and the browser, and it is reachable
// from the happy path, the error path AND a signal. Anything less leaks: on
// this machine the harness runs alongside other agent worktrees, and a
// squatting server is somebody else's confusing failure an hour later.

let liveServers = [];
let liveBrowser = null;

async function killEverything() {
  const servers = liveServers;
  const browser = liveBrowser;
  liveServers = [];
  liveBrowser = null;
  for (const server of servers) server.kill();
  if (browser !== null) {
    // Never let a hung close() strand the kill above — that ordering was the
    // original bug.
    await browser.close().catch(() => {});
  }
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    killEverything().finally(() => process.exit(130));
  });
}

/**
 * Launch Chromium, and fail with the fix rather than a stack trace when the
 * browser binary was never downloaded.
 *
 * `playwright` is a devDependency with no postinstall — deliberately, since
 * this repo builds a Fly image and an unconditional ~150 MB Chromium download
 * would land in every deploy. The cost is that `npm ci && npm run perf` on a
 * cold machine hits "Executable doesn't exist", so the harness names the one
 * command that fixes it.
 */
async function launchBrowser(opts) {
  try {
    return await chromium.launch({
      headless: !opts.headed,
      args: CHROME_ARGS,
      // AB_CHROME: another headless shell (e.g. a Linux box whose Playwright
      // cache holds a different build than this playwright expects).
      ...(process.env.AB_CHROME
        ? { executablePath: process.env.AB_CHROME }
        : {}),
    });
  } catch (err) {
    if (/Executable doesn.t exist|playwright install/i.test(String(err))) {
      throw new Error(
        "Chromium is not installed for Playwright.\n" +
          "Run this once, then re-run the harness:\n\n" +
          "    npm run perf:setup\n",
      );
    }
    throw err;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  device = DEVICES[opts.device];
  cpuThrottle = opts.cpuThrottle;
  segmentFilter = opts.segments === null ? null : new Set(opts.segments);
  if (opts.build) {
    console.log("building client…");
    await run("npm", ["run", "build", "-w", "client"], {
      stdio: opts.quiet ? "ignore" : "inherit",
    });
  }

  // O3 --ab-ref: the second arm is ANOTHER BUILD, checked out into its own
  // worktree with its own node_modules (a symlinked one would resolve
  // @angels-bandits/common to THIS tree's common/) and served by its own
  // server, interleaved exactly like a query arm.
  const ref =
    opts.abRef === null
      ? null
      : await prepareRefBuild(opts.abRef, { quiet: opts.quiet });

  const port = opts.port || (await freePort());
  console.log(`starting server on :${port}…`);
  // REGISTERED BEFORE ANYTHING CAN THROW. The server used to be spawned
  // outside the try that owns cleanup, so a chromium.launch() failure
  // orphaned `node --import tsx server/src/index.ts` — a real one was found
  // alive nine hours after the session that started it, still holding a port.
  liveServers.push(await startServer(port));
  let refPort = null;
  if (ref !== null) {
    refPort = await freePort();
    console.log(`starting ${ref.label} server on :${refPort}…`);
    liveServers.push(await startServer(refPort, ref.dir));
  }

  const urlFor = (overrides, at = port) => {
    const params = new URLSearchParams();
    if (opts.aa) params.set("aa", opts.aa);
    params.set("res", opts.res);
    params.set("gputime", "1");
    // L12: pin the sky cycle to deep night so a baseline never depends on
    // the server's time of night (overrides may still pick another phase).
    params.set("sky", "night");
    // O3: pin the graphics tier (High unless --quality says otherwise), so
    // Auto can never step down mid-run and change the workload under a
    // measurement. An older build ignores the parameter.
    params.set("quality", opts.quality);
    for (const [k, v] of new URLSearchParams(overrides ?? "")) params.set(k, v);
    return `http://127.0.0.1:${at}/?${params}`;
  };
  // The second arm, whichever kind it is: a query on this build, or a build.
  const abLabel = ref !== null ? ref.label : opts.ab;
  const abUrl =
    ref !== null
      ? urlFor(null, refPort)
      : opts.ab !== null
        ? urlFor(opts.ab)
        : null;

  const browser = await launchBrowser(opts);
  liveBrowser = browser;

  if (opts.soak !== null) {
    try {
      await soak(browser, urlFor(null), opts.soak);
    } finally {
      await killEverything();
    }
    return;
  }

  let report;
  let abReport = null;
  try {
    const runs = [];
    const abRuns = [];
    // Per URL: a different `aa` mode compiles different pipelines, so each
    // arm has to warm its own or the interleave measures cache state.
    console.log("warm-up pass (discarded — caches and GPU clock)…");
    await warmArm(browser, urlFor(null));
    if (abUrl !== null) await warmArm(browser, abUrl);
    for (let i = 0; i < opts.runs; i++) {
      console.log(`measuring pass ${i + 1}/${opts.runs}…`);
      runs.push(await measure(browser, urlFor(null)));
      if (abUrl !== null) {
        // INTERLEAVED, not "all of A then all of B". The GPU's clock state
        // drifts as the machine warms: a straight A-then-B run showed pass 2
        // reading ~40 % slower than pass 1 on identical work. Alternating
        // puts that drift into both arms equally, which is the only way the
        // A/B delta means anything.
        console.log(`measuring pass ${i + 1}/${opts.runs} (${abLabel})…`);
        abRuns.push(await measure(browser, abUrl));
      }
    }
    report = buildReport(opts.label, runs, opts);
    if (abUrl !== null) {
      abReport = buildReport(abLabel, abRuns, opts);
      if (ref !== null) abReport.config.ref = ref.label;
    }
  } finally {
    // The server FIRST: it is the one nothing else will clean up. Playwright
    // reaps its own browser on exit; an orphaned node process squats a port
    // until someone notices.
    await killEverything();
  }

  printTable(report);
  if (abReport) {
    printTable(abReport);
    printDelta(report, abReport);
    printCostRatios(report, abReport);
    report.ab = abReport;
  }
  const dead = report.segments.filter((s) => !s.alive);
  if (dead.length > 0) {
    console.error(
      `\n!! plane was dead during: ${dead
        .map(
          (s) =>
            `${s.name} (${s.aliveBefore === false ? "dead before the window" : "died in the window"}${s.death ? `, cause ${s.death.cause ?? "unknown"}` : ""})`,
        )
        .join(
          ", ",
        )} — that segment measured a kill-cam, not the scene. Fix the path.`,
    );
  }
  if (report.pageErrors.length > 0) {
    console.error(`\n!! page errors:\n${report.pageErrors.join("\n")}`);
  }
  if (report.determinism) {
    const d = report.determinism;
    console.log(
      `\ndeterminism over ${opts.runs} passes: worst GPU p50 spread ` +
        `${d.worstGpuP50SpreadMs.toFixed(2)} ms (${d.worstGpuP50SpreadPct.toFixed(1)}%), ` +
        `worst wall p50 spread ${d.worstP50SpreadPct.toFixed(1)}%, draw calls ` +
        `${d.drawCallsAgreeEverywhere ? "identical" : "DIFFER"} per segment`,
    );
    console.log(
      `  asserted over ${d.assertedOver.join(", ")}; ${d.notAsserted.join(" and ")} measured but not asserted (${d.worldPinned ? "fake pilots on their own wall clock — see UNPINNED_WORLD_PINNED" : "server-clock content, world NOT pinned — see UNPINNED_SEGMENTS"})`,
    );
    console.log(
      `  tolerance: draw calls identical + GPU p50 within ${TOLERANCE.gpuP50Pct}% or ${TOLERANCE.gpuP50Ms.toFixed(1)} ms, whichever is looser (wall p50 reported, not asserted) — ${d.pass ? "PASS" : "FAIL"}`,
    );
    if (!d.pass) {
      // "It disagreed" has two very different causes and the harness already
      // holds the evidence to tell them apart, so it says WHICH rather than
      // always blaming the pinning. Draw calls are an integer count of what
      // was submitted: if they held, the scene did not move, and the spread
      // is in what the machine charged for the same work.
      if (!d.drawCallsAgreeEverywhere) {
        console.error(
          "  !! DRAW CALLS MOVED — the harness stopped pinning the scene. Nothing measured against it is trustworthy until that is fixed.",
        );
      } else if (d.worstP50SpreadPct >= d.worstGpuP50SpreadPct) {
        console.error(
          `  !! the machine was busy: wall p50 moved ${d.worstP50SpreadPct.toFixed(1)}% alongside the GPU's ${d.worstGpuP50SpreadPct.toFixed(1)}%, and contention raises both together. Re-run on a quieter box.`,
        );
      } else {
        console.error(
          `  !! the SCENE held (draw calls identical, wall p50 within ${d.worstP50SpreadPct.toFixed(1)}%) but GPU cost moved ${d.worstGpuP50SpreadPct.toFixed(1)}% — that is the GPU's own clock/occupancy state between passes, not the build.`,
        );
        console.error(
          "     Absolute numbers from this run are not comparable to a baseline recorded in a different GPU state. A paired --ab delta still is: both arms are interleaved through the same state, which is exactly what --ab is for.",
        );
      }
    }
  }

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${opts.out}`);
  if (opts.baseline) {
    const path = resolve(HERE, "baseline.json");
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${path}`);
  }
  if (opts.compare) {
    printDelta(report, JSON.parse(readFileSync(opts.compare, "utf8")));
  }
  // Only --strict turns a failure into an exit code. The default stays
  // "report, don't gate": the baseline needs a few PRs of trust first, and
  // a check that fails on a busy laptop gets disabled and then ignored.
  if (opts.strict && report.determinism && !report.determinism.pass) {
    process.exitCode = 1;
  }
}

// Only when RUN as the entry point. `tools/perf/run.test.mjs` imports the
// pure helpers above, and importing a module must never boot a server and
// fly a benchmark.
const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(resolve(HERE, "run.mjs"))) {
  main().catch(async (err) => {
    console.error(err);
    await killEverything();
    process.exit(1);
  });
}
