// E1 Air force: what does an enemy count cost? Boots the REAL server once per
// count with the air force staged at that size (AB_AIRFORCE=n: n squadron
// planes in the air at once, off no rig) on top of the carrier war's own
// waves (AB_BOSS_FAST: the fleet is up in seconds, its wave's aces come
// off it), joins `--humans` ws pilots that weave through the city at
// TICK_UP_HZ (tools/perf/pilots.mjs) and fire in bursts, and after a
// warm-up reports, per count:
//
//  - the server tick (one room — every pilot shares it), from `GET
//    /debug/tick` (server/src/tickstats.ts): in CPU time with the D5/C1
//    director's phase left out — the figure judged against the budget, as
//    the director's event planning spikes the same with no enemy at all
//    (the 0 row shows it) and a shared machine's scheduler is not the
//    server's cost — then the whole tick in CPU time and in wall time;
//  - the wire per client: mean and worst client's bytes per second (every
//    message, snapshots alone), and the planes a snapshot carries.
//
//   node --import tsx tools/airforce-bench.ts [--counts 50,100,200,300,500,700]
//        [--humans 6] [--warmup 8] [--seconds 15] [--json out.json]
//        [--phases] [--cpu-prof <dir>]
//
// The budget ENEMY_CAP_MAX is held to: server tick p99 ≤ 4 ms per room (the
// CPU figure above) and
// ≤ 250 KB/s per client (the M3's 60 fps and the mobile tier's 30 fps are
// measured on the M3 gallery, `airforce-swarm`). The table it prints is the
// one in docs/infinite-war.md. Wall-clock numbers: compare runs from one
// session, and read the load average printed beside them.

import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TICK_UP_HZ } from "@angels-bandits/common/constants";
import WebSocket from "ws";
import { pilotPose } from "./perf/pilots.mjs";

/** The pilots weave at 200–280 m: among the squadrons, and over C1's
 * low-flying chaos band (LOW_EXIT_ALT), so its collapses — not the air
 * force — do not decide the tick. */
const BENCH_FLIGHT = { near: 80, far: 380, yLo: 200, yHi: 280 };

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};
const COUNTS = arg("counts", "50,100,200,300,500,700").split(",").map(Number);
const HUMANS = Number(arg("humans", "6"));
const WARMUP_S = Number(arg("warmup", "8"));
const SECONDS = Number(arg("seconds", "15"));
const JSON_OUT = process.argv.includes("--json") ? arg("json", "") : "";
/** `--cpu-prof <dir>`: the server's V8 CPU profile per count, there. */
const CPU_PROF = process.argv.includes("--cpu-prof")
  ? resolve(arg("cpu-prof", "."))
  : "";

/** The budgets (ticket E1). */
const TICK_P99_MS = 4;
const CLIENT_BPS = 250_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => ok(port));
    });
  });
}

async function startServer(port: number, n: number): Promise<ChildProcess> {
  const log: string[] = [];
  const prof = CPU_PROF
    ? [
        "--cpu-prof",
        `--cpu-prof-dir=${CPU_PROF}`,
        "--import",
        resolve(REPO, "tools/perf/exit-on-term.mjs"),
      ]
    : [];
  const proc = spawn(
    "node",
    [...prof, "--import", "tsx", "server/src/index.ts"],
    {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(port),
        AB_BOSS_FAST: "1",
        AB_AIRFORCE: String(n),
        AB_TICK_STATS: "1",
        LIVENESS_TIMEOUT_MS: "30000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout?.on("data", (d) => log.push(String(d)));
  proc.stderr?.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 160; i++) {
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

interface Client {
  ws: WebSocket;
  counting: boolean;
  bytes: number;
  snapBytes: number;
  snaps: number;
  planes: number;
  /** Enemies the roster names (welcome + joined − left). */
  enemies: Set<string>;
}

function join(port: number, i: number): Promise<Client> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const c: Client = {
      ws,
      counting: false,
      bytes: 0,
      snapBytes: 0,
      snaps: 0,
      planes: 0,
      enemies: new Set(),
    };
    const timer = setTimeout(
      () => fail(new Error(`pilot ${i}: no welcome`)),
      30_000,
    );
    ws.on("error", fail);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "join", name: `AIR${i}` })),
    );
    ws.on("message", (data: Buffer) => {
      const text = String(data);
      const type = /^\{"type":"([^"]+)"/.exec(text)?.[1] ?? "?";
      if (type === "welcome") {
        clearTimeout(timer);
        const msg = JSON.parse(text) as {
          roster: { id: string; isBot?: boolean }[];
        };
        for (const r of msg.roster) if (r.isBot) c.enemies.add(r.id);
        ok(c);
      } else if (type === "playerJoined") {
        const m = JSON.parse(text) as {
          player: { id: string; isBot?: boolean };
        };
        if (m.player.isBot) c.enemies.add(m.player.id);
      } else if (type === "playerLeft") {
        c.enemies.delete((JSON.parse(text) as { id: string }).id);
      }
      if (!c.counting) return;
      c.bytes += data.length;
      if (type === "snapshot") {
        c.snapBytes += data.length;
        c.snaps++;
        const m = JSON.parse(text) as { p: unknown[]; s?: number[][] };
        let n = m.p.length;
        for (const row of m.s ?? []) {
          for (let k = 0; k < 8; k++) if ((row[12] as number) & (1 << k)) n++;
        }
        c.planes += n;
      }
    });
  });
}

interface Row {
  enemies: number;
  tickP50: number;
  tickP99: number;
  tickMax: number;
  /** CPU time, the director's phase left out: what is judged. */
  coreCpuP50: number;
  coreCpuP99: number;
  cpuP99: number;
  bpsMean: number;
  bpsMax: number;
  snapBpsMax: number;
  planesPerSnap: number;
  ok: boolean;
}

async function measure(n: number): Promise<Row> {
  const port = await freePort();
  const proc = await startServer(port, n);
  const clients: Client[] = [];
  try {
    for (let i = 0; i < HUMANS; i++) clients.push(await join(port, i));
    // Spread over the city, each pilot weaving down its own street.
    const centers = clients.map((_, i) => ({
      x: 200 + (i % 4) * 400,
      y: 0,
      z: 600 + Math.floor(i / 4) * 800,
    }));
    const t0 = performance.now();
    let seq = 0;
    const poses = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      clients.forEach((c, i) => {
        if (c.ws.readyState !== WebSocket.OPEN) return;
        c.ws.send(
          JSON.stringify({
            type: "pose",
            pose: pilotPose(i, t, centers[i], BENCH_FLIGHT),
          }),
        );
      });
    }, 1000 / TICK_UP_HZ);
    const fire = setInterval(() => {
      for (const c of clients) {
        if (c.ws.readyState === WebSocket.OPEN) {
          c.ws.send(JSON.stringify({ type: "fire", seq: ++seq }));
        }
      }
    }, 250);
    // Until the air force is up (8 squadrons a tick), then the warm-up.
    const until = Date.now() + 30_000;
    while (Date.now() < until && (clients[0]?.enemies.size ?? 0) < n) {
      await sleep(200);
    }
    await sleep(WARMUP_S * 1000);
    await fetch(`http://127.0.0.1:${port}/debug/tick?reset=1`);
    for (const c of clients) c.counting = true;
    const start = performance.now();
    await sleep(SECONDS * 1000);
    for (const c of clients) c.counting = false;
    const secs = (performance.now() - start) / 1000;
    const tick = (await (
      await fetch(`http://127.0.0.1:${port}/debug/tick`)
    ).json()) as {
      p50: number;
      p99: number;
      max: number;
      phases: Record<string, { p50: number; p99: number; mean: number }>;
      cpu: { p50: number; p99: number; max: number };
      core: { p50: number; p99: number; cpuP50: number; cpuP99: number };
    };
    if (process.argv.includes("--phases")) {
      console.error(`  ${n} phases:`, JSON.stringify(tick.phases));
    }
    clearInterval(poses);
    clearInterval(fire);
    const bps = clients.map((c) => c.bytes / secs);
    const snapBps = clients.map((c) => c.snapBytes / secs);
    const planes = clients.reduce((a, c) => a + c.planes, 0);
    const snaps = clients.reduce((a, c) => a + c.snaps, 0);
    const enemies = clients[0]?.enemies.size ?? 0;
    const row: Row = {
      enemies,
      tickP50: tick.p50,
      tickP99: tick.p99,
      tickMax: tick.max,
      coreCpuP50: tick.core.cpuP50,
      coreCpuP99: tick.core.cpuP99,
      cpuP99: tick.cpu.p99,
      bpsMean: bps.reduce((a, b) => a + b, 0) / Math.max(1, bps.length),
      bpsMax: Math.max(...bps),
      snapBpsMax: Math.max(...snapBps),
      planesPerSnap: planes / Math.max(1, snaps),
      ok: false,
    };
    row.ok = row.coreCpuP99 <= TICK_P99_MS && row.bpsMax <= CLIENT_BPS;
    return row;
  } finally {
    for (const c of clients) c.ws.close();
    proc.kill("SIGTERM");
    await new Promise((r) => proc.once("exit", r));
  }
}

const kb = (b: number) => (b / 1000).toFixed(1);

async function main(): Promise<void> {
  const rows: { staged: number; row: Row }[] = [];
  for (const n of COUNTS) {
    const row = await measure(n);
    rows.push({ staged: n, row });
    console.error(`  ${n}: done (${JSON.stringify(row)})`);
  }
  const la = loadavg()
    .map((x) => x.toFixed(1))
    .join(" ");
  console.log(
    `\nE1 air force bench — ${HUMANS} pilots in one room, ${SECONDS} s each, loadavg ${la}`,
  );
  console.log(
    `budget: server tick p99 ≤ ${TICK_P99_MS} ms per room, ≤ ${CLIENT_BPS / 1000} KB/s per client\n`,
  );
  console.log(
    "| air force | enemies up | tick CPU p50 / p99 (no director) | tick CPU p99 (all) | tick wall p50 / p99 / max | KB/s per client (mean / worst) | snapshots KB/s (worst) | planes per snapshot | in budget |",
  );
  console.log(
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |",
  );
  for (const { staged, row } of rows) {
    console.log(
      `| ${staged} | ${row.enemies} | ${row.coreCpuP50.toFixed(2)} / ${row.coreCpuP99.toFixed(2)} ms | ${row.cpuP99.toFixed(1)} ms | ${row.tickP50.toFixed(2)} / ${row.tickP99.toFixed(1)} / ${row.tickMax.toFixed(0)} ms | ${kb(row.bpsMean)} / ${kb(row.bpsMax)} | ${kb(row.snapBpsMax)} | ${row.planesPerSnap.toFixed(0)} | ${row.ok ? "yes" : "NO"} |`,
    );
  }
  const max = rows.filter((r) => r.row.ok).map((r) => r.staged);
  console.log(
    `\nlargest count in budget: ${max.length > 0 ? Math.max(...max) : "none"}`,
  );
  if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(rows, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
