// The radio channel. RadioQueue is the pure seam (injected clock, no DOM,
// no timers — same idiom as spatial.ts): one global channel, one line at a
// time, priority + per-key play-time cooldowns + combat suppression.
// RadioVoice below is the thin adapter that actually speaks the polled
// lines: pre-rendered, radio-processed OGGs (tools/gen-radio-voices.sh)
// played as WebAudio buffers on GameAudio's ducked voice bus, with a
// deterministic per-callsign playbackRate as each bot pilot's identity.

import { mulberry32 } from "@angels-bandits/common/city";
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

/**
 * A voiced line's bundled-asset id: the same slug the generation script
 * (tools/gen-radio-voices.sh) derives when it names the OGG files — the two
 * implementations must agree, and the exhaustive bank↔file test keeps them
 * honest. Lowercase, non-alphanumeric runs collapse to "-".
 */
export function voiceSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Unrendered BANDIT-<n> lines (the server mints numbers past the 12
 * pre-rendered ones over a long-lived room) degrade to the anon variants. */
const CHECK_IN_LINE = /^BANDIT-\d+, checking in\.$/;
const OFF_STATION_LINE = /^BANDIT-\d+ off station\.$/;

/**
 * The bundled asset a voice line should play, or null (nothing rendered
 * for it — the caller stays silent and the queue's estimate paces the
 * channel). `has` answers whether an asset id exists in the bundle.
 */
export function resolveVoiceAsset(
  text: string,
  has: (id: string) => boolean,
): string | null {
  const slug = voiceSlug(text);
  if (has(slug)) return slug;
  if (CHECK_IN_LINE.test(text)) {
    const anon = voiceSlug("New contact, checking in.");
    if (has(anon)) return anon;
  }
  if (OFF_STATION_LINE.test(text)) {
    const anon = voiceSlug("Contact off station.");
    if (has(anon)) return anon;
  }
  return null;
}

/** Per-pilot identity band: playbackRate stays within ±6% of neutral. */
const PILOT_RATE_SPREAD = 0.06;

/**
 * Deterministic per-bot voice identity: a callsign always maps to the same
 * playbackRate in [1−6%, 1+6%], so BANDIT-2 and BANDIT-7 read as different
 * pilots on every client. Non-bot speakers (humans, the GUARD net) stay
 * neutral. Seeded through mulberry32 (the city generator's stream) off an
 * FNV-1a hash of the callsign.
 */
export function pilotRate(speaker: string): number {
  if (!/^BANDIT-\d+$/.test(speaker)) return 1;
  let hash = 0x811c9dc5;
  for (let i = 0; i < speaker.length; i++) {
    hash ^= speaker.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const r = mulberry32(hash >>> 0)();
  return 1 + (r * 2 - 1) * PILOT_RATE_SPREAD;
}

/** What the voice adapter needs from GameAudio: decode once, play on the
 * ducked voice bus. Both degrade to null/false without a running context. */
export interface VoiceSink {
  decodeVoice(data: ArrayBuffer): Promise<AudioBuffer | null>;
  playVoice(buffer: AudioBuffer, rate: number, onDone: () => void): boolean;
}

/**
 * Thin pre-rendered-buffer adapter: speaks a polled line by playing its
 * bundled OGG (squelch click-in and static tail-out are baked into the
 * files by tools/gen-radio-voices.sh) at the speaker's pilotRate. Assets
 * are fetched eagerly at construction and decoded once the AudioContext
 * runs (first user gesture); until a line's buffer is ready — or when
 * WebAudio is unavailable (headless QA) — the line stays ticker-only and
 * the queue's estimated duration paces the channel instead of the
 * buffer's end event.
 */
export class RadioVoice {
  /** asset id → fetched-but-undecoded bytes. */
  private readonly raw = new Map<string, ArrayBuffer>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private decoding = false;

  constructor(
    private readonly sink: VoiceSink,
    urls: Record<string, string>,
  ) {
    for (const [id, url] of Object.entries(urls)) {
      void fetch(url)
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .then((data) => {
          if (data) this.raw.set(id, data);
        })
        .catch(() => {}); // missing asset → that line stays ticker-only
    }
  }

  /** True once at least one line is decoded and playable. */
  get ready(): boolean {
    return this.buffers.size > 0;
  }

  /** Decode everything fetched so far; a no-op until the sink's context
   * runs, and cheap to re-kick (undecoded bytes stay in `raw`). */
  private ensureDecoded(): void {
    if (this.decoding || this.raw.size === 0) return;
    this.decoding = true;
    void (async () => {
      for (const [id, data] of this.raw) {
        const buffer = await this.sink.decodeVoice(data);
        if (!buffer) break; // context not running yet — retry on next speak
        this.buffers.set(id, buffer);
        this.raw.delete(id);
      }
      this.decoding = false;
    })();
  }

  /**
   * Put one line on the air. `onDone` fires when the buffer actually ends
   * (feed it RadioQueue.release so the channel frees early); it is never
   * called when nothing plays — the queue's estimate rules there.
   */
  speak(text: string, speaker: string, onDone: () => void): void {
    this.ensureDecoded();
    const id = resolveVoiceAsset(text, (asset) => this.buffers.has(asset));
    if (id === null) return;
    const buffer = this.buffers.get(id);
    if (buffer) this.sink.playVoice(buffer, pilotRate(speaker), onDone);
  }
}
