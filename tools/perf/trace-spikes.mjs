// O5: what a wall-clock spike is made of, from a Chrome trace.
//
//     node tools/perf/trace-spikes.mjs <trace.json> [...more]
//
// run.mjs `--trace <dir>` records one trace per measured segment window
// (CDP Tracing: devtools.timeline + V8 GC) and runs this on it. A SPIKE is a
// frame interval — one requestAnimationFrame callback start to the next, on
// the page's main thread — over SPIKE_FACTOR × the window's median interval,
// the harness's own spike rule (run.mjs SPIKE_FACTOR). Each is split into:
//
//  - gc:      V8 garbage collection on the main thread inside the interval;
//  - script:  the rest of the frame callback and other main-thread tasks;
//  - outside: the main thread idle — waiting on the GPU process, the
//             compositor or vsync. JavaScript cannot cause this part.
//
// A spike is caused by JS when gc + script is over half of the interval's
// EXCESS over the median (so a GC that merely lands in a long GPU wait is
// not blamed for it). `cause` is the bigger of gc and script when it is.
//
// One honest blind spot: a WebGL call that blocks on a backed-up GPU queue
// (SwiftShader does this, see tools/perf/README.md) runs INSIDE the frame
// callback, so it counts as script here. A real GPU drains in microseconds
// and shows this blind spot as nothing; on SwiftShader read `script` spikes
// as "script or GL backpressure" and check `gc` for the GC claim.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Same rule as run.mjs's SPIKE_FACTOR (kept here so this file stands alone). */
export const SPIKE_FACTOR = 4;

const GC_NAMES = new Set([
  "MinorGC",
  "MajorGC",
  "V8.GCScavenger",
  "V8.GCCompactor",
  "V8.GCFinalizeMC",
  "V8.GCIncrementalMarking",
  "V8.GC_MC_BACKGROUND_MARKING",
  "V8.GCMinorMS",
  "BlinkGC.AtomicPhase",
  "BlinkGC.IncrementalMarkingStep",
]);

/** The renderer main thread that ran the page's animation frames. */
function mainThread(events) {
  const counts = new Map();
  for (const e of events) {
    if (e.name === "FireAnimationFrame") {
      const k = `${e.pid}:${e.tid}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  let best = null;
  for (const [k, n] of counts) if (!best || n > best[1]) best = [k, n];
  return best ? best[0] : null;
}

/** Sum of the parts of [a, b] covered by `spans` (sorted or not). */
function covered(spans, a, b) {
  let t = 0;
  for (const [s, e] of spans) {
    const lo = Math.max(a, s);
    const hi = Math.min(b, e);
    if (hi > lo) t += hi - lo;
  }
  return t;
}

/** Analyse one trace's events (the array, or {traceEvents}). */
export function analyseTrace(trace) {
  const events = Array.isArray(trace) ? trace : (trace.traceEvents ?? []);
  const key = mainThread(events);
  if (key === null) return { frames: 0, spikes: [], medianMs: null };
  const onMain = events.filter(
    (e) => `${e.pid}:${e.tid}` === key && e.ph === "X" && e.dur !== undefined,
  );
  // Only the harness's measured window (run.mjs marks it), when marked.
  const mark = (name) => events.find((e) => e.name === name)?.ts ?? null;
  const w0 = mark("abWindowStart") ?? Number.NEGATIVE_INFINITY;
  const w1 = mark("abWindowEnd") ?? Number.POSITIVE_INFINITY;
  const frames = onMain
    .filter((e) => e.name === "FireAnimationFrame" && e.ts >= w0 && e.ts <= w1)
    .map((e) => e.ts)
    .sort((a, b) => a - b);
  // Top-level tasks: what the main thread was doing at all.
  const tasks = onMain
    .filter(
      (e) => e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask",
    )
    .map((e) => [e.ts, e.ts + e.dur]);
  const gcs = onMain
    .filter((e) => GC_NAMES.has(e.name))
    .map((e) => [e.ts, e.ts + e.dur]);
  const intervals = [];
  for (let i = 1; i < frames.length; i++) {
    intervals.push([frames[i - 1], frames[i]]);
  }
  const lens = intervals.map(([a, b]) => b - a).sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const spikes = [];
  for (const [a, b] of intervals) {
    const len = b - a;
    if (!(len > SPIKE_FACTOR * median)) continue;
    const gc = covered(gcs, a, b);
    const busy = covered(tasks, a, b);
    const script = Math.max(0, busy - gc);
    const outside = Math.max(0, len - busy);
    const excess = len - median;
    const js = gc + script > excess / 2;
    spikes.push({
      atMs: Math.round((a - (frames[0] ?? a)) / 100) / 10,
      ms: Math.round(len / 100) / 10,
      gcMs: Math.round(gc / 100) / 10,
      scriptMs: Math.round(script / 100) / 10,
      outsideMs: Math.round(outside / 100) / 10,
      js,
      cause: js ? (gc >= script ? "gc" : "script") : "outside JS",
    });
  }
  return {
    frames: frames.length,
    medianMs: Math.round(median / 100) / 10,
    gcMs:
      Math.round(covered(gcs, frames[0] ?? 0, frames.at(-1) ?? 0) / 100) / 10,
    spikes,
  };
}

/** One line per trace, then its spikes. */
export function describe(name, r) {
  const js = r.spikes.filter((s) => s.js);
  const gc = js.filter((s) => s.cause === "gc");
  const lines = [
    `${name}: ${r.frames} frames, median ${r.medianMs} ms, ${r.spikes.length} spikes > ${SPIKE_FACTOR}× median — ${js.length} JS (${gc.length} GC), ${r.spikes.length - js.length} outside JS; GC total ${r.gcMs} ms`,
  ];
  for (const s of r.spikes) {
    lines.push(
      `    +${s.atMs} ms  ${s.ms} ms = gc ${s.gcMs} + script ${s.scriptMs} + outside ${s.outsideMs}  → ${s.cause}`,
    );
  }
  return lines.join("\n");
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  for (const f of process.argv.slice(2)) {
    console.log(describe(f, analyseTrace(JSON.parse(readFileSync(f, "utf8")))));
  }
}
