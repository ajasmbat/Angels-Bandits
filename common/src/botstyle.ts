// B3 bot personalities — one seeded flying style per BANDIT-<n> callsign.
//
// Derived from the callsign's number alone (seed from ids, never from where
// anything is), so the server's brain and every client's radio agree on a
// bot's style with nothing new on the wire. Callsigns are dealt in blocks of
// three, each block a seeded permutation of the three styles — so any room
// with three or more bots flies all three, and a refill never stacks a room
// with one temperament.

import { mulberry32 } from "./city/rng";

export type BotStyle = "aggressive" | "sniper" | "wingman";

export const BOT_STYLES: readonly BotStyle[] = [
  "aggressive",
  "sniper",
  "wingman",
];

/** How a style flies. Multipliers scale the shared BOT_* knobs. */
export interface BotStyleTuning {
  /** Break off (no new fights) below this HP fraction… */
  breakHp: number;
  /** …and come back once regen has it above this one (the hysteresis). */
  returnHp: number;
  /** Aim wander, × BOT_AIM_JITTER. */
  jitter: number;
  /** First-shot reaction delay, × BOT_REACTION_MS — never under 1: the F4
   * fairness floor holds for every style. */
  reaction: number;
  /** Joins a two-ship pincer on a shared target. */
  pincer: boolean;
  /** Prefers to stay this far out, m: inside it a chase holds the throttle
   * back instead of closing (0: presses in). */
  standoff: number;
  /** The defensive maneuver tried first when a contact sits on its six. */
  defense: "loop" | "roll";
}

export const BOT_STYLE_TUNING: Readonly<Record<BotStyle, BotStyleTuning>> = {
  aggressive: {
    breakHp: 0.2,
    returnHp: 0.7,
    jitter: 1.1,
    reaction: 1,
    pincer: true,
    standoff: 0,
    defense: "loop",
  },
  sniper: {
    breakHp: 0.45,
    returnHp: 0.9,
    jitter: 0.8,
    reaction: 1.25,
    pincer: false,
    standoff: 180,
    defense: "roll",
  },
  wingman: {
    breakHp: 0.35,
    returnHp: 0.8,
    jitter: 1,
    reaction: 1,
    pincer: true,
    standoff: 0,
    defense: "roll",
  },
};

/** The style of bot number `n` (BANDIT-<n>, n ≥ 1). */
export function botStyle(n: number): BotStyle {
  const k = Math.max(0, Math.floor(n) - 1);
  const block = Math.floor(k / BOT_STYLES.length);
  const rand = mulberry32((Math.imul(block + 1, 0x9e3779b1) ^ 0xb3571e5) >>> 0);
  // Fisher–Yates over the three styles, seeded per block.
  const deck = [...BOT_STYLES];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = deck[i] as BotStyle;
    deck[i] = deck[j] as BotStyle;
    deck[j] = t;
  }
  return deck[k % deck.length] as BotStyle;
}

const CALLSIGN = /^BANDIT-(\d+)$/;

/** The style behind a bot callsign, or null for anything that is not one. */
export function botStyleOfName(name: string): BotStyle | null {
  const m = CALLSIGN.exec(name);
  return m ? botStyle(Number(m[1])) : null;
}
