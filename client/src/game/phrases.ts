// The radio phrase bank — every string the TTS voice is allowed to speak
// (plus the ticker renderings of the same lines). Fixed, hand-written,
// profanity-free. The voice NEVER speaks anything outside this file except
// strictly-validated BANDIT-<n> bot callsigns (see callouts.ts safeCallsign)
// — free-text player names are a TTS griefing vector and stay ticker-only.

/** Event brevity calls (voice text / ticker text pairs live in callouts.ts). */
export const PHRASE = {
  splashOne: "Splash one.",
  goodKill: "Good kill, good kill.",
  mayday: "Mayday, mayday, going down.",
  banditSix: "Bandit on your six, break!",
  imHit: "I'm hit, I'm hit.",
  thatWasClose: "That was close.",
  checkIn: "checking in.",
  checkInAnon: "New contact, checking in.",
  offStation: "off station.",
  offStationAnon: "Contact off station.",
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
