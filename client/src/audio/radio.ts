// The radio channel. RadioQueue is the pure seam (injected clock, no DOM,
// no timers — same idiom as spatial.ts): one global channel, one line at a
// time, priority + per-key play-time cooldowns + combat suppression.
// RadioVoice below is the thin Web Speech API adapter that actually speaks
// the polled lines, framed by GameAudio's synthesized squelch/static —
// TTS cannot route through WebAudio, so framing is the radio character.

import type { Callout, RadioKind } from "../game/callouts";

/** Lower number = played first (plan: threat > own > kill > ambient). */
export const RADIO_PRIORITY: Record<RadioKind, number> = {
  threat: 0,
  own: 1,
  kill: 2,
  ambient: 3,
};

/** Combat radio discipline: ambient stays silent for this long after the
 * last combat event (damaged, firing, or an active threat), ms. */
export const COMBAT_WINDOW_MS = 8_000;

/** Rough spoken duration of a line, ms — paces the channel when the TTS
 * end event never comes (voice muted, TTS unavailable). */
const LINE_BASE_MS = 700;
const LINE_MS_PER_CHAR = 55;

interface Queued {
  line: Callout;
  /** Enqueue time (expiry runs from here). */
  at: number;
  /** Tiebreaker: FIFO within a priority class. */
  seq: number;
}

export class RadioQueue {
  private readonly queue: Queued[] = [];
  private readonly lastPlayed = new Map<string, number>();
  private busyUntil = Number.NEGATIVE_INFINITY;
  private combatUntil = Number.NEGATIVE_INFINITY;
  private seq = 0;

  /** Whether the local player is inside the combat-discipline window. */
  inCombat(now: number): boolean {
    return now < this.combatUntil;
  }

  /** Note a combat event: opens the suppression window, drops queued ambient. */
  noteCombat(now: number): void {
    this.combatUntil = Math.max(this.combatUntil, now + COMBAT_WINDOW_MS);
    this.dropKind("ambient");
  }

  /**
   * Offer a line to the channel. Rejected (false) when ambient during
   * combat, or when two lines with the same key are already waiting (one
   * about to air + one on deck is the per-key cap — cooldowns apply at play
   * time, not here, so two simultaneous kills both get accepted).
   * A threat drops all queued ambient the moment it is accepted.
   */
  enqueue(line: Callout, now: number): boolean {
    if (line.kind === "ambient" && this.inCombat(now)) return false;
    if (this.queue.filter((q) => q.line.key === line.key).length >= 2)
      return false;
    if (line.kind === "threat") this.dropKind("ambient");
    this.queue.push({ line, at: now, seq: this.seq++ });
    this.queue.sort(
      (a, b) =>
        RADIO_PRIORITY[a.line.kind] - RADIO_PRIORITY[b.line.kind] ||
        a.seq - b.seq,
    );
    return true;
  }

  /**
   * The next line to put on air, or null (channel busy / nothing ready).
   * Expired lines are dropped; lines whose key cooldown hasn't elapsed since
   * its last PLAY stay queued. Polling a line marks the channel busy for an
   * estimated spoken duration — release() ends it early (TTS onend).
   */
  poll(now: number): Callout | null {
    if (now < this.busyUntil) return null;
    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      if (!entry) break;
      const { line, at } = entry;
      if (now >= at + line.expiresMs) {
        this.queue.splice(i, 1);
        i--;
        continue;
      }
      if (line.kind === "ambient" && this.inCombat(now)) continue;
      const played = this.lastPlayed.get(line.key);
      if (played !== undefined && now < played + line.cooldownMs) continue;
      this.queue.splice(i, 1);
      this.lastPlayed.set(line.key, now);
      this.busyUntil =
        now + LINE_BASE_MS + line.voice.length * LINE_MS_PER_CHAR;
      return line;
    }
    return null;
  }

  /** Free the channel (the spoken line actually ended). */
  release(now: number): void {
    this.busyUntil = Math.min(this.busyUntil, now);
  }

  private dropKind(kind: RadioKind): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]?.line.kind === kind) this.queue.splice(i, 1);
    }
  }
}
