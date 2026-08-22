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
