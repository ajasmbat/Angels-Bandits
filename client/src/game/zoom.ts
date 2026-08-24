// Hold-right-click aim zoom (ANGE-G9CPCV) — the pure seam. One eased scalar
// drives the FOV, the camera dolly, the look-at target and the steering cost,
// so every one of them arrives and leaves together. Same shape as freelook.ts:
// a per-frame step over immutable state, renderer-free, with thin adapters in
// flight-input/camera/main. CLIENT-ONLY — nothing here touches the wire or
// common/, and the reduced turn rate is always valid under the server's clamps.

import { BULLET_RANGE } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";

/** Un-zoomed vertical FOV — the value main.ts builds the camera with. */
export const BASE_FOV = 70;
/** Aimed FOV: 2.5× magnification, tight enough to read a bandit at range. */
export const ZOOM_FOV = 28;
/** Eye distance behind the plane at full zoom (chase is 22 m). */
const ZOOM_DISTANCE = 6;
/** Eye height above the plane at full zoom (chase is 6 m). Tuned by capture,
 * not by theory: a 9 m span subtends 73 degrees at 6 m, so at a 28-degree FOV
 * the airframe is ALWAYS wider than the frame and the only question is where
 * it sits vertically. 2.2 put the upper wing and struts across the bottom
 * third; 3.0 lifted the plane out of shot entirely. 2.6 leaves a thin
 * foreground silhouette along the bottom edge with the target area clear. */
const ZOOM_HEIGHT = 2.6;
/** Steering authority at full zoom: a stabilized gun platform can't break hard. */
const ZOOM_STEER = 0.6;
/** Exp response 1/s: ≥95% of the commanded zoom within ~0.17 s. */
const ZOOM_RESPONSE = 18;
/** Distance below which z snaps to an endpoint, so 0 and 1 are bit-exact. */
const ZOOM_SNAP_EPSILON = 1e-3;
/** How far down the nose the zoomed view axis looks — the gun line's own range. */
const ZOOM_LOOK_AHEAD = BULLET_RANGE;
/** The un-zoomed look-at rides 2 m above the plane (camera.ts's own offset). */
const CHASE_LOOK_UP = 2;

export interface ZoomState {
  /** Whether the zoom is currently commanded (edge rules key off this). */
  held: boolean;
  /** Eased zoom 0..1, exactly 0 when out and exactly 1 when fully in. */
  z: number;
}

/** Fresh, fully-out zoom (spawn / death force-exit). */
export function createZoom(): ZoomState {
  return { held: false, z: 0 };
}

/**
 * Free-look wins. At full zoom the eye is ~6 m from the plane, so orbiting at
 * that radius through a 28° FOV would put the viewer inside the fuselage —
 * composing them needs a second camera mode. Keeping them exclusive also keeps
 * the firing gate a single rule: free-look suppresses fire, zoom never does.
 */
export function zoomHeld(aimHeld: boolean, freeLookHeld: boolean): boolean {
  return aimHeld && !freeLookHeld;
}

/** Advance one frame toward the commanded end, snapping out at both ends. */
export function stepZoom(s: ZoomState, held: boolean, dt: number): ZoomState {
  const target = held ? 1 : 0;
  const blend = 1 - Math.exp(-ZOOM_RESPONSE * dt);
  let z = s.z + (target - s.z) * blend;
  if (z < ZOOM_SNAP_EPSILON) z = 0;
  else if (z > 1 - ZOOM_SNAP_EPSILON) z = 1;
  return { held, z };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Vertical FOV for the current zoom. Exactly BASE_FOV at z=0. */
export function zoomFov(z: number): number {
  return lerp(BASE_FOV, ZOOM_FOV, z);
}

/** Steering authority for the current zoom. Exactly 1 at z=0. */
export function zoomSteer(z: number): number {
  return lerp(1, ZOOM_STEER, z);
}

/**
 * Dolly the DISPLAYED eye offset (camera − plane, images already aligned) in
 * toward the nose. Blending the offset rather than feeding the dolly through
 * the chase target keeps it off the CAMERA_RESPONSE smoothing — zoom responds
 * at its own rate — and preserves camera.ts's invariant that displayed
 * modifiers never re-enter the chase state. Returns `chase` itself at z=0.
 */
export function zoomOffset(chase: Vec3, fwd: Vec3, z: number): Vec3 {
  return {
    x: lerp(chase.x, -fwd.x * ZOOM_DISTANCE, z),
    y: lerp(chase.y, -fwd.y * ZOOM_DISTANCE + ZOOM_HEIGHT, z),
    z: lerp(chase.z, -fwd.z * ZOOM_DISTANCE, z),
  };
}

/**
 * Swing the look-at target from the plane's shoulder out along the nose, so at
 * full zoom the view axis IS the gun line and the pipper lands mid-frame.
 */
export function zoomLookAt(aim: Vec3, fwd: Vec3, z: number): Vec3 {
  return {
    x: lerp(aim.x, aim.x + fwd.x * ZOOM_LOOK_AHEAD, z),
    y: lerp(aim.y + CHASE_LOOK_UP, aim.y + fwd.y * ZOOM_LOOK_AHEAD, z),
    z: lerp(aim.z, aim.z + fwd.z * ZOOM_LOOK_AHEAD, z),
  };
}
