// Tab-held scoreboard (PLAN.md UI): name, kills, deaths, sorted by kills.
// State is whatever the server last said (welcome scores + score events) —
// the client never counts kills itself. W1: it lists the PILOTS — the
// carrier's enemy planes come and go with every wave, and the HUD counts
// them instead (ui/hud.ts setWaves).

import { streakTier } from "@angels-bandits/common/medals";
import type { RosterEntry, ScoreEntry } from "@angels-bandits/common/protocol";
import { INTENSITY_MAX } from "@angels-bandits/common/waves";
import { type IntensityBar, intensityName } from "./intensity";

/** Touch (M9): taps on the intensity cells this soon after the panel opens
 * are ignored — a double-tap on the minimap must not change the room's
 * enemies. */
const TAP_GUARD_MS = 300;

interface Row {
  name: string;
  kills: number;
  deaths: number;
  isBot: boolean;
  /** S7: current kill streak (server-owned, from the score rows). */
  streak: number;
  /** W3: AA-nest kills of planes this pilot damaged first. */
  assists: number;
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
  /** Held open while an intensity drag is in flight: releasing Tab mid-drag
   * must not yank the surface out from under the pointer. */
  private dragging = false;
  private tabHeld = false;
  /** Touch (M2): there is no Tab key, so a minimap tap pins the panel open
   * until the next tap — see bindTapToggle. */
  private pinned = false;
  /** performance.now() of the last closed → open (the tap guard). */
  private openedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly selfId: string,
    target: Window = window,
    /** FL1: false in the Flight Lab, where Tab opens the lab panel. */
    tabKey = true,
  ) {
    target.addEventListener("keydown", (e: KeyboardEvent) => {
      if (tabKey && e.code === "Tab") {
        e.preventDefault(); // don't tab focus around the page
        this.tabHeld = true;
        this.setOpen(true);
      }
    });
    target.addEventListener("keyup", (e: KeyboardEvent) => {
      if (tabKey && e.code === "Tab") {
        this.tabHeld = false;
        if (!this.dragging && !this.pinned) this.setOpen(false);
      }
    });
    target.addEventListener("blur", () => {
      this.tabHeld = false;
      this.dragging = false;
      this.pinned = false;
      this.setOpen(false);
    });
  }

  /**
   * Wire the shared enemy-intensity bar (W1; ANGE-6STDNN's slider) to this
   * panel: build its cells (one per level), paint `bar`'s state, and drive
   * drags from pointer events.
   */
  bindIntensity(bar: IntensityBar, target: Window = window): void {
    const cells = document.getElementById("intensity-cells") as HTMLDivElement;
    const value = document.getElementById("intensity-value") as HTMLSpanElement;
    const by = document.getElementById("intensity-by") as HTMLSpanElement;
    cells.setAttribute("aria-valuemax", `${INTENSITY_MAX}`);
    for (let i = 0; i <= INTENSITY_MAX; i++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.level = `${i}`;
      cells.append(cell);
    }

    const paint = (): void => {
      const shown = bar.displayed;
      value.textContent = intensityName(shown);
      cells.setAttribute("aria-valuenow", `${shown}`);
      cells.setAttribute("aria-valuetext", intensityName(shown));
      for (const cell of cells.querySelectorAll<HTMLDivElement>(".cell")) {
        cell.classList.toggle("filled", Number(cell.dataset.level) <= shown);
      }
      // Free text from another player: textContent keeps it inert (and the
      // radio voice never receives it — see game/callouts.ts).
      by.textContent = bar.attribution ?? "";
    };
    this.repaintIntensity = paint;

    /** Which level the pointer is over: the cell it is on, or the nearest
     * end. */
    const notchAt = (clientX: number): number => {
      const box = cells.getBoundingClientRect();
      const frac = (clientX - box.left) / box.width;
      const n = INTENSITY_MAX + 1;
      return Math.min(INTENSITY_MAX, Math.max(0, Math.floor(frac * n)));
    };

    // A touch cancelled at touchstart never sends its emulated mousedown /
    // mouseup / click, so the drag below never starts and nothing is
    // claimed. Event.timeStamp is performance.now()'s clock.
    cells.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        if (e.timeStamp - this.openedAt < TAP_GUARD_MS) e.preventDefault();
      },
      { passive: false },
    );
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
      if (!this.tabHeld && !this.pinned) this.setOpen(false);
    });
    paint();
  }

  /** Touch (M2): a tap on `el` (the minimap) opens the panel, the next one
   * closes it. Only touch devices make the minimap tappable (index.html),
   * so on desktop this never fires and Tab stays the one path. */
  bindTapToggle(el: HTMLElement): void {
    // A tap also synthesises mousedown/mouseup, and the gun trigger listens
    // on window — the tap must not double as a trigger pull.
    const swallow = (e: MouseEvent) => e.stopPropagation();
    el.addEventListener("mousedown", swallow);
    el.addEventListener("mouseup", swallow);
    el.addEventListener("click", () => {
      this.pinned = !this.pinned;
      this.setOpen(this.pinned || this.tabHeld);
    });
  }

  /** Repaint the intensity bar after a server change; set by
   * bindIntensity. */
  private repaintIntensity: (() => void) | null = null;

  /** An intensityConfig landed (main.ts already applied it to the bar). */
  refreshIntensity(): void {
    this.repaintIntensity?.();
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
    for (const { id, kills, deaths, streak, assists } of scores) {
      const row = this.upsert(id);
      row.kills = kills;
      row.deaths = deaths;
      row.streak = streak ?? 0;
      row.assists = assists ?? 0;
    }
    this.dirty = true;
  }

  private upsert(id: string): Row {
    let row = this.rows.get(id);
    if (!row) {
      row = {
        name: "???",
        kills: 0,
        deaths: 0,
        isBot: false,
        streak: 0,
        assists: 0,
      };
      this.rows.set(id, row);
    }
    return row;
  }

  /** The panel is up (Tab held, pinned by a tap, or lingering for a drag). */
  get isOpen(): boolean {
    return this.panel.classList.contains("open");
  }

  private setOpen(open: boolean): void {
    if (open && !this.panel.classList.contains("open")) {
      this.openedAt = performance.now();
    }
    if (open && this.dirty) this.render();
    this.panel.classList.toggle("open", open);
  }

  private render(): void {
    // W1: pilots only — the carrier's planes are the waves' business.
    const sorted = [...this.rows.entries()]
      .filter(([, row]) => !row.isBot)
      .sort(([, a], [, b]) => b.kills - a.kills || a.deaths - b.deaths);
    this.rowsEl.replaceChildren(
      ...sorted.map(([id, row]) => {
        const tr = document.createElement("tr");
        if (id === this.selfId) tr.className = "self";
        // S7: a pilot on a streak glows, brighter per tier.
        const tier = streakTier(row.streak);
        if (tier > 0) {
          tr.classList.add("streak", `streak-${tier}`);
          tr.title = `${row.streak}-kill streak`;
        }
        // W3: AA assists ride the kills column ("3 +1").
        const kills =
          row.assists > 0 ? `${row.kills} +${row.assists}` : `${row.kills}`;
        for (const text of [row.name, kills, `${row.deaths}`]) {
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
