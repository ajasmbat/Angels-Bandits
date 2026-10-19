// FC1 gun-sight (ui/gunsight.ts): the zoomed view's reticle — its fade with
// the zoom, the range arc and its label, and the projected gun line, whose
// ticks run up from below the pipper onto it when the eye sits just over the
// gun line (the zoom's sight eye, game/zoom.ts).

import { BULLET_RANGE } from "@angels-bandits/common/constants";
import { createFlightState } from "@angels-bandits/common/flight";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  GUN_LINE_RANGES,
  gunsightView,
  projectGunLine,
} from "../src/ui/gunsight";

describe("gunsightView", () => {
  it("is hidden out of the zoom and through its first half, full by 0.95", () => {
    expect(gunsightView(0, null).opacity).toBe(0);
    expect(gunsightView(0.5, null).opacity).toBe(0);
    expect(gunsightView(0.95, null).opacity).toBe(1);
    expect(gunsightView(1, null).opacity).toBe(1);
    const mid = gunsightView(0.725, null).opacity;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
  });

  it("darkens the vignette with the zoom", () => {
    expect(gunsightView(0, null).vignette).toBe(0);
    expect(gunsightView(1, null).vignette).toBeCloseTo(0.85, 6);
  });

  it("sweeps the range arc with the target's range, hot inside the guns' reach", () => {
    const near = gunsightView(1, 175);
    expect(near.arc).toBeCloseTo(0.5, 6);
    expect(near.inRange).toBe(true);
    expect(near.label).toBe("175 M");
    const far = gunsightView(1, 700);
    expect(far.arc).toBe(1);
    expect(far.inRange).toBe(false);
    expect(gunsightView(1, BULLET_RANGE).inRange).toBe(true);
  });

  it("shows no arc and no label without a target", () => {
    const v = gunsightView(1, null);
    expect(v.arc).toBe(0);
    expect(v.inRange).toBe(false);
    expect(v.label).toBe("");
  });
});

describe("projectGunLine", () => {
  const W = 1600;
  const H = 900;
  /** Level north at (1000, 300, 1000); the sight eye 2.5 m behind and 1.4 m
   * over, looking 350 m down the nose (zoom.ts at full zoom), 30° FOV. */
  const setup = () => {
    const flight = createFlightState({ x: 1000, y: 300, z: 1000 }, 0);
    const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 5000);
    cam.position.set(1000, 301.4, 1002.5);
    cam.lookAt(1000, 300, 1000 - BULLET_RANGE);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    return { flight, cam };
  };

  it("runs up from below the pipper onto it, on the centre line", () => {
    const { flight, cam } = setup();
    const out = new Float64Array(GUN_LINE_RANGES.length * 2);
    projectGunLine(cam, cam.position, flight, out, new THREE.Vector3(), W, H);
    for (let i = 0; i < GUN_LINE_RANGES.length; i++) {
      expect(out[i * 2]).toBeCloseTo(W / 2, 3);
    }
    // The pipper (the last point) is the view's centre…
    const last = GUN_LINE_RANGES.length - 1;
    expect(out[last * 2 + 1]).toBeCloseTo(H / 2, 3);
    // …and every nearer tick sits lower on screen than the next one out.
    for (let i = 0; i < last; i++) {
      expect(out[i * 2 + 1] as number).toBeGreaterThan(
        out[(i + 1) * 2 + 1] as number,
      );
    }
    // The 50 m tick is clearly off the pipper (tens of pixels, not one).
    expect((out[1] as number) - H / 2).toBeGreaterThan(20);
  });

  it("marks a point behind the camera NaN", () => {
    const { flight, cam } = setup();
    cam.lookAt(1000, 300, 1000 + BULLET_RANGE); // looking back
    cam.updateMatrixWorld();
    const out = new Float64Array(GUN_LINE_RANGES.length * 2);
    projectGunLine(cam, cam.position, flight, out, new THREE.Vector3(), W, H);
    expect(Number.isNaN(out[0] as number)).toBe(true);
  });
});
