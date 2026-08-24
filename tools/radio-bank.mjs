// The radio render pipeline's pure part: which Piper voice the bundle is
// rendered with, and the exact line list the phrase bank expands into.
// tools/gen-radio-voices.mjs imports both and does everything impure
// (Piper, ffmpeg, writing OGGs) around them; client/test/radio-bank.test.ts
// is the seam's test surface.
//
// Plain ESM on purpose: gen-radio-voices.mjs runs under bare `node`, so it
// cannot import a .ts. The phrase bank is passed IN rather than imported
// here — the script hands over the on-the-fly tsc compile of
// client/src/game/phrases.ts, the test hands over the real module.

/**
 * The Piper voice the committed bundle is rendered with. Three places must
 * agree and the seam test enforces it: this constant, MODEL= in
 * gen-radio-voices.sh (which downloads it), and the licence record in
 * client/assets/radio/CREDITS.md.
 */
export const VOICE_MODEL = "en_US-joe-medium";

/**
 * Speaker id for a multi-speaker model, or null for a single-speaker one.
 * Passing -s to a single-speaker voice errors; omitting it on a
 * multi-speaker voice silently renders everything as speaker 0.
 */
export const VOICE_SPEAKER = null;

/** Wire callsigns carry digits; Piper reads them as words. */
const NUMBER_WORD = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
];

/** How many BANDIT-<n> callsigns get their own pre-rendered lines; past
 * this the runtime degrades to the anonymous variants (resolveVoiceAsset). */
export const RENDERED_CALLSIGNS = 12;

/**
 * Every line the bundle contains, as [assetText, spokenText] pairs.
 * `assetText` is what voiceSlug (client/src/audio/radio.ts) hashes into the
 * OGG filename — it carries the WIRE form, e.g. "BANDIT-7, checking in.".
 * `spokenText` is what Piper reads aloud.
 *
 * @param {Record<string, string>} PHRASE fixed brevity calls
 * @param {readonly string[]} AMBIENT_PHRASES ambient chatter bank
 * @returns {[string, string][]}
 */
export function voiceLines(PHRASE, AMBIENT_PHRASES) {
  const lines = [];
  for (const text of Object.values(PHRASE)) {
    // The two bare fragments are only ever voiced inside the callsign shapes.
    if (text === PHRASE.checkIn || text === PHRASE.offStation) continue;
    lines.push([text, text]);
  }
  for (const text of AMBIENT_PHRASES) lines.push([text, text]);
  for (let n = 1; n <= RENDERED_CALLSIGNS; n++) {
    lines.push([
      `BANDIT-${n}, ${PHRASE.checkIn}`,
      `Bandit ${NUMBER_WORD[n]}, ${PHRASE.checkIn}`,
    ]);
    lines.push([
      `BANDIT-${n} ${PHRASE.offStation}`,
      `Bandit ${NUMBER_WORD[n]} ${PHRASE.offStation}`,
    ]);
  }
  return lines;
}
