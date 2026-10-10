// A1: the server tick and the wire under load — no browser, no GPU.
//
//     node tools/perf/server-tick.mjs [--humans 8] [--bots 4] [--warmup 20]
//                                     [--seconds 60] [--calm] [--out f.json]
//                                     [--cpu-prof <dir>]
//
// Boots the real server (AB_TICK_STATS=1, and every chaos layer on its FAST
// schedule unless --calm: boss raid, missiles, director, meteors, quakes,
// fires, cave-ins), joins `--humans` plain ws pilots that stream poses at
// TICK_UP_HZ and fire in bursts (pilots.mjs's weave, spread over the city),
// asks for `--bots` bots, and after a warm-up reports:
//
//  - the tick: p50 / p95 / p99 / max ms, and each phase's p50 / p99 / mean
//    (server/src/tickstats.ts, read from `GET /debug/tick`);
//  - the wire, as ONE client receives it: bytes per second by message type,
//    and the snapshot's bytes per tick (p50 / max) and per entry.
//
// `--cpu-prof <dir>` writes the server's V8 CPU profile there (open it in
// Chrome DevTools' Performance panel) — the way to find what a phase spends.
//
// Bots never count against a seat but the room holds ROOM_CAP (12) planes in
// all, so `--humans 8` gets at most 4 bots. The numbers are wall-clock on
// whatever machine runs this: compare runs from the same session only, and
// print `loadavg` beside them (the report does).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { pilotPose } from "./pilots.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POSE_HZ = 30;

function parseArgs(argv) {
  const opts = {
    humans: 8,
    bots: 4,
    warmup: 20,
    seconds: 60,
    calm: false,
    out: null,
    cpuProf: null,
    cwd: REPO,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--humans") opts.humans = Number(next());
    else if (a === "--bots") opts.bots = Number(next());
    else if (a === "--warmup") opts.warmup = Number(next());
    else if (a === "--seconds") opts.seconds = Number(next());
    else if (a === "--calm") opts.calm = true;
    else if (a === "--out") opts.out = next();
    else if (a === "--cwd") opts.cwd = resolve(next());
    else if (a === "--cpu-prof") opts.cpuProf = resolve(next());
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function startServer(port, opts) {
  const log = [];
  const fast = opts.calm
    ? {}
    : {
        AB_BOSS_FAST: "1",
        AB_MISSILE_FAST: "1",
        AB_DIRECTOR_FAST: "1",
        AB_CHAOS_FAST: "1",
      };
  const prof = opts.cpuProf
    ? [
        "--cpu-prof",
        `--cpu-prof-dir=${opts.cpuProf}`,
        "--import",
        resolve(REPO, "tools/perf/exit-on-term.mjs"),
      ]
    : [];
  const args = [...prof, "--import", "tsx", "server/src/index.ts"];
  const proc = spawn("node", args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...fast,
      PORT: String(port),
      AB_TICK_STATS: "1",
      LIVENESS_TIMEOUT_MS: "30000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => log.push(String(d)));
  proc.stderr.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null)
      throw new Error(`server died:\n${log.join("")}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error(`server never came up:\n${log.join("")}`);
}

/** One pilot: joins, then streams its weave and fires in bursts. Pilot 0
 * also counts every byte it receives, by message type. */
function joinPilot(port, i, wire) {
  return new Promise((resolveJoin, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(
      () => reject(new Error(`pilot ${i} never got a welcome`)),
      30_000,
    );
    ws.on("error", reject);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "join", name: `TICK${i}` })),
    );
    ws.on("message", (data) => {
      const text = String(data);
      // Cheap type sniff: every server message starts {"type":"…".
      const type = /^\{"type":"([^"]+)"/.exec(text)?.[1] ?? "?";
      if (type === "welcome") {
        clearTimeout(timer);
        resolveJoin(ws);
      }
      if (!wire || !wire.counting) return;
      wire.bytes[type] = (wire.bytes[type] ?? 0) + data.length;
      wire.count[type] = (wire.count[type] ?? 0) + 1;
      if (type === "snapshot") {
        const n = JSON.parse(text).p.length;
        wire.snapshots.push({ bytes: data.length, entries: n });
      }
    });
  });
}

const pct = (sorted, q) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const port = await freePort();
  const proc = await startServer(port, opts);
  const wire = { counting: false, bytes: {}, count: {}, snapshots: [] };
  const sockets = [];
  try {
    for (let i = 0; i < opts.humans; i++) {
      sockets.push(await joinPilot(port, i, i === 0 ? wire : null));
    }
    // Spread the pilots over the city: each weaves down its own street.
    const centers = sockets.map((_, i) => ({
      x: 200 + (i % 4) * 400,
      y: 0,
      z: 600 + Math.floor(i / 4) * 800,
    }));
    const t0 = performance.now();
    let seq = 0;
    const poseTimer = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      sockets.forEach((ws, i) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(
          JSON.stringify({ type: "pose", pose: pilotPose(i, t, centers[i]) }),
        );
      });
    }, 1000 / POSE_HZ);
    const fireTimer = setInterval(() => {
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "fire", seq: ++seq }));
        }
      }
    }, 250);
    sockets[0].send(JSON.stringify({ type: "setBots", count: opts.bots }));

    await sleep(opts.warmup * 1000);
    await fetch(`http://127.0.0.1:${port}/debug/tick?reset=1`);
    wire.counting = true;
    await sleep(opts.seconds * 1000);
    wire.counting = false;
    const tick = await (
      await fetch(`http://127.0.0.1:${port}/debug/tick`)
    ).json();
    clearInterval(poseTimer);
    clearInterval(fireTimer);

    const snapBytes = wire.snapshots.map((s) => s.bytes).sort((a, b) => a - b);
    const entries = wire.snapshots.reduce((a, s) => a + s.entries, 0);
    const totalSnap = snapBytes.reduce((a, b) => a + b, 0);
    const perSecond = Object.fromEntries(
      Object.entries(wire.bytes)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, Math.round(v / opts.seconds)]),
    );
    const report = {
      humans: opts.humans,
      bots: opts.bots,
      chaos: opts.calm ? "calm" : "fast",
      seconds: opts.seconds,
      loadavg: loadavg().map((n) => Math.round(n * 10) / 10),
      tick,
      wire: {
        bytesPerSecond: perSecond,
        totalBytesPerSecond: Object.values(perSecond).reduce(
          (a, b) => a + b,
          0,
        ),
        messagesPerSecond: Object.fromEntries(
          Object.entries(wire.count).map(([k, v]) => [
            k,
            Math.round((v / opts.seconds) * 10) / 10,
          ]),
        ),
        snapshot: {
          count: snapBytes.length,
          p50: pct(snapBytes, 0.5),
          max: snapBytes[snapBytes.length - 1] ?? 0,
          bytesPerEntry:
            entries > 0 ? Math.round((totalSnap / entries) * 10) / 10 : 0,
          meanEntries:
            Math.round((entries / Math.max(1, snapBytes.length)) * 10) / 10,
        },
      },
    };
    printReport(report);
    if (opts.out)
      writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    for (const ws of sockets) ws.close();
    proc.kill("SIGTERM");
    await new Promise((r) => proc.once("exit", r));
  }
}

function printReport(r) {
  const t = r.tick;
  console.log(
    `server tick — ${r.humans} humans + ${r.bots} bots, chaos ${r.chaos}, ${r.seconds} s, loadavg ${r.loadavg.join(" ")}`,
  );
  console.log(
    `  tick ms: p50 ${t.p50}  p95 ${t.p95}  p99 ${t.p99}  max ${t.max}  (${t.ticks} ticks)`,
  );
  for (const [name, p] of Object.entries(t.phases)) {
    console.log(
      `    ${name.padEnd(16)} p50 ${String(p.p50).padStart(7)}  p99 ${String(p.p99).padStart(7)}  max ${String(p.max).padStart(7)}  mean ${String(p.mean).padStart(7)}`,
    );
  }
  const w = r.wire;
  console.log(
    `  wire, one client: ${w.totalBytesPerSecond} B/s; snapshot p50 ${w.snapshot.p50} B, max ${w.snapshot.max} B, ${w.snapshot.bytesPerEntry} B/entry over ${w.snapshot.meanEntries} entries`,
  );
  for (const [type, bps] of Object.entries(w.bytesPerSecond)) {
    console.log(
      `    ${type.padEnd(16)} ${String(bps).padStart(7)} B/s  ${w.messagesPerSecond[type]}/s`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
