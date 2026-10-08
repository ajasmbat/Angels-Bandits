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
import { VIEWS } from "./gallery-views.mjs";
const OUT = resolve(process.argv[2] ?? "gallery");
const PORT = Number(process.argv[3] ?? 8099);
const ONLY = process.argv[4] ? process.argv[4].split(",") : null;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});
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
    // The plane hangs beyond the intersection over the OPPOSITE lane and
    // looks back down the street, so the queue faces the camera — headlights,
    // cones and pools — without the plane hiding it. Forward is −Z at yaw 0
    // for planes and cars alike.
    const fx = -Math.sin(q.yaw);
    const fz = -Math.cos(q.yaw);
    const alongZ = Math.abs(fz) > 0.5;
    const cross = alongZ ? q.x : q.z;
    const mirror = 2 * Math.round(cross / 200) * 200 - cross;
    const view = {
      x: (alongZ ? mirror : q.x) + fx * 45,
      z: (alongZ ? q.z : mirror) + fz * 45,
      y: 40,
      yaw: q.yaw + Math.PI,
      pitch: -0.45,
    };
    // Pin the plane every frame IN the page (no round trip per pin): on a
    // slow GPU each page.evaluate waits on a frame, and the queue would drive
    // out of shot before a round-trip hold finished.
    await page.evaluate((v) => {
      const pin = () => {
        if (!window.__abPin) return;
        window.__ab.teleport(v.x, v.z, v.y, v.yaw);
        window.__ab.state().pitch = v.pitch;
        requestAnimationFrame(pin);
      };
      window.__abPin = true;
      pin();
    }, view);
    await sleep(1500);
    if (wantRed) {
      await page.screenshot({ path: `${OUT}/intersection-red.png` });
      console.log(
        "shot intersection-red",
        JSON.stringify(q),
        JSON.stringify(await page.evaluate(() => window.__ab.perf())),
      );
    }
    if (wantGreen) {
      // Shoot as the light turns: by the time the frame is captured the
      // start-up wave is rolling (a slow GPU adds whole seconds here).
      await page.waitForFunction(
        (q) => window.__ab.trafficAspect(q.bx, q.bz)[q.axis] === "green",
        q,
        { polling: "raf", timeout: 60000 },
      );
      const greenAt = await page.evaluate(() => window.__ab.traffic().time);
      const wait = Number(process.env.AB_GREEN_WAIT_MS ?? 1500);
      if (wait > 0) {
        await page.waitForFunction(
          ([at, ms]) => window.__ab.traffic().time >= at + ms,
          [greenAt, wait],
          { polling: "raf", timeout: 30000 },
        );
      }
      await page.screenshot({ path: `${OUT}/intersection-green.png` });
      const late = await page.evaluate(
        (at) => window.__ab.traffic().time - at,
        greenAt,
      );
      console.log(
        "shot intersection-green",
        `${(late / 1000).toFixed(1)} s into green`,
        JSON.stringify(await page.evaluate(() => window.__ab.perf())),
      );
    }
    await page.evaluate(() => {
      window.__abPin = false;
    });
  }
} finally {
  server.kill();
  await browser?.close().catch(() => {});
}
