// All-synthesized WebAudio (PLAN.md: engine, guns, near-miss whoosh — no
// external assets, no CDNs). Thin adapter over the pure spatial.ts seam:
// every positional sound gets its StereoPanner/Gain values from spatialize.
// The context starts on the first user gesture (the join click usually
// already counts; a listener catches the stricter browsers).

import { MAX_SPEED, MIN_SPEED } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import type { VoiceSink } from "./radio";
import { spatialize } from "./spatial";

/** A remote plane audible this frame (from RemotePlanes.contacts()). */
export interface EngineSource {
  id: string;
  pos: Vec3;
  speed: number;
}

const MASTER_LEVEL = 0.5;
const OWN_ENGINE_LEVEL = 0.16;
const REMOTE_ENGINE_LEVEL = 0.6;
const GUN_LEVEL = 0.5;
const WHOOSH_LEVEL = 0.7;
const EXPLOSION_LEVEL = 1.0;
const HIT_LEVEL = 0.55;
const KILL_LEVEL = 0.4;
// Radio voice bus: pre-rendered lines are loudness-normalized to −18 LUFS,
// so one level rules them all; while a line is on air the rest of the mix
// ducks under it so the call reads through combat.
const VOICE_LEVEL = 0.9;
const DUCK_LEVEL = 0.55;
const DUCK_RAMP_S = 0.08;
// Storm (ST2): thunder rumbles under the explosion level; the in-cloud
// static bed is diegetic flavor, quieter than everything else.
const THUNDER_LEVEL = 0.8;
const STATIC_BED_LEVEL = 0.055;

/** Engine pitch band: idle throttle → full throttle, Hz. */
const ENGINE_MIN_HZ = 55;
const ENGINE_MAX_HZ = 135;

interface RemoteEngine {
  osc: OscillatorNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

export class GameAudio implements VoiceSink {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Everything except the radio voice — ducked while a line is on air. */
  private sfx: GainNode | null = null;
  private voice: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ownOsc: OscillatorNode | null = null;
  private ownGain: GainNode | null = null;
  private staticGain: GainNode | null = null;
  private readonly remotes = new Map<string, RemoteEngine>();
  private lastWhooshAt = 0;

  constructor() {
    const kick = () => this.ensure();
    window.addEventListener("pointerdown", kick);
    window.addEventListener("keydown", kick);
    this.ensure();
  }

  /** Create/resume the context. Safe to call every frame. */
  private ensure(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return null; // no WebAudio (headless QA) — stay silent
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = MASTER_LEVEL;
      this.master.connect(this.ctx.destination);
      this.sfx = this.ctx.createGain();
      this.sfx.connect(this.master);
      this.voice = this.ctx.createGain();
      this.voice.gain.value = VOICE_LEVEL;
      this.voice.connect(this.master);
      // 1 s of shared white noise for every burst-shaped sound.
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx.state === "running" ? this.ctx : null;
  }

  /** Throttle fraction 0…1 from a commanded speed. */
  private static throttle01(targetSpeed: number): number {
    return Math.max(
      0,
      Math.min(1, (targetSpeed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)),
    );
  }

  /** Own engine loop: pitch tracks the throttle. Call every frame. */
  setEngine(targetSpeed: number, alive: boolean): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx) return;
    if (!this.ownOsc || !this.ownGain) {
      this.ownOsc = ctx.createOscillator();
      this.ownOsc.type = "sawtooth";
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 900;
      this.ownGain = ctx.createGain();
      this.ownGain.gain.value = 0;
      this.ownOsc.connect(filter).connect(this.ownGain).connect(this.sfx);
      this.ownOsc.start();
    }
    const t = GameAudio.throttle01(targetSpeed);
    const now = ctx.currentTime;
    this.ownOsc.frequency.setTargetAtTime(
      ENGINE_MIN_HZ + t * (ENGINE_MAX_HZ - ENGINE_MIN_HZ),
      now,
      0.08,
    );
    this.ownGain.gain.setTargetAtTime(
      alive ? OWN_ENGINE_LEVEL * (0.55 + 0.45 * t) : 0,
      now,
      0.1,
    );
  }

  /** Remote engine loops: pan + falloff via spatialize. Call every frame. */
  syncRemotes(
    sources: readonly EngineSource[],
    listenerPos: Vec3,
    listenerYaw: number,
  ): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx) return;
    const seen = new Set<string>();
    const now = ctx.currentTime;
    for (const src of sources) {
      seen.add(src.id);
      let engine = this.remotes.get(src.id);
      if (!engine) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 700;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const pan = ctx.createStereoPanner();
        osc.connect(filter).connect(gain).connect(pan).connect(this.sfx);
        osc.start();
        engine = { osc, gain, pan };
        this.remotes.set(src.id, engine);
      }
      const s = spatialize(listenerPos, listenerYaw, src.pos);
      const t = GameAudio.throttle01(src.speed);
      engine.osc.frequency.setTargetAtTime(
        ENGINE_MIN_HZ + t * (ENGINE_MAX_HZ - ENGINE_MIN_HZ),
        now,
        0.08,
      );
      engine.gain.gain.setTargetAtTime(s.gain * REMOTE_ENGINE_LEVEL, now, 0.1);
      engine.pan.pan.setTargetAtTime(s.pan, now, 0.05);
    }
    for (const [id, engine] of this.remotes) {
      if (seen.has(id)) continue;
      engine.osc.stop();
      engine.pan.disconnect();
      this.remotes.delete(id);
    }
  }

  /** One noise burst through a filter with an exponential-ish decay. */
  private burst(
    filterType: BiquadFilterType,
    startHz: number,
    endHz: number,
    duration: number,
    level: number,
    pan: number,
  ): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx || !this.noise || level <= 0) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(startHz, now);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(endHz, 1),
      now + duration,
    );
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    src.connect(filter).connect(gain).connect(panner).connect(this.sfx);
    src.start(now, Math.random());
    src.stop(now + duration + 0.05);
  }

  /** Own gun: sharp centered crack per shot. */
  gunshot(): void {
    this.burst("bandpass", 1800, 500, 0.09, GUN_LEVEL, 0);
  }

  /** A remote's validated shot, panned and attenuated from its muzzle. */
  remoteGunshot(pos: Vec3, listenerPos: Vec3, listenerYaw: number): void {
    const s = spatialize(listenerPos, listenerYaw, pos);
    this.burst("bandpass", 1500, 450, 0.09, GUN_LEVEL * s.gain * 2, s.pan);
  }

  /** Decode one pre-rendered voice line; null until the context runs. */
  decodeVoice(data: ArrayBuffer): Promise<AudioBuffer | null> {
    const ctx = this.ensure();
    if (!ctx) return Promise.resolve(null);
    // decodeAudioData detaches its input — hand it a copy so the caller's
    // bytes survive a failed decode.
    return ctx.decodeAudioData(data.slice(0)).catch(() => null);
  }

  /** Hit thunk: a local sweep just connected. Low centered knock with ±10%
   * pitch jitter — clearly apart from the own-gun crack (1800→500 band). */
  hitThunk(): void {
    const jitter = 0.9 + Math.random() * 0.2;
    this.burst("bandpass", 750 * jitter, 210 * jitter, 0.08, HIT_LEVEL, 0);
  }

  /** Kill confirm: quick rising two-note chime over the last thunk. */
  killConfirm(): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx) return;
    const now = ctx.currentTime;
    for (const [i, hz] of [523, 784].entries()) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = hz;
      const gain = ctx.createGain();
      const at = now + i * 0.09;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(KILL_LEVEL, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.28);
      osc.connect(gain).connect(this.sfx);
      osc.start(at);
      osc.stop(at + 0.3);
    }
  }

  /** Play one voice line on the voice bus at the pilot's playbackRate,
   * ducking everything else under it for the line's duration. */
  playVoice(buffer: AudioBuffer, rate: number, onDone: () => void): boolean {
    const ctx = this.ensure();
    if (!ctx || !this.voice || !this.sfx) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.voice);
    const now = ctx.currentTime;
    this.sfx.gain.cancelScheduledValues(now);
    this.sfx.gain.setTargetAtTime(DUCK_LEVEL, now, DUCK_RAMP_S);
    this.sfx.gain.setTargetAtTime(1, now + buffer.duration / rate, DUCK_RAMP_S);
    src.addEventListener("ended", onDone);
    src.start(now);
    return true;
  }

  /** Thunder for a due storm strike: soft = long low rumble, hard = crack
   * plus the rumble body plus a sub-bass drop (the kill-bolt sound). */
  thunder(gain01: number, hard: boolean): void {
    const level = Math.min(1.2, gain01) * THUNDER_LEVEL;
    if (level <= 0) return;
    this.burst("lowpass", hard ? 420 : 180, 45, hard ? 1.7 : 2.6, level, 0);
    if (!hard) return;
    this.burst("bandpass", 1400, 320, 0.16, level * 0.9, 0);
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(70, now);
    sub.frequency.exponentialRampToValueAtTime(24, now + 1.1);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.6 * level, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    sub.connect(gain).connect(this.master);
    sub.start(now);
    sub.stop(now + 1.3);
  }

  /** In-cloud static crackle bed: level 0..1, ramped every frame like the
   * engine loop. Silent at 0 — the loop idles at zero gain. */
  setStatic(level: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noise) return;
    if (!this.staticGain) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = 2600;
      this.staticGain = ctx.createGain();
      this.staticGain.gain.value = 0;
      src.connect(filter).connect(this.staticGain).connect(this.master);
      src.start();
    }
    this.staticGain.gain.setTargetAtTime(
      Math.max(0, Math.min(1, level)) * STATIC_BED_LEVEL,
      ctx.currentTime,
      0.3,
    );
  }

  /** Near-miss whoosh: an enemy bullet just shaved past. Rate-limited. */
  whoosh(pan: number, nowMs: number): void {
    if (nowMs - this.lastWhooshAt < 150) return;
    this.lastWhooshAt = nowMs;
    this.burst("bandpass", 2400, 300, 0.3, WHOOSH_LEVEL, pan);
  }

  /** Kill explosion at a world position: low boom + rumble tail. */
  explosion(pos: Vec3, listenerPos: Vec3, listenerYaw: number): void {
    const s = spatialize(listenerPos, listenerYaw, pos);
    const level = Math.min(1, s.gain * 6); // audible well past engine range
    this.burst("lowpass", 500, 50, 1.1, EXPLOSION_LEVEL * level, s.pan);
    const ctx = this.ensure();
    if (!ctx || !this.sfx || level <= 0) return;
    const now = ctx.currentTime;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(95, now);
    sub.frequency.exponentialRampToValueAtTime(28, now + 0.8);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.7 * level, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    const panner = ctx.createStereoPanner();
    panner.pan.value = s.pan;
    sub.connect(gain).connect(panner).connect(this.sfx);
    sub.start(now);
    sub.stop(now + 1);
  }
}
