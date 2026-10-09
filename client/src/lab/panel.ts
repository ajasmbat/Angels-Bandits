// FL1 Flight Lab panel: the DOM around common/src/tuning.ts. One row per
// TUNING_SPEC field, grouped like TUNING_GROUPS, writing straight into the
// LIVE tuning object main.ts flies with — so a drag lands within a frame.
// Presets, A/B/C slots (1/2/3 load, Shift+1/2/3 save), Copy settings with a
// share link, a paste-to-import box and the playground's route buttons and
// toggles ride along. Everything it remembers lives under lab-only keys
// (never the game's own settings), through the guarded storage helpers.
//
// Input etiquette: the panel swallows its own mouse, touch and wheel events
// so a click on a slider never fires the guns and a scroll never moves the
// throttle, and pointerOver() tells main.ts to fly the autopilot while the
// pointer is on it — reaching for a slider never steers the plane.

import {
  DEFAULT_TUNING,
  type FlightTuning,
  TUNING_GROUPS,
  TUNING_PRESETS,
  TUNING_SPEC,
  type TuningGroup,
  type TuningKey,
  type TuningSpec,
  decodeShare,
  encodeShare,
  exportTuning,
  importTuning,
  presetTuning,
  sanitizeTuning,
} from "@angels-bandits/common/tuning";
import { readStored, writeStored } from "../ui/storage";
import "./lab.css";

/** What the panel drives in the game (main.ts). */
export interface LabPanelHooks {
  /** The live tuning changed (already written in place). */
  onChange(): void;
  onRoute(id: string): void;
  onToggle(name: "bots" | "chaos", on: boolean): void;
  onRespawn(): void;
}

export type LabToggle = "bots" | "chaos";

/** The tuning, as exportTuning JSON. */
export const LAB_TUNING_KEY = "ab-lab-tuning";
/** The A/B/C slots: an array of three exportTuning strings or null. */
export const LAB_SLOTS_KEY = "ab-lab-slots";
/** Panel open state and the collapsed groups. */
export const LAB_PANEL_KEY = "ab-lab-panel";

const SLOT_NAMES = ["A", "B", "C"] as const;

interface PanelState {
  open: boolean;
  collapsed: TuningGroup[];
}

interface Row {
  spec: TuningSpec;
  el: HTMLElement;
  input: HTMLInputElement;
  value: HTMLElement | null;
  reset: HTMLButtonElement;
}

/** Display form of a stored value. */
const toDisplay = (s: TuningSpec, v: number): number => v * (s.scale ?? 1);

/** Decimals a step implies (0.05 → 2). */
function decimals(step: number): number {
  if (step >= 1) return 0;
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

/** A display value back to stored units; snaps to the default exactly when
 * it is the default (degree round trips must not export as a change). */
export function fromDisplay(s: TuningSpec, display: number): number {
  const v = display / (s.scale ?? 1);
  const d = DEFAULT_TUNING[s.key];
  if (Math.abs(v - d) <= 1e-9 * Math.max(1, Math.abs(d))) return d;
  return Math.min(s.max, Math.max(s.min, v));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls: string, text: string, onClick: () => void) {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** Keys the panel never takes from a text field. */
function typing(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t?.tagName) return false;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  return t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range";
}

function loadPanelState(): PanelState {
  try {
    const o = JSON.parse(readStored(LAB_PANEL_KEY) ?? "null") as {
      open?: unknown;
      collapsed?: unknown;
    } | null;
    return {
      open: typeof o?.open === "boolean" ? o.open : true,
      collapsed: Array.isArray(o?.collapsed)
        ? (o.collapsed as unknown[]).filter((g): g is TuningGroup =>
            TUNING_GROUPS.includes(g as TuningGroup),
          )
        : [],
    };
  } catch {
    return { open: true, collapsed: [] };
  }
}

function loadSlots(): (string | null)[] {
  try {
    const o = JSON.parse(readStored(LAB_SLOTS_KEY) ?? "null") as unknown;
    if (Array.isArray(o)) {
      return [0, 1, 2].map((i) => {
        const s = o[i];
        return typeof s === "string" && importTuning(s).ok ? s : null;
      });
    }
  } catch {
    // junk: empty slots
  }
  return [null, null, null];
}

/** The tuning a lab visit starts from: a share link wins (and is saved),
 * then the stored tuning, then the defaults. */
export function initialTuning(search: string): FlightTuning {
  const code = new URLSearchParams(search).get("lab");
  if (code) {
    const shared = decodeShare(code);
    if (shared.ok) {
      writeStored(LAB_TUNING_KEY, exportTuning(shared.tuning));
      return shared.tuning;
    }
  }
  const stored = readStored(LAB_TUNING_KEY);
  if (stored) {
    const r = importTuning(stored);
    if (r.ok) return r.tuning;
  }
  return sanitizeTuning({});
}

export class LabPanel {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly rows: Row[] = [];
  private readonly slotEls: HTMLElement[] = [];
  private readonly toggleEls = new Map<LabToggle, HTMLInputElement>();
  private readonly presetEls: HTMLButtonElement[] = [];
  private readonly exportBox: HTMLTextAreaElement;
  private readonly importStatus: HTMLElement;
  private readonly copyBtn: HTMLButtonElement;
  private slots: (string | null)[];
  private state: PanelState;
  private hover = false;
  private dragging = false;
  private feedbackTimer = 0;

  constructor(
    private readonly tuning: FlightTuning,
    private readonly hooks: LabPanelHooks,
    routes: readonly { id: string; name: string }[],
    search: string = window.location.search,
    host: HTMLElement = document.body,
  ) {
    Object.assign(tuning, initialTuning(search));
    this.state = loadPanelState();
    this.slots = loadSlots();

    this.root = el("aside", "lab-panel");
    this.root.setAttribute("aria-label", "Flight Lab");
    const tab = button("lab-tab", "LAB ⚙", () => this.toggle());
    tab.title = "Flight Lab (Tab)";
    this.root.append(tab);

    const sheet = el("div", "lab-sheet");
    this.root.append(sheet);
    const head = el("header", "lab-head");
    head.append(el("span", "lab-title", "FLIGHT LAB"));
    const exit = el("a", "lab-exit", "Exit lab");
    exit.href = "/";
    head.append(
      exit,
      button("lab-close", "✕", () => this.close()),
    );
    sheet.append(head);

    this.body = el("div", "lab-body");
    sheet.append(this.body);

    // Presets.
    const presets = this.section("Presets");
    const pr = el("div", "lab-btns");
    for (const p of TUNING_PRESETS) {
      const b = button("lab-btn", p.name, () => {
        this.replace(presetTuning(p));
      });
      b.title = p.hint;
      b.dataset.preset = p.id;
      this.presetEls.push(b);
      pr.append(b);
    }
    presets.append(pr);

    // A/B/C slots.
    const slotSec = this.section("Compare (1 / 2 / 3)");
    const sr = el("div", "lab-slots");
    SLOT_NAMES.forEach((name, i) => {
      const s = el("div", "lab-slot");
      s.append(el("span", "lab-slot-name", name));
      const load = button("lab-btn", "Load", () => this.loadSlot(i));
      load.title = `Fly slot ${name} (${i + 1})`;
      const save = button("lab-btn", "Save", () => this.saveSlot(i));
      save.title = `Save the current settings to ${name} (Shift+${i + 1})`;
      s.append(load, save);
      this.slotEls.push(s);
      sr.append(s);
    });
    slotSec.append(sr);

    // Copy / share / import.
    const share = this.section("Share");
    const sb = el("div", "lab-btns");
    this.copyBtn = button("lab-btn lab-primary", "Copy settings", () =>
      this.copy(exportTuning(this.tuning), this.copyBtn, "Copied!"),
    );
    const linkBtn: HTMLButtonElement = button(
      "lab-btn",
      "Copy share link",
      () =>
        this.copy(
          `${location.origin}${location.pathname}?lab=${encodeShare(this.tuning)}`,
          linkBtn,
          "Link copied!",
        ),
    );
    sb.append(this.copyBtn, linkBtn);
    this.exportBox = el("textarea", "lab-json");
    this.exportBox.readOnly = true;
    this.exportBox.rows = 2;
    this.exportBox.addEventListener("focus", () => this.exportBox.select());
    const importBox = el("textarea", "lab-json");
    importBox.rows = 2;
    importBox.placeholder = "Paste settings JSON here";
    this.importStatus = el("div", "lab-status");
    const apply = button("lab-btn", "Apply pasted", () => {
      const r = importTuning(importBox.value.trim());
      if (r.ok) {
        this.replace(r.tuning);
        importBox.value = "";
        this.importStatus.textContent = "Applied.";
        this.importStatus.classList.remove("error");
      } else {
        this.importStatus.textContent = `Can't use that: ${r.error}.`;
        this.importStatus.classList.add("error");
      }
    });
    share.append(sb, this.exportBox, importBox, apply, this.importStatus);

    // Playground.
    const play = this.section("Playground");
    const rr = el("div", "lab-btns");
    for (const r of routes) {
      rr.append(button("lab-btn", r.name, () => this.hooks.onRoute(r.id)));
    }
    rr.append(button("lab-btn", "Respawn (R)", () => this.hooks.onRespawn()));
    play.append(rr);
    for (const [name, label] of [
      ["bots", "Bots"],
      ["chaos", "Chaos (boss, missiles, quakes)"],
    ] as const) {
      const lab = el("label", "lab-check");
      const box = el("input");
      box.type = "checkbox";
      box.addEventListener("change", () => {
        this.hooks.onToggle(name, box.checked);
        box.blur();
      });
      lab.append(box, el("span", "", label));
      this.toggleEls.set(name, box);
      play.append(lab);
    }

    // The tunables.
    for (const group of TUNING_GROUPS) {
      const sec = this.section(group, true);
      for (const spec of TUNING_SPEC) {
        if (spec.group === group) sec.append(this.row(spec));
      }
    }
    const foot = el("div", "lab-btns lab-foot");
    foot.append(
      button("lab-btn", "Reset all", () => this.replace(sanitizeTuning({}))),
    );
    this.body.append(foot);

    this.guardEvents();
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("pointerup", () => {
      this.dragging = false;
    });
    host.append(this.root);
    this.setOpen(this.state.open);
    this.refresh();
  }

  get isOpen(): boolean {
    return this.state.open;
  }

  open(): void {
    this.setOpen(true);
  }

  close(): void {
    this.setOpen(false);
  }

  toggle(): void {
    this.setOpen(!this.state.open);
  }

  /** True while the pointer is on the open panel or a slider is dragging —
   * main.ts flies the autopilot then. */
  pointerOver(): boolean {
    return this.dragging || (this.state.open && this.hover);
  }

  /** Reflect a playground toggle's state. */
  setToggle(name: LabToggle, on: boolean): void {
    const box = this.toggleEls.get(name);
    if (box) box.checked = on;
  }

  /** Re-read the live tuning into every control. */
  refresh(): void {
    for (const r of this.rows) this.paintRow(r);
    this.exportBox.value = exportTuning(this.tuning);
    const now = exportTuning(this.tuning);
    for (const [i, b] of this.presetEls.entries()) {
      const p = TUNING_PRESETS[i];
      b.classList.toggle(
        "on",
        p !== undefined && exportTuning(presetTuning(p)) === now,
      );
    }
    this.slotEls.forEach((s, i) => {
      s.classList.toggle("filled", this.slots[i] !== null);
      s.classList.toggle("on", this.slots[i] === now);
    });
  }

  // --- Internals -------------------------------------------------------------

  /** Write a whole tuning in place, then tell the game and repaint. */
  private replace(next: FlightTuning): void {
    Object.assign(this.tuning, next);
    this.changed();
  }

  private changed(): void {
    // The cross-field rules (top speed over the slowest, boost over top
    // speed — the flight step divides by both gaps): a slider dragged past
    // its partner pushes the partner along.
    Object.assign(this.tuning, sanitizeTuning(this.tuning));
    writeStored(LAB_TUNING_KEY, exportTuning(this.tuning));
    this.hooks.onChange();
    this.refresh();
  }

  private loadSlot(i: number): void {
    const s = this.slots[i];
    if (!s) return;
    const r = importTuning(s);
    if (r.ok) this.replace(r.tuning);
  }

  private saveSlot(i: number): void {
    this.slots[i] = exportTuning(this.tuning);
    writeStored(LAB_SLOTS_KEY, JSON.stringify(this.slots));
    this.refresh();
  }

  private setOpen(open: boolean): void {
    this.state.open = open;
    this.root.classList.toggle("open", open);
    if (!open) this.hover = false;
    this.saveState();
  }

  private saveState(): void {
    writeStored(LAB_PANEL_KEY, JSON.stringify(this.state));
  }

  private section(title: string, collapsible = false): HTMLElement {
    const sec = el("section", "lab-sec");
    const h = el("h3", "lab-sec-title", title);
    sec.append(h);
    if (collapsible) {
      const g = title as TuningGroup;
      sec.classList.add("collapsible");
      sec.classList.toggle("collapsed", this.state.collapsed.includes(g));
      h.addEventListener("click", () => {
        const c = sec.classList.toggle("collapsed");
        this.state.collapsed = c
          ? [...this.state.collapsed.filter((x) => x !== g), g]
          : this.state.collapsed.filter((x) => x !== g);
        this.saveState();
      });
    }
    this.body.append(sec);
    return sec;
  }

  private row(spec: TuningSpec): HTMLElement {
    const r = el("div", spec.toggle ? "lab-row lab-toggle" : "lab-row");
    r.dataset.key = spec.key;
    const top = el("div", "lab-row-top");
    const label = el("label", "lab-label", spec.label);
    const input = el("input");
    const id = `lab-${spec.key}`;
    input.id = id;
    label.htmlFor = id;
    let value: HTMLElement | null = null;
    const reset = button("lab-reset", "↺", () => {
      this.tuning[spec.key] = DEFAULT_TUNING[spec.key];
      this.changed();
    });
    reset.title = "Back to the default";
    if (spec.toggle) {
      input.type = "checkbox";
      input.addEventListener("change", () => {
        this.tuning[spec.key] = input.checked ? 1 : 0;
        input.blur();
        this.changed();
      });
      top.append(input, label, reset);
      r.append(top);
    } else {
      input.type = "range";
      input.min = String(toDisplay(spec, spec.min));
      input.max = String(toDisplay(spec, spec.max));
      input.step = String(toDisplay(spec, spec.step));
      input.addEventListener("pointerdown", () => {
        this.dragging = true;
      });
      input.addEventListener("input", () => {
        this.tuning[spec.key] = fromDisplay(spec, Number(input.value));
        this.changed();
      });
      input.addEventListener("change", () => input.blur());
      input.addEventListener("pointerup", () => {
        this.dragging = false;
        input.blur();
      });
      value = el("span", "lab-value");
      top.append(label, value, reset);
      r.append(top, input);
    }
    r.append(el("div", "lab-hint", spec.hint));
    this.rows.push({ spec, el: r, input, value, reset });
    return r;
  }

  private paintRow(r: Row): void {
    const { spec } = r;
    const v = this.tuning[spec.key as TuningKey];
    const isDefault = v === DEFAULT_TUNING[spec.key];
    r.el.classList.toggle("changed", !isDefault);
    r.reset.disabled = isDefault;
    if (spec.toggle) {
      r.input.checked = v >= 0.5;
      return;
    }
    const d = toDisplay(spec, v);
    // Never write the focused slider's value mid-drag (it would jump).
    if (document.activeElement !== r.input) r.input.value = String(d);
    if (r.value) {
      const txt = `${d.toFixed(decimals(toDisplay(spec, spec.step)))}${spec.unit ? ` ${spec.unit}` : ""}`;
      if (r.value.textContent !== txt) r.value.textContent = txt;
    }
  }

  /** Keep the panel's own input away from the game's window listeners. */
  private guardEvents(): void {
    const stop = (e: Event) => e.stopPropagation();
    for (const type of [
      "mousedown",
      "mouseup",
      "click",
      "contextmenu",
      "touchstart",
      "touchmove",
      "touchend",
      "wheel",
    ]) {
      this.root.addEventListener(type, stop);
    }
    // The panel scrolls itself; only the window's throttle must not see it.
    this.root.addEventListener("pointerenter", () => {
      this.hover = true;
    });
    this.root.addEventListener("pointerleave", () => {
      this.hover = false;
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.code === "Tab") {
      e.preventDefault();
      if (!e.repeat) this.toggle();
      return;
    }
    if (e.repeat || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    const slot = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
    if (slot >= 0) {
      if (e.shiftKey) this.saveSlot(slot);
      else this.loadSlot(slot);
      return;
    }
    if (e.code === "KeyR") this.hooks.onRespawn();
  }

  private copy(text: string, btn: HTMLButtonElement, done: string): void {
    const label = btn.textContent;
    const feedback = (msg: string) => {
      btn.textContent = msg;
      window.clearTimeout(this.feedbackTimer);
      this.feedbackTimer = window.setTimeout(() => {
        btn.textContent = label;
      }, 1400);
    };
    const fallback = () => {
      const ta = el("textarea", "lab-offscreen");
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      feedback(ok ? done : "Select & copy below");
    };
    this.exportBox.value = text;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => feedback(done), fallback);
    } else {
      fallback();
    }
  }
}
