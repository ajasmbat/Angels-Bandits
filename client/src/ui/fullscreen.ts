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
  addEventListener?: (type: string, listener: () => void) => void;
}

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
    const root = doc.documentElement;
    if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else root.webkitRequestFullscreen?.();
  }
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

/** The extra document surface the button wiring needs (still mockable). */
export interface FullscreenUiDoc extends FullscreenDoc {
  body?: { classList: { toggle: (name: string, on: boolean) => void } };
  getElementById?: (id: string) => {
    hidden: boolean;
    addEventListener: (
      type: string,
      listener: (ev: { stopPropagation: () => void }) => void,
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
 * is unsupported; `body.fullscreen` (the icon's exit state, CSS) follows the
 * change events so Esc-exit stays truthful. */
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
    return;
  }
  const swallow = (ev: { stopPropagation: () => void }) => ev.stopPropagation();
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
