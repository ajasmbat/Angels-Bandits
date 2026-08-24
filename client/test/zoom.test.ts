// Aim-zoom seam (ANGE-G9CPCV): the pure per-frame step and the curves a single
// eased scalar drives. Mirrors freelook.ts — renderer-free, immutable state,
// thin adapters in flight-input/camera/main. Expected values are hand-worked
// from the spec (FOV 70→28, chase 22 m/6 m → 6 m/2.2 m, steer 1→0.6), never
// recomputed the way the implementation does it.

import { describe, expect, it } from "vitest";
import {
  createZoom,
  stepZoom,
  zoomFov,
  zoomHeld,
  zoomLookAt,
  zoomOffset,
  zoomSteer,
} from "../src/game/zoom";

const DT = 1 / 60;

/** Advance `seconds` of right-button-held (or released) time at 60 fps. */
function advance(
  state: ReturnType<typeof createZoom>,
  held: boolean,
  seconds: number,
) {
  let s = state;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) s = stepZoom(s, held, DT);
  return s;
}

/** North: yaw 0 faces −Z, so a level plane's forward is (0, 0, −1). */
const FWD_NORTH = { x: 0, y: 0, z: -1 };
/** The un-zoomed chase offset for CHASE_DISTANCE 22 / CHASE_HEIGHT 6. */
const CHASE_OFFSET = { x: 0, y: 6, z: 22 };

describe("stepZoom easing", () => {
  it("starts fully out", () => {
    expect(createZoom()).toEqual({ held: false, z: 0 });
  });

  it("reaches at least 95% of full zoom within 0.17 s of holding", () => {
    expect(advance(createZoom(), true, 0.17).z).toBeGreaterThanOrEqual(0.95);
  });

  it("is still short of half zoom after a single 60 fps frame", () => {
    // A hair-trigger right-click must not snap the FOV.
    expect(advance(createZoom(), true, DT).z).toBeLessThan(0.5);
  });

  it("snaps to exactly 0 on release so the un-zoomed state is bit-exact", () => {
    const held = advance(createZoom(), true, 0.5);
    const out = advance(held, false, 0.5);
    expect(out.z).toBe(0);
    expect(out.held).toBe(false);
  });

  it("snaps to exactly 1 once the hold has settled", () => {
    expect(advance(createZoom(), true, 0.5).z).toBe(1);
  });

  it("never mutates the state it is given", () => {
    const s = createZoom();
    stepZoom(s, true, DT);
    expect(s).toEqual({ held: false, z: 0 });
  });
});

describe("zoomHeld — free-look wins", () => {
  it("zooms on the right button alone", () => {
    expect(zoomHeld(true, false)).toBe(true);
  });

  it("refuses to zoom while free-look is held", () => {
    expect(zoomHeld(true, true)).toBe(false);
  });

  it("does not zoom from free-look alone, or from nothing", () => {
    expect(zoomHeld(false, true)).toBe(false);
    expect(zoomHeld(false, false)).toBe(false);
  });
});

describe("zoom curves", () => {
  it("holds the shipped FOV endpoints exactly", () => {
    expect(zoomFov(0)).toBe(70);
    expect(zoomFov(1)).toBe(28);
  });

  it("puts half zoom at 49° — the midpoint of 70 and 28", () => {
    expect(zoomFov(0.5)).toBeCloseTo(49);
  });

  it("narrows monotonically", () => {
    const fovs = [0, 0.25, 0.5, 0.75, 1].map(zoomFov);
    for (let i = 1; i < fovs.length; i++) {
      expect(fovs[i]).toBeLessThan(fovs[i - 1] as number);
    }
  });

  it("leaves steering untouched at z=0 and costs 40% at full zoom", () => {
    expect(zoomSteer(0)).toBe(1);
    expect(zoomSteer(1)).toBeCloseTo(0.6);
  });

  it("bleeds steering authority monotonically", () => {
    const steer = [0, 0.25, 0.5, 0.75, 1].map(zoomSteer);
    for (let i = 1; i < steer.length; i++) {
      expect(steer[i]).toBeLessThan(steer[i - 1] as number);
    }
  });
});

describe("zoomOffset — the camera dolly", () => {
  it("returns the chase offset untouched at z=0", () => {
    expect(zoomOffset(CHASE_OFFSET, FWD_NORTH, 0)).toEqual(CHASE_OFFSET);
  });

  it("dollies to 6 m behind and 2.2 m above at full zoom", () => {
    // Facing −Z, "behind" is +Z: −fwd·6 = (0, 0, 6), plus 2.2 m of height.
    const o = zoomOffset(CHASE_OFFSET, FWD_NORTH, 1);
    expect(o.x).toBeCloseTo(0);
    expect(o.y).toBeCloseTo(2.2);
    expect(o.z).toBeCloseTo(6);
  });

  it("closes the eye-to-plane distance from 22.8 m to 6.4 m", () => {
    const far = zoomOffset(CHASE_OFFSET, FWD_NORTH, 0);
    const near = zoomOffset(CHASE_OFFSET, FWD_NORTH, 1);
    expect(Math.hypot(far.x, far.y, far.z)).toBeCloseTo(22.804, 2);
    expect(Math.hypot(near.x, near.y, near.z)).toBeCloseTo(6.391, 2);
  });

  it("dollies along the nose when the plane is climbing", () => {
    // 45° climb: forward is (0, √½, −√½), so the eye sits below and behind.
    const s = Math.SQRT1_2;
    const o = zoomOffset(CHASE_OFFSET, { x: 0, y: s, z: -s }, 1);
    expect(o.y).toBeCloseTo(2.2 - 6 * s, 3);
    expect(o.z).toBeCloseTo(6 * s, 3);
  });
});

describe("zoomLookAt — the view axis becomes the gun line", () => {
  const aim = { x: 1000, y: 300, z: 1000 };

  it("keeps today's plane+2y target at z=0", () => {
    expect(zoomLookAt(aim, FWD_NORTH, 0)).toEqual({
      x: 1000,
      y: 302,
      z: 1000,
    });
  });

  it("looks 350 m down the nose at full zoom", () => {
    const p = zoomLookAt(aim, FWD_NORTH, 1);
    expect(p.x).toBeCloseTo(1000);
    expect(p.y).toBeCloseTo(300);
    expect(p.z).toBeCloseTo(650);
  });
});
