// Touch controls (M1, Mobile Playable) — the thin DOM adapter over
// game/touch-input.ts. The thumbs drive the SAME seams the mouse and
// keyboard do: the aim point is FlightInputSource's cursor, FIRE is the
// guns' trigger, BOOST is the SPACE edge, ZOOM is the right button, two
// fingers are the E free-look. No parallel flight path. Built only on a
// touch device (main.ts, via M2's whenTouch); chrome lives in index.html.
// Releasing the aim finger holds the aim point, as a parked mouse does: the
// instructor keeps the nose on it, and in classic mode (where the point is
// the stick) the deflection holds. No avoidance-assist icon: main dropped
// the assist (#66), so the small icons are scoreboard, aim mode, sensitivity.

import type { BoostKey } from "../game/boost-key";
import type { FlightInputSource } from "../game/flight-input";
import type { Guns } from "../game/guns";
import {
  type TouchAimState,
  type TouchPoint,
  createTouchAim,
  loadSensitivity,
  nextSensitivity,
  speedSlider,
  throttleCommand,
  touchInput,
} from "../game/touch-input";
import type { Scoreboard } from "./scoreboard";

/** Touches starting left of this share of the width never aim (the left
 * thumb's side: throttle, FIRE, BOOST). */
const AIM_ZONE_LEFT = 0.4;
/** Free-look px per finger px: thumbs travel less than a mouse does. */
const TOUCH_LOOK_GAIN = 1.5;
/** A ZOOM press shorter than this toggles the latch; longer is a hold. */
const ZOOM_TAP_MS = 250;

export interface TouchTargets {
  input: FlightInputSource;
  guns: Guns;
  boostKey: BoostKey;
  scoreboard: Scoreboard;
}

const byId = (id: string): HTMLElement =>
  document.getElementById(id) as HTMLElement;

/** Touches → plain points (a TouchList is live; copy what we keep). */
const points = (list: Iterable<Touch>): TouchPoint[] =>
  Array.from(list, (t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));

/**
 * A press-and-hold control: down while ANY finger that started on it is
 * still down. Its own touches are cancelled so no click or emulated mouse
 * event ever leaves it. Returns the release hook.
 */
function holdButton(
  el: HTMLElement,
  onChange: (down: boolean, at: number) => void,
) {
  const fingers = new Set<number>();
  // `at` is the input's own time (Event.timeStamp, performance.now's
  // clock), not the handler's: a slow frame must not turn a tap into a hold.
  const set = (down: boolean, at = performance.now()) => {
    el.classList.toggle("on", down);
    onChange(down, at);
  };
  el.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      const was = fingers.size > 0;
      for (const t of Array.from(e.changedTouches)) fingers.add(t.identifier);
      if (!was) set(true, e.timeStamp);
    },
    { passive: false },
  );
  const up = (e: TouchEvent) => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) fingers.delete(t.identifier);
    if (fingers.size === 0) set(false, e.timeStamp);
  };
  el.addEventListener("touchend", up, { passive: false });
  el.addEventListener("touchcancel", up, { passive: false });
  return () => {
    if (fingers.size === 0) return;
    fingers.clear();
    set(false);
  };
}

/** A small HUD icon: click-based like M2's minimap, and its emulated
 * mousedown/up never reach the window (the gun trigger's rule). */
function iconButton(el: HTMLElement, onTap: () => void): void {
  const swallow = (e: MouseEvent) => e.stopPropagation();
  el.addEventListener("mousedown", swallow);
  el.addEventListener("mouseup", swallow);
  el.addEventListener("click", onTap);
}

export class TouchControls {
  private aim: TouchAimState;
  private sensitivity = loadSensitivity(window);
  /** Throttle finger's slider value 0..1, null while no finger holds it. */
  private slider: number | null = null;
  private sliderId: number | null = null;
  private zoomLatched = false;
  private zoomDownAt = 0;
  private zoomWasLatched = false;
  private wasAlive = true;
  private knobCss = ""; // last-written knob position / aim icon: the frame
  private aimGlyph = ""; // loop only touches the DOM when they change
  private readonly root = byId("touch-ui");
  private readonly throttle = byId("touch-throttle");
  private readonly knob = byId("touch-knob");
  private readonly aimIcon = byId("touch-aim-mode");
  private readonly sensIcon = byId("touch-sens");
  private readonly releases: Array<() => void> = [];

  constructor(private readonly t: TouchTargets) {
    this.aim = createTouchAim(this.viewport());
    this.bindAimLayer(byId("touch-layer"));
    this.bindSlider(this.throttle);
    this.releases.push(
      holdButton(byId("touch-fire"), (down) => t.guns.setTrigger(down)),
      holdButton(byId("touch-boost"), (down) => t.boostKey.setHeld(down)),
      holdButton(byId("touch-zoom"), (down, at) => this.zoomPress(down, at)),
    );
    t.scoreboard.bindTapToggle(byId("touch-score"));
    iconButton(this.aimIcon, () => t.input.toggleAimMode());
    iconButton(this.sensIcon, () => {
      this.sensitivity = nextSensitivity(this.sensitivity, window);
      this.paintSensitivity();
    });
    this.paintSensitivity();

    // Anything that can swallow a touchend must not leave a control stuck
    // down: the app backgrounded, a system gesture, a rotation.
    const releaseAll = () => this.releaseAll();
    window.addEventListener("blur", releaseAll);
    window.addEventListener("pagehide", releaseAll);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) releaseAll();
    });
    // Only a real layout change (rotation, split screen): an address bar
    // sliding in or out also fires resize — height only — and must never
    // drop FIRE or jerk the aim mid-fight.
    let width = window.innerWidth;
    window.addEventListener("resize", () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      this.releaseAll();
      this.recentre();
    });
  }

  /**
   * Once a frame, before input.read(): servo the throttle onto a held
   * slider (the knob shows the commanded speed otherwise), and drop the
   * zoom latch / recentre the aim around a death.
   */
  frame(targetSpeed: number, alive: boolean, dt: number): void {
    this.t.input.setTouchThrottle(
      alive ? throttleCommand(this.slider, targetSpeed, dt) : 0,
    );
    const knob = this.slider ?? speedSlider(targetSpeed);
    const knobCss = `${(knob * 100).toFixed(1)}%`;
    if (knobCss !== this.knobCss) {
      this.knobCss = knobCss;
      this.knob.style.bottom = knobCss;
    }
    if (!alive && this.zoomLatched) {
      this.zoomLatched = false;
      this.t.input.setTouchZoom(false);
    }
    if (alive !== this.wasAlive) {
      this.root.classList.toggle("dead", !alive);
      if (alive) this.recentre(); // a fresh plane starts on a centred aim
      this.wasAlive = alive;
    }
    const glyph = this.t.input.aimMode() === "instructor" ? "◎" : "✛";
    if (glyph !== this.aimGlyph) {
      this.aimGlyph = glyph;
      this.aimIcon.textContent = glyph;
    }
  }

  /** QA view (`__ab.touch`). */
  debug(): {
    fingers: number;
    looking: boolean;
    aim: { x: number; y: number };
    slider: number | null;
    zoomLatched: boolean;
    sensitivity: number;
  } {
    return {
      fingers: this.aim.fingers.length,
      looking: this.aim.looking,
      aim: { x: this.aim.aimX, y: this.aim.aimY },
      slider: this.slider,
      zoomLatched: this.zoomLatched,
      sensitivity: this.sensitivity,
    };
  }

  private viewport(): { w: number; h: number } {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  private bindAimLayer(el: HTMLElement): void {
    // Which fingers aim is decided at touchstart, by where they land.
    const aimers = new Set<number>();
    const update = (e: TouchEvent) => {
      e.preventDefault(); // no emulated mouse, no click, no scroll/zoom
      const v = this.viewport();
      if (e.type === "touchstart") {
        for (const t of Array.from(e.changedTouches)) {
          if (t.clientX >= v.w * AIM_ZONE_LEFT) aimers.add(t.identifier);
        }
      } else if (e.type !== "touchmove") {
        for (const t of Array.from(e.changedTouches)) {
          aimers.delete(t.identifier);
        }
      }
      const touches = points(e.targetTouches).filter((p) => aimers.has(p.id));
      this.step(touches);
    };
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      el.addEventListener(type, update as EventListener, { passive: false });
    }
    this.releases.push(() => {
      aimers.clear();
      this.step([]);
    });
  }

  /** Run the pure mapping and hand its results to the input seams. */
  private step(touches: TouchPoint[]): void {
    let s = this.aim;
    if (s.fingers.length === 0 && touches.length > 0) {
      // Pick up wherever the cursor is (a hybrid laptop's mouse may have
      // moved it), so the first touch never jumps the aim. The RAW point:
      // the smoothed one lags by whole frames on a slow phone.
      const c = this.t.input.pointerPx();
      if (c) s = { ...s, aimX: c.x, aimY: c.y };
    }
    s = touchInput(s, touches, this.viewport(), this.sensitivity);
    this.t.input.setTouchLook(s.looking);
    if (s.lookDx !== 0 || s.lookDy !== 0) {
      this.t.input.addLookDelta(
        s.lookDx * TOUCH_LOOK_GAIN,
        s.lookDy * TOUCH_LOOK_GAIN,
      );
      s = { ...s, lookDx: 0, lookDy: 0 };
    }
    if (touches.length > 0) this.t.input.setTouchAim(s.aimX, s.aimY);
    this.aim = s;
  }

  private bindSlider(el: HTMLElement): void {
    // The rail is the knob's travel: its ends are 0 and 1.
    const rail = byId("touch-rail");
    const read = (y: number) => {
      const r = rail.getBoundingClientRect();
      this.slider = Math.min(1, Math.max(0, (r.bottom - y) / r.height));
    };
    const find = (list: TouchList) =>
      Array.from(list).find((t) => t.identifier === this.sliderId);
    el.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        if (this.sliderId !== null) return;
        const t = e.changedTouches[0];
        if (!t) return;
        this.sliderId = t.identifier;
        el.classList.add("on");
        read(t.clientY);
      },
      { passive: false },
    );
    el.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        const t = find(e.changedTouches);
        if (t) read(t.clientY);
      },
      { passive: false },
    );
    const end = (e: TouchEvent) => {
      e.preventDefault();
      if (find(e.changedTouches)) this.releaseSlider();
    };
    el.addEventListener("touchend", end, { passive: false });
    el.addEventListener("touchcancel", end, { passive: false });
    this.releases.push(() => this.releaseSlider());
  }

  private releaseSlider(): void {
    this.sliderId = null;
    this.slider = null;
    this.throttle.classList.remove("on");
  }

  /** ZOOM: a quick tap toggles the latch, a longer press is a hold. */
  private zoomPress(down: boolean, at: number): void {
    if (down) {
      this.zoomDownAt = at;
      this.zoomWasLatched = this.zoomLatched;
      this.t.input.setTouchZoom(true);
      return;
    }
    this.zoomLatched =
      at - this.zoomDownAt < ZOOM_TAP_MS ? !this.zoomWasLatched : false;
    this.t.input.setTouchZoom(this.zoomLatched);
  }

  private releaseAll(): void {
    for (const release of this.releases) release();
    this.zoomLatched = false;
    this.t.input.setTouchZoom(false);
  }

  private recentre(): void {
    const v = this.viewport();
    this.aim = { ...this.aim, aimX: v.w / 2, aimY: v.h / 2 };
    this.t.input.setTouchAim(v.w / 2, v.h / 2);
  }

  private paintSensitivity(): void {
    this.sensIcon.textContent = `${this.sensitivity}×`;
  }
}
