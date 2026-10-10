// VO gallery: fixed viewpoints -> PNGs, for before/after visual review.
//   npm run build -w client && node tools/perf/gallery.mjs <outDir> [port] [view,view]
// Uses the cached chromium headless shell on Metal (see tools/perf/README.md;
// AB_CHROME / AB_CHROME_ARGS point it elsewhere, e.g. SwiftShader on Linux;
// AB_GALLERY_QUALITY pins a quality tier; AB_GALLERY_QUERY appends raw query
// params, e.g. `refl=0` for S6's before shots out of the same build).
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
  // AB_GALLERY_QUALITY: pin a tier (on a slow box Auto steps down mid-run,
  // so a before/after pair would compare two tiers).
  const quality = process.env.AB_GALLERY_QUALITY
    ? `&quality=${process.env.AB_GALLERY_QUALITY}`
    : "";
  const extra = process.env.AB_GALLERY_QUERY
    ? `&${process.env.AB_GALLERY_QUERY}`
    : "";
  await page.goto(
    `http://127.0.0.1:${PORT}/?res=${process.env.AB_GALLERY_RES ?? 1.5}&sky=night${quality}${extra}`,
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
        // U5: a static view may hold the world clock at a chosen moment.
        if (v.timeMs !== undefined) window.__ab.pinWorld(v.timeMs);
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
    // U6: stage the cave-in `ago` ms into its life at the view's pinned
    // world time — and again after every pin below: idempotent (it replaces
    // what it staged), and a software-GL frame of seconds can trip the
    // socket watchdog, whose resume replays the room's (empty) cave-ins.
    const stageCaveIn = () =>
      page.evaluate(
        (v) =>
          window.__ab.qaCaveIn([
            {
              tunnel: v.caveIn.tunnel,
              s: v.caveIn.s,
              gap: v.caveIn.gap,
              t0: v.timeMs - v.caveIn.ago,
            },
          ]),
        v,
      );
    if (v.caveIn) {
      console.log("caveIn", v.name, JSON.stringify(await stageCaveIn()));
    }
    if (v.boss) {
      // S9: stage the carrier at the pinned instant (see gallery-views.mjs).
      const r = await page.evaluate((v) => {
        window.__ab.qaBoss({
          x: v.x,
          y: v.y,
          z: v.z,
          yaw: v.yaw,
          ahead: v.boss.ahead,
          worldMs: v.timeMs,
          crossMs: 0,
          corridor: { near: 60, far: 160, lateral: 30, yLo: 250, yHi: 330 },
        });
        if (v.boss.launch) {
          window.__ab.qaBossLaunch(v.boss.launch.kind, v.boss.launch.phaseMs);
        }
        if (v.boss.downAfterMs !== undefined) {
          window.__ab.qaBossDown(v.boss.downAfterMs);
        }
        return window.__ab.boss();
      }, v);
      console.log("boss", v.name, JSON.stringify(r?.drawn ?? null));
    }
    if (v.chew) {
      // D2: break the building once, before the frames settle.
      const r = await page.evaluate((c) => {
        const [ex, ey, ez] = c.eye;
        const [ax, ay, az] = c.at;
        return window.__ab.chew(
          { x: ex, y: ey, z: ez },
          { x: ax, y: ay, z: az },
          c.rounds,
          c.spread,
        );
      }, v.chew);
      console.log("chew", v.name, JSON.stringify(r));
    }
    if (v.stage) {
      // D8: stage the destruction once (times relative to the render clock).
      const r = await page.evaluate((st) => {
        // Every hide lands in the next frame or two, not over minutes.
        window.__ab.standingBudget?.(1e9);
        const t0 = window.__ab.reactions().renderTime ?? 0;
        const at = (o) => ({ ...o, t: t0 + o.t });
        // D9: props, craters and burning floors — every `t` in them too.
        const atAll = (o) =>
          JSON.parse(JSON.stringify(o), (k, v) =>
            k === "t" && typeof v === "number" ? t0 + v : v,
          );
        return window.__ab.qaDestruction({
          ...(st.area ? { area: at(st.area) } : {}),
          ...(st.fell ? { fell: st.fell.map(at) } : {}),
          ...(st.props ? { props: atAll(st.props) } : {}),
          ...(st.blasts ? { blasts: st.blasts.map(at) } : {}),
        });
      }, v.stage);
      console.log("stage", v.name, JSON.stringify(r));
      // A software rasteriser draws ~1 fps: let a few frames take it in,
      // and (D8) every layer re-seat the staged buildings — the standing
      // work is budgeted per FRAME, so at 1 fps it drains over seconds.
      await page.evaluate(
        () =>
          new Promise((done) => {
            let n = 0;
            const t0 = performance.now();
            const tick = () =>
              ++n >= 4 &&
              ((window.__ab.standingPending?.() ?? 0) === 0 ||
                performance.now() - t0 > 60_000)
                ? done()
                : requestAnimationFrame(tick);
            requestAnimationFrame(tick);
          }),
      );
    }
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
      if (v.caveIn) await stageCaveIn();
      // D9: keep a glass curtain wall's cascade in the air (a software
      // frame is ~1 s: one burst would be gone by the shot).
      if (v.glass !== undefined) {
        await page.evaluate((b) => window.__ab.qaGlass?.(b), v.glass);
      }
      await sleep(90);
    }
    if (v.stage?.props) {
      console.log("props", v.name, JSON.stringify(await page.evaluate(() => window.__ab.props?.())));
    }
    // S6: rebuild the reflection probe at this exact pose and let two frames
    // draw with it, so no shot catches the glass mid-crossfade (a build
    // without the hook just skips it).
    await page.evaluate(() => window.__ab.reflections?.({ refill: true }));
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
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
    if (v.caveIn) {
      console.log(
        "caveIns",
        v.name,
        JSON.stringify(await page.evaluate(() => window.__ab.caveIns())),
      );
      await page.evaluate(() => window.__ab.qaCaveIn(null));
    }
    if (v.eye) await page.evaluate(() => window.__ab.qaCamera(null));
    if (v.boss) await page.evaluate(() => window.__ab.qaBoss(null));
    if (v.stage) {
      await page.evaluate(() => {
        window.__ab.qaDestruction(null);
        window.__ab.standingBudget?.(null);
      });
    }
    if (v.timeMs !== undefined && !v.trainEye) {
      await page.evaluate(() => window.__ab.pinWorld(null));
    }
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
