#!/usr/bin/env node
// X1 chaos audit: twelve scripted flights through the LIVE war (the nine
// the ticket names, then the deck and the view straight up and down), each
// read by the chaos meter (`__ab.chaosMeter`, client/src/game/chaos-meter.ts) —
// what the pilot could see or hear, second by second, and the longest run
// of seconds with nothing happening (the dead time).
//
//     npm run build -w client && node tools/perf/chaos-flights.mjs \
//       --out <dir> [--label after] [--only spawn,high-cruise] [--seconds 25]
//
// The server is the real one with its defaults — the carrier war's waves
// and the air force, the director, C1's low chaos, C2's meteors and comets,
// the rooftop AA — so the meter reads the game a player gets at the default
// level, not a staged scene. Only the plane is scripted: every frame the
// page re-teleports it along its flight (the perf harness's glide, run.mjs),
// at a speed of WALL time, so a 3 fps software rasteriser flies the same
// path as a GPU. A death is part of the war: the driver waits out the
// kill-cam and carries on from where the flight has got to, and the table
// counts it.
//
// Like gallery.mjs it runs anywhere: AB_CHROME / AB_CHROME_ARGS point it at
// another headless shell; the default args are SwiftShader's. The meter
// counts what is in the view frustum and in range — it does not depend on
// the frame rate, only on what the war put where.
//
// Exit 1 when any flight's longest dead run is over CHAOS_DEAD_MAX_S (3 s),
// or the page logged an error.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const OUT = resolve(opt("out", "chaos-flights-out"));
const LABEL = opt("label", "run");
const ONLY = opt("only", null)?.split(",") ?? null;
const SECONDS = Number(opt("seconds", "25"));
/** --repo: serve another checkout's built client (the BEFORE arm). */
const SERVE_REPO = resolve(opt("repo", REPO));
mkdirSync(OUT, { recursive: true });

/** The audit's target (chaos-meter.ts CHAOS_DEAD_MAX_S). */
const DEAD_MAX_S = 3;

const CHROME_ARGS = process.env.AB_CHROME_ARGS
  ? process.env.AB_CHROME_ARGS.split(" ")
  : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
CHROME_ARGS.push(
  "--autoplay-policy=no-user-gesture-required",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
);

/** yaw 0 faces −Z (common/src/flight.ts) — a heading toward (dx, dz). */
const yawToward = (dx, dz) => Math.atan2(-dx, -dz);

/**
 * The flights. Every path keeps clear of the city by one of the perf
 * harness's rules (segments.mjs): along a street centreline (x on a 200 m
 * block boundary, yaw 0), over the dilated roofline (`__ab.roofline`) plus
 * a margin, or down a tunnel's own axis.
 */
export const FLIGHTS = [
  {
    name: "spawn",
    what: "the first seconds after FLY: spawn protection, flown hands-off",
    kind: "free",
  },
  {
    name: "high-cruise",
    what: "level at 420 m, just under the deck, down the x = 1000 avenue",
    kind: "glide",
    x: 1000,
    z: 1900,
    y: 420,
    yaw: 0,
    speed: 80,
  },
  {
    name: "rooftop-skim",
    what: "18 m over the roofline on a diagonal across midtown",
    kind: "glide",
    x: 300,
    z: 1700,
    y: 0,
    yaw: yawToward(1, -1),
    speed: 70,
    roof: 18,
  },
  {
    name: "street-canyon",
    what: "45 m up the x = 200 street, between the towers",
    kind: "glide",
    x: 200,
    z: 1900,
    y: 45,
    yaw: 0,
    speed: 60,
  },
  {
    name: "tunnel-exit",
    what: "Crosstown's last 450 m, out of the east portal and climbing, then held",
    kind: "tunnel",
    id: 0,
    s: -450,
    speed: 40,
    maxM: 510,
    climb: 40,
  },
  {
    name: "chase",
    what: "140 m behind the nearest enemy plane, guns hot",
    kind: "chase",
    x: 1000,
    z: 1000,
    y: 260,
    yaw: 0,
  },
  {
    name: "airship-attack",
    what: "closing on the nearest airship from 450 m to 220 m, guns hot",
    kind: "airship",
    x: 1000,
    z: 1000,
    y: 260,
    yaw: 0,
  },
  {
    name: "death-respawn",
    what: "a crash, the kill-cam, the respawn and its first seconds",
    kind: "crash",
  },
  {
    name: "quiet-hover",
    what: "held still 40 m over the city's lowest district (roofs ≤ 100 m), nose level",
    kind: "hold",
    x: 1450,
    z: 850,
    y: 0,
    roof: 40,
    yaw: yawToward(1, 1),
  },
  // The holes the ticket names that the nine above never point at: the
  // cloud deck (the dome and the painted sky are off inside it) and the
  // view straight up or straight down.
  {
    name: "in-the-deck",
    what: "level at 462 m inside the cloud deck, down the x = 1000 avenue",
    kind: "glide",
    x: 1000,
    z: 1900,
    y: 462,
    yaw: 0,
    speed: 80,
  },
  {
    name: "look-up",
    what: "held at 300 m over the x = 1000 avenue, nose 70° up",
    kind: "hold",
    x: 1000,
    z: 1000,
    y: 300,
    yaw: 0,
    pitch: 1.22,
  },
  {
    name: "look-down",
    what: "held at 300 m over the x = 1000 avenue, nose 70° down",
    kind: "hold",
    x: 1000,
    z: 1000,
    y: 300,
    yaw: 0,
    pitch: -1.22,
  },
];

/** The in-page driver: re-teleports the plane every frame along `spec`. */
const DRIVER = (spec) => {
  const ab = window.__ab;
  const W = 2000;
  const wrap = (d) => d - Math.round(d / W) * W;
  const fwd = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
  const roofAhead = (x, z, yaw, look) => {
    const f = fwd(yaw);
    let m = 0;
    for (let s = -20; s <= look; s += 10) {
      m = Math.max(m, ab.roofline(x + f.x * s, z + f.z * s));
    }
    return m;
  };
  const st = {
    spec,
    t0: performance.now(),
    last: performance.now(),
    stop: false,
    deaths: 0,
    alive: true,
    y: null,
    held: null,
    firing: false,
  };
  window.__cf = st;
  const fire = (on) => {
    if (on !== st.firing) ab.setFiring(on);
    st.firing = on;
  };
  if (spec.kind === "crash") {
    const p = ab.state().pos;
    ab.teleport(p.x, p.z, 1);
  } else if (spec.x !== undefined) {
    const y = spec.roof
      ? roofAhead(spec.x, spec.z, spec.yaw, 120) + spec.roof
      : spec.y;
    ab.teleport(spec.x, spec.z, y, spec.yaw);
    st.y = y;
  }
  const tick = () => {
    if (st.stop) {
      fire(false);
      return;
    }
    const now = performance.now();
    const dt = Math.min(0.5, (now - st.last) / 1000);
    st.last = now;
    const c = ab.combat();
    if (!c.alive) {
      if (st.alive) st.deaths++;
      st.alive = false;
      fire(false);
      requestAnimationFrame(tick);
      return;
    }
    st.alive = true;
    const me = ab.state().pos;
    const s = (now - st.t0) / 1000;
    if (spec.kind === "glide") {
      const d = spec.speed * s;
      const f = fwd(spec.yaw);
      const x = spec.x + f.x * d;
      const z = spec.z + f.z * d;
      let y = spec.y;
      if (spec.roof) {
        const want = roofAhead(x, z, spec.yaw, 140) + spec.roof;
        // Up at once, down at 12 m/s: a skim, never a dive into a street.
        y = Math.max(want, (st.y ?? want) - 12 * dt);
      }
      st.y = y;
      ab.teleport(x, z, y, spec.yaw);
    } else if (spec.kind === "tunnel") {
      const d = Math.min(spec.maxM, spec.speed * s);
      const p = ab.tunnelPose(spec.id, spec.s, d, spec.climb);
      ab.teleport(p.x, p.z, p.y, p.yaw);
    } else if (spec.kind === "hold") {
      ab.teleport(spec.x, spec.z, st.y, spec.yaw);
      if (spec.pitch) {
        // The chase camera levels with the plane: the QA eye holds the
        // look instead (the meter reads the render camera, either way).
        const f = fwd(spec.yaw);
        const c = Math.cos(spec.pitch);
        ab.qaCamera({
          eye: { x: spec.x, y: st.y, z: spec.z },
          at: {
            x: spec.x + f.x * c * 100,
            y: st.y + Math.sin(spec.pitch) * 100,
            z: spec.z + f.z * c * 100,
          },
        });
      }
    } else if (spec.kind === "chase" || spec.kind === "airship") {
      let best = null;
      let bd = Number.POSITIVE_INFINITY;
      const cands =
        spec.kind === "chase"
          ? c.targets.filter((t) => t.id.startsWith("bot:"))
          : ab
              .fleet()
              .ships.filter((sh) => sh.present && !sh.falling)
              .map((sh) => ({ id: sh.id, pos: sh.pos }));
      for (const t of cands) {
        const dx = wrap(t.pos.x - me.x);
        const dz = wrap(t.pos.z - me.z);
        const d = Math.hypot(dx, t.pos.y - me.y, dz);
        if (d < bd) {
          bd = d;
          best = { t, dx, dz };
        }
      }
      if (best) {
        const h = Math.hypot(best.dx, best.dz) || 1;
        const ux = best.dx / h;
        const uz = best.dz / h;
        const r =
          spec.kind === "chase" ? 140 : 450 - (230 * Math.min(s, 20)) / 20;
        const x = best.t.pos.x - ux * r;
        const z = best.t.pos.z - uz * r;
        const yaw = Math.atan2(-ux, -uz);
        const lift = spec.kind === "airship" ? 30 : 0;
        const y = Math.max(best.t.pos.y + lift, roofAhead(x, z, yaw, 60) + 25);
        ab.teleport(x, z, y, yaw);
        fire(bd < 700);
      } else {
        // Nobody near yet: cruise on over the roofs and look for one.
        const yaw = ab.state().yaw;
        const f = fwd(yaw);
        const x = me.x + f.x * 70 * dt;
        const z = me.z + f.z * 70 * dt;
        ab.teleport(x, z, Math.max(me.y, roofAhead(x, z, yaw, 140) + 30), yaw);
        fire(false);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  ab.chaosMeter("reset");
  return true;
};

/** Stop the driver and read the meter. */
const READ = () => {
  const st = window.__cf;
  if (st) st.stop = true;
  if (st?.spec.pitch) window.__ab.qaCamera(null);
  const m = window.__ab.chaosMeter();
  return {
    deaths: st?.deaths ?? 0,
    meter: m.sinceReset,
    perf: window.__ab.perf(),
  };
};

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

let liveServer = null;
let liveBrowser = null;
async function killEverything() {
  if (liveServer) liveServer.kill();
  liveServer = null;
  if (liveBrowser) await liveBrowser.close().catch(() => {});
  liveBrowser = null;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void killEverything().then(() => process.exit(130));
  });
}

async function startServer(port) {
  const log = [];
  const proc = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
    cwd: SERVE_REPO,
    env: {
      ...process.env,
      PORT: String(port),
      // A software-rendered frame can take seconds: the production 4 s
      // liveness bound would drop the page and resume it mid-flight.
      LIVENESS_TIMEOUT_MS: "600000",
      BOOT_TIMEOUT_MS: "300000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveServer = proc;
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 240; i++) {
    if (proc.exitCode !== null)
      throw new Error(`server died:\n${log.join("")}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) {
        const page = await fetch(`http://127.0.0.1:${port}/`);
        if (!page.ok)
          throw new Error("no client/dist — run `npm run build -w client`");
        return { proc, log };
      }
    } catch (err) {
      if (String(err).includes("client/dist")) throw err;
    }
    await sleep(250);
  }
  throw new Error(`server never answered:\n${log.join("")}`);
}

/** One table row's cells from a flight's meter span. */
function row(name, r) {
  const k = r.meter.kinds;
  const s = (kind) => k[kind].seconds;
  const pk = (kind) => k[kind].peak;
  return {
    flight: name,
    seconds: r.meter.seconds,
    dead: r.meter.deadSeconds,
    longestDead: r.meter.longestDead,
    nearDead: r.meter.nearDeadSeconds,
    longestNearDead: r.meter.longestNearDead,
    explosions: s("explosions"),
    collapses: s("collapses"),
    tracers: s("tracers"),
    planes: `${pk("planesReal")} / ${pk("planesCosmetic")}`,
    airships: `${pk("airshipsReal")} / ${pk("airshipsCosmetic")}`,
    sky: `${s("planesCosmetic")} / ${s("skyTracers")} / ${s("skyFlak")}`,
    skyKills: s("skyKills"),
    fires: pk("fires"),
    debris: s("debris"),
    flak: s("flak"),
    strikes: s("strikes"),
    radio: k.radio.total,
    headlines: k.headlines.total,
    deaths: r.deaths,
    unsampled: r.meter.unsampled,
    fps: Number(r.perf.fps.toFixed(1)),
    audioPeak: r.audio.postDb === null ? "n/a" : r.audio.postDb.toFixed(1),
    limiter:
      r.audio.reductionDb === null ? "n/a" : r.audio.reductionDb.toFixed(1),
  };
}

const HEAD = [
  ["flight", "flight"],
  ["seconds", "s"],
  ["dead", "dead s"],
  ["longestDead", "longest dead"],
  ["nearDead", "near-dead s"],
  ["longestNearDead", "longest near-dead"],
  ["explosions", "explosions (s)"],
  ["collapses", "collapses (s)"],
  ["tracers", "tracers (s)"],
  ["planes", "planes peak (real / cosmetic)"],
  ["airships", "airships peak (real / cosmetic)"],
  ["sky", "painted sky: planes / tracers / flak (s)"],
  ["skyKills", "sky kills (s)"],
  ["fires", "fires peak"],
  ["debris", "falling debris (s)"],
  ["flak", "flak (s)"],
  ["strikes", "strikes (s)"],
  ["radio", "radio calls"],
  ["headlines", "headlines"],
  ["deaths", "deaths"],
  ["audioPeak", "audio peak post-limiter (dBFS)"],
  ["limiter", "limiter max reduction (dB)"],
];

function markdown(rows) {
  const lines = [
    `| ${HEAD.map(([, h]) => h).join(" | ")} |`,
    `| ${HEAD.map(([k]) => (k === "flight" ? "---" : "---:")).join(" | ")} |`,
  ];
  for (const r of rows) {
    lines.push(`| ${HEAD.map(([k]) => String(r[k])).join(" | ")} |`);
  }
  return lines.join("\n");
}

async function main() {
  const flights = ONLY ? FLIGHTS.filter((f) => ONLY.includes(f.name)) : FLIGHTS;
  const port = await freePort();
  await startServer(port);
  liveBrowser = await chromium.launch({
    args: CHROME_ARGS,
    ...(process.env.AB_CHROME ? { executablePath: process.env.AB_CHROME } : {}),
  });
  const context = await liveBrowser.newContext({
    viewport: { width: 640, height: 360 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });
  await page.waitForSelector("#join.open #join-name:not([disabled])", {
    timeout: 300000,
  });
  await page.fill("#join-name", "CHAOS");
  await page.press("#join-name", "Enter");
  await page.waitForFunction(
    () =>
      document.getElementById("join")?.classList.contains("open") === false &&
      window.__ab?.combat().alive === true &&
      window.__ab.renderMs() !== null,
    null,
    { timeout: 300000, polling: 250 },
  );
  if (
    !(await page.evaluate(() => typeof window.__ab.chaosMeter === "function"))
  ) {
    throw new Error("this build has no __ab.chaosMeter");
  }
  const results = [];
  for (const f of flights) {
    // Each flight starts alive: wait out a respawn the last one left.
    await page.waitForFunction(
      () => window.__ab.combat().alive === true,
      null,
      {
        timeout: 120000,
        polling: 250,
      },
    );
    await page.evaluate(DRIVER, f);
    // The mix, once a second: the loudest peak out of the limiter (0 dBFS
    // is clipping) and the hardest it had to squash.
    const audio = { postDb: null, preDb: null, reductionDb: null };
    const until = Date.now() + SECONDS * 1000;
    while (Date.now() < until) {
      await sleep(1000);
      const a = await page.evaluate(() => window.__ab.qaUi().audio);
      if (!a || a.state !== "running") continue;
      const max = (x, y) => (x === null ? y : Math.max(x, y));
      if (Number.isFinite(a.postDb)) audio.postDb = max(audio.postDb, a.postDb);
      if (Number.isFinite(a.preDb)) audio.preDb = max(audio.preDb, a.preDb);
      audio.reductionDb =
        audio.reductionDb === null
          ? a.reductionDb
          : Math.min(audio.reductionDb, a.reductionDb);
    }
    const r = { ...(await page.evaluate(READ)), audio };
    // Let the driver's last frame see `stop`.
    await sleep(300);
    const cells = row(f.name, r);
    results.push({
      ...f,
      ...cells,
      kinds: r.meter.kinds,
      deadAt: r.meter.deadAt ?? null,
      nearDeadAt: r.meter.nearDeadAt ?? null,
      audio,
    });
    console.log(
      `${f.name.padEnd(15)} ${String(cells.seconds).padStart(3)} s  dead ${String(cells.dead).padStart(2)}  longest ${cells.longestDead}  near-dead ${String(cells.nearDead).padStart(2)}  longest ${cells.longestNearDead}  deaths ${cells.deaths}  fps ${cells.fps}  peak ${cells.audioPeak} dBFS`,
    );
  }
  await killEverything();
  const rows = results.map((r) =>
    Object.fromEntries(HEAD.map(([k]) => [k, r[k]])),
  );
  const md = markdown(rows);
  console.log(`\n${md}\n`);
  const failing = results.filter((r) => r.longestDead > DEAD_MAX_S);
  writeFileSync(
    resolve(OUT, `chaos-flights-${LABEL}.json`),
    JSON.stringify(
      {
        label: LABEL,
        seconds: SECONDS,
        deadMaxS: DEAD_MAX_S,
        flights: results,
        errors,
      },
      null,
      2,
    ),
  );
  writeFileSync(resolve(OUT, `chaos-flights-${LABEL}.md`), `${md}\n`);
  if (errors.length > 0) {
    console.log(`console errors (${errors.length}):`);
    for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
  }
  if (failing.length > 0) {
    console.log(
      `FAIL: longest dead run over ${DEAD_MAX_S} s in ${failing.map((r) => `${r.name} (${r.longestDead} s)`).join(", ")}`,
    );
  }
  const ok = failing.length === 0 && errors.length === 0;
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await killEverything();
  process.exit(2);
});
