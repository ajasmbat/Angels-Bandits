// Deterministic weather cycle (L4), shared verbatim by client and server — the
// storm.ts trick applied to rain. weatherAt is a pure function of (seed,
// synced clock): every client computes the IDENTICAL sky, so nothing about
// the weather is ever streamed. No Math.random anywhere.
//
// Shape: time is cut into fixed WEATHER_CYCLE_MS cycles, each running
// clear → drizzle → downpour → clearing. The four phase lengths are seeded per
// cycle as 8 min ± a swing that cancels pairwise (clear +u, drizzle +v,
// downpour −u, clearing −v), so every phase stays 6–10 min while every cycle
// is exactly 32 min — any instant is addressable in O(1), no walking from
// epoch zero.
//
// The curves are designed, not simulated, and continuous across every phase
// and cycle boundary: rain ramps in through drizzle to a seeded downpour peak
// and stops early in clearing; wetness LAGS the rain (streets need a while to
// get wet) and dries slowly through clearing and the next clear phase. The
// whole clear phase is dry, so the per-cycle wind switch at a cycle boundary
// never shows.
//
// The lightning schedule (storm.ts) is deliberately NOT gated on this: strikes
// are server-authoritative kills, so only their LOOK (`flash`) follows the
// weather.

import { mulberry32 } from "./city/index";

export const WEATHER_PHASES = [
  "clear",
  "drizzle",
  "downpour",
  "clearing",
] as const;
export type WeatherPhase = (typeof WEATHER_PHASES)[number];

/** One full clear → clearing cycle, ms. */
export const WEATHER_CYCLE_MS = 32 * 60_000;
/** Mean phase length, ms (the cycle is four of these). */
const PHASE_MID_MS = WEATHER_CYCLE_MS / 4;
/** Max seeded swing of a phase off the mean, ms (→ 6–10 min phases). */
const PHASE_SWING_MS = 2 * 60_000;
/** Steady drizzle rain level, 0..1. */
const DRIZZLE_RAIN = 0.3;
/** Downpour peak range, 0..1 (seeded per cycle). */
const PEAK_MIN = 0.85;
/** Wetness carried from a cycle's clearing into the next clear phase. */
const CARRY_WETNESS = 0.45;
/** Drizzle alone only dampens the streets this far. */
const DRIZZLE_WETNESS = 0.4;
/** Wind speed band, m/s (constant within a cycle). */
const WIND_MIN = 2;
const WIND_MAX = 6;
/** Sky-flash scale in a dry sky — downpours flash at 1. */
const FLASH_DRY = 0.55;

/** The weather at one instant. All scalars 0..1 unless noted. */
export interface Weather {
  phase: WeatherPhase;
  /** Progress through the current phase, [0, 1). */
  phaseT: number;
  /** Cycle index (time / WEATHER_CYCLE_MS). */
  cycle: number;
  /** Rainfall intensity. */
  rain: number;
  /** How wet the streets and roofs are — lags rain, dries slowly. */
  wetness: number;
  /** Extra haze — denser in downpours. */
  haze: number;
  /** Lightning flash scale, FLASH_DRY..1 — brightest in a downpour. */
  flash: number;
  /** Wind drift, m/s, horizontal (constant within a cycle). */
  wind: { x: number; z: number };
}

interface CycleLayout {
  /** Phase lengths, ms, in WEATHER_PHASES order (sum = WEATHER_CYCLE_MS). */
  lengths: readonly [number, number, number, number];
  peak: number;
  windX: number;
  windZ: number;
}

/** Per-cycle stream: golden-ratio hash of the cycle index into the seed,
 * salted so it never shares a stream with storm.ts. */
function cycleLayout(seed: number, cycle: number): CycleLayout {
  const rand = mulberry32(
    (seed ^ 0x2c1b3c6d ^ Math.imul(cycle, 0x9e3779b9)) >>> 0,
  );
  const u = (rand() * 2 - 1) * PHASE_SWING_MS;
  const v = (rand() * 2 - 1) * PHASE_SWING_MS;
  const peak = PEAK_MIN + (1 - PEAK_MIN) * rand();
  const angle = rand() * Math.PI * 2;
  const speed = WIND_MIN + (WIND_MAX - WIND_MIN) * rand();
  return {
    lengths: [
      PHASE_MID_MS + u,
      PHASE_MID_MS + v,
      PHASE_MID_MS - u,
      PHASE_MID_MS - v,
    ],
    peak,
    windX: Math.cos(angle) * speed,
    windZ: Math.sin(angle) * speed,
  };
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Locate `timeMs` in its cycle: phase index, phase start and length. */
function locate(
  seed: number,
  timeMs: number,
): { cycle: number; layout: CycleLayout; index: number; start: number } {
  const cycle = Math.floor(timeMs / WEATHER_CYCLE_MS);
  const layout = cycleLayout(seed, cycle);
  let start = cycle * WEATHER_CYCLE_MS;
  let index = 0;
  while (index < 3 && timeMs >= start + (layout.lengths[index] ?? 0)) {
    start += layout.lengths[index] ?? 0;
    index++;
  }
  return { cycle, layout, index, start };
}

/**
 * The shared weather at synced time `timeMs` (server snapshot clock, epoch
 * ms). Pure and deterministic for a (seed, time).
 */
export function weatherAt(seed: number, timeMs: number): Weather {
  const { cycle, layout, index, start } = locate(seed, timeMs);
  const t = (timeMs - start) / (layout.lengths[index] ?? PHASE_MID_MS);
  const peak = layout.peak;
  let rain: number;
  let wetness: number;
  switch (index) {
    case 0: // clear: dry sky, the last downpour's streets drying out
      rain = 0;
      wetness = CARRY_WETNESS * (1 - smooth(0, 0.6, t));
      break;
    case 1: // drizzle: rain comes in fast, the streets only slowly darken
      rain = DRIZZLE_RAIN * smooth(0, 0.15, t);
      wetness = DRIZZLE_WETNESS * smooth(0.12, 0.85, t);
      break;
    case 2: // downpour: rain climbs to the cycle's peak, standing water
      rain = DRIZZLE_RAIN + (peak - DRIZZLE_RAIN) * smooth(0, 0.25, t);
      wetness =
        DRIZZLE_WETNESS + (1 - DRIZZLE_WETNESS) * smooth(0.05, 0.45, t);
      break;
    default: // clearing: rain stops early, the city stays soaked a while
      rain = peak * (1 - smooth(0, 0.4, t));
      wetness = 1 - (1 - CARRY_WETNESS) * smooth(0.3, 1, t);
      break;
  }
  return {
    phase: WEATHER_PHASES[index] as WeatherPhase,
    phaseT: t,
    cycle,
    rain,
    wetness,
    haze: rain * Math.sqrt(rain),
    flash: FLASH_DRY + (1 - FLASH_DRY) * Math.min(1, rain / PEAK_MIN),
    wind: { x: layout.windX, z: layout.windZ },
  };
}

/** [startMs, endMs) of `phase` in the cycle containing `timeMs` — QA staging
 * (`__ab.weather("downpour")`) and tests. */
export function phaseWindow(
  seed: number,
  timeMs: number,
  phase: WeatherPhase,
): [number, number] {
  const cycle = Math.floor(timeMs / WEATHER_CYCLE_MS);
  const layout = cycleLayout(seed, cycle);
  const index = WEATHER_PHASES.indexOf(phase);
  let start = cycle * WEATHER_CYCLE_MS;
  for (let i = 0; i < index; i++) start += layout.lengths[i] ?? 0;
  return [start, start + (layout.lengths[index] ?? 0)];
}
