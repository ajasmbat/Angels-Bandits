// P1 penetration time-lapse: a plane (a fighter's airframe flown in level),
// a meteor and a comet staged into a tower through __ab.qaPenetrate, seen
// from the planner's fixed side-on QA camera, captured at fixed times after
// the impact and laid out as one labelled sheet per case — the body
// ploughing on, a burst per chunk as it gets there, the tunnel left behind.
//
//   npm run build -w client
//   node tools/perf/penetrate-timelapse.mjs <outDir> [--cases plane,meteor,comet]
//     [--times before,0.1,0.25,0.45,0.7,1,1.5,3] [--port 8232] [--fps 30]
//     [--res 0.75]
//
// Same browser knobs as gallery.mjs (AB_CHROME / AB_CHROME_ARGS, e.g.
// SwiftShader on a GPU-less box; AB_GALLERY_QUALITY pins a tier). The world
// clock is pinned (__ab.pinWorld) and the impact staged LEAD_MS after it,
// so every capture is the same instant of the same impact on any machine;
// with `__ab.qaFrameClock` every frame steps 1000 / fps ms of a virtual
// clock, so a 1 fps software rasteriser ages the particles as a GPU would.
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
  argv[0] && !argv[0].startsWith("--") ? argv[0] : "penetrate-timelapse",
);
const PORT = Number(opt("port", 8232));
const FPS = Number(opt("fps", 30));
const RES = opt("res", "0.75");
const TIMES = opt("times", "before,0.1,0.25,0.45,0.7,1,1.5,3")
  .split(",")
  .map((t) => (t === "before" ? null : Number(t)));
const CASES = {
  plane: "P1 — a fighter flown level into a tower's flank",
  meteor: "P1 — a meteor down through a tower's roof",
  comet: "P1 — a comet through a row of buildings",
};
const ONLY = opt("cases", Object.keys(CASES).join(",")).split(",");
/** World ms between the pin and the impact. */
const LEAD_MS = 5000;
/** Rendered frame by frame before each capture, world ms. */
const WARM_MS = 1500;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The host flags. SOLO: the page's own host reads them off `sim`
 * (local-game.mjs); the spawned server — statics, and a pre-SOLO build's
 * game — off its environment. */
// A quiet city with an empty sky: nothing breaks but what is staged.
const HOST_ENV = {
  AB_WAVES: "0",
  AB_QUIET_CITY: "1",
  LIVENESS_TIMEOUT_MS: "600000",
};

const server = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), ...HOST_ENV },
  stdio: "ignore",
});

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
  page.on("pageerror", (e) => console.error("PAGEERROR", e.stack));
  const quality = process.env.AB_GALLERY_QUALITY
    ? `&quality=${process.env.AB_GALLERY_QUALITY}`
    : "";
  await page.goto(
    withSim(
      `http://127.0.0.1:${PORT}/?res=${RES}&sky=night&nanprobe&silence=600000${quality}`,
      HOST_ENV,
    ),
  );
  await page.fill("#join-name", "LAPSE");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => !!window.__ab, null, { timeout: 120_000 });
  await sleep(1500);
  const virtual = await page.evaluate(() => !!window.__ab.qaFrameClock);
  const stats = await browser.newPage();
  const report = { virtual, fps: FPS, cases: {} };

  for (const name of ONLY) {
    if (!CASES[name]) throw new Error(`no case "${name}"`);
    await page.evaluate(() => window.__ab.weather("clear"));
    const w0 = await page.evaluate(() => {
      const t = Math.round(window.__ab.renderMs() ?? 0);
      window.__ab.pinWorld(t);
      return t;
    });
    // Plan first (far ahead) for the camera; stage for real below.
    const plan = await page.evaluate(
      (k) => window.__ab.qaPenetrate(k, 600_000),
      name,
    );
    if (!plan) throw new Error(`qaPenetrate("${name}") planned nothing`);
    await page.evaluate(
      ({ eye, at }) => {
        window.__ab.qaCamera({ eye, at });
        // Parked over the eye, above every roof; re-pinned every frame.
        window.__abPin = true;
        const hold = () => {
          if (!window.__abPin) return;
          window.__ab.teleport(eye.x, eye.z, 520, 0);
          requestAnimationFrame(hold);
        };
        hold();
      },
      { eye: plan.eye, at: plan.at },
    );
    const t0 = w0 + LEAD_MS;
    const staged = await page.evaluate(
      ({ k, t0 }) =>
        window.__ab.qaPenetrate(k, t0 - (window.__ab.renderMs() ?? 0)),
      { k: name, t0 },
    );
    console.log("stage", name, JSON.stringify(staged));
    if (virtual)
      await page.evaluate((dt) => window.__ab.qaFrameClock(dt), 1000 / FPS);
    const shots = [];
    for (const tau of TIMES) {
      const target = tau === null ? t0 - 1200 : staged.t + tau * 1000;
      const now = await page.evaluate(() => window.__ab.renderMs() ?? 0);
      if (target - now > WARM_MS) {
        await page.evaluate((t) => window.__ab.pinWorld(t), target - WARM_MS);
      }
      await untilWorld(page, target);
      // Hold the instant: a software frame of seconds would otherwise age
      // the scene by several virtual frames during the capture itself.
      if (virtual) await page.evaluate(() => window.__ab.qaFrameClock(0.001));
      const png = await page.screenshot({ timeout: 300_000 });
      const info = await page.evaluate(() => ({
        world: window.__ab.renderMs(),
        pen: window.__ab.penetrations(),
        drawCalls: window.__ab.perf().drawCalls,
        destroyed: window.__ab.destruction().destroyed,
        nan: window.__ab.nanProbe(),
      }));
      info.luma = await lumaStats(stats, png);
      if (virtual)
        await page.evaluate((dt) => window.__ab.qaFrameClock(dt), 1000 / FPS);
      // Labelled with the instant actually drawn (≥ the target).
      const off = (info.world - staged.t) / 1000;
      const label = `${tau === null ? "before: " : ""}t = ${off.toFixed(2)} s`;
      console.log("shot", name, label, JSON.stringify(info));
      writeFileSync(
        `${OUT}/${name}-${tau === null ? "before" : tau.toFixed(2)}.png`,
        png,
      );
      shots.push({ label, png: png.toString("base64"), info });
    }
    if (virtual) await page.evaluate(() => window.__ab.qaFrameClock(null));
    await page.evaluate(() => {
      window.__abPin = false;
      window.__ab.qaPenetrate(null);
      window.__ab.qaCamera(null);
      window.__ab.pinWorld(null);
    });
    report.cases[name] = {
      title: CASES[name],
      staged,
      shots: shots.map((s) => ({ label: s.label, ...s.info })),
    };
    try {
      writeFileSync(
        `${OUT}/${name}-timelapse.png`,
        await makeSheet(stats, CASES[name], shots),
      );
    } catch (e) {
      console.error("sheet", name, e.message);
    }
  }
  writeFileSync(`${OUT}/timelapse.json`, JSON.stringify(report, null, 2));
} finally {
  server.kill();
  await browser?.close().catch(() => {});
}
