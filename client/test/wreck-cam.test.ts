// D4 kill-cam: for the whole KILL_CAM_MS beat the camera follows your own
// falling wreck — looking at exactly where the shared path puts it, from a
// fixed distance behind — and holds on the impact once it has landed.

import { KILL_CAM_MS } from "@angels-bandits/common/constants";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import { type WreckPath, wreckPosAt } from "@angels-bandits/common/wreck";
import { describe, expect, it } from "vitest";
import {
  WRECK_CAM_BACK,
  WRECK_CAM_UP,
  wreckCamView,
} from "../src/game/wreck-cam";

const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const arm = Math.hypot(WRECK_CAM_BACK, WRECK_CAM_UP);

/** Shot down over the seam, still flying fast. */
const wreck: WreckPath = {
  p: { x: 1995, y: 260, z: 4 },
  v: { x: 70, y: -5, z: 30 },
  t: 500_000,
  spin: 1,
  end: 4200,
};

describe("wreck kill-cam", () => {
  it("follows the wreck through the whole KILL_CAM_MS beat", () => {
    const eye = v3();
    const at = v3();
    let prevAt: Vec3 | null = null;
    let moved = 0;
    for (let ms = wreck.t; ms <= wreck.t + KILL_CAM_MS; ms += 50) {
      wreckCamView(wreck, ms, eye, at);
      expect(at).toEqual(wreckPosAt(wreck, ms, v3()));
      expect(wrapDistance(eye, at)).toBeCloseTo(arm, 6);
      expect(eye.y).toBeCloseTo(at.y + WRECK_CAM_UP, 9);
      if (prevAt) moved += wrapDistance(prevAt, at);
      prevAt = { ...at };
    }
    // It really rode the fall, not a fixed point.
    expect(moved).toBeGreaterThan(100);
  });

  it("trails along the death heading, so the corkscrew never swings it", () => {
    const eye = v3();
    const at = v3();
    const h = Math.hypot(wreck.v.x, wreck.v.z);
    for (let ms = wreck.t; ms <= wreck.t + KILL_CAM_MS; ms += 250) {
      wreckCamView(wreck, ms, eye, at);
      const dx = ((at.x - eye.x + 3000) % 2000) - 1000;
      const dz = ((at.z - eye.z + 3000) % 2000) - 1000;
      expect(dx / WRECK_CAM_BACK).toBeCloseTo(wreck.v.x / h, 6);
      expect(dz / WRECK_CAM_BACK).toBeCloseTo(wreck.v.z / h, 6);
    }
  });

  it("holds on the impact point once the wreck has landed", () => {
    const eye = v3();
    const at = v3();
    const impact = wreckPosAt(wreck, wreck.t + wreck.end, v3());
    wreckCamView({ ...wreck, end: 1200 }, wreck.t + KILL_CAM_MS, eye, at);
    expect(at).toEqual(
      wreckPosAt({ ...wreck, end: 1200 }, wreck.t + 1200, v3()),
    );
    wreckCamView(wreck, wreck.t + wreck.end + 900, eye, at);
    expect(at).toEqual(impact);
  });

  it("holds at the death point while the render clock still lags the death", () => {
    const eye = v3();
    const at = v3();
    wreckCamView(wreck, wreck.t - 120, eye, at);
    expect(wrapDistance(at, wreck.p)).toBeLessThan(1e-9);
  });
});
