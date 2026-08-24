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
 * The Piper voice the committed bundle is rendered with — the single place
 * it is named. gen-radio-voices.sh reads it from here to download the
 * model; the seam test additionally holds the licence record in
 * client/assets/radio/CREDITS.md to it, since that one is prose a human
 * maintains and cannot be derived.
 *
 * Chosen by ear over an audition of five candidates against the reference
 * recordings in tools/radio-reference/ (ticket ANGE-N0UOVH): the
 * en_US-joe-medium bank it replaces was reported as audibly robotic.
 * LibriTTS is trained on audiobook reading rather than prompted studio
 * lines, which is what buys the conversational delivery.
 */
export const VOICE_MODEL = "en_US-libritts-high";

/**
 * Speaker id for a multi-speaker model, or null for a single-speaker one.
 * Passing -s to a single-speaker voice errors; omitting it on a
 * multi-speaker voice silently renders everything as speaker 0.
 *
 * LibriTTS carries 904 speakers, so the voice is a choice rather than a
 * given. Candidates were narrowed by measuring the fundamental frequency
 * of a test render per speaker and keeping the male band; 90 is the
 * deepest of those (~107 Hz) and was picked from the audition.
 */
export const VOICE_SPEAKER = 90;

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
