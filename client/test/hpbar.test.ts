// HP-bar seam: pure ownership + linger state. The bar belongs to the LOCAL
// player's damage only — main.ts records solely damage broadcasts where
// shooterId === selfId, so the tracker showing ONLY recorded targets is the
// ownership rule. Spec literals: 3 s linger (HPBAR_LINGER_MS), linear fade.

import { describe, expect, it } from "vitest";
import { HpBarTracker } from "../src/ui/hpbar";

describe("HpBarTracker", () => {
  it("shows the damaged target with a linear 3 s fade", () => {
    const tracker = new HpBarTracker();
    tracker.recordDamage("bandit-1", 65, 0);
    const shown = tracker.current(1000);
    expect(shown?.targetId).toBe("bandit-1");
    expect(shown?.hp).toBe(65);
    // 1 s into a 3 s linger: alpha 2/3 (linear).
    expect(shown?.alpha).toBeCloseTo(2 / 3, 5);
  });

  it("disappears once 3 s pass without further damage", () => {
    const tracker = new HpBarTracker();
    tracker.recordDamage("bandit-1", 65, 0);
    expect(tracker.current(2999)).not.toBeNull();
    expect(tracker.current(3001)).toBeNull();
  });

  it("shows nothing when no local damage was recorded (ownership)", () => {
    // Another player's hits never reach recordDamage — main.ts filters on
    // shooterId === selfId — so an empty tracker stays empty.
    const tracker = new HpBarTracker();
    expect(tracker.current(1000)).toBeNull();
  });

  it("tracks the most recently damaged target and refreshes the fade per hit", () => {
    const tracker = new HpBarTracker();
    tracker.recordDamage("bandit-1", 65, 0);
    tracker.recordDamage("bandit-2", 90, 500);
    const shown = tracker.current(600);
    expect(shown?.targetId).toBe("bandit-2");
    // Fade runs from the LAST hit (500), not the first: 100 ms in.
    expect(shown?.alpha).toBeCloseTo(1 - 100 / 3000, 5);
    // Re-hitting bandit-1 takes the bar back with fresh timing and hp.
    tracker.recordDamage("bandit-1", 58, 700);
    expect(tracker.current(800)?.targetId).toBe("bandit-1");
    expect(tracker.current(800)?.hp).toBe(58);
  });

  it("clears instantly when the target dies", () => {
    const tracker = new HpBarTracker();
    tracker.recordDamage("bandit-1", 12, 0);
    tracker.clear("bandit-1");
    expect(tracker.current(100)).toBeNull();
    // Clearing an unrelated id leaves the bar alone.
    tracker.recordDamage("bandit-2", 40, 200);
    tracker.clear("bandit-1");
    expect(tracker.current(300)?.targetId).toBe("bandit-2");
  });
});
