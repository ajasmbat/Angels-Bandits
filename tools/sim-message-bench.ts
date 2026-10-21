// G9: what the page's main thread allocates per sim-worker message — the
// "GC from per-message allocation" suspect behind the 1-in-6 frame hitch
// (tools/perf/README.md, G9).
//
//   node --import tsx tools/sim-message-bench.ts [--where] [--planes=61]
//
// The page's half of every per-tick message the solo sim worker posts,
// through the real code: a fake Worker hands messages to the page's own
// listener (client/src/sim/local.ts), the WorkerLink hands them to the
// GameSocket (client/src/net/socket.ts), whose snapshot goes to a consumer
// that keeps what remotes.ingest keeps — each plane's pose, pushed into its
// InterpolationBuffer (client/src/net/interp.ts). Rows:
//
//   - snapshot, JSON frame: a snapshot as UTF-8 JSON — the ws path, and
//     every solo snapshot before G9 (TextDecoder, JSON.parse, a decoded
//     object per plane). Reported, not judged.
//   - snapshot, packed: G9's solo path — the worker decodes the snapshot and
//     posts it packed (common/src/net.ts packSnapshot); the page decodes it
//     into objects it reuses.
//   - poses: DS1's debris frame for a 1600-piece collapse, into the page's
//     PhysRegistry (client/src/sim/poses.ts).
//
// The message objects themselves are the BROWSER's (structured clone builds
// them on arrival; a transferred buffer is not copied): the bench builds
// each one in its own loop, which is not charged. What is charged is every
// byte the page's code allocates handling it, under V8's sampling heap
// profiler (~every 32 B, collected objects included), after 600 warm
// messages, median of five runs of 3000 — the method of
// tools/destruction-bench.ts. A judged row passes at <= 64 B a message
// (V8's sampling noise; a decoded object per plane is ~6 KB). Exits 1 over.

import { Session } from "node:inspector/promises";
import {
  PIECE_STRIDE,
  RECORD_HEAD,
} from "@angels-bandits/common/city/physpose";
import { encodeSnapshotEntry, packSnapshot } from "@angels-bandits/common/net";
import type {
  SnapshotEntry,
  WireSnapshotEntry,
} from "@angels-bandits/common/protocol";
import { InterpolationBuffer } from "../client/src/net/interp";

const args = process.argv.slice(2);
const WHERE = args.includes("--where");
const PLANES = Number(
  args.find((a) => a.startsWith("--planes="))?.split("=")[1] ?? 61,
);
const PIECES = 1600;

// --- A page with a sim worker that is this bench ------------------------------

type PageListener = (ev: { data: unknown }) => void;
let page: PageListener | null = null;
const deliver = (msg: unknown): void => page?.({ data: msg });
const encoder = new TextEncoder();
const welcome = {
  type: "welcome",
  id: "me",
  roomId: "room-1",
  seed: 42,
  spawn: { pos: { x: 0, y: 300, z: 0 }, yaw: 0, speed: 60 },
  roster: [],
  scores: [],
  intensity: 1,
  waves: [0, 0, 0, 0, 0, 0],
  cityEvents: [],
  resumeToken: "t",
  destroyed: [],
  collapses: [],
  courses: [],
};
class FakeWorker {
  addEventListener(type: string, fn: PageListener): void {
    if (type === "message") page = fn;
  }
  postMessage(msg: { t: string; id?: number }): void {
    if (msg.t === "open") {
      queueMicrotask(() => deliver({ t: "open", id: msg.id }));
    } else if (msg.t === "send") {
      const data = encoder.encode(JSON.stringify(welcome)).buffer;
      queueMicrotask(() => deliver({ t: "frame", id: msg.id, data }));
    }
  }
}
const g = globalThis as Record<string, unknown>;
g.Worker = FakeWorker;
g.location = { search: "", hostname: "localhost", host: "localhost" };
g.document = { hidden: false, addEventListener() {} };
g.localStorage = { getItem: () => null, setItem() {} };

const { GameSocket } = await import("../client/src/net/socket");
const { ingestPoses } = await import("../client/src/sim/poses");
const socket = await GameSocket.connect("bench");

// What remotes.ingest keeps of a snapshot: each plane's pose, in its buffer.
const buffers = new Map<string, InterpolationBuffer>();
let sink = 0;
socket.events.onSnapshot = (snap) => {
  const players = snap.players;
  for (let k = 0; k < players.length; k++) {
    const p = players[k] as SnapshotEntry;
    let b = buffers.get(p.id);
    if (!b) {
      b = new InterpolationBuffer();
      buffers.set(p.id, b);
    }
    b.push(snap.time - (p.age ?? 0), p.pose);
    sink += p.hp;
  }
};

// --- The messages (built by the bench: not charged) --------------------------

/** Plane k's wire tuple at step f: flying round in a circle. */
function tuple(k: number, f: number): WireSnapshotEntry {
  const a = k * 0.37 + f * 0.01;
  return encodeSnapshotEntry({
    id: k === 0 ? "me" : `e${k}`,
    pose: {
      pos: {
        x: 500 + 300 * Math.cos(a),
        y: 120 + k,
        z: 500 + 300 * Math.sin(a),
      },
      quat: { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) },
      speed: 70,
    },
    hp: 100,
    prot: false,
    age: k === 0 ? 30 : 0,
  });
}
const T0 = 1_000_000;
const timeAt = (f: number) => T0 + f * 50;
const jsonFrame = (f: number) => {
  const p: WireSnapshotEntry[] = [];
  for (let k = 0; k < PLANES; k++) p.push(tuple(k, f));
  const text = JSON.stringify({ type: "snapshot", time: timeAt(f), p });
  return { t: "frame", id: 1, data: encoder.encode(text).buffer };
};
const ids = new Map<string, number>();
const idIndex = (id: string): number => {
  let k = ids.get(id);
  if (k === undefined) {
    k = ids.size;
    ids.set(id, k);
  }
  return k;
};
// The link's id table, as the worker would send it before the first one.
const all: string[] = [];
for (let k = 0; k < PLANES; k++) all.push(k === 0 ? "me" : `e${k}`);
for (const id of all) idIndex(id);
deliver({ t: "ids", id: 1, base: 0, ids: all });
const packedFrame = (f: number) => {
  const p: WireSnapshotEntry[] = [];
  for (let k = 0; k < PLANES; k++) p.push(tuple(k, f));
  return { t: "snap", id: 1, data: packSnapshot(timeAt(f), p, idIndex) };
};
const posesTemplate = new Float32Array(RECORD_HEAD + PIECES * PIECE_STRIDE);
posesTemplate[0] = 1;
posesTemplate[1] = 7;
posesTemplate[2] = PIECES;
for (let i = 0; i < PIECES; i++) {
  posesTemplate[RECORD_HEAD + i * PIECE_STRIDE + 6] = 1;
  posesTemplate[RECORD_HEAD + i * PIECE_STRIDE + 8] = 1;
}
const posesFrame = (f: number) => {
  const data = posesTemplate.slice();
  for (let i = 0; i < PIECES; i++) {
    data[RECORD_HEAD + i * PIECE_STRIDE + 1] = 100 - f * 0.01;
  }
  return { t: "poses", at: timeAt(f), epoch: 1, data, heaps: null };
};

type Entry = {
  name: string;
  judged: boolean;
  make: (f: number) => unknown;
  handle: (msg: unknown) => void;
};
const ENTRIES: Entry[] = [
  {
    name: "snapshot, JSON frame (ws; solo before G9)",
    judged: false,
    make: jsonFrame,
    handle: deliver,
  },
  {
    name: "snapshot, packed (solo, G9)",
    judged: true,
    make: packedFrame,
    handle: deliver,
  },
  {
    name: "poses (DS1 debris frame)",
    judged: true,
    make: posesFrame,
    handle: (msg) => ingestPoses(msg as Parameters<typeof ingestPoses>[0]),
  },
];

// --- Measuring ----------------------------------------------------------------

const WARM = 600;
const MESSAGES = 3000;
const RUNS = 5;
const BUDGET_BYTES = 64;

type ProfileNode = {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: ProfileNode[];
};
const fileOf = (url: string): string =>
  url.replace(/^.*\/(client|common|server|tools|node_modules)\//, "$1/");
const isBench = (file: string): boolean =>
  file.startsWith("tools/") || file.startsWith("node:");

let step = 0;
async function profileRun(
  e: Entry,
): Promise<{ perMessage: number; sites: [string, number][] }> {
  for (let k = 0; k < WARM; k++) e.handle(e.make(step++));
  const msgs: unknown[] = [];
  for (let k = 0; k < MESSAGES; k++) msgs.push(e.make(step++));
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 32,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let k = 0; k < MESSAGES; k++) e.handle(msgs[k]);
  const { profile } = await session.post("HeapProfiler.stopSampling");
  session.disconnect();
  const sites = new Map<string, number>();
  let total = 0;
  const walk = (n: ProfileNode, owner: string) => {
    const file = fileOf(n.callFrame.url);
    const here = file === "" ? owner : file;
    if (n.selfSize > 0 && !isBench(here)) {
      total += n.selfSize;
      const key = `${n.callFrame.functionName || "(anonymous)"} ${file ? `${file}:${n.callFrame.lineNumber + 1}` : `(builtin, from ${here})`}`;
      sites.set(key, (sites.get(key) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c, here);
  };
  walk(profile.head as ProfileNode, "node:");
  return {
    perMessage: total / MESSAGES,
    sites: [...sites].sort((a, b) => b[1] - a[1]),
  };
}

let failed = false;
console.log(
  `bytes the page allocates per message (${PLANES} planes a snapshot, ${PIECES} pieces a pose frame), median of ${RUNS}:`,
);
for (const e of ENTRIES) {
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(await profileRun(e));
  runs.sort((a, b) => a.perMessage - b.perMessage);
  const mid = runs[Math.floor(RUNS / 2)] as (typeof runs)[number];
  const over = e.judged && mid.perMessage > BUDGET_BYTES;
  if (over) failed = true;
  console.log(
    `  ${e.name.padEnd(42)} ${mid.perMessage.toFixed(1).padStart(8)} B  ${e.judged ? (over ? "OVER" : "ok") : "(reported)"}`,
  );
  if (WHERE || over) {
    for (const [site, bytes] of mid.sites.slice(0, 6)) {
      console.log(
        `      ${(bytes / MESSAGES).toFixed(1).padStart(8)} B  ${site}`,
      );
    }
  }
}
console.log(`(sink ${sink > 0 ? "ok" : "EMPTY"})`);
process.exit(failed || !(sink > 0) ? 1 : 0);
