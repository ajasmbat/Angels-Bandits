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
export const OWN_ENGINE_LEVEL = 0.16;
/** The own engine's share of its level at idle throttle — its quietest. */
export const OWN_ENGINE_IDLE = 0.55;
const REMOTE_ENGINE_LEVEL = 0.6;
const GUN_LEVEL = 0.5;
const WHOOSH_LEVEL = 0.7;
const EXPLOSION_LEVEL = 1.0;
const HIT_LEVEL = 0.55;
const KILL_LEVEL = 0.4;
/** J1 slow-mo: the SFX bus's low-pass, wide open and at the dip's bottom,
 * Hz — the world goes muffled and heavy while the FX layer crawls. */
const SLOWMO_OPEN_HZ = 20_000;
const SLOWMO_SHUT_HZ = 650;
const SOLUTION_LEVEL = 0.13;
const DAMAGE_LEVEL = 0.6;
const SHIELD_LEVEL = 0.12;
// Radio voice bus: pre-rendered lines are loudness-normalized to −18 LUFS,
// so one level rules them all; while a line is on air the rest of the mix
// ducks under it so the call reads through combat.
const VOICE_LEVEL = 0.9;
const DUCK_LEVEL = 0.55;
const DUCK_RAMP_S = 0.08;
// S2 soundtrack: the whole score sums (worst case, every layer and sting at
// full) to 6 dB under the own engine at idle, so the engine's pitch cue —
// the F5 corner manager's only cue — always reads through it. Under a radio
// line it ducks a further −6 dB on top of the sfx duck (≈ −11 dB in all).
export const MUSIC_LEVEL = OWN_ENGINE_LEVEL * OWN_ENGINE_IDLE * 10 ** (-6 / 20);
const MUSIC_DUCK_LEVEL = 0.5;
/** Slider and mute moves glide instead of clicking. */
const MUSIC_VOLUME_RAMP_S = 0.05;
// Storm (ST2): thunder rumbles under the explosion level; the in-cloud
// static bed is diegetic flavor, quieter than everything else.
const THUNDER_LEVEL = 0.8;
const STATIC_BED_LEVEL = 0.055;
// L7: a broken neon tube's buzz — faint, close-range only (the level that
// reaches here is already distance-scaled by signage-anim buzzLevel()).
const NEON_BUZZ_LEVEL = 0.05;
/** Mains hum's first harmonic — the classic failing-ballast pitch. */
const NEON_BUZZ_HZ = 120;
// Elevated train (L5): a low rolling rumble from the nearest car, and a thin
// wheel squeal on top while a car rounds a curve. A train is loud, so its
// falloff is a few times slower than an engine's.
const TRAIN_RUMBLE_LEVEL = 0.45;
const TRAIN_SQUEAL_LEVEL = 0.07;
const TRAIN_FALLOFF = 3;
/** S9: the boss carrier's engine drone — four big diesels, a beating low
 * hum — its level at full, and how far it carries (spatial gain ×). */
const BOSS_DRONE_LEVEL = 0.32;
const BOSS_DRONE_FALLOFF = 9;

/** Engine pitch band: idle throttle → full throttle, Hz. */
const ENGINE_MIN_HZ = 55;
const ENGINE_MAX_HZ = 135;
/** Engine pitch at full boost speed (F2) — the burn climbs past full throttle. */
const ENGINE_BOOST_HZ = 185;
const BOOST_CUE_LEVEL = 0.45;
/** X1 incoming-missile whistle: a clean rising TONE — nothing like the
 * storm's filtered-noise thunder, so the two are never confused. */
const WHISTLE_LEVEL = 0.32;
/** P3: the master limiter — a brick wall just under full scale, so a
 * pile-up of chaos (C2: a quake under a missile under a collapse) squashes
 * instead of clipping. Fast attack, short release: transparent until it
 * has to act. */
const LIMIT_THRESHOLD_DB = -3;
const LIMIT_RATIO = 20;
const LIMIT_ATTACK_S = 0.003;
const LIMIT_RELEASE_S = 0.1;
/** P3: at most this many chaos one-shots (explosions, blasts, flak,
 * collapses, director warnings) sound at once. A louder newcomer steals the
 * quietest — a near blast always plays; a far one under a full stack
 * doesn't. */
const CHAOS_VOICES = 6;
/** How long a collapse sounds after the crash lands (its grumbling tail). */
const COLLAPSE_TAIL_S = 6;
/** P3: the air rush as the plane rolls or loops through inverted. */
const AERO_WHOOSH_LEVEL = 0.28;
const AERO_WHOOSH_MIN_MS = 1200;
/** F10: the hard pull's airframe creak, under the whoosh. */
const CREAK_LEVEL = 0.32;
const WHISTLE_FROM_HZ = 700;
const WHISTLE_TO_HZ = 2400;

/** A running context and its buses, for an add-on layer (L2 city ambience)
 * that builds its own nodes once and mixes into the existing chain. */
export interface MixBus {
  ctx: AudioContext;
  /** The ducked effects bus (the radio voice ducks everything on it). */
  sfx: GainNode;
  /** The master, after the duck — where a send off `sfx` returns to. */
  master: GainNode;
  /** The S2 soundtrack's input: music volume, then its own deeper radio
   * duck, then `sfx`. */
  music: GainNode;
}

/** Player volume multipliers (M6 settings), each a gain 0..1. */
export interface Volumes {
  master: number;
  /** Own and remote engine loops. */
  engine: number;
  /** The radio voice bus. */
  voice: number;
  /** The S2 soundtrack (0 = muted). */
  music: number;
}

/** One live chaos one-shot (P3's voice cap): its own output stage, how loud
 * it was asked to be, and when (audio clock) it will have finished. */
interface ChaosVoice {
  gain: GainNode;
  level: number;
  until: number;
}

interface RemoteEngine {
  osc: OscillatorNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

export class GameAudio implements VoiceSink {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** P3: master → limiter → destination. */
  private limiter: DynamicsCompressorNode | null = null;
  /** P3 QA: peak taps either side of the limiter, built on first read. */
  private taps: {
    pre: AnalyserNode;
    post: AnalyserNode;
    buf: Float32Array<ArrayBuffer>;
  } | null = null;
  private readonly chaos: ChaosVoice[] = [];
  private lastAeroAt = Number.NEGATIVE_INFINITY;
  /** Everything except the radio voice — ducked while a line is on air. */
  private sfx: GainNode | null = null;
  /** J1: the slow-mo low-pass between the SFX bus and the master. */
  private slowFilter: BiquadFilterNode | null = null;
  private slowDepth = 0;
  private voice: GainNode | null = null;
  /** S2: the music volume stage, and the radio duck under it. */
  private music: GainNode | null = null;
  private musicDuck: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ownOsc: OscillatorNode | null = null;
  private ownGain: GainNode | null = null;
  private staticGain: GainNode | null = null;
  /** S9: the boss drone's loop (built on first use) and its panner. */
  private drone: { gain: GainNode; pan: StereoPannerNode } | null = null;
  private buzzGain: GainNode | null = null;
  private buzzPan: StereoPannerNode | null = null;
  private train: {
    rumble: GainNode;
    squeal: GainNode;
    pan: StereoPannerNode;
  } | null = null;
  private readonly remotes = new Map<string, RemoteEngine>();
  private lastWhooshAt = 0;
  private lastThudAt = Number.NEGATIVE_INFINITY;
  private lastPingAt = Number.NEGATIVE_INFINITY;
  /** M6 settings: gain multipliers (already curved), applied to the buses
   * as they are built and to the engine levels every frame. */
  private volumes: Volumes = { master: 1, engine: 1, voice: 1, music: 1 };

  /** Backgrounded (M2): the context is suspended on purpose, and the
   * per-frame ensure() must not wake it back up. */
  private hidden = false;

  constructor() {
    const kick = () => this.ensure();
    window.addEventListener("pointerdown", kick);
    window.addEventListener("keydown", kick);
    // iOS only unlocks Web Audio inside touchend/click (not pointerdown), and
    // only for a resume() called synchronously in that handler. Permanent,
    // not once: the same gesture also recovers an iOS "interrupted" context
    // (a phone call, Siri) later in the session.
    const unlock = () => this.unlock();
    window.addEventListener("touchend", unlock);
    window.addEventListener("click", unlock);
    // Safari 17+: "playback" plays through the ringer/silent switch, which
    // otherwise mutes Web Audio entirely on an iPhone.
    const session = (navigator as { audioSession?: { type: string } })
      .audioSession;
    if (session) session.type = "playback";
    document.addEventListener("visibilitychange", () => {
      this.hidden = document.hidden;
      if (!this.ctx) return;
      if (this.hidden) void this.ctx.suspend();
      else this.ensure();
    });
    this.ensure();
  }

  /** A user gesture: resume, and while still locked start a silent
   * one-sample buffer — older iOS only unlocks on a source started in the
   * gesture itself. */
  private unlock(): void {
    this.ensure();
    const ctx = this.ctx;
    if (!ctx || ctx.state === "running") return;
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start();
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
      this.master.gain.value = MASTER_LEVEL * this.volumes.master;
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = LIMIT_THRESHOLD_DB;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = LIMIT_RATIO;
      this.limiter.attack.value = LIMIT_ATTACK_S;
      this.limiter.release.value = LIMIT_RELEASE_S;
      this.master.connect(this.limiter).connect(this.ctx.destination);
      this.sfx = this.ctx.createGain();
      this.slowFilter = this.ctx.createBiquadFilter();
      this.slowFilter.type = "lowpass";
      this.slowFilter.frequency.value = SLOWMO_OPEN_HZ;
      this.slowFilter.Q.value = 0.9;
      this.sfx.connect(this.slowFilter).connect(this.master);
      this.voice = this.ctx.createGain();
      this.voice.gain.value = VOICE_LEVEL * this.volumes.voice;
      this.voice.connect(this.master);
      this.musicDuck = this.ctx.createGain();
      this.musicDuck.connect(this.sfx);
      this.music = this.ctx.createGain();
      this.music.gain.value = MUSIC_LEVEL * this.volumes.music;
      this.music.connect(this.musicDuck);
      // 1 s of shared white noise for every burst-shaped sound.
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    // Not while backgrounded (M2). "interrupted" is iOS-only (a call,
    // Siri) and missing from TS's AudioContextState.
    const state = this.ctx.state as AudioContextState | "interrupted";
    if (!this.hidden && (state === "suspended" || state === "interrupted")) {
      void this.ctx.resume();
    }
    return this.ctx.state === "running" ? this.ctx : null;
  }

  /** M6 settings: the player's volumes, as gains. Stored first, so a call
   * before the first gesture (no context, no buses yet) still takes effect
   * when they are built; the engine loops read theirs every frame. */
  setVolumes(v: Volumes): void {
    this.volumes = { ...v };
    if (this.master) this.master.gain.value = MASTER_LEVEL * v.master;
    if (this.voice) this.voice.gain.value = VOICE_LEVEL * v.voice;
    if (this.ctx && this.music) {
      this.music.gain.setTargetAtTime(
        MUSIC_LEVEL * v.music,
        this.ctx.currentTime,
        MUSIC_VOLUME_RAMP_S,
      );
    }
  }

  /** QA (`__ab.settings`): the live master, voice and music bus gains, or
   * null before the audio context exists. `music` is the target the slider
   * set (the live value glides there). */
  busGains(): { master: number; voice: number; music: number } | null {
    if (!this.master || !this.voice) return null;
    return {
      master: this.master.gain.value,
      voice: this.voice.gain.value,
      music: MUSIC_LEVEL * this.volumes.music,
    };
  }

  /** P3 QA (`__ab.qaUi`): the context state, live chaos voices, the
   * limiter's current gain reduction (dB, ≤ 0) and the instantaneous peak
   * (dBFS) going into and out of it. The taps are built on the first call —
   * nothing of this runs in a session no harness reads. */
  qaStats(): {
    state: string;
    chaosVoices: number;
    reductionDb: number;
    preDb: number;
    postDb: number;
  } | null {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.limiter) return null;
    if (!this.taps) {
      const pre = ctx.createAnalyser();
      const post = ctx.createAnalyser();
      pre.fftSize = post.fftSize = 2048;
      this.master.connect(pre);
      this.limiter.connect(post);
      this.taps = { pre, post, buf: new Float32Array(2048) };
    }
    const peakDb = (a: AnalyserNode, buf: Float32Array<ArrayBuffer>) => {
      a.getFloatTimeDomainData(buf);
      let m = 0;
      for (const v of buf) m = Math.max(m, Math.abs(v));
      return m > 0 ? 20 * Math.log10(m) : Number.NEGATIVE_INFINITY;
    };
    this.pruneChaos(ctx.currentTime);
    return {
      state: ctx.state,
      chaosVoices: this.chaos.length,
      reductionDb: this.limiter.reduction,
      preDb: peakDb(this.taps.pre, this.taps.buf),
      postDb: peakDb(this.taps.post, this.taps.buf),
    };
  }

  /** Drop finished chaos voices (their sources have stopped). */
  private pruneChaos(now: number): void {
    for (let i = this.chaos.length - 1; i >= 0; i--) {
      const v = this.chaos[i];
      if (!v || v.until > now) continue;
      v.gain.disconnect();
      this.chaos.splice(i, 1);
    }
  }

  /**
   * P3: an output stage for one chaos one-shot of `level` lasting
   * `durationS`, or null when CHAOS_VOICES louder ones are already playing.
   * Over the cap the quietest live voice is faded out (20 ms, no click) to
   * make room.
   */
  private chaosVoice(level: number, durationS: number): GainNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || level <= 0) return null;
    const now = ctx.currentTime;
    this.pruneChaos(now);
    if (this.chaos.length >= CHAOS_VOICES) {
      let quietest: ChaosVoice | null = null;
      for (const v of this.chaos) {
        if (!quietest || v.level < quietest.level) quietest = v;
      }
      if (!quietest || quietest.level >= level) return null;
      // Its sources stop on their own schedule; silenced, it is just a
      // short tail of zeros until they do.
      quietest.gain.gain.setTargetAtTime(0, now, 0.02);
      this.chaos.splice(this.chaos.indexOf(quietest), 1);
    }
    const gain = ctx.createGain();
    gain.connect(this.sfx);
    this.chaos.push({ gain, level, until: now + durationS + 0.1 });
    return gain;
  }

  /** The buses an add-on layer mixes into; null until the context runs
   * (first user gesture), so nothing downstream starts before the join. */
  mixBus(): MixBus | null {
    const ctx = this.ensure();
    if (!ctx || !this.sfx || !this.master || !this.music) return null;
    return { ctx, sfx: this.sfx, master: this.master, music: this.music };
  }

  /** Throttle fraction 0…1 from a commanded speed. */
  private static throttle01(targetSpeed: number): number {
    return Math.max(
      0,
      Math.min(1, (targetSpeed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)),
    );
  }

  /** Own engine loop: pitch tracks the throttle, then climbs further with
   * `boost01` (airspeed past MAX_SPEED, 0..1 — F2). Call every frame. */
  setEngine(targetSpeed: number, alive: boolean, boost01 = 0): void {
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
      ENGINE_MIN_HZ +
        t * (ENGINE_MAX_HZ - ENGINE_MIN_HZ) +
        boost01 * (ENGINE_BOOST_HZ - ENGINE_MAX_HZ),
      now,
      0.08,
    );
    this.ownGain.gain.setTargetAtTime(
      alive
        ? OWN_ENGINE_LEVEL *
            this.volumes.engine *
            (OWN_ENGINE_IDLE + (1 - OWN_ENGINE_IDLE) * t + 0.3 * boost01)
        : 0,
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
      engine.gain.gain.setTargetAtTime(
        s.gain * REMOTE_ENGINE_LEVEL * this.volumes.engine,
        now,
        0.1,
      );
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
    out: AudioNode | null = this.sfx,
  ): void {
    const ctx = this.ensure();
    if (!ctx || !out || !this.noise || level <= 0) return;
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
    src.connect(filter).connect(gain).connect(panner).connect(out);
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

  /** We took a round (U1): a dull centered body thud — low noise knock
   * plus a falling sub, nothing like the outgoing hit thunk. ≤ 1 / 120 ms. */
  damageThud(nowMs: number): void {
    if (nowMs - this.lastThudAt < 120) return;
    this.lastThudAt = nowMs;
    this.burst("lowpass", 420, 90, 0.16, DAMAGE_LEVEL, 0);
    const ctx = this.ensure();
    if (!ctx || !this.sfx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(110, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.14);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(DAMAGE_LEVEL, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(gain).connect(this.sfx);
    osc.start(now);
    osc.stop(now + 0.18);
  }

  /** Our round glanced off a spawn shield (U1): a soft glassy ping, so it
   * never reads as a hit. ≤ 1 / 80 ms. */
  shieldPing(nowMs: number): void {
    if (nowMs - this.lastPingAt < 80) return;
    this.lastPingAt = nowMs;
    const ctx = this.ensure();
    if (!ctx || !this.sfx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1760, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(SHIELD_LEVEL, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain).connect(this.sfx);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  /** Firing solution acquired: one soft, short blip — a nudge, not an alarm.
   * Rate-limiting lives in ui/lead.ts's SolutionTone, which can be tested. */
  solutionTick(): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 1046;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(SOLUTION_LEVEL, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(gain).connect(this.sfx);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /** J1 slow-mo: muffle the SFX bus by `depth` (0 open … 1 the dip's
   * bottom). Writes automation only when the depth moves. */
  setSlowMo(depth: number): void {
    const d = Math.min(1, Math.max(0, depth));
    if (Math.abs(d - this.slowDepth) < 0.01 && (d > 0 || this.slowDepth === 0))
      return;
    this.slowDepth = d;
    const f = this.slowFilter;
    if (!f || !this.ctx) return;
    const hz = SLOWMO_OPEN_HZ * (SLOWMO_SHUT_HZ / SLOWMO_OPEN_HZ) ** d;
    f.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.03);
  }

  /** Kill confirm: a body thump under a quick rising two-note chime. */
  killConfirm(): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx) return;
    const now = ctx.currentTime;
    // J1: the punch — a short pitch-dropping sine you feel more than hear.
    const thump = ctx.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(130, now);
    thump.frequency.exponentialRampToValueAtTime(42, now + 0.16);
    const body = ctx.createGain();
    body.gain.setValueAtTime(0.0001, now);
    body.gain.exponentialRampToValueAtTime(KILL_LEVEL * 1.4, now + 0.008);
    body.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    thump.connect(body).connect(this.sfx);
    thump.start(now);
    thump.stop(now + 0.22);
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
    if (this.musicDuck) {
      // The score ducks deeper than the effects, on the same timeline; an
      // overlapping line re-arms the restore from its own end.
      const duck = this.musicDuck.gain;
      duck.cancelScheduledValues(now);
      duck.setTargetAtTime(MUSIC_DUCK_LEVEL, now, DUCK_RAMP_S);
      duck.setTargetAtTime(1, now + buffer.duration / rate, DUCK_RAMP_S);
    }
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
    if (!ctx || !this.sfx) return;
    const now = ctx.currentTime;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(70, now);
    sub.frequency.exponentialRampToValueAtTime(24, now + 1.1);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.6 * level, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    // P3: on the ducked bus with the rest of the strike — a callout reads
    // through thunder too.
    sub.connect(gain).connect(this.sfx);
    sub.start(now);
    sub.stop(now + 1.3);
  }

  /** In-cloud static crackle bed: level 0..1, ramped every frame like the
   * engine loop. Silent at 0 — the loop idles at zero gain. */
  setStatic(level: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx || !this.noise) return;
    if (!this.staticGain) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = 2600;
      this.staticGain = ctx.createGain();
      this.staticGain.gain.value = 0;
      src.connect(filter).connect(this.staticGain).connect(this.sfx);
      src.start();
    }
    this.staticGain.gain.setTargetAtTime(
      Math.max(0, Math.min(1, level)) * STATIC_BED_LEVEL,
      ctx.currentTime,
      0.3,
    );
  }

  /** Broken-neon buzz (L7): level 0..1 and pan, ramped every frame. Built
   * lazily the first time a tube is in earshot; idles at zero gain after. */
  setNeonBuzz(level: number, pan: number): void {
    if (!this.buzzGain && level <= 0) return;
    const ctx = this.ensure();
    if (!ctx || !this.sfx) return;
    if (!this.buzzGain || !this.buzzPan) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = NEON_BUZZ_HZ;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 1100;
      filter.Q.value = 0.8;
      this.buzzGain = ctx.createGain();
      this.buzzGain.gain.value = 0;
      this.buzzPan = ctx.createStereoPanner();
      osc
        .connect(filter)
        .connect(this.buzzGain)
        .connect(this.buzzPan)
        .connect(this.sfx);
      osc.start();
    }
    const now = ctx.currentTime;
    this.buzzGain.gain.setTargetAtTime(
      Math.max(0, Math.min(1, level)) * NEON_BUZZ_LEVEL,
      now,
      0.03,
    );
    this.buzzPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, 0.05);
  }

  /** The L5 train's rumble (and curve squeal) from `source`, the nearest
   * car's position, or silence with null. Call every frame; both loops idle
   * at zero gain and are ramped like the engine. T2: `speed01` (that train's
   * speed over its cruise) scales the rumble — a train standing at a
   * station only hums. */
  setTrainRumble(
    source: Vec3 | null,
    squeal: boolean,
    listenerPos: Vec3,
    listenerYaw: number,
    speed01 = 1,
  ): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx || !this.noise) return;
    if (!this.train) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const low = ctx.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.value = 110;
      low.Q.value = 2.5;
      const high = ctx.createBiquadFilter();
      high.type = "bandpass";
      high.frequency.value = 3200;
      high.Q.value = 9;
      const rumble = ctx.createGain();
      rumble.gain.value = 0;
      const squealGain = ctx.createGain();
      squealGain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      src.connect(low).connect(rumble).connect(pan);
      src.connect(high).connect(squealGain).connect(pan);
      pan.connect(this.sfx);
      src.start();
      this.train = { rumble, squeal: squealGain, pan };
    }
    const s = source
      ? spatialize(listenerPos, listenerYaw, source)
      : { gain: 0, pan: 0 };
    const level = Math.min(1, s.gain * TRAIN_FALLOFF);
    const now = ctx.currentTime;
    this.train.rumble.gain.setTargetAtTime(
      level * TRAIN_RUMBLE_LEVEL * (0.2 + 0.8 * speed01),
      now,
      0.2,
    );
    this.train.squeal.gain.setTargetAtTime(
      squeal ? level * TRAIN_SQUEAL_LEVEL : 0,
      now,
      0.15,
    );
    this.train.pan.pan.setTargetAtTime(s.pan, now, 0.1);
  }

  /** Boost ignition (F2): a rising rush of air as the burn lights. */
  boostCue(): void {
    this.burst("bandpass", 500, 2600, 0.5, BOOST_CUE_LEVEL, 0);
  }

  /** P3: the air rush of rolling or looping through inverted — a soft,
   * slow band sweep, well under the near-miss whoosh. Rate-limited. */
  aeroWhoosh(nowMs: number): void {
    if (nowMs - this.lastAeroAt < AERO_WHOOSH_MIN_MS) return;
    this.lastAeroAt = nowMs;
    this.burst("bandpass", 380, 1500, 0.55, AERO_WHOOSH_LEVEL, 0);
  }

  /** F10: a hard pull — the airframe's low creak under a rush of air,
   * louder the harder the pull (`g`). Fired once per pull (game/
   * pull-feel.ts stepPullCue), and rate-limited with the aero whoosh. */
  hardPull(g: number, nowMs: number): void {
    if (nowMs - this.lastAeroAt < AERO_WHOOSH_MIN_MS) return;
    this.lastAeroAt = nowMs;
    const k = Math.min(1, Math.max(0, (g - 3) / 4));
    this.burst("lowpass", 240, 90, 0.45, CREAK_LEVEL * (0.6 + 0.4 * k), 0);
    this.burst(
      "bandpass",
      900,
      300,
      0.6,
      AERO_WHOOSH_LEVEL * (0.7 + 0.3 * k),
      0,
    );
  }

  /** Near-miss whoosh: an enemy bullet just shaved past. Rate-limited. */
  whoosh(pan: number, nowMs: number): void {
    if (nowMs - this.lastWhooshAt < 150) return;
    this.lastWhooshAt = nowMs;
    this.burst("bandpass", 2400, 300, 0.3, WHOOSH_LEVEL, pan);
  }

  /**
   * D3 collapse at a world position: a deep rumble that swells through the
   * `fallS` seconds the building takes to come down, then the crash of the
   * bulk landing (sub thump + a broadband roar) and a long grumbling tail.
   * `size01` (how much fell) scales both; distance attenuates like an
   * explosion, but the rumble carries further.
   */
  collapse(
    pos: Vec3,
    listenerPos: Vec3,
    listenerYaw: number,
    fallS: number,
    size01: number,
  ): void {
    const s = spatialize(listenerPos, listenerYaw, pos);
    const level =
      Math.min(1, s.gain * 10) * (0.55 + 0.45 * Math.min(1, size01));
    const ctx = this.ensure();
    if (!ctx || !this.sfx || !this.noise || level <= 0) return;
    const now = ctx.currentTime;
    const crashAt = now + Math.max(0.3, fallS);
    const out = this.chaosVoice(level, Math.max(0.3, fallS) + COLLAPSE_TAIL_S);
    if (!out) return;
    const panner = ctx.createStereoPanner();
    panner.pan.value = s.pan;
    panner.connect(out);
    // Rumble: low-passed noise, swelling to the crash, then fading.
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise;
    rumble.loop = true;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.setValueAtTime(90, now);
    low.frequency.linearRampToValueAtTime(160, crashAt);
    low.frequency.exponentialRampToValueAtTime(50, crashAt + 4);
    low.Q.value = 0.8;
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.001, now);
    rg.gain.linearRampToValueAtTime(0.6 * level, now + 0.8);
    rg.gain.linearRampToValueAtTime(0.9 * level, crashAt);
    rg.gain.exponentialRampToValueAtTime(0.001, crashAt + 4.5);
    rumble.connect(low).connect(rg).connect(panner);
    rumble.start(now, Math.random());
    rumble.stop(crashAt + 4.6);
    // Crash: a broadband roar collapsing to a growl.
    const roar = ctx.createBufferSource();
    roar.buffer = this.noise;
    roar.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "lowpass";
    band.frequency.setValueAtTime(1400, crashAt);
    band.frequency.exponentialRampToValueAtTime(70, crashAt + 2);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.001, now);
    cg.gain.setValueAtTime(EXPLOSION_LEVEL * level, crashAt);
    cg.gain.exponentialRampToValueAtTime(0.001, crashAt + 2.2);
    roar.connect(band).connect(cg).connect(panner);
    roar.start(now, Math.random());
    roar.stop(crashAt + 2.3);
    // Sub thump under the crash.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(70, crashAt);
    sub.frequency.exponentialRampToValueAtTime(22, crashAt + 1.2);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.001, now);
    sg.gain.setValueAtTime(0.9 * level, crashAt);
    sg.gain.exponentialRampToValueAtTime(0.001, crashAt + 1.4);
    sub.connect(sg).connect(panner);
    sub.start(now);
    sub.stop(crashAt + 1.5);
  }

  /**
   * D5: a director event is coming at `pos` in `durationS`: a deep rumble
   * swelling up to it and, for a tower or a crane, the structure groaning —
   * slow, bending metal creaks; for a gas main, a hiss building under the
   * street. Distance attenuates like the collapse it announces.
   */
  directorWarning(
    gas: boolean,
    pos: Vec3,
    listenerPos: Vec3,
    listenerYaw: number,
    durationS: number,
  ): void {
    const s = spatialize(listenerPos, listenerYaw, pos);
    const level = Math.min(1, s.gain * 10);
    const ctx = this.ensure();
    if (!ctx || !this.sfx || !this.noise || level <= 0 || durationS <= 0.1) {
      return;
    }
    const now = ctx.currentTime;
    const end = now + durationS;
    const out = this.chaosVoice(level * 0.5, durationS + 0.5);
    if (!out) return;
    const panner = ctx.createStereoPanner();
    panner.pan.value = s.pan;
    panner.connect(out);
    // Rumble: low-passed noise swelling to the event.
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise;
    rumble.loop = true;
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.setValueAtTime(60, now);
    low.frequency.linearRampToValueAtTime(130, end);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.001, now);
    rg.gain.linearRampToValueAtTime(0.5 * level, end);
    rg.gain.linearRampToValueAtTime(0.001, end + 0.4);
    rumble.connect(low).connect(rg).connect(panner);
    rumble.start(now, Math.random());
    rumble.stop(end + 0.5);
    if (gas) {
      // Hiss: high-passed noise, rising in pitch and level.
      const hiss = ctx.createBufferSource();
      hiss.buffer = this.noise;
      hiss.loop = true;
      const high = ctx.createBiquadFilter();
      high.type = "bandpass";
      high.Q.value = 0.7;
      high.frequency.setValueAtTime(1800, now);
      high.frequency.exponentialRampToValueAtTime(4200, end);
      const hg = ctx.createGain();
      hg.gain.setValueAtTime(0.001, now);
      hg.gain.exponentialRampToValueAtTime(0.35 * level, end);
      hg.gain.linearRampToValueAtTime(0.001, end + 0.1);
      hiss.connect(high).connect(hg).connect(panner);
      hiss.start(now, Math.random());
      hiss.stop(end + 0.2);
      return;
    }
    // Groans: a few slow, bending creaks of loaded steel.
    const creaks = Math.max(2, Math.round(durationS * 1.2));
    for (let i = 0; i < creaks; i++) {
      const at = now + (i + Math.random() * 0.6) * (durationS / creaks);
      const len = 0.5 + Math.random() * 0.7;
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      const f0 = 70 + Math.random() * 60;
      osc.frequency.setValueAtTime(f0, at);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.7, at + len);
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 380 + Math.random() * 300;
      band.Q.value = 4;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.001, at);
      cg.gain.linearRampToValueAtTime(0.4 * level, at + 0.15);
      cg.gain.exponentialRampToValueAtTime(0.001, at + len);
      osc.connect(band).connect(cg).connect(panner);
      osc.start(at);
      osc.stop(at + len + 0.05);
    }
  }

  /**
   * X1: an incoming missile's whistle, rising from now until it lands in
   * `durationS` (≤ MISSILE_WHISTLE_MS), placed at its impact point. Gain
   * swells as it falls; cut dead at impact, where the blast takes over.
   */
  missileWhistle(
    target: Vec3,
    listenerPos: Vec3,
    listenerYaw: number,
    durationS: number,
  ): void {
    const s = spatialize(listenerPos, listenerYaw, target);
    const level = Math.min(1, s.gain * 8) * WHISTLE_LEVEL;
    const ctx = this.ensure();
    if (!ctx || !this.sfx || level <= 0 || durationS <= 0.05) return;
    const now = ctx.currentTime;
    const end = now + durationS;
    // A late start (joined mid-fall) picks the sweep up where it would be.
    const done = 1 - Math.min(1, durationS / 2);
    const fromHz = WHISTLE_FROM_HZ * (WHISTLE_TO_HZ / WHISTLE_FROM_HZ) ** done;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(fromHz, now);
    osc.frequency.exponentialRampToValueAtTime(WHISTLE_TO_HZ, end);
    // A slow wobble: falling ordnance, not a test tone.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 7;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 25;
    lfo.connect(lfoDepth).connect(osc.frequency);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level * (0.15 + 0.85 * done), now);
    gain.gain.linearRampToValueAtTime(level, end - 0.02);
    gain.gain.linearRampToValueAtTime(0, end);
    const panner = ctx.createStereoPanner();
    panner.pan.value = s.pan;
    osc.connect(gain).connect(panner).connect(this.sfx);
    osc.start(now);
    lfo.start(now);
    osc.stop(end + 0.02);
    lfo.stop(end + 0.02);
  }

  /** X1: a missile impact — the kill explosion plus a sharper, heavier
   * crack, so a strike lands harder than a plane going down. */
  missileBlast(pos: Vec3, listenerPos: Vec3, listenerYaw: number): void {
    const s = spatialize(listenerPos, listenerYaw, pos);
    const level = Math.min(1, s.gain * 6);
    this.ensure();
    const out = this.chaosVoice(level, 2.25);
    if (!out) return;
    this.explosionInto(out, level, s.pan);
    const crack = EXPLOSION_LEVEL * level;
    this.burst("bandpass", 2600, 400, 0.25, crack, s.pan, out);
    this.burst("lowpass", 260, 35, 2.2, crack * 0.8, s.pan, out);
  }

  /** S9: the carrier's engine drone from `source` (its hull's centre), or
   * silence with null. Call every frame; the loop idles at zero gain. Two
   * detuned saws through a low-pass beat like four diesels out of step. */
  setBossDrone(
    source: Vec3 | null,
    listenerPos: Vec3,
    listenerYaw: number,
  ): void {
    if (!source && !this.drone) return;
    const ctx = this.ensure();
    if (!ctx || !this.sfx) return;
    if (!this.drone) {
      const low = ctx.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.value = 180;
      low.Q.value = 1.4;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      for (const hz of [41, 43.5, 82.3]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = hz;
        osc.connect(low);
        osc.start();
      }
      low.connect(gain).connect(pan).connect(this.sfx);
      this.drone = { gain, pan };
    }
    const s = source
      ? spatialize(listenerPos, listenerYaw, source)
      : { gain: 0, pan: 0 };
    const now = ctx.currentTime;
    this.drone.gain.gain.setTargetAtTime(
      Math.min(1, s.gain * BOSS_DRONE_FALLOFF) * BOSS_DRONE_LEVEL,
      now,
      0.4,
    );
    this.drone.pan.pan.setTargetAtTime(s.pan, now, 0.2);
  }

  /** S9: the belly hangar's door klaxon — a two-tone horn, three blasts. */
  bossKlaxon(pos: Vec3, listenerPos: Vec3, listenerYaw: number): void {
    const s = spatialize(listenerPos, listenerYaw, pos);
    const level = Math.min(1, s.gain * 7);
    if (level <= 0.01) return;
    const ctx = this.ensure();
    const out = this.chaosVoice(level * 0.35, 1.9);
    if (!ctx || !out) return;
    const now = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    pan.pan.value = s.pan;
    pan.connect(out);
    for (let b = 0; b < 3; b++) {
      const t = now + b * 0.6;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(b % 2 ? 392 : 466, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12 * level, t + 0.03);
      g.gain.setValueAtTime(0.12 * level, t + 0.38);
      g.gain.linearRampToValueAtTime(0, t + 0.45);
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 900;
      f.Q.value = 0.9;
      osc.connect(f).connect(g).connect(pan);
      osc.start(t);
      osc.stop(t + 0.5);
    }
  }

  /** S9: catapult steam — a long falling hiss; `slam` adds the shuttle
   * hitting its stops at the release. */
  catapultHiss(
    pos: Vec3,
    listenerPos: Vec3,
    listenerYaw: number,
    slam: boolean,
  ): void {
    const s = spatialize(listenerPos, listenerYaw, pos);
    const level = Math.min(1, s.gain * 6);
    if (level <= 0.01) return;
    this.ensure();
    const out = this.chaosVoice(level * 0.4, slam ? 1.4 : 1.2);
    if (!out) return;
    this.burst(
      "highpass",
      5200,
      1800,
      slam ? 1.3 : 1.1,
      0.5 * level,
      s.pan,
      out,
    );
    if (slam) this.burst("lowpass", 420, 60, 0.35, 0.7 * level, s.pan, out);
  }

  /** S9: the trapeze hook letting go — a short metallic clunk. */
  hookClunk(pos: Vec3, listenerPos: Vec3, listenerYaw: number): void {
    const s = spatialize(listenerPos, listenerYaw, pos);
    const level = Math.min(1, s.gain * 6);
    if (level <= 0.01) return;
    this.ensure();
    const out = this.chaosVoice(level * 0.35, 0.4);
    if (!out) return;
    this.burst("bandpass", 1400, 700, 0.12, 0.6 * level, s.pan, out);
    this.burst("lowpass", 300, 80, 0.3, 0.5 * level, s.pan, out);
  }

  /** S4: a flak shell bursting — a sharp, papery crack and a short thump,
   * far lighter than a kill (a turret volley must not drown the fight). */
  flakBurst(pos: Vec3, listenerPos: Vec3, listenerYaw: number): void {
    const s = spatialize(listenerPos, listenerYaw, pos);
    const level = Math.min(1, s.gain * 4);
    if (level <= 0.01) return;
    this.ensure();
    const out = this.chaosVoice(level * 0.45, 0.4);
    if (!out) return;
    const crack = EXPLOSION_LEVEL * 0.45 * level;
    this.burst("bandpass", 1900, 500, 0.16, crack, s.pan, out);
    this.burst("lowpass", 320, 60, 0.4, crack * (0.35 / 0.45), s.pan, out);
  }

  /** Kill explosion at a world position: low boom + rumble tail. */
  explosion(pos: Vec3, listenerPos: Vec3, listenerYaw: number): void {
    const s = spatialize(listenerPos, listenerYaw, pos);
    const level = Math.min(1, s.gain * 6); // audible well past engine range
    this.ensure();
    const out = this.chaosVoice(level, 1.1);
    if (out) this.explosionInto(out, level, s.pan);
  }

  /** The kill explosion's boom and sub into `out` (one chaos voice). */
  private explosionInto(out: AudioNode, level: number, pan: number): void {
    this.burst("lowpass", 500, 50, 1.1, EXPLOSION_LEVEL * level, pan, out);
    const ctx = this.ctx;
    if (!ctx || level <= 0) return;
    const now = ctx.currentTime;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(95, now);
    sub.frequency.exponentialRampToValueAtTime(28, now + 0.8);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.7 * level, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    sub.connect(gain).connect(panner).connect(out);
    sub.start(now);
    sub.stop(now + 1);
  }
}
