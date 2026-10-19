// Hold-right-click aim zoom (ANGE-G9CPCV, FC1's gun-sight) — the pure seam.
// One eased scalar drives the FOV, the camera dolly, the look-at target, the
// own plane's dissolve, the steadying and the steering, so every one of them
// arrives and leaves together. Same shape as freelook.ts: a per-frame step
// over immutable state, renderer-free, with thin adapters in
// flight-input/camera/main. CLIENT-ONLY — nothing here touches the wire or
// common/, and the reduced turn rate is always valid under the server's clamps.
//
// FC1: the own plane no longer fights the dolly. Before, the eye stopped 6 m
// behind the tail and the 9 m span, wider than any 28° frame, sat across the
// bottom of the shot. Now the airframe dissolves away (render/fleet.ts, a
// screen-door fade) while the eye slides up onto the gun line, so the full
// sight picture is clear. The wheel steps the FOV through three sights while
// the zoom is held, each eased.

import { BULLET_RANGE } from "@angels-bandits/common/constants";
import { DEFAULT_TUNING } from "@angels-bandits/common/tuning";
import type { Vec3 } from "@angels-bandits/common/world";
import { tuning } from "./tuning";

/** Un-zoomed vertical FOV — the value main.ts builds the camera with (FL1:
 * the shipped default; zoomFov reads the client's live tuning). */
export const BASE_FOV = DEFAULT_TUNING.baseFov;
/** Aimed FOV of the first sight, degrees (the tuning's zoomFov). */
export const ZOOM_FOV = DEFAULT_TUNING.zoomFov;
/** The pre-FC1 zoom's flat steering cost in every aim mode — what
 * tools/flight-courses.ts's BEFORE arm flies. */
export const PRE_FC1_ZOOM_STEER = 0.6;
/** Pre-FC1 dolly (zoomFade off): 6 m behind, 2.6 m above. A 9 m span
 * subtends 73° at 6 m, so at a 28° FOV the airframe was ALWAYS wider than
 * the frame; 2.6 left a thin silhouette along the bottom edge. */
const DOLLY_DISTANCE = 6;
const DOLLY_HEIGHT = 2.6;
/** FC1 (zoomFade on): the eye just behind and over the cockpit — the plane
 * is gone by then — so the view axis is the gun line and the line itself,
 * seen from 1.4 m above it, projects as a short stroke rising onto the
 * pipper: the sight's range ladder (hud.ts). */
const SIGHT_DISTANCE = 2.5;
const SIGHT_HEIGHT = 1.4;
/** Stick steering never drops below this share zoomed (a 15° sight would
 * otherwise leave a fifth of the turn rate). */
const STICK_STEER_MIN = 0.3;
/** z at which the own plane starts to dissolve, and where it is gone — well
 * before the eye reaches the airframe, so no near-plane cut ever shows. */
const FADE_START = 0.12;
const FADE_END = 0.55;
/** ln 20: the exp response that covers 95% of the way in `zoomTime`. */
const LN20 = Math.log(20);
/** Distance below which z snaps to an endpoint, so 0 and 1 are bit-exact. */
const ZOOM_SNAP_EPSILON = 1e-3;
/** …and the FOV to its step's. */
const FOV_SNAP = 1e-3;
/** How far down the nose the zoomed view axis looks — the gun line's own range. */
const ZOOM_LOOK_AHEAD = BULLET_RANGE;
/** The un-zoomed look-at rides 2 m above the plane (camera.ts's own offset). */
const CHASE_LOOK_UP = 2;
/** Wheel sights, in order: the tuning fields holding their FOVs. */
export const ZOOM_STEPS = 3;

export interface ZoomState {
  /** Whether the zoom is currently commanded (edge rules key off this). */
  held: boolean;
  /** Eased zoom 0..1, exactly 0 when out and exactly 1 when fully in. */
  z: number;
  /** The wheel's sight, 0..ZOOM_STEPS−1 (0 = right-click's own). Kept while
   * the zoom eases out, so the way out never jumps; 0 again once out. */
  step: number;
  /** The zoomed FOV, degrees, eased onto the step's. */
  fov: number;
}

/** The FOV of wheel sight `step`, degrees. */
export function stepFov(step: number): number {
  return step <= 0
    ? tuning.zoomFov
    : step === 1
      ? tuning.zoomFovMid
      : tuning.zoomFovTight;
}

/** Fresh, fully-out zoom (spawn / death force-exit). */
export function createZoom(): ZoomState {
  return { held: false, z: 0, step: 0, fov: stepFov(0) };
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

/** The exp response, 1/s, for the tuning's zoomTime. */
const response = (): number => LN20 / Math.max(0.01, tuning.zoomTime);

/** Advance one frame toward the commanded end, snapping out at both ends. */
export function stepZoom(s: ZoomState, held: boolean, dt: number): ZoomState {
  const target = held ? 1 : 0;
  const blend = 1 - Math.exp(-response() * dt);
  let z = s.z + (target - s.z) * blend;
  if (z < ZOOM_SNAP_EPSILON) z = 0;
  else if (z > 1 - ZOOM_SNAP_EPSILON) z = 1;
  // Out: back to the first sight for the next press.
  const step = z === 0 && !held ? 0 : s.step;
  const want = stepFov(step);
  let fov = step === s.step ? s.fov + (want - s.fov) * blend : want;
  if (Math.abs(fov - want) < FOV_SNAP) fov = want;
  return { held, z, step, fov };
}

/**
 * The wheel while the zoom is held: `notches` toward the user (+, down)
 * widens a sight, away (−, up) tightens one, within the three. Out of the
 * zoom the wheel is the throttle's (flight-input.ts), so this is the
 * identity there.
 */
export function zoomWheel(s: ZoomState, notches: number): ZoomState {
  if (!s.held || notches === 0) return s;
  const step = Math.max(
    0,
    Math.min(ZOOM_STEPS - 1, s.step + (notches < 0 ? 1 : -1)),
  );
  return step === s.step ? s : { ...s, step };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Vertical FOV for the current zoom. Exactly the tuning's baseFov at z=0;
 * `fov` is the zoomed sight's (ZoomState.fov; the first sight's by default). */
export function zoomFov(z: number, fov = tuning.zoomFov): number {
  return lerp(tuning.baseFov, fov, z);
}

/**
 * Steering authority for the current zoom. Exactly 1 at z=0. The mouse-aim
 * instructor keeps all of it: the cursor IS the aim, and a narrower FOV
 * already moves it fewer degrees per pixel — so aim travels the screen at
 * the same speed it always did. A rate stick (classic, the arrows) scales
 * with the FOV instead, so a full stick sweeps the zoomed screen exactly as
 * fast as it sweeps the wide one (never under STICK_STEER_MIN).
 */
export function zoomSteer(
  z: number,
  mode: "instructor" | "stick" = "stick",
  fov = tuning.zoomFov,
): number {
  if (mode === "instructor" || z === 0) return 1;
  const k = Math.max(STICK_STEER_MIN, Math.min(1, fov / tuning.baseFov));
  return lerp(1, k, z);
}

/** How far the own plane has dissolved, 0 (drawn) … 1 (gone): a smoothstep
 * over FADE_START..FADE_END of the zoom; 0 with the tuning's zoomFade off. */
export function zoomPlaneFade(z: number): number {
  if (tuning.zoomFade < 0.5 || z <= FADE_START) return 0;
  if (z >= FADE_END) return 1;
  const t = (z - FADE_START) / (FADE_END - FADE_START);
  return t * t * (3 - 2 * t);
}

/** Multiplier on the displayed camera's shake and roll wobble: 1 out of the
 * zoom, 1 − zoomSteady at full zoom. */
export function zoomSteady(z: number): number {
  return 1 - tuning.zoomSteady * z;
}

/** Bullet magnetism's bend-rate multiplier for the current zoom: 1 out of
 * it, the tuning's zoomMagnet at full zoom (its spec caps it at 1.5). */
export function zoomMagnet(z: number): number {
  return lerp(1, tuning.zoomMagnet, z);
}

/** World up — the default up for the dolly and look-at offsets. */
const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * Dolly the DISPLAYED eye offset (camera − plane, images already aligned) in
 * toward the nose. Blending the offset rather than feeding the dolly through
 * the chase target keeps it off the CAMERA_RESPONSE smoothing — zoom responds
 * at its own rate — and preserves camera.ts's invariant that displayed
 * modifiers never re-enter the chase state. Returns `chase` itself at z=0.
 * `up` is the chase camera's up (F7: the plane's own up through aerobatics).
 * FC1: with zoomFade on the eye ends over the cockpit (the plane has
 * dissolved by then), otherwise at the pre-FC1 6 m dolly.
 */
export function zoomOffset(
  chase: Vec3,
  fwd: Vec3,
  z: number,
  up: Vec3 = WORLD_UP,
): Vec3 {
  const sight = tuning.zoomFade >= 0.5;
  const dist = sight ? SIGHT_DISTANCE : DOLLY_DISTANCE;
  const height = sight ? SIGHT_HEIGHT : DOLLY_HEIGHT;
  return {
    x: lerp(chase.x, -fwd.x * dist + up.x * height, z),
    y: lerp(chase.y, -fwd.y * dist + up.y * height, z),
    z: lerp(chase.z, -fwd.z * dist + up.z * height, z),
  };
}

/**
 * Swing the look-at target from the plane's shoulder out along the nose, so at
 * full zoom the view axis IS the gun line and the pipper lands mid-frame.
 * `up` as zoomOffset's.
 */
export function zoomLookAt(
  aim: Vec3,
  fwd: Vec3,
  z: number,
  up: Vec3 = WORLD_UP,
): Vec3 {
  return {
    x: lerp(aim.x + up.x * CHASE_LOOK_UP, aim.x + fwd.x * ZOOM_LOOK_AHEAD, z),
    y: lerp(aim.y + up.y * CHASE_LOOK_UP, aim.y + fwd.y * ZOOM_LOOK_AHEAD, z),
    z: lerp(aim.z + up.z * CHASE_LOOK_UP, aim.z + fwd.z * ZOOM_LOOK_AHEAD, z),
  };
}
