// GPU frame-cost probe (P1) — dev/QA only, off unless `?gputime=1`.
//
// Wall-clock frame deltas measure the WHOLE pipeline, this process and every
// other one on the machine. Both P1 render wins are GPU bandwidth changes,
// and on a loaded laptop a 2 ms GPU saving disappears under a 100 ms
// scheduling spike that has nothing to do with the renderer. EXT_disjoint_-
// timer_query_webgl2 times the work between begin() and end() on the GPU's
// own clock instead, so a contended CPU cannot move the number.
//
// It is not on by default because a query object per in-flight frame is real
// driver state, and because a disjoint (a GPU context switch, a power-state
// change) silently poisons results — a measurement tool may pay attention to
// that, the game should not have to.
//
// Only ONE TIME_ELAPSED query may be active at a time, hence the single
// `active` slot plus a FIFO of queries waiting on the GPU to catch up.

/** `ext.TIME_ELAPSED_EXT` — the query target, in nanoseconds. */
const TIME_ELAPSED_EXT = 0x88bf;
/** `ext.GPU_DISJOINT_EXT` — set when the GPU did something that invalidates
 * every in-flight timing. Reading it clears it. */
const GPU_DISJOINT_EXT = 0x8fbb;

export class GpuTimer {
  private readonly free: WebGLQuery[] = [];
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** Reused by drain() so polling never allocates. */
  private readonly out: number[] = [];

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    capacity: number,
  ) {
    for (let i = 0; i < capacity; i++) {
      const query = gl.createQuery();
      if (query) this.free.push(query);
    }
  }

  /**
   * A timer over `gl`, or null where the extension is missing (most mobile
   * drivers, and desktop Chrome with the GPU sandbox tightened). Callers
   * must treat null as "no GPU numbers", never as an error.
   */
  static create(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    capacity = 6,
  ): GpuTimer | null {
    const isWebGL2 =
      typeof WebGL2RenderingContext !== "undefined" &&
      gl instanceof WebGL2RenderingContext;
    if (!isWebGL2) return null;
    const gl2 = gl as WebGL2RenderingContext;
    if (gl2.getExtension("EXT_disjoint_timer_query_webgl2") === null) {
      return null;
    }
    return new GpuTimer(gl2, capacity);
  }

  /** Open a query around this frame's draw calls. False when none is free. */
  begin(): boolean {
    if (this.active !== null) return false;
    const query = this.free.pop();
    if (query === undefined) return false;
    this.gl.beginQuery(TIME_ELAPSED_EXT, query);
    this.active = query;
    return true;
  }

  /** Close the query opened by begin(). Safe to call when none is open. */
  end(): void {
    if (this.active === null) return;
    this.gl.endQuery(TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /**
   * GPU times (ms) for every query the GPU has finished, oldest first.
   * The array is reused — copy it if you need to keep it. Results are
   * dropped entirely when the driver reports a disjoint, because a poisoned
   * number is worse than a missing one.
   */
  drain(): readonly number[] {
    this.out.length = 0;
    const disjoint = this.gl.getParameter(GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length > 0) {
      const query = this.pending[0] as WebGLQuery;
      const ready = this.gl.getQueryParameter(
        query,
        this.gl.QUERY_RESULT_AVAILABLE,
      ) as boolean;
      if (!ready) break;
      this.pending.shift();
      if (!disjoint) {
        const ns = this.gl.getQueryParameter(
          query,
          this.gl.QUERY_RESULT,
        ) as number;
        this.out.push(ns / 1e6);
      }
      this.free.push(query);
    }
    return this.out;
  }
}
