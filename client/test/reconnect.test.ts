// W2 reconnect backoff: 0.5, 1, 2, 4, 8 s, then 8 s steps, until the resume
// window is spent.

import { RESUME_WINDOW_MS } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "../src/net/reconnect";

describe("reconnectDelayMs", () => {
  it("backs off 0.5, 1, 2, 4, 8 s and holds at 8 s", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((n) => reconnectDelayMs(n, 0));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("gives up once the next attempt would land past the resume window", () => {
    let elapsed = 0;
    let attempts = 0;
    for (;;) {
      const delay = reconnectDelayMs(attempts, elapsed);
      if (delay === null) break;
      elapsed += delay;
      attempts++;
    }
    expect(elapsed).toBeLessThan(RESUME_WINDOW_MS);
    expect(elapsed + 8000).toBeGreaterThanOrEqual(RESUME_WINDOW_MS);
    // 0.5+1+2+4 = 7.5 s, then 8 s steps: 6 more fit inside 60 s.
    expect(attempts).toBe(10);
  });

  it("respects a shorter window", () => {
    expect(reconnectDelayMs(0, 0, 1000)).toBe(500);
    expect(reconnectDelayMs(1, 500, 1000)).toBeNull();
  });
});
