// L4 weather QA: the gallery's fixed viewpoints, shot once per weather phase,
// plus an optional per-shot frame-cost/draw-call sample.
//   npm run build -w client && WEATHER=clear,drizzle,downpour \
//     node tools/perf/weather.mjs <outDir> [port] [view,view]
//
// Each phase is pinned through __ab.weather(phase) (the middle of that phase
// in the current cycle) and re-pinned every frame, as is the pose: on a
// software renderer a frame takes seconds, long enough for the plane to fly
// out of shot or a pinned offset to drift into the next phase. Shots land
// just after a storm strike has been consumed, never on the one-frame violet
// sky flash a strike paints. PNGs are <view>-<weather>.png.
//
// FRAMES=120 also records each shot's frame-time p50 and median draw calls
// over that many frames (after a 2 s warm-up) into <outDir>/weather-perf.json.
// On a shared or software-GL box, compare weathers with interleaved runs, not
// one sequential pass — load drift dwarfs the difference.
//
// Same browser knobs as gallery.mjs: AB_CHROME / AB_CHROME_ARGS (e.g.
// SwiftShader on Linux: AB_CHROME_ARGS="--use-angle=swiftshader
// --enable-unsafe-swiftshader") and AB_GALLERY_RES (pinned pixel ratio,
// default 1.5 — the auto scaler would otherwise hide fill cost). Use a port
// of your own: parallel worktrees share 8099.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const OUT = resolve(process.argv[2] ?? "weather");
const PORT = Number(process.argv[3] ?? 8099);
const ONLY = process.argv[4] ? process.argv[4].split(",") : null;
const WEATHERS = (process.env.WEATHER ?? "clear,drizzle,downpour").split(",");
const FRAMES = Number(process.env.FRAMES ?? 0);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
// The gallery's static viewpoints (gallery.mjs), weather-relevant subset.
const VIEWS = [
  { name: "chase-rooftops", x: 300, z: 900, y: 175, yaw: 0.6 },
  { name: "chase-canyon", x: 400, z: 1100, y: 70, yaw: 0 },
  { name: "high-overview", x: 100, z: 1500, y: 380, yaw: 0.9, pitch: -0.35 },
  { name: "plane-side", x: 600, z: 700, y: 200, yaw: 1.2 },
  { name: "plane-front", x: 800, z: 300, y: 160, yaw: -0.4 },
  { name: "street-low", x: 1000, z: 1300, y: 35, yaw: 0 },
  { name: "rooftop-skim", x: 1210, z: 500, y: 140, yaw: 1.57, pitch: -0.15 },
  { name: "plaza-park", x: 900, z: 1030, y: 120, yaw: 0, pitch: -0.6 },
  { name: "moon", x: 700, z: 1000, y: 260, yaw: -0.61, pitch: 0.2 },
];
let browser;
try {
  for (let i = 0; i < 120; i++) {
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
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE", m.text());
  });
  await page.goto(
    `http://127.0.0.1:${PORT}/?res=${process.env.AB_GALLERY_RES ?? 1.5}&sky=night`,
  );
  await page.fill("#join-name", "WX");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => !!window.__ab, null, { timeout: 60000 });
  await page.evaluate(() => window.__ab.setBots(0));
  await sleep(1500);
  // Hold the pose and the weather phase EVERY frame from inside the page.
  await page.evaluate(() => {
    const hold = () => {
      if (window.__wxPhase) window.__ab.weather(window.__wxPhase);
      const v = window.__wxPin;
      if (v) {
        window.__ab.teleport(v.x, v.z, v.y, v.yaw);
        if (v.pitch) window.__ab.state().pitch = v.pitch;
      }
      requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
  });
  const frames = () =>
    page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  const perfRows = [];
  for (const wx of WEATHERS) {
    const state = await page.evaluate((w) => {
      window.__wxPhase = w;
      return window.__ab.weather(w);
    }, wx);
    console.log("weather", wx, JSON.stringify(state));
    await sleep(1500); // resample + let the haze/rain settle
    for (const v of VIEWS) {
      if (ONLY && !ONLY.includes(v.name)) continue;
      await page.evaluate((v) => {
        window.__wxPin = v;
      }, v);
      await sleep(1600);
      // Shoot just after a strike is consumed: the next is ≥ 8 s away.
      const lastStrike = () =>
        page.evaluate(() => window.__ab.storm().strikes.at(-1)?.timeMs ?? 0);
      const before = await lastStrike();
      for (let k = 0; k < 60 && (await lastStrike()) === before; k++) {
        await sleep(500);
      }
      await frames();
      const shot = `${v.name}-${wx}`;
      await page.screenshot({ path: `${OUT}/${shot}.png`, timeout: 180000 });
      console.log(
        "shot",
        shot,
        JSON.stringify(await page.evaluate(() => window.__ab.perf())),
      );
      if (FRAMES > 0) {
        await sleep(2000);
        await page.evaluate(() => window.__ab.perfReset());
        while (
          (await page.evaluate(() => window.__ab.perfStats().count)) < FRAMES
        ) {
          await sleep(250);
        }
        const st = await page.evaluate(() => window.__ab.perfStats());
        const drops = (await page.evaluate(() => window.__ab.weather())).drops;
        perfRows.push({
          view: v.name,
          weather: wx,
          p50: st.p50,
          drawCalls: st.drawCalls,
          drawCallsMax: st.drawCallsMax,
          drops,
        });
        console.log("perf", shot, JSON.stringify(perfRows.at(-1)));
      }
    }
  }
  if (FRAMES > 0) {
    writeFileSync(
      `${OUT}/weather-perf.json`,
      JSON.stringify(perfRows, null, 2),
    );
  }
} finally {
  server.kill();
  await browser?.close().catch(() => {});
}
