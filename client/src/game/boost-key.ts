// SPACE boost key (F2) — its own listener, the way guns.ts owns the trigger,
// so flight-input.ts (mouse aim) stays untouched. Reports key-held state and
// a once-per-press edge: a burn only ever starts on a FRESH press, so holding
// SPACE through a drained gauge or a respawn never re-fires it.

export const BOOST_KEY = "Space";

export class BoostKey {
  private held = false;
  private pressed = false; // a press edge not yet taken

  constructor(target: Window = window) {
    target.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.code !== BOOST_KEY) return;
      // Space scrolls the page and clicks a focused button — never here.
      e.preventDefault();
      if (e.repeat || this.held) return;
      this.held = true;
      this.pressed = true;
    });
    target.addEventListener("keyup", (e: KeyboardEvent) => {
      if (e.code !== BOOST_KEY) return;
      e.preventDefault(); // a focused button activates on keyup
      this.held = false;
    });
    // A keyup delivered outside the window never arrives (the guns.ts bug),
    // and a hidden tab stops the frame loop that would send the stop edge.
    const release = () => {
      this.held = false;
      this.pressed = false;
    };
    target.addEventListener("blur", release);
    target.document.addEventListener("visibilitychange", () => {
      if (target.document.hidden) release();
    });
  }

  /** Whether SPACE is down right now. */
  isHeld(): boolean {
    return this.held;
  }

  /** True once per physical press; drains the edge. Call every frame. */
  takePress(): boolean {
    const p = this.pressed;
    this.pressed = false;
    return p;
  }
}
