// Mouse-aim + keyboard → FlightInput. Two aim modes, M toggles (F1):
// - instructor (default): the cursor is the aim point — this class only
//   reports the smoothed cursor, and game/instructor.ts flies the pipper
//   onto it;
// - classic: the cursor's offset from screen centre is a direct rate stick
//   (deadzone + expo, read()).
// W/S drive throttle, A/D the roll assist. The throttle lives at FULL (F5):
// with no W/S held and no finger on the touch slider the axis reads
// AUTO_THROTTLE, so the command rides back to full after any change — S
// slows only while held. F9: the mouse wheel is W/S too — each notch holds
// the key for WHEEL_HOLD_S (down = slower), so it rides back to full
// exactly like a released key. (The corner speed manager, not the throttle, is
// what slows the plane for a corner.) No pointer lock — the HUD needs
// the visible cursor. On a touch device (M1) ui/touch-controls.ts feeds the
// same state through the setTouch* seams: the thumb's aim point IS the
// cursor, so nothing downstream knows which one is steering.

import type { FlightInput } from "@angels-bandits/common/flight";
import { FREELOOK_KEY } from "./freelook";
import { emulatedMouse, watchTouches } from "./touch-input";

const DEADZONE = 0.06; // fraction of the half-window the cursor can rest in
/** Classic-stick expo: 0 = linear, 1 = pure cube. Soft centre, full edges. */
const EXPO = 0.5;
/** Cursor smoothing time constant, s — takes the twitch out of a hand. */
const CURSOR_SMOOTH_S = 0.04;
/** Once the cursor leaves the window, steering fades out over this, s. */
const PRESENCE_FADE_S = 0.25;
/** Throttle axis with nothing commanding it, −1..1 (F5): the commanded
 * speed climbs back to full at AUTO_THROTTLE × THROTTLE_RATE = 18 m/s². */
export const AUTO_THROTTLE = 0.6;
/** F9: one wheel notch holds W (up) or S (down) this long, s; a spin
 * stacks up to WHEEL_HOLD_MAX_S. A notch is a DOM_DELTA_LINE of 3 or
 * ~100 px of DOM_DELTA_PIXEL (wheelNotches). */
export const WHEEL_HOLD_S = 0.2;
export const WHEEL_HOLD_MAX_S = 1;
const WHEEL_NOTCH_PX = 100;
const WHEEL_NOTCH_LINES = 3;

/** Wheel notches in a WheelEvent's delta, + = toward the user (down):
 * slower. Pages count as many notches as the hold allows. */
export function wheelNotches(deltaY: number, deltaMode: number): number {
  if (deltaMode === 2)
    return Math.sign(deltaY) * (WHEEL_HOLD_MAX_S / WHEEL_HOLD_S);
  return deltaY / (deltaMode === 1 ? WHEEL_NOTCH_LINES : WHEEL_NOTCH_PX);
}

/** The aim-mode key, hardcoded like FREELOOK_KEY (no keybinding UI yet). */
export const AIM_MODE_KEY = "KeyM";
const AIM_MODE_STORAGE = "ab-aim-mode";

export type AimMode = "instructor" | "classic";

/** Stored mode, or the instructor when storage is absent or throws. */
function loadAimMode(target: Window): AimMode {
  try {
    return target.localStorage.getItem(AIM_MODE_STORAGE) === "classic"
      ? "classic"
      : "instructor";
  } catch {
    return "instructor";
  }
}

export class FlightInputSource {
  private rawX: number | null = null; // last clientX/Y, px (null = never moved)
  private rawY = 0;
  private mouseX = 0; // smoothed, -1..1 of the half-window, +right
  private mouseY = 0; // smoothed, -1..1 of the half-window, +down
  private inside = true; // false once the cursor leaves the window
  private presenceK = 1; // steering presence 1 → 0 after leaving
  private aimModeV: AimMode;
  private lookDx = 0; // px of mouse motion since the last takeLookDelta
  private lookDy = 0;
  private aim = false; // right button held: the aim-zoom command (ANGE-G9CPCV)
  private readonly keys = new Set<string>();
  // Touch controls (M1): all neutral on a desktop, so read() is unchanged.
  private touchThrottle: number | null = null; // slider servo, null = released
  private touchZoom = false; // ZOOM button held or latched
  private touchLook = false; // two fingers on the aim zone
  private touchAimed = false; // a touch, not a mouse, placed the cursor last
  private active = false; // the mouse moved since the last takeActivity
  /** F9 wheel throttle: seconds of W (+) or S (−) still held. */
  private wheelHold = 0;

  constructor(private readonly target: Window = window) {
    this.aimModeV = loadAimMode(target);
    watchTouches(target);
    target.addEventListener("mousemove", (e: MouseEvent) => {
      // A tap's compatibility echo would yank the cursor to the tap point.
      if (emulatedMouse(e)) return;
      // Raw pixels — normalised per frame against the CURRENT window size in
      // tick(), so a resize can never leave a stale aim behind.
      this.rawX = e.clientX;
      this.rawY = e.clientY;
      this.touchAimed = false;
      this.inside = true;
      this.presenceK = 1;
      this.active = true;
      this.lookDx += e.movementX;
      this.lookDy += e.movementY;
    });
    // Leaving the window must not mean "keep turning forever": a null
    // relatedTarget is the pointer leaving the document altogether.
    target.addEventListener("mouseout", (e: MouseEvent) => {
      if (!e.relatedTarget && !emulatedMouse(e)) this.inside = false;
    });
    target.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.code !== AIM_MODE_KEY || e.repeat) return;
      // Typing a name with an M in it must not switch modes.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      this.toggleAimMode();
    });
    target.addEventListener("keydown", (e: KeyboardEvent) =>
      this.keys.add(e.code),
    );
    target.addEventListener("keyup", (e: KeyboardEvent) =>
      this.keys.delete(e.code),
    );
    // Button 2 is the aim zoom; button 0 stays the guns' trigger (guns.ts).
    target.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button === 2 && !emulatedMouse(e)) this.aim = true;
    });
    target.addEventListener("mouseup", (e: MouseEvent) => {
      if (e.button === 2) this.aim = false;
    });
    // F9: the wheel is the throttle. Non-passive, so the page never scrolls
    // or zooms under it — except over the settings panel, which scrolls.
    target.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        const el = e.target as Element | null;
        if (el?.closest?.(".settings")) return;
        e.preventDefault();
        this.addWheel(wheelNotches(e.deltaY, e.deltaMode));
      },
      { passive: false },
    );
    // Without this the browser menu eats the hold and steals focus mid-zoom.
    target.addEventListener("contextmenu", (e: Event) => e.preventDefault());
    // A right mouseup delivered outside the window never arrives — the same
    // bug guns.ts already learned. Drop the button as well as the keys.
    target.addEventListener("blur", () => {
      this.keys.clear();
      this.aim = false;
      this.inside = false;
    });
  }

  /**
   * Advance the cursor smoothing and the presence fade. Call once per frame,
   * alive or dead, before read() — frame-rate independent.
   */
  tick(dt: number): void {
    if (this.rawX !== null) {
      // Both axes over the full window: ±1 at the left/right and top/bottom
      // edges, so a wide screen no longer saturates X a third of the way out.
      const hw = this.target.innerWidth / 2;
      const hh = this.target.innerHeight / 2;
      const x = Math.max(-1, Math.min(1, (this.rawX - hw) / hw));
      const y = Math.max(-1, Math.min(1, (this.rawY - hh) / hh));
      const blend = 1 - Math.exp(-dt / CURSOR_SMOOTH_S);
      this.mouseX += (x - this.mouseX) * blend;
      this.mouseY += (y - this.mouseY) * blend;
    }
    if (!this.inside) this.presenceK *= Math.exp(-dt / PRESENCE_FADE_S);
    // The wheel's hold runs down toward zero from either side.
    this.wheelHold =
      this.wheelHold > 0
        ? Math.max(0, this.wheelHold - dt)
        : Math.min(0, this.wheelHold + dt);
  }

  /** Wheel notches (+ = down: slower) as a held W/S, stacked to the cap. A
   * turn the other way first cancels what is left of the hold. */
  addWheel(notches: number): void {
    if (notches === 0) return;
    const add = -notches * WHEEL_HOLD_S;
    const base =
      Math.sign(add) === Math.sign(this.wheelHold) ? this.wheelHold : 0;
    this.wheelHold = Math.max(
      -WHEEL_HOLD_MAX_S,
      Math.min(WHEEL_HOLD_MAX_S, base + add),
    );
  }

  /** Whether the pilot moved the mouse since the last call; drains it (F9
   * idle). Touch reports its own (TouchControls.aiming). */
  takeActivity(): boolean {
    const a = this.active;
    this.active = false;
    return a;
  }

  /** Flip the aim mode — the M key and the touch aim-mode icon. */
  toggleAimMode(): void {
    this.setAimMode(this.aimModeV === "instructor" ? "classic" : "instructor");
  }

  /** Pick the aim mode (M6 settings panel), persisted like the toggle. */
  setAimMode(mode: AimMode): void {
    this.aimModeV = mode;
    try {
      this.target.localStorage.setItem(AIM_MODE_STORAGE, this.aimModeV);
    } catch {
      // Private mode / blocked storage: the toggle still works this visit.
    }
  }

  /** Drop every held key and the zoom button — the M6 settings panel
   * opening, where a W/S/A/D held at that moment would never see its keyup
   * reach the flight command again. */
  releaseKeys(): void {
    this.keys.clear();
    this.aim = false;
    this.wheelHold = 0;
  }

  /** Touch aim point, client px — exactly what a mousemove would report.
   * A finger on the glass is present: steering never fades under it. */
  setTouchAim(x: number, y: number): void {
    this.rawX = x;
    this.rawY = y;
    this.touchAimed = true;
    this.inside = true;
    this.presenceK = 1;
  }

  /** The instructor mode's world-anchored touch aim (M7), already projected
   * to NDC (+y up) through the view the instructor reads this frame. Sets
   * the cursor outright: the direction is smooth already, and smoothing
   * lag inside the loop would only stand the nose off it. */
  setTouchAimNdc(x: number, y: number): void {
    const hw = this.target.innerWidth / 2;
    const hh = this.target.innerHeight / 2;
    this.mouseX = Math.max(-1, Math.min(1, x));
    this.mouseY = -Math.max(-1, Math.min(1, y));
    this.setTouchAim(hw + this.mouseX * hw, hh + this.mouseY * hh);
  }

  /** Whether a touch placed the cursor last — false again once a real
   * mouse moves it (a hybrid laptop), so the touch aim never fights it. */
  touchOwnsCursor(): boolean {
    return this.touchAimed;
  }

  /** The throttle slider's command, −1..1, added to W/S; null when no
   * finger is on it (the auto throttle then takes over). */
  setTouchThrottle(v: number | null): void {
    this.touchThrottle = v;
  }

  /** The ZOOM button: the touch twin of the right button. */
  setTouchZoom(held: boolean): void {
    this.touchZoom = held;
  }

  /** Two-finger free-look: the touch twin of holding E. */
  setTouchLook(held: boolean): void {
    this.touchLook = held;
  }

  /** Two-finger drag, px in the mouse's convention (takeLookDelta drains). */
  addLookDelta(dx: number, dy: number): void {
    this.lookDx += dx;
    this.lookDy += dy;
  }

  /** Current aim mode (M toggles; persisted when storage allows). */
  aimMode(): AimMode {
    return this.aimModeV;
  }

  /** Smoothed cursor in NDC (−1..1, +x right, +y UP) — the camera's convention. */
  cursorNdc(): { x: number; y: number } {
    return { x: this.mouseX, y: -this.mouseY };
  }

  /** Raw (unsmoothed) cursor in pixels, null before any move — where a new
   * touch picks the aim up, so slow frames' smoothing lag never jumps it. */
  pointerPx(): { x: number; y: number } | null {
    return this.rawX === null ? null : { x: this.rawX, y: this.rawY };
  }

  /** Smoothed cursor in pixels, for the aim-circle HUD. */
  cursorPx(): { x: number; y: number } {
    const hw = this.target.innerWidth / 2;
    const hh = this.target.innerHeight / 2;
    return { x: hw + this.mouseX * hw, y: hh + this.mouseY * hh };
  }

  /** Steering presence 0..1: 1 while the cursor is in the window, fading to
   * 0 (neutral, attitude hold) once it leaves. Scales both modes' steering. */
  presence(): number {
    return this.presenceK;
  }

  /** Whether the free-look key is held (key-held state — no repeat events). */
  freeLookHeld(): boolean {
    return this.keys.has(FREELOOK_KEY) || this.touchLook;
  }

  /** Whether the right button is held — the raw aim-zoom command, before the
   * free-look exclusivity rule in zoom.ts decides whether it counts. */
  aimHeld(): boolean {
    return this.aim || this.touchZoom;
  }

  /** Mouse motion (px) accumulated since the last call; drains the buffer.
   * Consume every frame — free-looking or not — so stale motion never dumps
   * into the orbit as one jump when free-look engages. */
  takeLookDelta(): { dx: number; dy: number } {
    const d = { dx: this.lookDx, dy: this.lookDy };
    this.lookDx = 0;
    this.lookDy = 0;
    return d;
  }

  private axis(v: number): number {
    const a = Math.abs(v);
    if (a < DEADZONE) return 0;
    const s = Math.min(1, (a - DEADZONE) / (1 - DEADZONE));
    return Math.sign(v) * this.presenceK * ((1 - EXPO) * s + EXPO * s * s * s);
  }

  read(): FlightInput {
    const w = this.keys.has("KeyW") || this.wheelHold > 0;
    const s = this.keys.has("KeyS") || this.wheelHold < 0;
    const keys = (w ? 1 : 0) + (s ? -1 : 0);
    // Nothing on the throttle: ride back to full (F5).
    const throttle =
      !w && !s && this.touchThrottle === null
        ? AUTO_THROTTLE
        : Math.max(-1, Math.min(1, keys + (this.touchThrottle ?? 0)));
    // A rolls left (positive roll = left wing down), D rolls right.
    const roll =
      (this.keys.has("KeyA") ? 1 : 0) + (this.keys.has("KeyD") ? -1 : 0);
    return {
      turn: this.axis(this.mouseX), // cursor right of center → right turn
      pitch: this.axis(-this.mouseY), // cursor above center → pull up
      roll,
      throttle,
    };
  }
}
