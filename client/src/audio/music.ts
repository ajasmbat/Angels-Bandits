// Dynamic soundtrack (S2): the WebAudio adapter over music-model.ts. All
// synthesized, no files (PLAN.md's licence rule): a saw pad, a filtered saw
// bass, a sine kick and noise snare/hats, a square arpeggio with a dotted-
// eighth echo, a detuned low-HP drone, and three stings (victory, low-HP
// drop, swell).
//
// Every node is built ONCE, on the first frame the context runs (so nothing
// starts before the join gesture), and every source runs forever behind an
// envelope gain: a note only re-points a frequency and re-triggers its
// envelope — no node churn. Bars are scheduled a beat ahead on the shared
// 120 bpm grid; layer levels crossfade over one beat from each bar line. The
// score feeds GameAudio's music input, which ducks under the radio voice.

import { mulberry32 } from "@angels-bandits/common/city";
import {
  BAR_S,
  BEAT_S,
  Conductor,
  DOGFIGHT,
  EIGHTH_S,
  type Intensity,
  KICK,
  KICK_FIGHT,
  type LayerMix,
  MUSIC_WEIGHTS,
  type MusicState,
  SNARE,
  STEPS_PER_BAR,
  STEP_S,
  arpNote,
  barIndex,
  bassNote,
  calmState,
  emptyMix,
  hatOn,
  layerMix,
  nextGrid,
  padChord,
  targetState,
} from "./music-model";
import type { MixBus } from "./sound";

/** A moment the score marks with a sting. `swell` is for D3/D5 building
 * collapses and the S4 sky boss's entrance. */
export type MusicMoment = "victory" | "drop" | "swell";

/** What the frame loop knows this frame. */
export interface MusicFrame {
  /** performance.now() — the clock noteCombat() stamps with. */
  nowMs: number;
  /** Distance to the nearest living remote plane, or null if none. */
  threatDist: number | null;
  hp: number;
  alive: boolean;
}

/** Envelope peaks inside each layer (each layer's voices sum to ≤ 1). */
const KICK_PEAK = 0.55;
const SNARE_PEAK = 0.28;
const HAT_PEAK = 0.12;
const HAT_ACCENT = 0.17;
const PAD_VOICE = 1 / 3;
const ARP_DRY = 0.7;
const ARP_WET = 0.3;
/** Pad filter cutoff from `bright` 0..1, Hz. */
const PAD_DARK_HZ = 500;
const PAD_BRIGHT_HZ = 2600;
/** Seconds of seeded noise for the drums and the swell. */
const NOISE_SECONDS = 2;
const NOISE_SALT = 0x5c0e2a;
/** One sting of a kind per bar at most. */
const STING_GAP_S = BAR_S;

interface Graph {
  ctx: AudioContext;
  input: GainNode;
  pad: GainNode;
  padOsc: OscillatorNode[];
  padFilter: BiquadFilterNode;
  bass: GainNode;
  bassOsc: OscillatorNode;
  bassEnv: GainNode;
  drums: GainNode;
  kickOsc: OscillatorNode;
  kickEnv: GainNode;
  snareEnv: GainNode;
  hatEnv: GainNode;
  arp: GainNode;
  arpOsc: OscillatorNode;
  arpEnv: GainNode;
  tension: GainNode;
  winOsc: OscillatorNode;
  winEnv: GainNode;
  dropOsc: OscillatorNode;
  dropEnv: GainNode;
  swellEnv: GainNode;
  swellFilter: BiquadFilterNode;
  impactOsc: OscillatorNode;
  impactEnv: GainNode;
}

export class Music {
  private graph: Graph | null = null;
  private readonly conductor = new Conductor();
  /** What the inputs call for this frame (bars apply it on their lines). */
  private readonly target: MusicState = calmState();
  private readonly mix: LayerMix = emptyMix();
  private lastCombatMs = Number.NEGATIVE_INFINITY;
  private enabled = true;
  /** Context time each sting may next fire at. */
  private readonly stingFree: Record<MusicMoment, number> = {
    victory: 0,
    drop: 0,
    swell: 0,
  };
  /** Last bar line scheduled, and how many nodes the graph holds (QA). */
  private lastBarAt: number | null = null;
  private nodes = 0;
  /** Last level each layer param was faded to — a bar that leaves it where
   * it is writes no automation at all. */
  private readonly levels = new Map<AudioParam, number>();

  constructor(
    private readonly audio: { mixBus(): MixBus | null },
    private readonly seed: number,
  ) {}

  /** A combat event: our shot, a hit taken, an enemy near-miss. */
  noteCombat(nowMs: number): void {
    this.lastCombatMs = nowMs;
  }

  /** Muted (MUSIC OFF, or the slider at 0): the scheduler idles and every
   * layer fades out; back on, the beat picks up on the next bar line. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.silence();
    this.conductor.reset();
  }

  /** Call every frame. Steps the state even without WebAudio (QA reads it). */
  update(f: MusicFrame): void {
    const wasLow = this.target.lowHp;
    targetState(
      this.target,
      {
        threatDist: f.threatDist,
        sinceCombatS: (f.nowMs - this.lastCombatMs) / 1000,
        hp: f.hp,
        alive: f.alive,
      },
      this.target,
    );
    if (!this.enabled) return;
    const mixBus = this.audio.mixBus();
    if (!mixBus) return;
    if (!this.graph) this.graph = this.build(mixBus);
    const now = this.graph.ctx.currentTime;
    // The tense drop lands on the edge into low HP, not on the bar line.
    if (this.target.lowHp && !wasLow) this.moment("drop");
    for (;;) {
      const at = this.conductor.step(now, this.target);
      if (at === null) break;
      this.scheduleBar(this.graph, at);
    }
  }

  /** Mark a moment with its sting (ignored while muted or before the
   * context runs). Quantised to the next eighth; one per kind per bar. */
  moment(kind: MusicMoment): void {
    const g = this.graph;
    if (!g || !this.enabled) return;
    const now = g.ctx.currentTime;
    if (now < this.stingFree[kind]) return;
    this.stingFree[kind] = now + STING_GAP_S;
    const at = nextGrid(now + 0.02, EIGHTH_S);
    if (kind === "victory") this.victory(g, at);
    else if (kind === "drop") this.drop(g, at);
    else this.swell(g, at);
  }

  /** QA (`__ab.music`): the state the inputs call for, what the bars play,
   * the layer mix, and the size of the (fixed) graph. */
  debug() {
    const a = this.conductor.applied;
    return {
      running: this.graph !== null,
      enabled: this.enabled,
      target: { ...this.target },
      applied: { ...a },
      mix: { ...layerMix(a, this.mix) },
      lastBarAt: this.lastBarAt,
      nodes: this.nodes,
    };
  }

  /** One bar: the layer crossfade on its line, then every note in it. */
  private scheduleBar(g: Graph, at: number): void {
    this.lastBarAt = at;
    const s = this.conductor.applied;
    const m = layerMix(s, this.mix);
    const W = MUSIC_WEIGHTS;
    this.fade(g.pad.gain, W.pad * m.pad, at);
    this.fade(g.bass.gain, W.bass * m.bass, at);
    this.fade(g.drums.gain, W.drums * m.drums, at);
    this.fade(g.arp.gain, W.arp * m.arp, at);
    this.fade(g.tension.gain, W.tension * m.tension, at);
    this.fade(
      g.padFilter.frequency,
      PAD_DARK_HZ * (PAD_BRIGHT_HZ / PAD_DARK_HZ) ** m.bright,
      at,
    );

    const bar = barIndex(at);
    const chord = padChord(bar);
    for (const [i, osc] of g.padOsc.entries()) {
      osc.frequency.setTargetAtTime(chord[i % 3] ?? chord[0], at, 0.04);
    }
    // Silent layers are not sequenced: no automation for what nobody hears.
    if (m.bass > 0) this.bassBar(g, bar, at);
    if (m.drums > 0) this.drumBar(g, s.intensity, at);
    if (m.arp > 0) this.arpBar(g, bar, at);
  }

  /** A layer's bar-line crossfade: hold its level until the line `at`, then
   * glide to `to` over one beat. Nothing is written if it would not move. */
  private fade(param: AudioParam, to: number, at: number): void {
    const from = this.levels.get(param) ?? param.value;
    if (Math.abs(from - to) < 1e-4) return;
    this.levels.set(param, to);
    param.setValueAtTime(from, at);
    param.linearRampToValueAtTime(to, at + BEAT_S);
  }

  private bassBar(g: Graph, bar: number, at: number): void {
    const env = g.bassEnv.gain;
    for (let e = 0; e < 8; e++) {
      const t = at + e * EIGHTH_S;
      const hz = bassNote(bar, e);
      if (hz === null) {
        env.setTargetAtTime(0, t, 0.03);
        continue;
      }
      g.bassOsc.frequency.setValueAtTime(hz, t);
      env.setValueAtTime(0, t);
      env.linearRampToValueAtTime(1, t + 0.008);
      env.setTargetAtTime(0.35, t + 0.01, 0.09);
    }
  }

  private drumBar(g: Graph, intensity: Intensity, at: number): void {
    const kicks = intensity === DOGFIGHT ? KICK_FIGHT : KICK;
    for (const step of kicks) {
      const t = at + step * STEP_S;
      g.kickOsc.frequency.setValueAtTime(150, t);
      g.kickOsc.frequency.exponentialRampToValueAtTime(48, t + 0.12);
      hit(g.kickEnv.gain, t, KICK_PEAK, 0.07);
    }
    for (const step of SNARE)
      hit(g.snareEnv.gain, at + step * STEP_S, SNARE_PEAK, 0.05);
    for (let step = 0; step < STEPS_PER_BAR; step++) {
      if (!hatOn(intensity, step)) continue;
      // Offbeat eighths ring a touch louder: the groove's lift.
      const peak = step % 4 === 2 ? HAT_ACCENT : HAT_PEAK;
      hit(g.hatEnv.gain, at + step * STEP_S, peak, 0.018);
    }
  }

  private arpBar(g: Graph, bar: number, at: number): void {
    for (let step = 0; step < STEPS_PER_BAR; step++) {
      const t = at + step * STEP_S;
      g.arpOsc.frequency.setValueAtTime(arpNote(bar, step), t);
      hit(g.arpEnv.gain, t, 1, 0.045);
    }
  }

  /** Victory: a rising A-minor run that lands on the high A and rings. */
  private victory(g: Graph, at: number): void {
    const env = g.winEnv.gain;
    env.cancelScheduledValues(at);
    const notes = [440, 523.25, 659.25, 880];
    for (const [i, hz] of notes.entries()) {
      const t = at + i * STEP_S;
      const last = i === notes.length - 1;
      g.winOsc.frequency.setValueAtTime(hz, t);
      hit(env, t, last ? 1 : 0.8, last ? 0.35 : 0.06);
    }
  }

  /** Low HP: the floor drops out — a falling sweep into the drone. */
  private drop(g: Graph, at: number): void {
    const f = g.dropOsc.frequency;
    const env = g.dropEnv.gain;
    f.cancelScheduledValues(at);
    env.cancelScheduledValues(at);
    f.setValueAtTime(660, at);
    f.exponentialRampToValueAtTime(82, at + 1.2);
    env.setValueAtTime(0, at);
    env.linearRampToValueAtTime(1, at + 0.03);
    env.setTargetAtTime(0, at + 0.4, 0.3);
  }

  /** Swell: an impact now, then a noise riser and a lift into the next bar
   * line (at least a beat away). */
  private swell(g: Graph, at: number): void {
    hit(g.impactEnv.gain, at, 1, 0.35);
    g.impactOsc.frequency.cancelScheduledValues(at);
    g.impactOsc.frequency.setValueAtTime(90, at);
    g.impactOsc.frequency.exponentialRampToValueAtTime(32, at + 0.9);
    const peak = nextGrid(at + BEAT_S, BAR_S);
    const env = g.swellEnv.gain;
    const f = g.swellFilter.frequency;
    env.cancelScheduledValues(at);
    f.cancelScheduledValues(at);
    env.setValueAtTime(0, at);
    env.linearRampToValueAtTime(1, peak);
    env.setTargetAtTime(0, peak, 0.25);
    f.setValueAtTime(300, at);
    f.exponentialRampToValueAtTime(5000, peak);
  }

  /** Muted: every layer glides out now; scheduled notes play into silence. */
  private silence(): void {
    const g = this.graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    for (const layer of [g.pad, g.bass, g.drums, g.arp, g.tension]) {
      layer.gain.cancelScheduledValues(now);
      layer.gain.setTargetAtTime(0, now, 0.1);
      this.levels.set(layer.gain, 0);
    }
  }

  /** The whole graph, once. Sources run forever at zero gain until needed. */
  private build({ ctx, music }: MixBus): Graph {
    let nodes = 0;
    const count = <T>(n: T): T => {
      nodes++;
      return n;
    };
    const now = ctx.currentTime;
    const gain = (value: number): GainNode => {
      const node = count(ctx.createGain());
      node.gain.value = value;
      return node;
    };
    const filter = (
      type: BiquadFilterType,
      hz: number,
      q: number,
    ): BiquadFilterNode => {
      const node = count(ctx.createBiquadFilter());
      node.type = type;
      node.frequency.value = hz;
      node.Q.value = q;
      return node;
    };
    const tone = (type: OscillatorType, hz: number): OscillatorNode => {
      const osc = count(ctx.createOscillator());
      osc.type = type;
      osc.frequency.value = hz;
      osc.start(now);
      return osc;
    };
    const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    const noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const rng = mulberry32((this.seed ^ NOISE_SALT) >>> 0);
    const data = noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = rng() * 2 - 1;
    const noiseSource = (offset: number): AudioBufferSourceNode => {
      const src = count(ctx.createBufferSource());
      src.buffer = noise;
      src.loop = true;
      src.start(now, offset);
      return src;
    };

    // Music input: a 70 Hz high-pass and a dip at 100 Hz keep the score off
    // the engine's pitch band (55–185 Hz) — the corner manager's cue.
    const input = gain(1);
    const dip = filter("peaking", 100, 1);
    dip.gain.value = -6;
    input
      .connect(filter("highpass", 70, 0.7))
      .connect(dip)
      .connect(music);
    const layer = (): GainNode => {
      const node = gain(0);
      node.connect(input);
      return node;
    };

    // Pad: three detuned saws through one filter whose opening is `bright`.
    const pad = layer();
    const padFilter = filter("lowpass", PAD_DARK_HZ, 0.6);
    padFilter.connect(pad);
    const first = padChord(0);
    const padOsc = first.map((hz, i) => {
      const osc = tone("sawtooth", hz);
      osc.detune.value = (i - 1) * 7;
      osc.connect(gain(PAD_VOICE)).connect(padFilter);
      return osc;
    });

    // Bass: a saw with a resonant low-pass, plucked by its envelope.
    const bass = layer();
    const bassEnv = gain(0);
    const bassOsc = tone("sawtooth", 110);
    bassOsc
      .connect(filter("lowpass", 650, 4))
      .connect(bassEnv)
      .connect(bass);

    // Drums: a pitch-dropping sine kick, band-passed noise snare, hats.
    const drums = layer();
    const kickEnv = gain(0);
    const kickOsc = tone("sine", 150);
    kickOsc.connect(kickEnv).connect(drums);
    const snareEnv = gain(0);
    noiseSource(0.3)
      .connect(filter("bandpass", 1800, 0.9))
      .connect(snareEnv)
      .connect(drums);
    const hatEnv = gain(0);
    noiseSource(1.1)
      .connect(filter("highpass", 7000, 0.7))
      .connect(hatEnv)
      .connect(drums);

    // Arpeggio: a filtered square with a dotted-eighth echo.
    const arp = layer();
    const arpEnv = gain(0);
    const arpOsc = tone("square", 440);
    arpOsc.connect(filter("lowpass", 3200, 0.7)).connect(arpEnv);
    arpEnv.connect(gain(ARP_DRY)).connect(arp);
    const echo = count(ctx.createDelay(1));
    echo.delayTime.value = EIGHTH_S * 1.5;
    const feedback = gain(0.3);
    arpEnv.connect(echo).connect(feedback).connect(echo);
    echo.connect(gain(ARP_WET)).connect(arp);

    // Tension: a minor second (E5/F5) trembling in sixteenths.
    const tension = layer();
    const tremolo = gain(0.5);
    tremolo.connect(tension);
    for (const hz of [659.25, 698.46]) {
      tone("triangle", hz).connect(gain(0.5)).connect(tremolo);
    }
    const lfo = tone("sine", 1 / STEP_S);
    lfo.connect(gain(0.5)).connect(tremolo.gain);

    // Stings share one layer, each on its own oscillator and envelope.
    const sting = gain(MUSIC_WEIGHTS.sting);
    sting.connect(input);
    const winEnv = gain(0);
    const winOsc = tone("triangle", 440);
    winOsc.connect(winEnv).connect(sting);
    const dropEnv = gain(0);
    const dropOsc = tone("sawtooth", 660);
    dropOsc
      .connect(filter("lowpass", 1400, 1))
      .connect(dropEnv)
      .connect(sting);

    // Swell: a noise riser plus a sub impact, on their own layer.
    const swell = gain(MUSIC_WEIGHTS.swell);
    swell.connect(input);
    const swellEnv = gain(0);
    const swellFilter = filter("bandpass", 300, 1.4);
    noiseSource(0.7).connect(swellFilter).connect(swellEnv).connect(swell);
    const impactEnv = gain(0);
    const impactOsc = tone("sine", 90);
    impactOsc.connect(impactEnv).connect(swell);

    this.nodes = nodes;
    return {
      ctx,
      input,
      pad,
      padOsc,
      padFilter,
      bass,
      bassOsc,
      bassEnv,
      drums,
      kickOsc,
      kickEnv,
      snareEnv,
      hatEnv,
      arp,
      arpOsc,
      arpEnv,
      tension,
      winOsc,
      winEnv,
      dropOsc,
      dropEnv,
      swellEnv,
      swellFilter,
      impactOsc,
      impactEnv,
    };
  }
}

/** A percussive envelope hit: a fast attack to `peak`, then decay. */
function hit(param: AudioParam, t: number, peak: number, decay: number): void {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + 0.004);
  param.setTargetAtTime(0, t + 0.006, decay);
}
