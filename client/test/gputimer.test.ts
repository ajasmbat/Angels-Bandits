// The GPU timer's two failure modes, both of which make a frame-time report
// LIE rather than error: a starved query pool silently drops the expensive
// frames, and a disjoint that lands while queries are still in flight poisons
// results that are then reported as valid.
//
// Driven against a fake WebGL2 context, because both bugs are about the
// ORDER of driver events and neither is reproducible on a real GPU on demand.

import { describe, expect, it } from "vitest";
import { GpuTimer } from "../src/render/gputimer";

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;

/** A query as the fake driver sees it: a result and whether it has landed. */
interface FakeQuery {
  id: number;
  ns: number;
  ready: boolean;
}

class FakeGl {
  static readonly QUERY_RESULT_AVAILABLE = 0x9194;
  static readonly QUERY_RESULT = 0x9193;
  readonly QUERY_RESULT_AVAILABLE = FakeGl.QUERY_RESULT_AVAILABLE;
  readonly QUERY_RESULT = FakeGl.QUERY_RESULT;
  /** Raised by the fake driver; cleared by the first read, like the real one. */
  disjoint = false;
  private next = 1;
  private open: FakeQuery | null = null;
  readonly all: FakeQuery[] = [];
  /** Queries the GPU has been handed but has not finished, oldest first. */
  private readonly inFlight: FakeQuery[] = [];

  createQuery(): FakeQuery {
    const q = { id: this.next++, ns: 0, ready: false };
    this.all.push(q);
    return q;
  }
  getExtension(name: string): object | null {
    return name === "EXT_disjoint_timer_query_webgl2" ? {} : null;
  }
  getParameter(pname: number): boolean {
    if (pname !== GPU_DISJOINT_EXT) throw new Error(`unexpected ${pname}`);
    const was = this.disjoint;
    this.disjoint = false; // reading CLEARS it — the whole trap
    return was;
  }
  beginQuery(target: number, q: FakeQuery): void {
    if (target !== TIME_ELAPSED_EXT) throw new Error("wrong target");
    // Queries are recycled by the pool, so a re-used one starts over.
    q.ready = false;
    q.ns = 0;
    this.open = q;
  }
  endQuery(): void {
    if (this.open !== null) this.inFlight.push(this.open);
    this.open = null;
  }
  getQueryParameter(q: FakeQuery, pname: number): boolean | number {
    return pname === FakeGl.QUERY_RESULT_AVAILABLE ? q.ready : q.ns;
  }
  /** The GPU finishes the oldest `n` outstanding queries, at `ms` each. */
  land(n: number, ms: number): void {
    for (let i = 0; i < n; i++) {
      const q = this.inFlight.shift();
      if (q === undefined) return;
      q.ns = ms * 1e6;
      q.ready = true;
    }
  }
}

/** GpuTimer.create() instanceof-checks WebGL2RenderingContext; satisfy it. */
function timerOver(gl: FakeGl, capacity: number): GpuTimer {
  const original = globalThis.WebGL2RenderingContext;
  // biome-ignore lint/suspicious/noExplicitAny: standing in for a GL context
  (globalThis as any).WebGL2RenderingContext = FakeGl;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: standing in for a GL context
    const t = GpuTimer.create(gl as any, capacity);
    if (t === null)
      throw new Error("create() returned null over a fake WebGL2");
    return t;
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restoring the global
    (globalThis as any).WebGL2RenderingContext = original;
  }
}

describe("GpuTimer — availability", () => {
  it("is null without the extension, which is a missing number not an error", () => {
    const gl = new FakeGl();
    gl.getExtension = () => null;
    const original = globalThis.WebGL2RenderingContext;
    // biome-ignore lint/suspicious/noExplicitAny: standing in for a context
    (globalThis as any).WebGL2RenderingContext = FakeGl;
    // biome-ignore lint/suspicious/noExplicitAny: standing in for a context
    expect(GpuTimer.create(gl as any)).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: restoring the global
    (globalThis as any).WebGL2RenderingContext = original;
  });
});

describe("GpuTimer — measuring", () => {
  it("reports finished queries in order, in milliseconds", () => {
    const gl = new FakeGl();
    const t = timerOver(gl, 4);
    for (const ms of [8, 9, 10]) {
      expect(t.begin()).toBe(true);
      t.end();
      gl.land(1, ms);
    }
    expect([...t.drain()]).toEqual([8, 9, 10]);
  });

  it("never stalls on a query the GPU has not finished", () => {
    const gl = new FakeGl();
    const t = timerOver(gl, 4);
    t.begin();
    t.end();
    expect([...t.drain()]).toEqual([]);
  });
});

describe("GpuTimer — starvation is counted, not hidden", () => {
  it("counts every frame it could not time", () => {
    const gl = new FakeGl();
    const t = timerOver(gl, 2);
    // Two queries go out and never land; the next three frames are starved.
    for (let i = 0; i < 5; i++) {
      t.begin();
      t.end();
    }
    expect(t.starved).toBe(3);
  });

  it("starves precisely when the GPU is behind — the expensive frames", () => {
    const gl = new FakeGl();
    const t = timerOver(gl, 2);
    // A cheap stretch: results land immediately, nothing is dropped.
    for (let i = 0; i < 10; i++) {
      t.begin();
      t.end();
      gl.land(1, 5);
      t.drain();
    }
    expect(t.starved).toBe(0);
    // Now the GPU falls behind. These are the frames p95/worst are made of,
    // and without the counter they would vanish from the report silently.
    for (let i = 0; i < 10; i++) {
      t.begin();
      t.end();
    }
    expect(t.starved).toBeGreaterThan(0);
  });

  it("resets on demand, so the count is per measurement window", () => {
    const gl = new FakeGl();
    const t = timerOver(gl, 1);
    for (let i = 0; i < 4; i++) {
      t.begin();
      t.end();
    }
    expect(t.starved).toBe(3);
    t.resetStarved();
    expect(t.starved).toBe(0);
  });
});

describe("GpuTimer — a disjoint poisons what was in flight, and only that", () => {
  it("drops results that were in flight when the disjoint was raised", () => {
    const gl = new FakeGl();
    const t = timerOver(gl, 8);
    // Three frames in flight, none landed yet.
    for (let i = 0; i < 3; i++) {
      t.begin();
      t.end();
    }
    // The driver reports a disjoint NOW — while nothing is available. The
    // shipped code read (and cleared) the flag on this drain, discarded
    // nothing, and then reported all three as valid.
    gl.disjoint = true;
    expect([...t.drain()]).toEqual([]);
    gl.land(3, 12);
    expect([...t.drain()]).toEqual([]);
  });

  it("keeps measuring after the disjoint clears", () => {
    const gl = new FakeGl();
    const t = timerOver(gl, 8);
    t.begin();
    t.end();
    gl.disjoint = true;
    t.drain();
    gl.land(1, 99);
    expect([...t.drain()]).toEqual([]);
    // A fresh frame, no disjoint: this one is trustworthy.
    t.begin();
    t.end();
    gl.land(1, 7);
    expect([...t.drain()]).toEqual([7]);
  });

  it("does not poison queries started after the disjoint", () => {
    const gl = new FakeGl();
    const t = timerOver(gl, 8);
    t.begin();
    t.end();
    gl.disjoint = true;
    t.drain(); // latches: 1 in flight is poisoned
    t.begin();
    t.end();
    gl.land(2, 6);
    // The first is dropped, the second survives.
    expect([...t.drain()]).toEqual([6]);
  });
});
