// X1 QA (`__ab.chaosMeter`, main.ts): how much war the player can see or
// hear, second by second — the chaos audit's one number. QA only: main.ts
// feeds it only while it is armed (the first `__ab.chaosMeter()` call), so
// a plain visit never pays for the sampling.
//
// Every ~CHAOS_SAMPLE_MS main.ts counts, per kind, what is on screen (in
// the view frustum, within that kind's draw range) or audible (within
// CHAOS_AUDIBLE_M, any direction) right now — `sample()` — and notes the
// one-off events as they happen (`note()`: a radio callout going on air, a
// headline on the screens). Each wall-clock second keeps, per kind, the
// PEAK of its samples (for a presence kind) or the SUM (for an event).
//
// A second is DEAD when no LIVE kind showed in it: no explosion, collapse,
// tracer, plane, real airship, falling debris, flak, strike in the air,
// dogfight, flak or kill in the painted sky, or radio callout. Fires and
// the cosmetic armada are reported but are AMBIENT — a sky of distant
// hulls over a burning block is the backdrop, not something happening. The
// audit's target is a longest dead run of at most CHAOS_DEAD_MAX_S.
//
// A second is also NEAR-DEAD when only the painted sky and the radio
// filled it: no REAL thing (CHAOS_NEAR_KINDS — the simulated war inside
// the fog) showed. That is the stricter number the tuning works on: the
// cosmetic sky is always there to fill a view, the real war is not.

/** Every kind the meter counts, in report order. */
export const CHAOS_KINDS = [
  "explosions",
  "collapses",
  "tracers",
  "planesReal",
  "airshipsReal",
  "debris",
  "flak",
  "strikes",
  "planesCosmetic",
  "skyTracers",
  "skyFlak",
  "skyKills",
  "airshipsCosmetic",
  "fires",
  "radio",
  "headlines",
] as const;
export type ChaosKind = (typeof CHAOS_KINDS)[number];

/** Kinds noted as one-off events (summed per second); the rest are
 * sampled presence (peak per second). */
export const CHAOS_EVENT_KINDS: readonly ChaosKind[] = ["radio", "headlines"];
/** Kinds that do NOT make a second live on their own. */
export const CHAOS_AMBIENT_KINDS: readonly ChaosKind[] = [
  "airshipsCosmetic",
  "fires",
  "headlines",
];

/** The real war's kinds: one of these makes a second near-live. */
export const CHAOS_NEAR_KINDS: readonly ChaosKind[] = [
  "explosions",
  "collapses",
  "tracers",
  "planesReal",
  "airshipsReal",
  "debris",
  "flak",
  "strikes",
];

/** The rolling window `__ab.chaosMeter()` reports, s. */
export const CHAOS_WINDOW_S = 10;
/** Seconds of history kept (a whole scripted flight). */
export const CHAOS_HISTORY_S = 240;
/** How often main.ts samples, ms of the frame clock. */
export const CHAOS_SAMPLE_MS = 250;
/** Heard from any direction within this, m (a blast's rumble, flak). */
export const CHAOS_AUDIBLE_M = 450;
/** The audit's target: no longer run of dead seconds than this. */
export const CHAOS_DEAD_MAX_S = 3;

const KINDS = CHAOS_KINDS.length;
const index = new Map<ChaosKind, number>(CHAOS_KINDS.map((k, i) => [k, i]));
const isEvent = CHAOS_KINDS.map((k) => CHAOS_EVENT_KINDS.includes(k));
const isLive = CHAOS_KINDS.map((k) => !CHAOS_AMBIENT_KINDS.includes(k));
const isNear = CHAOS_KINDS.map((k) => CHAOS_NEAR_KINDS.includes(k));

/** One kind over a span of seconds. */
export interface ChaosKindStats {
  /** Seconds it showed in. */
  seconds: number;
  /** The most at once (presence) or in one second (events). */
  peak: number;
  /** Per-second values summed (events: how many there were). */
  total: number;
}

export interface ChaosSpan {
  /** Whole seconds covered. */
  seconds: number;
  deadSeconds: number;
  /** The longest run of consecutive dead seconds. */
  longestDead: number;
  /** Seconds with nothing REAL in them, and their longest run. */
  nearDeadSeconds: number;
  longestNearDead: number;
  /** Which seconds were dead and near-dead (offsets from the span's
   * first second). */
  deadAt: number[];
  nearDeadAt: number[];
  /** Seconds no sample landed in (a hitch longer than a second): each
   * takes the sample that ended it, and they are counted here. */
  unsampled: number;
  kinds: Record<ChaosKind, ChaosKindStats>;
}

export interface ChaosReport {
  /** The last CHAOS_WINDOW_S complete seconds. */
  window: ChaosSpan;
  /** Every complete second since the last reset (up to CHAOS_HISTORY_S). */
  sinceReset: ChaosSpan;
  /** The window second by second, oldest first: live, and each kind. */
  timeline: {
    live: boolean;
    near: boolean;
    counts: Record<ChaosKind, number>;
  }[];
}

export class ChaosMeter {
  /** Whether main.ts samples (the first `__ab.chaosMeter()` arms it). */
  armed = false;
  /** Per second (ring of CHAOS_HISTORY_S), per kind. */
  private readonly ring = new Float32Array(CHAOS_HISTORY_S * KINDS);
  private readonly sampled = new Uint8Array(CHAOS_HISTORY_S);
  private readonly filled = new Uint8Array(CHAOS_HISTORY_S);
  /** This sample's counts, written by main.ts through `set`. */
  private readonly cur = new Float32Array(KINDS);
  /** Events noted since the last commit. */
  private readonly events = new Float32Array(KINDS);
  /** The second the history starts at, and the last one sampled. */
  private startSec = Number.NaN;
  private lastSec = Number.NaN;
  private nextSampleAt = Number.NEGATIVE_INFINITY;

  /** Forget everything; the history starts at `nowMs`'s second. */
  reset(nowMs: number): void {
    this.ring.fill(0);
    this.sampled.fill(0);
    this.filled.fill(0);
    this.events.fill(0);
    this.startSec = Math.floor(nowMs / 1000);
    this.lastSec = this.startSec - 1;
    this.nextSampleAt = Number.NEGATIVE_INFINITY;
  }

  /** Whether a sample is due at `nowMs` (main.ts then counts and calls
   * `set` for each kind, then `commit`). */
  due(nowMs: number): boolean {
    if (!this.armed) return false;
    if (Number.isNaN(this.startSec)) this.reset(nowMs);
    if (nowMs < this.nextSampleAt) return false;
    this.nextSampleAt = nowMs + CHAOS_SAMPLE_MS;
    this.cur.fill(0);
    return true;
  }

  /** This sample's count of `kind`. */
  set(kind: ChaosKind, n: number): void {
    this.cur[index.get(kind) as number] = n;
  }

  /** Fold the sample into its second (and any seconds a hitch skipped). */
  commit(nowMs: number): void {
    const sec = Math.floor(nowMs / 1000);
    if (sec - this.lastSec > CHAOS_HISTORY_S) this.lastSec = sec - 1;
    for (let s = this.lastSec + 1; s < sec; s++) {
      // A second with no sample of its own takes this one, flagged.
      this.clearSec(s);
      this.fold(s);
    }
    if (sec > this.lastSec) this.clearSec(sec);
    this.fold(sec);
    // The events noted since the last sample land in this one's second.
    const o = this.slot(sec) * KINDS;
    for (let k = 0; k < KINDS; k++) {
      const n = this.events[k] as number;
      if (n > 0) this.ring[o + k] = (this.ring[o + k] as number) + n;
    }
    this.events.fill(0);
    this.sampled[this.slot(sec)] = 1;
    this.lastSec = Math.max(this.lastSec, sec);
  }

  /** A one-off event of `kind` (an event kind), counted in the next
   * sample's second (a frame later at most). */
  note(kind: ChaosKind): void {
    if (!this.armed || Number.isNaN(this.startSec)) return;
    const k = index.get(kind) as number;
    this.events[k] = (this.events[k] as number) + 1;
  }

  /** The window and the history up to (not including) `nowMs`'s second. */
  report(nowMs: number): ChaosReport {
    const end = Math.min(Math.floor(nowMs / 1000) - 1, this.lastSec);
    const from = Number.isNaN(this.startSec)
      ? end + 1
      : Math.max(this.startSec, end - CHAOS_HISTORY_S + 1);
    const winFrom = Math.max(from, end - CHAOS_WINDOW_S + 1);
    const timeline: ChaosReport["timeline"] = [];
    for (let s = winFrom; s <= end; s++) {
      const counts = {} as Record<ChaosKind, number>;
      for (let k = 0; k < KINDS; k++) {
        counts[CHAOS_KINDS[k] as ChaosKind] = this.at(s, k);
      }
      timeline.push({
        live: this.live(s, isLive),
        near: this.live(s, isNear),
        counts,
      });
    }
    return {
      window: this.span(winFrom, end),
      sinceReset: this.span(from, end),
      timeline,
    };
  }

  private slot(sec: number): number {
    return ((sec % CHAOS_HISTORY_S) + CHAOS_HISTORY_S) % CHAOS_HISTORY_S;
  }

  private at(sec: number, k: number): number {
    return this.ring[this.slot(sec) * KINDS + k] as number;
  }

  private clearSec(sec: number): void {
    const o = this.slot(sec);
    this.ring.fill(0, o * KINDS, (o + 1) * KINDS);
    this.sampled[o] = 0;
    this.filled[o] = 1;
  }

  /** The sample into second `sec`: presence by peak (events stay summed). */
  private fold(sec: number): void {
    const o = this.slot(sec) * KINDS;
    for (let k = 0; k < KINDS; k++) {
      if (isEvent[k]) continue;
      const v = this.cur[k] as number;
      if (v > (this.ring[o + k] as number)) this.ring[o + k] = v;
    }
  }

  /** Whether a kind `which` marks showed in second `sec`. */
  private live(sec: number, which: readonly boolean[]): boolean {
    for (let k = 0; k < KINDS; k++) {
      if (which[k] && this.at(sec, k) > 0) return true;
    }
    return false;
  }

  private span(from: number, to: number): ChaosSpan {
    const kinds = {} as Record<ChaosKind, ChaosKindStats>;
    for (const k of CHAOS_KINDS) kinds[k] = { seconds: 0, peak: 0, total: 0 };
    let seconds = 0;
    let dead = 0;
    let run = 0;
    let longest = 0;
    let nearDead = 0;
    let nearRun = 0;
    let nearLongest = 0;
    const deadAt: number[] = [];
    const nearDeadAt: number[] = [];
    let unsampled = 0;
    for (let s = from; s <= to; s++) {
      if (!this.filled[this.slot(s)]) continue;
      seconds++;
      if (!this.sampled[this.slot(s)]) unsampled++;
      for (let k = 0; k < KINDS; k++) {
        const v = this.at(s, k);
        if (v <= 0) continue;
        const st = kinds[CHAOS_KINDS[k] as ChaosKind];
        st.seconds++;
        st.total += v;
        if (v > st.peak) st.peak = v;
      }
      if (this.live(s, isLive)) run = 0;
      else {
        dead++;
        deadAt.push(s - from);
        run++;
        if (run > longest) longest = run;
      }
      if (this.live(s, isNear)) nearRun = 0;
      else {
        nearDead++;
        nearDeadAt.push(s - from);
        nearRun++;
        if (nearRun > nearLongest) nearLongest = nearRun;
      }
    }
    return {
      seconds,
      deadSeconds: dead,
      longestDead: longest,
      nearDeadSeconds: nearDead,
      longestNearDead: nearLongest,
      deadAt,
      nearDeadAt,
      unsampled,
      kinds,
    };
  }
}
