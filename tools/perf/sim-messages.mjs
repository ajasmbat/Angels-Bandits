// G9: what the sim worker's messages cost the page's main thread — the
// attribution behind the 1-in-6 frame hitch (tools/perf/README.md, G9).
//
//     npm run build -w client
//     node tools/perf/sim-messages.mjs [--view canyon-supertalls] [--ms 6000]
//         [--port 8251] [--size 480x270] [--out trace.json] [--live]
//         [--quality low]
//
// Plays the solo game on the built client (SwiftShader-friendly: a small
// viewport, ratio 0.5 — the frames are short enough to show a hitch), holds
// a gallery view's camera on a pinned world, and records one Chrome trace
// (devtools.timeline, V8 GC and the CPU profiler) of `--ms`. Then it splits
// the main thread's time:
//
//   - per worker message (an EventDispatch of `message` on the page): how
//     many, how long each took (p50 / p95 / max) and the GC inside them;
//   - per rAF frame: the frames a message landed in against the frames it
//     did not (their median and p95 length — the hitch, if the messages are
//     its cause), and the two-clock spike rows of trace-spikes.mjs;
//   - the top JS functions sampled inside the messages.
//
// `--live` plays the default game (waves, the air force, the director)
// instead of the gallery's quiet city.
//
// AB_CHROME / AB_CHROME_ARGS as for gallery.mjs (default: Playwright's own
// Chromium with SwiftShader).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { VIEWS } from "./gallery-views.mjs";
import { withSim } from "./local-game.mjs";
import { analyseTrace, describe, mainThread } from "./trace-spikes.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const VIEW = opt("view", "canyon-supertalls");
const MS = Number(opt("ms", "6000"));
const PORT = Number(opt("port", "8251"));
const [W, H] = opt("size", "480x270").split("x").map(Number);
const OUT = opt("out", null);
/** `--quality low`: a cheaper tier, for shorter SwiftShader frames. */
const QUALITY = opt("quality", null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST_ENV = args.includes("--live")
  ? { LIVENESS_TIMEOUT_MS: "600000" }
  : { AB_WAVES: "0", AB_QUIET_CITY: "1", LIVENESS_TIMEOUT_MS: "600000" };
const view = VIEWS.find((v) => v.name === VIEW);
if (!view) throw new Error(`no gallery view ${VIEW}`);

const server = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), ...HOST_ENV },
  stdio: "ignore",
});
let browser = null;
const pct = (sorted, p) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
    : 0;
const r1 = (x) => Math.round(x * 10) / 10;
try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
    } catch {}
    await sleep(250);
  }
  browser = await chromium.launch({
    executablePath: process.env.AB_CHROME,
    args: process.env.AB_CHROME_ARGS
      ? process.env.AB_CHROME_ARGS.split(" ")
      : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
  await page.addInitScript(timeWorkerMessages);
  await page.goto(
    withSim(
      `http://127.0.0.1:${PORT}/?res=0.5&sky=night${QUALITY ? `&quality=${QUALITY}` : ""}`,
      HOST_ENV,
    ),
  );
  await page.fill("#join-name", "MSGS");
  await page.click('#join button[type="submit"]');
  await page.waitForFunction(() => !!window.__ab, null, { timeout: 60000 });
  await sleep(1500);
  await page.evaluate((v) => {
    window.__ab.sky("night");
    if (v.weather) window.__ab.weather(v.weather);
    if (v.timeMs !== undefined) window.__ab.pinWorld(v.timeMs);
    window.__ab.teleport(v.x, v.z, v.y, v.yaw);
    if (v.eye) {
      const [ex, ey, ez] = v.eye;
      const [ax, ay, az] = v.at;
      window.__ab.qaCamera({
        eye: { x: ex, y: ey, z: ez },
        at: { x: ax, y: ay, z: az },
      });
    }
  }, view);
  await sleep(4000);
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  cdp.on("Tracing.dataCollected", (e) => {
    for (const ev of e.value) events.push(ev);
  });
  const done = new Promise((ok) => cdp.once("Tracing.tracingComplete", ok));
  await cdp.send("Tracing.start", {
    categories: [
      "toplevel",
      "devtools.timeline",
      "v8",
      "disabled-by-default-v8.gc",
      "disabled-by-default-v8.cpu_profiler",
    ].join(","),
    transferMode: "ReportEvents",
  });
  const perf0 = await page.evaluate(() => {
    window.__ab.perfReset();
    window.__abSimMsg.reset();
    return true;
  });
  await sleep(MS);
  const stats = await page.evaluate(() => window.__ab.perfStats());
  const kinds = await page.evaluate(() => window.__abSimMsg.report());
  await cdp.send("Tracing.end");
  await done;
  void perf0;
  const key = mainThread(events);
  const main = events.filter((e) => `${e.pid}:${e.tid}` === key);
  if (OUT) {
    writeFileSync(
      resolve(OUT),
      `{"traceEvents":[\n${main
        .concat(events.filter((e) => e.name === "ProfileChunk"))
        .map((e) => JSON.stringify(e))
        .join(",\n")}\n]}\n`,
    );
  }
  const spans = main.filter((e) => e.ph === "X" && e.dur !== undefined);
  // Worker messages: each one a HandlePostMessage task on the page.
  const msgs = spans.filter((e) => e.name === "HandlePostMessage");
  const gcs = spans.filter(
    (e) =>
      e.name === "MinorGC" ||
      e.name === "MajorGC" ||
      e.name === "V8.GCScavenger" ||
      e.name === "V8.GCFinalizeMC",
  );
  const inside = (a, list) =>
    list
      .filter((g) => g.ts >= a.ts && g.ts < a.ts + a.dur)
      .reduce((s, g) => s + g.dur, 0) / 1000;
  const durs = msgs.map((m) => m.dur / 1000).sort((a, b) => a - b);
  const msgGc = msgs.reduce((s, m) => s + inside(m, gcs), 0);
  const frames = spans
    .filter((e) => e.name === "FireAnimationFrame")
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  const withMsg = [];
  const without = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const len = (b - a) / 1000;
    const hit = msgs.some((m) => m.ts >= a && m.ts < b);
    (hit ? withMsg : without).push(len);
  }
  withMsg.sort((x, y) => x - y);
  without.sort((x, y) => x - y);
  const span = (frames.at(-1) - frames[0]) / 1e6;
  console.log(
    `view ${VIEW} ${W}x${H}: ${frames.length} frames over ${r1(span)} s; perfStats p50 ${r1(stats.p50)} p95 ${r1(stats.p95)} p99 ${r1(stats.p99)} mean ${r1(stats.mean)}`,
  );
  console.log(
    `messages: ${msgs.length} (${r1(msgs.length / span)} /s), each p50 ${r1(pct(durs, 0.5))} p95 ${r1(pct(durs, 0.95))} max ${r1(durs.at(-1) ?? 0)} ms, ${r1(durs.reduce((s, d) => s + d, 0))} ms in all, GC inside ${r1(msgGc)} ms`,
  );
  console.log("by kind (page clock: count, ms each p50/p95/max, KB each):");
  for (const k of kinds) {
    console.log(
      `  ${k.kind.padEnd(14)} ${String(k.n).padStart(5)}  ${r1(k.p50)} / ${r1(k.p95)} / ${r1(k.max)} ms  ${r1(k.kb)} KB`,
    );
  }
  console.log(
    `frames with a message: ${withMsg.length}, p50 ${r1(pct(withMsg, 0.5))} p95 ${r1(pct(withMsg, 0.95))} ms; without: ${without.length}, p50 ${r1(pct(without, 0.5))} p95 ${r1(pct(without, 0.95))} ms`,
  );
  console.log(
    `GC on the main thread: ${r1(gcs.reduce((s, g) => s + g.dur, 0) / 1000)} ms in ${gcs.length} events`,
  );
  // The JS sampled inside the messages, by function.
  const samples = [];
  const nodes = new Map();
  let t = 0;
  for (const e of events) {
    if (e.name === "Profile" && `${e.pid}:${e.tid}` === key) {
      t = e.args?.data?.startTime ?? e.ts;
    }
  }
  for (const e of events) {
    if (e.name !== "ProfileChunk" || `${e.pid}` !== key.split(":")[0]) continue;
    const d = e.args?.data ?? {};
    for (const n of d.cpuProfile?.nodes ?? []) nodes.set(n.id, n.callFrame);
    const ids = d.cpuProfile?.samples ?? [];
    const deltas = d.timeDeltas ?? [];
    for (let i = 0; i < ids.length; i++) {
      t += deltas[i] ?? 0;
      samples.push([t, nodes.get(ids[i]) ?? {}]);
    }
  }
  const byFn = new Map();
  for (const [ts, cf] of samples) {
    if (!msgs.some((m) => ts >= m.ts && ts < m.ts + m.dur)) continue;
    const name = `${cf.functionName || "(anon)"} ${String(cf.url ?? "")
      .split("/")
      .pop()}:${(cf.lineNumber ?? -1) + 1}`;
    byFn.set(name, (byFn.get(name) ?? 0) + 1);
  }
  const top = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log("top samples inside messages:");
  for (const [fn, n] of top) console.log(`  ${n}\t${fn}`);
  console.log(describe("spikes", analyseTrace(events)));
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}

/** Init script: time every listener the page puts on a Worker's `message`,
 * by what the message is (a `poses`, a game frame by its JSON `type`, …). */
function timeWorkerMessages() {
  const rows = new Map();
  const kindOf = (data) => {
    if (!data || typeof data !== "object") return "?";
    if (data.t !== "frame") return data.t ?? "?";
    const u8 = new Uint8Array(data.data);
    const head = String.fromCharCode(...u8.subarray(0, 24));
    const m = /"type":"([a-zA-Z]+)"/.exec(head);
    return m ? m[1] : "frame";
  };
  const sizeOf = (data) =>
    data?.data?.byteLength ??
    (data?.data?.length ?? 0) * 4 + (data?.heaps?.length ?? 0) * 4;
  const add = Worker.prototype.addEventListener;
  Worker.prototype.addEventListener = function (type, fn, opts) {
    if (type !== "message") return add.call(this, type, fn, opts);
    const timed = (ev) => {
      const kind = kindOf(ev.data);
      const bytes = sizeOf(ev.data);
      const t0 = performance.now();
      fn.call(this, ev);
      const ms = performance.now() - t0;
      let r = rows.get(kind);
      if (!r) {
        r = { n: 0, ms: [], bytes: 0 };
        rows.set(kind, r);
      }
      r.n++;
      r.ms.push(ms);
      r.bytes += bytes;
    };
    return add.call(this, type, timed, opts);
  };
  window.__abSimMsg = {
    report: () =>
      [...rows]
        .map(([kind, r]) => {
          const s = r.ms.slice().sort((a, b) => a - b);
          return {
            kind,
            n: r.n,
            p50: s[Math.floor(s.length / 2)] ?? 0,
            p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0,
            max: s.at(-1) ?? 0,
            kb: r.bytes / Math.max(1, r.n) / 1024,
          };
        })
        .sort((a, b) => b.n * b.p50 - a.n * a.p50),
    reset: () => rows.clear(),
  };
}
