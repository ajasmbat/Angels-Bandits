// F9 on the classic stick (and touch's classic mode, the same seam): the
// novice pilot (client/test/novice-sim.ts) holds a rate stick toward the
// waypoint — full stick at 30° off the view — with the same delay and
// tremor. The default scheme's numbers are novice-pilot.test.ts's; here the
// assist (Normal's 0.85 stick authority included) must simply be no worse
// than main on either count.

import { describe, expect, it } from "vitest";
import { type Result, flyAll, perWaypoint, report } from "./novice-sim";

/** An arm flies 50 seeds × 30 s of the full client pipeline. */
const ARM_TIMEOUT_MS = 120_000;

describe("novice pilot, classic stick (F9)", () => {
  const results = new Map<string, Result>();

  for (const [name, arm] of [
    ["main classic", { scheme: "classic", assist: false, feel: "sharp" }],
    ["F9 classic", { scheme: "classic", assist: true, feel: "normal" }],
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

  it("no worse than main on either count", () => {
    const main = results.get("main classic") as Result;
    const f9 = results.get("F9 classic") as Result;
    expect(f9.crashes).toBeLessThanOrEqual(main.crashes);
    expect(perWaypoint(f9)).toBeLessThanOrEqual(perWaypoint(main));
  });
});
