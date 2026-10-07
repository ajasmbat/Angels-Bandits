// VO gallery: fixed viewpoints -> PNGs, for before/after visual review.
//   npm run build -w client && node tools/perf/gallery.mjs <outDir> [port] [view,view]
// Uses the cached chromium headless shell on Metal (see tools/perf/README.md;
// AB_CHROME / AB_CHROME_ARGS point it elsewhere, e.g. SwiftShader on Linux).
// The sky is pinned to deep night (`?sky=night`, L12) so shots never depend
// on the server's time of night; views with a `sky` field force their own
// phase through __ab.sky.
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
  // L12 sky cycle: each phase toward its own horizon (dusk glow in the west,
  // the night moon, the dawn glow in the east) and over the same rooftops.
  {
    name: "sky-dusk",
    x: 700,
    z: 1000,
    y: 230,
    yaw: 2.5,
    pitch: 0.12,
    sky: "dusk",
  },
  {
    name: "sky-night",
    x: 700,
    z: 1000,
    y: 230,
    yaw: -0.61,
    pitch: 0.12,
    sky: "night",
  },
  {
    name: "sky-predawn",
    x: 700,
    z: 1000,
    y: 230,
    yaw: -0.66,
    pitch: 0.12,
    sky: "predawn",
  },
  { name: "sky-dusk-city", x: 300, z: 900, y: 175, yaw: 0.6, sky: "dusk" },
  { name: "sky-night-city", x: 300, z: 900, y: 175, yaw: 0.6, sky: "night" },
  {
    name: "sky-predawn-city",
    x: 300,
    z: 900,
    y: 175,
    yaw: 0.6,
    sky: "predawn",
  },
  // L10 sky traffic: placed at capture time from the live __ab read-backs,
  // since all three move on the synced clock.
  { name: "sky-airliner", dyn: "airliner" },
  { name: "news-heli", dyn: "newsHeli" },
  { name: "drone-show", dyn: "drones" },
  // L5: the elevated train running down its canyon. x/z/yaw are recomputed
  // from the live train pose at every pin (it moves 22 m/s): the plane sits
  // `behind` m back from the last car and `side` m off its track, `y` m up,
  // nose `dyaw` off the train's heading so the plane does not hide it.
  // `leadMs` poses the train that far ahead of now (a slow software renderer
  // shows a frame seconds after it was pinned).
  {
    name: "train-canyon",
    train: true,
    behind: 38,
    side: -5,
    dyaw: 0.4,
    y: 40,
    pitch: -0.32,
    leadMs: 0,
  },
];
/** Yaw that points the nose along (dx, dz): yaw 0 faces -Z. */
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
/** Resolve an L10 view against the live world. */
async function place(page, v) {
  if (v.dyn === "airliner") {
    // Wait for one well up in the sky, then look straight at it.
    for (let i = 0; i < 120; i++) {
      const o = await page.evaluate(() =>
        window.__ab
          .skyTraffic()
          .airlinerOffsets.find(
            (a) =>
              a.y / Math.hypot(a.x, a.y, a.z) > 0.25 &&
              a.y / Math.hypot(a.x, a.y, a.z) < 0.6,
          ),
      );
      if (o) {
        const el = Math.atan2(o.y, Math.hypot(o.x, o.z));
        return {
          ...v,
          x: 1000,
          z: 1000,
          y: 330,
          yaw: yawTo(o.x, o.z),
          pitch: el * 0.8,
        };
      }
      await sleep(1000);
    }
    return { ...v, x: 1000, z: 1000, y: 330, yaw: 0, pitch: 0.5 };
  }
  if (v.dyn === "newsHeli") {
    let h;
    for (let i = 0; i < 60 && !h; i++) {
      h = await page.evaluate(() =>
        window.__ab.movers()?.aircraft.find((a) => a.kind === "newsHeli"),
      );
      if (!h) await sleep(500);
    }
    // 160 m off, a little below, looking at it; the camera trails the plane.
    return {
      ...v,
      x: h.x - 140,
      z: h.z + 50,
      y: h.y - 20,
      yaw: yawTo(140, -50),
      pitch: 0.12,
    };
  }
  await page.evaluate(() => window.__ab.forceDroneShow(30)); // the heart
  let s = null;
  for (let i = 0; i < 60 && !s; i++) {
    s = await page.evaluate(() => window.__ab.skyTraffic().droneShow);
    if (!s) await sleep(250);
  }
  return {
    ...v,
    x: s.x,
    z: s.z + 330,
    y: s.y - 40,
    yaw: yawTo(0, -330),
    pitch: 0.06,
  };
}
let browser;
try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
    } catch {}
    await sleep(250);
  }
  // AB_CHROME / AB_CHROME_ARGS: point the harness at another headless shell
  // (e.g. Linux CI with SwiftShader); the default is the M3 setup.
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
  // AB_GALLERY_RES: a software-GL box cannot draw 1.5x in time.
  await page.goto(
    `http://127.0.0.1:${PORT}/?res=${process.env.AB_GALLERY_RES ?? 1.5}&sky=night`,
  );
  await page.fill("#join-name", "SHOT");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => !!window.__ab, null, { timeout: 60000 });
  await page.evaluate(() => window.__ab.setBots(0));
  await sleep(1500);
  for (const view of VIEWS) {
    if (ONLY && !ONLY.includes(view.name)) continue;
    // L12: each view at its own time of night (deep night unless it says).
    await page.evaluate((s) => window.__ab.sky(s ?? "night"), view.sky);
    const v = view.dyn ? await place(page, view) : view;
    const pin = async () =>
      page.evaluate((v) => {
        if (v.train) {
          // Behind the last car, facing its heading (box yaw -> flight yaw is
          // a quarter turn: flight yaw 0 faces -Z).
          const now = window.__ab.train()?.time ?? 0;
          const cars = window.__ab.train(now + v.leadMs)?.cars ?? [];
          const tail = cars[cars.length - 1];
          if (tail) {
            const hx = Math.cos(tail.yaw);
            const hz = -Math.sin(tail.yaw);
            v.x = tail.x - hx * v.behind - hz * v.side;
            v.z = tail.z - hz * v.behind + hx * v.side;
            v.yaw = tail.yaw - Math.PI / 2 + v.dyaw;
          }
        }
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
    await page.screenshot({ path: `${OUT}/${v.name}.png`, timeout: 180000 });
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
} finally {
  server.kill();
  await browser?.close().catch(() => {});
}
