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
/** T2: a fixed eye/look-at framing of the trains at a pinned world time. */
async function placeTrain(page, v) {
  return page.evaluate((kind) => {
    const now = window.__ab.train()?.time ?? 0;
    const info = window.__ab.train(now);
    const line0 = info.lines[0];
    const centre = (l) => ({ x: l.ox + l.w / 2, z: l.oz + l.d / 2 });
    const wrap = (d) => d - Math.round(d / 2000) * 2000;
    // The side of (x, z) away from the line's middle: the outside of the loop.
    const outward = (l, x, z, nx, nz) => {
      const c = centre(l);
      return wrap(x - c.x) * nx + wrap(z - c.z) * nz >= 0 ? 1 : -1;
    };
    for (let s = 2; s < 240; s += 0.5) {
      const t = now + s * 1000;
      if (kind === "trainsPassing") {
        const m = window.__ab.trainMeeting(0, t);
        if (!m) break;
        const hx = Math.cos(m.yaw);
        const hz = -Math.sin(m.yaw);
        const side = outward(line0, m.x, m.z, hz, -hx);
        return {
          timeMs: m.timeMs - 250,
          trainEye: {
            x: m.x + side * hz * 15 - hx * 36,
            y: 44,
            z: m.z - side * hx * 15 - hz * 36,
          },
          trainAt: { x: m.x, y: 27.2, z: m.z },
        };
      }
      const trains = window.__ab.train(t).trains;
      for (const tr of trains) {
        const line = info.lines[tr.line];
        const hx = Math.cos(tr.yaw);
        const hz = -Math.sin(tr.yaw);
        if (kind === "trainStation" && tr.station >= 0 && tr.doors >= 1) {
          const st = line.stations[tr.station];
          const nx = st.uz;
          const nz = -st.ux;
          const side = tr.track === 0 ? 1 : -1;
          return {
            timeMs: t,
            trainEye: {
              x: st.x + side * nx * 13 - st.ux * 36,
              y: 31.5,
              z: st.z + side * nz * 13 - st.uz * 36,
            },
            trainAt: {
              x: st.x + side * nx * 3,
              y: 27.5,
              z: st.z + side * nz * 3,
            },
          };
        }
        if (kind === "trainCab" && tr.station >= 0 && tr.doors >= 1) {
          // Nose on to the lead car: the cab, its lamps and the LED sign.
          const lx = tr.x + hx * 17.5;
          const lz = tr.z + hz * 17.5;
          return {
            timeMs: t,
            trainEye: {
              x: lx + hx * 16 + hz * 3,
              y: 28.6,
              z: lz + hz * 16 - hx * 3,
            },
            trainAt: { x: lx, y: 27.6, z: lz },
          };
        }
        if (kind === "trainCurve" && tr.curve && tr.v > 12) {
          const side = outward(line, tr.x, tr.z, hz, -hx);
          return {
            timeMs: t,
            trainEye: {
              x: tr.x + side * hz * 42 - hx * 30,
              y: 46,
              z: tr.z - side * hx * 42 - hz * 30,
            },
            trainAt: { x: tr.x, y: 27, z: tr.z },
          };
        }
      }
    }
    return null;
  }, v.dyn);
}
/** H2: frame a hole from `__ab.holes()` (see the views above). */
async function placeHole(page, v) {
  const h = await page.evaluate(() => window.__ab.holes());
  const tunnels = h.spans.filter((s) => s.kind === "tunnel");
  const rows = tunnels.filter((s) => s.hosts > 1);
  const pick = (rows.length ? rows : tunnels).sort((a, b) => a.y0 - b.y0)[0];
  if (!pick) throw new Error("no tunnel in __ab.holes()");
  console.log("hole", v.name, JSON.stringify(pick), JSON.stringify(h.decor));
  const ax = pick.axis === "x" ? 1 : 0;
  const az = 1 - ax;
  const cy = pick.y0 + pick.height / 2;
  const e = pick.entry;
  const at = (d, y) => [e.x + ax * d, y, e.z + az * d];
  const eye = v.dyn === "holeApproach" ? at(-110, cy + 9) : at(6, cy + 2);
  const look = v.dyn === "holeApproach" ? at(0, cy - 2) : at(60, cy);
  return {
    ...v,
    // The plane hangs well above the run, nose along it, out of shot.
    x: e.x + ax * 40,
    z: e.z + az * 40,
    y: pick.y0 + pick.height + 120,
    yaw: ax ? -Math.PI / 2 : Math.PI,
    eye,
    at: look,
    weather: "clear",
  };
}
/** Resolve an L10 view against the live world. */
async function place(page, v) {
  if (v.dyn?.startsWith("hole")) return placeHole(page, v);
  if (v.dyn?.startsWith("train")) {
    const shot = await placeTrain(page, v);
    if (!shot) throw new Error(`no ${v.dyn} moment found`);
    return { ...v, ...shot };
  }
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
    // A1: a view (or AB_GALLERY_WEATHER, for paired before/after runs) may
    // pin the weather phase; otherwise the live weather stands.
    const wx = view.weather ?? process.env.AB_GALLERY_WEATHER;
    if (wx) await page.evaluate((w) => window.__ab.weather(w), wx);
    const v = view.dyn ? await place(page, view) : view;
    const pin = async () =>
      page.evaluate((v) => {
        if (v.trainEye) {
          // T2: the world held at the chosen moment, a fixed camera on it,
          // the plane parked high above (out of shot, out of the way).
          window.__ab.pinWorld(v.timeMs);
          window.__ab.weather("clear");
          window.__ab.qaCamera({ eye: v.trainEye, at: v.trainAt });
          window.__ab.teleport(v.trainEye.x, v.trainEye.z, 300, 0);
          return;
        }
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
        if (v.eye) {
          const [ex, ey, ez] = v.eye;
          const [ax, ay, az] = v.at;
          window.__ab.qaCamera({
            eye: { x: ex, y: ey, z: ez },
            at: { x: ax, y: ay, z: az },
          });
        }
      }, v);
    await pin();
    if (v.raf) {
      await page.evaluate((v) => {
        const hold = () => {
          if (!window.__abPin) return;
          window.__ab.teleport(v.x, v.z, v.y, v.yaw);
          if (v.pitch) window.__ab.state().pitch = v.pitch;
          requestAnimationFrame(hold);
        };
        window.__abPin = true;
        hold();
      }, v);
    }
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
    if (v.trainEye) {
      console.log(
        "train",
        v.name,
        JSON.stringify(
          await page.evaluate(() => {
            const d = window.__ab.train();
            return { people: d.people, lights: d.lights, time: d.time };
          }),
        ),
      );
      await page.evaluate(() => {
        window.__ab.weather(null);
        window.__ab.qaCamera(null);
        window.__ab.pinWorld(null);
      });
    }
    if (v.eye) await page.evaluate(() => window.__ab.qaCamera(null));
    if (v.raf) {
      await page.evaluate(() => {
        window.__abPin = false;
      });
    }
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
