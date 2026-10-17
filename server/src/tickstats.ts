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
  /** E1: the same tick in main-thread CPU time — what the work
   * cost, not what a busy machine's scheduler added to it. */
  cpu: { p50: number; p99: number; max: number };
  /** E1: the tick less the D5/C1 director's phase (its event planning
   * spikes the same with no enemies at all), wall and CPU. */
  core: { p50: number; p99: number; cpuP50: number; cpuP99: number };
}

const percentile = (sorted: number[], q: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** E1: phases the `core` figures leave out. */
const CORE_EXCLUDES = new Set(["director"]);

/** The main thread's CPU time, ms (the tick's own work — not the GC
 * helpers' or the I/O threads'); the process's where Node lacks
 * threadCpuUsage (before 23.9). */
const threadCpu = (
  process as { threadCpuUsage?: () => { user: number; system: number } }
).threadCpuUsage;
const cpuMs = (): number => {
  const u = threadCpu ? threadCpu() : process.cpuUsage();
  return (u.user + u.system) / 1000;
};

export class TickProfiler {
  private readonly totals: number[] = [];
  private readonly cpuTotals: number[] = [];
  private readonly coreTotals: number[] = [];
  private readonly coreCpuTotals: number[] = [];
  private readonly phases = new Map<string, number[]>();
  private readonly current = new Map<string, number>();
  private readonly currentCpu = new Map<string, number>();
  private t0 = 0;
  private last = 0;
  private c0 = 0;
  private lastCpu = 0;

  constructor(readonly enabled: boolean) {}

  begin(): void {
    if (!this.enabled) return;
    this.t0 = this.last = performance.now();
    this.c0 = this.lastCpu = cpuMs();
    this.current.clear();
    this.currentCpu.clear();
  }

  /** Charge the time since the previous lap to `phase` (summed when a
   * phase runs once per room). */
  lap(phase: string): void {
    if (!this.enabled) return;
    const now = performance.now();
    const cpu = cpuMs();
    this.current.set(phase, (this.current.get(phase) ?? 0) + now - this.last);
    this.currentCpu.set(
      phase,
      (this.currentCpu.get(phase) ?? 0) + cpu - this.lastCpu,
    );
    this.last = now;
    this.lastCpu = cpu;
  }

  end(): void {
    if (!this.enabled) return;
    const total = performance.now() - this.t0;
    const cpu = cpuMs() - this.c0;
    push(this.totals, total);
    push(this.cpuTotals, cpu);
    let out = 0;
    let outCpu = 0;
    for (const phase of CORE_EXCLUDES) {
      out += this.current.get(phase) ?? 0;
      outCpu += this.currentCpu.get(phase) ?? 0;
    }
    push(this.coreTotals, total - out);
    push(this.coreCpuTotals, cpu - outCpu);
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
    const by = (series: number[]) => [...series].sort((a, b) => a - b);
    const cpu = by(this.cpuTotals);
    const core = by(this.coreTotals);
    const coreCpu = by(this.coreCpuTotals);
    return {
      ticks: sorted.length,
      p50: round3(percentile(sorted, 0.5)),
      p95: round3(percentile(sorted, 0.95)),
      p99: round3(percentile(sorted, 0.99)),
      max: round3(sorted[sorted.length - 1] ?? 0),
      phases,
      cpu: {
        p50: round3(percentile(cpu, 0.5)),
        p99: round3(percentile(cpu, 0.99)),
        max: round3(cpu[cpu.length - 1] ?? 0),
      },
      core: {
        p50: round3(percentile(core, 0.5)),
        p99: round3(percentile(core, 0.99)),
        cpuP50: round3(percentile(coreCpu, 0.5)),
        cpuP99: round3(percentile(coreCpu, 0.99)),
      },
    };
  }

  reset(): void {
    this.totals.length = 0;
    this.cpuTotals.length = 0;
    this.coreTotals.length = 0;
    this.coreCpuTotals.length = 0;
    this.phases.clear();
  }
}

function push(series: number[], ms: number): void {
  series.push(ms);
  if (series.length > WINDOW) series.shift();
}
