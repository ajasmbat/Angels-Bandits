// Tab-held scoreboard (PLAN.md UI): name, kills, deaths, sorted by kills.
// State is whatever the server last said (welcome scores + score events) —
// the client never counts kills itself.

import { BOT_TARGET_MAX } from "@angels-bandits/common/constants";
import type { RosterEntry, ScoreEntry } from "@angels-bandits/common/protocol";
import type { BotBar } from "./botbar";

interface Row {
  name: string;
  kills: number;
  deaths: number;
  isBot: boolean;
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
  /** Held open while a bot-count drag is in flight: releasing Tab mid-drag
   * must not yank the surface out from under the pointer. */
  private dragging = false;
  private tabHeld = false;

  constructor(
    private readonly selfId: string,
    target: Window = window,
  ) {
    target.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.code === "Tab") {
        e.preventDefault(); // don't tab focus around the page
        this.tabHeld = true;
        this.setOpen(true);
      }
    });
    target.addEventListener("keyup", (e: KeyboardEvent) => {
      if (e.code === "Tab") {
        this.tabHeld = false;
        if (!this.dragging) this.setOpen(false);
      }
    });
    target.addEventListener("blur", () => {
      this.tabHeld = false;
      this.dragging = false;
      this.setOpen(false);
    });
  }

  /**
   * Wire the shared bot-count bar (ANGE-6STDNN) to this panel: build its
   * cells, paint `bar`'s state, and drive drags from pointer events.
   */
  bindBotBar(bar: BotBar, target: Window = window): void {
    const cells = document.getElementById("bots-cells") as HTMLDivElement;
    const value = document.getElementById("bots-value") as HTMLSpanElement;
    const by = document.getElementById("bots-by") as HTMLSpanElement;
    const max = document.getElementById("bots-max") as HTMLSpanElement;
    max.textContent = `${BOT_TARGET_MAX}`;
    cells.setAttribute("aria-valuemax", `${BOT_TARGET_MAX}`);
    for (let i = 1; i <= BOT_TARGET_MAX; i++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.count = `${i}`;
      cells.append(cell);
    }

    const paint = (): void => {
      const shown = bar.displayed;
      value.textContent = `${shown}`;
      cells.setAttribute("aria-valuenow", `${shown}`);
      for (const cell of cells.querySelectorAll<HTMLDivElement>(".cell")) {
        cell.classList.toggle("filled", Number(cell.dataset.count) <= shown);
      }
      // Free text from another player: textContent keeps it inert (and the
      // radio voice never receives it — see game/callouts.ts).
      by.textContent = bar.attribution ?? "";
    };
    this.repaintBots = paint;

    /** Which notch the pointer is over: the cell it is on, or the nearest
     * end. Left of the first cell means 0 — the only way to ask for none. */
    const notchAt = (clientX: number): number => {
      const box = cells.getBoundingClientRect();
      const frac = (clientX - box.left) / box.width;
      return Math.ceil(Math.min(Math.max(frac, 0), 1) * BOT_TARGET_MAX);
    };

    cells.addEventListener("mousedown", (e: MouseEvent) => {
      // Right-click is the aim zoom, not a grab — let it reach the window.
      if (e.button === 2) return;
      // The gun trigger listens on window mousedown — a grab at the bar is
      // not a trigger pull (same swallow as the HUD fullscreen button).
      e.stopPropagation();
      e.preventDefault();
      this.dragging = true;
      bar.dragTo(notchAt(e.clientX));
      paint();
    });
    target.addEventListener("mousemove", (e: MouseEvent) => {
      if (!this.dragging) return;
      bar.dragTo(notchAt(e.clientX));
      paint();
    });
    target.addEventListener("mouseup", (e: MouseEvent) => {
      if (!this.dragging) return;
      e.stopPropagation();
      this.dragging = false;
      bar.release();
      paint();
      // The panel only lingered for the drag; Tab is in charge again.
      if (!this.tabHeld) this.setOpen(false);
    });
    paint();
  }

  /** Repaint the bot bar after a server change; set by bindBotBar. */
  private repaintBots: (() => void) | null = null;

  /** A botsConfig landed (main.ts already applied it to the BotBar). */
  refreshBotBar(): void {
    this.repaintBots?.();
  }

  setRoster(roster: RosterEntry[]): void {
    for (const { id, name, isBot } of roster) {
      const row = this.upsert(id);
      row.name = name;
      row.isBot = isBot ?? false;
    }
    this.dirty = true;
  }

  playerJoined({ id, name, isBot }: RosterEntry): void {
    const row = this.upsert(id);
    row.name = name;
    row.isBot = isBot ?? false;
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
      row = { name: "???", kills: 0, deaths: 0, isBot: false };
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
        else if (row.isBot) tr.className = "bot";
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
