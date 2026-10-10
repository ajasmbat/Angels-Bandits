// W1 Carrier War — the shared, pure half. Every enemy plane in a room is
// launched by the war-zeppelin carrier (S9's belly trapeze and dorsal
// catapult), in WAVES, and hunts the humans. The server decides when
// (server/src/waves.ts); this file is the arithmetic both sides agree on:
//
//  - the room's ENEMY INTENSITY (Easy / Normal / Hard / Insane), which
//    replaced ANGE-6STDNN's bot-count slider and shapes every wave;
//  - each wave's size: wave 1 is `first` planes, every later one grows by a
//    seeded growMin..growMax, never past the level's cap (≤ ENEMY_CAP, the
//    perf budget);
//  - each wave's GRADE: aim jitter, reaction and trigger discipline start
//    soft and ramp gently over the first WAVE_RAMP waves, so the first
//    waves stay easy for a new player;
//  - each wave's BOMBING (W2): how often its planes start bomb runs and how
//    many fly at once, heavier with the level and the wave;
//  - each carrier's TIER: the n-th carrier of a session is tougher and its
//    flak hits harder;
//  - who hunts whom (assignQuarries): the nearest human, spread across the
//    humans when there are several;
//  - the `waves` state on the wire (the HUD's wave number, banner and
//    enemies left).
//
// Not re-exported from common/src/index.ts; import "@angels-bandits/common/waves".

import { type Vec3, wrapDistance } from "./world/index";

// --- Intensity ------------------------------------------------------------------

export type Intensity = 0 | 1 | 2 | 3;
export const INTENSITY_NAMES: readonly string[] = [
  "EASY",
  "NORMAL",
  "HARD",
  "INSANE",
];
export const INTENSITY_DEFAULT: Intensity = 1;
export const INTENSITY_MAX: Intensity = 3;
/** One accepted intensity change per player per this long, ms — the shared
 * setting's only governance besides last-write-wins (ANGE-6STDNN's rule). */
export const INTENSITY_RATE_MS = 3000;

/** A level from anything a client sent, or null when it is not one. */
export function asIntensity(v: unknown): Intensity | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  return Math.min(Math.max(v, 0), INTENSITY_MAX) as Intensity;
}

// --- Waves ------------------------------------------------------------------------

/** Enemy planes alive at once, at most, in any room (the perf budget). */
export const ENEMY_CAP = 12;
/** The beat between one wave's last plane going down and the next wave's
 * first launch, ms — the "WAVE n" banner shows through it. */
export const WAVE_BREATHER_MS = 8000;
/** From a carrier coming on (its run-in starting) to its first wave's
 * launches, ms: the banner, then the planes. */
export const WAVE_FIRST_DELAY_MS = 3000;
/** The next carrier starts its run-in this long after the last one went
 * down (or flew off), ms. */
export const NEXT_CARRIER_MS = 20_000;
/** A wave's grade eases to its level's end values over this many waves. */
export const WAVE_RAMP = 6;

export interface WaveLevel {
  /** Wave 1's planes. */
  first: number;
  /** Each later wave adds growMin..growMax (seeded), up to `cap`. */
  growMin: number;
  growMax: number;
  cap: number;
  /** Wave 1's grade and the grade WAVE_RAMP waves on: aim-jitter and
   * reaction-delay multipliers, and the chance a lined-up shot is taken. */
  jitter: readonly [number, number];
  reaction: readonly [number, number];
  fire: readonly [number, number];
}

/** W4: EASY's and NORMAL's first waves start slower to shoot and let
 * more of their lined-up shots go (reaction / fire) — their aim jitter
 * already sits at the bots' jitter clamp for a new player, so softening
 * it further would change nothing. */
export const WAVE_LEVELS: readonly WaveLevel[] = [
  // EASY
  {
    first: 3,
    growMin: 1,
    growMax: 1,
    cap: 6,
    jitter: [2.2, 1.4],
    reaction: [2.2, 1.3],
    fire: [0.25, 0.6],
  },
  // NORMAL
  {
    first: 3,
    growMin: 1,
    growMax: 2,
    cap: 8,
    jitter: [1.8, 1],
    reaction: [1.9, 1],
    fire: [0.35, 0.85],
  },
  // HARD
  {
    first: 4,
    growMin: 1,
    growMax: 2,
    cap: 10,
    jitter: [1.3, 0.85],
    reaction: [1.2, 0.85],
    fire: [0.7, 1],
  },
  // INSANE
  {
    first: 5,
    growMin: 2,
    growMax: 2,
    cap: ENEMY_CAP,
    jitter: [1, 0.7],
    reaction: [1, 0.7],
    fire: [0.9, 1],
  },
];

const levelOf = (level: Intensity): WaveLevel =>
  WAVE_LEVELS[level] as WaveLevel;

/**
 * The size of the next wave: `first` when there was none (`prev` null),
 * else `prev` grown by a seeded growMin..growMax and capped. Exactly one
 * draw from `rand` either way, so the stream behind it never shifts.
 */
export function nextWaveSize(
  prev: number | null,
  level: Intensity,
  rand: () => number,
): number {
  const l = levelOf(level);
  const r = rand();
  if (prev === null) return Math.min(l.first, l.cap);
  const grow = l.growMin + Math.floor(r * (l.growMax - l.growMin + 1));
  return Math.min(l.cap, prev + grow);
}

/** How an enemy of wave `wave` (1-based) flies and shoots. */
export interface WaveGrade {
  /** Aim-jitter multiplier (on top of style and the human's skill). */
  jitter: number;
  /** First-shot reaction multiplier. */
  reaction: number;
  /** Chance a lined-up trigger pull is taken, 0..1. */
  fire: number;
}

/** Wave `wave`'s grade at `level`: wave 1 its level's softest, easing
 * linearly to the end values by wave 1 + WAVE_RAMP. Pure. */
export function waveGrade(wave: number, level: Intensity): WaveGrade {
  const l = levelOf(level);
  const t = Math.min(1, Math.max(0, (wave - 1) / WAVE_RAMP));
  const lerp = (r: readonly [number, number]) => r[0] + (r[1] - r[0]) * t;
  return {
    jitter: lerp(l.jitter),
    reaction: lerp(l.reaction),
    fire: Math.min(1, Math.max(0, lerp(l.fire))),
  };
}

// --- Bombing (W2) ---------------------------------------------------------------

/** How hard a wave bombs the city (server/src/bombs.ts schedules it). */
export interface WaveBombing {
  /** The room's gap between two bomb runs starting, ms. */
  gapMs: number;
  /** Bomb runs on at once in the room, at most. */
  maxRuns: number;
  /** One enemy's rest between the end of its run and its next, ms. */
  restMs: number;
}

/** Per level: wave 1's gap and the gap WAVE_RAMP waves on, ms; the run cap
 * the same way; and the per-enemy rest. Every column eases toward harder
 * with the wave and is harder level by level. */
const BOMB_LEVELS: readonly {
  gap: readonly [number, number];
  runs: readonly [number, number];
  rest: number;
}[] = [
  { gap: [16_000, 10_000], runs: [1, 1], rest: 24_000 }, // EASY
  { gap: [11_000, 6500], runs: [1, 2], rest: 18_000 }, // NORMAL
  { gap: [8000, 4500], runs: [2, 3], rest: 14_000 }, // HARD
  { gap: [6000, 3000], runs: [2, 4], rest: 10_000 }, // INSANE
];

/** Wave `wave`'s bombing at `level`: wave 1 its level's lightest, easing
 * linearly to the end values by wave 1 + WAVE_RAMP, like waveGrade. Pure. */
export function waveBombing(wave: number, level: Intensity): WaveBombing {
  const l = BOMB_LEVELS[level] as (typeof BOMB_LEVELS)[number];
  const t = Math.min(1, Math.max(0, (wave - 1) / WAVE_RAMP));
  const lerp = (r: readonly [number, number]) => r[0] + (r[1] - r[0]) * t;
  return {
    gapMs: Math.round(lerp(l.gap)),
    maxRuns: Math.round(lerp(l.runs)),
    restMs: l.rest,
  };
}

// --- Carrier tiers --------------------------------------------------------------

/** The n-th carrier's weak-point HP multiplier: the first one is a soft
 * target for a lone pilot, each later one tougher, to a ceiling. */
export const carrierHpScale = (tier: number): number =>
  Math.min(1.5, 0.4 + 0.15 * (Math.max(1, tier) - 1));

/** The n-th carrier's flak multiplier (shell damage and the per-second
 * cap): its six turrets all shoot at humans now, so the first carrier's
 * guns are soft. */
export const carrierFlakScale = (tier: number): number =>
  Math.min(1, 0.35 + 0.15 * (Math.max(1, tier) - 1));

// --- Quarries -------------------------------------------------------------------

/** Each enemy already hunting a human makes that human rank this much
 * further away for the next enemy, m — what spreads a wave across several
 * humans instead of piling it onto the nearest. */
export const QUARRY_SPREAD_M = 250;

/**
 * Who each enemy hunts: in the order given (the caller passes a stable
 * one), each takes the human whose distance plus QUARRY_SPREAD_M per
 * enemy already on them is least. An enemy with no human to hunt is left
 * out. Pure; ties go to the earlier human.
 */
export function assignQuarries(
  enemies: readonly { id: string; pos: Vec3 }[],
  humans: readonly { id: string; pos: Vec3 }[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (humans.length === 0) return out;
  const load = humans.map(() => 0);
  for (const e of enemies) {
    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    humans.forEach((h, i) => {
      const score =
        wrapDistance(e.pos, h.pos) + QUARRY_SPREAD_M * (load[i] as number);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    const h = humans[best] as { id: string };
    load[best] = (load[best] as number) + 1;
    out.set(e.id, h.id);
  }
  return out;
}

// --- Wire -----------------------------------------------------------------------

/** No carrier war going on (no carrier yet, or between carriers). */
export const WAVE_IDLE = 0;
/** The breather before wave `wave`, which starts launching at `at`. */
export const WAVE_BREATHER = 1;
/** Wave `wave` is up: launching and fighting. */
export const WAVE_LIVE = 2;
export type WavePhase = 0 | 1 | 2;

/** The room's wave as the HUD needs it. */
export interface WaveState {
  /** The wave on (or coming): 1-based, 0 before the first. */
  wave: number;
  phase: WavePhase;
  /** WAVE_BREATHER: when the wave starts launching, server ms; else when
   * this phase began. */
  at: number;
  /** Enemies left: in the air plus still to launch. */
  left: number;
  /** The wave's planes in all. */
  size: number;
  /** The carrier's tier (0: none yet). */
  tier: number;
}

export const idleWaves = (): WaveState => ({
  wave: 0,
  phase: WAVE_IDLE,
  at: 0,
  left: 0,
  size: 0,
  tier: 0,
});

/** On the wire: [wave, phase, at, left, size, tier], integers only. */
export type WireWaves = [
  wave: number,
  phase: number,
  at: number,
  left: number,
  size: number,
  tier: number,
];

export const encodeWaves = (s: WaveState): WireWaves => [
  s.wave,
  s.phase,
  Math.round(s.at),
  s.left,
  s.size,
  s.tier,
];

/** Inverse of encodeWaves; null for anything malformed. */
export function decodeWaves(w: unknown): WaveState | null {
  if (
    !Array.isArray(w) ||
    w.length !== 6 ||
    !w.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0)
  ) {
    return null;
  }
  const [wave, phase, at, left, size, tier] = w as number[];
  if (phase !== WAVE_IDLE && phase !== WAVE_BREATHER && phase !== WAVE_LIVE) {
    return null;
  }
  return {
    wave: wave as number,
    phase,
    at: at as number,
    left: left as number,
    size: size as number,
    tier: tier as number,
  };
}
