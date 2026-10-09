// The radio phrase bank — every string the TTS voice is allowed to speak
// (plus the ticker renderings of the same lines). Fixed, hand-written,
// profanity-free. The voice NEVER speaks anything outside this file except
// strictly-validated BANDIT-<n> bot callsigns (see callouts.ts safeCallsign)
// — free-text player names are a TTS griefing vector and stay ticker-only.

import type { BotStyle } from "@angels-bandits/common/botstyle";

/** Event brevity calls (voice text / ticker text pairs live in callouts.ts). */
export const PHRASE = {
  splashOne: "Splash one.",
  goodKill: "Good kill, good kill.",
  mayday: "Mayday, mayday, going down.",
  banditSix: "Bandit on your six, break!",
  imHit: "I'm hit, I'm hit.",
  thatWasClose: "That was close.",
  incoming: "Incoming! Incoming!",
  checkIn: "checking in.",
  checkInAnon: "New contact, checking in.",
  offStation: "off station.",
  offStationAnon: "Contact off station.",
  // S7 announcer: kill-streak tiers. Fixed text only — a streak line never
  // names its pilot (the ticker does that, inert).
  streakThree: "Three in a row. You're on a streak.",
  streakFive: "Five kills. Unstoppable.",
  streakTen: "Ten kills. You're the ace of the sky.",
  enemyStreakThree: "Heads up, enemy on a three kill streak.",
  enemyStreakFive: "Enemy on a five kill streak. Take them down.",
  enemyStreakTen: "Enemy ace, ten kills. All stations, engage.",
  // S4 sky boss: the raid's arrival, its flak, its end either way.
  bossInbound: "All stations, enemy war zeppelin inbound. Hit the engines.",
  flak: "Flak, flak! Break!",
  bossDown: "The zeppelin is going down! Clear the area!",
  bossEscaped: "The zeppelin is pulling out. It got away.",
} as const;

/**
 * Ambient bot chatter fillers — quiet-frequency color between fights,
 * spoken as-is. Cadence is seeded (mulberry32) in callouts.ts.
 */
export const AMBIENT_PHRASES: readonly string[] = [
  "Two, radar contact, nothing.",
  "Fuel state green.",
  "Copy, holding pattern.",
  "Three, wings level, on station.",
  "Negative contact, continuing sweep.",
  "Winds aloft steady, visibility good.",
  "Four, orbiting the tower block.",
  "Comm check, loud and clear.",
  "Holding angels three, all quiet.",
  "Passing the north sector, no joy.",
  "Two, say fuel. Fuel state green.",
  "Steady heading, scanning low.",
  "Skyline clear on my side.",
  "Five, midtown sweep complete.",
  "Nothing on the scope, boss.",
  "Keeping it low between the towers.",
  "Six, climbing to angels four.",
  "Neon glare's rough tonight.",
  "Watch the supertall on the east line.",
  "Copy that, resuming patrol.",
  "All stations, radio discipline, keep it short.",
  "Two circuits done, starting a third.",
  "Crossing the seam, station passing north.",
  "Traffic below is heavy, staying high.",
  "Rooftop beacons in sight, on course.",
  "No bandits this pass, turning back.",
  "Engine's running smooth, temps good.",
  "Quiet night so far. Stay sharp.",
  // Our own renders of the tools/radio-reference/ Pixabay lines — the
  // reference audio itself is calibration-only and never ships.
  "Engaging enemy.",
  "Roger, prepare for medevac.",
];

/**
 * B3 bot personalities on the net: each style's ambient lines — a voiced
 * subset of AMBIENT_PHRASES (every one already rendered), so a bot's chatter
 * sounds like its style without a single new line for the TTS bank.
 */
export const STYLE_AMBIENT: Readonly<Record<BotStyle, readonly string[]>> = {
  aggressive: [
    "Engaging enemy.",
    "Keeping it low between the towers.",
    "No bandits this pass, turning back.",
    "Quiet night so far. Stay sharp.",
    "Passing the north sector, no joy.",
  ],
  sniper: [
    "Steady heading, scanning low.",
    "Holding angels three, all quiet.",
    "Watch the supertall on the east line.",
    "Rooftop beacons in sight, on course.",
    "Skyline clear on my side.",
  ],
  wingman: [
    "Copy, holding pattern.",
    "Copy that, resuming patrol.",
    "Comm check, loud and clear.",
    "Two, say fuel. Fuel state green.",
    "Two circuits done, starting a third.",
  ],
};
