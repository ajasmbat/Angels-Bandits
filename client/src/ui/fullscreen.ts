// Fullscreen toggle (HUD button + F key). Real Fullscreen API only — the
// standard entry points with the webkit-prefixed fallbacks older Safari
// ships; no CSS-fake fullscreen. Everything takes a document-like object
// (defaulting to the real one) so the seam is testable in a node env, same
// injectable-target idiom as Scoreboard's `target: Window`.

/** The slice of Document (+ webkit prefixes) the fullscreen seam touches. */
export interface FullscreenDoc {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: unknown;
  webkitFullscreenElement?: unknown;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
  documentElement: {
    requestFullscreen?: () => Promise<void>;
    webkitRequestFullscreen?: () => void;
  };
  addEventListener?: (
    type: string,
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
}

/** The webkit entry point returns nothing; give up on its change event after
 * this long (a denied request fires none). */
const WEBKIT_ENTER_TIMEOUT_MS = 1000;

/** False on iPhones (no fullscreen API at all) — callers hide the UI. */
export function isFullscreenSupported(
  doc: FullscreenDoc = document as FullscreenDoc,
): boolean {
  return Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}

/** Truthful current state — the browser owns it (Esc exits behind our back). */
export function isFullscreen(
  doc: FullscreenDoc = document as FullscreenDoc,
): boolean {
  return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

/** Request fullscreen; settles when the browser has answered. Rejects where
 * unsupported or denied — every caller must catch. Must run inside a user
 * gesture (M5's JOIN tap and re-enter pill, the toggle's button/F key). */
export function enterFullscreen(
  doc: FullscreenDoc = document as FullscreenDoc,
): Promise<void> {
  const root = doc.documentElement;
  if (!isFullscreenSupported(doc)) {
    return Promise.reject(new Error("fullscreen unsupported"));
  }
  if (root.requestFullscreen) return root.requestFullscreen();
  if (!root.webkitRequestFullscreen) {
    return Promise.reject(new Error("fullscreen unsupported"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("fullscreen denied")),
      WEBKIT_ENTER_TIMEOUT_MS,
    );
    doc.addEventListener?.(
      "webkitfullscreenchange",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    root.webkitRequestFullscreen?.();
  });
}

/** One toggle for both triggers (button click, F key). No-op if unsupported;
 * the request promise may still reject (browser denies) — state stays truthful
 * because the icon follows fullscreenchange, never this call. */
export function toggleFullscreen(
  doc: FullscreenDoc = document as FullscreenDoc,
): void {
  if (!isFullscreenSupported(doc)) return;
  if (isFullscreen(doc)) {
    if (doc.exitFullscreen) doc.exitFullscreen().catch(() => {});
    else doc.webkitExitFullscreen?.();
  } else {
    enterFullscreen(doc).catch(() => {});
  }
}

/** Launched from the home screen (installed PWA, or iOS's navigator flag). */
export function isStandalone(win: Window = window): boolean {
  return (
    win.matchMedia("(display-mode: fullscreen), (display-mode: standalone)")
      .matches ||
    (win.navigator as { standalone?: boolean }).standalone === true
  );
}

/** Report the truthful state on every change event (standard + webkit) —
 * icon state hangs off this, never off which button was clicked. */
export function watchFullscreen(
  onChange: (fullscreen: boolean) => void,
  doc: FullscreenDoc = document as FullscreenDoc,
): void {
  const report = () => onChange(isFullscreen(doc));
  doc.addEventListener?.("fullscreenchange", report);
  doc.addEventListener?.("webkitfullscreenchange", report);
}

/** The mouse-event surface the trigger swallow reads. */
export interface SwallowableEvent {
  /** Which button; absent in the synthetic events the tests fire. */
  button?: number;
  stopPropagation: () => void;
}

/** The extra document surface the button wiring needs (still mockable). */
export interface FullscreenUiDoc extends FullscreenDoc {
  body?: { classList: { toggle: (name: string, on: boolean) => void } };
  getElementById?: (id: string) => {
    hidden: boolean;
    addEventListener: (
      type: string,
      listener: (ev: SwallowableEvent) => void,
    ) => void;
  } | null;
}

/** Keydown shape the F binding reads — target tag gates out the name input. */
export interface FullscreenKeyEvent {
  code: string;
  repeat?: boolean;
  target?: { tagName?: string } | null;
}

/** Wire the HUD + join-overlay buttons and the F key (chrome lives in
 * index.html). Hides the buttons — and leaves F unbound — where fullscreen
 * is unsupported (showing the add-to-home-screen hint instead);
 * `body.fullscreen` (the icon's exit state, CSS) follows the change events
 * so Esc-exit stays truthful. */
export function initFullscreenUi(
  doc: FullscreenUiDoc = document as FullscreenUiDoc,
  win:
    | {
        addEventListener: (
          type: string,
          listener: (ev: FullscreenKeyEvent) => void,
        ) => void;
        // Lazy default: tests run in a node env where `window` doesn't exist.
      }
    | undefined = typeof window === "undefined" ? undefined : window,
): void {
  const buttons = [
    doc.getElementById?.("fs-btn"),
    doc.getElementById?.("join-fs"),
  ];
  if (!isFullscreenSupported(doc)) {
    for (const btn of buttons) if (btn) btn.hidden = true;
    // iPhone (M2): pages can't go fullscreen there, home-screen apps can —
    // point at that instead, unless this already is the home-screen app.
    const hint = doc.getElementById?.("pwa-hint");
    if (hint && typeof window !== "undefined" && !isStandalone(window)) {
      hint.hidden = false;
    }
    return;
  }
  // Button 2 is the aim zoom (ANGE-G9CPCV), which also listens on window —
  // let it through, or resting the cursor here silently kills the zoom.
  const swallow = (ev: SwallowableEvent) => {
    if (ev.button !== 2) ev.stopPropagation();
  };
  for (const btn of buttons) {
    btn?.addEventListener("click", () => toggleFullscreen(doc));
    // The gun trigger listens on window mousedown/mouseup — a click on the
    // button must never double as a trigger pull.
    btn?.addEventListener("mousedown", swallow);
    btn?.addEventListener("mouseup", swallow);
  }
  watchFullscreen((on) => doc.body?.classList.toggle("fullscreen", on), doc);
  win?.addEventListener("keydown", (ev) => {
    if (ev.code !== "KeyF" || ev.repeat) return;
    // Typing a name with an F in it must not fullscreen.
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    toggleFullscreen(doc);
  });
}
