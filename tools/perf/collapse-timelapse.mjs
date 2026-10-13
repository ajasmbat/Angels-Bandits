// D11 collapse time-lapse: a tower felled through __ab.qaDestruction, seen
// from a fixed QA camera, captured at fixed times after it lets go and laid
// out as one labelled sheet — what a player 300–600 m away sees.
//
//   npm run build -w client
//   node tools/perf/collapse-timelapse.mjs <outDir> [--cases pancake,topple,chain]
//     [--times before,1.5,3,4.5,6.5,9,14,25] [--label after] [--port 8231]
//     [--root <checkout>] [--fps 30] [--res 0.75] [--eye x,y,z --at x,y,z]
//     [--sheet-only]   (lay out the frames a run already saved in <outDir>)
//
// Same browser knobs as gallery.mjs (AB_CHROME / AB_CHROME_ARGS, e.g.
// SwiftShader on a GPU-less box; AB_GALLERY_QUALITY pins a tier). `--root`
// serves another checkout's built client (a before sheet from main).
//
// The world clock is pinned (__ab.pinWorld) and the tower felled LEAD_MS
// after it, so every capture is the same instant of the same collapse on
// any machine. A build with `__ab.qaFrameClock` (D11) also steps every
// frame by 1000 / fps ms of a virtual clock, so a 1 fps software
// rasteriser sheds and ages the particles as a GPU at `fps` would; the
// last WARM_MS before each capture are rendered frame by frame (anything
// further is jumped). A build without it jumps the world clock only (its
// particles age on the wall clock: sparser than in play).
//
// The plane is parked high over the eye (above every roof, under the
// carrier band), pinned every frame; its crash state is logged per frame
// shot (a staged collapse must never reach it).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { CASES } from "./collapse-cases.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const OUT = resolve(
  argv[0] && !argv[0].startsWith("--") ? argv[0] : "timelapse",
);
const PORT = Number(opt("port", 8231));
const ROOT = resolve(opt("root", "."));
const LABEL = opt("label", "");
const FPS = Number(opt("fps", 30));
const RES = opt("res", "0.75");
const TIMES = opt("times", "before,1.5,3,4.5,6.5,9,14,25")
  .split(",")
  .map((t) => (t === "before" ? null : Number(t)));
/** World ms between the pin and the tower letting go. */
const LEAD_MS = 1000;
/** Rendered frame by frame before each capture, world ms. */
const WARM_MS = 2500;

const ONLY = opt("cases", Object.keys(CASES).join(",")).split(",");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
  cwd: ROOT,
  // No carrier war and a quiet city (no director demolitions, raids or
  // meteors on the wall clock): nothing breaks but what is staged. A slow
  // frame must not read as a dead client.
  env: {
    ...process.env,
    PORT: String(PORT),
    AB_WAVES: "0",
    AB_QUIET_CITY: "1",
    LIVENESS_TIMEOUT_MS: "600000",
  },
  stdio: "ignore",
});

/** Wait until the pinned world reaches `ms` (frames keep rendering). */
const untilWorld = (page, ms) =>
  page.waitForFunction(
    (target) => (window.__ab.renderMs() ?? 0) >= target,
    ms,
    { polling: "raf", timeout: 600_000 },
  );

/**
 * A capture's luma (Rec. 709 over sRGB, 0–255): mean, standard deviation
 * and the share of pixels at 250 or more (clipped) — "never one flat grey,
 * never blown white" as numbers.
 */
const lumaStats = (statsPage, png) =>
  statsPage.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let sum = 0;
    let sq = 0;
    let clipped = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      sum += l;
      sq += l * l;
      if (l >= 250) clipped++;
    }
    const mean = sum / n;
    return {
      mean: Math.round(mean * 10) / 10,
      std: Math.round(Math.sqrt(Math.max(0, sq / n - mean * mean)) * 10) / 10,
      clipped: Math.round((clipped / n) * 10000) / 100,
    };
  }, png.toString("base64"));

/**
 * The labelled sheet — two columns of 640×360 frames, a caption on each,
 * the case's title on top — drawn on a plain 2D canvas in `page` (no page
 * screenshot: a full-page capture of eight full frames could take the
 * browser down on a loaded software-GL box). PNG bytes.
 */
async function makeSheet(page, title, shots) {
  const b64 = await page.evaluate(
    async ([title, frames]) => {
      const W = 640;
      const H = 360;
      const rows = Math.ceil(frames.length / 2);
      const cv = document.createElement("canvas");
      cv.width = 2 * W;
      cv.height = 32 + rows * H;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.font = "600 15px monospace";
      ctx.fillStyle = "#fff";
      ctx.fillText(title, 10, 21);
      for (let i = 0; i < frames.length; i++) {
        const img = new Image();
        img.src = `data:image/png;base64,${frames[i].png}`;
        await img.decode();
        const x = (i % 2) * W;
        const y = 32 + Math.floor(i / 2) * H;
        ctx.drawImage(img, x, y, W, H);
        ctx.fillStyle = "rgba(0,0,0,.75)";
        ctx.fillRect(x, y, 12 + 9.2 * frames[i].label.length, 26);
        ctx.fillStyle = "#fff";
        ctx.fillText(frames[i].label, x + 8, y + 18);
      }
      return cv.toDataURL("image/png").split(",")[1];
    },
    [title, shots.map((s) => ({ label: s.label, png: s.png }))],
  );
  return Buffer.from(b64, "base64");
}

const chromeArgs = () => ({
  executablePath:
    process.env.AB_CHROME ??
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  args: process.env.AB_CHROME_ARGS
    ? process.env.AB_CHROME_ARGS.split(" ")
    : ["--use-angle=metal", "--enable-gpu"],
});

// `--sheet-only`: lay out the frames an earlier run saved in <outDir>.
if (argv.includes("--sheet-only")) {
  const b = await chromium.launch(chromeArgs());
  const page = await b.newPage();
  for (const name of ONLY) {
    const shots = TIMES.map((tau) => ({
      label: tau === null ? "before" : `t = ${tau.toFixed(1)} s`,
      file: `${OUT}/${name}-${tau === null ? "before" : tau.toFixed(1)}.png`,
    }))
      .filter((s) => existsSync(s.file))
      .map((s) => ({ ...s, png: readFileSync(s.file).toString("base64") }));
    if (shots.length === 0) continue;
    const title = `${CASES[name].title}${LABEL ? ` — ${LABEL}` : ""}`;
    writeFileSync(
      `${OUT}/${name}-timelapse${LABEL ? `-${LABEL}` : ""}.png`,
      await makeSheet(page, title, shots),
    );
    console.log("sheet", name, shots.length);
  }
  await b.close();
  server.kill();
  process.exit(0);
}

let browser;
try {
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
    } catch {}
    await sleep(250);
  }
  browser = await chromium.launch(chromeArgs());
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  const quality = process.env.AB_GALLERY_QUALITY
    ? `&quality=${process.env.AB_GALLERY_QUALITY}`
    : "";
  await page.goto(
    `http://127.0.0.1:${PORT}/?res=${RES}&sky=night&nanprobe&silence=600000${quality}`,
  );
  await page.fill("#join-name", "LAPSE");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => !!window.__ab, null, { timeout: 120_000 });
  await sleep(1500);
  const virtual = await page.evaluate(() => !!window.__ab.qaFrameClock);
  // A plain page that measures each capture (no WebGL: a 2D canvas).
  const stats = await browser.newPage();
  console.log(
    `build ${ROOT}: ${virtual ? `virtual frame clock at ${FPS} fps` : "no qaFrameClock — world-clock jumps only"}`,
  );
  const report = { label: LABEL, root: ROOT, virtual, fps: FPS, cases: {} };

  for (const name of ONLY) {
    const base = CASES[name];
    if (!base) throw new Error(`no case "${name}"`);
    // `--eye x,y,z --at x,y,z`: the same collapse from another pose.
    const xyz = (o) => opt(o, null)?.split(",").map(Number) ?? null;
    const c = {
      ...base,
      eye: xyz("eye") ?? base.eye,
      at: xyz("at") ?? base.at,
    };
    await page.evaluate(() => window.__ab.weather("clear"));
    // The world from here: pinned, the tower felled LEAD_MS on.
    const w0 = await page.evaluate(() => {
      const t = Math.round(window.__ab.renderMs() ?? 0);
      window.__ab.pinWorld(t);
      return t;
    });
    await page.evaluate(
      ({ eye, at, fov }) => {
        window.__ab.qaCamera({
          eye: { x: eye[0], y: eye[1], z: eye[2] },
          at: { x: at[0], y: at[1], z: at[2] },
          fov,
        });
        // Parked over the eye, above every roof (CITY_TOP 480 m) and
        // under the carrier band; re-pinned every frame.
        window.__abPin = true;
        const hold = () => {
          if (!window.__abPin) return;
          window.__ab.teleport(eye[0], eye[2], 520, 0);
          requestAnimationFrame(hold);
        };
        hold();
      },
      { eye: c.eye, at: c.at, fov: c.fov },
    );
    await page.evaluate(() => window.__ab.weather("clear"));
    const t0 = w0 + LEAD_MS;
    const staged = await page.evaluate(
      ({ fell, t0 }) => {
        window.__ab.standingBudget?.(1e9);
        return window.__ab.qaDestruction({
          fell: fell.map((f) => ({ ...f, t: t0 })),
        });
      },
      { fell: c.fell, t0 },
    );
    console.log("stage", name, JSON.stringify(staged));
    if (virtual)
      await page.evaluate((dt) => window.__ab.qaFrameClock(dt), 1000 / FPS);
    const shots = [];
    const deaths = [];
    for (const tau of TIMES) {
      const target = tau === null ? w0 + LEAD_MS / 2 : t0 + tau * 1000;
      const now = await page.evaluate(() => window.__ab.renderMs() ?? 0);
      if (target - now > WARM_MS) {
        await page.evaluate((t) => window.__ab.pinWorld(t), target - WARM_MS);
      }
      await untilWorld(page, target);
      const png = await page.screenshot({ timeout: 300_000 });
      const info = await page.evaluate(() => {
        const d = window.__ab.destruction();
        const c = window.__ab.combat();
        return {
          world: window.__ab.renderMs(),
          alive: c.alive,
          death: c.lastDeath?.cause ?? null,
          debrisPieces: d.debrisPieces,
          dustPuffs: d.dustPuffs,
          // D11 (null on a build without them): the dust's share of the
          // frame and the haze at the eye; what the camera sees of the
          // collapse; the fragments lying settled.
          dustCoverage: d.dustCoverage ?? null,
          dustHazeAtEye: d.dustHazeAtEye ?? null,
          view: d.collapseView ?? null,
          settled: d.settledFlecks ?? null,
          impactParticles: d.impactParticles,
          drawCalls: window.__ab.perf().drawCalls,
          nan: window.__ab.nanProbe(),
        };
      });
      info.luma = await lumaStats(stats, png);
      if (!info.alive) deaths.push({ tau, cause: info.death });
      const label = tau === null ? "before" : `t = ${tau.toFixed(1)} s`;
      console.log("shot", name, label, JSON.stringify(info));
      writeFileSync(
        `${OUT}/${name}-${tau === null ? "before" : tau.toFixed(1)}.png`,
        png,
      );
      shots.push({ label, png: png.toString("base64"), info });
    }
    if (virtual) await page.evaluate(() => window.__ab.qaFrameClock(null));
    await page.evaluate(() => {
      window.__abPin = false;
      window.__ab.qaDestruction(null);
      window.__ab.standingBudget?.(null);
      window.__ab.qaCamera(null);
      window.__ab.pinWorld(null);
    });
    report.cases[name] = {
      title: c.title,
      staged,
      deaths,
      shots: shots.map((s) => ({ label: s.label, ...s.info })),
    };
    writeFileSync(
      `${OUT}/${name}${LABEL ? `-${LABEL}` : ""}.json`,
      JSON.stringify(report.cases[name], null, 2),
    );
    try {
      writeFileSync(
        `${OUT}/${name}-timelapse${LABEL ? `-${LABEL}` : ""}.png`,
        await makeSheet(
          stats,
          `${c.title}${LABEL ? ` — ${LABEL}` : ""}`,
          shots,
        ),
      );
    } catch (e) {
      // The frames are on disk: `--sheet-only` lays them out later.
      console.error("sheet", name, e.message);
    }
    console.log(
      "deaths",
      name,
      deaths.length === 0 ? "none" : JSON.stringify(deaths),
    );
  }
  writeFileSync(
    `${OUT}/timelapse${LABEL ? `-${LABEL}` : ""}.json`,
    JSON.stringify(report, null, 2),
  );
} finally {
  server.kill();
  await browser?.close().catch(() => {});
}
