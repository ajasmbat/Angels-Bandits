// Dynamic soundtrack (S2): the pure seam behind music.ts, the same split as
// ambient-mix.ts — no WebAudio in here. What the pilot is living through
// (the nearest threat, how fresh the last exchange of fire is, hp) becomes
// an intensity state with hysteresis; a conductor applies that state only on
// bar lines; the state becomes one 0..1 gain per music layer. The tempo grid,
// the key and the patterns live here too, so the L2 plaza pad and the A1
// buskers can play on the same clock and in the same key as the score.

import { LOW_HP_CALLOUT } from "../game/callouts";

// --- The grid --------------------------------------------------------------
//
// One tempo for everything musical: 120 bpm, 4/4, so a bar is 2 s. The grid's
// origin is AudioContext time 0, so any layer that snaps to it (nextGrid)
// lands on the same downbeats as every other.

export const BPM = 120;
export const BEAT_S = 60 / BPM;
export const BAR_S = 4 * BEAT_S;
export const EIGHTH_S = BEAT_S / 2;
export const STEP_S = BEAT_S / 4;
export const STEPS_PER_BAR = 16;

/** The first grid line at or after `t` (grid lines every `step` from 0). */
export function nextGrid(t: number, step: number): number {
  return Math.ceil(t / step - 1e-9) * step + 0; // + 0: never −0
}

/** The absolute index of the bar starting at grid line `t`. */
export function barIndex(t: number): number {
  return Math.round(t / BAR_S);
}

// --- The intensity state machine -------------------------------------------

export const CALM = 0;
export const CONTACT = 1;
export const DOGFIGHT = 2;
/** J1: the carrier fight — the war-zeppelin up and close. */
export const CARRIER = 3;
export type Intensity =
  | typeof CALM
  | typeof CONTACT
  | typeof DOGFIGHT
  | typeof CARRIER;

/** Bass and drums come in with a threat this close (3D, torus), m… */
export const CONTACT_ENTER_M = 500;
/** …and leave only once it is past this: 150 m of hysteresis. */
export const CONTACT_EXIT_M = 650;
/** A combat event (our shot, a hit taken, a near-miss) this fresh starts a
 * dogfight, s… */
export const COMBAT_ENTER_S = 1;
/** …which holds until the guns have been quiet this long. Tighter than the
 * radio's 8 s window: the score settles before the chatter returns. */
export const DOGFIGHT_HOLD_S = 6;
/** Low-HP tension enters under the "I'm hit" callout's threshold… */
export const LOW_HP_ENTER = LOW_HP_CALLOUT;
/** …and leaves once regen (or a pickup) has carried us clear of it. */
export const LOW_HP_EXIT = 45;
/** J1: the carrier fight starts with the zeppelin this close (3D, torus)… */
export const CARRIER_ENTER_M = 700;
/** …and lets go past this: 150 m of hysteresis, like contact's. */
export const CARRIER_EXIT_M = 850;
/** A calmer state applies only after this many bars of the louder one. */
export const DEESCALATE_BARS = 2;

/** What the frame loop knows this frame. */
export interface MusicInputs {
  /** Distance to the nearest living remote plane, or null if none. */
  threatDist: number | null;
  /** Seconds since our last combat event (Infinity if none yet). */
  sinceCombatS: number;
  hp: number;
  alive: boolean;
  /** J1: distance to the carrier while it is up, or null (none, or down). */
  carrierDist?: number | null;
  /** J1: a wave is live — its enemies are coming for us, so the score
   * never sits at calm. */
  waveLive?: boolean;
}

export interface MusicState {
  intensity: Intensity;
  lowHp: boolean;
}

export const calmState = (): MusicState => ({ intensity: CALM, lowHp: false });

/**
 * The state the inputs call for, given the last one (for the hysteresis).
 * Monotonic: a nearer threat or a fresher exchange never lowers it. Dead
 * (kill-cam, respawn wait) is calm. Writes into `out`, which may be `prev`.
 */
export function targetState(
  prev: MusicState,
  inp: MusicInputs,
  out: MusicState = calmState(),
): MusicState {
  if (!inp.alive) {
    out.intensity = CALM;
    out.lowHp = false;
    return out;
  }
  const reach = prev.intensity >= CONTACT ? CONTACT_EXIT_M : CONTACT_ENTER_M;
  const near = inp.threatDist !== null && inp.threatDist <= reach;
  const hold = prev.intensity >= DOGFIGHT ? DOGFIGHT_HOLD_S : COMBAT_ENTER_S;
  const fight = inp.sinceCombatS <= hold;
  const lowHp = inp.hp < (prev.lowHp ? LOW_HP_EXIT : LOW_HP_ENTER);
  const carrierReach =
    prev.intensity === CARRIER ? CARRIER_EXIT_M : CARRIER_ENTER_M;
  const carrier =
    inp.carrierDist !== undefined &&
    inp.carrierDist !== null &&
    inp.carrierDist <= carrierReach;
  out.intensity = carrier
    ? CARRIER
    : fight
      ? DOGFIGHT
      : near || inp.waveLive === true
        ? CONTACT
        : CALM;
  out.lowHp = lowHp;
  return out;
}

/** The intensity the next bar plays: louder at once, calmer only after
 * DEESCALATE_BARS bars of the current one. */
export function nextApplied(
  applied: Intensity,
  barsHeld: number,
  target: Intensity,
): Intensity {
  if (target > applied) return target;
  if (target < applied && barsHeld >= DEESCALATE_BARS) return target;
  return applied;
}

// --- Bar clock and conductor -------------------------------------------------

/** Bars are scheduled this far ahead: more than a beat, so a 20 fps phone or
 * a throttled tab's long frame never misses a downbeat. */
export const LOOKAHEAD_S = 0.6;
/** Never schedule closer to "now" than this. */
const MIN_LEAD_S = 0.05;

/** Hands out bar lines to schedule, each exactly once, just ahead of time. */
export class BarClock {
  private next = Number.NEGATIVE_INFINITY;

  /** The next bar line if it is due (inside the lookahead), else null. After
   * a stall (a hidden tab, the first call) it realigns to the next grid bar
   * instead of firing a backlog of missed bars. */
  due(now: number): number | null {
    if (this.next < now + MIN_LEAD_S)
      this.next = nextGrid(now + MIN_LEAD_S, BAR_S);
    if (this.next > now + LOOKAHEAD_S) return null;
    const at = this.next;
    this.next += BAR_S;
    return at;
  }

  /** Forget the beat: the next due() realigns (music muted, then back). */
  reset(): void {
    this.next = Number.NEGATIVE_INFINITY;
  }
}

/** Applies the target state on bar lines only. One per music layer graph. */
export class Conductor {
  readonly applied: MusicState = calmState();
  /** Bars the applied intensity has played (counting the one just due). */
  barsHeld = 0;
  private readonly clock = new BarClock();

  /** Per frame: the bar line to schedule now (with `applied` updated to what
   * it plays), or null when no bar is due. */
  step(now: number, target: MusicState): number | null {
    const at = this.clock.due(now);
    if (at === null) return null;
    const next = nextApplied(
      this.applied.intensity,
      this.barsHeld,
      target.intensity,
    );
    this.barsHeld = next === this.applied.intensity ? this.barsHeld + 1 : 1;
    this.applied.intensity = next;
    this.applied.lowHp = target.lowHp;
    return at;
  }

  reset(): void {
    this.clock.reset();
  }
}

// --- Layer mix ---------------------------------------------------------------

export interface LayerMix {
  pad: number;
  bass: number;
  drums: number;
  arp: number;
  /** Low-HP dissonance drone. */
  tension: number;
  /** Pad filter opening, 0 (dark) .. 1 (bright). */
  bright: number;
}

/** Per-layer share of MUSIC_LEVEL. Sums to 1, so with every layer and both
 * stings at full the music input never exceeds MUSIC_LEVEL (headroom test). */
export const MUSIC_WEIGHTS = {
  pad: 0.3,
  bass: 0.18,
  drums: 0.2,
  arp: 0.1,
  tension: 0.06,
  sting: 0.08,
  swell: 0.08,
} as const;

/** The loudest the music input can sum to, as a share of MUSIC_LEVEL. */
export const WORST_CASE_SUM = Object.values(MUSIC_WEIGHTS).reduce(
  (a, b) => a + b,
  0,
);

const BASS = [0, 1, 1, 1] as const;
const DRUMS = [0, 0.7, 1, 1] as const;
/** In CARRIER the arp layer's gain carries the war ostinato instead. */
const ARP = [0, 0, 1, 1] as const;
const BRIGHT = [0.25, 0.55, 1, 1] as const;
/** The low-HP drop: the pad filter closes to this share. */
const LOW_HP_DARK = 0.35;

export const emptyMix = (): LayerMix => ({
  pad: 0,
  bass: 0,
  drums: 0,
  arp: 0,
  tension: 0,
  bright: 0,
});

/** Per-layer gains (0..1) for a state, written into the reused `out`.
 * Calm is the pad alone; contact adds bass and drums; the dogfight adds the
 * arpeggio and opens the pad; the carrier fight (J1) swaps the arpeggio for
 * the war ostinato on the same layer — so no state ever sums past the
 * weights. Low HP adds the drone and darkens the pad. */
export function layerMix(s: MusicState, out: LayerMix): LayerMix {
  const i = s.intensity;
  out.pad = 1;
  out.bass = BASS[i];
  out.drums = DRUMS[i];
  out.arp = ARP[i];
  out.tension = s.lowHp ? 1 : 0;
  out.bright = BRIGHT[i] * (s.lowHp ? LOW_HP_DARK : 1);
  return out;
}

// --- Harmony and patterns (A minor: Am – F – C – G, one chord per bar) --------

/** Bars per pass of the progression (the L2 plaza pad and the A1 buskers
 * play the same four chords on the same bars). */
export const PROGRESSION_LENGTH = 4;

/** Score pad voicings, A3 and up (clear of the engine's 55–185 Hz band). */
const PAD: readonly (readonly [number, number, number])[] = [
  [220, 261.63, 329.63],
  [220, 261.63, 349.23],
  [261.63, 329.63, 392],
  [246.94, 293.66, 392],
];
/** Bass roots, A2 and up. */
const BASS_ROOT = [110, 174.61, 130.81, 196] as const;
/** Eighth-note bass line as semitones over the root; null = rest. */
const BASS_LINE: readonly (number | null)[] = [0, null, 0, 12, 0, null, 7, 12];
/** Sixteenth-note arpeggio as chord-tone indices (3 = root an octave up). */
const ARP_LINE = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 3, 2, 1] as const;

/** Drum steps (16ths). Contact plays eighth hats; the dogfight plays 16ths
 * with a pickup kick. */
export const KICK = [0, 8, 10] as const;
export const KICK_FIGHT = [0, 8, 10, 14] as const;
export const SNARE = [4, 12] as const;

const chordSlot = (bar: number): number =>
  ((bar % PROGRESSION_LENGTH) + PROGRESSION_LENGTH) % PROGRESSION_LENGTH;

export function padChord(bar: number): readonly [number, number, number] {
  return PAD[chordSlot(bar)] ?? [220, 261.63, 329.63];
}

/** The bass note of eighth `e` (0..7) of bar `bar`, Hz, or null for a rest. */
export function bassNote(bar: number, e: number): number | null {
  const semis = BASS_LINE[e % BASS_LINE.length];
  if (semis === null || semis === undefined) return null;
  return (BASS_ROOT[chordSlot(bar)] ?? 110) * 2 ** (semis / 12);
}

/** The arpeggio note of 16th `s` (0..15) of bar `bar`, Hz (A4 and up). */
export function arpNote(bar: number, s: number): number {
  const chord = padChord(bar);
  const idx = ARP_LINE[s % ARP_LINE.length] ?? 0;
  const base = idx === 3 ? chord[0] * 2 : (chord[idx] ?? chord[0]);
  return base * 2;
}

/** Hats on this 16th at this intensity? */
export function hatOn(i: Intensity, s: number): boolean {
  return i >= DOGFIGHT || s % 2 === 0;
}

// --- J1 war ostinato (the carrier fight) -------------------------------------

/** War toms on these 16ths: a driving, off-kilter march. */
export const WAR_TOMS = [0, 3, 6, 8, 10, 11, 14] as const;
/** Eighth-note brass stabs as semitones over the bar's bass root an octave
 * up; null = rest. Minor third and fifth: menace, not triumph. */
const WAR_LINE: readonly (number | null)[] = [0, null, 0, 3, 0, null, 7, 5];

/** The brass note of eighth `e` (0..7) of bar `bar`, Hz, or null. */
export function warNote(bar: number, e: number): number | null {
  const semis = WAR_LINE[e % WAR_LINE.length];
  if (semis === null || semis === undefined) return null;
  return (BASS_ROOT[chordSlot(bar)] ?? 110) * 2 * 2 ** (semis / 12);
}
