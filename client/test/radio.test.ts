// RadioQueue seam: one-line-at-a-time priority scheduler with an injected
// clock. Contract under test (plan): threat > own > kill > ambient; per-key
// cooldowns apply at PLAY time (a queued second kill waits out the 6 s
// cooldown, it isn't silently dropped); enqueueing a threat drops queued
// ambient; ambient is fully suppressed during the 8 s combat window; queued
// lines past their expiry never play. Times are plain ms numbers.

import { describe, expect, it } from "vitest";
import { COMBAT_WINDOW_MS, RadioQueue } from "../src/audio/radio";
import type { Callout, RadioKind } from "../src/game/callouts";

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
