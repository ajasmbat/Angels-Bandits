// Phone fullscreen (M5, Mobile Playable): no fiddling on a phone. Android
// and iPad go fullscreen + landscape on the JOIN tap and get a one-tap
// re-enter pill if they drop out; iPhone (no page Fullscreen API) gets a
// one-time "Add to Home Screen" sheet, since the installed app is fullscreen
// (manifest `display: fullscreen`); an installable browser offers its install
// prompt once, after the first life. Desktop never enters any of it: `touch`
// is the coarse PRIMARY pointer, so a touchscreen laptop stays a desktop.
// The decisions are pure (`fullscreenPlan`, `installChipPlan`) and tested in
// a node env; `initPhoneFullscreen` is the thin DOM wiring around them.

import {
  enterFullscreen,
  isFullscreen,
  isFullscreenSupported,
  isStandalone,
  watchFullscreen,
} from "./fullscreen";
import { coarsePointer, lockLandscape } from "./mobile";

/** One-time flags, same `ab:` prefix as the remembered callsign. */
export const SHEET_KEY = "ab:fs-sheet";
export const INSTALL_KEY = "ab:install-offered";

/** The install chip gets out of the way on its own after this long. */
const INSTALL_CHIP_MS = 20_000;

export type FullscreenPlan = "auto" | "pill" | "ios-install-sheet" | "none";

export interface FullscreenEnv {
  /** Coarse primary pointer (a phone or tablet). */
  touch: boolean;
  /** iPhone / iPad — the only devices the Share-sheet steps describe. */
  ios: boolean;
  /** Launched from the home screen: already fullscreen. */
  standalone: boolean;
  /** The page Fullscreen API exists (false on iPhone). */
  fsApi: boolean;
  /** Fullscreen right now. */
  fsActive: boolean;
  /** The JOIN tap has happened and the game is connected. */
  joined: boolean;
  /** A fullscreen request is out and the browser hasn't answered yet. */
  inFlight: boolean;
  /** The install sheet has already been shown once. */
  sheetSeen: boolean;
}

/** What the phone should do right now; the first matching rule wins. */
export function fullscreenPlan(env: FullscreenEnv): FullscreenPlan {
  if (!env.touch || env.standalone) return "none";
  // No API: only iOS has a way out (the home screen); an Android in-app
  // webview gets nothing rather than Share-sheet steps that don't exist.
  if (!env.fsApi) {
    return env.ios && !env.sheetSeen ? "ios-install-sheet" : "none";
  }
  if (env.fsActive || env.inFlight) return "none";
  return env.joined ? "pill" : "auto";
}

export interface InstallEnv {
  touch: boolean;
  standalone: boolean;
  /** A deferred `beforeinstallprompt` is in hand. */
  hasPrompt: boolean;
  /** The player's first life has ended ("after the first match"). */
  firstLifeOver: boolean;
  /** Already offered once (persisted). */
  offered: boolean;
}

/** Whether to show the one-time install chip. */
export function installChipPlan(env: InstallEnv): boolean {
  return (
    env.touch &&
    !env.standalone &&
    env.hasPrompt &&
    env.firstLifeOver &&
    !env.offered
  );
}

/** iPhone/iPod/iPad, including iPadOS's desktop-Safari user agent. */
export function isIos(nav: {
  userAgent: string;
  maxTouchPoints?: number;
}): boolean {
  return (
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    (/Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1)
  );
}

/** The slice of Storage the flags touch. */
export interface FlagStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** Blocked storage (private mode) reads as unset — never throws. */
export function readFlag(store: FlagStore | undefined, key: string): boolean {
  try {
    return store?.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Blocked storage swallows the write — the flag just won't persist. */
export function writeFlag(store: FlagStore | undefined, key: string): void {
  try {
    store?.setItem(key, "1");
  } catch {
    // Nothing to do: the sheet may show again next visit.
  }
}

/** Chrome's install event; not in TS's DOM lib. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

export interface PhoneFullscreen {
  /** Call synchronously inside the JOIN submit handler (the user gesture). */
  onJoinGesture: () => void;
  /** The game is connected: from now on a windowed phone gets the pill. */
  onJoined: () => void;
  /** The player's first life ended: the install chip may be offered. */
  onFirstLifeOver: () => void;
}

/** `localStorage` itself can throw on access (blocked site data). */
function storage(): FlagStore | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The mouse-emulation of a tap must never reach the gun trigger, which
 * listens on window (same rule as the fullscreen buttons and M1's icons). */
function swallowMouse(el: HTMLElement): void {
  const swallow = (e: MouseEvent) => e.stopPropagation();
  el.addEventListener("mousedown", swallow);
  el.addEventListener("mouseup", swallow);
}

/** Install the phone fullscreen behaviour. Call once, after
 * `initMobileShell()` (the sheet sizes to its `--vv-h`) and before the join
 * prompt (the sheet greets the join card). */
export function initPhoneFullscreen(): PhoneFullscreen {
  const store = storage();
  const pill = document.getElementById("fs-pill") as HTMLButtonElement;
  const chip = document.getElementById("install-chip") as HTMLDivElement;
  const sheet = document.getElementById("ios-sheet") as HTMLDivElement;
  let joined = false;
  let inFlight = false;
  let firstLifeOver = false;
  let deferred: BeforeInstallPromptEvent | null = null;
  let chipTimer: ReturnType<typeof setTimeout> | undefined;

  const env = (): FullscreenEnv => ({
    touch: coarsePointer(),
    ios: isIos(navigator),
    standalone: isStandalone(),
    fsApi: isFullscreenSupported(),
    fsActive: isFullscreen(),
    joined,
    inFlight,
    sheetSeen: readFlag(store, SHEET_KEY),
  });

  // Gesture only: the JOIN tap and the pill's click are the sole callers.
  // Landscape is locked once fullscreen is granted (Chrome refuses it
  // windowed); lockLandscape is idempotent with mobile.ts's own watcher.
  const goFullscreen = () => {
    inFlight = true;
    syncPill();
    enterFullscreen()
      .then(() => lockLandscape(true))
      .catch(() => {}) // denied: the pill offers a retry
      .finally(() => {
        inFlight = false;
        syncPill();
      });
  };

  const syncPill = () => {
    pill.hidden = fullscreenPlan(env()) !== "pill";
  };
  watchFullscreen(syncPill);
  pill.addEventListener("click", goFullscreen);
  swallowMouse(pill);

  // iPhone: the one-time sheet greets the join card. "Once" is recorded the
  // moment it shows, so a reload without dismissing doesn't repeat it.
  if (fullscreenPlan(env()) === "ios-install-sheet") {
    writeFlag(store, SHEET_KEY);
    sheet.classList.add("open");
    const close = () => sheet.classList.remove("open");
    swallowMouse(sheet);
    sheet.addEventListener("click", (e) => {
      // The backdrop or GOT IT dismisses; taps on the card itself don't.
      const t = e.target as HTMLElement;
      if (t === sheet || t.closest("button")) close();
    });
  }

  // Install: keep the browser's own mini-infobar quiet and offer the prompt
  // ourselves, once, after the first life — whenever the event arrives.
  const hideChip = () => {
    chip.hidden = true;
    clearTimeout(chipTimer);
  };
  const syncChip = () => {
    const show = installChipPlan({
      touch: coarsePointer(),
      standalone: isStandalone(),
      hasPrompt: deferred !== null,
      firstLifeOver,
      offered: readFlag(store, INSTALL_KEY),
    });
    if (!show) return;
    writeFlag(store, INSTALL_KEY);
    chip.hidden = false;
    chipTimer = setTimeout(hideChip, INSTALL_CHIP_MS);
  };
  window.addEventListener("beforeinstallprompt", (e) => {
    if (!coarsePointer()) return; // desktop: the browser's own UI, unchanged
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    syncChip();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    hideChip();
  });
  swallowMouse(chip);
  chip.addEventListener("click", (e) => {
    const dismiss = (e.target as HTMLElement).closest("#install-dismiss");
    if (!dismiss) deferred?.prompt().catch(() => {});
    deferred = null; // a deferred prompt can only be used once
    hideChip();
  });

  return {
    onJoinGesture: () => {
      if (fullscreenPlan(env()) === "auto") goFullscreen();
    },
    onJoined: () => {
      joined = true;
      syncPill();
    },
    onFirstLifeOver: () => {
      if (firstLifeOver) return;
      firstLifeOver = true;
      syncChip();
    },
  };
}
