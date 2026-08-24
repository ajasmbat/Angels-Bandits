// Chase-camera composition (ANGE-G9CPCV). The aim-zoom dolly is the third
// DISPLAY modifier on this camera, alongside the free-look orbit and the storm
// shake — none of them may reach the smoothed chase state. Expected values are
// hand-worked from the constants (chase 22 m back / 6 m up, zoom 6 m / 2.2 m,
// look-ahead 350 m), never recomputed the way the implementation does it.

import { createFlightState } from "@angels-bandits/common/flight";
import { describe, expect, it } from "vitest";
import { ChaseCamera } from "../src/game/camera";

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
  it("sits 22 m behind and 6 m above, looking 2 m over the plane", () => {
    const { pos, look } = framed(0);
    expect(pos[0]).toBeCloseTo(1000, 3);
    expect(pos[1]).toBeCloseTo(306, 3);
    expect(pos[2]).toBeCloseTo(1022, 3);
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
  it("dollies in to 6 m behind and 2.2 m above", () => {
    const { pos } = framed(1);
    expect(pos[0]).toBeCloseTo(1000, 3);
    expect(pos[1]).toBeCloseTo(302.2, 3);
    expect(pos[2]).toBeCloseTo(1006, 3);
  });

  it("closes the eye-to-plane distance from 22.8 m to 6.4 m", () => {
    const far = framed(0).pos;
    const near = framed(1).pos;
    const range = (p: number[]) =>
      Math.hypot(
        (p[0] as number) - 1000,
        (p[1] as number) - 300,
        (p[2] as number) - 1000,
      );
    expect(range(far)).toBeCloseTo(22.804, 2);
    expect(range(near)).toBeCloseTo(6.391, 2);
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
    expect(r).toBeCloseTo(6.391, 2);
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
    expect(calls.pos[1]).toBeCloseTo(306, 3);
    expect(calls.pos[2]).toBeCloseTo(1022, 3);
  });
});
