// Kill feed (PLAN.md UI): top-right "A ▸ B" entries fed by server death
// events, fading out after ~6 s. DOM-only, like the rest of client/src/ui.

const ENTRY_LIFE_MS = 6000;
const FADE_MS = 1000;
const MAX_ENTRIES = 6;

export class KillFeed {
  private readonly root = document.getElementById("killfeed") as HTMLDivElement;

  /** `killerName` null = un-credited crash ("☠ B"); a credited crash is
   * "A ✕ B" — not the shoot-down's "A ▸ B" (U2); a storm kill renders as the
   * bolt's own line ("⚡ took down B") whoever got the credit, and an X1
   * missile kill its own ("🚀 missile strike took down B"). `self` marks
   * a line the local pilot is in (decided by id — names aren't unique). */
  add(
    killerName: string | null,
    victimName: string,
    cause?: "shot" | "crash" | "storm" | "missile",
    self = false,
  ): void {
    const entry = document.createElement("div");
    entry.className = self ? "entry self" : "entry";

    const victim = document.createElement("span");
    victim.className = "victim";
    victim.textContent = victimName;

    if (cause === "storm") {
      entry.append("⚡ took down ", victim);
    } else if (cause === "missile") {
      entry.append("🚀 missile strike took down ", victim);
    } else if (killerName === null) {
      entry.append("☠ ", victim);
    } else {
      const killer = document.createElement("span");
      killer.className = "killer";
      killer.textContent = killerName;
      if (cause === "crash") {
        const glyph = document.createElement("span");
        glyph.className = "crash";
        glyph.title = "crashed — credited kill";
        glyph.textContent = " ✕ ";
        entry.append(killer, glyph, victim);
      } else {
        entry.append(killer, " ▸ ", victim);
      }
    }

    this.root.append(entry);
    while (this.root.children.length > MAX_ENTRIES) {
      this.root.firstElementChild?.remove();
    }
    setTimeout(() => entry.classList.add("fading"), ENTRY_LIFE_MS);
    setTimeout(() => entry.remove(), ENTRY_LIFE_MS + FADE_MS);
  }
}
