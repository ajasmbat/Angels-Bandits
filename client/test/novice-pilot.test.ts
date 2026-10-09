// F9 effortless controls, measured rather than guessed: the novice pilot
// (client/test/novice-sim.ts) on the DEFAULT scheme — the mouse instructor
// — on main's tuning (assist off, the Sharp loop: today exactly) and on the
// default (assist on, Normal), same seeds, same routes, same hand. The
// numbers are logged; the PR records them.

import { describe, expect, it } from "vitest";
import {
  type Result,
  SEEDS,
  flyAll,
  perWaypoint,
  report,
  routes,
} from "./novice-sim";

/** An arm flies 50 seeds × 30 s of the full client pipeline. */
const ARM_TIMEOUT_MS = 120_000;

describe("novice pilot, default scheme (F9)", () => {
  const results = new Map<string, Result>();

  it("routes are real: long, low, and some thread a hole", () => {
    let holes = 0;
    for (const r of routes) {
      expect(r.points.length).toBeGreaterThan(8);
      holes += r.holes;
    }
    expect(holes).toBeGreaterThan(SEEDS.length);
  });

  for (const [name, arm] of [
    ["main", { scheme: "instructor", assist: false, feel: "sharp" }],
    ["F9", { scheme: "instructor", assist: true, feel: "normal" }],
  ] as const) {
    it(
      `flies the ${name} arm`,
      () => {
        const r = flyAll(arm);
        results.set(name, r);
        console.log(`novice ${report(name, r)}`);
      },
      ARM_TIMEOUT_MS,
    );
  }

  it("≥ 40% fewer crashes and ≥ 20% less time per waypoint than main", () => {
    const main = results.get("main") as Result;
    const f9 = results.get("F9") as Result;
    // The novice really does struggle on main's tuning.
    expect(main.crashes).toBeGreaterThan(20);
    expect(f9.crashes).toBeLessThanOrEqual(main.crashes * 0.6);
    expect(perWaypoint(f9)).toBeLessThanOrEqual(perWaypoint(main) * 0.8);
  });
});
