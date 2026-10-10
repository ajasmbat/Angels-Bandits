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

import { type BotStyle, botStyleOfName } from "@angels-bandits/common/botstyle";
import { mulberry32 } from "@angels-bandits/common/city";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import type { ComboKind, MomentKind } from "./juice";
import { AMBIENT_PHRASES, PHRASE, STYLE_AMBIENT } from "./phrases";

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

/** Own HP below this voices "I'm hit" (edge-triggered, re-armed on regen). */
export const LOW_HP_CALLOUT = 30;

/** Per-event cooldowns, ms (plan: threat ≤ 1/12 s, others' kills ≤ 1/6 s). */
export const THREAT_COOLDOWN_MS = 12_000;
export const KILL_COOLDOWN_MS = 6_000;
const HIT_COOLDOWN_MS = 8_000;
const NEAR_MISS_COOLDOWN_MS = 8_000;
const CHECK_IN_COOLDOWN_MS = 3_000;
/** X1: one "incoming" per this long — two strikes in a row are one call. */
const INCOMING_COOLDOWN_MS = 6_000;

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

/** B3: how each bot style signs off a kill on the ticker (the voice stays
 * the fixed "Splash one."). */
const STYLE_SPLASH: Readonly<Record<BotStyle, string>> = {
  aggressive: "splash one — who's next?",
  sniper: "splash one. Clean shot.",
  wingman: "splash one, rejoining",
};

/** B3: a bot's style as its check-in ticker reads it. */
const STYLE_TAG: Readonly<Record<BotStyle, string>> = {
  aggressive: "aggressive, guns hot",
  sniper: "sniper, long shots",
  wingman: "wingman, looking for a lead",
};

/** The style of a voice-safe bot callsign, else null (humans, spoofs). */
function styleOf(name: string, isBot: boolean): BotStyle | null {
  const callsign = safeCallsign(name, isBot);
  return callsign ? botStyleOfName(callsign) : null;
}

/** Another pilot scored a kill: their "Splash one." on the net. With
 * `styled`, a bot killer's ticker line carries its style (B3). */
export function splashCallout(
  killerName: string,
  killerIsBot: boolean,
  styled = false,
): Callout {
  const style = styled ? styleOf(killerName, killerIsBot) : null;
  return {
    kind: "kill",
    key: "kill",
    cooldownMs: KILL_COOLDOWN_MS,
    expiresMs: 15_000,
    voice: PHRASE.splashOne,
    ticker: style ? STYLE_SPLASH[style] : "splash one",
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

/** J1: a combo's announcer line. It shares the own kill's `goodkill` key
 * and replaces it — a double kill is one call, not "good kill" twice and a
 * combo after. Expires fast: a late combo call is worse than none. */
const COMBO_VOICE: Readonly<Record<ComboKind, string>> = {
  double: PHRASE.comboDouble,
  triple: PHRASE.comboTriple,
  multi: PHRASE.comboMulti,
};
const COMBO_TICKER: Readonly<Record<ComboKind, string>> = {
  double: "double kill!",
  triple: "triple kill!",
  multi: "multi kill — they're falling out of the sky",
};

export function comboCallout(combo: ComboKind): Callout {
  return {
    kind: "own",
    key: "goodkill",
    cooldownMs: 0,
    expiresMs: 3_000,
    voice: COMBO_VOICE[combo],
    ticker: COMBO_TICKER[combo],
    speaker: "CONTROL",
  };
}

/** J1: a carrier-war moment the local pilot earned (W2's bomber, the
 * carrier, W3's AA assist, a wave cleared). */
const MOMENT_VOICE: Readonly<Record<MomentKind, string>> = {
  bomber: PHRASE.bomberStopped,
  carrier: PHRASE.carrierDown,
  aa: PHRASE.aaAssist,
  wave: PHRASE.waveCleared,
};
const MOMENT_TICKER: Readonly<Record<MomentKind, string>> = {
  bomber: "bomber stopped — nice work",
  carrier: "CARRIER DOWN! CARRIER DOWN!",
  aa: "triple-A assist — good shooting, ground crew",
  wave: "wave cleared — regroup",
};

export function momentCallout(kind: MomentKind): Callout {
  return {
    kind: "own",
    key: `moment-${kind}`,
    cooldownMs: 0,
    expiresMs: kind === "carrier" || kind === "wave" ? 8_000 : 4_000,
    voice: MOMENT_VOICE[kind],
    ticker: MOMENT_TICKER[kind],
    speaker: "CONTROL",
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

/** Enemy streak lines share this cooldown: a full bot room crosses tiers
 * often, and the channel is for the fight, not the scoreboard. */
export const ENEMY_STREAK_COOLDOWN_MS = 10_000;

const OWN_STREAK_VOICE = {
  3: PHRASE.streakThree,
  5: PHRASE.streakFive,
  10: PHRASE.streakTen,
} as const;
const ENEMY_STREAK_VOICE = {
  3: PHRASE.enemyStreakThree,
  5: PHRASE.enemyStreakFive,
  10: PHRASE.enemyStreakTen,
} as const;

/**
 * S7 announcer: a pilot crossed a kill-streak tier. The local pilot's own
 * streak is an `own` line that always airs; anyone else's is a `kill` line
 * on a shared cooldown. The voice is fixed bank text — it never names the
 * pilot; the ticker does (real names are safe there).
 */
export function streakCallout(
  tier: 3 | 5 | 10,
  own: boolean,
  pilotName: string,
): Callout {
  return own
    ? {
        kind: "own",
        key: "ownstreak",
        cooldownMs: 0,
        expiresMs: 8_000,
        voice: OWN_STREAK_VOICE[tier],
        ticker: `${tier} in a row — you're on a streak`,
        speaker: "CONTROL",
      }
    : {
        kind: "kill",
        key: "streak",
        cooldownMs: ENEMY_STREAK_COOLDOWN_MS,
        expiresMs: 8_000,
        voice: ENEMY_STREAK_VOICE[tier],
        ticker: `${pilotName} is on a ${tier}-kill streak`,
        speaker: "CONTROL",
      };
}

/** X1: a missile strike is coming down near the local plane. Expires fast:
 * a late "incoming" after the blast is worse than none. */
export function incomingCallout(): Callout {
  return {
    kind: "threat",
    key: "incoming",
    cooldownMs: INCOMING_COOLDOWN_MS,
    expiresMs: 1_500,
    voice: PHRASE.incoming,
    ticker: "INCOMING!",
    speaker: "GUARD",
  };
}

/** S4: one "flak" per this long — a turret volley is one call. */
const FLAK_COOLDOWN_MS = 15_000;

/** S4: a sky-boss raid begins — the whole room hears it once. */
export function bossInboundCallout(): Callout {
  return {
    kind: "threat",
    key: "boss",
    cooldownMs: 0,
    expiresMs: 12_000,
    voice: PHRASE.bossInbound,
    ticker: "Enemy war zeppelin inbound — hit the engines and gas cells",
    speaker: "CONTROL",
  };
}

/** S4: a flak burst close to the local plane. Expires fast, like
 * "incoming": a late call after the burst is worse than none. */
export function flakCallout(): Callout {
  return {
    kind: "threat",
    key: "flak",
    cooldownMs: FLAK_COOLDOWN_MS,
    expiresMs: 2_000,
    voice: PHRASE.flak,
    ticker: "FLAK! BREAK!",
    speaker: "GUARD",
  };
}

/** S9: one carrier-launch call per this long — a raid launches a bot every
 * few seconds; the radio names it, it does not narrate each one. */
const CARRIER_LAUNCH_COOLDOWN_MS = 20_000;

/** S9: bandits launching off the boss carrier. */
export function carrierLaunchCallout(): Callout {
  return {
    kind: "threat",
    key: "carrier",
    cooldownMs: CARRIER_LAUNCH_COOLDOWN_MS,
    expiresMs: 4_000,
    voice: PHRASE.carrierLaunch,
    ticker: "BANDITS LAUNCHING FROM THE CARRIER",
    speaker: "CONTROL",
  };
}

/** S4: the zeppelin is down (`own`: we dealt the most), or it got away. */
export function bossEndCallout(down: boolean): Callout {
  return {
    kind: "kill",
    key: "bossend",
    cooldownMs: 0,
    expiresMs: 10_000,
    voice: down ? PHRASE.bossDown : PHRASE.bossEscaped,
    ticker: down
      ? "The zeppelin is going down — clear the area"
      : "The zeppelin is pulling out — it got away",
    speaker: "CONTROL",
  };
}

/** Roster join: bots check in by callsign, humans generically. A bot's
 * ticker line names its flying style (B3) — the voice never changes, so it
 * still resolves to the rendered "BANDIT-<n>, checking in." asset. */
export function checkInCallout(name: string, isBot: boolean): Callout {
  const callsign = safeCallsign(name, isBot);
  const style = styleOf(name, isBot);
  return {
    kind: "ambient",
    key: "checkin",
    cooldownMs: CHECK_IN_COOLDOWN_MS,
    expiresMs: 10_000,
    voice: callsign ? `${callsign}, ${PHRASE.checkIn}` : PHRASE.checkInAnon,
    ticker: style ? `${PHRASE.checkIn} ${STYLE_TAG[style]}.` : PHRASE.checkIn,
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
    const pick = this.rand();
    const speaker = botCallsigns[Math.floor(this.rand() * botCallsigns.length)];
    // B3: a bot speaks in its style — its own voiced subset of the bank.
    const style = speaker === undefined ? null : botStyleOfName(speaker);
    const bank = style ? STYLE_AMBIENT[style] : AMBIENT_PHRASES;
    const phrase = bank[Math.floor(pick * bank.length)];
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
