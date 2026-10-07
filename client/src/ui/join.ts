// Name-entry overlay (PLAN.md: join via link, pick a name, spawn). The markup
// and styling live in index.html with the rest of the chrome; this module
// shows the overlay, resolves with the chosen name, and remembers it.

import { NAME_MAX_LENGTH } from "@angels-bandits/common/constants";

const STORAGE_KEY = "ab:name";
/** One-shot (M2): set by the signal-lost card right before it reloads, so
 * the rejoin is one tap — the remembered name flies straight back in. */
const REJOIN_KEY = "ab:rejoin";

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

/** Show the join overlay and resolve with the pilot's name once they enter. */
export function requestName(): Promise<string> {
  const overlay = document.getElementById("join") as HTMLDivElement;
  const form = document.getElementById("join-form") as HTMLFormElement;
  const input = document.getElementById("join-name") as HTMLInputElement;

  input.maxLength = NAME_MAX_LENGTH;
  input.value = localStorage.getItem(STORAGE_KEY) ?? "";
  const remembered = input.value.trim();
  if (takeRejoin() && remembered) return Promise.resolve(remembered);
  overlay.classList.add("open");
  input.focus();
  input.select();

  return new Promise((resolve) => {
    form.addEventListener(
      "submit",
      (ev) => {
        ev.preventDefault();
        const name = input.value.trim().slice(0, NAME_MAX_LENGTH) || "Pilot";
        localStorage.setItem(STORAGE_KEY, name);
        overlay.classList.remove("open");
        resolve(name);
      },
      { once: true },
    );
  });
}

/** Swap the overlay's copy into an error state (server unreachable). */
export function showJoinError(message: string): void {
  const overlay = document.getElementById("join") as HTMLDivElement;
  const status = document.getElementById("join-status") as HTMLParagraphElement;
  status.textContent = message;
  overlay.classList.add("open");
}

/** Back from the background to a dead socket (the server's liveness sweep
 * drops a tab that stopped posing) or a lost GL context (M2): the game
 * can't recover in place, so one tap reloads and rejoins under the same
 * name. Idempotent. */
export function showSignalLost(): void {
  const card = document.getElementById("signal-lost") as HTMLDivElement;
  if (card.classList.contains("open")) return;
  card.classList.add("open");
  card.addEventListener(
    "click",
    () => {
      try {
        sessionStorage.setItem(REJOIN_KEY, "1");
      } catch {
        // Storage blocked: the reload just shows the join card as usual.
      }
      location.reload();
    },
    { once: true },
  );
}
