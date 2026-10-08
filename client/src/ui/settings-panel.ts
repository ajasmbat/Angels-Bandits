// Settings panel (M6, Mobile Playable): the thin DOM wiring around the pure
// model in ui/settings.ts. It lives in today's `#rotate` container — a phone
// held upright gets the settings instead of the bare "rotate" card, and the
// card's icon and hint stay on as the panel's footer. On landscape and
// desktop the same panel opens from the gear (`#settings-btn`) or Esc. Esc
// is a convenience only: in browser fullscreen the browser takes Esc to
// leave fullscreen and the page never sees it, so the gear is the way in.
//
// Built once the join has completed (main.ts), but the panel's markup is
// only built on first open: settings never cost the boot anything.

import type { AimMode } from "../game/flight-input";
import { SENSITIVITY_STEPS } from "../game/touch-input";
import {
  QUALITY_SETTINGS,
  type QualitySetting,
  type QualityTier,
} from "../render/quality";
import { coarsePointer } from "./mobile";
import {
  type PanelEnv,
  type PanelEvent,
  type Settings,
  type SettingsStore,
  clampSettings,
  nextManual,
  panelOpen,
  portraitForced,
  saveSettings,
} from "./settings";

/** What the panel reads from and drives in the game (main.ts). */
export interface SettingsHooks {
  quality: () => { setting: QualitySetting; tier: QualityTier };
  /** Applies live and persists (O3's `ab-quality`). */
  setQuality: (setting: QualitySetting) => void;
  fps: () => number;
  /** The touch aim sensitivity, or null where there are no touch controls. */
  sensitivity: () => number | null;
  setSensitivity: (value: number) => void;
  aimMode: () => AimMode;
  setAimMode: (mode: AimMode) => void;
  radioVoice: () => boolean;
  setRadioVoice: (on: boolean) => void;
  /** Haptics on/off, or null where the device can't vibrate (row hidden). */
  haptics: () => boolean | null;
  setHaptics: (on: boolean) => void;
  /** The resolution scale changed (debounced while a slider drags). */
  setResScale: (scale: number) => void;
  /** Any volume changed. */
  setVolumes: (s: Settings) => void;
  /** The panel opened or closed: the autopilot and the touch controls. */
  onOpenChange: (open: boolean) => void;
}

/** The Settings values a range slider drives. */
type SliderKey = "resScale" | "master" | "engine" | "voice";

/** While open, every value is re-read this often (FPS, Auto's tier, and
 * anything the G key, M key or a HUD toggle changed behind the panel). */
const REFRESH_MS = 500;
/** Trailing debounce on the resolution slider: a drag must not reset the
 * scaler on every input event. `change` (release) applies at once. */
const RES_DEBOUNCE_MS = 150;

const QUALITY_LABEL: Record<QualitySetting, string> = {
  auto: "AUTO",
  high: "HIGH",
  medium: "MED",
  low: "LOW",
  mobile: "MOBILE",
};

const seg = (key: string, label: string, opts: [string, string][]): string =>
  `<div class="seg" data-key="${key}" role="radiogroup" aria-label="${label}">${opts
    .map(
      ([v, text]) =>
        `<button type="button" data-v="${v}" role="radio" tabindex="-1">${text}</button>`,
    )
    .join("")}</div>`;

const slider = (key: string, label: string, min: number): string =>
  `<label class="slider"><span>${label}</span><input type="range" min="${min}" max="100" step="5" data-key="${key}" aria-label="${label}" /><output data-out="${key}"></output></label>`;

const MARKUP = `
<div class="settings" role="dialog" aria-modal="true" aria-labelledby="settings-h" tabindex="-1">
  <header>
    <h2 id="settings-h">SETTINGS</h2>
    <button type="button" class="settings-close" aria-label="Close settings" tabindex="-1">✕</button>
  </header>
  <div class="settings-body">
    <section>
      <h3>GRAPHICS</h3>
      ${seg(
        "quality",
        "Graphics quality",
        QUALITY_SETTINGS.map((q) => [q, QUALITY_LABEL[q]]),
      )}
      <div class="readout"><span data-out="tier"></span><span data-out="fps"></span></div>
      ${slider("resScale", "RESOLUTION", 50)}
    </section>
    <section>
      <h3>CONTROLS</h3>
      <div class="row" data-row="sensitivity">
        <span>AIM SENSITIVITY</span>
        ${seg(
          "sensitivity",
          "Aim sensitivity",
          SENSITIVITY_STEPS.map((s) => [String(s), `${s}×`]),
        )}
      </div>
      <div class="row">
        <span>AIM MODE</span>
        ${seg("aimMode", "Aim mode", [
          ["instructor", "INSTRUCTOR"],
          ["classic", "CLASSIC"],
        ])}
      </div>
      <div class="row" data-row="haptics">
        <span>HAPTICS</span>
        ${seg("haptics", "Haptics", [
          ["on", "ON"],
          ["off", "OFF"],
        ])}
      </div>
    </section>
    <section>
      <h3>SOUND</h3>
      ${slider("master", "MASTER", 0)}
      ${slider("engine", "ENGINE", 0)}
      ${slider("voice", "RADIO VOICE", 0)}
      <div class="row">
        <span>RADIO VOICE</span>
        ${seg("radioVoice", "Radio voice", [
          ["on", "ON"],
          ["off", "OFF"],
        ])}
      </div>
    </section>
  </div>
  <footer class="settings-rotate"><span>ROTATE TO LANDSCAPE TO FLY ↻</span></footer>
</div>`;

/** The gun trigger, the aim zoom and free-look listen on window: a press on
 * the panel must never reach them. Button 2 (the aim zoom) passes, same
 * rule as the HUD toggles and the fullscreen buttons. */
function swallowMouse(el: HTMLElement): void {
  const swallow = (e: MouseEvent) => {
    if (e.button !== 2) e.stopPropagation();
  };
  el.addEventListener("mousedown", swallow);
  el.addEventListener("mouseup", swallow);
}

export class SettingsPanel {
  private manual = false;
  private open = false;
  private built = false;
  private values: Settings;
  private timer: ReturnType<typeof setInterval> | undefined;
  private resTimer: ReturnType<typeof setTimeout> | undefined;
  /** The slider a finger or the mouse is dragging (never re-synced). */
  private dragging: HTMLInputElement | null = null;
  private readonly root = document.getElementById("rotate") as HTMLDivElement;
  private readonly portrait = window.matchMedia("(orientation: portrait)");

  constructor(
    private readonly hooks: SettingsHooks,
    initial: Settings,
    private readonly store: SettingsStore | undefined,
  ) {
    this.values = clampSettings(initial);
    // From here on the panel owns #rotate: the bare-card CSS fallback
    // (index.html) stands down, so the plain prompt never shows after boot.
    document.body.classList.add("settings-live");
    this.portrait.addEventListener("change", () =>
      this.event(this.portrait.matches ? null : "landscape"),
    );
    const gear = document.getElementById("settings-btn");
    if (gear) {
      gear.hidden = false;
      swallowMouse(gear);
      gear.addEventListener("click", () => this.event("toggle"));
    }
    window.addEventListener("keydown", (e) => {
      if (e.code !== "Escape" || e.repeat) return;
      if (document.getElementById("signal-lost")?.classList.contains("open")) {
        return;
      }
      this.event("toggle");
    });
    this.sync();
  }

  /** Whether the panel is up (the autopilot's switch). */
  isOpen(): boolean {
    return this.open;
  }

  /** QA view (`__ab.settings`). */
  current(): Settings {
    return { ...this.values };
  }

  private env(): PanelEnv {
    return { touch: coarsePointer(), portrait: this.portrait.matches };
  }

  /** A gear / Esc / ✕ / rotation event, or null for a plain re-check. */
  private event(e: PanelEvent | null): void {
    if (e) this.manual = nextManual(this.manual, e, this.env());
    this.sync();
  }

  private sync(): void {
    const env = this.env();
    const open = panelOpen(this.manual, env);
    this.root.classList.toggle("portrait", portraitForced(env));
    if (open === this.open) return;
    this.open = open;
    if (open) this.build();
    this.root.classList.toggle("open", open);
    if (open) {
      this.refresh();
      this.timer = setInterval(() => this.refresh(), REFRESH_MS);
      // Focus the dialog itself (not a control: Space is BOOST, and a
      // focused button would take the press as a click).
      if (!env.touch) this.dialog()?.focus({ preventScroll: true });
    } else {
      clearInterval(this.timer);
      this.flushRes();
      this.dragging = null;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && this.root.contains(focused)) {
        focused.blur();
      }
    }
    this.hooks.onOpenChange(open);
  }

  private dialog(): HTMLElement | null {
    return this.root.querySelector(".settings");
  }

  /** First open: the markup, with today's rotate icon moved into the footer. */
  private build(): void {
    if (this.built) return;
    this.built = true;
    const phone = this.root.querySelector(".phone");
    this.root.innerHTML = MARKUP;
    this.root.setAttribute("aria-live", "off");
    if (phone) this.root.querySelector(".settings-rotate")?.prepend(phone);
    swallowMouse(this.root);
    // Keys typed into the panel (arrows on a slider, Space on a button)
    // must not also steer, boost, or flip G/M/F/Tab behind it. Esc passes:
    // it closes the panel.
    this.root.addEventListener("keydown", (e) => {
      if (e.code !== "Escape") e.stopPropagation();
    });
    this.root.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".settings-close")) {
        this.event("close");
        return;
      }
      const btn = t.closest<HTMLButtonElement>(".seg button");
      const group = btn?.parentElement?.dataset.key;
      if (!btn || !group) return;
      this.pick(group, btn.dataset.v ?? "");
      btn.blur();
      this.refresh();
    });
    for (const input of this.root.querySelectorAll<HTMLInputElement>(
      "input[type=range]",
    )) {
      const key = input.dataset.key as SliderKey;
      const grab = () => {
        this.dragging = input;
      };
      const drop = () => {
        if (this.dragging === input) this.dragging = null;
      };
      input.addEventListener("pointerdown", grab);
      input.addEventListener("touchstart", grab, { passive: true });
      input.addEventListener("pointerup", drop);
      input.addEventListener("touchend", drop);
      input.addEventListener("touchcancel", drop);
      input.addEventListener("input", () =>
        this.slide(key, Number(input.value) / 100, false),
      );
      input.addEventListener("change", () => {
        drop();
        this.slide(key, Number(input.value) / 100, true);
      });
    }
  }

  /** A segmented button. */
  private pick(group: string, v: string): void {
    const h = this.hooks;
    if (group === "quality") h.setQuality(v as QualitySetting);
    else if (group === "sensitivity") h.setSensitivity(Number(v));
    else if (group === "aimMode") h.setAimMode(v as AimMode);
    else if (group === "radioVoice") h.setRadioVoice(v === "on");
    else if (group === "haptics") {
      // Stored only once the player picks: until then it stays null, the
      // device default.
      this.values = clampSettings({ ...this.values, haptics: v === "on" });
      saveSettings(this.store, this.values);
      h.setHaptics(v === "on");
    }
  }

  /** A slider moved (`done` on release). */
  private slide(key: SliderKey, v: number, done: boolean): void {
    this.values = clampSettings({ ...this.values, [key]: v });
    saveSettings(this.store, this.values);
    this.paintOutputs();
    if (key !== "resScale") {
      this.hooks.setVolumes(this.values);
      return;
    }
    clearTimeout(this.resTimer);
    if (done) this.flushRes();
    else this.resTimer = setTimeout(() => this.flushRes(), RES_DEBOUNCE_MS);
  }

  private flushRes(): void {
    if (this.resTimer === undefined) return;
    clearTimeout(this.resTimer);
    this.resTimer = undefined;
    this.hooks.setResScale(this.values.resScale);
  }

  /** Re-read everything from the game, except a control in the hand. */
  private refresh(): void {
    const h = this.hooks;
    const q = h.quality();
    const sens = h.sensitivity();
    const haptics = h.haptics();
    const marks: Record<string, string> = {
      quality: q.setting,
      sensitivity: String(sens),
      aimMode: h.aimMode(),
      radioVoice: h.radioVoice() ? "on" : "off",
      haptics: haptics ? "on" : "off",
    };
    for (const group of this.root.querySelectorAll<HTMLElement>(".seg")) {
      const want = marks[group.dataset.key ?? ""];
      for (const b of group.querySelectorAll<HTMLButtonElement>("button")) {
        const on = b.dataset.v === want;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
      }
    }
    const sensRow = this.root.querySelector<HTMLElement>(
      "[data-row=sensitivity]",
    );
    if (sensRow) sensRow.hidden = sens === null;
    const hapticsRow =
      this.root.querySelector<HTMLElement>("[data-row=haptics]");
    if (hapticsRow) hapticsRow.hidden = haptics === null;
    const tier = q.tier.toUpperCase();
    this.out("tier", q.setting === "auto" ? `AUTO · ${tier}` : tier);
    this.out("fps", `${Math.round(h.fps())} FPS`);
    for (const input of this.root.querySelectorAll<HTMLInputElement>(
      "input[type=range]",
    )) {
      if (input === this.dragging || input === document.activeElement) {
        continue;
      }
      const v = this.values[input.dataset.key as SliderKey];
      input.value = String(Math.round(v * 100));
    }
    this.paintOutputs();
  }

  private paintOutputs(): void {
    for (const key of ["resScale", "master", "engine", "voice"] as const) {
      this.out(key, `${Math.round(this.values[key] * 100)}%`);
    }
  }

  private out(key: string, text: string): void {
    const el = this.root.querySelector(`[data-out="${key}"]`);
    if (el && el.textContent !== text) el.textContent = text;
  }
}
