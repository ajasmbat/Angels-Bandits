// Comms ticker: the always-on radio feed under the kill feed — one line per
// spoken (or would-be-spoken) radio call, `⟨BANDIT-3⟩ splash one` style.
// DOM-only, same shape as ui/killfeed.ts. Names render via textContent, so
// arbitrary player names are inert text here (the TTS name-guard lives in
// game/callouts.ts — this feed MAY show real names, the voice never does).

const LINE_LIFE_MS = 6000;
const FADE_MS = 1000;
const MAX_LINES = 3;

export class CommsTicker {
  private readonly root = document.getElementById("comms") as HTMLDivElement;

  add(speaker: string, text: string): void {
    const entry = document.createElement("div");
    entry.className = "entry";

    const who = document.createElement("span");
    who.className = "speaker";
    who.textContent = `⟨${speaker}⟩`;

    entry.append(who, ` ${text}`);
    this.root.append(entry);
    while (this.root.children.length > MAX_LINES) {
      this.root.firstElementChild?.remove();
    }
    setTimeout(() => entry.classList.add("fading"), LINE_LIFE_MS);
    setTimeout(() => entry.remove(), LINE_LIFE_MS + FADE_MS);
  }
}
