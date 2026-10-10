// A1: the server tick's own cost, phase by phase — off unless
// AB_TICK_STATS=1 (tools/perf/server-tick.mjs sets it and reads
// `GET /debug/tick`). Disabled, every call is one boolean test, so the
// production tick pays nothing for it.
//
// A tick is `begin()`, then `lap(name)` after each phase (the time since the
// previous lap is charged to `name`), then `end()`. The last WINDOW ticks are
// kept, so the report is the recent steady state, not the boot.

const WINDOW = 1200;

export interface TickPhaseStats {
  p50: number;
  p99: number;
  max: number;
  mean: number;
}

export interface TickReport {
  ticks: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  phases: Record<string, TickPhaseStats>;
}

const percentile = (sorted: number[], q: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export class TickProfiler {
  private readonly totals: number[] = [];
  private readonly phases = new Map<string, number[]>();
  private readonly current = new Map<string, number>();
  private t0 = 0;
  private last = 0;

  constructor(readonly enabled: boolean) {}

  begin(): void {
    if (!this.enabled) return;
    this.t0 = this.last = performance.now();
    this.current.clear();
  }

  /** Charge the time since the previous lap to `phase` (summed when a
   * phase runs once per room). */
  lap(phase: string): void {
    if (!this.enabled) return;
    const now = performance.now();
    this.current.set(phase, (this.current.get(phase) ?? 0) + now - this.last);
    this.last = now;
  }

  end(): void {
    if (!this.enabled) return;
    push(this.totals, performance.now() - this.t0);
    for (const [phase, ms] of this.current) {
      let series = this.phases.get(phase);
      if (!series) {
        series = [];
        this.phases.set(phase, series);
      }
      push(series, ms);
    }
  }

  report(): TickReport {
    const sorted = [...this.totals].sort((a, b) => a - b);
    const phases: Record<string, TickPhaseStats> = {};
    for (const [phase, series] of this.phases) {
      const s = [...series].sort((a, b) => a - b);
      phases[phase] = {
        p50: round3(percentile(s, 0.5)),
        p99: round3(percentile(s, 0.99)),
        max: round3(s[s.length - 1] ?? 0),
        mean: round3(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
      };
    }
    return {
      ticks: sorted.length,
      p50: round3(percentile(sorted, 0.5)),
      p95: round3(percentile(sorted, 0.95)),
      p99: round3(percentile(sorted, 0.99)),
      max: round3(sorted[sorted.length - 1] ?? 0),
      phases,
    };
  }

  reset(): void {
    this.totals.length = 0;
    this.phases.clear();
  }
}

function push(series: number[], ms: number): void {
  series.push(ms);
  if (series.length > WINDOW) series.shift();
}
