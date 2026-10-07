// Touch → input (M1, Mobile Playable) — the pure seam. The right thumb's
// RELATIVE drag moves an aim point in screen pixels; that point is handed to
// FlightInputSource exactly as a mouse cursor would be, so the instructor
// (F1) flies the nose onto it through the one steering seam desktop uses.
// Two fingers on the aim zone are free-look instead. Renderer- and DOM-free
// (same pattern as freelook.ts / zoom.ts); ui/touch-controls.ts is the thin
// DOM adapter. CLIENT-ONLY — nothing here touches the wire or common/.

import {
  MAX_SPEED,
  MIN_SPEED,
  THROTTLE_RATE,
} from "@angels-bandits/common/constants";

/** One finger on the aim zone, client px. `id` is Touch.identifier. */
export interface TouchPoint {
  id: number;
  x: number;
  y: number;
}

/** The layout viewport the aim point lives in, px. */
export interface Viewport {
  w: number;
  h: number;
}

export interface TouchAimState {
  /** The aim point, client px — where the cursor would be on desktop. */
  aimX: number;
  aimY: number;
  /** Fingers seen last call (positions are the drag baseline). */
  fingers: readonly TouchPoint[];
  /** Two or more fingers down: free-look, aim frozen. */
  looking: boolean;
  /** Free-look drag (px, mouse convention) not yet taken by the caller. */
  lookDx: number;
  lookDy: number;
}

/** A centred aim point and no fingers. */
export function createTouchAim(v: Viewport): TouchAimState {
  return {
    aimX: v.w / 2,
    aimY: v.h / 2,
    fingers: [],
    looking: false,
    lookDx: 0,
    lookDy: 0,
  };
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/**
 * Advance on every touch event with the fingers now down on the aim zone.
 * - One finger that was also the ONLY finger last time: the aim point moves
 *   by its drag × sensitivity, clamped to the viewport.
 * - Any other one-finger case (a fresh touch, or the survivor of a lifted
 *   pair) only re-baselines: lifting or adding a finger never jumps the aim.
 * - Two or more: free-look. The mean drag of the fingers seen both times
 *   accumulates into lookDx/lookDy; the aim point holds.
 * - None: everything holds (releasing keeps the last aim).
 */
export function touchInput(
  s: TouchAimState,
  touches: readonly TouchPoint[],
  v: Viewport,
  sensitivity: number,
): TouchAimState {
  let { aimX, aimY, lookDx, lookDy } = s;
  const t = touches.length === 1 ? touches[0] : undefined;
  const p = s.fingers.length === 1 ? s.fingers[0] : undefined;
  if (t && p) {
    if (t.id === p.id) {
      aimX += (t.x - p.x) * sensitivity;
      aimY += (t.y - p.y) * sensitivity;
    }
  } else if (touches.length >= 2) {
    let dx = 0;
    let dy = 0;
    let n = 0;
    for (const t of touches) {
      const p = s.fingers.find((f) => f.id === t.id);
      if (!p) continue;
      dx += t.x - p.x;
      dy += t.y - p.y;
      n++;
    }
    if (n > 0) {
      lookDx += dx / n;
      lookDy += dy / n;
    }
  }
  return {
    aimX: clamp(aimX, 0, v.w),
    aimY: clamp(aimY, 0, v.h),
    fingers: touches.map(({ id, x, y }) => ({ id, x, y })),
    looking: touches.length >= 2,
    lookDx,
    lookDy,
  };
}

/** Slider 0..1 (bottom..top) → the commanded speed it stands for, m/s. */
export function sliderSpeed(slider: number): number {
  return MIN_SPEED + clamp(slider, 0, 1) * (MAX_SPEED - MIN_SPEED);
}

/** Commanded speed, m/s → where the released knob should sit, 0..1. */
export function speedSlider(targetSpeed: number): number {
  return clamp((targetSpeed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED), 0, 1);
}

/**
 * The positional slider, through the same −1..1 throttle axis W/S drive:
 * while held, the command that moves the commanded speed onto the knob in
 * this frame's step (stepFlight adds throttle × THROTTLE_RATE × dt), so it
 * lands exactly instead of overshooting — at most full W/S rate. Released
 * (null) it commands nothing, so the speed holds exactly like letting go of
 * W, and the knob follows the commanded speed (speedSlider).
 */
export function throttleCommand(
  slider: number | null,
  targetSpeed: number,
  dt: number,
): number {
  if (slider === null || dt <= 0) return 0;
  const error = sliderSpeed(slider) - targetSpeed;
  return clamp(error / (THROTTLE_RATE * dt), -1, 1);
}

/** Aim-drag sensitivity steps the icon cycles through; DEFAULT is index 2. */
export const SENSITIVITY_STEPS = [0.75, 1, 1.5, 2, 3] as const;
const DEFAULT_SENSITIVITY = 1.5;
const SENSITIVITY_STORAGE = "ab-touch-sens";

/** Stored sensitivity, or the default when absent, invalid or blocked
 * (reading `localStorage` itself throws where storage is blocked). */
export function loadSensitivity(target: Pick<Window, "localStorage">): number {
  try {
    const v = Number(target.localStorage.getItem(SENSITIVITY_STORAGE));
    return (SENSITIVITY_STEPS as readonly number[]).includes(v)
      ? v
      : DEFAULT_SENSITIVITY;
  } catch {
    return DEFAULT_SENSITIVITY;
  }
}

/** The next step (wrapping), persisted when storage allows. */
export function nextSensitivity(
  current: number,
  target: Pick<Window, "localStorage">,
): number {
  const i = (SENSITIVITY_STEPS as readonly number[]).indexOf(current);
  const next =
    SENSITIVITY_STEPS[(i + 1) % SENSITIVITY_STEPS.length] ??
    DEFAULT_SENSITIVITY;
  try {
    target.localStorage.setItem(SENSITIVITY_STORAGE, String(next));
  } catch {
    // Private mode / blocked storage: the step still applies this visit.
  }
  return next;
}

// --- Emulated-mouse guard -------------------------------------------------
// A tap anywhere (canvas, an icon, the minimap, a toggle) makes the browser
// fire compatibility mouse events at the tap point after touchend. The gun
// trigger and the aim cursor listen on window, so without this a tap would
// pull the trigger, move the cursor, or (a mouseout) fade steering out. The
// one impure corner of this file: a timestamp, stamped by passive capture
// listeners. A desktop never touches, so there it is always false.

/** Mouse events this soon after a touch event are the browser's echo. */
const EMULATED_MOUSE_MS = 700;
let lastTouchAt = Number.NEGATIVE_INFINITY;
let watching = false;

/** Start stamping touch times on `target` (idempotent). */
export function watchTouches(target: Window): void {
  if (watching) return;
  watching = true;
  const stamp = () => {
    lastTouchAt = performance.now();
  };
  // touchend/cancel too: iOS emits the echo AFTER the finger lifts (a long
  // press outlasts any window measured from touchstart) and has no
  // sourceCapabilities, so the timestamp is its only tell.
  for (const type of ["touchstart", "touchend", "touchcancel"]) {
    target.addEventListener(type, stamp, { capture: true, passive: true });
  }
}

/** Whether a mouse event is a touch's compatibility echo, not a mouse. */
export function emulatedMouse(e: MouseEvent): boolean {
  const caps = (e as { sourceCapabilities?: { firesTouchEvents?: boolean } })
    .sourceCapabilities;
  if (caps?.firesTouchEvents) return true;
  return performance.now() - lastTouchAt < EMULATED_MOUSE_MS;
}
