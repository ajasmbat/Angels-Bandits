// VO gallery: fixed viewpoints -> PNGs, for before/after visual review.
//   npm run build -w client && node tools/perf/gallery.mjs <outDir> [port] [view,view]
// Uses the cached chromium headless shell on Metal (see tools/perf/README.md).
//
// L4 weather pass (optional): WEATHER=clear,drizzle,downpour pins each
// weather phase via __ab.weather(phase) and shoots every view once per
// weather, as <view>-<weather>.png. FRAMES=120 also measures each shot's
// frame-time p50 and draw calls over that many frames (after a 2 s warm-up)
// into <outDir>/weather-perf.json. RES=<ratio> pins the pixel ratio (default
// 1.5). CHROMIUM=<path> overrides the browser;
// off macOS it falls back to Playwright's own (SwiftShader — relative
// numbers only, see the README).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
const OUT = resolve(process.argv[2] ?? "gallery");
const PORT = Number(process.argv[3] ?? 8099);
const ONLY = process.argv[4] ? process.argv[4].split(",") : null;
const WEATHERS = process.env.WEATHER ? process.env.WEATHER.split(",") : [null];
const FRAMES = Number(process.env.FRAMES ?? 0);
/** Pinned pixel ratio (the auto scaler would hide fill cost). */
const RES = process.env.RES ?? "1.5";
const MAC_SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const EXECUTABLE =
  process.env.CHROMIUM ?? (existsSync(MAC_SHELL) ? MAC_SHELL : undefined);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
const VIEWS = [
  // name, x, z, y, yaw, extra
  { name: "chase-rooftops", x: 300, z: 900, y: 175, yaw: 0.6 },
  { name: "chase-canyon", x: 400, z: 1100, y: 70, yaw: 0 },
  { name: "high-overview", x: 100, z: 1500, y: 380, yaw: 0.9, pitch: -0.35 },
  { name: "plane-side", x: 600, z: 700, y: 200, yaw: 1.2, orbit: 260 },
  { name: "plane-front", x: 800, z: 300, y: 160, yaw: -0.4, orbit: 620 },
  { name: "street-low", x: 1000, z: 1300, y: 35, yaw: 0 },
  { name: "rooftop-skim", x: 1210, z: 500, y: 140, yaw: 1.57, pitch: -0.15 },
  // N1: plaza (4,4) as a night park — pond, paths, lamps, tree clusters.
  { name: "plaza-park", x: 900, z: 1030, y: 120, yaw: 0, pitch: -0.6 },
  { name: "moon", x: 700, z: 1000, y: 260, yaw: -0.61, pitch: 0.2 }, // faces MOON_DIR
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
    executablePath: EXECUTABLE,
    args:
      platform() === "darwin"
        ? ["--use-angle=metal", "--enable-gpu"]
        : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE", m.text());
  });
  await page.goto(`http://127.0.0.1:${PORT}/?res=${RES}`);
  await page.fill("#join-name", "SHOT");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => !!window.__ab, null, { timeout: 60000 });
  await page.evaluate(() => window.__ab.setBots(0));
  await sleep(1500);
  // Hold each view's pose EVERY frame from inside the page: on a software
  // renderer a frame takes seconds, and a pin sent from here between frames
  // lets the plane fly away from the view before the shot lands.
  await page.evaluate(() => {
    const hold = () => {
      const v = window.__galleryPin;
      if (v) {
        window.__ab.teleport(v.x, v.z, v.y, v.yaw);
        if (v.pitch) window.__ab.state().pitch = v.pitch;
      }
      requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
  });
  const perfRows = [];
  for (const wx of WEATHERS) {
    if (wx) {
      const state = await page.evaluate((w) => window.__ab.weather(w), wx);
      console.log("weather", wx, JSON.stringify(state));
      await sleep(1500); // resample + let the haze/rain settle
    }
    for (const v of VIEWS) {
      if (ONLY && !ONLY.includes(v.name)) continue;
      const pin = async () =>
        page.evaluate((v) => {
          window.__galleryPin = v;
          window.__ab.teleport(v.x, v.z, v.y, v.yaw);
          if (v.pitch) {
            const s = window.__ab.state();
            s.pitch = v.pitch;
          }
        }, v);
      await pin();
      if (v.orbit) {
        await page.mouse.move(640, 360);
        await page.keyboard.down("KeyE");
        for (let k = 0; k < 12; k++) {
          await page.mouse.move(640 + ((k + 1) * v.orbit) / 12, 360 - k * 2);
          await sleep(30);
        }
      }
      for (let k = 0; k < 18; k++) {
        await pin();
        await sleep(90);
      }
      const shot = wx ? `${v.name}-${wx}` : v.name;
      // Generous timeout: a software (SwiftShader) frame can take seconds.
      await page.screenshot({ path: `${OUT}/${shot}.png`, timeout: 180000 });
      if (FRAMES > 0) {
        // Frame cost at this exact pin: warm up, reset, hold until FRAMES.
        for (let k = 0; k < 20; k++) {
          await pin();
          await sleep(100);
        }
        await page.evaluate(() => window.__ab.perfReset());
        while (
          (await page.evaluate(() => window.__ab.perfStats().count)) < FRAMES
        ) {
          await pin();
          await sleep(100);
        }
        const st = await page.evaluate(() => window.__ab.perfStats());
        const drops = wx
          ? (await page.evaluate(() => window.__ab.weather())).drops
          : 0;
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
      if (v.orbit) {
        await page.keyboard.up("KeyE");
        await sleep(600);
      }
      console.log(
        "shot",
        shot,
        JSON.stringify(await page.evaluate(() => window.__ab.perf())),
      );
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
