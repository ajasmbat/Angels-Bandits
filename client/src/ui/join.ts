// Name-entry overlay (PLAN.md: join via link, pick a name, spawn). The markup
// and styling live in index.html with the rest of the chrome; this module
// shows the overlay, resolves with the chosen name, and remembers it.

import { NAME_MAX_LENGTH } from "@angels-bandits/common/constants";

const STORAGE_KEY = "ab:name";

/** Show the join overlay and resolve with the pilot's name once they enter. */
export function requestName(): Promise<string> {
  const overlay = document.getElementById("join") as HTMLDivElement;
  const form = document.getElementById("join-form") as HTMLFormElement;
  const input = document.getElementById("join-name") as HTMLInputElement;

  input.maxLength = NAME_MAX_LENGTH;
  input.value = localStorage.getItem(STORAGE_KEY) ?? "";
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
