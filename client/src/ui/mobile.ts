// Mobile shell (M2, Mobile Playable): everything a phone needs AROUND the
// controls — the touch chrome switch, the browser-gesture lock, the
// on-screen-keyboard viewport, and the landscape lock. The controls
// themselves are M1's; this module is the one touch-detection seam both
// share, so `body.touch` has exactly one owner. Desktop never enters any of
// it: nothing here runs until the device is touch.

import { isStandalone, watchFullscreen } from "./fullscreen";

/** The ticket's rule: a coarse PRIMARY pointer, or the first real touch. A
 * touchscreen laptop keeps its mouse (nothing here touches mouse input); it
 * only gains the touch chrome once someone actually touches the screen. */
const TOUCH_QUERY = "(pointer: coarse)";

/** Below this share of the layout height the visual viewport is taken to be
 * squeezed by the on-screen keyboard (rotation or pinch can't shrink it:
 * zoom is locked and rotation resizes both). */
const KEYBOARD_SHARE = 0.75;

const touchListeners: Array<() => void> = [];

/** True once the touch chrome is on (`body.touch`). */
export function isTouch(): boolean {
  return document.body.classList.contains("touch");
}

/** Run `fn` when the touch chrome turns on — now, if it already is. For M1
 * (controls) and anything else that only exists on touch devices. */
export function whenTouch(fn: () => void): void {
  if (isTouch()) fn();
  else touchListeners.push(fn);
}

/** Pure: is the keyboard up, from the visual vs layout viewport heights
 * while a text field has focus? */
export function keyboardUp(
  visualHeight: number,
  layoutHeight: number,
  editing: boolean,
): boolean {
  return editing && visualHeight < layoutHeight * KEYBOARD_SHARE;
}

const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;

/** `lock()` is missing from TS's DOM lib (and from iOS); type it locally. */
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape") => Promise<void>;
};

/** Best effort: browsers only honour it fullscreen or installed, iOS never. */
function lockLandscape(on: boolean): void {
  const o = screen.orientation as LockableOrientation | undefined;
  if (!o) return;
  try {
    if (on) o.lock?.("landscape").catch(() => {});
    else o.unlock();
  } catch {
    // unlock() throws where locking was never supported — nothing to undo.
  }
}

function enableTouch(): void {
  if (isTouch()) return;
  const body = document.body;
  body.classList.add("touch");

  // Gesture lock. CSS `touch-action: none` (index.html) kills double-tap
  // zoom and panning, but iOS Safari ignores user-scalable=no and still
  // pinches, so cancel the moves themselves. Non-passive, or Chrome's
  // document-level passive default silently drops the preventDefault.
  // Never on touchstart: that would stop taps synthesising clicks.
  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.cancelable && !isEditable(e.target)) e.preventDefault();
    },
    { passive: false },
  );
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, (e) => e.preventDefault(), {
      passive: false,
    });
  }

  // On-screen keyboard: size the join card to what is actually visible, and
  // flag `body.kbd` so the card can drop its title to fit a landscape phone.
  const vv = window.visualViewport;
  if (vv) {
    const root = document.documentElement.style;
    const sync = () => {
      root.setProperty("--vv-h", `${vv.height}px`);
      root.setProperty("--vv-top", `${vv.offsetTop}px`);
      body.classList.toggle(
        "kbd",
        keyboardUp(
          vv.height,
          window.innerHeight,
          isEditable(document.activeElement),
        ),
      );
    };
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    document.addEventListener("focusin", sync);
    sync();
  }
  // iOS scrolls the page to a focused field even under overflow:hidden, and
  // leaves it there — the whole game would sit shifted up after the join.
  document.addEventListener("focusout", (e) => {
    if (isEditable(e.target)) {
      window.scrollTo(0, 0);
      body.classList.remove("kbd");
    }
  });

  // Landscape: the manifest locks an installed app; in a browser tab only
  // fullscreen may lock (Android), so follow the fullscreen state.
  if (isStandalone()) lockLandscape(true);
  watchFullscreen((on) => lockLandscape(on));

  for (const fn of touchListeners.splice(0)) fn();
}

/** Install the mobile shell. Call once, before the join prompt. */
export function initMobileShell(): void {
  if (window.matchMedia(TOUCH_QUERY).matches) enableTouch();
  else
    window.addEventListener("touchstart", enableTouch, {
      once: true,
      passive: true,
      capture: true,
    });
}
