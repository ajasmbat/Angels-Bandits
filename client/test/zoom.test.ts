// Aim-zoom seam (ANGE-G9CPCV, FC1's gun-sight): the pure per-frame step and
// the curves a single eased scalar drives. Mirrors freelook.ts — renderer-
// free, immutable state, thin adapters in flight-input/camera/main. Expected
// values are hand-worked from the spec (FOV 70→30 in ~0.15 s, the wheel's
// sights 30/22/15, the own plane gone by z 0.55, the eye 2.5 m behind and
// 1.4 m over the gun line; the pre-FC1 6 m / 2.6 m dolly with zoomFade off;
// steer 1 for the mouse-aim and FOV/70 for a stick), never recomputed the way
// the implementation does it.

import { afterEach, describe, expect, it } from "vitest";
import { resetTuning, tuning } from "../src/game/tuning";
import {
  createZoom,
  stepFov,
  stepZoom,
  zoomFov,
  zoomHeld,
  zoomLookAt,
  zoomMagnet,
  zoomOffset,
  zoomPlaneFade,
  zoomSteady,
  zoomSteer,
  zoomWheel,
} from "../src/game/zoom";

const DT = 1 / 60;

afterEach(() => resetTuning());

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
  it("starts fully out, on the first sight", () => {
    expect(createZoom()).toEqual({ held: false, z: 0, step: 0, fov: 30 });
  });

  it("reaches at least 95% of full zoom within 0.15 s of holding", () => {
    expect(advance(createZoom(), true, 0.15).z).toBeGreaterThanOrEqual(0.95);
  });

  it("is out again (≤ 5%) within 0.15 s of letting go", () => {
    const held = advance(createZoom(), true, 0.5);
    expect(advance(held, false, 0.15).z).toBeLessThanOrEqual(0.05 + 1e-9);
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

  it("follows the tuning's zoom time", () => {
    tuning.zoomTime = 0.3;
    expect(advance(createZoom(), true, 0.15).z).toBeLessThan(0.9);
    expect(advance(createZoom(), true, 0.3).z).toBeGreaterThanOrEqual(0.95);
  });

  it("never mutates the state it is given", () => {
    const s = createZoom();
    stepZoom(s, true, DT);
    expect(s).toEqual({ held: false, z: 0, step: 0, fov: 30 });
  });
});

describe("the wheel's sights", () => {
  it("steps in 30 → 22 → 15 while held, and no further", () => {
    let s = advance(createZoom(), true, 0.5);
    expect(stepFov(s.step)).toBe(30);
    s = zoomWheel(s, -1); // a notch away from the user: closer
    expect(s.step).toBe(1);
    s = zoomWheel(s, -1);
    expect(s.step).toBe(2);
    s = zoomWheel(s, -3);
    expect(s.step).toBe(2);
    s = zoomWheel(s, 1); // toward the user: wider
    expect(s.step).toBe(1);
    s = zoomWheel(zoomWheel(s, 1), 1);
    expect(s.step).toBe(0);
  });

  it("eases the FOV onto a new sight instead of snapping", () => {
    let s = zoomWheel(advance(createZoom(), true, 0.5), -1);
    s = stepZoom(s, true, DT);
    expect(s.fov).toBeLessThan(30);
    expect(s.fov).toBeGreaterThan(22);
    s = advance(s, true, 0.5);
    expect(s.fov).toBe(22);
    expect(zoomFov(s.z, s.fov)).toBe(22);
  });

  it("does nothing out of the zoom (the wheel is the throttle there)", () => {
    const s = createZoom();
    expect(zoomWheel(s, -1)).toBe(s);
  });

  it("keeps the sight while easing out, then starts the next zoom on the first", () => {
    let s = zoomWheel(advance(createZoom(), true, 0.5), -2);
    s = advance(s, true, 0.5);
    const easing = stepZoom(s, false, DT);
    expect(easing.step).toBe(1);
    const out = advance(easing, false, 0.5);
    expect(out.step).toBe(0);
    expect(out.fov).toBe(30);
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
    expect(zoomFov(1)).toBe(30);
  });

  it("puts half zoom at 50° — the midpoint of 70 and 30", () => {
    expect(zoomFov(0.5)).toBeCloseTo(50);
  });

  it("narrows monotonically", () => {
    const fovs = [0, 0.25, 0.5, 0.75, 1].map((z) => zoomFov(z));
    for (let i = 1; i < fovs.length; i++) {
      expect(fovs[i]).toBeLessThan(fovs[i - 1] as number);
    }
  });

  it("gives the mouse-aim its full authority at every zoom", () => {
    for (const z of [0, 0.5, 1]) expect(zoomSteer(z, "instructor")).toBe(1);
  });

  it("scales a stick with the FOV: 30/70 at full zoom, 1 out of it", () => {
    expect(zoomSteer(0)).toBe(1);
    expect(zoomSteer(1)).toBeCloseTo(30 / 70, 6);
    expect(zoomSteer(1, "stick", 22)).toBeCloseTo(22 / 70, 6);
    // …never under 0.3, however tight the sight.
    expect(zoomSteer(1, "stick", 15)).toBeCloseTo(0.3, 6);
  });

  it("bleeds a stick's authority monotonically", () => {
    const steer = [0, 0.25, 0.5, 0.75, 1].map((z) => zoomSteer(z));
    for (let i = 1; i < steer.length; i++) {
      expect(steer[i]).toBeLessThan(steer[i - 1] as number);
    }
  });
});

describe("own-plane fade, steadying and magnetism", () => {
  it("leaves the plane drawn early in the zoom and gone by 0.55", () => {
    expect(zoomPlaneFade(0)).toBe(0);
    expect(zoomPlaneFade(0.1)).toBe(0);
    expect(zoomPlaneFade(0.55)).toBe(1);
    expect(zoomPlaneFade(1)).toBe(1);
    const mid = zoomPlaneFade(0.335);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });

  it("fades monotonically", () => {
    let prev = 0;
    for (let z = 0; z <= 1; z += 0.05) {
      const f = zoomPlaneFade(z);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it("never fades with zoomFade off (the pre-FC1 look)", () => {
    tuning.zoomFade = 0;
    expect(zoomPlaneFade(1)).toBe(0);
  });

  it("takes 70% of the shake and roll wobble out at full zoom", () => {
    expect(zoomSteady(0)).toBe(1);
    expect(zoomSteady(1)).toBeCloseTo(0.3, 6);
  });

  it("bends rounds 1.25× harder at full zoom, exactly 1× out of it", () => {
    expect(zoomMagnet(0)).toBe(1);
    expect(zoomMagnet(1)).toBeCloseTo(1.25, 6);
  });
});

describe("zoomOffset — the camera dolly", () => {
  it("returns the chase offset untouched at z=0", () => {
    expect(zoomOffset(CHASE_OFFSET, FWD_NORTH, 0)).toEqual(CHASE_OFFSET);
  });

  it("puts the eye 2.5 m behind and 1.4 m over the gun line at full zoom", () => {
    // Facing −Z, "behind" is +Z: −fwd·2.5 = (0, 0, 2.5), plus 1.4 m of height.
    const o = zoomOffset(CHASE_OFFSET, FWD_NORTH, 1);
    expect(o.x).toBeCloseTo(0);
    expect(o.y).toBeCloseTo(1.4);
    expect(o.z).toBeCloseTo(2.5);
  });

  it("keeps the pre-FC1 6 m / 2.6 m dolly with zoomFade off", () => {
    tuning.zoomFade = 0;
    const o = zoomOffset(CHASE_OFFSET, FWD_NORTH, 1);
    expect(o.y).toBeCloseTo(2.6);
    expect(o.z).toBeCloseTo(6);
  });

  it("closes the eye-to-plane distance from 22.8 m to 2.9 m", () => {
    const far = zoomOffset(CHASE_OFFSET, FWD_NORTH, 0);
    const near = zoomOffset(CHASE_OFFSET, FWD_NORTH, 1);
    expect(Math.hypot(far.x, far.y, far.z)).toBeCloseTo(22.804, 2);
    expect(Math.hypot(near.x, near.y, near.z)).toBeCloseTo(2.865, 2);
  });

  it("dollies along the nose when the plane is climbing", () => {
    // 45° climb: forward is (0, √½, −√½), so the eye sits below and behind.
    const s = Math.SQRT1_2;
    const o = zoomOffset(CHASE_OFFSET, { x: 0, y: s, z: -s }, 1);
    expect(o.y).toBeCloseTo(1.4 - 2.5 * s, 3);
    expect(o.z).toBeCloseTo(2.5 * s, 3);
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
