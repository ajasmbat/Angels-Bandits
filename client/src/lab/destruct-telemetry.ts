// DL1 Destruction Lab telemetry: the FL1 strip's look (lab.css), with the
// numbers a destruction tune is judged by — frame rate and time, draw
// calls, the debris pieces still moving, the particles on screen, every
// collision box the field holds, and the server's destruction tick (last /
// p99, and the heaviest collapse build) — plus a warning when a setting
// breaks a budget. Written per frame, cheaply: a cell's text node is only
// touched when its string changes.

import "./lab.css";

export interface DestructTelemetry {
  fps: number;
  frameMs: number;
  draws: number;
  /** Debris pieces still moving / every piece in the field. */
  live: number;
  boxes: number;
  particles: number;
  /** The particle pool's cap (the saturation check). */
  particleCap: number;
  /** The server's destruction tick, ms (null: no report yet). */
  serverLast: number | null;
  serverP99: number | null;
  serverBuild: number | null;
}

/** The budgets the warning checks: a 60 fps frame (with a little slack
 * for the measurement), the server's collapse tick, and the pool. */
export const FRAME_BUDGET_MS = 1000 / 55;
export const SERVER_TICK_BUDGET_MS = 1;
export const POOL_FULL_SHARE = 0.95;

const DASH = "—";

const CELLS = [
  ["fps", "FPS"],
  ["ms", "FRAME"],
  ["draws", "DRAWS"],
  ["live", "PIECES"],
  ["boxes", "BOXES"],
  ["particles", "PARTICLES"],
  ["server", "SRV TICK"],
  ["build", "BUILD"],
  ["warn", "BUDGET"],
] as const;
type Cell = (typeof CELLS)[number][0];

/** What, if anything, is over budget (a short line), or "ok". */
export function budgetWarning(v: DestructTelemetry): string {
  const over: string[] = [];
  if (v.frameMs > FRAME_BUDGET_MS) over.push("frame");
  if (v.serverP99 !== null && v.serverP99 > SERVER_TICK_BUDGET_MS) {
    over.push("server p99");
  }
  if (v.particleCap > 0 && v.particles >= v.particleCap * POOL_FULL_SHARE) {
    over.push("particles");
  }
  return over.length === 0 ? "ok" : `over: ${over.join(", ")}`;
}

export class DestructTelemetryStrip {
  readonly el: HTMLElement;
  private readonly text = new Map<Cell, Text>();
  private readonly warnCell: HTMLElement;

  constructor(root: HTMLElement = document.body) {
    this.el = document.createElement("div");
    this.el.className = "lab-telemetry dlab-telemetry";
    this.el.setAttribute("aria-hidden", "true");
    let warn: HTMLElement | null = null;
    for (const [key, label] of CELLS) {
      const cell = document.createElement("span");
      cell.className = `lab-tm lab-tm-${key}`;
      const l = document.createElement("i");
      l.textContent = label;
      const v = document.createElement("b");
      const t = document.createTextNode(DASH);
      v.append(t);
      cell.append(l, v);
      this.el.append(cell);
      this.text.set(key, t);
      if (key === "warn") warn = cell;
    }
    this.warnCell = warn as HTMLElement;
    root.append(this.el);
  }

  update(v: DestructTelemetry): void {
    this.set("fps", String(Math.round(v.fps)));
    this.set("ms", `${v.frameMs.toFixed(1)} ms`);
    this.set("draws", String(v.draws));
    this.set("live", `${v.live}`);
    this.set("boxes", String(v.boxes));
    this.set("particles", String(v.particles));
    this.set(
      "server",
      v.serverLast === null || v.serverP99 === null
        ? DASH
        : `${v.serverLast.toFixed(2)} / ${v.serverP99.toFixed(2)} ms`,
    );
    this.set(
      "build",
      v.serverBuild === null ? DASH : `${v.serverBuild.toFixed(1)} ms`,
    );
    const w = budgetWarning(v);
    this.set("warn", w);
    this.warnCell.classList.toggle("over", w !== "ok");
  }

  private set(key: Cell, s: string): void {
    const t = this.text.get(key);
    if (t && t.data !== s) t.data = s;
  }
}
