// Smoke seam: wounded-plane threshold from snapshot HP, and the trail-point
// model that stores puffs as offsets from the newest anchor, re-based through
// wrapDelta — the rule that keeps a seam-crossing plane from smearing a 2 km
// smoke streak. Thresholds use the spec literals: MAX_HP = 100,
// SMOKE_HP_FRAC = 0.3 → smoke strictly below 30 HP.

import { describe, expect, it } from "vitest";
import { SMOKE_EMIT_MS, SmokeTrail, smokeActive } from "../src/render/smoke";

describe("smokeActive", () => {
  it("starts strictly below 30% HP and stops when regen crosses back", () => {
    expect(smokeActive(29)).toBe(true);
    expect(smokeActive(30)).toBe(false); // at the threshold — no smoke
    expect(smokeActive(31)).toBe(false); // regen carried it back over
    expect(smokeActive(100)).toBe(false);
  });

  it("never smokes a dead plane (hp 0 and below)", () => {
    expect(smokeActive(0)).toBe(false);
    expect(smokeActive(-5)).toBe(false);
  });
});

describe("SmokeTrail", () => {
  it("emits at the cadence cap, not per call", () => {
    const trail = new SmokeTrail();
    const anchor = { x: 1000, y: 300, z: 1000 };
    trail.update(anchor, 0, true);
    trail.update(anchor, SMOKE_EMIT_MS / 2, true); // too soon — no new puff
    expect(trail.puffs(SMOKE_EMIT_MS / 2)).toHaveLength(1);
    trail.update(anchor, SMOKE_EMIT_MS, true);
    expect(trail.puffs(SMOKE_EMIT_MS)).toHaveLength(2);
  });

  it("re-bases offsets across the torus seam — no 2 km streak", () => {
    const trail = new SmokeTrail();
    // Plane flying +X crosses the seam: 1995 → 5 is 10 m of true travel.
    trail.update({ x: 1995, y: 300, z: 100 }, 0, true);
    trail.update({ x: 5, y: 300, z: 100 }, 100, true);
    const puffs = trail.puffs(100);
    expect(puffs).toHaveLength(2);
    // The older puff sits ~10 m BEHIND the new anchor (−X), never 1990 ahead.
    const old = puffs[0]?.offset;
    expect(old?.x).toBeCloseTo(-10, 5);
    for (const p of puffs) {
      expect(Math.hypot(p.offset.x, p.offset.y, p.offset.z)).toBeLessThan(50);
    }
  });

  it("ages puffs out and keeps emitting=false frames from adding any", () => {
    const trail = new SmokeTrail();
    trail.update({ x: 1000, y: 300, z: 1000 }, 0, true);
    trail.update({ x: 1010, y: 300, z: 1000 }, 200, false);
    expect(trail.puffs(200)).toHaveLength(1);
    // Well past SMOKE_LIFE_MS (1500) the trail is empty.
    expect(trail.puffs(5000)).toHaveLength(0);
  });
});
