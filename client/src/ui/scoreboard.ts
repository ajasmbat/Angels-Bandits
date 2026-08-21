// Tab-held scoreboard (PLAN.md UI): name, kills, deaths, sorted by kills.
// State is whatever the server last said (welcome scores + score events) —
// the client never counts kills itself.

import type { RosterEntry, ScoreEntry } from "@angels-bandits/common/protocol";

interface Row {
  name: string;
  kills: number;
  deaths: number;
}

export class Scoreboard {
  private readonly panel = document.getElementById(
    "scoreboard",
  ) as HTMLDivElement;
  private readonly rowsEl = document.getElementById(
    "scoreboard-rows",
  ) as HTMLTableSectionElement;
  private readonly rows = new Map<string, Row>();
  private dirty = true;

  constructor(
    private readonly selfId: string,
    target: Window = window,
  ) {
    target.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.code === "Tab") {
        e.preventDefault(); // don't tab focus around the page
        this.setOpen(true);
      }
    });
    target.addEventListener("keyup", (e: KeyboardEvent) => {
      if (e.code === "Tab") this.setOpen(false);
    });
    target.addEventListener("blur", () => this.setOpen(false));
  }

  setRoster(roster: RosterEntry[]): void {
    for (const { id, name } of roster) this.upsert(id).name = name;
    this.dirty = true;
  }

  playerJoined({ id, name }: RosterEntry): void {
    this.upsert(id).name = name;
    this.dirty = true;
  }

  playerLeft(id: string): void {
    this.rows.delete(id);
    this.dirty = true;
  }

  /** Apply a server scoreboard (welcome or a score broadcast). */
  setScores(scores: ScoreEntry[]): void {
    for (const { id, kills, deaths } of scores) {
      const row = this.upsert(id);
      row.kills = kills;
      row.deaths = deaths;
    }
    this.dirty = true;
  }

  private upsert(id: string): Row {
    let row = this.rows.get(id);
    if (!row) {
      row = { name: "???", kills: 0, deaths: 0 };
      this.rows.set(id, row);
    }
    return row;
  }

  private setOpen(open: boolean): void {
    if (open && this.dirty) this.render();
    this.panel.classList.toggle("open", open);
  }

  private render(): void {
    const sorted = [...this.rows.entries()].sort(
      ([, a], [, b]) => b.kills - a.kills || a.deaths - b.deaths,
    );
    this.rowsEl.replaceChildren(
      ...sorted.map(([id, row]) => {
        const tr = document.createElement("tr");
        if (id === this.selfId) tr.className = "self";
        for (const text of [row.name, `${row.kills}`, `${row.deaths}`]) {
          const td = document.createElement("td");
          td.textContent = text;
          tr.append(td);
        }
        return tr;
      }),
    );
    this.dirty = false;
  }
}
