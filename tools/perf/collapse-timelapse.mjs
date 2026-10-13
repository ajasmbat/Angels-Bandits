// D11 collapse time-lapse: a tower felled through __ab.qaDestruction, seen
// from a fixed QA camera, captured at fixed times after it lets go and laid
// out as one labelled sheet — what a player 300–600 m away sees.
//
//   npm run build -w client
//   node tools/perf/collapse-timelapse.mjs <outDir> [--cases pancake,topple,chain]
//     [--times before,1.5,3,4.5,6.5,9,14,25] [--label after] [--port 8231]
//     [--root <checkout>] [--fps 30] [--res 0.75]
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
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

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

/**
 * The collapses. Building indices are generateCity(CITY_SEED)'s and `h`
 * guards them (qaDestruction throws if the city changed). Eyes are
 * ~460 m off and 200 m up with a clear sight line to the tower (losClear
 * over every other building), the tower near the middle of the frame.
 */
const CASES = {
  // The planner's pancake: building 166 (305 m at (663, 729)), from the
  // north-west across the river blocks.
  pancake: {
    title: "pancake — building 166, 305 m, eye 460 m off, 200 m up",
    eye: [264, 200, 959],
    at: [663, 140, 729],
    fell: [{ b: 166, h: 305, style: "pancake", dir: 0 }],
  },
  // The planner's topple: building 247 (312 m at (948, 1651)) falling
  // north (−z), across the view from the east.
  topple: {
    title: "topple — building 247, 312 m, falling north, eye 470 m off",
    eye: [1410, 200, 1569],
    at: [948, 130, 1651],
    fell: [{ b: 247, h: 312, style: "topple", dir: 2 }],
  },
  // Tower-on-tower: building 157 (294 m at (659, 249)) felled west into
  // the 302 m building 110, whose struck floors give way in turn (D10
  // `chain`), seen from the north.
  chain: {
    title: "tower-on-tower — 157 (294 m) toppled west into 110 (302 m)",
    eye: [682, 200, -170],
    at: [600, 120, 293],
    fell: [{ b: 157, h: 294, style: "topple", dir: 0, chain: true }],
  },
};

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

let browser;
try {
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
    } catch {}
    await sleep(250);
  }
  browser = await chromium.launch({
    executablePath:
      process.env.AB_CHROME ??
      `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    args: process.env.AB_CHROME_ARGS
      ? process.env.AB_CHROME_ARGS.split(" ")
      : ["--use-angle=metal", "--enable-gpu"],
  });
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
  console.log(
    `build ${ROOT}: ${virtual ? `virtual frame clock at ${FPS} fps` : "no qaFrameClock — world-clock jumps only"}`,
  );
  const report = { label: LABEL, root: ROOT, virtual, fps: FPS, cases: {} };

  for (const name of ONLY) {
    const c = CASES[name];
    if (!c) throw new Error(`no case "${name}"`);
    await page.evaluate(() => window.__ab.weather("clear"));
    // The world from here: pinned, the tower felled LEAD_MS on.
    const w0 = await page.evaluate(() => {
      const t = Math.round(window.__ab.renderMs() ?? 0);
      window.__ab.pinWorld(t);
      return t;
    });
    await page.evaluate(
      ({ eye, at }) => {
        window.__ab.qaCamera({
          eye: { x: eye[0], y: eye[1], z: eye[2] },
          at: { x: at[0], y: at[1], z: at[2] },
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
      { eye: c.eye, at: c.at },
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
          impactParticles: d.impactParticles,
          drawCalls: window.__ab.perf().drawCalls,
          nan: window.__ab.nanProbe(),
        };
      });
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
    // The labelled sheet: two columns, a caption bar on each frame.
    const sheet = await browser.newPage({
      viewport: { width: 1280, height: 400 },
      deviceScaleFactor: 1,
    });
    const head = `${c.title}${LABEL ? ` — ${LABEL}` : ""}`;
    await sheet.setContent(`<!doctype html><html><body style="margin:0;background:#000;font:600 15px/1 monospace;color:#fff">
      <div style="padding:8px 10px;background:#111">${head}</div>
      <div style="display:grid;grid-template-columns:640px 640px">
      ${shots
        .map(
          (s) => `<div style="position:relative;width:640px;height:360px">
          <img src="data:image/png;base64,${s.png}" style="width:640px;height:360px;display:block">
          <div style="position:absolute;left:0;top:0;padding:6px 10px;background:rgba(0,0,0,.75)">${s.label}</div></div>`,
        )
        .join("")}
      </div></body></html>`);
    await sheet.screenshot({
      path: `${OUT}/${name}-timelapse${LABEL ? `-${LABEL}` : ""}.png`,
      fullPage: true,
    });
    await sheet.close();
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
