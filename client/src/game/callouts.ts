// Radio callouts — the pure seam (same idiom as freelook.ts/spatial.ts):
// event → Callout builders, threat geometry over wrapDelta, and the seeded
// ambient scheduler. No DOM, no WebAudio, no TTS in here — main.ts feeds
// these into the RadioQueue (audio/radio.ts) and the comms ticker.
//
// SECURITY GUARD (plan's named constraint): the `voice` field is what TTS
// speaks, and it is built ONLY from the fixed phrase bank plus bot callsigns
// that strictly match BANDIT-<n>. Free-text player names never reach it —
// they are a TTS griefing vector. The `ticker`/`speaker` fields MAY carry
// real names; the ticker renders them inert via textContent.

import { mulberry32 } from "@angels-bandits/common/city";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import { AMBIENT_PHRASES, PHRASE } from "./phrases";

/** Radio traffic classes, highest priority first (see RADIO_PRIORITY). */
export type RadioKind = "threat" | "own" | "kill" | "ambient";

export interface Callout {
  kind: RadioKind;
  /** Cooldown bucket + queue-dedupe key (one queued line per key). */
  key: string;
  /** Minimum ms between PLAYED lines of this key. */
  cooldownMs: number;
  /** Queued lines older than this are stale and dropped unplayed. */
  expiresMs: number;
  /** TTS text — never contains a free-text (human) player name. */
  voice: string;
  /** Ticker line text (safe for real names — rendered as textContent). */
  ticker: string;
  /** Ticker speaker label: bot callsign, human name, or a fixed net name. */
  speaker: string;
}

/** Per-event cooldowns, ms (plan: threat ≤ 1/12 s, others' kills ≤ 1/6 s). */
export const THREAT_COOLDOWN_MS = 12_000;
export const KILL_COOLDOWN_MS = 6_000;
const HIT_COOLDOWN_MS = 8_000;
const NEAR_MISS_COOLDOWN_MS = 8_000;
const CHECK_IN_COOLDOWN_MS = 3_000;

/** Pursuer counts as a threat inside this torus range, meters. */
export const THREAT_RANGE_M = 400;
/** …and only when their nose points within this cone of you, degrees. */
export const THREAT_CONE_DEG = 20;
const THREAT_CONE_COS = Math.cos((THREAT_CONE_DEG * Math.PI) / 180);

/** A remote plane's interpolated pose, reduced to threat inputs. */
export interface ThreatContact {
  pos: Vec3;
  /** World-space nose direction (any nonzero length). */
  fwd: Vec3;
}

/**
 * True when any contact is on the local player's six: within THREAT_RANGE_M,
 * nose within THREAT_CONE_DEG of the (torus-shortest) line to you, and aft
 * of your 3-9 line. Self forward from yaw is (−sin yaw, 0, −cos yaw) — the
 * flight convention: yaw 0 faces −Z, right turn decreases yaw.
 */
export function threatOnSix(
  selfPos: Vec3,
  selfYaw: number,
  contacts: readonly ThreatContact[],
): boolean {
  for (const contact of contacts) {
    const toSelf = wrapDelta(contact.pos, selfPos);
    const dist = Math.hypot(toSelf.x, toSelf.y, toSelf.z);
    if (dist > THREAT_RANGE_M || dist < 1e-6) continue;
    const fwdLen = Math.hypot(contact.fwd.x, contact.fwd.y, contact.fwd.z);
    if (fwdLen < 1e-6) continue;
    const aimCos =
      (contact.fwd.x * toSelf.x +
        contact.fwd.y * toSelf.y +
        contact.fwd.z * toSelf.z) /
      (fwdLen * dist);
    if (aimCos < THREAT_CONE_COS) continue;
    // Aft of the 3-9 line: self-forward · (self→attacker) < 0, written with
    // toSelf negated (wrapDelta(self, attacker) ≈ −toSelf on the torus).
    const behind =
      Math.sin(selfYaw) * toSelf.x + Math.cos(selfYaw) * toSelf.z < 0;
    if (behind) return true;
  }
  return false;
}

/** Server-minted bot callsigns are exactly BANDIT-<n> — anything else
 * (any human name, any spoofed bot name) is refused by the voice. */
const BOT_CALLSIGN = /^BANDIT-\d+$/;

/** The name if it is voice-safe (a real bot callsign), else null. */
export function safeCallsign(name: string, isBot: boolean): string | null {
  return isBot && BOT_CALLSIGN.test(name) ? name : null;
}

/** Another pilot scored a kill: their "Splash one." on the net. */
export function splashCallout(
  killerName: string,
  killerIsBot: boolean,
): Callout {
  return {
    kind: "kill",
    key: "kill",
    cooldownMs: KILL_COOLDOWN_MS,
    expiresMs: 15_000,
    voice: PHRASE.splashOne,
    ticker: "splash one",
    speaker: killerName,
  };
}

/** The local player scored the kill. */
export function ownKillCallout(selfName: string): Callout {
  return {
    kind: "own",
    key: "goodkill",
    cooldownMs: 1_000,
    expiresMs: 6_000,
    voice: PHRASE.goodKill,
    ticker: "good kill, good kill",
    speaker: selfName,
  };
}

/** The local player just died. */
export function maydayCallout(selfName: string): Callout {
  return {
    kind: "own",
    key: "mayday",
    cooldownMs: 0,
    expiresMs: 6_000,
    voice: PHRASE.mayday,
    ticker: "mayday, mayday, going down",
    speaker: selfName,
  };
}

/** Own HP crossed below the low-health threshold (edge-triggered by main). */
export function hitCallout(selfName: string): Callout {
  return {
    kind: "own",
    key: "imhit",
    cooldownMs: HIT_COOLDOWN_MS,
    expiresMs: 6_000,
    voice: PHRASE.imHit,
    ticker: "I'm hit, I'm hit",
    speaker: selfName,
  };
}

/** An enemy bullet just shaved past (the whoosh trigger). */
export function nearMissCallout(selfName: string): Callout {
  return {
    kind: "own",
    key: "nearmiss",
    cooldownMs: NEAR_MISS_COOLDOWN_MS,
    expiresMs: 4_000,
    voice: PHRASE.thatWasClose,
    ticker: "that was close",
    speaker: selfName,
  };
}

/** Someone is on the local player's six — the break call. */
export function threatCallout(_selfName: string): Callout {
  return {
    kind: "threat",
    key: "threat",
    cooldownMs: THREAT_COOLDOWN_MS,
    expiresMs: 4_000,
    voice: PHRASE.banditSix,
    ticker: "bandit on your six, break!",
    speaker: "GUARD",
  };
}

/** Roster join: bots check in by callsign, humans generically. */
export function checkInCallout(name: string, isBot: boolean): Callout {
  const callsign = safeCallsign(name, isBot);
  return {
    kind: "ambient",
    key: "checkin",
    cooldownMs: CHECK_IN_COOLDOWN_MS,
    expiresMs: 10_000,
    voice: callsign ? `${callsign}, ${PHRASE.checkIn}` : PHRASE.checkInAnon,
    ticker: PHRASE.checkIn,
    speaker: name,
  };
}

/** Roster leave: the mirror of check-in. */
export function offStationCallout(name: string, isBot: boolean): Callout {
  const callsign = safeCallsign(name, isBot);
  return {
    kind: "ambient",
    key: "checkin",
    cooldownMs: CHECK_IN_COOLDOWN_MS,
    expiresMs: 10_000,
    voice: callsign
      ? `${callsign} ${PHRASE.offStation}`
      : PHRASE.offStationAnon,
    ticker: PHRASE.offStation,
    speaker: name,
  };
}

/** Ambient chatter gap bounds, ms (plan: 20–45 s, seeded jitter). */
export const AMBIENT_MIN_GAP_MS = 20_000;
export const AMBIENT_MAX_GAP_MS = 45_000;

/**
 * Seeded ambient bot chatter: quiet-frequency filler between fights.
 * mulberry32 (shared with the city generator) drives both the cadence and
 * the phrase/speaker picks, so a given seed always produces the same
 * schedule — ambient need not be cross-client identical, just stable.
 * Combat suppression lives in RadioQueue, not here.
 */
export class AmbientChatter {
  private readonly rand: () => number;
  private nextAt: number;

  constructor(seed: number, now: number) {
    this.rand = mulberry32(seed);
    this.nextAt = now + this.gap();
  }

  private gap(): number {
    return (
      AMBIENT_MIN_GAP_MS +
      this.rand() * (AMBIENT_MAX_GAP_MS - AMBIENT_MIN_GAP_MS)
    );
  }

  /**
   * A due ambient line spoken by one of `botCallsigns`, or null. Polling a
   * due slot always reschedules the next one; an empty frequency (no bots
   * in the room) skips the slot silently — humans never generate ambient.
   */
  poll(now: number, botCallsigns: readonly string[]): Callout | null {
    if (now < this.nextAt) return null;
    this.nextAt = now + this.gap();
    const phrase =
      AMBIENT_PHRASES[Math.floor(this.rand() * AMBIENT_PHRASES.length)];
    const speaker = botCallsigns[Math.floor(this.rand() * botCallsigns.length)];
    if (phrase === undefined || speaker === undefined) return null;
    return {
      kind: "ambient",
      key: "ambient",
      cooldownMs: 0, // the seeded schedule IS the cooldown
      expiresMs: 12_000,
      voice: phrase, // fixed-bank text only — voice-safe by construction
      ticker: phrase,
      speaker,
    };
  }
}
