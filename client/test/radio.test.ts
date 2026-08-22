// RadioQueue seam: one-line-at-a-time priority scheduler with an injected
// clock. Contract under test (plan): threat > own > kill > ambient; per-key
// cooldowns apply at PLAY time (a queued second kill waits out the 6 s
// cooldown, it isn't silently dropped); enqueueing a threat drops queued
// ambient; ambient is fully suppressed during the 8 s combat window; queued
// lines past their expiry never play. Times are plain ms numbers.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMBAT_WINDOW_MS,
  RadioQueue,
  pilotRate,
  resolveVoiceAsset,
  voiceSlug,
} from "../src/audio/radio";
import type { Callout, RadioKind } from "../src/game/callouts";
import { AMBIENT_PHRASES, PHRASE } from "../src/game/phrases";

/** Minimal test line; cooldown/expiry defaults sized to stay out of the way. */
function line(
  kind: RadioKind,
  key: string,
  over: Partial<Callout> = {},
): Callout {
  return {
    kind,
    key,
    cooldownMs: 0,
    expiresMs: 60_000,
    voice: `${key} voice`,
    ticker: `${key} ticker`,
    speaker: "TEST",
    ...over,
  };
}

describe("RadioQueue", () => {
  it("plays one line at a time until released", () => {
    const q = new RadioQueue();
    q.enqueue(line("own", "a"), 0);
    q.enqueue(line("own", "b"), 0);
    expect(q.poll(0)?.key).toBe("a");
    expect(q.poll(1)).toBeNull(); // channel busy
    q.release(2);
    expect(q.poll(3)?.key).toBe("b");
  });

  it("plays by priority: threat > own > kill > ambient", () => {
    const q = new RadioQueue();
    q.enqueue(line("kill", "kill"), 0);
    q.enqueue(line("own", "own"), 0);
    q.enqueue(line("threat", "threat"), 0);
    expect(q.poll(0)?.kind).toBe("threat");
    q.release(1);
    expect(q.poll(2)?.kind).toBe("own");
    q.release(3);
    expect(q.poll(4)?.kind).toBe("kill");
  });

  it("a threat preempts queued ambient (drops it)", () => {
    const q = new RadioQueue();
    q.enqueue(line("ambient", "ambient"), 0);
    q.enqueue(line("threat", "threat"), 0);
    expect(q.poll(0)?.kind).toBe("threat");
    q.release(1);
    expect(q.poll(2)).toBeNull(); // the ambient line is gone, not queued
  });

  it("two simultaneous kills: one plays, one queues and waits out the 6 s cooldown", () => {
    const q = new RadioQueue();
    const kill = () =>
      line("kill", "kill", { cooldownMs: 6_000, expiresMs: 15_000 });
    expect(q.enqueue(kill(), 0)).toBe(true);
    expect(q.enqueue(kill(), 0)).toBe(true); // queues behind the first
    expect(q.poll(0)?.kind).toBe("kill");
    q.release(1_500);
    expect(q.poll(2_000)).toBeNull(); // cooldown holds it back
    expect(q.poll(6_000)?.kind).toBe("kill"); // exactly one cooldown later
  });

  it("dedupes: a third same-key line is rejected while one is queued", () => {
    const q = new RadioQueue();
    expect(q.enqueue(line("kill", "kill"), 0)).toBe(true);
    expect(q.enqueue(line("kill", "kill"), 0)).toBe(true);
    expect(q.enqueue(line("kill", "kill"), 0)).toBe(false);
  });

  it("suppresses ambient during the combat window, allows it after", () => {
    const q = new RadioQueue();
    q.noteCombat(1_000);
    expect(q.inCombat(1_000)).toBe(true);
    expect(q.enqueue(line("ambient", "ambient"), 2_000)).toBe(false);
    // Window is 8 s from the last combat event.
    expect(q.inCombat(1_000 + COMBAT_WINDOW_MS)).toBe(false);
    expect(
      q.enqueue(line("ambient", "ambient"), 1_000 + COMBAT_WINDOW_MS),
    ).toBe(true);
  });

  it("drops already-queued ambient when combat starts", () => {
    const q = new RadioQueue();
    q.enqueue(line("ambient", "ambient"), 0);
    q.noteCombat(100);
    expect(q.poll(200)).toBeNull();
  });

  it("never plays a stale line past its expiry", () => {
    const q = new RadioQueue();
    q.enqueue(line("own", "old", { expiresMs: 4_000 }), 0);
    expect(q.poll(5_000)).toBeNull();
  });

  it("voiceSlug: a voiced line maps to its bundled asset id (known literals)", () => {
    // Independent source of truth: the filenames the generation script emits.
    expect(voiceSlug("Bandit on your six, break!")).toBe(
      "bandit-on-your-six-break",
    );
    expect(voiceSlug("BANDIT-7, checking in.")).toBe("bandit-7-checking-in");
    expect(voiceSlug("Splash one.")).toBe("splash-one");
    expect(voiceSlug("I'm hit, I'm hit.")).toBe("i-m-hit-i-m-hit");
  });

  it("resolveVoiceAsset: exact bank lines hit their own file", () => {
    const has = (id: string) => id === "splash-one";
    expect(resolveVoiceAsset("Splash one.", has)).toBe("splash-one");
    expect(resolveVoiceAsset("Never rendered line.", has)).toBeNull();
  });

  it("resolveVoiceAsset: an unrendered BANDIT-<n> falls back to the anonymous line", () => {
    // Only BANDIT-1..12 are pre-rendered; the server can mint higher numbers
    // over a long-lived room, so those degrade to the anon variants.
    const rendered = new Set([
      "bandit-7-checking-in",
      "new-contact-checking-in",
      "contact-off-station",
    ]);
    const has = (id: string) => rendered.has(id);
    expect(resolveVoiceAsset("BANDIT-7, checking in.", has)).toBe(
      "bandit-7-checking-in",
    );
    expect(resolveVoiceAsset("BANDIT-31, checking in.", has)).toBe(
      "new-contact-checking-in",
    );
    expect(resolveVoiceAsset("BANDIT-31 off station.", has)).toBe(
      "contact-off-station",
    );
  });

  it("pilotRate: deterministic per-callsign identity within ±6%", () => {
    const rates = new Map<string, number>();
    for (let n = 1; n <= 12; n++) {
      const rate = pilotRate(`BANDIT-${n}`);
      expect(rate).toBe(pilotRate(`BANDIT-${n}`)); // same callsign → same rate
      expect(rate).toBeGreaterThanOrEqual(0.94);
      expect(rate).toBeLessThanOrEqual(1.06);
      rates.set(`BANDIT-${n}`, rate);
    }
    // Different callsigns read as different pilots.
    expect(new Set(rates.values()).size).toBe(12);
    // Humans and the GUARD net stay at the neutral rate.
    expect(pilotRate("SomePlayer")).toBe(1);
    expect(pilotRate("GUARD")).toBe(1);
  });

  it("cooldown arithmetic runs from the last PLAY of the key", () => {
    const q = new RadioQueue();
    const threat = () =>
      line("threat", "threat", { cooldownMs: 12_000, expiresMs: 60_000 });
    q.enqueue(threat(), 0);
    expect(q.poll(0)?.kind).toBe("threat");
    q.release(2_000);
    q.enqueue(threat(), 3_000);
    expect(q.poll(4_000)).toBeNull(); // 12 s from play at t=0, not from release
    expect(q.poll(11_999)).toBeNull();
    expect(q.poll(12_000)?.kind).toBe("threat");
  });
});

// Bank ↔ bundle tripwire: every voice string the game can ever emit (the
// callout builders only produce these shapes — fixed PHRASE lines, ambient
// bank lines, and BANDIT-1..12 check-in/off-station variants) must resolve
// to a committed OGG in client/assets/radio/. A bank edit without rerunning
// tools/gen-radio-voices.sh fails here instead of failing silently in-game.
describe("voice bundle covers the whole phrase bank", () => {
  const assetDir = join(__dirname, "..", "assets", "radio");
  const ids = new Set(
    readdirSync(assetDir)
      .filter((f) => f.endsWith(".ogg"))
      .map((f) => f.replace(/\.ogg$/, "")),
  );
  const has = (id: string) => ids.has(id);

  const everyVoiceLine: string[] = [
    ...Object.values(PHRASE).filter(
      (p) => p !== PHRASE.checkIn && p !== PHRASE.offStation, // fragments — only voiced inside the shapes below
    ),
    ...AMBIENT_PHRASES,
  ];
  for (let n = 1; n <= 12; n++) {
    everyVoiceLine.push(`BANDIT-${n}, ${PHRASE.checkIn}`);
    everyVoiceLine.push(`BANDIT-${n} ${PHRASE.offStation}`);
  }

  it.each(everyVoiceLine)("%s → a bundled asset", (text) => {
    expect(resolveVoiceAsset(text, has)).not.toBeNull();
  });
});
