// Combat HUD: own HP and gun-heat gauges, the spawn-protection badge, the
// kill-cam overlay, and the hit-confirm blip on the crosshair. Pure DOM over
// the chrome in index.html (same split as ui/join.ts) — the values shown are
// whatever the server said, never a client-side simulation of them.

import { mulberry32 } from "@angels-bandits/common/city";
import {
  BOOST_MIN_START,
  KILL_CAM_MS,
  MAX_HP,
} from "@angels-bandits/common/constants";
import { MEDAL_LABEL, type MedalKind } from "@angels-bandits/common/medals";
import type { DeathMsg } from "@angels-bandits/common/protocol";
import type { LifeCard } from "../game/session-stats";

/** How long a medal toast stays up, ms (S7). */
const MEDAL_TOAST_MS = 2600;

/**
 * The S7 end-of-life card's two lines: the numbers, then the medals (a
 * repeat shown once with its count). Pure, for the card and its QA hook.
 */
export function lifeCardLines(card: LifeCard): [string, string] {
  const accuracy = card.accuracy === null ? "—" : `${card.accuracy}%`;
  const stats =
    `KILLS ${card.kills} · ACCURACY ${accuracy} · ` +
    `BEST STREAK ${card.bestStreak}`;
  const counts = new Map<MedalKind, number>();
  for (const m of card.medals) counts.set(m, (counts.get(m) ?? 0) + 1);
  const medals = [...counts]
    .map(([m, n]) => (n > 1 ? `${MEDAL_LABEL[m]} ×${n}` : MEDAL_LABEL[m]))
    .join(" · ");
  return [stats, medals];
}

/**
 * The kill-cam headline (U2): how you died and who gets the credit. A
 * credited crash keeps saying CRASHED — the server's death message refines
 * the local crash display, it never turns a crash into a shoot-down. The
 * storm's bolt names itself (discovery is the design, so no more than that).
 */
export function deathLabel(
  cause: DeathMsg["cause"],
  killerName: string | null,
): string {
  if (cause === "storm") return "⚡ STRUCK BY THE STORM";
  if (cause === "collapse") {
    return killerName === null
      ? "CRUSHED BY A COLLAPSE"
      : `CRUSHED — ${killerName} BROUGHT IT DOWN`;
  }
  if (cause === "missile") return "🚀 CAUGHT IN A MISSILE STRIKE";
  if (cause === "blast") return "💥 CAUGHT IN A GAS MAIN BLAST";
  if (cause === "meteor") return "☄ HIT BY A METEOR";
  if (cause === "bomb") return "💣 CAUGHT IN A BOMB RUN";
  if (cause === "flak") {
    return killerName === null
      ? "💥 SHOT DOWN BY FLAK"
      : `💥 FLAK — CREDIT TO ${killerName}`;
  }
  if (killerName === null) return "CRASHED";
  if (cause === "wreck") return `HIT A WRECK — CREDIT TO ${killerName}`;
  return cause === "shot"
    ? `SHOT DOWN BY ${killerName}`
    : `CRASHED — CREDIT TO ${killerName}`;
}

/** The aim mode as a toast names it. Touch (M9) has no M key and no mouse,
 * so its wording carries neither. */
function aimModeLabel(mode: "instructor" | "classic", touch: boolean): string {
  if (touch) return mode === "instructor" ? "INSTRUCTOR" : "CLASSIC STICK";
  return mode === "instructor" ? "MOUSE INSTRUCTOR (M)" : "CLASSIC STICK (M)";
}

/** Last value written per element per style property (O2): the HUD setters
 * run every frame, and an unchanged write still costs a style parse and can
 * dirty layout — so only a CHANGED value reaches the DOM. */
const written = new WeakMap<HTMLElement | SVGElement, Map<string, string>>();

function setStyle(
  el: HTMLElement | SVGElement,
  prop: "width" | "transform" | "display" | "opacity",
  value: string,
): void {
  let props = written.get(el);
  if (!props) {
    props = new Map();
    written.set(el, props);
  }
  if (props.get(prop) === value) return;
  props.set(prop, value);
  el.style[prop] = value;
}

/** R3: drops beaded on the canopy rim. */
const LENS_DROPS = 28;

/**
 * The lens drops as one CSS background: small beads laid along the screen's
 * four edges, inset 1–8 % (index.html's mask keeps them off the middle).
 * Sized in vmin, so on any screen they cover ~0.1 % of it — far inside the
 * 0.5 % the rain coverage budget leaves them (rain-look.ts). Seeded: the
 * same beads every session.
 */
export function lensDropsBackground(): string {
  const rand = mulberry32(0x0d40b1e5);
  const layers: string[] = [];
  for (let i = 0; i < LENS_DROPS; i++) {
    const along = 4 + rand() * 92;
    const inset = 1 + rand() * 7;
    const edge = Math.floor(rand() * 4);
    const x = edge < 2 ? along : edge === 2 ? inset : 100 - inset;
    const y = edge < 2 ? (edge === 0 ? inset : 100 - inset) : along;
    const r = 0.25 + rand() * 0.35;
    layers.push(
      `radial-gradient(circle at ${x.toFixed(1)}% ${y.toFixed(1)}%, #eef6ff66 0, #c8dcff2e ${r.toFixed(2)}vmin, #0000 ${(r + 0.15).toFixed(2)}vmin)`,
    );
  }
  return layers.join(", ");
}

export class Hud {
  private readonly hpFill = document.getElementById(
    "hp-fill",
  ) as HTMLDivElement;
  private readonly heatEl = document.getElementById("heat") as HTMLDivElement;
  private readonly heatFill = document.getElementById(
    "heat-fill",
  ) as HTMLDivElement;
  private readonly boostEl = document.getElementById("boost") as HTMLDivElement;
  private readonly boostFill = document.getElementById(
    "boost-fill",
  ) as HTMLDivElement;
  private readonly raindrops = document.getElementById(
    "raindrops",
  ) as HTMLDivElement | null;
  private raindropsLaid = false;
  private readonly badge = document.getElementById(
    "protected-badge",
  ) as HTMLDivElement;
  private readonly killcam = document.getElementById(
    "killcam",
  ) as HTMLDivElement;
  private readonly killcamCause = document.getElementById(
    "killcam-cause",
  ) as HTMLDivElement;
  private readonly killcamCount = document.getElementById(
    "killcam-count",
  ) as HTMLDivElement;
  private readonly kd = document.getElementById("kd") as HTMLSpanElement;
  private readonly reconnecting = document.getElementById(
    "reconnecting",
  ) as HTMLDivElement;
  private readonly crosshair = document.getElementById(
    "crosshair",
  ) as unknown as SVGSVGElement;
  private readonly hitmarker = document.getElementById(
    "hitmarker",
  ) as HTMLDivElement;
  private readonly radioToggle = document.getElementById(
    "radio-toggle",
  ) as HTMLDivElement;
  private readonly qualityToggle = document.getElementById(
    "quality-toggle",
  ) as HTMLDivElement | null;
  private readonly aimCursor = document.getElementById(
    "aim-cursor",
  ) as unknown as SVGSVGElement;
  private readonly aimModeToast = document.getElementById(
    "aim-mode-toast",
  ) as HTMLDivElement;
  private readonly medalToast = document.getElementById(
    "medal-toast",
  ) as HTMLDivElement;
  private readonly killcamCard = document.getElementById(
    "killcam-card",
  ) as HTMLDivElement;
  private medalUntil = 0;
  /** P3: the kill's edge glow (built here, styled in ui/polish.css) — one
   * element, replayed by a class restart, never rebuilt. */
  private readonly killPulse = ((): HTMLDivElement => {
    const el = document.createElement("div");
    el.id = "kill-pulse";
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    return el;
  })();
  /** S4: the boss bar's nodes, the HP it last drew, and its hit flash. */
  private readonly bossBar = document.getElementById(
    "boss-bar",
  ) as HTMLDivElement;
  private readonly bossFill = this.bossBar.querySelector(
    ".fill",
  ) as HTMLDivElement;
  private readonly bossCells = this.bossBar.querySelector(
    ".cells",
  ) as HTMLDivElement;
  /** The HP the bar last drew (null: hidden). Compared in place — the
   * bar is checked every frame while the boss flies. */
  private bossShown: number[] | null = null;
  private bossFlashUntil = 0;
  private hitBlipUntil = 0;
  private aimModeTimer: ReturnType<typeof setTimeout> | undefined;
  private markerUntil = 0;
  /** performance.now() the server's respawn is due; 0 = kill-cam closed. */
  private respawnAt = 0;
  private countShown = -1;

  /** Server-owned HP (snapshots / damage events). */
  setHp(hp: number): void {
    const frac = Math.min(1, Math.max(0, hp / MAX_HP));
    setStyle(this.hpFill, "width", `${(frac * 100).toFixed(1)}%`);
  }

  /** Local heat model state (identical to what the server validates with). */
  setHeat(heat: number, locked: boolean): void {
    setStyle(
      this.heatFill,
      "width",
      `${(Math.min(1, heat) * 100).toFixed(1)}%`,
    );
    this.heatEl.classList.toggle("locked", locked);
  }

  /** Local boost energy (F2) — the same model the server mirrors. `low`
   * means a fresh press couldn't start a burn yet; `body.boost` drives the
   * speed-line streaks while burning. */
  setBoost(energy: number, burning: boolean): void {
    const frac = Math.min(1, Math.max(0, energy));
    setStyle(this.boostFill, "width", `${(frac * 100).toFixed(1)}%`);
    this.boostEl.classList.toggle("low", !burning && frac < BOOST_MIN_START);
    document.body.classList.toggle("boost", burning);
  }

  /** R3: rain on the lens, 0..1 — beads on the screen's rim. Laid out on
   * the first rain; the opacity moves in 0.05 steps, so it is written only
   * on a change. */
  setRainOnLens(level: number): void {
    if (!this.raindrops) return;
    const q = Math.round(Math.min(1, Math.max(0, level)) * 20) / 20;
    if (q > 0 && !this.raindropsLaid) {
      this.raindrops.style.backgroundImage = lensDropsBackground();
      this.raindropsLaid = true;
    }
    setStyle(this.raindrops, "opacity", q.toFixed(2));
  }

  /** Own kills and deaths from the server's `score` broadcast (U2). */
  setScore(kills: number, deaths: number): void {
    const text = `K ${kills} · D ${deaths}`;
    if (this.kd.textContent !== text) this.kd.textContent = text;
  }

  setProtected(on: boolean): void {
    this.badge.classList.toggle("on", on);
  }

  /** W2: the RECONNECTING… banner, up while a dropped socket resumes. */
  setReconnecting(on: boolean): void {
    this.reconnecting.classList.toggle("open", on);
  }

  /**
   * Radio-voice mute toggle (mutes TTS only — the comms ticker stays on).
   * Guns hold their trigger from a window-level mousedown, so pointer events
   * on the toggle must never bubble — clicking it can't mean "fire".
   */
  bindRadioToggle(
    initial: boolean,
    onToggle: (on: boolean) => void,
  ): (on: boolean) => void {
    let on = initial;
    const render = () => {
      this.radioToggle.textContent = on ? "RADIO VOICE ON" : "RADIO VOICE OFF";
      this.radioToggle.classList.toggle("off", !on);
    };
    render();
    // ...except button 2, which is the aim zoom and also listens on window.
    const swallow = (e: MouseEvent) => {
      if (e.button !== 2) e.stopPropagation();
    };
    this.radioToggle.addEventListener("mousedown", swallow);
    this.radioToggle.addEventListener("mouseup", swallow);
    this.radioToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      on = !on;
      render();
      onToggle(on);
    });
    // The M6 settings panel flips it too: keep this entry truthful.
    return (next) => {
      on = next;
      render();
    };
  }

  /**
   * O3 graphics quality entry: a click cycles the setting (main.ts owns the
   * order and the state). Same click-swallowing as the radio toggle, so a
   * click here never fires the guns.
   */
  bindQualityToggle(onCycle: () => void): void {
    const el = this.qualityToggle;
    if (!el) return;
    const swallow = (e: MouseEvent) => {
      if (e.button !== 2) e.stopPropagation();
    };
    el.addEventListener("mousedown", swallow);
    el.addEventListener("mouseup", swallow);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      onCycle();
    });
  }

  /** "GFX AUTO · HIGH" — under Auto, the tier it is currently running. */
  setQuality(setting: string, tier: string): void {
    if (!this.qualityToggle) return;
    this.qualityToggle.textContent =
      setting === "auto"
        ? `GFX AUTO · ${tier.toUpperCase()}`
        : `GFX ${tier.toUpperCase()}`;
  }

  /** Free-look (hold E): show the hint and dim the aim chrome via CSS. */
  setFreeLook(on: boolean): void {
    document.body.classList.toggle("freelook", on);
  }

  /** Aim zoom (hold right-click): brighten the pipper via CSS. */
  setZoom(on: boolean): void {
    document.body.classList.toggle("zoom", on);
  }

  /**
   * Put the pipper — and the hitmarker with it — where the gun line lands on
   * screen. Both used to be pinned at 50%/50%, which pointed ~10 degrees below
   * the actual gun line; the hitmarker follows so it still lands "at the
   * reticle" the way its own design says it does. Null hides them (the gun
   * line is behind the camera, or we are dead).
   */
  setAimPoint(p: { x: number; y: number } | null): void {
    if (!p) {
      setStyle(this.crosshair, "display", "none");
      return;
    }
    const t = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    setStyle(this.crosshair, "transform", t);
    setStyle(this.crosshair, "display", "block");
    setStyle(this.hitmarker, "transform", t);
  }

  /**
   * The instructor's aim circle at the (smoothed) cursor, and the converged
   * state it shares with the pipper once the nose has arrived. Null hides it
   * and hands the 3D view its OS cursor back (classic mode, kill-cam).
   */
  setAimCursor(p: { x: number; y: number } | null, converged: boolean): void {
    document.body.classList.toggle("aim-instructor", p !== null);
    this.crosshair.classList.toggle("converged", p !== null && converged);
    if (!p) {
      setStyle(this.aimCursor, "display", "none");
      return;
    }
    setStyle(
      this.aimCursor,
      "transform",
      `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`,
    );
    setStyle(this.aimCursor, "display", "block");
    this.aimCursor.classList.toggle("converged", converged);
  }

  /** Brief toast naming the aim mode M just switched to. */
  showAimMode(mode: "instructor" | "classic", touch: boolean): void {
    this.toast(`◇ AIM: ${aimModeLabel(mode, touch)} ◇`);
  }

  /**
   * The settings screen closed after changing the aim (M9). It covers the
   * HUD while open, so the toast waits for it; null means unchanged, and
   * both changes share one toast.
   */
  showAimChanges(
    mode: "instructor" | "classic" | null,
    sensitivity: number | null,
    touch: boolean,
  ): void {
    const parts: string[] = [];
    if (mode !== null) parts.push(`AIM: ${aimModeLabel(mode, touch)}`);
    if (sensitivity !== null) {
      parts.push(`${mode === null ? "AIM " : ""}SENSITIVITY ${sensitivity}×`);
    }
    if (parts.length > 0) this.toast(`◇ ${parts.join(" · ")} ◇`);
  }

  /** The shared top-centre toast (aim mode, aim settings). */
  private toast(text: string): void {
    this.aimModeToast.textContent = text;
    this.aimModeToast.classList.add("on");
    // Re-arm the fade: the class must be off for a frame to transition out.
    clearTimeout(this.aimModeTimer);
    this.aimModeTimer = setTimeout(
      () => this.aimModeToast.classList.remove("on"),
      1200,
    );
  }

  /** Kill-cam overlay: the deathLabel headline plus a respawn countdown.
   * Called again when the server's death message lands after a local crash:
   * the headline upgrades, but the countdown keeps the clock it started on
   * (`now`, performance.now()) — the respawn comes KILL_CAM_MS after death. */
  showKillCam(label: string, now: number): void {
    this.killcamCause.textContent = label;
    if (this.respawnAt === 0) {
      this.respawnAt = now + KILL_CAM_MS;
      this.countShown = -1;
      this.tickCountdown(now);
    }
    this.killcam.classList.add("open");
  }

  hideKillCam(): void {
    this.killcam.classList.remove("open");
    this.respawnAt = 0;
    this.showLifeCard(null);
  }

  /** S7: the life that just ended, under the kill-cam headline (null
   * clears it). Re-called when a posthumous kill or medal lands. */
  showLifeCard(card: LifeCard | null): void {
    if (!card) {
      this.killcamCard.replaceChildren();
      return;
    }
    const [stats, medals] = lifeCardLines(card);
    const statsEl = document.createElement("div");
    statsEl.textContent = stats;
    const medalsEl = document.createElement("div");
    medalsEl.className = "medals";
    medalsEl.textContent = medals;
    this.killcamCard.replaceChildren(statsEl, medalsEl);
  }

  /**
   * S4: the sky boss's shared health bar — the sum of its weak points over
   * their full HP, one cell per weak point under it. `hp` null hides it.
   * Writes the DOM only when what it shows changed.
   */
  setBoss(
    hp: readonly number[] | null,
    max: readonly number[],
    now: number,
  ): void {
    if (hp === null || hp.length === 0) {
      if (this.bossShown !== null) {
        this.bossBar.classList.remove("open");
        this.bossShown = null;
      }
      return;
    }
    const was = this.bossShown;
    if (was !== null && was.length === hp.length) {
      let same = true;
      for (let k = 0; k < hp.length && same; k++) same = hp[k] === was[k];
      if (same) return;
    }
    let left = 0;
    let full = 0;
    for (let k = 0; k < max.length; k++) {
      left += Math.max(0, hp[k] ?? 0);
      full += max[k] ?? 0;
    }
    this.bossShown = [...hp];
    this.bossFill.style.width = `${(100 * left) / Math.max(1, full)}%`;
    if (this.bossCells.children.length !== max.length) {
      this.bossCells.replaceChildren(
        ...max.map(() => {
          const cell = document.createElement("div");
          cell.className = "cell";
          return cell;
        }),
      );
    }
    hp.forEach((v, k) => {
      this.bossCells.children[k]?.classList.toggle("spent", v <= 0);
    });
    this.bossBar.classList.add("open");
    if (was !== null) {
      // A hit since the last change: a white tick on the bar.
      this.bossBar.classList.add("hit");
      this.bossFlashUntil = now + 90;
    }
  }

  /** S7: own medals pop in at the top of the screen, stacked, held
   * MEDAL_TOAST_MS. A new award replaces the stack and re-pops it. */
  showMedals(medals: readonly MedalKind[], now: number): void {
    if (medals.length === 0) return;
    this.medalToast.replaceChildren(
      ...medals.map((m) => {
        const row = document.createElement("div");
        row.className = "medal";
        row.textContent = MEDAL_LABEL[m];
        return row;
      }),
    );
    // Restart the pop-in: the class must be off for a reflow to replay it.
    this.medalToast.classList.remove("on");
    void this.medalToast.offsetWidth;
    this.medalToast.classList.add("on");
    this.medalUntil = now + MEDAL_TOAST_MS;
  }

  /** Whole seconds left to the respawn, written only when it changes. Never
   * below 1: the server's respawn message, not this clock, ends the beat. */
  private tickCountdown(now: number): void {
    const left = Math.max(1, Math.ceil((this.respawnAt - now) / 1000));
    if (left === this.countShown) return;
    this.countShown = left;
    this.killcamCount.textContent = `RESPAWN IN ${left}`;
  }

  /** One frame's worth of hit-confirm: flash the crosshair briefly. */
  hitConfirm(now: number): void {
    this.hitBlipUntil = now + 120;
    this.crosshair.classList.add("hit");
  }

  /** Instant X at the reticle the frame the local sweep connects (~120 ms). */
  hitMarker(now: number): void {
    // A kill flourish in flight outranks a plain hit — don't shrink it.
    if (this.hitmarker.classList.contains("kill") && now < this.markerUntil) {
      return;
    }
    this.markerUntil = now + 120;
    this.hitmarker.classList.remove("kill");
    this.hitmarker.classList.add("on");
  }

  /** Kill confirm: the marker grows into a pink X held ~400 ms. */
  killConfirm(now: number): void {
    this.markerUntil = now + 400;
    // P3: replay the pop and the edge glow (the class must be off for a
    // reflow to restart a CSS animation — once per kill, never per frame).
    this.hitmarker.classList.remove("kill", "on");
    this.killPulse.classList.remove("on");
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add("kill", "on");
    this.killPulse.classList.add("on");
  }

  /** Call every frame to age the hit blip and hitmarker out. */
  update(now: number): void {
    if (this.respawnAt !== 0) this.tickCountdown(now);
    if (this.bossFlashUntil !== 0 && now > this.bossFlashUntil) {
      this.bossBar.classList.remove("hit");
      this.bossFlashUntil = 0;
    }
    if (this.medalUntil !== 0 && now > this.medalUntil) {
      this.medalToast.classList.remove("on"); // CSS fades it out
      this.medalUntil = 0;
    }
    if (this.hitBlipUntil !== 0 && now > this.hitBlipUntil) {
      this.crosshair.classList.remove("hit");
      this.hitBlipUntil = 0;
    }
    if (this.markerUntil !== 0 && now > this.markerUntil) {
      this.hitmarker.classList.remove("on"); // CSS fades the rest of the way
      this.markerUntil = 0;
    }
  }
}
