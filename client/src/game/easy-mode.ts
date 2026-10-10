// W4 Easy mode — the pure half. A first-time pilot starts in Easy mode: the
// room's enemies treat them as the most novice skill level and let more of
// their shots go (server/src/bottactics.ts, bots.ts). It turns itself off for
// good once they have seen EASY_WAVES waves cleared, unless they picked it in
// the settings — a pick, either way, is theirs and sticks.
//
// Decided ONCE and kept (`ab:easy`): the first visit after this shipped reads
// a pilot who has played before (a remembered callsign or the coach's done
// flag) as already graduated, anyone else as a first-timer — so a newcomer's
// second session is still a first-timer's until three waves go by.
//
// A wave counts as cleared only on a step SEEN in play: live(n) → the
// breather before n+1, or live(n) → idle with the carrier actually down.
// The caller skips the first wave state after a join or resume, a hidden
// tab and the Flight Lab. No DOM here.

import {
  WAVE_BREATHER,
  WAVE_IDLE,
  WAVE_LIVE,
  type WaveState,
} from "@angels-bandits/common/waves";

/** The stored state's key (same `ab:` prefix as the callsign). */
export const EASY_KEY = "ab:easy";
/** Waves cleared before Easy mode turns itself off. */
export const EASY_WAVES = 3;

export interface EasyState {
  /** Waves seen cleared, capped at EASY_WAVES. */
  cleared: number;
  /** The player's own pick in the settings, or null: automatic. */
  on: boolean | null;
}

/** The stored state, or — first visit since W4 — a fresh one: graduated
 * for a `returning` pilot, a first-timer's otherwise. Junk reads as fresh. */
export function loadEasy(raw: string | null, returning: boolean): EasyState {
  try {
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (o && typeof o === "object" && typeof o.cleared === "number") {
      const cleared = Number.isFinite(o.cleared)
        ? Math.min(EASY_WAVES, Math.max(0, Math.floor(o.cleared)))
        : 0;
      return { cleared, on: typeof o.on === "boolean" ? o.on : null };
    }
  } catch {
    // Junk: start over below.
  }
  return { cleared: returning ? EASY_WAVES : 0, on: null };
}

export const saveEasy = (s: EasyState): string => JSON.stringify(s);

/** Whether Easy mode is on: the player's pick, else until EASY_WAVES. */
export const easyActive = (s: EasyState): boolean =>
  s.on ?? s.cleared < EASY_WAVES;

/**
 * Whether the room's wave went from `prev` to `next` by being cleared:
 * live(n) → the breather before wave n+1, or live(n) → idle with the
 * carrier destroyed (`carrierDown`). Pure.
 */
export function waveCleared(
  prev: WaveState,
  next: WaveState,
  carrierDown: boolean,
): boolean {
  if (prev.phase !== WAVE_LIVE) return false;
  if (next.phase === WAVE_BREATHER) return next.wave === prev.wave + 1;
  return next.phase === WAVE_IDLE && carrierDown;
}

/** One more wave cleared (capped). */
export const noteCleared = (s: EasyState): EasyState => ({
  ...s,
  cleared: Math.min(EASY_WAVES, s.cleared + 1),
});
