// First five minutes (U3): everything that teaches the controls, and all of
// its copy in one place so it can't drift from the real controls unnoticed.
// - the controls primer on the join card (desktop or touch variant),
// - the first-life hints: aim → fire → boost (W4: three, short), one at a
//   time, each fading as soon as the player does it (or after HINT_MS),
//   never again once learned (done — remembered per hint) or once the queue
//   is through or skipped,
// - the one-time touch coach overlay on the first spawn,
// - the one-time storm-ceiling notice after the first storm death.
// No in-flight warnings (the owner removed PULL UP in #66): nothing here
// speaks up unprompted except the queue, once. The queue is pure
// (`createCoach` / `noteAction` / `stepCoach`); `Coach` is the thin DOM
// layer around it. Every flag goes through the guarded storage helper, so
// blocked storage just means the hints show again next visit.

import { STORM_KILL_ALT } from "@angels-bandits/common/constants";
import { BOOST_KEY } from "../game/boost-key";
import { AIM_MODE_KEY } from "../game/flight-input";
import { FREELOOK_KEY } from "../game/freelook";
import { readStored, writeStored } from "./storage";

/** One-time flags, same `ab:` prefix as the remembered callsign. */
export const COACH_DONE_KEY = "ab:coach-done";
export const TOUCH_COACH_KEY = "ab:touch-coach";
export const STORM_HINT_KEY = "ab:storm-hint";
/** W4: the hints already learned (done by the player), comma-separated —
 * a learned hint never shows again, even if the queue never finished. */
export const COACH_LEARNED_KEY = "ab:coach-learned";

/** A hint stays up at most this long before the next one, ms. */
export const HINT_MS = 8000;
/** Quiet between two hints (and after a respawn or a pause), ms. */
export const GAP_MS = 1500;
/** The first hint waits this long after the first frame, ms. */
const FIRST_DELAY_MS = 2000;
/** The storm notice's time on screen, ms. */
const STORM_HINT_MS = 6000;
/** Cursor travel that counts as having aimed, degrees of view. */
const AIM_DONE_DEG = 10;
/** A touch drag in the aim zone that counts as having aimed, px. */
const AIM_DRAG_PX = 24;
/** Touches starting left of this share of the width never aim (mirrors
 * touch-controls.ts: the left thumb's side). */
const AIM_ZONE_LEFT = 0.4;

/** "KeyE" → "E", "Space" → "SPACE". */
const keyName = (code: string): string =>
  code.replace(/^Key/, "").toUpperCase();

/** The join card's controls primer: [control, action] pairs. */
export function primerItems(touch: boolean): Array<[string, string]> {
  if (touch) {
    return [
      ["DRAG RIGHT SIDE", "aim"],
      ["FIRE", "shoot · auto-fire on a lock"],
      ["BOOST", "speed"],
      ["⟲ ⟳", "roll · double-tap: snap"],
      ["LEFT SLIDER", "throttle"],
      ["ZOOM", "tap: stay · hold: peek"],
      ["TWO FINGERS", "look around"],
      ["TAP MINIMAP", "scores"],
    ];
  }
  return [
    ["MOUSE", "aim"],
    ["HOLD CLICK", "fire"],
    [keyName(BOOST_KEY), "boost"],
    ["W / S", "throttle"],
    ["A / D", "roll · double-tap: snap"],
    ["RIGHT CLICK", "zoom"],
    ["ARROWS · ENTER", "keyboard: steer · fire"],
    [keyName(FREELOOK_KEY), "look around"],
    ["TAB", "scores & bots"],
    [keyName(AIM_MODE_KEY), "aim mode"],
    ["ESC", "settings"],
  ];
}

export type HintId = "aim" | "fire" | "boost";
/** W4: three tips, no more — the scores hint went (TAB / the minimap stay
 * in the controls primer behind the join card's ? icon). */
export const HINT_ORDER: readonly HintId[] = ["aim", "fire", "boost"];

/** W4: the learned-hints flag's value → the hints in it (junk ignored). */
export function parseLearned(raw: string | null): HintId[] {
  if (!raw) return [];
  return raw
    .split(",")
    .filter((id): id is HintId => (HINT_ORDER as readonly string[]).includes(id));
}

/** A hint's line, for the device it shows on. */
export function hintText(id: HintId, touch: boolean): string {
  switch (id) {
    case "aim":
      return touch ? "DRAG THE RIGHT SIDE TO AIM" : "MOVE THE MOUSE TO AIM";
    case "fire":
      return touch ? "HOLD FIRE TO SHOOT" : "HOLD LEFT CLICK TO FIRE";
    case "boost":
      return touch
        ? "HOLD BOOST FOR SPEED"
        : `HOLD ${keyName(BOOST_KEY)} TO BOOST`;
  }
}

export const STORM_HINT_TEXT = `STAY BELOW THE STORM — ${STORM_KILL_ALT} M CEILING`;

export interface CoachState {
  /** Hints still to show, in order (the one on screen is not in it). */
  queue: readonly HintId[];
  /** The hint on screen, or null. */
  showing: HintId | null;
  /** How long `showing` has been up, ms. */
  shownMs: number;
  /** Quiet left before the next hint, ms. */
  waitMs: number;
}

/** A fresh queue; `done` (the flag) means nothing left to show, and a
 * `learned` hint (W4) is left out. */
export function createCoach(
  done: boolean,
  learned: readonly HintId[] = [],
): CoachState {
  return {
    queue: done ? [] : HINT_ORDER.filter((id) => !learned.includes(id)),
    showing: null,
    shownMs: 0,
    waitMs: FIRST_DELAY_MS,
  };
}

/** Nothing on screen and nothing left to show. */
export function coachFinished(s: CoachState): boolean {
  return s.showing === null && s.queue.length === 0;
}

/** The player did `id`: its hint fades if it is up, and is dropped if it is
 * still to come (nobody needs to be told what they already did). */
export function noteAction(s: CoachState, id: HintId): CoachState {
  if (s.showing === id) {
    return { ...s, showing: null, shownMs: 0, waitMs: GAP_MS };
  }
  if (!s.queue.includes(id)) return s;
  return { ...s, queue: s.queue.filter((q) => q !== id) };
}

/** Advance by `dtMs`. Inactive (dead, hidden, settings open, the touch
 * overlay or the storm notice up), the hint on screen goes back to the front
 * of the queue — it resumes, in full, once play does. */
export function stepCoach(
  s: CoachState,
  dtMs: number,
  active: boolean,
): CoachState {
  if (!active) {
    if (s.showing === null && s.waitMs >= GAP_MS) return s;
    return {
      queue: s.showing === null ? s.queue : [s.showing, ...s.queue],
      showing: null,
      shownMs: 0,
      waitMs: Math.max(s.waitMs, GAP_MS),
    };
  }
  if (s.showing !== null) {
    const shownMs = s.shownMs + dtMs;
    if (shownMs < HINT_MS) return { ...s, shownMs };
    return { ...s, showing: null, shownMs: 0, waitMs: GAP_MS };
  }
  const next = s.queue[0];
  if (next === undefined) return s;
  if (s.waitMs > dtMs) return { ...s, waitMs: s.waitMs - dtMs };
  return { queue: s.queue.slice(1), showing: next, shownMs: 0, waitMs: 0 };
}

/** Degrees of view a cursor move of (dx, dy) NDC sweeps — the vertical FOV
 * spans 2 NDC units, the horizontal one `aspect` times wider. */
export function cursorTravelDeg(
  dx: number,
  dy: number,
  fovDeg: number,
  aspect: number,
): number {
  return Math.hypot(dx * aspect, dy) * (fovDeg / 2);
}

/** Taps and clicks on coach chrome must never reach the gun trigger, which
 * listens on window (same rule as M5's chips). */
function swallowMouse(el: HTMLElement): void {
  const swallow = (e: MouseEvent) => e.stopPropagation();
  el.addEventListener("mousedown", swallow);
  el.addEventListener("mouseup", swallow);
}

/** Fill the join card's primer for the device. */
export function renderPrimer(touch: boolean): void {
  const el = document.getElementById("join-primer");
  if (!el) return;
  el.classList.toggle("touch", touch);
  el.replaceChildren(
    ...primerItems(touch).map(([control, action]) => {
      const item = document.createElement("li");
      const key = document.createElement("b");
      key.textContent = control;
      item.append(key, ` ${action}`);
      return item;
    }),
  );
}

/** What the hint slot shows: a queued hint, the storm notice, or nothing. */
type Shown = HintId | "storm" | null;

/** The touch coach marks: element id → label, and where the label sits. */
const MARKS: Array<{ id: string; label: string; side: string }> = [
  { id: "touch-fire", label: "HOLD TO SHOOT", side: "right" },
  { id: "touch-zoom", label: "TAP: STAY ZOOMED · HOLD: PEEK", side: "left" },
  { id: "minimap", label: "TAP FOR SCORES", side: "below" },
];

export class Coach {
  private state: CoachState;
  /** W4: hints the player has done, ever (COACH_LEARNED_KEY). */
  private readonly learned: Set<HintId>;
  private finished: boolean;
  private shown: Shown = null;
  private started = false;
  /** Time since start(), ms (capped once past FIRST_DELAY_MS). */
  private sinceStartMs = 0;
  /** A storm death is waiting for its respawn to show the notice. */
  private stormPending = false;
  /** The notice was queued this session (once even with storage blocked). */
  private stormSeen = false;
  private stormMs = 0;
  /** Aim travel so far, degrees (desktop cursor). */
  private aimDeg = 0;
  private overlayOpen = false;
  /** QA: how each hint left the screen, `id:action|timeout|paused`. */
  private readonly ended: string[] = [];
  /** Last-written overlay pause (no per-frame class writes). */
  private overlayPaused = false;
  private readonly hint = document.getElementById("coach-hint") as HTMLElement;
  private readonly hintText = this.hint.querySelector(
    ".text",
  ) as HTMLSpanElement;
  private readonly skipBtn = this.hint.querySelector(
    "button",
  ) as HTMLButtonElement;
  private readonly overlay = document.getElementById(
    "touch-coach",
  ) as HTMLElement;

  constructor(private readonly touch: () => boolean) {
    this.learned = new Set(parseLearned(readStored(COACH_LEARNED_KEY)));
    this.state = createCoach(
      readStored(COACH_DONE_KEY) === "1",
      [...this.learned],
    );
    this.finished = coachFinished(this.state);
    swallowMouse(this.skipBtn);
    this.skipBtn.addEventListener("click", () => this.skip());
    window.addEventListener("resize", () => {
      if (this.overlayOpen) this.placeMarks();
    });
  }

  /** The first frame is on screen: hints may start, and a touch player
   * without the flag gets the coach overlay. "Once" is recorded the moment
   * it shows, like M5's iPhone sheet. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.touch() || readStored(TOUCH_COACH_KEY) === "1") return;
    writeStored(TOUCH_COACH_KEY, "1");
    this.overlayOpen = true;
    this.overlay.classList.add("open");
    this.placeMarks();
  }

  /** Touch: watch the aim layer for the first real aim drag — it dismisses
   * the overlay and completes the aim hint. Passive: the drag still aims. */
  bindTouchAim(layer: HTMLElement): void {
    const starts = new Map<number, { x: number; y: number }>();
    layer.addEventListener("touchstart", (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX >= window.innerWidth * AIM_ZONE_LEFT) {
          starts.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
      }
    });
    layer.addEventListener("touchmove", (e) => {
      for (const t of Array.from(e.changedTouches)) {
        const s = starts.get(t.identifier);
        if (!s) continue;
        if (Math.hypot(t.clientX - s.x, t.clientY - s.y) < AIM_DRAG_PX) {
          continue;
        }
        this.closeOverlay();
        this.note("aim");
      }
    });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) starts.delete(t.identifier);
    };
    layer.addEventListener("touchend", end);
    layer.addEventListener("touchcancel", end);
  }

  /** Desktop: the cursor moved by (dx, dy) NDC through this view. */
  noteCursor(dx: number, dy: number, fovDeg: number, aspect: number): void {
    // Not before the first hint is due: the cursor's smoothing catching up
    // to wherever FLY left the mouse is not the player aiming.
    if (this.finished || this.sinceStartMs < FIRST_DELAY_MS) return;
    if (dx === 0 && dy === 0) return;
    this.aimDeg += cursorTravelDeg(dx, dy, fovDeg, aspect);
    if (this.aimDeg >= AIM_DONE_DEG) this.note("aim");
  }

  /** The player did `id` (cheap to call every frame). */
  note(id: HintId): void {
    if (this.finished) return;
    if (!this.learned.has(id)) {
      this.learned.add(id);
      writeStored(COACH_LEARNED_KEY, [...this.learned].join(","));
    }
    if (this.state.showing === id) this.ended.push(`${id}:action`);
    this.state = noteAction(this.state, id);
  }

  /** Our own death, by the storm: the next respawn gets the notice. */
  noteStormDeath(): void {
    if (this.stormSeen || readStored(STORM_HINT_KEY) === "1") return;
    this.stormSeen = true;
    this.stormPending = true;
  }

  /**
   * Once a frame. `alive` false closes the overlay for good (a kill-cam
   * isn't the moment); `paused` (tab hidden, settings open) only holds
   * everything. DOM writes happen only when what is shown changes.
   */
  frame(dtMs: number, alive: boolean, paused: boolean): void {
    if (!this.started) return;
    if (this.sinceStartMs < FIRST_DELAY_MS) this.sinceStartMs += dtMs;
    if (!alive) this.closeOverlay();
    if (paused !== this.overlayPaused) {
      this.overlayPaused = paused;
      this.overlay.classList.toggle("paused", paused);
    }
    const live = alive && !paused;
    if (this.stormPending && live) {
      this.stormPending = false;
      this.stormMs = STORM_HINT_MS;
      writeStored(STORM_HINT_KEY, "1");
    }
    if (this.stormMs > 0) this.stormMs = live ? this.stormMs - dtMs : 0;
    if (!this.finished) {
      const was = this.state.showing;
      this.state = stepCoach(
        this.state,
        dtMs,
        live && !this.overlayOpen && this.stormMs <= 0,
      );
      if (was !== null && this.state.showing === null) {
        this.ended.push(
          `${was}:${this.state.queue[0] === was ? "paused" : "timeout"}`,
        );
      }
      if (coachFinished(this.state)) this.finish();
    }
    this.show(this.stormMs > 0 ? "storm" : this.state.showing);
  }

  /** SKIP TIPS: done with every hint and the overlay (the storm notice is
   * a safety line, and still shows once). */
  skip(): void {
    this.state = createCoach(true);
    this.finish();
    writeStored(TOUCH_COACH_KEY, "1");
    this.closeOverlay();
    if (this.shown !== "storm") this.show(null);
  }

  /** QA view (`__ab.coach`). */
  debug(): {
    shown: Shown;
    queue: readonly HintId[];
    overlay: boolean;
    ended: readonly string[];
  } {
    return {
      shown: this.shown,
      queue: this.state.queue,
      overlay: this.overlayOpen,
      ended: this.ended,
    };
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    writeStored(COACH_DONE_KEY, "1");
  }

  private show(next: Shown): void {
    if (next === this.shown) return;
    this.shown = next;
    if (next === null) {
      // The text stays for the fade-out; only the class goes.
      this.hint.classList.remove("on");
      return;
    }
    this.hintText.textContent =
      next === "storm" ? STORM_HINT_TEXT : hintText(next, this.touch());
    this.skipBtn.hidden = next === "storm";
    this.hint.classList.toggle("storm", next === "storm");
    this.hint.classList.add("on");
  }

  private closeOverlay(): void {
    if (!this.overlayOpen) return;
    this.overlayOpen = false;
    this.overlay.classList.remove("open");
  }

  /** Put each mark on its control's live rect (on open and on resize). */
  private placeMarks(): void {
    const place = (el: HTMLElement, r: DOMRect, pad: number) => {
      el.style.left = `${r.left - pad}px`;
      el.style.top = `${r.top - pad}px`;
      el.style.width = `${r.width + 2 * pad}px`;
      el.style.height = `${r.height + 2 * pad}px`;
    };
    for (const { id, label, side } of MARKS) {
      let mark = this.overlay.querySelector<HTMLElement>(`[data-for="${id}"]`);
      if (!mark) {
        mark = document.createElement("div");
        mark.className = `mark ${side}`;
        mark.dataset.for = id;
        const text = document.createElement("span");
        text.textContent = label;
        mark.append(text);
        this.overlay.append(mark);
      }
      const target = document.getElementById(id);
      if (target) place(mark, target.getBoundingClientRect(), 6);
    }
    // The aim zone: right of the left thumb's side, below the top band,
    // where the touch layer takes aim drags.
    let zone = this.overlay.querySelector<HTMLElement>(".zone");
    if (!zone) {
      zone = document.createElement("div");
      zone.className = "zone";
      const aim = document.createElement("b");
      aim.textContent = "DRAG HERE TO AIM";
      const look = document.createElement("span");
      look.textContent = "TWO FINGERS — LOOK AROUND";
      zone.append(aim, look);
      this.overlay.prepend(zone);
    }
    const band = document.getElementById("touch-throttle");
    if (band) {
      const b = band.getBoundingClientRect();
      const left = window.innerWidth * AIM_ZONE_LEFT;
      zone.style.left = `${left}px`;
      zone.style.top = `${b.top}px`;
      zone.style.width = `${window.innerWidth - left - 12}px`;
      zone.style.height = `${b.height}px`;
    }
  }
}
