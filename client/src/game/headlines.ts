// S1 match headlines — the pure seam behind the jumbotrons and LED tickers
// (same idiom as callouts.ts): who leads, what a death reads as on a screen
// the whole room can see, and which plane the LAST KILL card shows. No DOM,
// no THREE. Every output is a function of what the server broadcast to the
// whole room (deaths with their kill site, score tallies, the roster) and
// the seeded weather, so two clients that saw the same kill print the same
// headline, word for word.
//
// NAME GUARD (the radio's rule, extended to the city): a world screen is
// read by everyone in the room, so free-text player names never reach one.
// A bot shows its callsign only when it passes callouts.ts `safeCallsign`
// (strictly BANDIT-<n>); a human — and anything that fails the guard — shows
// a fixed alias derived from their id (`VIPER-27`). The HUD kill feed keeps
// real names; it renders them inert and only to the local player.

import {
  CONSTRUCTION_BLOCKS,
  LANDMARK_BLOCKS,
  PLAZA_BLOCKS,
} from "@angels-bandits/common/city";
import { isRiverRow } from "@angels-bandits/common/city/river";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import type { DeathMsg, ScoreEntry } from "@angels-bandits/common/protocol";
import type { Weather } from "@angels-bandits/common/weather";
import { safeCallsign } from "./callouts";

/** FNV-1a over a string — the same stable hash liveryFor() rides. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Alias words for pilots whose name may not be shown. Fixed, profanity-free
 * and never "BANDIT", so an alias can never pass for a bot callsign. */
export const ALIAS_WORDS: readonly string[] = [
  "ACE",
  "VIPER",
  "FALCON",
  "GHOST",
  "RAVEN",
  "COBRA",
  "HAWK",
  "LANCER",
  "COMET",
  "TALON",
  "SABRE",
  "ROOK",
];

/** A pilot's stable on-screen alias: a word and two digits from the id
 * (digits only — a letter suffix could spell something). */
export function pilotAlias(id: string): string {
  const h = hash(id);
  const word = ALIAS_WORDS[h % ALIAS_WORDS.length] as string;
  return `${word}-${10 + ((h >>> 8) % 90)}`;
}

/** What a roster entry looks like to the headline model. */
export interface PilotInfo {
  name: string;
  isBot: boolean;
}

/** The label a world screen may show for pilot `id`: the bot callsign when
 * the name guard passes it, else the alias. Unknown ids get the alias too —
 * it depends on the id alone, so every client still agrees. */
export function pilotLabel(id: string, info: PilotInfo | undefined): string {
  return (info && safeCallsign(info.name, info.isBot)) ?? pilotAlias(id);
}

/**
 * The TOP PILOT: most kills, then fewest deaths, then the lower id — a pure
 * function of the broadcast tallies, so every client in the room crowns the
 * same pilot (no per-client incumbency to diverge on). Null until somebody
 * has a kill.
 */
export function topPilot(scores: readonly ScoreEntry[]): ScoreEntry | null {
  let best: ScoreEntry | null = null;
  for (const s of scores) {
    if (s.kills <= 0) continue;
    if (
      best === null ||
      s.kills > best.kills ||
      (s.kills === best.kills &&
        (s.deaths < best.deaths ||
          (s.deaths === best.deaths && s.id < best.id)))
    ) {
      best = s;
    }
  }
  return best;
}

/** Fictional names for the hand-placed landmarks, in LANDMARK_BLOCKS order. */
export const LANDMARK_NAMES: readonly string[] = [
  "THE NEEDLE",
  "MERIDIAN TOWER",
  "THE SPIRE",
  "HALCYON TOWER",
];
/** …and for the plazas, in PLAZA_BLOCKS order. */
export const PLAZA_NAMES: readonly string[] = [
  "FOUNTAIN PLAZA",
  "LANTERN SQUARE",
  "MARKET COMMONS",
];

const GRID = WORLD_SIZE / BLOCK_PITCH;
/** Torus-wrapped block-index distance (Chebyshev per axis). */
const blockDist = (a: number, b: number): number => {
  const d = (((a - b) % GRID) + GRID) % GRID;
  return Math.min(d, GRID - d);
};
const indexAt = (
  blocks: ReadonlyArray<readonly [number, number]>,
  bx: number,
  bz: number,
  within: number,
): number =>
  blocks.findIndex(
    ([x, z]) => Math.max(blockDist(bx, x), blockDist(bz, z)) <= within,
  );

/**
 * Where a kill happened, as a headline tail: "OVER THE RIVER", "OVER THE
 * SPIRE", "NEAR FOUNTAIN PLAZA"… From the server's kill site, so every
 * client names the same place; "" when the death carried no site.
 */
export function placePhrase(x?: number, z?: number): string {
  if (x === undefined || z === undefined) return "";
  const bx = Math.floor(x / BLOCK_PITCH);
  const bz = Math.floor(z / BLOCK_PITCH);
  const landmark = indexAt(LANDMARK_BLOCKS, bx, bz, 0);
  if (landmark >= 0) return `OVER ${LANDMARK_NAMES[landmark]}`;
  const plaza = indexAt(PLAZA_BLOCKS, bx, bz, 0);
  if (plaza >= 0) return `OVER ${PLAZA_NAMES[plaza]}`;
  if (isRiverRow(bz)) return "OVER THE RIVER";
  if (indexAt(CONSTRUCTION_BLOCKS, bx, bz, 0) >= 0) return "OVER THE CRANES";
  const nearLandmark = indexAt(LANDMARK_BLOCKS, bx, bz, 1);
  if (nearLandmark >= 0) return `NEAR ${LANDMARK_NAMES[nearLandmark]}`;
  const nearPlaza = indexAt(PLAZA_BLOCKS, bx, bz, 1);
  if (nearPlaza >= 0) return `NEAR ${PLAZA_NAMES[nearPlaza]}`;
  return "OVER DOWNTOWN";
}

/** The death fields the headline reads (DeathMsg without its `type`). */
export type HeadlineDeath = Pick<
  DeathMsg,
  "victimId" | "killerId" | "cause" | "x" | "z"
>;

const SHOT_VERBS = ["DOWNS", "SPLASHES", "TAKES OUT", "DROPS", "SMOKES"];
const FORCED_VERBS = ["FORCES DOWN", "RUNS DOWN", "CHASES DOWN"];
const CRASH_VERBS = ["CRASHES", "GOES DOWN", "AUGERS IN"];
const STORM_LEADS = ["LIGHTNING STRIKES", "STORM CLAIMS", "BOLT TAKES"];

const pick = (list: readonly string[], seed: number): string =>
  list[seed % list.length] as string;

/**
 * The headline for one death. `label` maps an id to its guarded on-screen
 * label (pilotLabel); `victimDeathsBefore` is the victim's death tally from
 * the scores held when the death landed — the server sends every death
 * BEFORE its score broadcast, so that is the same number on every client and
 * the verb rotates kill to kill without any client-side counter.
 */
export function killHeadline(
  death: HeadlineDeath,
  label: (id: string) => string,
  victimDeathsBefore: number,
): string {
  const seed = hash(
    `${death.killerId ?? "-"}|${death.victimId}|${victimDeathsBefore}`,
  );
  const victim = label(death.victimId);
  const place = placePhrase(death.x, death.z);
  let line: string;
  if (death.cause === "storm") {
    line = `${pick(STORM_LEADS, seed)} ${victim}`;
  } else if (death.killerId === null) {
    line = `${victim} ${pick(CRASH_VERBS, seed)}`;
  } else if (death.cause === "crash") {
    line = `${label(death.killerId)} ${pick(FORCED_VERBS, seed)} ${victim}`;
  } else {
    line = `${label(death.killerId)} ${pick(SHOT_VERBS, seed)} ${victim}`;
  }
  return place ? `${line} ${place}` : line;
}

/** One short kill-feed line for a world screen (the HUD feed's glyphs, the
 * guarded labels). */
export function feedLine(
  death: HeadlineDeath,
  label: (id: string) => string,
): string {
  const victim = label(death.victimId);
  if (death.cause === "storm") return `⚡ ${victim}`;
  if (death.killerId === null) return `☠ ${victim}`;
  const glyph = death.cause === "crash" ? "✕" : "▸";
  return `${label(death.killerId)} ${glyph} ${victim}`;
}

/** What the LAST KILL card shows: whose plane, under which caption. */
export interface ReplaySubject {
  id: string;
  caption: string;
}

/** The killer's plane — or, when nobody gets the credit (a storm kill, an
 * un-credited crash), the plane that went down. */
export function replaySubject(death: HeadlineDeath): ReplaySubject {
  if (death.cause === "storm") {
    return { id: death.victimId, caption: "STORM KILL" };
  }
  if (death.killerId === null) {
    return { id: death.victimId, caption: "WIPEOUT" };
  }
  return { id: death.killerId, caption: "LAST KILL" };
}

/** A banner the screens carry above everything else. D5 (destruction) will
 * add its own kind; today the storm is the only source. */
export interface MatchWarning {
  kind: "storm";
  text: string;
}

/** Share of the drizzle phase after which the storm is announced. */
const STORM_APPROACH_T = 0.6;
/** Share of the clearing phase the all-clear stays up. */
const STORM_CLEARING_T = 0.3;

/** The storm banners — fixed objects, so the per-frame weather check never
 * allocates (and the screens compare them by identity). */
export const STORM_INBOUND: MatchWarning = {
  kind: "storm",
  text: "STORM WARNING — DOWNPOUR INBOUND",
};
export const STORM_OVERHEAD: MatchWarning = {
  kind: "storm",
  text: "STORM WARNING — LIGHTNING OVER THE CITY",
};
export const STORM_CLEARING: MatchWarning = {
  kind: "storm",
  text: "STORM CLEARING",
};

/**
 * The storm banner for the shared weather. It reports the WEATHER only —
 * never the hidden death ceiling, which is discovered, not announced.
 * Changes a handful of times per 32-minute cycle, so the screens repaint
 * for it rarely.
 */
export function stormWarning(weather: Weather): MatchWarning | null {
  switch (weather.phase) {
    case "drizzle":
      return weather.phaseT >= STORM_APPROACH_T ? STORM_INBOUND : null;
    case "downpour":
      return STORM_OVERHEAD;
    case "clearing":
      return weather.phaseT < STORM_CLEARING_T ? STORM_CLEARING : null;
    default:
      return null;
  }
}
