// Bundle integrity for the committed radio voice lines. The bank↔bundle
// test in radio.test.ts proves every phrase HAS a file; this proves each
// file is a usable one. A re-render that produced silence, a truncated
// line, a stereo or wrong-rate stream, or one that blew the size budget
// passes the filename check and fails here.
//
// The OGG pages are parsed directly rather than shelled out to ffprobe:
// the suite has to run wherever `npm test` runs, and ffmpeg is a
// build-time dependency of tools/gen-radio-voices.sh, not of the tests.

import { execFile, execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Channel count, sample rate and duration of an Ogg Vorbis file, read from
 * its own headers (Vorbis I spec §4.2.2 for the identification header,
 * Ogg RFC 3533 §6 for the page structure).
 */
function probeOgg(bytes: Buffer): {
  channels: number;
  sampleRate: number;
  seconds: number;
} {
  let offset = 0;
  let firstPageData: Buffer | null = null;
  let lastGranule = 0n;
  while (offset + 27 <= bytes.length) {
    if (bytes.toString("latin1", offset, offset + 4) !== "OggS") {
      throw new Error(`not an Ogg page at byte ${offset}`);
    }
    const granule = bytes.readBigUInt64LE(offset + 6);
    const segments = bytes.readUInt8(offset + 26);
    const table = bytes.subarray(offset + 27, offset + 27 + segments);
    const dataLen = table.reduce((n, seg) => n + seg, 0);
    const dataAt = offset + 27 + segments;
    if (firstPageData === null) {
      firstPageData = bytes.subarray(dataAt, dataAt + dataLen);
    }
    // A page with no audio yet (the headers) carries granule 0 or -1.
    if (granule !== 0xffffffffffffffffn) lastGranule = granule;
    offset = dataAt + dataLen;
  }
  if (firstPageData === null) throw new Error("no Ogg pages");
  if (firstPageData.toString("latin1", 0, 7) !== "\x01vorbis") {
    throw new Error("first packet is not a Vorbis identification header");
  }
  const channels = firstPageData.readUInt8(11);
  const sampleRate = firstPageData.readUInt32LE(12);
  return { channels, sampleRate, seconds: Number(lastGranule) / sampleRate };
}

// The delivery format the generator documents (tools/gen-radio-voices.mjs):
// mono, 16 kHz, Vorbis. Anything else means the render escaped the chain.
const CHANNELS = 1;
const SAMPLE_RATE = 16_000;
// The bank is brevity calls and one-breath ambient chatter. Below the floor
// is a render that failed or got truncated; above the ceiling is a line
// that would outlast RadioQueue's own duration estimate and jam the channel.
const MIN_SECONDS = 0.5;
const MAX_SECONDS = 5;
// Per-file floor catches a "successful" render of near-silence.
const MIN_BYTES = 4_000;
// Plan budget: the whole voice bundle stays around 1 MB so game load is
// unaffected.
const MAX_BUNDLE_BYTES = 1_024 * 1_024;

const assetDir = join(__dirname, "..", "assets", "radio");
const files = readdirSync(assetDir)
  .filter((f) => f.endsWith(".ogg"))
  .sort();

describe("radio voice bundle integrity", () => {
  it("is not empty (a wiped bundle must not pass silently)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s is a well-formed, audible line", (file) => {
    const bytes = readFileSync(join(assetDir, file));
    expect(bytes.length).toBeGreaterThanOrEqual(MIN_BYTES);
    const { channels, sampleRate, seconds } = probeOgg(bytes);
    expect(channels).toBe(CHANNELS);
    expect(sampleRate).toBe(SAMPLE_RATE);
    expect(seconds).toBeGreaterThanOrEqual(MIN_SECONDS);
    expect(seconds).toBeLessThanOrEqual(MAX_SECONDS);
  });

  it("fits the bundle size budget", () => {
    const total = files.reduce(
      (n, f) => n + readFileSync(join(assetDir, f)).length,
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
  });
});

// --- Loudness -----------------------------------------------------------------
// One line must not land audibly quieter than the next: the runtime plays
// every file at a fixed voice-bus gain, so any spread here is spread a
// player hears. This needs a Vorbis decoder, so unlike the checks above it
// runs only where ffmpeg does — the same machines that can regenerate the
// bank. It is what catches a chain that normalises inaccurately: the
// en_US-joe-medium bank held a 0.6 dB spread, and swapping in a more
// dynamic voice through a single-pass loudnorm opened that to 2.8 dB.

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Integrated loudness in LUFS, via ffmpeg's EBU R128 meter. */
async function integratedLufs(path: string): Promise<number> {
  const { stderr } = await promisify(execFile)("ffmpeg", [
    "-nostats",
    "-i",
    path,
    "-filter_complex",
    "ebur128",
    "-f",
    "null",
    "-",
  ]);
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const match = summary.match(/^ *I: *(-?[\d.]+) LUFS/m);
  if (!match?.[1]) throw new Error(`no loudness reading for ${path}`);
  return Number(match[1]);
}

// The generator's stated target (tools/gen-radio-voices.mjs: loudnorm I=-18).
const TARGET_LUFS = -18;
const TOLERANCE_DB = 1;
const MAX_SPREAD_DB = 1;

describe.skipIf(!hasFfmpeg)("radio voice bundle loudness", () => {
  it("every line sits at the chain's target, within a decibel of each other", async () => {
    const measured = await Promise.all(
      files.map(
        async (f) => [f, await integratedLufs(join(assetDir, f))] as const,
      ),
    );
    const tooFar = measured.filter(
      ([, lufs]) => Math.abs(lufs - TARGET_LUFS) > TOLERANCE_DB,
    );
    expect(tooFar).toEqual([]);
    const levels = measured.map(([, lufs]) => lufs);
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(
      MAX_SPREAD_DB,
    );
  }, 60_000);
});
