// Edge-marker seam: pure NDC clamp math for offscreen enemy arrows.
// Inputs are the target's NDC coordinates (x right, y up, on screen within
// ±1) plus a behind-the-camera flag; the result is the marker's clamped NDC
// anchor and an arrow angle measured clockwise from screen-up. Worked
// examples are hand-derived from the clamp geometry.

import { describe, expect, it } from "vitest";
import { edgeMarker } from "../src/ui/markers";

describe("edgeMarker", () => {
  it("returns null for a target on screen in front of the camera", () => {
    expect(edgeMarker(0.5, 0.2, false)).toBeNull();
    expect(edgeMarker(-1, 1, false)).toBeNull();
  });

  it("clamps a target off the right edge to (0.92, 0) with a right-pointing arrow", () => {
    const m = edgeMarker(2, 0, false);
    expect(m).not.toBeNull();
    expect(m?.x).toBeCloseTo(0.92);
    expect(m?.y).toBeCloseTo(0);
    expect(m?.angle).toBeCloseTo(Math.PI / 2);
  });

  it("clamps a target above the top edge to (0, 0.92) with an up arrow", () => {
    const m = edgeMarker(0, 1.5, false);
    expect(m?.x).toBeCloseTo(0);
    expect(m?.y).toBeCloseTo(0.92);
    expect(m?.angle).toBeCloseTo(0);
  });

  it("clamps a diagonal target to the corner along its center ray", () => {
    const m = edgeMarker(3, -3, false);
    expect(m?.x).toBeCloseTo(0.92);
    expect(m?.y).toBeCloseTo(-0.92);
    expect(m?.angle).toBeCloseTo((3 * Math.PI) / 4);
  });

  it("never returns null for a target behind the camera, and mirrors it", () => {
    // Projection through a behind-camera w flips coordinates; the marker
    // must point where the target actually is: mirrored to the left edge.
    const m = edgeMarker(0.1, 0, true);
    expect(m).not.toBeNull();
    expect(m?.x).toBeCloseTo(-0.92);
    expect(m?.y).toBeCloseTo(0);
    expect(m?.angle).toBeCloseTo(-Math.PI / 2);
  });

  it("points straight down for a target exactly behind the camera", () => {
    const m = edgeMarker(0, 0, true);
    expect(m?.x).toBeCloseTo(0);
    expect(m?.y).toBeCloseTo(-0.92);
    expect(m?.angle).toBeCloseTo(Math.PI);
  });
});
