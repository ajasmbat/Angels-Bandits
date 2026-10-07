// VO gallery: fixed viewpoints -> PNGs, for before/after visual review.
//   npm run build -w client && node tools/perf/gallery.mjs <outDir> [port] [view,view]
// Uses the cached chromium headless shell on Metal (see tools/perf/README.md).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
const OUT = resolve(process.argv[2] ?? "gallery");
const PORT = Number(process.argv[3] ?? 8099);
const ONLY = process.argv[4] ? process.argv[4].split(",") : null;
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
    // AB_CHROME / AB_CHROME_ARGS let the same script shoot off the M3 (e.g. a
    // Linux box: no Metal, so ANGLE's GL/Vulkan backends instead).
    executablePath:
      process.env.AB_CHROME ??
      `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    args: (
      process.env.AB_CHROME_ARGS ?? "--use-angle=metal --enable-gpu"
    ).split(" "),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE", m.text());
  });
  await page.goto(`http://127.0.0.1:${PORT}/?res=1.5`);
  await page.fill("#join-name", "SHOT");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => !!window.__ab, null, { timeout: 60000 });
  await page.evaluate(() => window.__ab.setBots(0));
  await sleep(1500);
  for (const v of VIEWS) {
    if (ONLY && !ONLY.includes(v.name)) continue;
    const pin = async () =>
      page.evaluate((v) => {
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
    await page.screenshot({ path: `${OUT}/${v.name}.png` });
    if (v.orbit) {
      await page.keyboard.up("KeyE");
      await sleep(600);
    }
    console.log(
      "shot",
      v.name,
      JSON.stringify(await page.evaluate(() => window.__ab.perf())),
    );
  }
  // L6: one intersection at a red (a real queue behind the stop line), then
  // the SAME intersection on green as the queue pulls away. Pinned through
  // __ab.trafficQueue / __ab.trafficAspect so the shots are of a queue the
  // model really holds, not a lucky frame.
  const wantRed = !ONLY || ONLY.includes("intersection-red");
  const wantGreen = !ONLY || ONLY.includes("intersection-green");
  if (wantRed || wantGreen) {
    let q = null;
    for (let k = 0; k < 120; k++) {
      q = await page.evaluate(() => {
        const queue = window.__ab.trafficQueue();
        if (!queue || queue.count < 3) return null;
        const aspect = window.__ab.trafficAspect(queue.bx, queue.bz)[
          queue.axis
        ];
        return aspect === "red" ? queue : null;
      });
      if (q) break;
      await sleep(500);
    }
    if (!q) throw new Error("no red-light queue of 3+ within 60 s");
    // The plane hangs back along the lane, looking down it at the stop line:
    // forward is −Z at yaw 0 for planes and cars alike.
    const fx = -Math.sin(q.yaw);
    const fz = -Math.cos(q.yaw);
    const view = {
      x: q.x - fx * 62,
      z: q.z - fz * 62,
      y: 24,
      yaw: q.yaw,
      pitch: -0.32,
    };
    const hold = async () => {
      for (let k = 0; k < 18; k++) {
        await page.evaluate((v) => {
          window.__ab.teleport(v.x, v.z, v.y, v.yaw);
          window.__ab.state().pitch = v.pitch;
        }, view);
        await sleep(90);
      }
    };
    if (wantRed) {
      await hold();
      await page.screenshot({ path: `${OUT}/intersection-red.png` });
      console.log(
        "shot intersection-red",
        JSON.stringify(q),
        JSON.stringify(await page.evaluate(() => window.__ab.perf())),
      );
    }
    if (wantGreen) {
      for (let k = 0; k < 120; k++) {
        const aspect = await page.evaluate(
          (q) => window.__ab.trafficAspect(q.bx, q.bz)[q.axis],
          q,
        );
        if (aspect === "green") break;
        await sleep(250);
      }
      // A few seconds into green: the start-up wave is rolling.
      await sleep(2500);
      await hold();
      await page.screenshot({ path: `${OUT}/intersection-green.png` });
      console.log(
        "shot intersection-green",
        JSON.stringify(await page.evaluate(() => window.__ab.perf())),
      );
    }
  }
} finally {
  server.kill();
  await browser?.close().catch(() => {});
}
