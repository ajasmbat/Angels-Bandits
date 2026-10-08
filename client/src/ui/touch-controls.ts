// Touch controls (M1, Mobile Playable) — the thin DOM adapter over
// game/touch-input.ts. The thumbs drive the SAME seams the mouse and
// keyboard do: the aim point is FlightInputSource's cursor, FIRE is the
// guns' trigger, BOOST is the SPACE edge, ZOOM is the right button, two
// fingers are the E free-look. No parallel flight path. Built only on a
// touch device (main.ts, via M2's whenTouch); chrome lives in index.html.
// M7: in the instructor mode the thumb steers a direction anchored in the
// world (game/touch-aim-dir.ts), projected onto the cursor each frame by
// steer() — lifting leaves it where it is in the world, so the plane settles
// onto it and flies straight, and recentring puts it on the gun line (the
// pipper), never screen centre. In classic mode (where the point is the
// stick) a lifted thumb springs the stick back to centre. One small icon, the
// scoreboard: aim mode and sensitivity are settings-screen only (M9), so a
// stray tap mid-fight can't flip them.

import type { FlightState } from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import type { BoostKey } from "../game/boost-key";
import type { AimMode, FlightInputSource } from "../game/flight-input";
import type { Guns } from "../game/guns";
import { cursorRay } from "../game/instructor";
import {
  aimDirFromRay,
  aimDirNdc,
  aimFriction,
  createAimDir,
  dragAimDir,
  recentreAimDir,
  stepAimDir,
} from "../game/touch-aim-dir";
import {
  BUTTON_SLOP_PX,
  type LookGate,
  type TouchAimState,
  type TouchPoint,
  createLookGate,
  createTouchAim,
  gateLook,
  loadSensitivity,
  nearControl,
  saveSensitivity,
  speedSlider,
  springBack,
  throttleCommand,
  touchInput,
} from "../game/touch-input";
import type { Scoreboard } from "./scoreboard";

/** Touches starting left of this share of the width never aim (the left
 * thumb's side: throttle, FIRE, BOOST). */
const AIM_ZONE_LEFT = 0.4;
/** Controls a touch landing near never aims (M8 hit-slop): the touch
 * buttons and icons, the settings gear, the fullscreen icon and chips, the
 * minimap. */
const CONTROL_SELECTOR =
  "#touch-ui .tc, #settings-btn, #fs-btn, #fs-chips button, #minimap";
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
  enabled: () => boolean,
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
      if (!enabled()) return;
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

export class TouchControls {
  private aim: TouchAimState;
  /** M8: a second finger only free-looks after a deliberate drag. */
  private gate: LookGate = createLookGate();
  /** The instructor mode's world-anchored aim (M7). */
  private readonly dir = createAimDir();
  /** Put `dir` on the gun line at the next steer() (it needs the plane). */
  private recentrePending = true;
  /** A touch took the aim over from a mouse: seed `dir` from its cursor. */
  private pickupPending = false;
  private readonly ndc = { x: 0, y: 0 };
  /** The lead reticle, screen px, as last drawn (M8 aim friction). */
  private readonly reticle = { x: 0, y: 0 };
  private reticleShown = false;
  /** Reused viewport for the per-frame classic spring (no allocation). */
  private readonly view = { w: 0, h: 0 };
  private aimModeSeen: AimMode;
  private sensitivity = loadSensitivity(window);
  /** Throttle finger's slider value 0..1, null while no finger holds it. */
  private slider: number | null = null;
  private sliderId: number | null = null;
  private zoomLatched = false;
  private zoomDownAt = 0;
  private zoomWasLatched = false;
  private wasAlive = true;
  /** M6: the settings panel is open — every control is released and every
   * handler ignores new touches until it closes. */
  private suspended = false;
  /** Last-written knob position: the frame loop only touches the DOM when
   * it changes. */
  private knobCss = "";
  private readonly root = byId("touch-ui");
  private readonly throttle = byId("touch-throttle");
  private readonly knob = byId("touch-knob");
  private readonly releases: Array<() => void> = [];

  constructor(private readonly t: TouchTargets) {
    this.aim = createTouchAim(this.viewport());
    this.aimModeSeen = t.input.aimMode();
    this.bindAimLayer(byId("touch-layer"));
    this.bindSlider(this.throttle);
    const live = () => !this.suspended;
    this.releases.push(
      holdButton(byId("touch-fire"), (down) => t.guns.setTrigger(down), live),
      holdButton(byId("touch-boost"), (down) => t.boostKey.setHeld(down), live),
      holdButton(
        byId("touch-zoom"),
        (down, at) => this.zoomPress(down, at),
        live,
      ),
    );
    t.scoreboard.bindTapToggle(byId("touch-score"));

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
    // Released (or dead): null, and the auto throttle rides it back to full.
    this.t.input.setTouchThrottle(
      alive && this.slider !== null
        ? throttleCommand(this.slider, targetSpeed, dt)
        : null,
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
    const mode = this.t.input.aimMode();
    if (mode !== this.aimModeSeen) {
      // A mode switch starts on a centred aim, like a fresh instructor.
      this.aimModeSeen = mode;
      this.recentre();
    }
    if (
      mode === "classic" &&
      this.aim.fingers.length === 0 &&
      this.t.input.touchOwnsCursor()
    ) {
      // The thumb lifted: the stick springs back (never a mouse's cursor).
      this.view.w = window.innerWidth;
      this.view.h = window.innerHeight;
      const s = springBack(this.aim, this.view, dt);
      if (s !== this.aim) {
        this.aim = s;
        this.t.input.setTouchAim(s.aimX, s.aimY);
      }
    }
  }

  /**
   * Instructor mode, alive, once a frame BEFORE the instructor reads the
   * cursor: project the world-anchored aim through `frame`/`fovDeg` — the
   * very view (ChaseCamera.aimFrame, un-orbited) the instructor reads this
   * frame — and set the cursor to it. Returns whether it did: false while a
   * hybrid laptop's mouse owns the cursor (it moved since the last touch).
   */
  steer(
    flight: FlightState,
    frame: { eye: Vec3; at: Vec3 },
    fovDeg: number,
    aspect: number,
    dt: number,
  ): boolean {
    let claim = false;
    if (this.recentrePending) {
      recentreAimDir(this.dir, flight);
      this.recentrePending = false;
      this.pickupPending = false;
      claim = true;
    } else if (this.pickupPending) {
      const c = this.t.input.cursorNdc();
      const ray = cursorRay(frame.eye, frame.at, fovDeg, aspect, c.x, c.y);
      aimDirFromRay(this.dir, frame.eye, ray);
      this.pickupPending = false;
      claim = true;
    }
    if (!claim && !this.t.input.touchOwnsCursor()) return false;
    stepAimDir(this.dir, flight, this.aim.fingers.length > 0, dt);
    aimDirNdc(this.dir.dir, frame, fovDeg, aspect, this.ndc);
    this.t.input.setTouchAimNdc(this.ndc.x, this.ndc.y);
    return true;
  }

  /** M6 settings panel: suspend (releasing everything held — a FIRE held
   * while the phone turns upright must not keep shooting) or resume (on a
   * centred aim, like a fresh plane). */
  setSuspended(on: boolean): void {
    if (on === this.suspended) return;
    this.suspended = on;
    if (on) this.releaseAll();
    else this.recentre();
  }

  /** Once a frame, after the lead computer: where its reticle sits (null:
   * hidden, or dead) — aim drags slow down near it (M8). */
  setLeadReticle(px: { x: number; y: number } | null): void {
    this.reticleShown = px !== null;
    if (px) {
      this.reticle.x = px.x;
      this.reticle.y = px.y;
    }
  }

  /** M6 settings panel: pick a sensitivity step (persisted). */
  setSensitivity(value: number): void {
    saveSensitivity(value, window);
    this.sensitivity = value;
  }

  /** QA view (`__ab.touch`). */
  debug(): {
    fingers: number;
    looking: boolean;
    lookGate: "idle" | "judging" | "missed" | "open";
    aim: { x: number; y: number };
    aimDir: { x: number; y: number; z: number };
    touchOwnsCursor: boolean;
    slider: number | null;
    zoomLatched: boolean;
    sensitivity: number;
  } {
    return {
      fingers: this.aim.fingers.length,
      looking: this.aim.looking,
      lookGate: this.gate.open
        ? "open"
        : this.gate.missed
          ? "missed"
          : this.gate.pair
            ? "judging"
            : "idle",
      aim: { x: this.aim.aimX, y: this.aim.aimY },
      aimDir: { ...this.dir.dir },
      touchOwnsCursor: this.t.input.touchOwnsCursor(),
      slider: this.slider,
      zoomLatched: this.zoomLatched,
      sensitivity: this.sensitivity,
    };
  }

  private viewport(): { w: number; h: number } {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  private bindAimLayer(el: HTMLElement): void {
    // Which fingers aim is decided at touchstart, by where they land: right
    // of the left thumb's side, and not a near-miss on a control (M8).
    const aimers = new Set<number>();
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(CONTROL_SELECTOR),
    );
    const update = (e: TouchEvent) => {
      e.preventDefault(); // no emulated mouse, no click, no scroll/zoom
      if (this.suspended) return;
      const v = this.viewport();
      if (e.type === "touchstart") {
        // Measured per touchstart, so a resize or the dead layout is never
        // stale.
        const rects = controls.map((c) => c.getBoundingClientRect());
        for (const t of Array.from(e.changedTouches)) {
          if (
            t.clientX >= v.w * AIM_ZONE_LEFT &&
            !nearControl(t.clientX, t.clientY, rects, BUTTON_SLOP_PX)
          ) {
            aimers.add(t.identifier);
          }
        }
      } else if (e.type !== "touchmove") {
        for (const t of Array.from(e.changedTouches)) {
          aimers.delete(t.identifier);
        }
      }
      const touches = points(e.targetTouches).filter((p) => aimers.has(p.id));
      this.step(touches, e.timeStamp);
    };
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      el.addEventListener(type, update as EventListener, { passive: false });
    }
    this.releases.push(() => {
      aimers.clear();
      this.step([], performance.now());
    });
  }

  /** Run the pure mapping and hand its results to the input seams. `now`
   * is the event's timeStamp (the look gate's clock). */
  private step(all: TouchPoint[], now: number): void {
    const gated = gateLook(this.gate, all, now, this.t.guns.firing);
    this.gate = gated.gate;
    const touches = gated.touches;
    let s = this.aim;
    if (s.fingers.length === 0 && touches.length > 0) {
      // Pick up wherever the cursor is (a hybrid laptop's mouse may have
      // moved it), so the first touch never jumps the aim. The RAW point:
      // the smoothed one lags by whole frames on a slow phone.
      const c = this.t.input.pointerPx();
      if (c) s = { ...s, aimX: c.x, aimY: c.y };
      // The instructor's direction picks up the mouse's cursor the same way
      // (steer() has the view to do it in).
      if (!this.t.input.touchOwnsCursor()) this.pickupPending = true;
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
    if (this.t.input.aimMode() === "instructor") {
      // The drag turns the world-anchored direction; steer() projects it.
      // Near the lead reticle it turns slower (M8 aim friction).
      const friction = aimFriction(
        this.t.input.cursorPx(),
        this.reticleShown ? this.reticle : null,
      );
      dragAimDir(this.dir, s.aimDx, s.aimDy, this.sensitivity * friction);
    } else if (touches.length > 0) {
      this.t.input.setTouchAim(s.aimX, s.aimY);
    }
    if (s.aimDx !== 0 || s.aimDy !== 0) s = { ...s, aimDx: 0, aimDy: 0 };
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
        if (this.suspended || this.sliderId !== null) return;
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

  /** A centred aim: the direction onto the gun line (at the next steer()),
   * the classic stick to screen centre. */
  private recentre(): void {
    const v = this.viewport();
    this.aim = { ...this.aim, aimX: v.w / 2, aimY: v.h / 2 };
    this.recentrePending = true;
    if (this.t.input.aimMode() === "classic") {
      this.t.input.setTouchAim(v.w / 2, v.h / 2);
    }
  }
}
