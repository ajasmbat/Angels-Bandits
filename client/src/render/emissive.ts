// Emissive-ladder plumbing (S1): the ladder targets live in common/constants
// as peak linear luminances; each material derives its HDR color boost from
// its rung and its own color, so the strict WINDOW < SIGN < LAMP < BEACON <
// TRACER ordering can never drift out from under a hand-tuned scalar.

import type * as THREE from "three";

/** Rec. 709 luminance of a linear-space color (THREE.Color is linear). */
export const luminance = (c: THREE.Color): number =>
  0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** Scalar boost that lifts `color` to `target` peak linear luminance. */
export const emissiveBoost = (color: THREE.Color, target: number): number =>
  target / luminance(color);
