// FL1 Flight Lab telemetry strip: a compact line of numbers along the top
// centre, so every preset has figures as well as a feel. Updated per frame,
// cheaply: each cell keeps its text node and is only written when its
// formatted string changes.

import "./lab.css";

export interface Telemetry {
  /** Airspeed, m/s. */
  speed: number;
  /** Current turn radius, m (null: flying straight). */
  turnRadius: number | null;
  /** Roll / pitch rate, °/s. */
  rollRate: number;
  pitchRate: number;
  /** Load factor, g. */
  g: number;
  routeName: string | null;
  /** Time on the current route / best on it, ms. */
  routeMs: number | null;
  bestMs: number | null;
  crashes: number;
  /** Aim-on-target share, 0..100 (null: not on the aim route). */
  aimPct: number | null;
}

const DASH = "—";

/** ms → m:ss.t */
export function formatLabTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return DASH;
  const tenths = Math.max(0, Math.floor(ms / 100));
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, "0")}.${tenths % 10}`;
}

const CELLS = [
  ["speed", "SPD"],
  ["radius", "TURN R"],
  ["roll", "ROLL"],
  ["pitch", "PITCH"],
  ["g", "G"],
  ["route", "ROUTE"],
  ["time", "TIME"],
  ["best", "BEST"],
  ["crashes", "CRASH"],
  ["aim", "AIM"],
] as const;
type Cell = (typeof CELLS)[number][0];

export class TelemetryStrip {
  readonly el: HTMLElement;
  private readonly text = new Map<Cell, Text>();

  constructor(root: HTMLElement = document.body) {
    this.el = document.createElement("div");
    this.el.className = "lab-telemetry";
    this.el.setAttribute("aria-hidden", "true");
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
    }
    root.append(this.el);
  }

  update(v: Telemetry): void {
    this.set("speed", `${Math.round(v.speed)} m/s`);
    this.set(
      "radius",
      v.turnRadius === null || !Number.isFinite(v.turnRadius)
        ? DASH
        : `${Math.round(v.turnRadius)} m`,
    );
    this.set("roll", `${Math.round(v.rollRate)}°/s`);
    this.set("pitch", `${Math.round(v.pitchRate)}°/s`);
    this.set("g", `${v.g.toFixed(1)} g`);
    this.set("route", v.routeName ?? DASH);
    this.set("time", formatLabTime(v.routeMs));
    this.set("best", formatLabTime(v.bestMs));
    this.set("crashes", String(v.crashes));
    this.set("aim", v.aimPct === null ? DASH : `${Math.round(v.aimPct)}%`);
  }

  private set(key: Cell, s: string): void {
    const t = this.text.get(key);
    if (t && t.data !== s) t.data = s;
  }
}
