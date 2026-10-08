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
//  - GL wait: busy time whose CPU-profile samples sit inside a WebGL call
//             (the page blocked on a backed-up GPU queue — SwiftShader);
//  - outside: the main thread idle — waiting on the GPU process, the
//             compositor or vsync. JavaScript cannot cause this part.
//
// A spike is caused by JS when gc + script is over half of the interval's
// EXCESS over the median (so a GC that merely lands in a long GPU wait is
// not blamed for it). `cause` is the bigger of gc and script when it is.
//
// A WebGL call that blocks on a backed-up GPU queue (SwiftShader does this,
// see tools/perf/README.md) runs INSIDE the frame callback; without the
// V8 CPU profiler in the trace it would count as script. run.mjs traces the
// profiler, and the samples inside the spike split its busy time: the share
// sampled inside a GL call is GL wait, not script. A trace without samples
// marks its spikes "(unprofiled)".

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

/** Main-thread work: the top-level task (with `toplevel` traced) and,
 * since a trace without it has none, the work events themselves. */
const BUSY_NAMES = new Set([
  "RunTask",
  "ThreadControllerImpl::RunTask",
  "FireAnimationFrame",
  "FunctionCall",
  "TimerFire",
  "EventDispatch",
  "EvaluateScript",
  "v8.callFunction",
  "UpdateLayoutTree",
  "Layout",
  "PrePaint",
  "Paint",
  "Layerize",
  "HitTest",
  ...GC_NAMES,
]);

/** Overlapping [start, end] spans merged into disjoint ones. */
function merge(spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** The renderer main thread that ran the page's animation frames. */
export function mainThread(events) {
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

/**
 * WebGL entry points, by name: a CPU-profile sample whose leaf is one of
 * these (a builtin, no script URL) is the page waiting inside a GL call —
 * on SwiftShader, a backed-up GPU queue — not JavaScript work.
 */
const GL_CALL =
  /^(draw|buffer|uniform|tex|bind|clear|readPixels|vertexAttrib|enable|disable|blend|depth|viewport|scissor|useProgram|framebuffer|renderbuffer|invalidate|blit|color|stencil|flush|finish|fenceSync|clientWaitSync|getSync|beginQuery|endQuery|getQuery|compileShader|linkProgram|shaderSource|createProgram|deleteProgram|getProgram|getShader|getUniform|getAttrib|getError|getExtension|getParameter|pixelStorei|generateMipmap|copyTex|compressedTex|deleteBuffer|deleteTexture|createBuffer|createTexture|createVertexArray|bindVertexArray|polygonOffset|cullFace|frontFace|lineWidth|activeTexture)/;

/**
 * The page main thread's V8 CPU-profile samples (`disabled-by-default-v8.
 * cpu_profiler`), as [ts, kind] with kind gl | gc | idle | native | js.
 * Empty when the trace did not record the profiler.
 */
function cpuSamples(events, key) {
  const out = [];
  const byId = new Map();
  for (const e of events) {
    if (`${e.pid}:${e.tid}` !== key) continue;
    if (e.name === "Profile") {
      byId.set(e.id, { t: e.args?.data?.startTime ?? e.ts, nodes: new Map() });
    }
  }
  for (const e of events) {
    // Chunks come from V8's profiler thread: matched by profile id.
    if (e.name !== "ProfileChunk") continue;
    const prof = byId.get(e.id);
    if (!prof) continue;
    const d = e.args?.data ?? {};
    for (const n of d.cpuProfile?.nodes ?? [])
      prof.nodes.set(n.id, n.callFrame);
    const samples = d.cpuProfile?.samples ?? [];
    const deltas = d.timeDeltas ?? [];
    for (let i = 0; i < samples.length; i++) {
      prof.t += deltas[i] ?? 0;
      const cf = prof.nodes.get(samples[i]) ?? {};
      const fn = cf.functionName ?? "";
      const kind =
        fn === "(garbage collector)"
          ? "gc"
          : fn === "(idle)"
            ? "idle"
            : fn === "(program)" || fn === "(root)"
              ? "native"
              : !cf.url && GL_CALL.test(fn)
                ? "gl"
                : "js";
      out.push([prof.t, kind]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
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
  // What the main thread was doing at all: every work event, merged (they
  // nest — a FunctionCall inside a FireAnimationFrame inside a RunTask).
  const tasks = merge(
    onMain
      .filter((e) => BUSY_NAMES.has(e.name))
      .map((e) => [e.ts, e.ts + e.dur]),
  );
  const gcs = merge(
    onMain.filter((e) => GC_NAMES.has(e.name)).map((e) => [e.ts, e.ts + e.dur]),
  );
  const samples = cpuSamples(events, key);
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
    let script = Math.max(0, busy - gc);
    let gl = 0;
    // With the CPU profiler traced, the busy time splits by what the
    // samples were doing: a GL call blocking is not script.
    const inSpike = samples.filter(([t]) => t >= a && t < b);
    if (inSpike.length >= 4) {
      const share = (k) =>
        inSpike.filter(([, kind]) => kind === k).length / inSpike.length;
      gl = busy * (share("gl") / (1 - share("idle") || 1));
      script = Math.max(0, busy - gc - gl);
    }
    const outside = Math.max(0, len - busy);
    const excess = len - median;
    const js = gc + script > excess / 2;
    spikes.push({
      atMs: Math.round((a - (frames[0] ?? a)) / 100) / 10,
      ms: Math.round(len / 100) / 10,
      gcMs: Math.round(gc / 100) / 10,
      scriptMs: Math.round(script / 100) / 10,
      glMs: Math.round(gl / 100) / 10,
      profiled: inSpike.length >= 4,
      outsideMs: Math.round(outside / 100) / 10,
      js,
      cause: js
        ? gc >= script
          ? "gc"
          : "script"
        : gl > outside
          ? "GL wait"
          : "outside JS",
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
      `    +${s.atMs} ms  ${s.ms} ms = gc ${s.gcMs} + script ${s.scriptMs} + GL wait ${s.glMs} + outside ${s.outsideMs}${s.profiled ? "" : " (unprofiled)"}  → ${s.cause}`,
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
