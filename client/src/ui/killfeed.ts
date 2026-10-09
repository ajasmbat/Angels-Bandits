// Kill feed (PLAN.md UI): top-right "A ▸ B" entries fed by server death
// events, fading out after ~6 s. DOM-only, like the rest of client/src/ui.

const ENTRY_LIFE_MS = 6000;
const FADE_MS = 1000;
const MAX_ENTRIES = 6;

export class KillFeed {
  private readonly root = document.getElementById("killfeed") as HTMLDivElement;

  /** `killerName` null = un-credited crash ("☠ B"); a credited crash is
   * "A ✕ B" — not the shoot-down's "A ▸ B" (U2); a storm kill renders as the
   * bolt's own line ("⚡ took down B") whoever got the credit; a D4 wreck
   * kill is "A 🔥 B" — A shot down the wreck B flew into. `self` marks
   * a line the local pilot is in (decided by id — names aren't unique).
   * `victimId` tags the line so the kill's S7 medals can join it. */
  add(
    killerName: string | null,
    victimName: string,
    cause?: "shot" | "crash" | "storm" | "wreck",
    self = false,
    victimId?: string,
  ): void {
    const entry = document.createElement("div");
    entry.className = self ? "entry self" : "entry";
    if (victimId !== undefined) entry.dataset.victim = victimId;

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
      if (cause === "wreck") {
        const glyph = document.createElement("span");
        glyph.className = "crash";
        glyph.title = "flew into a wreck — credited to its shooter";
        glyph.textContent = " 🔥 ";
        entry.append(killer, glyph, victim);
      } else if (cause === "crash") {
        const glyph = document.createElement("span");
        glyph.className = "crash";
        glyph.title = "crashed — credited kill";
        glyph.textContent = " ✕ ";
        entry.append(killer, glyph, victim);
      } else {
        entry.append(killer, " ▸ ", victim);
      }
    }

    this.push(entry);
  }

  /**
   * S7: a kill's medals, as badges on that kill's own line (the newest one
   * for `victimId`) — a medal never costs a real kill its slot in the feed.
   * A line already aged out takes nothing: the toast and the radio carry it.
   */
  addMedals(victimId: string, labels: readonly string[]): void {
    if (labels.length === 0) return;
    const lines = this.root.querySelectorAll<HTMLDivElement>(".entry");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line?.dataset.victim !== victimId) continue;
      for (const label of labels) {
        const badge = document.createElement("span");
        badge.className = "medal";
        badge.textContent = label;
        line.append(badge);
      }
      return;
    }
  }

  /** S7: a pilot crossed a kill-streak tier — its own line. */
  addStreak(name: string, tier: number, self = false): void {
    const entry = document.createElement("div");
    entry.className = `entry streak streak-${tier}${self ? " self" : ""}`;
    const pilot = document.createElement("span");
    pilot.className = "killer";
    pilot.textContent = name;
    entry.append(pilot, ` ★ ${tier} KILL STREAK`);
    this.push(entry);
  }

  private push(entry: HTMLDivElement): void {
    this.root.append(entry);
    while (this.root.children.length > MAX_ENTRIES) {
      this.root.firstElementChild?.remove();
    }
    setTimeout(() => entry.classList.add("fading"), ENTRY_LIFE_MS);
    setTimeout(() => entry.remove(), ENTRY_LIFE_MS + FADE_MS);
  }
}
