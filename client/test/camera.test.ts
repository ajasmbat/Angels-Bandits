// Chase-camera composition (ANGE-G9CPCV). The aim-zoom dolly is the third
// DISPLAY modifier on this camera, alongside the free-look orbit and the storm
// shake — none of them may reach the smoothed chase state. Expected values are
// hand-worked from the constants (chase D(65) = 26 + 0.12·25 = 29 m along the
// 22:6 arm — 27.978 m back / 7.630 m up — zoom 6 m / 2.2 m, look-ahead
// 350 m), never recomputed the way the implementation does it.

import { generateCity } from "@angels-bandits/common/city";
import { RIVER_CENTER_Z } from "@angels-bandits/common/city/river";
import { buildCityIndex } from "@angels-bandits/common/collision";
import { CITY_SEED, PLAYER_RADIUS } from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { ChaseCamera, type SolidQuery } from "../src/game/camera";
import { touchesSolid } from "../src/game/collision";

/** Records what the camera was told, without a WebGL context (storm idiom). */
function stubCamera() {
  const calls = { pos: [0, 0, 0], look: [0, 0, 0] };
  const cam = {
    position: {
      set: (x: number, y: number, z: number) => {
        calls.pos = [x, y, z];
      },
    },
    lookAt: (x: number, y: number, z: number) => {
      calls.look = [x, y, z];
    },
  } as unknown as import("three").PerspectiveCamera;
  return { calls, cam };
}

const DT = 1 / 60;
/** Level and facing north (yaw 0 ⇒ forward is −Z), mid-map, mid-altitude. */
const flight = createFlightState({ x: 1000, y: 300, z: 1000 });

/** Snap behind the plane, then one settled frame at the given zoom. */
function framed(zoom: number) {
  const { calls, cam } = stubCamera();
  const chase = new ChaseCamera();
  chase.snapTo(flight);
  chase.update(cam, flight, DT, undefined, undefined, zoom);
  return calls;
}

describe("chase camera at zoom 0", () => {
  it("sits 28 m behind and 7.6 m above at 65 m/s, looking 2 m over the plane", () => {
    const { pos, look } = framed(0);
    expect(pos[0]).toBeCloseTo(1000, 3);
    expect(pos[1]).toBeCloseTo(307.6304, 3);
    expect(pos[2]).toBeCloseTo(1027.9781, 3);
    expect(look).toEqual([1000, 302, 1000]);
  });

  it("is bit-identical whether or not a zoom is passed (regression guard)", () => {
    const { calls, cam } = stubCamera();
    const chase = new ChaseCamera();
    chase.snapTo(flight);
    chase.update(cam, flight, DT); // the pre-zoom call shape
    expect(calls).toEqual(framed(0));
  });
});

describe("chase camera at full zoom", () => {
  it("dollies in to 6 m behind and 2.6 m above", () => {
    const { pos } = framed(1);
    expect(pos[0]).toBeCloseTo(1000, 3);
    expect(pos[1]).toBeCloseTo(302.6, 3);
    expect(pos[2]).toBeCloseTo(1006, 3);
  });

  it("closes the eye-to-plane distance from 29 m to 6.5 m", () => {
    const far = framed(0).pos;
    const near = framed(1).pos;
    const range = (p: number[]) =>
      Math.hypot(
        (p[0] as number) - 1000,
        (p[1] as number) - 300,
        (p[2] as number) - 1000,
      );
    expect(range(far)).toBeCloseTo(29, 2);
    expect(range(near)).toBeCloseTo(6.539, 2);
  });

  it("swings the view axis onto the gun line, 350 m down the nose", () => {
    const { look } = framed(1);
    expect(look[0]).toBeCloseTo(1000, 3);
    expect(look[1]).toBeCloseTo(300, 3);
    expect(look[2]).toBeCloseTo(650, 3);
  });
});

describe("zoom composes with the other display modifiers", () => {
  it("keeps the storm shake displacing the eye while zoomed", () => {
    const { calls, cam } = stubCamera();
    const chase = new ChaseCamera();
    chase.snapTo(flight);
    chase.update(cam, flight, DT, undefined, { x: 3, y: -2, z: 1 }, 1);
    const plain = framed(1).pos;
    expect(calls.pos[0]).toBeCloseTo((plain[0] as number) + 3, 3);
    expect(calls.pos[1]).toBeCloseTo((plain[1] as number) - 2, 3);
    expect(calls.pos[2]).toBeCloseTo((plain[2] as number) + 1, 3);
  });

  it("orbits at the DOLLIED radius, not the chase one, during the ease-out", () => {
    // Free-look wins, so the two only overlap while a zoom eases out — the
    // orbit must ride the shortened offset or the eye snaps back out.
    const { calls, cam } = stubCamera();
    const chase = new ChaseCamera();
    chase.snapTo(flight);
    chase.update(cam, flight, DT, { yaw: Math.PI / 2, pitch: 0 }, undefined, 1);
    const r = Math.hypot(
      calls.pos[0] - 1000,
      calls.pos[1] - 300,
      calls.pos[2] - 1000,
    );
    expect(r).toBeCloseTo(6.539, 2);
  });

  it("never lets the zoom leak into the smoothed chase state", () => {
    // Zoom in hard, then release: the state the camera falls back to must be
    // the untouched chase framing, not a dollied one.
    const { calls, cam } = stubCamera();
    const chase = new ChaseCamera();
    chase.snapTo(flight);
    for (let i = 0; i < 60; i++)
      chase.update(cam, flight, DT, undefined, undefined, 1);
    chase.update(cam, flight, DT, undefined, undefined, 0);
    expect(calls.pos[1]).toBeCloseTo(307.6304, 3);
    expect(calls.pos[2]).toBeCloseTo(1027.9781, 3);
  });
});

// L11b spring arm. The river (river.ts): water at y −22, a bridge deck
// −2.5…0 over x = k·200 ± 20, channel z 1100 ± 60. Flying the channel the
// un-armed eye rides 6 m above the plane (more with the chase lag), so a
// climb-out past a deck lifts it straight into the slab.
describe("spring arm (L11b)", () => {
  const buildings = generateCity(CITY_SEED);
  const index = buildCityIndex(buildings);
  const solid: SolidQuery = (p, r) => touchesSolid(p, r, buildings, index);
  /** The near plane (0.1 m) must never be inside anything. */
  const NEAR = 0.1;

  interface Pass {
    insideFrames: number;
    /** Largest frame-to-frame move of the eye RELATIVE to the plane, m,
     * after a 0.5 s settle: the un-armed chase moves ≤ 0.7 m here, and a
     * snapping arm 7–17 m. */
    maxStep: number;
  }

  /** Fly eastbound down the channel from (`x0`, `y0`) at `v` m/s; once
   * `climbAfter` m have been flown, pitch up at `rate` (stick) to `climb`
   * rad and hold it. Every frame goes through the real ChaseCamera. */
  function pass(opts: {
    x0: number;
    y0: number;
    v: number;
    climbAfter: number;
    rate: number;
    climb: number;
    arm: boolean;
    look?: { yaw: number; pitch: number };
  }): Pass {
    const { calls, cam } = stubCamera();
    const chase = new ChaseCamera();
    if (opts.arm) chase.solid = solid;
    let f: FlightState = {
      ...createFlightState(
        { x: opts.x0, y: opts.y0, z: RIVER_CENTER_Z },
        -Math.PI / 2,
      ),
      speed: opts.v,
      targetSpeed: opts.v,
    };
    chase.snapTo(f);
    const out: Pass = { insideFrames: 0, maxStep: 0 };
    let flown = 0;
    let prev: Vec3 | null = null;
    for (let i = 0; i < 6 / DT; i++) {
      const up = flown >= opts.climbAfter && f.pitch < opts.climb;
      f = stepFlight(
        f,
        { pitch: up ? opts.rate : 0, turn: 0, roll: 0, throttle: 0 },
        DT,
      );
      flown += f.speed * DT;
      expect(solid(f.pos, PLAYER_RADIUS)).toBe(false); // a flyable script
      chase.update(cam, f, DT, opts.look);
      const eye = { x: calls.pos[0], y: calls.pos[1], z: calls.pos[2] };
      if (solid(eye, NEAR)) out.insideFrames++;
      // The eye is in render space, next to the plane's nearest image.
      const rel = wrapDelta(f.pos, eye);
      if (prev && i * DT >= 0.5) {
        out.maxStep = Math.max(
          out.maxStep,
          Math.hypot(rel.x - prev.x, rel.y - prev.y, rel.z - prev.z),
        );
      }
      prev = rel;
    }
    return out;
  }

  /** Mid-span (x 100) at y −10, under the x = 200 deck. */
  const gentle = { x0: 100, y0: -10, climbAfter: 60, rate: 0.3, climb: 0.1 };
  const hard = { x0: 100, y0: -10, climbAfter: 100, rate: 1, climb: 0.52 };

  for (const v of [50, 70, 90]) {
    it(`a gentle climb-out under a bridge at ${v} m/s: never inside a solid`, () => {
      expect(pass({ ...gentle, v, arm: false }).insideFrames).toBeGreaterThan(
        0,
      );
      const on = pass({ ...gentle, v, arm: true });
      expect(on.insideFrames).toBe(0);
      expect(on.maxStep).toBeLessThan(3);
    });

    it(`a full-stick climb-out at a deck's edge at ${v} m/s: never inside a solid`, () => {
      expect(pass({ ...hard, v, arm: false }).insideFrames).toBeGreaterThan(0);
      const on = pass({ ...hard, v, arm: true });
      expect(on.insideFrames).toBe(0);
      expect(on.maxStep).toBeLessThan(3);
    });
  }

  it("climbing out from under the x = 0 bridge, across the seam", () => {
    const seam = { ...gentle, x0: 1900, v: 70 };
    expect(pass({ ...seam, arm: false }).insideFrames).toBeGreaterThan(0);
    const on = pass({ ...seam, arm: true });
    expect(on.insideFrames).toBe(0);
    expect(on.maxStep).toBeLessThan(3);
  });

  it("free-looking up and down under the decks: never inside a solid", () => {
    for (const pitch of [-0.6, 0.6]) {
      const level = { ...gentle, climbAfter: Number.POSITIVE_INFINITY };
      const on = pass({ ...level, v: 70, arm: true, look: { yaw: 0, pitch } });
      expect(on.insideFrames).toBe(0);
      expect(on.maxStep).toBeLessThan(3);
    }
  });

  it("leaves the open-air framing exactly as it was", () => {
    // Mid-map at 300 m: nothing near, so the arm never acts.
    const { calls, cam } = stubCamera();
    const chase = new ChaseCamera();
    chase.solid = solid;
    chase.snapTo(flight);
    chase.update(cam, flight, DT);
    expect(calls).toEqual(framed(0));
  });
});
