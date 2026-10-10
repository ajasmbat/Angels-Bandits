// A2: a throw in the scheduled tick costs that tick, not the process — and a
// fault that throws every tick cannot flood the log.

import { describe, expect, it } from "vitest";
import { createGuard } from "../src/tick-guard";

describe("createGuard (A2)", () => {
  it("contains a throw, logs it once per window, and the next step still runs", () => {
    const lines: string[] = [];
    const guard = createGuard("tick", (line) => lines.push(line), 10000);
    const boom = () => {
      throw new Error("boom");
    };
    expect(guard(boom, 0)).toBe(false);
    expect(lines).toEqual(["tick failed:"]);
    // Twenty a second for a few seconds: folded, not logged.
    for (let t = 50; t < 5000; t += 50) expect(guard(boom, t)).toBe(false);
    expect(lines).toHaveLength(1);
    let ran = false;
    expect(
      guard(() => {
        ran = true;
      }, 5000),
    ).toBe(true);
    expect(ran).toBe(true);
    expect(guard(boom, 10000)).toBe(false);
    expect(lines).toEqual([
      "tick failed:",
      "tick failed (+99 since the last report):",
    ]);
  });
});
