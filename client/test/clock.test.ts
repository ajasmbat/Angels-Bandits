// The smoothed render clock and the fixed pose cadence (O2). Both are pure —
// every time below is a plain number — so these are the exact frame timings a
// client would see, jitter included, with no fake timers.
//
// The last block replays a whole remote-plane pipeline (sender frames →
// pose upload → server ticks → snapshot arrival → interpolation → receiver
// frames) through the OLD timing and the NEW one, and measures the jerk the
// receiver would draw. That is the GPU-independent half of the two-tab QA.

import { mulberry32 } from "@angels-bandits/common/city";
import { POSE_AGE_MAX_MS } from "@angels-bandits/common/constants";
import type { Pose } from "@angels-bandits/common/protocol";
import { describe, expect, it } from "vitest";
import {
  PoseCadence,
  RENDER_CLOCK_SLEW,
  RENDER_CLOCK_SNAP_MS,
  RenderClock,
} from "../src/net/clock";
import { InterpDelay } from "../src/net/delay";
import { InterpolationBuffer } from "../src/net/interp";

/** Jittered frame timestamps: ~60 fps with ±`jitter` ms of wobble. */
const frames = (
  seconds: number,
  seed = 7,
  mean = 1000 / 60,
  jitter = 4,
): number[] => {
  const rand = mulberry32(seed);
  const out: number[] = [];
  for (let t = 1000; t < 1000 + seconds * 1000; ) {
    out.push(t);
    t += mean + (rand() * 2 - 1) * jitter;
  }
  return out;
};

/** Drive a clock over `times` with target(t); returns the clock's values. */
const drive = (times: number[], target: (t: number) => number): number[] => {
  const clock = new RenderClock();
  return times.map((t) => clock.advance(t, target(t)));
};

/** Every frame-to-frame rate of `values` over `times`. */
const rates = (times: number[], values: number[]): number[] =>
  values.slice(1).map((v, i) => {
    const dt = (times[i + 1] as number) - (times[i] as number);
    return (v - (values[i] as number)) / dt;
  });

const EPS = 1e-9;

describe("RenderClock", () => {
  it("starts on its target and then runs at real time while the target does", () => {
    const times = frames(3);
    const values = drive(times, (t) => t + 5000);
    expect(values[0]).toBe((times[0] as number) + 5000);
    for (const r of rates(times, values)) expect(r).toBeCloseTo(1, 9);
  });

  for (const jump of [40, -40]) {
    it(`never decreases and stays within ±5 % of real time while converging after a ${jump > 0 ? "+" : "−"}40 ms jump`, () => {
      const times = frames(6);
      const stepAt = times[60] as number;
      const values = drive(times, (t) => t + 5000 + (t >= stepAt ? jump : 0));
      for (const r of rates(times, values)) {
        expect(r).toBeGreaterThanOrEqual(1 - RENDER_CLOCK_SLEW - EPS);
        expect(r).toBeLessThanOrEqual(1 + RENDER_CLOCK_SLEW + EPS);
      }
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] as number);
      }
      // Converged: within a millisecond of the target well before the end.
      const last = times.length - 1;
      const error =
        (times[last] as number) + 5000 + jump - (values[last] as number);
      expect(Math.abs(error)).toBeLessThan(1);
      // ...and it actually USED the slew rather than jumping: shortly after
      // the step it is still most of the way from its target.
      const soon = times.findIndex((t) => t >= stepAt + 100);
      const early =
        (times[soon] as number) + 5000 + jump - (values[soon] as number);
      expect(Math.abs(early)).toBeGreaterThan(Math.abs(jump) * 0.75);
    });
  }

  it("does not overshoot: the error never changes sign while it converges", () => {
    const times = frames(6);
    const stepAt = times[30] as number;
    const values = drive(times, (t) => t + (t >= stepAt ? 40 : 0));
    const errors = times.map(
      (t, i) => t + (t >= stepAt ? 40 : 0) - (values[i] as number),
    );
    for (const e of errors) expect(e).toBeGreaterThanOrEqual(-EPS);
  });

  it("tracks a slowly drifting-down target (clock-offset adaptation) within a few ms", () => {
    // The offset estimate adapts downward a little per snapshot; model a
    // steady 2 ms/s drift — the clock must not lag it into a thin buffer.
    const times = frames(20);
    const target = (t: number) => t - (t - 1000) * 0.002;
    const values = drive(times, target);
    times.forEach((t, i) => {
      expect(Math.abs(target(t) - (values[i] as number))).toBeLessThan(3);
    });
  });

  it("snaps FORWARD past a huge lag rather than slewing for seconds", () => {
    const clock = new RenderClock();
    clock.advance(1000, 1000);
    clock.advance(1016, 1016);
    const v = clock.advance(1032, 1032 + RENDER_CLOCK_SNAP_MS + 750);
    expect(v).toBe(1032 + RENDER_CLOCK_SNAP_MS + 750);
  });

  it("holds still — never steps back — when far AHEAD of its target", () => {
    const clock = new RenderClock();
    clock.advance(1000, 1000);
    const held = clock.advance(1016, 1016);
    // The target falls a full second back: the clock stops, it does not rewind.
    let prev = held;
    let t = 1016;
    for (let i = 0; i < 200; i++) {
      t += 16;
      const v = clock.advance(t, t - 1000);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // Rate 0 until inside the slew band, then converges as usual.
    const v = clock.advance(t + 16, t + 16 - 1000);
    expect(t + 16 - 1000 - v).toBeGreaterThan(-RENDER_CLOCK_SNAP_MS - 1);
  });

  it("restarts on its target after reset()", () => {
    const clock = new RenderClock();
    clock.advance(1000, 1000);
    clock.reset();
    expect(clock.time).toBeNull();
    expect(clock.advance(2000, 9000)).toBe(9000);
  });
});

describe("PoseCadence", () => {
  it("fires at a fixed 30 Hz without drift over 10 s of jittered frames", () => {
    const cadence = new PoseCadence(1000 / 30);
    const times = frames(10, 11, 1000 / 60, 6);
    const sent = times.filter((t) => cadence.due(t));
    const span = (times[times.length - 1] as number) - (times[0] as number);
    // One send per interval over the whole span, give or take the edges.
    expect(Math.abs(sent.length - (span / 1000) * 30)).toBeLessThanOrEqual(1);
    // No drift: the n-th send is never more than one frame off n intervals.
    sent.forEach((t, n) => {
      const ideal = (sent[0] as number) + (n * 1000) / 30;
      expect(t - ideal).toBeGreaterThanOrEqual(-EPS);
      expect(t - ideal).toBeLessThan(1000 / 60 + 6 + EPS);
    });
  });

  it("holds 30 Hz at uneven frame rates too (45 fps)", () => {
    const cadence = new PoseCadence(1000 / 30);
    const times = frames(10, 3, 1000 / 45, 3);
    const sent = times.filter((t) => cadence.due(t)).length;
    const span = (times[times.length - 1] as number) - (times[0] as number);
    expect(Math.abs(sent - (span / 1000) * 30)).toBeLessThanOrEqual(1);
  });

  it("restarts after a stall instead of bursting the missed sends", () => {
    const cadence = new PoseCadence(1000 / 30);
    expect(cadence.due(1000)).toBe(true);
    expect(cadence.due(3000)).toBe(true); // a 2 s hidden-tab gap
    expect(cadence.due(3016)).toBe(false);
    expect(cadence.due(3020)).toBe(false);
    expect(cadence.due(3034)).toBe(true);
  });
});

// --- The whole pipeline, old timing vs new --------------------------------

const SERVER_OFFSET = 50_000; // server clock − local clocks
const SPEED = 0.1; // m per ms (100 m/s)

interface Sent {
  arrive: number; // server clock
  pose: Pose;
  t: number | null; // pose stamp (server clock), null on the old wire
}

const poseAt = (x: number): Pose => ({
  pos: { x, y: 300, z: 500 },
  quat: { x: 0, y: 0, z: 0, w: 1 },
  speed: 100,
});

/** p95 of the receiver's per-frame second difference of drawn position. */
function replayJerk(mode: "old" | "new", seed: number): number {
  const rand = mulberry32(seed);
  const duration = 12_000;
  // Sender A: ~60 fps frames; old wire = lastSent=now at 20 Hz, new = 30 Hz
  // fixed cadence stamped with A's (smoothed, so constant-offset) estimate.
  const sent: Sent[] = [];
  const cadence = new PoseCadence(1000 / 30);
  let lastSent = Number.NEGATIVE_INFINITY;
  for (let t = 0; t < duration; t += 1000 / 60 + (rand() * 2 - 1) * 3) {
    const pose = poseAt(100 + SPEED * t);
    const uplink = 12 + rand() * 18;
    if (mode === "old") {
      if (t - lastSent < 50) continue;
      lastSent = t;
      sent.push({ arrive: t + SERVER_OFFSET + uplink, pose, t: null });
    } else if (cadence.due(t)) {
      // A's estimate of server now lags the truth by its min downlink.
      sent.push({
        arrive: t + SERVER_OFFSET + uplink,
        pose,
        t: t + SERVER_OFFSET - 10,
      });
    }
  }
  sent.sort((a, b) => a.arrive - b.arrive);

  // Server: 20 Hz ticks (with a little scheduling wobble) snapshot the
  // newest pose that has arrived; snapshots reach B with downlink jitter.
  const snaps: { arrive: number; time: number; pose: Pose; age: number }[] = [];
  let k = 0;
  let latest: Sent | null = null;
  let poseTime = 0;
  for (
    let tick = SERVER_OFFSET + 200;
    tick < SERVER_OFFSET + duration;
    tick += 50 + (rand() * 2 - 1) * 2
  ) {
    while (k < sent.length && (sent[k] as Sent).arrive <= tick) {
      latest = sent[k] as Sent;
      const t = latest.t;
      poseTime =
        t === null
          ? latest.arrive
          : Math.min(
              latest.arrive,
              Math.max(latest.arrive - POSE_AGE_MAX_MS, t),
            );
      k++;
    }
    if (!latest) continue;
    const time = Math.round(tick);
    snaps.push({
      arrive: tick - SERVER_OFFSET + 10 + rand() * 15,
      time,
      pose: latest.pose,
      age: mode === "old" ? 0 : Math.round(time - poseTime),
    });
  }
  snaps.sort((a, b) => a.arrive - b.arrive);

  // Receiver B: the socket's offset estimator + delay controller, then
  // either the raw render time (old) or the smoothed per-remote clock (new).
  const delay = new InterpDelay();
  const buffer = new InterpolationBuffer();
  const global = new RenderClock();
  const own = new RenderClock();
  let offset: number | null = null;
  let lagPeak = 0;
  let s = 0;
  const drawn: number[] = [];
  for (let f = 0; f < duration; f += 1000 / 60 + (rand() * 2 - 1) * 3) {
    while (s < snaps.length && (snaps[s] as { arrive: number }).arrive <= f) {
      const snap = snaps[s++] as (typeof snaps)[number];
      delay.observe(snap.arrive);
      const sample = snap.time - snap.arrive;
      offset =
        offset === null || sample > offset
          ? sample
          : offset + (sample - offset) * 0.02;
      lagPeak =
        snap.age > lagPeak ? snap.age : lagPeak + (snap.age - lagPeak) * 0.02;
      buffer.push(snap.time - snap.age, snap.pose);
    }
    if (offset === null) continue;
    const target = f + offset - delay.delayMs;
    let at: number;
    if (mode === "old") {
      at = target;
    } else {
      global.advance(f, target);
      at = own.advance(f, target - lagPeak);
    }
    const p = buffer.sample(at);
    if (p && f > 2000) drawn.push(p.pos.x);
  }
  const jerk = drawn
    .slice(2)
    .map((x, i) =>
      Math.abs(x - 2 * (drawn[i + 1] as number) + (drawn[i] as number)),
    )
    .sort((a, b) => a - b);
  return jerk[Math.floor(jerk.length * 0.95)] as number;
}

describe("remote-plane jerk, old timing vs O2 (GPU-independent two-tab replay)", () => {
  it("cuts the p95 per-frame jerk of a remote by at least half", () => {
    for (const seed of [1, 2, 3]) {
      const before = replayJerk("old", seed);
      const after = replayJerk("new", seed);
      expect(before).toBeGreaterThan(0);
      expect(after).toBeLessThanOrEqual(before * 0.5);
    }
  });
});
