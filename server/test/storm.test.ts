// Death-ceiling seam: StormCeiling is pure per-plane timing bookkeeping —
// CONTINUOUS time above STORM_KILL_ALT (600 m), STORM_GRACE_MS (3000 ms) of
// grace, reset the instant the plane dips back below. Expected values are the
// ticket's spec literals, not recomputed from the implementation.

import { describe, expect, it } from "vitest";
import { StormCeiling } from "../src/storm";

const KILL_ALT = 600; // spec: hidden ceiling arms strictly above 600 m
const HIGH = 700;
const LOW = 400;

describe("StormCeiling grace timer", () => {
  it("does not kill a plane 2.9 s above the kill altitude", () => {
    const storm = new StormCeiling();
    expect(storm.observe("p", HIGH, 0)).toBeNull();
    expect(storm.observe("p", HIGH, 1500)).toBeNull();
    expect(storm.observe("p", HIGH, 2900)).toBeNull();
  });

  it("kills a plane 3.1 s continuously above the kill altitude", () => {
    const storm = new StormCeiling();
    storm.observe("p", HIGH, 0);
    expect(storm.observe("p", HIGH, 2900)).toBeNull();
    expect(storm.observe("p", HIGH, 3100)).toBe("kill");
  });

  it("resets on dipping below: 2 s up + dip + 2 s up stays alive", () => {
    const storm = new StormCeiling();
    expect(storm.observe("p", HIGH, 0)).toBeNull();
    expect(storm.observe("p", HIGH, 2000)).toBeNull();
    expect(storm.observe("p", LOW, 2100)).toBeNull(); // dip — timer resets
    expect(storm.observe("p", HIGH, 2200)).toBeNull(); // grace re-arms here
    expect(storm.observe("p", HIGH, 4200)).toBeNull(); // only 2 s continuous
    expect(storm.observe("p", HIGH, 5300)).toBe("kill"); // 3.1 s after 2200
  });

  it("treats exactly the kill altitude as safe (the rule is strictly above)", () => {
    const storm = new StormCeiling();
    storm.observe("p", HIGH, 0);
    expect(storm.observe("p", KILL_ALT, 2900)).toBeNull(); // resets the timer
    expect(storm.observe("p", HIGH, 3000)).toBeNull();
    expect(storm.observe("p", HIGH, 5900)).toBeNull(); // 2.9 s since re-arm
    expect(storm.observe("p", HIGH, 6100)).toBe("kill");
  });

  it("tracks planes independently", () => {
    const storm = new StormCeiling();
    storm.observe("a", HIGH, 0);
    expect(storm.observe("b", HIGH, 2000)).toBeNull();
    expect(storm.observe("a", HIGH, 3100)).toBe("kill");
    expect(storm.observe("b", HIGH, 4900)).toBeNull(); // b armed at 2000
    expect(storm.observe("b", HIGH, 5100)).toBe("kill");
  });

  it("is single-shot: a kill re-arms the grace instead of repeating", () => {
    const storm = new StormCeiling();
    storm.observe("p", HIGH, 0);
    expect(storm.observe("p", HIGH, 3100)).toBe("kill"); // re-arms at 3100
    expect(storm.observe("p", HIGH, 3200)).toBeNull(); // fresh grace
    expect(storm.observe("p", HIGH, 6000)).toBeNull(); // 2.9 s since re-arm
    expect(storm.observe("p", HIGH, 6200)).toBe("kill"); // 3.1 s since re-arm
  });

  it("forget() drops a plane's timer (leave/despawn cleanup)", () => {
    const storm = new StormCeiling();
    storm.observe("p", HIGH, 0);
    storm.forget("p");
    expect(storm.observe("p", HIGH, 3100)).toBeNull(); // re-armed at 3100
    expect(storm.observe("p", HIGH, 6200)).toBe("kill");
  });
});
