// Kill feed (PLAN.md UI): top-right "A ▸ B" entries fed by server death
// events, fading out after ~6 s. DOM-only, like the rest of client/src/ui.

const ENTRY_LIFE_MS = 6000;
const FADE_MS = 1000;
const MAX_ENTRIES = 6;

export class KillFeed {
  private readonly root = document.getElementById("killfeed") as HTMLDivElement;

  /** `killerName` null = un-credited crash ("☠ B"); a storm kill renders as
   * the bolt's own line ("⚡ took down B") whoever got the credit. */
  add(
    killerName: string | null,
    victimName: string,
    cause?: "shot" | "crash" | "storm",
  ): void {
    const entry = document.createElement("div");
    entry.className = "entry";

    const victim = document.createElement("span");
    victim.className = "victim";
    victim.textContent = victimName;

    if (cause === "storm") {
      entry.append("⚡ took down ", victim);
    } else if (killerName === null) {
      entry.append("☠ ", victim);
    } else {
      const killer = document.createElement("span");
      killer.className = "killer";
      killer.textContent = killerName;
      entry.append(killer, " ▸ ", victim);
    }

    this.root.append(entry);
    while (this.root.children.length > MAX_ENTRIES) {
      this.root.firstElementChild?.remove();
    }
    setTimeout(() => entry.classList.add("fading"), ENTRY_LIFE_MS);
    setTimeout(() => entry.remove(), ENTRY_LIFE_MS + FADE_MS);
  }
}
