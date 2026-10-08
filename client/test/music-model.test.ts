// Dynamic soundtrack (S2): the pure seam behind music.ts. Invariants under
// test: a nearer threat or a fresher exchange of fire never lowers any
// layer; the state has hysteresis (a threat hovering across 500 m, sporadic
// shots, hp hovering at the threshold never flap it); the conductor applies
// state only on bar lines, at most once per bar, louder at once and calmer
// only after two bars; the clock realigns after a stall without a backlog;
// and the score's worst case stays under the engine's idle level.

import { describe, expect, it } from "vitest";
import {
  BAR_S,
  BarClock,
  CALM,
  CONTACT,
  CONTACT_ENTER_M,
  CONTACT_EXIT_M,
  Conductor,
  DEESCALATE_BARS,
  DOGFIGHT,
  DOGFIGHT_HOLD_S,
  type Intensity,
  LOOKAHEAD_S,
  LOW_HP_ENTER,
  LOW_HP_EXIT,
  type LayerMix,
  type MusicInputs,
  type MusicState,
  WORST_CASE_SUM,
  barIndex,
  calmState,
  emptyMix,
  layerMix,
  nextApplied,
  nextGrid,
  targetState,
} from "../src/audio/music-model";
import {
  MUSIC_LEVEL,
  OWN_ENGINE_IDLE,
  OWN_ENGINE_LEVEL,
} from "../src/audio/sound";

const LAYERS = ["pad", "bass", "drums", "arp"] as const;
const INTENSITIES: Intensity[] = [CALM, CONTACT, DOGFIGHT];
const inputs = (o: Partial<MusicInputs> = {}): MusicInputs => ({
  threatDist: null,
  sinceCombatS: Number.POSITIVE_INFINITY,
  hp: 100,
  alive: true,
  ...o,
});
const mixOf = (prev: MusicState, inp: MusicInputs): LayerMix =>
  layerMix(targetState(prev, inp), emptyMix());
const onGrid = (t: number, step: number) =>
  expect(Math.abs(t / step - Math.round(t / step))).toBeLessThan(1e-9);

describe("targetState / layerMix", () => {
  const prevs: MusicState[] = INTENSITIES.flatMap((intensity) => [
    { intensity, lowHp: false },
    { intensity, lowHp: true },
  ]);
  const DISTS = [null, 2000, 900, 651, 650, 600, 501, 500, 300, 50, 0];
  const SINCE = [Number.POSITIVE_INFINITY, 60, 7, 6.01, 6, 3, 1.01, 1, 0.2, 0];

  it("is monotonic: a nearer threat never lowers any layer", () => {
    for (const prev of prevs) {
      for (const since of SINCE) {
        let last = mixOf(
          prev,
          inputs({ threatDist: null, sinceCombatS: since }),
        );
        for (const d of DISTS.slice(1)) {
          const m = mixOf(prev, inputs({ threatDist: d, sinceCombatS: since }));
          for (const k of LAYERS) expect(m[k]).toBeGreaterThanOrEqual(last[k]);
          expect(m.bright).toBeGreaterThanOrEqual(last.bright);
          last = m;
        }
      }
    }
  });

  it("is monotonic: a fresher exchange of fire never lowers any layer", () => {
    for (const prev of prevs) {
      for (const d of DISTS) {
        let last = mixOf(
          prev,
          inputs({ threatDist: d, sinceCombatS: SINCE[0] }),
        );
        for (const since of SINCE.slice(1)) {
          const m = mixOf(prev, inputs({ threatDist: d, sinceCombatS: since }));
          for (const k of LAYERS) expect(m[k]).toBeGreaterThanOrEqual(last[k]);
          last = m;
        }
      }
    }
  });

  it("layers only ever add as intensity rises", () => {
    for (const lowHp of [false, true]) {
      for (let i = 1; i < INTENSITIES.length; i++) {
        const lo = layerMix(
          { intensity: INTENSITIES[i - 1] as Intensity, lowHp },
          emptyMix(),
        );
        const hi = layerMix(
          { intensity: INTENSITIES[i] as Intensity, lowHp },
          emptyMix(),
        );
        for (const k of LAYERS) expect(hi[k]).toBeGreaterThanOrEqual(lo[k]);
      }
    }
  });

  it("maps the three moods: pad alone, + bass and drums, + arpeggio", () => {
    const calm = mixOf(calmState(), inputs());
    expect([calm.pad, calm.bass, calm.drums, calm.arp]).toEqual([1, 0, 0, 0]);
    const contact = mixOf(calmState(), inputs({ threatDist: 400 }));
    expect(contact.bass).toBe(1);
    expect(contact.drums).toBeGreaterThan(0);
    expect(contact.arp).toBe(0);
    const fight = mixOf(calmState(), inputs({ sinceCombatS: 0 }));
    expect([fight.bass, fight.drums, fight.arp]).toEqual([1, 1, 1]);
  });

  it("dead is calm, with no low-HP drone", () => {
    for (const prev of prevs) {
      const s = targetState(
        prev,
        inputs({ alive: false, threatDist: 10, sinceCombatS: 0, hp: 0 }),
      );
      expect(s).toEqual({ intensity: CALM, lowHp: false });
    }
  });

  it("low HP adds the drone and darkens the pad, and nothing else", () => {
    const healthy = mixOf(calmState(), inputs({ threatDist: 300 }));
    const low = mixOf(
      calmState(),
      inputs({ threatDist: 300, hp: LOW_HP_ENTER - 1 }),
    );
    expect(low.tension).toBe(1);
    expect(healthy.tension).toBe(0);
    expect(low.bright).toBeLessThan(healthy.bright);
    for (const k of LAYERS) expect(low[k]).toBe(healthy[k]);
  });
});

describe("hysteresis (no flapping)", () => {
  /** Run a frame stream through targetState, counting state changes. */
  const run = (
    frames: MusicInputs[],
  ): { changes: number; final: MusicState } => {
    const s = calmState();
    let changes = 0;
    let last = { ...s };
    for (const f of frames) {
      targetState(s, f, s);
      if (s.intensity !== last.intensity || s.lowHp !== last.lowHp) changes++;
      last = { ...s };
    }
    return { changes, final: s };
  };

  it("a threat hovering across the 500 m line enters contact once and stays", () => {
    const frames: MusicInputs[] = [];
    for (let i = 0; i < 600; i++) {
      // 480 ↔ 620 m: crosses the enter line every swing, never the exit line.
      frames.push(inputs({ threatDist: 550 + 70 * Math.sin(i / 7) }));
    }
    const { changes, final } = run(frames);
    expect(changes).toBe(1);
    expect(final.intensity).toBe(CONTACT);
  });

  it("contact leaves only past the exit line", () => {
    const s = targetState(calmState(), inputs({ threatDist: CONTACT_ENTER_M }));
    expect(s.intensity).toBe(CONTACT);
    expect(
      targetState(s, inputs({ threatDist: CONTACT_EXIT_M })).intensity,
    ).toBe(CONTACT);
    expect(
      targetState(s, inputs({ threatDist: CONTACT_EXIT_M + 1 })).intensity,
    ).toBe(CALM);
    expect(
      targetState(calmState(), inputs({ threatDist: CONTACT_ENTER_M + 1 }))
        .intensity,
    ).toBe(CALM);
  });

  it("sporadic fire every few seconds holds one dogfight", () => {
    const frames: MusicInputs[] = [];
    const dt = 1 / 60;
    let lastShot = Number.NEGATIVE_INFINITY;
    for (let t = 0; t < 40; t += dt) {
      // A burst every 4 s (inside the 6 s hold) for 30 s, then silence.
      if (t < 30 && t - lastShot >= 4) lastShot = t;
      frames.push(inputs({ threatDist: 2000, sinceCombatS: t - lastShot }));
    }
    const { changes, final } = run(frames);
    expect(changes).toBe(2); // into the fight, and out once it went quiet
    expect(final.intensity).toBe(CALM);
  });

  it("a stale event does not start a dogfight, but holds a running one", () => {
    const stale = inputs({ sinceCombatS: DOGFIGHT_HOLD_S - 1 });
    expect(targetState(calmState(), stale).intensity).toBe(CALM);
    expect(
      targetState({ intensity: DOGFIGHT, lowHp: false }, stale).intensity,
    ).toBe(DOGFIGHT);
  });

  it("hp hovering at the low-HP line toggles the drone once", () => {
    const frames: MusicInputs[] = [];
    for (let i = 0; i < 300; i++) {
      frames.push(inputs({ hp: LOW_HP_ENTER + 6 * Math.sin(i / 5) }));
    }
    const { changes, final } = run(frames);
    expect(changes).toBe(1);
    expect(final.lowHp).toBe(true);
    const s = { intensity: CALM, lowHp: true } as MusicState;
    expect(targetState(s, inputs({ hp: LOW_HP_EXIT - 1 })).lowHp).toBe(true);
    expect(targetState(s, inputs({ hp: LOW_HP_EXIT })).lowHp).toBe(false);
  });
});

describe("bar-quantised transitions", () => {
  it("nextGrid snaps up to the grid and keeps grid lines", () => {
    expect(nextGrid(0, BAR_S)).toBe(0);
    expect(nextGrid(0.01, BAR_S)).toBe(BAR_S);
    expect(nextGrid(BAR_S * 7, BAR_S)).toBe(BAR_S * 7);
    expect(nextGrid(BAR_S * 7 + 1e-3, BAR_S)).toBe(BAR_S * 8);
    expect(barIndex(BAR_S * 9)).toBe(9);
  });

  it("louder applies at once, calmer only after the dwell", () => {
    expect(nextApplied(CALM, 1, DOGFIGHT)).toBe(DOGFIGHT);
    expect(nextApplied(CONTACT, 1, DOGFIGHT)).toBe(DOGFIGHT);
    expect(nextApplied(DOGFIGHT, DEESCALATE_BARS - 1, CALM)).toBe(DOGFIGHT);
    expect(nextApplied(DOGFIGHT, DEESCALATE_BARS, CALM)).toBe(CALM);
    expect(nextApplied(CONTACT, 9, CONTACT)).toBe(CONTACT);
  });

  /** Drive a conductor at a frame rate against a target timeline. */
  const conduct = (
    target: (t: number) => Intensity,
    seconds: number,
    frame: (i: number) => number = () => 1 / 60,
  ) => {
    const c = new Conductor();
    const bars: { at: number; intensity: Intensity; now: number }[] = [];
    const want = calmState();
    let now = 3.21; // the context has been running a while
    for (let i = 0; now < seconds; i++) {
      want.intensity = target(now);
      for (;;) {
        const at = c.step(now, want);
        if (at === null) break;
        bars.push({ at, intensity: c.applied.intensity, now });
      }
      now += frame(i);
    }
    return bars;
  };

  it("applies state only on bar lines, at most one change per bar", () => {
    // A target flapping every 0.3 s between all three states.
    const flap = (t: number) =>
      INTENSITIES[Math.floor(t / 0.3) % 3] as Intensity;
    const bars = conduct(flap, 60);
    expect(bars.length).toBeGreaterThan(20);
    for (const [i, b] of bars.entries()) {
      onGrid(b.at, BAR_S);
      if (i > 0) expect(b.at - (bars[i - 1]?.at ?? 0)).toBeCloseTo(BAR_S, 9);
    }
    // Calmer never applies before DEESCALATE_BARS bars of the louder state.
    let held = 0;
    for (const [i, b] of bars.entries()) {
      const prev = bars[i - 1]?.intensity ?? CALM;
      if (b.intensity < prev)
        expect(held).toBeGreaterThanOrEqual(DEESCALATE_BARS);
      held = b.intensity === prev ? held + 1 : 1;
    }
  });

  it("a fight that starts mid-bar is heard from the next bar line on", () => {
    const start = 20.7;
    const bars = conduct((t) => (t >= start ? DOGFIGHT : CALM), 30);
    const first = bars.find((b) => b.intensity === DOGFIGHT);
    expect(first).toBeDefined();
    const at = first?.at ?? 0;
    onGrid(at, BAR_S);
    // Decided at most LOOKAHEAD_S ahead of its line, so no more than one bar
    // plus the lookahead after the fight started.
    expect(at).toBeGreaterThan(start);
    expect(at - start).toBeLessThanOrEqual(BAR_S + LOOKAHEAD_S);
  });

  it("long frames (50–250 ms) never skip or double a bar", () => {
    const gaps = [0.05, 0.1, 0.25, 0.016, 0.2, 0.033];
    const bars = conduct(
      () => CONTACT,
      120,
      (i) => gaps[i % gaps.length] ?? 0.05,
    );
    for (const [i, b] of bars.entries()) {
      expect(b.at).toBeGreaterThan(b.now); // never scheduled in the past
      if (i > 0) expect(b.at - (bars[i - 1]?.at ?? 0)).toBeCloseTo(BAR_S, 9);
    }
  });

  it("after a stall (hidden tab) the clock realigns with no backlog", () => {
    const clock = new BarClock();
    const first = clock.due(11.5);
    expect(first).not.toBeNull();
    onGrid(first ?? 0, BAR_S);
    // The context was suspended and resumes 30 s later: one bar, on the grid
    // and in the future — never the 15 bars that were missed.
    const now = 40.3;
    const due: number[] = [];
    for (;;) {
      const at = clock.due(now);
      if (at === null) break;
      due.push(at);
    }
    expect(due.length).toBeLessThanOrEqual(1);
    for (;;) {
      const at = clock.due(now + 1.5);
      if (at === null) break;
      due.push(at);
    }
    expect(due.length).toBe(1);
    onGrid(due[0] ?? 0, BAR_S);
    expect(due[0]).toBeGreaterThan(now);
  });
});

describe("headroom", () => {
  it("the score's worst case stays 6 dB under the own engine at idle", () => {
    const engineIdle = OWN_ENGINE_LEVEL * OWN_ENGINE_IDLE;
    expect(MUSIC_LEVEL * WORST_CASE_SUM).toBeLessThanOrEqual(
      engineIdle * 10 ** (-6 / 20) + 1e-12,
    );
    expect(WORST_CASE_SUM).toBeLessThanOrEqual(1 + 1e-12);
  });

  it("every layer gain stays within 0..1", () => {
    for (const intensity of INTENSITIES) {
      for (const lowHp of [false, true]) {
        const m = layerMix({ intensity, lowHp }, emptyMix());
        for (const v of Object.values(m)) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
