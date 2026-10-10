// A1 street performers' music: a plucked-guitar arpeggio from the performer
// nearest the plane, panned and faded with distance, riding the L2 city bus
// (so it shares its level, the combat duck and the radio duck).
//
// Synthesized, no files (PLAN.md's licence rule). Built ONCE on the first
// frame the context runs: two persistent oscillators through one pluck
// envelope and a low-pass; each note only re-points frequencies and
// re-triggers the envelope, scheduled just ahead of its beat — no node churn.
// One voice at a time, by design: the nearest busker is the one you hear.

import type { Vec3 } from "@angels-bandits/common/world";
import {
  BAR_S,
  EIGHTH_S,
  PROGRESSION_LENGTH,
  barIndex,
  nextGrid,
} from "./music-model";
import { rampTo } from "./ramp";
import { spatialize } from "./spatial";

/** Share of the city bus at the performer's feet. */
const BUSKER_WEIGHT = 0.55;
/** Full level inside this distance, silent past BUSKER_FAR (3D), meters. */
const BUSKER_NEAR = 10;
export const BUSKER_FAR = 75;
/** Eighth notes on the S2 soundtrack's 120 bpm grid. */
const NOTE_S = EIGHTH_S;
/** Am – F – C – G, four bars of eight plucks: root, fifth, octave, third…
 * — the same chord on the same bar as the score and the plaza pad. */
const CHORDS: readonly (readonly number[])[] = [
  [110, 164.81, 220, 261.63, 329.63, 261.63, 220, 164.81],
  [87.31, 130.81, 174.61, 220, 261.63, 220, 174.61, 130.81],
  [130.81, 196, 261.63, 329.63, 392, 329.63, 261.63, 196],
  [98, 146.83, 196, 246.94, 293.66, 246.94, 196, 146.83],
];

interface Voice {
  ctx: AudioContext;
  out: GainNode;
  pan: StereoPannerNode;
  env: GainNode;
  body: OscillatorNode;
  shimmer: OscillatorNode;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Distance gain of a busker heard at `d` meters (0..1). Pure. */
export const buskerGain = (d: number): number =>
  1 - smooth(BUSKER_NEAR, BUSKER_FAR, d);

export class Busker {
  private voice: Voice | null = null;
  private nextNoteAt = 0;
  private level = 0;

  constructor(private readonly city: { readonly bus: GainNode | null }) {}

  /**
   * Per frame. `source` is the nearest performer (render-space, any torus
   * image) or null; `listener`/`yaw` the plane.
   */
  update(listener: Vec3, yaw: number, source: Vec3 | null): void {
    const sp = source ? spatialize(listener, yaw, source) : null;
    this.level = sp ? buskerGain(sp.distance) : 0;
    const bus = this.city.bus;
    if (!bus) return;
    if (!this.voice) this.voice = build(bus);
    const v = this.voice;
    const now = v.ctx.currentTime;
    rampTo(v.out.gain, BUSKER_WEIGHT * this.level, now, 0.25);
    if (sp) rampTo(v.pan.pan, sp.pan, now, 0.1);
    if (this.level <= 0.001) return;
    // Schedule each pluck just ahead of its beat, on the shared grid (after
    // a hidden tab, pick the beat back up rather than firing a backlog).
    if (now > this.nextNoteAt) this.nextNoteAt = nextGrid(now, NOTE_S);
    while (now + 0.12 >= this.nextNoteAt) {
      const at = this.nextNoteAt;
      const barAt = Math.floor(at / BAR_S + 1e-6) * BAR_S;
      const bar = CHORDS[barIndex(barAt) % PROGRESSION_LENGTH] ?? [];
      const f = bar[Math.round((at - barAt) / NOTE_S) % 8] ?? 220;
      v.body.frequency.setValueAtTime(f, at);
      v.shimmer.frequency.setValueAtTime(f * 2, at);
      v.env.gain.cancelScheduledValues(at);
      v.env.gain.setValueAtTime(0.0001, at);
      v.env.gain.linearRampToValueAtTime(1, at + 0.006);
      v.env.gain.exponentialRampToValueAtTime(0.02, at + NOTE_S * 1.6);
      this.nextNoteAt += NOTE_S;
    }
  }

  /** QA: the current distance gain (0 when nobody is in earshot). */
  get gain(): number {
    return this.level;
  }
}

function build(bus: GainNode): Voice {
  const ctx = bus.context as AudioContext;
  const out = ctx.createGain();
  out.gain.value = 0;
  const pan = ctx.createStereoPanner();
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 2200;
  tone.Q.value = 0.7;
  const env = ctx.createGain();
  env.gain.value = 0;
  const body = ctx.createOscillator();
  body.type = "triangle";
  const shimmer = ctx.createOscillator();
  shimmer.type = "sine";
  const shimmerLevel = ctx.createGain();
  shimmerLevel.gain.value = 0.25;
  body.connect(env);
  shimmer.connect(shimmerLevel).connect(env);
  env.connect(tone).connect(pan).connect(out).connect(bus);
  body.start();
  shimmer.start();
  return { ctx, out, pan, env, body, shimmer };
}
