// Renders every radio voice line (see gen-radio-voices.sh for the one-shot
// entry point): phrase bank + BANDIT-1..12 callsign variants → Piper TTS →
// the "hard" military-radio chain (the design pick: bandpass 280–3200 Hz,
// 6:1 compression, +6 dB drive into soft clip, pink-noise bed, baked squelch
// click-in / static tail-out, −18 LUFS) → mono 24 kHz OGG Vorbis in
// client/assets/radio/<voiceSlug>.ogg.
//
// The phrase bank is imported from client/src/game/phrases.ts (compiled on
// the fly with the repo's tsc), so the bank stays the single source of
// truth. The slug derivation MUST match voiceSlug in client/src/audio/
// radio.ts — the bank↔bundle test in client/test/radio.test.ts trips if
// either side drifts. Reruns reproduce the same FILE SET (names/coverage;
// the test enforces it); every ffmpeg stage is seeded/bitexact, but Piper's
// VITS sampling is internally random (no seed exposed), so bytes differ
// between renders while the delivery stays equivalent.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CACHE = "tools/.cache";
const PIPER = `${CACHE}/piper-venv/bin/piper`;
const MODEL = `${CACHE}/voices/en_US-joe-medium.onnx`;
const OUT = "client/assets/radio";
const TMP = `${CACHE}/render`;

// --- The radio chain (design Concept 2: "Joe" x Hard) -----------------------
// 16 kHz: the chain lowpasses at 3.8 kHz, so 8 kHz Nyquist is transparent
// here and Vorbis's bitrate floor sits ~30% lower than at 24 kHz.
const SAMPLE_RATE = 16000;
const CHAIN = {
  highpassHz: 280,
  lowpassHz: 3200,
  compressRatio: 6,
  driveDb: 6,
  clipThreshold: 0.4,
  noiseAmplitude: 0.012,
  postLowpassHz: 3800,
};
// Delivery: slightly fast, clipped military cadence.
const LENGTH_SCALE = "0.9";
const SENTENCE_SILENCE = "0.15";

/** Must match voiceSlug in client/src/audio/radio.ts exactly. */
const voiceSlug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// --- Line list from the bank -------------------------------------------------
// phrases.ts has zero imports, so a single-file tsc compile suffices.
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
execFileSync("npx", [
  "tsc",
  "client/src/game/phrases.ts",
  "--outDir",
  `${TMP}/bank`,
  "--module",
  "esnext",
  "--target",
  "es2022",
  // Keep the single-file compile clean of the workspace's ambient @types
  // (classic resolution can't find their transitive deps and exits red).
  "--moduleResolution",
  "bundler",
  "--skipLibCheck",
  "--types",
  "node",
]);
const { PHRASE, AMBIENT_PHRASES } = await import(
  pathToFileURL(`${TMP}/bank/phrases.js`).href
);

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

/** [asset text (slug source), spoken text piper reads] */
const lines = [];
for (const text of Object.values(PHRASE)) {
  // The two bare fragments are only ever voiced inside the callsign shapes.
  if (text === PHRASE.checkIn || text === PHRASE.offStation) continue;
  lines.push([text, text]);
}
for (const text of AMBIENT_PHRASES) lines.push([text, text]);
for (let n = 1; n <= 12; n++) {
  // Voice strings carry the wire callsign; piper reads it as words.
  lines.push([
    `BANDIT-${n}, ${PHRASE.checkIn}`,
    `Bandit ${NUMBER_WORD[n]}, ${PHRASE.checkIn}`,
  ]);
  lines.push([
    `BANDIT-${n} ${PHRASE.offStation}`,
    `Bandit ${NUMBER_WORD[n]} ${PHRASE.offStation}`,
  ]);
}

// --- Render ------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
// Drop stale renders so a removed bank line doesn't linger in the bundle.
for (const f of readdirSync(OUT)) {
  if (f.endsWith(".ogg")) rmSync(`${OUT}/${f}`);
}
const ffmpeg = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

// Framing pieces are rendered once and concatenated onto every line: the
// squelch click that opens the channel and the static tail that closes it
// (the runtime plays the file as-is — no separate framing SFX anymore).
ffmpeg([
  "-filter_complex",
  [
    `anoisesrc=color=white:amplitude=0.5:duration=0.025:sample_rate=${SAMPLE_RATE}:seed=7,`,
    "highpass=f=1200,afade=t=out:st=0.012:d=0.013[c]",
  ].join(""),
  "-map",
  "[c]",
  "-ac",
  "1",
  `${TMP}/click.wav`,
]);
ffmpeg([
  "-filter_complex",
  `anoisesrc=color=white:amplitude=0.22:duration=0.13:sample_rate=${SAMPLE_RATE}:seed=11,` +
    `highpass=f=500,lowpass=f=${CHAIN.postLowpassHz},afade=t=out:st=0.10:d=0.03[t]`,
  "-map",
  "[t]",
  "-ac",
  "1",
  `${TMP}/tail.wav`,
]);

let total = 0;
for (const [text, spoken] of lines) {
  const slug = voiceSlug(text);
  const raw = `${TMP}/${slug}.wav`;
  execFileSync(
    PIPER,
    [
      "-m",
      MODEL,
      "--length-scale",
      LENGTH_SCALE,
      "--sentence-silence",
      SENTENCE_SILENCE,
      "-f",
      raw,
    ],
    { input: spoken },
  );
  const dur = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    raw,
  ])
    .toString()
    .trim();
  ffmpeg([
    "-i",
    raw,
    "-filter_complex",
    [
      `[0:a]aresample=${SAMPLE_RATE},`,
      `highpass=f=${CHAIN.highpassHz}:p=2,lowpass=f=${CHAIN.lowpassHz}:p=2,`,
      "acompressor=threshold=-24dB:ratio=",
      `${CHAIN.compressRatio}:attack=4:release=90:makeup=6,`,
      `volume=${CHAIN.driveDb}dB,asoftclip=type=atan:threshold=${CHAIN.clipThreshold},`,
      `highpass=f=300,lowpass=f=${CHAIN.postLowpassHz},alimiter=limit=0.95:level=false[sp];`,
      `anoisesrc=color=pink:amplitude=${CHAIN.noiseAmplitude}:duration=${dur}:sample_rate=${SAMPLE_RATE}:seed=23,`,
      `highpass=f=400,lowpass=f=${CHAIN.postLowpassHz}[nb];`,
      "[sp][nb]amix=inputs=2:duration=first:normalize=0[mix]",
    ].join(""),
    "-map",
    "[mix]",
    "-ac",
    "1",
    `${TMP}/${slug}.proc.wav`,
  ]);
  ffmpeg([
    "-i",
    `${TMP}/click.wav`,
    "-i",
    `${TMP}/${slug}.proc.wav`,
    "-i",
    `${TMP}/tail.wav`,
    "-filter_complex",
    "[0:a][1:a][2:a]concat=n=3:v=0:a=1,loudnorm=I=-18:TP=-1.0:LRA=9[o]",
    "-map",
    "[o]",
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-c:a",
    "libvorbis",
    "-q:a",
    "-1",
    // Byte-identical reruns: fixed Ogg stream serial (random by default)
    // and no encoder-version metadata.
    "-serial_offset",
    "42",
    "-flags:a",
    "+bitexact",
    "-map_metadata",
    "-1",
    `${OUT}/${slug}.ogg`,
  ]);
  const size = statSync(`${OUT}/${slug}.ogg`).size;
  total += size;
  console.log(`${slug}.ogg  ${(size / 1024).toFixed(1)} KB`);
}

const files = readdirSync(OUT).filter((f) => f.endsWith(".ogg"));
console.log(
  `\n${lines.length} lines rendered, ${files.length} OGGs in ${OUT}, ` +
    `${(total / 1024).toFixed(0)} KB total`,
);
