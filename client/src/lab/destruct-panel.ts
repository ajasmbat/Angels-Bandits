// DL1 Destruction Lab panel: the DOM around common/src/destruction-tuning.ts
// and the lab's controls — the FL1 panel's idiom (lab/panel.ts) and its
// styles (lab.css). One row per DESTRUCTION_SPEC field, grouped like
// DESTRUCTION_GROUPS, each with its plain-English hint and a reset, writing
// straight into the LIVE tuning the lab applies. Presets, A/B/C slots
// (1/2/3 load, Shift+1/2/3 save), Copy settings (versioned, only what
// differs) with a share link and a paste box. And the lab's own sections:
// the arena (pick, reset, drop into the city), the triggers (with the
// direction / corner / floor they read), and the watching tools (pause,
// slow motion, the scrub timeline, frame step, the time-lapse sheet).
//
// Everything it remembers lives under destruction-lab keys, through the
// guarded storage helpers. Its own input never reaches the game (the panel
// swallows its mouse, touch and wheel events).

import {
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
} from "@angels-bandits/common/city/collapse";
import {
  LAB_TRIGGERS,
  LAB_TRIGGER_HINTS,
  LAB_TRIGGER_NAMES,
  type LabTriggerKind,
  TRIGGER_NEEDS,
} from "@angels-bandits/common/destruct-lab";
import {
  DEFAULT_DESTRUCTION_TUNING,
  DESTRUCTION_GROUPS,
  DESTRUCTION_PRESETS,
  DESTRUCTION_SPEC,
  type DestructionGroup,
  type DestructionSpec,
  type DestructionTuning,
  decodeDestructionShare,
  encodeDestructionShare,
  exportDestructionTuning,
  importDestructionTuning,
  presetDestructionTuning,
  sanitizeDestructionTuning,
} from "@angels-bandits/common/destruction-tuning";
import { readStored, writeStored } from "../ui/storage";
import "./lab.css";

/** The tuning, as exportDestructionTuning JSON. */
export const DLAB_TUNING_KEY = "ab-dlab-tuning";
/** The A/B/C slots: three exportDestructionTuning strings or null. */
export const DLAB_SLOTS_KEY = "ab-dlab-slots";
/** Panel open state and the collapsed groups. */
export const DLAB_PANEL_KEY = "ab-dlab-panel";

const SLOT_NAMES = ["A", "B", "C"] as const;

/** Section ids the panel can fold (the tunables' groups and its own). */
type Section = DestructionGroup | "Arena" | "Triggers" | "Watch" | "Settings";

interface PanelState {
  open: boolean;
  collapsed: string[];
}

interface Row {
  spec: DestructionSpec;
  el: HTMLElement;
  input: HTMLInputElement;
  value: HTMLElement;
  reset: HTMLButtonElement;
}

/** What the panel drives (destruct-lab.ts). */
export interface DestructPanelHooks {
  /** The live tuning changed (already written in place). */
  onChange(): void;
  onArena(index: number): void;
  onResetArena(): void;
  onDropIntoCity(on: boolean): void;
  onTrigger(kind: LabTriggerKind): void;
  onPause(): void;
  onSpeed(speed: number): void;
  /** The timeline slider moved: its position, 0..1. */
  onScrub(u: number): void;
  onStep(frames: number): void;
  onLive(): void;
  onTimelapse(): void;
}

/** The direction / corner / floor the triggers read. */
export interface TriggerOptions {
  dir: number;
  corner: number;
  floor: number;
}

const toDisplay = (s: DestructionSpec, v: number): number => v * (s.scale ?? 1);

function decimals(step: number): number {
  if (step >= 1) return 0;
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

/** A display value back to stored units; snaps to the default exactly when
 * it is the default (degree round trips must not export as a change). */
export function destructFromDisplay(
  s: DestructionSpec,
  display: number,
): number {
  const v = display / (s.scale ?? 1);
  const d = DEFAULT_DESTRUCTION_TUNING[s.key];
  if (Math.abs(v - d) <= 1e-9 * Math.max(1, Math.abs(d))) return d;
  const c = Math.min(s.max, Math.max(s.min, v));
  return s.int ? Math.round(c) : c;
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
  b.addEventListener("click", () => {
    onClick();
    b.blur();
  });
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
    const o = JSON.parse(readStored(DLAB_PANEL_KEY) ?? "null") as {
      open?: unknown;
      collapsed?: unknown;
    } | null;
    return {
      open: typeof o?.open === "boolean" ? o.open : true,
      collapsed: Array.isArray(o?.collapsed)
        ? (o.collapsed as unknown[]).filter(
            (g): g is string => typeof g === "string",
          )
        : // Fold the long tail by default: the look groups stay open.
          ["Chain reactions", "Performance", "Settings"],
    };
  } catch {
    return { open: true, collapsed: [] };
  }
}

function loadSlots(): (string | null)[] {
  try {
    const o = JSON.parse(readStored(DLAB_SLOTS_KEY) ?? "null") as unknown;
    if (Array.isArray(o)) {
      return [0, 1, 2].map((i) => {
        const s = o[i];
        return typeof s === "string" && importDestructionTuning(s).ok
          ? s
          : null;
      });
    }
  } catch {
    // junk: empty slots
  }
  return [null, null, null];
}

/** The tuning a lab visit starts from: a share link (`?destructlab=<code>`)
 * wins (and is saved), then the stored tuning, then the defaults. */
export function initialDestructionTuning(search: string): DestructionTuning {
  const code = new URLSearchParams(search).get("destructlab");
  if (code) {
    const shared = decodeDestructionShare(code);
    if (shared.ok) {
      writeStored(DLAB_TUNING_KEY, exportDestructionTuning(shared.tuning));
      return shared.tuning;
    }
  }
  const stored = readStored(DLAB_TUNING_KEY);
  if (stored) {
    const r = importDestructionTuning(stored);
    if (r.ok) return r.tuning;
  }
  return sanitizeDestructionTuning({});
}

const DIRS: readonly [number, string][] = [
  [DIR_NEG_X, "−X"],
  [DIR_POS_X, "+X"],
  [DIR_NEG_Z, "−Z"],
  [DIR_POS_Z, "+Z"],
];
const CORNERS: readonly [number, string][] = [
  [0, "−X −Z"],
  [1, "+X −Z"],
  [2, "−X +Z"],
  [3, "+X +Z"],
];

export class DestructPanel {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly rows: Row[] = [];
  private readonly slotEls: HTMLElement[] = [];
  private readonly presetEls: HTMLButtonElement[] = [];
  private readonly arenaEls: HTMLButtonElement[] = [];
  private readonly dirEls: HTMLButtonElement[] = [];
  private readonly cornerEls: HTMLButtonElement[] = [];
  private readonly exportBox: HTMLTextAreaElement;
  private readonly importStatus: HTMLElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly target: HTMLElement;
  private readonly triggerHint: HTMLElement;
  private readonly floorInput: HTMLInputElement;
  private readonly floorValue: HTMLElement;
  private readonly dropBox: HTMLInputElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly liveBtn: HTMLButtonElement;
  private readonly speedInput: HTMLInputElement;
  private readonly speedValue: HTMLElement;
  private readonly timeline: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private readonly lapseBtn: HTMLButtonElement;
  private slots: (string | null)[];
  private state: PanelState;
  private hover = false;
  private dragging = false;
  private scrubbing = false;
  private feedbackTimer = 0;
  readonly options: TriggerOptions = { dir: DIR_POS_X, corner: 3, floor: 1 };

  constructor(
    private readonly tuning: DestructionTuning,
    private readonly hooks: DestructPanelHooks,
    arenas: readonly { name: string; hint: string }[],
    search: string = window.location.search,
    host: HTMLElement = document.body,
  ) {
    Object.assign(tuning, initialDestructionTuning(search));
    this.state = loadPanelState();
    this.slots = loadSlots();

    this.root = el("aside", "lab-panel dlab-panel");
    this.root.setAttribute("aria-label", "Destruction Lab");
    const tab = button("lab-tab", "LAB ⚙", () => this.toggle());
    tab.title = "Destruction Lab (Tab)";
    this.root.append(tab);
    const sheet = el("div", "lab-sheet");
    this.root.append(sheet);
    const head = el("header", "lab-head");
    head.append(el("span", "lab-title", "DESTRUCTION LAB"));
    const exit = el("a", "lab-exit", "Exit lab");
    exit.href = "/";
    head.append(
      exit,
      button("lab-close", "✕", () => this.close()),
    );
    sheet.append(head);
    this.body = el("div", "lab-body");
    sheet.append(this.body);

    // --- Arena -------------------------------------------------------------
    const arena = this.section("Arena", true);
    const ar = el("div", "lab-btns");
    arenas.forEach((a, i) => {
      const b = button("lab-btn", a.name, () => this.hooks.onArena(i));
      b.title = a.hint;
      this.arenaEls.push(b);
      ar.append(b);
    });
    ar.append(
      button("lab-btn", "Reset arena", () => this.hooks.onResetArena()),
    );
    arena.append(ar);
    const drop = el("label", "lab-check");
    this.dropBox = el("input");
    this.dropBox.type = "checkbox";
    this.dropBox.addEventListener("change", () => {
      this.hooks.onDropIntoCity(this.dropBox.checked);
      this.dropBox.blur();
    });
    drop.append(this.dropBox, el("span", "", "Drop into city (any tower)"));
    arena.append(drop);
    this.target = el("div", "lab-hint dlab-target", "Target: —");
    arena.append(
      this.target,
      el(
        "div",
        "lab-hint",
        "Drag to orbit · wheel to zoom · WASD / QE to move · click a tower to aim at it.",
      ),
    );

    // --- Triggers ----------------------------------------------------------
    const trig = this.section("Triggers", true);
    const tr = el("div", "lab-btns");
    for (const k of LAB_TRIGGERS) {
      const b = button("lab-btn", LAB_TRIGGER_NAMES[k], () => {
        this.showHint(k);
        this.hooks.onTrigger(k);
      });
      b.title = LAB_TRIGGER_HINTS[k];
      b.dataset.trigger = k;
      b.addEventListener("pointerenter", () => this.showHint(k));
      tr.append(b);
    }
    trig.append(tr);
    this.triggerHint = el("div", "lab-hint", "Pick a trigger.");
    trig.append(this.triggerHint);
    const dr = el("div", "lab-btns");
    dr.append(el("span", "lab-hint", "Topple:"));
    for (const [d, name] of DIRS) {
      const b = button("lab-btn", name, () => {
        this.options.dir = d;
        this.paintOptions();
      });
      this.dirEls.push(b);
      dr.append(b);
    }
    trig.append(dr);
    const cr = el("div", "lab-btns");
    cr.append(el("span", "lab-hint", "Corner:"));
    for (const [c, name] of CORNERS) {
      const b = button("lab-btn", name, () => {
        this.options.corner = c;
        this.paintOptions();
      });
      this.cornerEls.push(b);
      cr.append(b);
    }
    trig.append(cr);
    const floor = el("div", "lab-row");
    const ft = el("div", "lab-row-top");
    this.floorValue = el("span", "lab-value", "1");
    ft.append(el("span", "lab-label", "Charge on floor band"), this.floorValue);
    this.floorInput = el("input");
    this.floorInput.type = "range";
    this.floorInput.min = "0";
    this.floorInput.max = "8";
    this.floorInput.step = "1";
    this.floorInput.value = "1";
    this.floorInput.addEventListener("input", () => {
      this.options.floor = Number(this.floorInput.value);
      this.paintOptions();
    });
    this.floorInput.addEventListener("change", () => this.floorInput.blur());
    floor.append(ft, this.floorInput);
    trig.append(floor);

    // --- Watch -------------------------------------------------------------
    const watch = this.section("Watch", true);
    const wr = el("div", "lab-btns");
    this.pauseBtn = button("lab-btn", "Pause", () => this.hooks.onPause());
    this.pauseBtn.title = "Pause / play the collapses (Space)";
    const back = button("lab-btn", "◀ frame", () => this.hooks.onStep(-1));
    back.title = "One frame back (,)";
    const fwd = button("lab-btn", "frame ▶", () => this.hooks.onStep(1));
    fwd.title = "One frame on (.)";
    this.liveBtn = button("lab-btn", "Live", () => this.hooks.onLive());
    this.liveBtn.title = "Back to real time (L)";
    wr.append(this.pauseBtn, back, fwd, this.liveBtn);
    watch.append(wr);
    const sp = el("div", "lab-row");
    const st = el("div", "lab-row-top");
    this.speedValue = el("span", "lab-value", "1.0×");
    st.append(el("span", "lab-label", "Slow motion"), this.speedValue);
    this.speedInput = el("input");
    this.speedInput.type = "range";
    this.speedInput.min = "0.1";
    this.speedInput.max = "1";
    this.speedInput.step = "0.05";
    this.speedInput.value = "1";
    this.speedInput.addEventListener("input", () => {
      const v = Number(this.speedInput.value);
      this.speedValue.textContent = `${v.toFixed(2)}×`;
      this.hooks.onSpeed(v);
    });
    this.speedInput.addEventListener("change", () => this.speedInput.blur());
    sp.append(st, this.speedInput);
    watch.append(sp);
    const tl = el("div", "lab-row");
    const tt = el("div", "lab-row-top");
    this.timeLabel = el("span", "lab-value", "—");
    tt.append(el("span", "lab-label", "Timeline"), this.timeLabel);
    this.timeline = el("input");
    this.timeline.type = "range";
    this.timeline.min = "0";
    this.timeline.max = "1000";
    this.timeline.step = "1";
    this.timeline.value = "1000";
    this.timeline.addEventListener("pointerdown", () => {
      this.scrubbing = true;
    });
    this.timeline.addEventListener("input", () =>
      this.hooks.onScrub(Number(this.timeline.value) / 1000),
    );
    this.timeline.addEventListener("pointerup", () => {
      this.scrubbing = false;
      this.timeline.blur();
    });
    tl.append(tt, this.timeline);
    tl.append(
      el(
        "div",
        "lab-hint",
        "Replays the latest collapse exactly — every piece is a pure function of time.",
      ),
    );
    watch.append(tl);
    const lr = el("div", "lab-btns");
    this.lapseBtn = button("lab-btn", "Time-lapse sheet", () =>
      this.hooks.onTimelapse(),
    );
    this.lapseBtn.title =
      "Capture the latest collapse at fixed times into one labelled image";
    lr.append(this.lapseBtn);
    watch.append(lr);

    // --- Presets / compare / share ------------------------------------------
    const presets = this.section("Presets");
    const pr = el("div", "lab-btns");
    for (const p of DESTRUCTION_PRESETS) {
      const b = button("lab-btn", p.name, () =>
        this.replace(presetDestructionTuning(p)),
      );
      b.title = p.hint;
      b.dataset.preset = p.id;
      this.presetEls.push(b);
      pr.append(b);
    }
    presets.append(pr);
    const slotSec = this.section("Compare (1 / 2 / 3)");
    const sr = el("div", "lab-slots");
    SLOT_NAMES.forEach((name, i) => {
      const s = el("div", "lab-slot");
      s.append(el("span", "lab-slot-name", name));
      const load = button("lab-btn", "Load", () => this.loadSlot(i));
      load.title = `Load slot ${name} (${i + 1})`;
      const save = button("lab-btn", "Save", () => this.saveSlot(i));
      save.title = `Save the current settings to ${name} (Shift+${i + 1})`;
      s.append(load, save);
      this.slotEls.push(s);
      sr.append(s);
    });
    slotSec.append(sr);
    const share = this.section("Share");
    const sb = el("div", "lab-btns");
    this.copyBtn = button("lab-btn lab-primary", "Copy settings", () =>
      this.copy(exportDestructionTuning(this.tuning), this.copyBtn, "Copied!"),
    );
    const linkBtn: HTMLButtonElement = button(
      "lab-btn",
      "Copy share link",
      () =>
        this.copy(
          `${location.origin}${location.pathname}?destructlab=${encodeDestructionShare(this.tuning)}`,
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
      const r = importDestructionTuning(importBox.value.trim());
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

    // --- The tunables -------------------------------------------------------
    for (const group of DESTRUCTION_GROUPS) {
      const sec = this.section(group, true);
      for (const spec of DESTRUCTION_SPEC) {
        if (spec.group === group) sec.append(this.row(spec));
      }
    }
    const foot = el("div", "lab-btns lab-foot");
    foot.append(
      button("lab-btn", "Reset all", () =>
        this.replace(sanitizeDestructionTuning({})),
      ),
    );
    this.body.append(foot);

    this.guardEvents();
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("pointerup", () => {
      this.dragging = false;
      this.scrubbing = false;
    });
    host.append(this.root);
    this.setOpen(this.state.open);
    this.paintOptions();
    this.refresh();
  }

  get isOpen(): boolean {
    return this.state.open;
  }

  close(): void {
    this.setOpen(false);
  }

  toggle(): void {
    this.setOpen(!this.state.open);
  }

  /** True while the pointer is on the open panel or a slider is dragging. */
  pointerOver(): boolean {
    return this.dragging || this.scrubbing || (this.state.open && this.hover);
  }

  /** The highlighted arena (−1: none — dropped into the city). */
  setArena(index: number): void {
    this.arenaEls.forEach((b, i) => b.classList.toggle("on", i === index));
  }

  setDropIntoCity(on: boolean): void {
    this.dropBox.checked = on;
  }

  /** The target line, and the floor slider's range for its tower. */
  setTarget(label: string, floors: number): void {
    if (this.target.textContent !== label) this.target.textContent = label;
    const max = String(Math.max(0, floors - 1));
    if (this.floorInput.max !== max) {
      this.floorInput.max = max;
      if (this.options.floor > floors - 1) {
        this.options.floor = Math.max(0, floors - 1);
        this.paintOptions();
      }
    }
  }

  /** The watching tools' state: paused, live, the timeline (0..1 or null
   * when there is nothing to replay) and its time label. */
  setWatch(
    paused: boolean,
    live: boolean,
    u: number | null,
    label: string,
  ): void {
    const p = paused ? "Play" : "Pause";
    if (this.pauseBtn.textContent !== p) this.pauseBtn.textContent = p;
    this.liveBtn.classList.toggle("on", live);
    this.timeline.disabled = u === null;
    if (u !== null && !this.scrubbing) {
      const v = String(Math.round(u * 1000));
      if (this.timeline.value !== v) this.timeline.value = v;
    }
    if (this.timeLabel.textContent !== label)
      this.timeLabel.textContent = label;
  }

  /** The time-lapse button's state (busy while it captures). */
  setLapseBusy(busy: boolean): void {
    this.lapseBtn.disabled = busy;
    this.lapseBtn.textContent = busy ? "Capturing…" : "Time-lapse sheet";
  }

  /** Re-read the live tuning into every control. */
  refresh(): void {
    for (const r of this.rows) this.paintRow(r);
    const now = exportDestructionTuning(this.tuning);
    this.exportBox.value = now;
    this.presetEls.forEach((b, i) => {
      const p = DESTRUCTION_PRESETS[i];
      b.classList.toggle(
        "on",
        p !== undefined &&
          exportDestructionTuning(presetDestructionTuning(p)) === now,
      );
    });
    this.slotEls.forEach((s, i) => {
      s.classList.toggle("filled", this.slots[i] !== null);
      s.classList.toggle("on", this.slots[i] === now);
    });
  }

  // --- Internals -------------------------------------------------------------

  private showHint(k: LabTriggerKind): void {
    const need = TRIGGER_NEEDS[k];
    const extra = need.point
      ? " Aims where you last clicked on the target."
      : need.dir
        ? " Direction: below."
        : need.corner
          ? " Corner: below."
          : need.floor
            ? " Floor: below."
            : "";
    this.triggerHint.textContent = `${LAB_TRIGGER_HINTS[k]}${extra}`;
  }

  private paintOptions(): void {
    this.dirEls.forEach((b, i) =>
      b.classList.toggle("on", DIRS[i]?.[0] === this.options.dir),
    );
    this.cornerEls.forEach((b, i) =>
      b.classList.toggle("on", CORNERS[i]?.[0] === this.options.corner),
    );
    this.floorValue.textContent = String(this.options.floor);
    if (document.activeElement !== this.floorInput) {
      this.floorInput.value = String(this.options.floor);
    }
  }

  private replace(next: DestructionTuning): void {
    Object.assign(this.tuning, next);
    this.changed();
  }

  private changed(): void {
    Object.assign(this.tuning, sanitizeDestructionTuning(this.tuning));
    writeStored(DLAB_TUNING_KEY, exportDestructionTuning(this.tuning));
    this.hooks.onChange();
    this.refresh();
  }

  private loadSlot(i: number): void {
    const s = this.slots[i];
    if (!s) return;
    const r = importDestructionTuning(s);
    if (r.ok) this.replace(r.tuning);
  }

  private saveSlot(i: number): void {
    this.slots[i] = exportDestructionTuning(this.tuning);
    writeStored(DLAB_SLOTS_KEY, JSON.stringify(this.slots));
    this.refresh();
  }

  private setOpen(open: boolean): void {
    this.state.open = open;
    this.root.classList.toggle("open", open);
    if (!open) this.hover = false;
    writeStored(DLAB_PANEL_KEY, JSON.stringify(this.state));
  }

  private section(title: Section | string, collapsible = false): HTMLElement {
    const sec = el("section", "lab-sec");
    const h = el("h3", "lab-sec-title", title);
    sec.append(h);
    if (collapsible) {
      sec.classList.add("collapsible");
      sec.classList.toggle("collapsed", this.state.collapsed.includes(title));
      h.addEventListener("click", () => {
        const c = sec.classList.toggle("collapsed");
        this.state.collapsed = c
          ? [...this.state.collapsed.filter((x) => x !== title), title]
          : this.state.collapsed.filter((x) => x !== title);
        writeStored(DLAB_PANEL_KEY, JSON.stringify(this.state));
      });
    }
    this.body.append(sec);
    return sec;
  }

  private row(spec: DestructionSpec): HTMLElement {
    const r = el("div", "lab-row");
    r.dataset.key = spec.key;
    const top = el("div", "lab-row-top");
    const label = el("label", "lab-label", spec.label);
    const input = el("input");
    const id = `dlab-${spec.key}`;
    input.id = id;
    label.htmlFor = id;
    const reset = button("lab-reset", "↺", () => {
      this.tuning[spec.key] = DEFAULT_DESTRUCTION_TUNING[spec.key];
      this.changed();
    });
    reset.title = "Back to the default";
    input.type = "range";
    input.min = String(toDisplay(spec, spec.min));
    input.max = String(toDisplay(spec, spec.max));
    input.step = String(toDisplay(spec, spec.step));
    input.addEventListener("pointerdown", () => {
      this.dragging = true;
    });
    input.addEventListener("input", () => {
      this.tuning[spec.key] = destructFromDisplay(spec, Number(input.value));
      this.changed();
    });
    input.addEventListener("change", () => input.blur());
    input.addEventListener("pointerup", () => {
      this.dragging = false;
      input.blur();
    });
    const value = el("span", "lab-value");
    top.append(label, value, reset);
    r.append(top, input, el("div", "lab-hint", spec.hint));
    this.rows.push({ spec, el: r, input, value, reset });
    return r;
  }

  private paintRow(r: Row): void {
    const { spec } = r;
    const v = this.tuning[spec.key];
    const isDefault = v === DEFAULT_DESTRUCTION_TUNING[spec.key];
    r.el.classList.toggle("changed", !isDefault);
    r.reset.disabled = isDefault;
    const d = toDisplay(spec, v);
    if (document.activeElement !== r.input) r.input.value = String(d);
    const txt = `${d.toFixed(decimals(toDisplay(spec, spec.step)))}${spec.unit ? ` ${spec.unit}` : ""}`;
    if (r.value.textContent !== txt) r.value.textContent = txt;
  }

  private guardEvents(): void {
    const stop = (e: Event) => e.stopPropagation();
    for (const type of [
      "mousedown",
      "mouseup",
      "click",
      "contextmenu",
      "pointerdown",
      "touchstart",
      "touchmove",
      "touchend",
      "wheel",
    ]) {
      this.root.addEventListener(type, stop);
    }
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
    if (e.code === "Space") {
      e.preventDefault();
      this.hooks.onPause();
    } else if (e.code === "Comma") this.hooks.onStep(-1);
    else if (e.code === "Period") this.hooks.onStep(1);
    else if (e.code === "KeyL") this.hooks.onLive();
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
