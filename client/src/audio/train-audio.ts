// T2 train sounds on top of L5's rumble (sound.ts setTrainRumble): the
// clickety-clack of wheels over rail joints from the nearest train, at a
// rate set by its speed, and a two-tone horn when a plane passes within
// ~40 m of a car (TrainRenderer decides when; this only plays it).
//
// An add-on layer in the CityAmbience idiom: it builds its few nodes once on
// the existing mix bus (so the radio ducks it) and schedules short noise
// bursts ahead of the audio clock. Diegetic only — no warning, no HUD.

import type { Vec3 } from "@angels-bandits/common/world";
import type { MixBus } from "./sound";
import { spatialize } from "./spatial";

/** Rail length between joints, m. */
const RAIL_JOINT = 18;
/** Axle spacing in a bogie, m: the two clicks of one "clickety". */
const AXLE_SPACING = 2.5;
/** Clatter level at full gain, and how much slower than an engine it falls
 * off (a train is loud). */
const CLATTER_LEVEL = 0.22;
const CLATTER_FALLOFF = 2.5;
/** Horn level; it carries further still. */
const HORN_LEVEL = 0.32;
const HORN_FALLOFF = 4;
/** Horn chord, Hz (a metro's two-tone, a minor third). */
const HORN_HZ = [311, 370] as const;
/** Schedule clicks this far ahead of the audio clock, s. */
const LOOKAHEAD = 0.12;

/** What the clatter and horn need each frame. */
export interface TrainAudioFrame {
  listener: Vec3;
  yaw: number;
  /** Nearest car (rendered position), or null. */
  at: Vec3 | null;
  /** That train's speed, m/s. */
  speed: number;
  /** A horn to sound now, or null. */
  horn: Vec3 | null;
  alive: boolean;
}

interface Graph {
  ctx: AudioContext;
  noise: AudioBuffer;
  clatter: GainNode;
  pan: StereoPannerNode;
  filter: BiquadFilterNode;
  sfx: GainNode;
}

export class TrainAudio {
  private graph: Graph | null = null;
  /** Audio-clock time of the next joint, s. */
  private nextJoint = 0;

  constructor(private readonly audio: { mixBus(): MixBus | null }) {}

  /** Call every frame. */
  update(f: TrainAudioFrame): void {
    const bus = this.audio.mixBus();
    if (!bus) return;
    if (!this.graph) this.graph = this.build(bus);
    const g = this.graph;
    const now = g.ctx.currentTime;

    const s = f.at && f.alive ? spatialize(f.listener, f.yaw, f.at) : null;
    const level = s ? Math.min(1, s.gain * CLATTER_FALLOFF) : 0;
    g.clatter.gain.setTargetAtTime(level * CLATTER_LEVEL, now, 0.1);
    if (s) g.pan.pan.setTargetAtTime(s.pan, now, 0.08);

    // Wheels over joints: two clicks a bogie, one joint every RAIL_JOINT.
    if (level > 0.01 && f.speed > 2) {
      const period = RAIL_JOINT / f.speed;
      const axle = AXLE_SPACING / f.speed;
      if (this.nextJoint < now) this.nextJoint = now + 0.02;
      while (this.nextJoint < now + LOOKAHEAD) {
        this.click(this.nextJoint, 1);
        this.click(this.nextJoint + axle, 0.8);
        this.nextJoint += period;
      }
    } else {
      this.nextJoint = 0;
    }

    if (f.horn && f.alive) this.horn(f.listener, f.yaw, f.horn);
  }

  /** One wheel click: a short, bright noise burst with a thump under it. */
  private click(at: number, weight: number): void {
    const g = this.graph;
    if (!g) return;
    const src = g.ctx.createBufferSource();
    src.buffer = g.noise;
    const env = g.ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(weight, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.001, at + 0.07);
    src.connect(env).connect(g.filter);
    src.start(at, Math.random() * 0.5, 0.09);
  }

  /** The two-tone horn from `at`. */
  private horn(listener: Vec3, yaw: number, at: Vec3): void {
    const g = this.graph;
    if (!g) return;
    const s = spatialize(listener, yaw, at);
    const level = Math.min(1, s.gain * HORN_FALLOFF) * HORN_LEVEL;
    if (level < 0.005) return;
    const now = g.ctx.currentTime;
    const env = g.ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(level, now + 0.06);
    env.gain.setValueAtTime(level, now + 0.85);
    env.gain.exponentialRampToValueAtTime(0.0005, now + 1.25);
    const tone = g.ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 1600;
    const pan = g.ctx.createStereoPanner();
    pan.pan.value = s.pan;
    env.connect(tone).connect(pan).connect(g.sfx);
    for (const hz of HORN_HZ) {
      const osc = g.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = hz;
      osc.connect(env);
      osc.start(now);
      osc.stop(now + 1.3);
    }
  }

  private build({ ctx, sfx }: MixBus): Graph {
    // Half a second of white noise: clicks pick a random slice of it (an
    // audio texture, local to this client — nothing shared depends on it).
    const noise = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1400;
    filter.Q.value = 1.2;
    const clatter = ctx.createGain();
    clatter.gain.value = 0;
    const pan = ctx.createStereoPanner();
    filter.connect(clatter).connect(pan).connect(sfx);
    return { ctx, noise, clatter, pan, filter, sfx };
  }
}
