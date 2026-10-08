// Touch → input (M1, Mobile Playable) — the pure seam. The right thumb's
// RELATIVE drag is reported two ways: as raw drag px (aimDx/aimDy), which
// the instructor mode turns into a world-anchored aim direction (M7,
// touch-aim-dir.ts), and as an aim point in screen pixels, which classic
// mode hands to FlightInputSource as its stick — springing back to centre
// once the thumb lifts (springBack).
// Two fingers on the aim zone are free-look instead, once gateLook (M8) has
// seen both make a deliberate drag. Renderer- and DOM-free
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
  /** One-finger drag (px, mouse convention, before sensitivity) not yet
   * taken by the caller — the instructor mode's aim direction (M7). */
  aimDx: number;
  aimDy: number;
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
    aimDx: 0,
    aimDy: 0,
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
 *   by its drag × sensitivity, clamped to the viewport, and the raw drag
 *   accumulates into aimDx/aimDy.
 * - Any other one-finger case (a fresh touch, or the survivor of a lifted
 *   pair) only re-baselines: lifting or adding a finger never jumps the aim.
 * - Two or more: free-look. The mean drag of the fingers seen both times
 *   accumulates into lookDx/lookDy; the aim point holds.
 * - None: everything holds here; classic mode's springBack, and the
 *   instructor mode's world-anchored direction, take it from there.
 */
export function touchInput(
  s: TouchAimState,
  touches: readonly TouchPoint[],
  v: Viewport,
  sensitivity: number,
): TouchAimState {
  let { aimX, aimY, aimDx, aimDy, lookDx, lookDy } = s;
  const t = touches.length === 1 ? touches[0] : undefined;
  const p = s.fingers.length === 1 ? s.fingers[0] : undefined;
  if (t && p) {
    if (t.id === p.id) {
      aimX += (t.x - p.x) * sensitivity;
      aimY += (t.y - p.y) * sensitivity;
      aimDx += t.x - p.x;
      aimDy += t.y - p.y;
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
    aimDx,
    aimDy,
    looking: touches.length >= 2,
    lookDx,
    lookDy,
  };
}

// --- Free-look gate (M8) --------------------------------------------------
// A resting second finger (a missed ZOOM, a palm) must never swing the
// camera and block the guns: two fingers only free-look once BOTH make a
// deliberate drag right after the second lands. Until then the second is
// ignored and the first keeps aiming.

/** Each finger of a pair must travel this far, px… */
export const LOOK_MIN_PX = 16;
/** …within this long of the second finger landing, ms, to free-look. */
export const LOOK_WINDOW_MS = 150;

export interface LookGate {
  /** The finger that aims (the first down), or null with none down. */
  primary: number | null;
  /** The pair being judged: when the second finger landed (the event's
   * timeStamp, ms) and where both fingers were then. */
  pair: { at: number; a: TouchPoint; b: TouchPoint } | null;
  /** This pair missed its window (or FIRE dropped it): no free-look until
   * fewer than two fingers are down. */
  missed: boolean;
  /** The pair passed: free-look until FIRE or a lift. */
  open: boolean;
}

export function createLookGate(): LookGate {
  return { primary: null, pair: null, missed: false, open: false };
}

const travelled = (from: TouchPoint, now: TouchPoint | undefined): boolean =>
  now !== undefined &&
  Math.hypot(now.x - from.x, now.y - from.y) >= LOOK_MIN_PX;

/**
 * Which aim-zone fingers reach touchInput this event (`now`: its timeStamp).
 * One finger always does. With two or more, only the aiming finger does
 * until both fingers of the pair have moved LOOK_MIN_PX from where they were
 * when the second landed, within LOOK_WINDOW_MS of it — then every finger
 * does, which touchInput reads as free-look. `firing` (FIRE held, by hand or
 * auto-fire) closes the gate and drops the pair: the guns are blocked while
 * looking. If the aiming finger lifts, the survivor takes over (touchInput
 * re-baselines it, so the aim never jumps).
 */
export function gateLook(
  g: LookGate,
  touches: readonly TouchPoint[],
  now: number,
  firing: boolean,
): { gate: LookGate; touches: readonly TouchPoint[] } {
  const primary = touches.find((t) => t.id === g.primary) ?? touches[0];
  if (!primary) return { gate: createLookGate(), touches };
  if (touches.length < 2) {
    return {
      gate: { primary: primary.id, pair: null, missed: false, open: false },
      touches,
    };
  }
  const aiming = [primary];
  if (firing) {
    return {
      gate: { primary: primary.id, pair: null, missed: true, open: false },
      touches: aiming,
    };
  }
  if (g.open) return { gate: { ...g, primary: primary.id }, touches };
  if (g.missed) return { gate: { ...g, primary: primary.id }, touches: aiming };
  let pair = g.pair;
  if (!pair) {
    const second = touches.find((t) => t.id !== primary.id) as TouchPoint;
    pair = { at: now, a: { ...primary }, b: { ...second } };
  }
  const { a, b } = pair;
  const pa = touches.find((t) => t.id === a.id);
  const pb = touches.find((t) => t.id === b.id);
  if (!pa || !pb || now - pair.at > LOOK_WINDOW_MS) {
    return {
      gate: { primary: primary.id, pair: null, missed: true, open: false },
      touches: aiming,
    };
  }
  if (travelled(a, pa) && travelled(b, pb)) {
    return {
      gate: { primary: primary.id, pair: null, missed: false, open: true },
      touches,
    };
  }
  return {
    gate: { primary: primary.id, pair, missed: false, open: false },
    touches: aiming,
  };
}

// --- Button hit-slop (M8) -------------------------------------------------

/** A touch landing this close to a control, px, is a missed press — never
 * an aim finger. */
export const BUTTON_SLOP_PX = 24;

/** The slice of DOMRect the slop reads. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Whether (x, y) is within `slop` px of any rect; empty (hidden) rects
 * never count. */
export function nearControl(
  x: number,
  y: number,
  rects: Iterable<Rect>,
  slop: number,
): boolean {
  for (const r of rects) {
    if (r.right <= r.left || r.bottom <= r.top) continue;
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    if (Math.hypot(dx, dy) <= slop) return true;
  }
  return false;
}

/** Classic stick's spring-back time constant once the thumb lifts, s. */
const CLASSIC_SPRING_S = 0.12;
/** Within this of centre, px, the spring has landed. */
const SPRING_DONE_PX = 0.5;

/**
 * Classic mode, no aim finger: the stick (the aim point) springs back to
 * the viewport's centre, like a sprung stick — a lifted thumb never leaves
 * a turn held. Returns `s` itself once centred, so a resting stick costs
 * nothing per frame.
 */
export function springBack(
  s: TouchAimState,
  v: Viewport,
  dt: number,
): TouchAimState {
  const cx = v.w / 2;
  const cy = v.h / 2;
  if (s.aimX === cx && s.aimY === cy) return s;
  const k = Math.exp(-dt / CLASSIC_SPRING_S);
  let aimX = cx + (s.aimX - cx) * k;
  let aimY = cy + (s.aimY - cy) * k;
  if (Math.hypot(aimX - cx, aimY - cy) < SPRING_DONE_PX) {
    aimX = cx;
    aimY = cy;
  }
  return { ...s, aimX, aimY };
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
  saveSensitivity(next, target);
  return next;
}

/** Persist a step (the M6 settings panel picks one directly); off-step
 * values are ignored. */
export function saveSensitivity(
  value: number,
  target: Pick<Window, "localStorage">,
): void {
  if (!(SENSITIVITY_STEPS as readonly number[]).includes(value)) return;
  try {
    target.localStorage.setItem(SENSITIVITY_STORAGE, String(value));
  } catch {
    // Private mode / blocked storage: the step still applies this visit.
  }
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
