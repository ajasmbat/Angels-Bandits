// City soundscape (L2): the WebAudio adapter over ambient-mix.ts. All
// synthesized, no external files (PLAN.md's licence rule): filtered noise for
// traffic, crowd and wind; two detuned squares for horns; an LFO-wailed
// triangle for the siren; a triangle pad with a pulsing bass for plaza music;
// a generated-impulse convolver for tunnel echo.
//
// Every node is built ONCE, on the first frame the context runs (so nothing
// starts before the join gesture). Per frame this file only automates params,
// and only when a target actually moves — no node churn, no 60 Hz flood of
// automation events. The bus feeds GameAudio's sfx bus, so the radio voice
// ducks the whole city with everything else.

import { type HoleSpan, mulberry32 } from "@angels-bandits/common/city";
import type { Vec3 } from "@angels-bandits/common/world";
import {
  type AmbientMix,
  ambientMix,
  insideHole,
  plazaDistance,
  sirenAt,
  sirenGain,
  streetDistance,
} from "./ambient-mix";
import { BAR_S, PROGRESSION_LENGTH, barIndex, nextGrid } from "./music-model";
import { type MixBus, OWN_ENGINE_LEVEL } from "./sound";
import { spatialize } from "./spatial";

/** The whole soundscape sits −12 dB under the own engine's level. */
export const AMBIENCE_LEVEL = OWN_ENGINE_LEVEL * 10 ** (-12 / 20);
/** Combat discipline: the city drops a further −6 dB while you fight. */
const COMBAT_DUCK = 0.5;
/** Per-layer share of AMBIENCE_LEVEL; sums to 1, so with every layer at
 * full the bus never exceeds AMBIENCE_LEVEL. */
const WEIGHTS = {
  traffic: 0.3,
  horn: 0.1,
  siren: 0.12,
  plaza: 0.2,
  wind: 0.28,
} as const;
/** L4 rain on the canopy, absolute levels on the sfx bus (weather is not a
 * city layer: it keeps falling through combat and the kill-cam). A
 * band-passed hiss from the first drizzle, plus a low roar that only fills
 * in past drizzle strength (0.3). A tunnel keeps most of it out. */
const RAIN_HISS_LEVEL = 0.07;
const RAIN_ROAR_LEVEL = 0.09;
const RAIN_DRIZZLE = 0.3;
const RAIN_TUNNEL_KEEP = 0.2;
/** Tunnel reverb send off the sfx bus, capped: it taps the explosions too. */
const REVERB_SEND = 0.3;
const REVERB_SECONDS = 1.3;
/** Long enough that no loop repeats audibly (a 1 s loop buzzes at 1 Hz). */
const NOISE_SECONDS = 6;
/** Horns: at most one per interval, only where the horn layer is up. */
const HORN_MIN_GAP_S = 1.5;
const HORN_GAP_SPREAD_S = 5;
const HORN_AUDIBLE = 0.05;
/** Plaza pad: Am – F – C – G, one bar each on the S2 soundtrack's 120 bpm
 * grid (BAR_S) — the same chord on the same bar as the score. */
const CHORDS: readonly (readonly [number, number, number])[] = [
  [220, 261.63, 329.63],
  [174.61, 220, 261.63],
  [261.63, 329.63, 392],
  [196, 246.94, 293.66],
];
/** Salted streams: noise, impulse and horn timing never share draws. */
const NOISE_SALT = 0xa3b1e7;
const IMPULSE_SALT = 0x7e4b09;
const HORN_SALT = 0x40a2c5;

/** What the frame loop knows about the listener this frame. */
export interface AmbienceFrame {
  /** The PLANE, not the chase camera — the echo follows you into a hole. */
  pos: Vec3;
  yaw: number;
  speed: number;
  alive: boolean;
  /** The radio queue's combat window. */
  combat: boolean;
  /** Synced server clock (socket.renderTime()); null until the first snapshot. */
  serverTimeMs: number | null;
  /** L4 weather: rain heard at the camera, 0..1 (0 above the cloud base). */
  rain?: number;
}

interface Graph {
  ctx: AudioContext;
  bus: GainNode;
  traffic: GainNode;
  horn: GainNode;
  hornEnv: GainNode;
  hornPan: StereoPannerNode;
  siren: GainNode;
  sirenSrc: GainNode;
  sirenPan: StereoPannerNode;
  plaza: GainNode;
  pad: OscillatorNode[];
  bass: OscillatorNode;
  wind: GainNode;
  windFilter: BiquadFilterNode;
  reverbSend: GainNode;
  rainHiss: GainNode;
  rainRoar: GainNode;
}

/** A seeded buffer of white noise (or a decaying stereo impulse). */
function noiseBuffer(
  ctx: AudioContext,
  seconds: number,
  channels: number,
  seed: number,
  decay: number,
): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  const rng = mulberry32(seed);
  for (let c = 0; c < channels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      data[i] = (rng() * 2 - 1) * (1 - i / len) ** decay;
    }
  }
  return buf;
}

export class CityAmbience {
  private graph: Graph | null = null;
  private readonly mix: AmbientMix = {
    traffic: 0,
    horn: 0,
    siren: 0,
    plaza: 0,
    wind: 0,
    reverb: 0,
  };
  /** Last target written per param — skip writes that would not move it. */
  private readonly targets = new Map<AudioParam, number>();
  private readonly hornRng: () => number;
  private nextHornAt = 0;
  private nextBarAt = 0;
  // Last frame's inputs, for the QA hook.
  private streetDist = 0;
  private plazaDist = 0;
  private inHole = false;
  private sirenDistance: number | null = null;
  private sirenLevel = 0;
  private rainLevel = 0;

  constructor(
    private readonly audio: { mixBus(): MixBus | null },
    private readonly seed: number,
    private readonly holes: readonly HoleSpan[],
  ) {
    this.hornRng = mulberry32((seed ^ HORN_SALT) >>> 0);
  }

  /** Call every frame. Computes the mix even without WebAudio (QA reads it). */
  update(f: AmbienceFrame): void {
    this.streetDist = streetDistance(f.pos);
    this.plazaDist = plazaDistance(f.pos);
    this.inHole = insideHole(this.holes, f.pos);
    ambientMix(
      f.pos,
      f.speed,
      this.streetDist,
      this.plazaDist,
      this.inHole,
      this.mix,
    );
    const siren = sirenAt(this.seed, f.serverTimeMs);
    const sp = siren ? spatialize(f.pos, f.yaw, siren.pos) : null;
    this.sirenDistance = sp ? sp.distance : null;
    this.sirenLevel = siren && sp ? siren.level * sirenGain(sp.distance) : 0;
    this.rainLevel = Math.max(0, Math.min(1, f.rain ?? 0));

    const mixBus = this.audio.mixBus();
    if (!mixBus) return;
    if (!this.graph) this.graph = this.build(mixBus);
    const g = this.graph;
    const m = this.mix;
    const now = g.ctx.currentTime;

    const busLevel =
      AMBIENCE_LEVEL * (f.alive ? 1 : 0) * (f.combat ? COMBAT_DUCK : 1);
    this.ramp(g.bus.gain, busLevel, now, 0.4, 0.0005);
    this.ramp(g.traffic.gain, WEIGHTS.traffic * m.traffic, now, 0.3);
    this.ramp(g.horn.gain, WEIGHTS.horn * m.horn, now, 0.3);
    this.ramp(g.siren.gain, WEIGHTS.siren * m.siren, now, 0.3);
    this.ramp(g.sirenSrc.gain, this.sirenLevel, now, 0.2);
    if (sp) this.ramp(g.sirenPan.pan, sp.pan, now, 0.1, 0.02);
    this.ramp(g.plaza.gain, WEIGHTS.plaza * m.plaza, now, 0.3);
    this.ramp(g.wind.gain, WEIGHTS.wind * m.wind, now, 0.3);
    this.ramp(g.windFilter.frequency, 250 + 1100 * m.wind, now, 0.3, 5);
    // The send is gated BEFORE the convolver, so leaving a tunnel lets the
    // tail ring out instead of cutting the echo dead.
    this.ramp(g.reverbSend.gain, REVERB_SEND * m.reverb, now, 0.15);
    // L4 rain: slow ramps — weather swells, it never snaps.
    const rainKeep = 1 - (1 - RAIN_TUNNEL_KEEP) * m.reverb;
    const r = this.rainLevel;
    this.ramp(
      g.rainHiss.gain,
      Math.sqrt(r) * RAIN_HISS_LEVEL * rainKeep,
      now,
      0.8,
    );
    this.ramp(
      g.rainRoar.gain,
      (Math.max(0, r - RAIN_DRIZZLE) / (1 - RAIN_DRIZZLE)) *
        RAIN_ROAR_LEVEL *
        rainKeep,
      now,
      0.8,
    );

    if (now >= this.nextHornAt) {
      this.nextHornAt =
        now + HORN_MIN_GAP_S + this.hornRng() * HORN_GAP_SPREAD_S;
      if (m.horn > HORN_AUDIBLE) this.honk(g, now);
    }
    // Schedule each bar's chord just ahead of its downbeat, on the shared
    // grid; after a hidden tab pick the beat back up at the next bar line.
    if (now > this.nextBarAt) this.nextBarAt = nextGrid(now, BAR_S);
    if (now + 0.1 >= this.nextBarAt) {
      const chord =
        CHORDS[barIndex(this.nextBarAt) % PROGRESSION_LENGTH] ?? CHORDS[0];
      if (chord) {
        for (const [i, osc] of g.pad.entries()) {
          osc.frequency.setValueAtTime(chord[i] ?? chord[0], this.nextBarAt);
        }
        g.bass.frequency.setValueAtTime(chord[0] / 2, this.nextBarAt);
      }
      this.nextBarAt += BAR_S;
    }
  }

  /** A1: the city bus (null until the context runs), so other city layers
   * — the street performers — ride the same level, combat duck and radio
   * duck instead of growing a parallel bus. */
  get bus(): GainNode | null {
    return this.graph?.bus ?? null;
  }

  /** QA: the mix and its inputs, live whether or not the context runs. */
  debug() {
    return {
      running: this.graph !== null,
      mix: { ...this.mix },
      streetDist: this.streetDist,
      plazaDist: this.plazaDist,
      inHole: this.inHole,
      siren:
        this.sirenDistance === null
          ? null
          : { distance: this.sirenDistance, gain: this.sirenLevel },
      rain: this.rainLevel,
    };
  }

  /** setTargetAtTime, but only when the target moved more than `eps`. */
  private ramp(
    param: AudioParam,
    value: number,
    now: number,
    tc: number,
    eps = 0.002,
  ): void {
    const last = this.targets.get(param);
    if (last !== undefined && Math.abs(last - value) < eps) return;
    this.targets.set(param, value);
    param.setTargetAtTime(value, now, tc);
  }

  /** One honk (sometimes a double) on the horn envelope — its own gain, so
   * the per-frame level writes never fight the envelope. */
  private honk(g: Graph, now: number): void {
    const rng = this.hornRng;
    const env = g.hornEnv.gain;
    env.cancelScheduledValues(now);
    env.setValueAtTime(0, now);
    g.hornPan.pan.setValueAtTime(rng() * 1.6 - 0.8, now);
    const blasts = rng() < 0.3 ? 2 : 1;
    let at = now;
    for (let i = 0; i < blasts; i++) {
      const len = 0.18 + rng() * 0.4;
      env.setValueAtTime(0, at);
      env.linearRampToValueAtTime(1, at + 0.02);
      env.setValueAtTime(1, at + len);
      env.linearRampToValueAtTime(0, at + len + 0.04);
      at += len + 0.12;
    }
  }

  /** The whole graph, once. Sources run forever at zero gain until needed. */
  private build({ ctx, sfx, master }: MixBus): Graph {
    const noise = noiseBuffer(
      ctx,
      NOISE_SECONDS,
      1,
      (this.seed ^ NOISE_SALT) >>> 0,
      0,
    );
    const now = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(sfx);
    const layer = (): GainNode => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(bus);
      return gain;
    };
    // Each bed reads the shared buffer at its own offset and rate, so the
    // beds never move in lockstep.
    const noiseSource = (
      rate: number,
      offset: number,
    ): AudioBufferSourceNode => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.playbackRate.value = rate;
      src.start(now, offset);
      return src;
    };
    const filter = (
      type: BiquadFilterType,
      hz: number,
      q: number,
    ): BiquadFilterNode => {
      const node = ctx.createBiquadFilter();
      node.type = type;
      node.frequency.value = hz;
      node.Q.value = q;
      return node;
    };
    const lfo = (hz: number, depth: number, target: AudioParam): void => {
      const osc = ctx.createOscillator();
      osc.frequency.value = hz;
      const amount = ctx.createGain();
      amount.gain.value = depth;
      osc.connect(amount).connect(target);
      osc.start(now);
    };
    const tone = (type: OscillatorType, hz: number): OscillatorNode => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz;
      osc.start(now);
      return osc;
    };

    // Traffic: a low rumble with slow passing-car swells.
    const traffic = layer();
    const trafficTone = filter("lowpass", 380, 0.7);
    noiseSource(1, 0).connect(trafficTone).connect(traffic);
    lfo(0.13, 140, trafficTone.frequency);

    // Horns: two detuned squares → envelope → pan → level.
    const horn = layer();
    const hornPan = ctx.createStereoPanner();
    hornPan.connect(horn);
    const hornEnv = ctx.createGain();
    hornEnv.gain.value = 0;
    const hornTone = filter("lowpass", 1800, 0.7);
    hornTone.connect(hornEnv).connect(hornPan);
    for (const hz of [392, 466]) tone("square", hz).connect(hornTone);

    // Siren: a wailing triangle → distance gain → pan → level.
    const siren = layer();
    const sirenPan = ctx.createStereoPanner();
    sirenPan.connect(siren);
    const sirenSrc = ctx.createGain();
    sirenSrc.gain.value = 0;
    sirenSrc.connect(sirenPan);
    const sirenOsc = tone("triangle", 950);
    sirenOsc.connect(filter("lowpass", 2400, 0.7)).connect(sirenSrc);
    lfo(0.3, 280, sirenOsc.frequency);

    // Plaza: a muffled triangle pad, a pulsing bass, and crowd murmur.
    const plaza = layer();
    const padTone = filter("lowpass", 1100, 0.5);
    padTone.connect(plaza);
    const first = CHORDS[0] ?? [220, 261.63, 329.63];
    const pad = first.map((hz) => {
      const osc = tone("triangle", hz);
      const voice = ctx.createGain();
      voice.gain.value = 0.22;
      osc.connect(voice).connect(padTone);
      return osc;
    });
    const bass = tone("sine", first[0] / 2);
    const pulse = ctx.createGain();
    pulse.gain.value = 0.5;
    bass.connect(pulse).connect(padTone);
    lfo(2, 0.5, pulse.gain); // four-on-the-floor at 120 bpm
    const crowd = ctx.createGain();
    crowd.gain.value = 0.6;
    noiseSource(0.83, 2.1)
      .connect(filter("bandpass", 650, 0.8))
      .connect(crowd)
      .connect(plaza);
    lfo(0.27, 0.3, crowd.gain);

    // Wind: band-passed noise whose pitch climbs with the layer, plus gusts.
    const wind = layer();
    const windFilter = filter("bandpass", 400, 0.9);
    const gust = ctx.createGain();
    gust.gain.value = 1;
    noiseSource(1.17, 4.3).connect(windFilter).connect(gust).connect(wind);
    lfo(0.19, 0.3, gust.gain);

    // Tunnel echo: a send off the sfx bus (engine, guns, the city) through
    // one convolver, back into the master — never into sfx (no loop).
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0;
    const convolver = ctx.createConvolver();
    convolver.buffer = noiseBuffer(
      ctx,
      REVERB_SECONDS,
      2,
      (this.seed ^ IMPULSE_SALT) >>> 0,
      2.5,
    );
    sfx.connect(reverbSend).connect(convolver).connect(master);

    // L4 rain: two beds off the shared long noise (no audible loop), straight
    // into sfx — under the radio duck, outside the city bus's alive/combat gate.
    const rainHiss = ctx.createGain();
    rainHiss.gain.value = 0;
    noiseSource(1.31, 2.1)
      .connect(filter("bandpass", 5200, 0.6))
      .connect(rainHiss)
      .connect(sfx);
    const rainRoar = ctx.createGain();
    rainRoar.gain.value = 0;
    noiseSource(0.83, 0.7)
      .connect(filter("lowpass", 700, 0.7))
      .connect(rainRoar)
      .connect(sfx);

    this.nextBarAt = nextGrid(now, BAR_S);
    this.nextHornAt = now + HORN_MIN_GAP_S;
    return {
      ctx,
      bus,
      traffic,
      horn,
      hornEnv,
      hornPan,
      siren,
      sirenSrc,
      sirenPan,
      plaza,
      pad,
      bass,
      wind,
      windFilter,
      reverbSend,
      rainHiss,
      rainRoar,
    };
  }
}
