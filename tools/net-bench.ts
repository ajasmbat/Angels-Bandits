// Snapshot-network bench (ANGE-4KO2W2). Boots the REAL server on PORT=0, joins
// N fake pilots that stream a real flight path at TICK_UP_HZ, fills the rest of
// the room with bots, and measures what actually crosses the wire — bytes, the
// cadence the server really delivers, and the interpolation delay the SHIPPED
// controller converges to on those arrival times.
//
//   npx tsx tools/net-bench.ts [--pilots 6] [--bots 6] [--seconds 12]
//                              [--jitter 40] [--json]
//
// `--jitter N` is the bad-network run: each snapshot is held for a random
// 0..N ms before the client sees it, exactly as a wobbling link would. The
// bench then plays every snapshot through a real InterpolationBuffer at 60 fps
// and reports STARVATION — the fraction of frames whose render time fell past
// the newest sample, i.e. the frames where a remote plane would freeze on its
// last known pose instead of gliding. The adaptive buffer is scored against a
// fixed 100 ms control (what this ticket replaced) on the same arrival trace,
// so the two numbers are the same run, not two.
//
// To compare against a base branch, copy this file into a checkout of it; the
// bandwidth figures are branch-independent, and the delay there is whatever
// INTERP_DELAY_MS was fixed at.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { InterpDelay } from "@angels-bandits/client/net/delay";
import { InterpolationBuffer } from "@angels-bandits/client/net/interp";
import { TICK_UP_HZ, WORLD_SIZE } from "@angels-bandits/common/constants";
import { decodeSnapshotEntry } from "@angels-bandits/common/net";
import type {
  ServerMsg,
  WelcomeMsg,
  WireSnapshotMsg,
} from "@angels-bandits/common/protocol";
import WebSocket from "ws";

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const PILOTS = arg("pilots", 6);
const BOTS = arg("bots", 6);
const SECONDS = arg("seconds", 12);
const JITTER_MS = arg("jitter", 0);
const AS_JSON = process.argv.includes("--json");

/** The fixed buffer this ticket replaced — the control in the jitter run. */
const LEGACY_DELAY_MS = 100;
/** Frame rate the starvation replay is scored at. */
const REPLAY_FPS = 60;

const entry = fileURLToPath(new URL("../server/src/index.ts", import.meta.url));

const boot = (): Promise<{ kill: () => void; url: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", entry], {
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const timer = setTimeout(
      () => reject(new Error("server never bound")),
      30_000,
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const port = /listening on :(\d+)/.exec(chunk)?.[1];
      if (!port) return;
      clearTimeout(timer);
      resolve({
        kill: () => child.kill("SIGTERM"),
        url: `ws://127.0.0.1:${port}`,
      });
    });
  });

interface Arrival {
  /** Local clock when the client SAW this snapshot (jitter already applied). */
  at: number;
  msg: WireSnapshotMsg;
  bytes: number;
}

interface Pilot {
  ws: WebSocket;
  welcome: WelcomeMsg;
  arrivals: Arrival[];
  bytes: number;
}

/** A fake pilot: joins, streams a circling pose, records every arrival. */
function pilot(url: string, i: number): Promise<Pilot> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const state: Partial<Pilot> = { ws, arrivals: [], bytes: 0 };
    ws.on("error", reject);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "join", name: `Bench${i}` })),
    );
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      state.bytes = (state.bytes ?? 0) + data.length;
      if (msg.type === "snapshot") {
        const record = () =>
          state.arrivals?.push({
            at: performance.now(),
            msg,
            bytes: data.length,
          });
        // The bad-network run holds each frame a random beat before the
        // client is allowed to see it — the same thing a wobbling link does.
        if (JITTER_MS > 0) setTimeout(record, Math.random() * JITTER_MS);
        else record();
      }
      if (msg.type === "welcome") {
        state.welcome = msg;
        state.bytes = 0; // the welcome is a one-off, not steady state
        resolve(state as Pilot);
      }
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};

/**
 * Replay one pilot's arrival trace through a real InterpolationBuffer and
 * count starved frames — the honest proxy for "remotes stutter". `delayFor`
 * is asked for the buffer to hold at each frame, so the adaptive controller
 * and a fixed delay are scored identically.
 */
function starvation(
  arrivals: Arrival[],
  selfId: string,
  delayFor: (arrival: Arrival | null) => number,
): { starvedFrames: number; frames: number; delayMs: number } {
  const buffers = new Map<string, InterpolationBuffer>();
  /** Ids in the NEWEST snapshot. A dead plane is simply absent from snapshots
   * until it respawns, so its buffer going stale is the rules working, not a
   * starved remote — only planes the server is currently streaming count. */
  let live = new Set<string>();
  let next = 0;
  let starved = 0;
  let frames = 0;
  let delaySum = 0;
  let lastDelay = delayFor(null);
  const first = arrivals[0];
  const last = arrivals[arrivals.length - 1];
  if (!first || !last)
    return { starvedFrames: 0, frames: 0, delayMs: lastDelay };
  // Server clock offset, estimated the way GameSocket does: the largest
  // (serverTime − localTime) sample seen so far.
  let offset = Number.NEGATIVE_INFINITY;

  for (let t = first.at; t <= last.at; t += 1000 / REPLAY_FPS) {
    while (next < arrivals.length && (arrivals[next]?.at ?? 0) <= t) {
      const a = arrivals[next];
      next++;
      if (!a) continue;
      offset = Math.max(offset, a.msg.time - a.at);
      lastDelay = delayFor(a);
      live = new Set<string>();
      for (const w of a.msg.p) {
        const e = decodeSnapshotEntry(w);
        if (e.id === selfId) continue;
        live.add(e.id);
        let buf = buffers.get(e.id);
        if (!buf) {
          buf = new InterpolationBuffer();
          buffers.set(e.id, buf);
        }
        buf.push(a.msg.time, e.pose);
      }
    }
    if (!Number.isFinite(offset) || live.size === 0) continue;
    const renderTime = t + offset - lastDelay;
    frames++;
    delaySum += lastDelay;
    // Starved = the render time has run past the newest sample, so a remote
    // is pinned to its last known pose instead of gliding toward the next.
    for (const id of live) {
      const newest = buffers.get(id)?.latestTime;
      if (newest !== undefined && newest !== null && renderTime > newest) {
        starved++;
        break;
      }
    }
  }
  return { starvedFrames: starved, frames, delayMs: delaySum / (frames || 1) };
}

const run = async (): Promise<void> => {
  const { kill, url } = await boot();
  const pilots: Pilot[] = [];
  for (let i = 0; i < PILOTS; i++) pilots.push(await pilot(url, i));

  // Ask for the bot fill through the real shared-slider path.
  pilots[0]?.ws.send(JSON.stringify({ type: "setBots", count: BOTS }));

  // Every pilot flies a lazy circle so poses genuinely change every tick — a
  // parked plane would let nothing but the clock move on the wire.
  const flight = pilots.map((p) => ({
    pos: { ...p.welcome.spawn.pos },
    yaw: p.welcome.spawn.yaw,
    speed: p.welcome.spawn.speed,
  }));
  const UP_MS = 1000 / TICK_UP_HZ;
  const timer = setInterval(() => {
    for (let i = 0; i < pilots.length; i++) {
      const f = flight[i];
      const p = pilots[i];
      if (!f || !p) continue;
      f.yaw += 0.3 * (UP_MS / 1000) * (i % 2 ? 1 : -1);
      const dt = UP_MS / 1000;
      f.pos.x =
        (((f.pos.x - Math.sin(f.yaw) * f.speed * dt) % WORLD_SIZE) +
          WORLD_SIZE) %
        WORLD_SIZE;
      f.pos.z =
        (((f.pos.z - Math.cos(f.yaw) * f.speed * dt) % WORLD_SIZE) +
          WORLD_SIZE) %
        WORLD_SIZE;
      const half = f.yaw / 2;
      p.ws.send(
        JSON.stringify({
          type: "pose",
          pose: {
            pos: { ...f.pos },
            quat: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
            speed: f.speed,
          },
        }),
      );
    }
  }, UP_MS);

  // Settle: let bots spawn and the roster stop churning before counting.
  await wait(3000);
  for (const p of pilots) {
    p.bytes = 0;
    p.arrivals.length = 0;
  }
  const t0 = performance.now();
  await wait(SECONDS * 1000);
  const elapsed = (performance.now() - t0) / 1000;
  clearInterval(timer);
  // Let any jitter-held frames land before scoring.
  await wait(JITTER_MS + 50);

  const gaps = pilots.flatMap((p) =>
    p.arrivals.slice(1).map((a, i) => a.at - (p.arrivals[i]?.at ?? a.at)),
  );
  const entries = pilots.reduce(
    (n, p) => n + p.arrivals.reduce((m, a) => m + a.msg.p.length, 0),
    0,
  );
  const snapshotBytes = pilots.reduce(
    (n, p) => n + p.arrivals.reduce((m, a) => m + a.bytes, 0),
    0,
  );

  // Score the adaptive controller and the fixed 100 ms control on the SAME
  // arrival traces, so the comparison is one run, not two.
  const adaptive = { starved: 0, frames: 0, delays: [] as number[] };
  const legacy = { starved: 0, frames: 0 };
  for (const p of pilots) {
    const ctrl = new InterpDelay();
    const a = starvation(p.arrivals, p.welcome.id, (arr) => {
      if (arr) ctrl.observe(arr.at);
      return ctrl.delayMs;
    });
    adaptive.starved += a.starvedFrames;
    adaptive.frames += a.frames;
    adaptive.delays.push(a.delayMs);
    const l = starvation(p.arrivals, p.welcome.id, () => LEGACY_DELAY_MS);
    legacy.starved += l.starvedFrames;
    legacy.frames += l.frames;
  }

  for (const p of pilots) p.ws.close();
  kill();

  const out = {
    pilots: PILOTS,
    botsRequested: BOTS,
    injectedJitterMs: JITTER_MS,
    seconds: Number(elapsed.toFixed(2)),
    snapshotHz: Number(
      (
        pilots.reduce((n, p) => n + p.arrivals.length, 0) /
        PILOTS /
        elapsed
      ).toFixed(2),
    ),
    meanSnapshotGapMs: Number(mean(gaps).toFixed(2)),
    p95SnapshotGapMs: Number(pct(gaps, 0.95).toFixed(2)),
    bytesPerSnapshotEntry: Number((snapshotBytes / (entries || 1)).toFixed(1)),
    bytesPerSecondPerClient: Math.round(
      pilots.reduce((n, p) => n + p.bytes, 0) / PILOTS / elapsed,
    ),
    kbPerSecondPerClient: Number(
      (
        pilots.reduce((n, p) => n + p.bytes, 0) /
        PILOTS /
        elapsed /
        1024
      ).toFixed(2),
    ),
    interpDelayMs: Number(mean(adaptive.delays).toFixed(1)),
    legacyInterpDelayMs: LEGACY_DELAY_MS,
    adaptiveStarvedPct: Number(
      ((100 * adaptive.starved) / (adaptive.frames || 1)).toFixed(2),
    ),
    legacyStarvedPct: Number(
      ((100 * legacy.starved) / (legacy.frames || 1)).toFixed(2),
    ),
  };
  if (AS_JSON) console.log(JSON.stringify(out, null, 2));
  else
    for (const [k, v] of Object.entries(out))
      console.log(`${k.padEnd(24)} ${v}`);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
