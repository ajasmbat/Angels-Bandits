// Name-entry overlay (PLAN.md: join via link, pick a name, spawn). The markup
// and styling live in index.html with the rest of the chrome; this module
// shows the overlay, resolves with the chosen name, and remembers it.
//
// W1: the card is also the loading screen. It stays up after FLY showing
// CONNECTING… then LOADING CITY… until the first frame renders (main.ts
// closes it), and a join that can't reach the server ends on a RETRY.

import { NAME_MAX_LENGTH } from "@angels-bandits/common/constants";
import { readStored, writeStored } from "./storage";

const STORAGE_KEY = "ab:name";
/** One-shot (M2): set by the signal-lost card right before it reloads, so
 * the rejoin is one tap — the remembered name flies straight back in. */
const REJOIN_KEY = "ab:rejoin";
/** W2, the same one-shot shape: the session's resume token, written only
 * right before a reload (never kept mirrored — a duplicated tab would copy
 * it and take the live session over), so the reload comes back as the same
 * player with the same score. */
const RESUME_KEY = "ab:resume";

/** Read-and-clear the resume token a reload left behind, if any. */
export function takeResumeToken(): string | undefined {
  try {
    const token = sessionStorage.getItem(RESUME_KEY) ?? undefined;
    sessionStorage.removeItem(RESUME_KEY);
    return token;
  } catch {
    return undefined;
  }
}

/** Read-and-clear the rejoin flag (storage may be blocked: then no flag). */
function takeRejoin(): boolean {
  try {
    const set = sessionStorage.getItem(REJOIN_KEY) === "1";
    sessionStorage.removeItem(REJOIN_KEY);
    return set;
  } catch {
    return false;
  }
}

/** Show the join overlay and resolve with the pilot's name once they enter.
 * `onGesture` runs synchronously inside the submit (the user gesture) — M5's
 * phone fullscreen request must not wait for anything async. */
export function requestName(onGesture?: () => void): Promise<string> {
  const overlay = document.getElementById("join") as HTMLDivElement;
  const form = document.getElementById("join-form") as HTMLFormElement;
  const input = document.getElementById("join-name") as HTMLInputElement;

  input.maxLength = NAME_MAX_LENGTH;
  input.value = readStored(STORAGE_KEY) ?? "";
  const remembered = input.value.trim();
  overlay.classList.add("open");
  // Never a native submit: the card stays up as the loading screen, and a
  // second Enter must not navigate the page away mid-boot.
  form.addEventListener("submit", (ev) => ev.preventDefault());
  if (takeRejoin() && remembered) {
    setJoinStatus("CONNECTING…");
    return Promise.resolve(remembered);
  }
  input.focus();
  input.select();

  return new Promise((resolve) => {
    form.addEventListener(
      "submit",
      () => {
        // Close the on-screen keyboard first: it must not ride into
        // fullscreen over the game.
        input.blur();
        onGesture?.();
        const name = input.value.trim().slice(0, NAME_MAX_LENGTH) || "Pilot";
        writeStored(STORAGE_KEY, name);
        setJoinStatus("CONNECTING…");
        resolve(name);
      },
      { once: true },
    );
  });
}

/** Boot progress on the join card (W1): the form is spent (input and FLY
 * locked), the status line reads `text`. The card stays open. */
export function setJoinStatus(text: string): void {
  const form = document.getElementById("join-form") as HTMLFormElement;
  const input = document.getElementById("join-name") as HTMLInputElement;
  const status = document.getElementById("join-status") as HTMLParagraphElement;
  form.classList.add("busy");
  input.disabled = true;
  status.classList.remove("error");
  status.textContent = text;
}

/** setJoinStatus, then let the browser actually PAINT it before the caller
 * blocks the main thread (the city build is synchronous): two rAFs, raced
 * with a timeout so a hidden tab — no rAF at all — can't stall the boot. */
export function showJoinProgress(text: string): Promise<void> {
  setJoinStatus(text);
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });
}

/** The first frame is on screen: the loading card goes. */
export function closeJoin(): void {
  document.getElementById("join")?.classList.remove("open");
}

/** Swap the overlay's copy into an error state (server unreachable) with a
 * RETRY: a reload that rejoins under the remembered name in one tap (with
 * storage blocked the flag can't persist, so the name is typed again). */
export function showJoinError(message: string): void {
  const overlay = document.getElementById("join") as HTMLDivElement;
  const form = document.getElementById("join-form") as HTMLFormElement;
  const status = document.getElementById("join-status") as HTMLParagraphElement;
  const retry = document.getElementById("join-retry") as HTMLButtonElement;
  form.classList.add("busy");
  status.classList.add("error");
  status.textContent = message;
  retry.hidden = false;
  retry.addEventListener("click", () => rejoin(), { once: true });
  overlay.classList.add("open");
}

/** Reload straight back into a join under the same name — and, with a
 * `resumeToken` (W2), as the same player if the server still holds them. */
function rejoin(resumeToken?: string): void {
  try {
    sessionStorage.setItem(REJOIN_KEY, "1");
    if (resumeToken) sessionStorage.setItem(RESUME_KEY, resumeToken);
  } catch {
    // Storage blocked: the reload just shows the join card as usual.
  }
  location.reload();
}

/** A session that couldn't be resumed in place (W2), a page restored from
 * the back/forward cache, or a lost GL context (M2): one tap reloads and
 * rejoins under the same name, resuming through `resumeToken` when the
 * server still holds the session. Idempotent. */
export function showSignalLost(resumeToken?: string): void {
  const card = document.getElementById("signal-lost") as HTMLDivElement;
  if (card.classList.contains("open")) return;
  card.classList.add("open");
  card.addEventListener("click", () => rejoin(resumeToken), { once: true });
}
