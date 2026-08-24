// The render pipeline's pure seam (tools/radio-bank.mjs): which Piper voice
// the bundle claims, and the exact [assetText, spokenText] list the phrase
// bank expands into. tools/gen-radio-voices.mjs consumes both — everything
// downstream of here is Piper and ffmpeg, which this test deliberately does
// not reach. Two failure modes a model swap actually has are covered:
// a line list that drifts from the bank, and a model name that drifts
// between the module, the shell wrapper, and the CREDITS.md licence record.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — build tooling: plain ESM, no .d.ts (client/tsconfig
// only typechecks src, so this import is vitest-only).
import {
  VOICE_MODEL,
  VOICE_SPEAKER,
  voiceLines,
} from "../../tools/radio-bank.mjs";
import { voiceSlug } from "../src/audio/radio";
import { AMBIENT_PHRASES, PHRASE } from "../src/game/phrases";

const repoRoot = join(__dirname, "..", "..");
const lines: [string, string][] = voiceLines(PHRASE, AMBIENT_PHRASES);

describe("voiceLines: the bank expanded into renderable lines", () => {
  it("voices every fixed PHRASE except the two callsign fragments", () => {
    const assetTexts = new Set(lines.map(([asset]) => asset));
    // "checking in." / "off station." are never spoken alone — they only
    // ever appear inside a BANDIT-<n> shape (callouts.ts builds them).
    expect(assetTexts.has(PHRASE.checkIn)).toBe(false);
    expect(assetTexts.has(PHRASE.offStation)).toBe(false);
    for (const text of Object.values(PHRASE)) {
      if (text === PHRASE.checkIn || text === PHRASE.offStation) continue;
      expect(assetTexts.has(text)).toBe(true);
    }
  });

  it("voices every ambient line", () => {
    const assetTexts = new Set(lines.map(([asset]) => asset));
    for (const text of AMBIENT_PHRASES) expect(assetTexts.has(text)).toBe(true);
  });

  it("expands BANDIT-1..12 into wire-cased assets read as number words", () => {
    // Known-good literals, not a recomputation: the asset text carries the
    // WIRE callsign (what callouts.ts emits and voiceSlug hashes), while the
    // spoken text spells the number out so Piper reads "Seven", not "seven".
    const byAsset = new Map(lines);
    expect(byAsset.get("BANDIT-7, checking in.")).toBe(
      "Bandit Seven, checking in.",
    );
    expect(byAsset.get("BANDIT-12 off station.")).toBe(
      "Bandit Twelve off station.",
    );
    expect(byAsset.get("BANDIT-1, checking in.")).toBe(
      "Bandit One, checking in.",
    );
    // …and exactly twelve of each shape, no BANDIT-0 or BANDIT-13.
    const assets = lines.map(([a]) => a);
    expect(
      assets.filter((a) => /^BANDIT-\d+, checking in\.$/.test(a)).length,
    ).toBe(12);
    expect(
      assets.filter((a) => /^BANDIT-\d+ off station\.$/.test(a)).length,
    ).toBe(12);
    expect(assets.some((a) => a.startsWith("BANDIT-0"))).toBe(false);
    expect(assets.some((a) => a.startsWith("BANDIT-13"))).toBe(false);
  });

  it("emits no duplicate asset slugs (two lines would fight over one file)", () => {
    const slugs = lines.map(([asset]) => voiceSlug(asset));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("renders exactly the committed bundle — no line without a file, no file without a line", () => {
    const bundled = new Set(
      readdirSync(join(__dirname, "..", "assets", "radio"))
        .filter((f) => f.endsWith(".ogg"))
        .map((f) => f.replace(/\.ogg$/, "")),
    );
    const rendered = new Set(lines.map(([asset]) => voiceSlug(asset)));
    expect([...rendered].filter((s) => !bundled.has(s))).toEqual([]);
    expect([...bundled].filter((s) => !rendered.has(s))).toEqual([]);
  });
});

describe("VOICE_MODEL: one model name, three places, no drift", () => {
  it("is the model the one-shot script downloads", () => {
    const sh = readFileSync(
      join(repoRoot, "tools/gen-radio-voices.sh"),
      "utf8",
    );
    expect(sh).toMatch(new RegExp(`^MODEL=${VOICE_MODEL}$`, "m"));
  });

  it("is the model the shipped licence record documents", () => {
    // CREDITS.md is the human-maintained licence record — an independent
    // source of truth, not a recomputation of the constant. Swapping the
    // voice without re-recording its licence fails here.
    const credits = readFileSync(
      join(__dirname, "..", "assets", "radio", "CREDITS.md"),
      "utf8",
    );
    expect(credits).toContain(VOICE_MODEL);
  });

  it("names a speaker only for a multi-speaker model", () => {
    // Single-speaker voices must not pass -s (piper errors); multi-speaker
    // voices must, or every line silently renders as speaker 0.
    if (VOICE_SPEAKER === null) return;
    expect(Number.isInteger(VOICE_SPEAKER)).toBe(true);
    expect(VOICE_SPEAKER).toBeGreaterThanOrEqual(0);
    const credits = readFileSync(
      join(__dirname, "..", "assets", "radio", "CREDITS.md"),
      "utf8",
    );
    expect(credits).toContain(`speaker ${VOICE_SPEAKER}`);
  });
});
